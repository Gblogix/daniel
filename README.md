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

## Email
Without `SMTP_HOST` every email is stored in **Outbox** with status `LOGGED` (safe for testing).
With SMTP configured (e.g. Google Workspace / Microsoft 365 SMTP relay), emails are sent with attachments.
Automatic rules can be switched on/off in **Automation** (admin).

## Document extraction
* **Rule-based (default, offline):** PDF text, Excel/CSV packing lists (column headers auto-detected), text files.
  Validates container numbers with the ISO 6346 check digit and flags values that disagree between documents.
* **AI (optional):** set `ANTHROPIC_API_KEY` to also read scanned PDFs and unusual layouts with Claude.
  Rule-based extraction remains the fallback.

## Document templates
`src/docs/templates.js` holds generic Arrival Notice, Delivery Order and Authority to Make Entry layouts
(print-ready HTML, "Save as PDF" in the browser). Replace them with the company forms when ready.

## Project layout
```
src/server.js            Express app
src/db.js                SQLite schema
src/shipments.js         shipment model, statuses, tracking-bar math, access scoping
src/extract/             text extraction, rule-based + optional AI field extraction, merge
src/notify.js            outbox, email bodies, automation rules
src/docs/templates.js    A/N, D/O, ATME
src/routes/              auth, shipments, intake (portal), customer tracking, admin
views/                   EJS pages      public/  CSS/JS
```

## Next steps
* Plug in the real A/N, D/O, ATME forms
* PDF rendering of generated documents (currently HTML)
* Invoice generation & payment tracking, Smartsheet import of existing shipments
* Live vessel position (carrier / AIS API) instead of schedule-based progress
