# GlobalBridge Logistics (GB Logix) — Shipment Portal

Internal logistics system for GlobalBridge Logistics: overseas agents upload shipping documents to a
portal, the system extracts the key data, generates A/N / D/O / ATME, emails every party automatically,
and customers follow their cargo on a visual tracking board.

## The flow (from the whiteboard)

```
Factory ──► Overseas agent (국민해운 / Zhejiang)
              │  uploads MBL · HBL · P/L · C/I · ISF to the portal (no more email)
              ▼
         GB Logix  ── extracts MBL#, HBL#, container#, seal#, weight, CBM, vessel, ETD/ETA, P/L lines
              │     staff review & confirm (one screen)
              ├──► Customs broker (OMC / Solvenza / Opulen):  A/N + HBL + P/L + C/I (+ ATME for air)
              ├──► Customer (Unlockt Brands / PGP / Heyhae): ETD, ETA, P/L detail, delivery info + live tracking link
              └──► customs RELEASED ─► Trucker (CTC): D/O with pick-up & delivery location
                                      Customer: delivery date/time updates
```

Email subject format: `[A/N] MBL# … / HBL# … / CTN# … / ETA …`

## Access levels

| Role | Sees |
|---|---|
| **Admin** | Everything + users, automation settings |
| **Staff** | Dashboard, all shipments, document intake, parties, outbox |
| **Customer (CNEE)** | Only their own shipments: tracking bar, P/L contents, delivery location/date, invoice/paid, shared docs |
| **Overseas agent** | Upload portal + their shipments |
| **Customs broker** | Assigned shipments + A/N, B/L, P/L, C/I, ISF, ATME |
| **Trucker** | Assigned shipments + D/O, P/L |

## Modes
Air · Ocean (FCL) · Ocean (LCL) · Inland trucking (CFS → CFS)

## Run it

Requires Node.js 22.13+ (uses the built-in SQLite).

```bash
npm install
cp .env.example .env            # optional; set values as environment variables
npm run seed -- --demo          # optional demo data (parties + 3 sample shipments)
npm start                       # http://localhost:3000
npm test
```

First start creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (default `admin@gblogix.com` / `changeme123` — change it).
Demo users (password `demo1234`): `staff@gblogix.com`, `customer@unlockt.example`, `agent@kukmin.example`,
`agent@zhejiang.example`, `broker@ohmycustoms.example`, `dispatch@ctc.example`.

Data lives in `data/gblogix.db` (SQLite) and uploaded/generated files in `uploads/` — back both up.

## Email — Outlook / Microsoft 365
Notices are sent from `info@gblogix.com` through Microsoft Graph (they appear in Sent Items). Setup:
1. Azure portal → App registrations → New registration.
2. API permissions → Microsoft Graph → **Application**: `Mail.Send` (and `Mail.ReadWrite` for email intake) → Grant admin consent.
3. Certificates & secrets → new client secret. Put tenant ID, client ID, secret into `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.
4. Recommended: limit the app to the one mailbox with an Exchange `New-ApplicationAccessPolicy`.

`MS_MAIL_INTAKE=on` also imports agent emails with PDF/Excel attachments into **Document intake** (senders are matched
to agents by email domain on the Parties page), so agents who keep emailing are handled too.
SMTP is supported as a fallback. With neither configured, emails are stored in **Outbox** as `LOGGED`.

## Tracking — carrier & GPS
ETD / ETA / ATD / ATA, vessel, container LFD, terminal availability, holds, out-gate and empty return are updated every
`TRACKING_INTERVAL_HOURS` (and instantly via webhook). Status advances automatically and ETA changes email the customer.

| Mode | Source |
|---|---|
| Ocean | the carrier's own API (DCSA standard — Maersk, Hapag-Lloyd, CMA CGM, ONE, …) when credentials exist, else **Terminal49**, else ShipsGo |
| Air | **ShipsGo** by MAWB |
| Vessel position | **Datalastic** (by IMO, mid-ocean) and/or **aisstream.io** (free, by MMSI, coastal) — shown on a map |

Carrier websites are not scraped: carriers' terms forbid automated access and scrapers break silently.
Note: Terminal49 lists HMM as "partial" (tracks by MBL, not container).

## Reading documents (PDF)
* PDF text layer with positions → B/L fields and **packing-list / invoice tables rebuilt row by row** (wrapped cells, totals, units).
* **Scanned PDFs and photos → OCR** (offline; English bundled, Korean optional). OCR results are flagged for checking.
* **Merged PDFs** (MBL + HBL + P/L + C/I in one file) are split by page title.
* Container numbers are validated (ISO 6346) and common OCR misreads are corrected only when exactly one fix is valid.
* Also read: firms code, freight location, LFD, C/I number & value, ISF no., telex release.
* **AI (optional):** `ANTHROPIC_API_KEY` adds Claude's native PDF reading for scans and unusual layouts.

## Documents
Issued as PDF (needs Chromium; otherwise HTML) with the names used today:
`ARRIVAL_NOTICE___FREIGHT_INVOICE_<ref>.pdf`, `Delivery_Order_<ref>.pdf`, `AUTH_HBL_<ref>.pdf`
(ref = MAWB digits or MBL without SCAC; re-issues get `_Rev`, `_Rev2`). The A/N doubles as freight invoice (charges table).
Air D/Os go out with the ATME. Layouts live in `src/docs/templates.js` — swap in the company forms when provided.

## Daily LFD watch
Dashboard lists shipments with LFD ≤ 5 days (holds + next step); a 7:00 digest email goes to the office mailbox.

## Project layout
```
src/server.js            Express app
src/db.js                SQLite schema
src/shipments.js         shipment model, statuses, tracking-bar math, access scoping
src/extract/             PDF (text + OCR + tables), rule-based + optional AI extraction, merge
src/tracking/            Terminal49, ShipsGo, DCSA carrier APIs, AIS vessel position, poller
src/graph.js, mailin.js  Outlook send + email intake        src/alerts.js  daily LFD digest
src/docs/pdf.js          HTML → PDF (Chromium)
src/notify.js            outbox, email bodies, automation rules
src/docs/templates.js    A/N, D/O, ATME
src/routes/              auth, shipments, intake (portal), customer tracking, admin
views/                   EJS pages      public/  CSS/JS
```

## Go-live checklist
* [ ] Change the admin password (default `changeme123`) and delete / re-password the demo users (`demo1234`)
* [ ] Set `SESSION_SECRET`, `BASE_URL` (https)
* [ ] Outlook app registration (`MS_*`), tracking API keys
* [ ] Install Chromium for PDF output
* [ ] Back up `data/` and `uploads/`

## Next steps
* Plug in the real A/N, D/O, ATME forms
* Smartsheet import of existing shipments
