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

**Windows (easiest):** install Node.js 22 LTS, unzip, then double-click **`start-windows.bat`**.
In PowerShell, `npm` may be blocked by the execution policy — use `npm.cmd` / `npx.cmd`, or Command Prompt (cmd).

Requires Node.js 22.13+ (uses the built-in SQLite).

```bash
npm install
cp .env.example .env            # optional; set values as environment variables
npm run seed -- --demo          # optional demo data (parties + 3 sample shipments)
npm start                       # http://localhost:3000
npm test
```

First start creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (default `admin@gblogix.com` / `changeme123` — change it).
Demo users (password `demo1234`): `staff@gblogix.com`, `customer@unlockt.example`, `agent@nsc.example`,
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
The email text is read too (pre-alerts carry MBL / HBL / CNTR / ETD / ETA tables in the body).
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

## Smartsheet sync
With `SMARTSHEET_TOKEN` set, the shared sheets are read every 30 minutes (Admin › Automation › Sync now):
* **Unlockt - GlobalBridge** (and Seorin, Other Solvenza, Lumare, ATELIER QUINCE, OPULEN, BK Trading, Leepop Inc):
  each row → shipment matched by HBL (NSC… / ESSA…), MBL or container. Handles "8/28 > 8/24" revised dates (year from the
  HBL's yymm), "NSCLGB… // ESSASEL…" house numbers, consol rows (one P/L line per brand), Detail text (INV#, pallets,
  equipment, AIR), ISF / Custom checkboxes, declared value. Section headers, "REF; SEE BELOW" / "BKG#" / FBA rows are skipped.
* **Row attachments** (CI / PL / CO …) are downloaded once, stored on the shipment and read by the document extractor —
  P/L lines replace the sheet's summary line.
* **Delivery Status_Unlockt**: per-container terminal, availability, LFD, delivery date/time, delivered.
* Nothing is written to Smartsheet unless "write ETA back" is enabled; the system never uploads attachments
  (the Unlockt sheet emails the customer on attachment changes).

## Reading documents (PDF)
* PDF text layer with positions → B/L fields and **packing-list / invoice tables rebuilt row by row** (wrapped cells, totals, units).
* **Scanned PDFs and photos → OCR** (offline; English bundled, Korean optional). OCR results are flagged for checking.
* **Merged PDFs** (MBL + HBL + P/L + C/I in one file) are split by page title.
* Container numbers are validated (ISO 6346) and common OCR misreads are corrected only when exactly one fix is valid.
* Also read: firms code, freight location, LFD, C/I number & value, ISF no., telex release.
* **AI (optional):** `ANTHROPIC_API_KEY` adds Claude's native PDF reading for scans and unusual layouts.

## Documents (laid out after the current company forms)
| Document | File name | Sent to |
|---|---|---|
| Arrival Notice / Freight Invoice | `ARRIVAL_NOTICE___FREIGHT_INVOICE_<HBL>.pdf` | importer / customer, broker (prints the customer's AR invoice) |
| Delivery Order | `Delivery_Order _<HBL>.pdf` | trucker (CTC / Nextrade / Q-Trans) — POD signature block |
| Authority to Make Entry | `AUTH_HBL_<HAWB>.pdf` | broker / pickup trucker (issued in the consignee's name) |
| Invoice (AR) | `AR_INV12214_<Customer>.pdf` | customer billing email — batched "Invoice - <Customer>" |
| Debit / Credit Note | `DC_DCN11664-<Agent>.pdf` | overseas agent (NSC) |

PDF output needs Chromium (otherwise HTML). Re-issued shipment documents get `_Rev`, `_Rev2`.
Company name, address, tel/fax, accounting contact and **payment instructions** are edited in **Admin › Company**
(stored in the database only — keep bank details out of source control). Filing numbers continue the current sequence:
`OI-#####` ocean import, `AI-#####` air import, `OTH#######` other; `INV-#####`, `DCN-#####` (next numbers editable).

## Staff workspace
Staff sign in to **/app**: ☰ opens the menu (Main, Shipments, Documents, Accounting, Master Code, Administration — like OPUS);
☆ next to any page adds it to the favorites bar at the top (saved per user). Every page opens in its own tab
(Main, Shipments, HANIL COSMETICS · TCLU…); shipment / invoice / party links open a new tab, and open tabs come back after a reload.

## Billing
* **AR invoices** per shipment; bill-to can be a sister entity (Unlockt / Heyhae / PGP), Ship To = importer (e.g. Solvenza).
  Customer default terms (Unlockt 25 days, PGP 0) set on the Parties page. Batch email per customer.
* **D/N / C/N to agents** (cost recovery; can start from the shipment's AP costs), **AP** vendor bills → shipment profit.
* **Payments**: one ACH can be applied across many invoices (oldest first); AR aging (current / 30 / 60 / 90 / 90+).
* **Agent statement of account** (NSC): open debit notes, credit notes and agent invoices with running balance and
  "sent to agent" date; select items to settle by netting (the rest is carried forward); Excel export / email.
* **Files are named Shipper · Container** (e.g. `HANIL COSMETICS · TCLU1234567`, `+1` for more boxes; air = shipper · AWB).
  The OPUS-style file number (OI-11828 / AI-10009) stays as the internal number shown under the name.
* **Accounting inside the file** (shipment page › Accounting): add vendor bills (with the vendor's invoice no.), AR invoices
  and D/Ns line by line; revenue / cost / profit / margin per file. **Billing › P&L by file**: by month / customer, Excel export.
* **Check & settle** (Billing › a vendor or customer): every open invoice with its lines, a checkbox per invoice, editable
  amount for partial payments; checking both sides with an agent nets them off.
* **Closing files**: once the delivered file's customer invoices (and agent D/Ns) are paid, it closes automatically and moves to
  **History**. A new invoice reopens it. Accounting staff can also close / reopen by hand.
  Delivered files that are *not invoiced*, *invoice not sent*, *awaiting payment* or *overdue* are flagged on the dashboard,
  the shipment list (Billing filter) and the tracking board — visible to accounting users only.

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
src/docs/pdf.js          HTML → PDF (Chromium)          src/accounting.js  invoices, D/N, payments, SOA, aging
src/company.js           company profile + document numbering   src/reset.js  remove test data
src/notify.js            outbox, email bodies, automation rules
src/docs/templates.js    A/N, D/O, ATME
src/routes/              auth, shipments, intake (portal), customer tracking, admin
views/                   EJS pages      public/  CSS/JS
```

## Go-live checklist
* [ ] Admin › Automation › **Delete test data** (removes demo shipments, invoices and demo logins; keeps parties and settings)
* [ ] Change the admin password (default `changeme123`) and delete / re-password the demo users (`demo1234`)
* [ ] Set `SESSION_SECRET`, `BASE_URL` (https)
* [ ] Outlook app registration (`MS_*`), tracking API keys
* [ ] Install Chromium for PDF output
* [ ] Admin › Company: payment instructions, next filing / invoice numbers (continue from OPUS)
* [ ] Parties: billing emails and payment terms per customer / agent
* [ ] Back up `data/` and `uploads/`

## Next steps
* Plug in the real A/N, D/O, ATME forms
* Smartsheet import of existing shipments
