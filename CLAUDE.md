# web-auto

Browser automation framework for scriptable, reusable web interactions. Built on Playwright (TypeScript) with an HTTP pilot server for live interaction and MCP servers for Claude Code integration.

## Project structure

```
web-auto/
├── core/src/
│   ├── browser.ts      — launch browser, cookie persistence, cleanup
│   ├── connect.ts      — connect to running browser via CDP
│   ├── download.ts     — file download helpers (click-to-download, direct URL)
│   ├── nav.ts          — navigation helpers (goTo, retry, login, waitFor)
│   ├── server.ts       — launch browser with CDP on port 9222
│   ├── pilot.ts        — HTTP server (port 3001) for live browser interaction
│   ├── mcp-server.ts   — MCP server exposing BAS-K tools to Claude Code
│   └── index.ts        — re-exports
├── tasks/src/
│   ├── example.ts      — basic example
│   ├── bas-payment-import.ts  — navigate to BAS OCR page
│   ├── bas-explore.ts  — screenshot all BAS pages
│   ├── snap.ts         — quick screenshot utility
│   └── run.ts          — scratch pad for ad-hoc scripts
├── .cache/             — local caches (imported payments, etc.)
├── .screenshots/       — screenshots taken by pilot/tasks
└── .browser-state/     — browser cookies/storage persistence
```

## Architecture

### Three modes of operation

1. **Task scripts** (`tasks/src/*.ts`) — standalone scripts for full workflows. Run with `npx ts-node tasks/src/script.ts`. Good for repeatable, unattended operations.

2. **Pilot HTTP server** (`core/src/pilot.ts`) — persistent server on port 3001 for live interactive use. Stays connected to the browser, responds to curl. Fast iteration.

3. **MCP server** (`core/src/mcp-server.ts`) — exposes tools via Model Context Protocol for Claude Code to call directly. Registered as `web-auto.bas-k` in Claude Code settings.

### Browser lifecycle

- `server.ts` launches Chromium with `--remote-debugging-port=9222`
- Both pilot and MCP server connect via CDP (`chromium.connectOverCDP`)
- Pages persist across connections — the browser stays open
- MCP server auto-launches a browser if none is running

## Pilot server endpoints

### Generic browser control
- `GET /url` — current page URL
- `GET /screenshot` — save screenshot to `.screenshots/page.png`
- `POST /goto` `{url}` — navigate
- `POST /click` `{selector}` — click element
- `POST /fill` `{selector, value}` — fill input
- `POST /select` `{selector, value}` — select dropdown option
- `POST /upload` `{selector, file}` — upload file via file chooser
- `POST /eval` `{code}` — evaluate JS with `page` and `browser` in scope
- `GET /html?selector=` — get innerHTML
- `GET /text?selector=` — get text content
- `GET /elements?selector=` — list visible interactive elements

### BAS-K domain actions
- `POST /bas/import-payment` `{file}` — full payment import workflow (checks cache, navigates, uploads, submits)
- `POST /bas/sync-imported` — scrape all imported payments into local cache
- `GET /bas/imported-payments` — read cache

## MCP tools (web-auto.bas-k)

| Tool | Description |
|---|---|
| `screenshot` | Screenshot current page |
| `browser_goto` | Navigate to URL |
| `browser_click` | Click element |
| `browser_url` | Get current URL |
| `browser_eval` | Evaluate JS in page context |
| `browser_text` | Get element text |
| `browser_elements` | List visible interactive elements |
| `bas_import_payment` | Import payment file (cache-aware) |
| `bas_sync_imported` | Sync import history to local cache |
| `bas_list_imported` | List cached imported payments |

## BAS-K (bas.batunionen.se)

Boat club management system for Heleneborgs Båtklubb. Requires BankID login (manual).

### Key workflows

**Payment import (OCR inläsning)**:
1. Navigate to `/PaymentProcessing/PaymentProcessing`
2. File type defaults to P27 (ISO20022) — correct for ISO files
3. Upload via `.k-upload-button` (Kendo widget — must use `waitForEvent('filechooser')`, not `setInputFiles`)
4. Submit via `#btnLoadFile`
5. May show warning dialog if file was already imported

**Important: Kendo UI gotchas**:
- File upload: do NOT use `setInputFiles` + `dispatchEvent('change')` — breaks Kendo's internal state. Use `waitForEvent('filechooser')` + `.k-upload-button` click instead.
- Dropdowns: hidden `<select>` elements wrapped in Kendo widgets. Use `page.$eval` to read values, not `selectOption` on the hidden element.
- Pagination: page number links exist in `.k-pager-numbers`. "Fler sidor" link loads more page numbers.
- Dialogs: appear as `.k-window` elements. Read text with `.innerText()`, dismiss with button click.

### Payment files location
```
C:\Users\Alex\Dropbox\__MAIN__\Organisatoriska engagemang\HBK\Kassör\2025.2026\Inbetalningar\ISO20022\
```
Files are named `Camt053.eody.065564696291F001.DYYMMDD.T*.xml`

### Site map

**Medlemmar** (Members): search, groups, boat groups, update requests
**Rapporter** (Reports): custom reports, negative invoices, inactive members
**Kommunikation**: compose (email/SMS/letter), drafts, sent, distribution, SMS balance
**Ekonomi** (Finance): fees, invoicing, ledger, deposits, accounting journal, discrepancies, e-invoice matching, fee groups, OCR import
**Platshantering** (Berths): spots, areas (Hamn/Varv/Kajak summer/winter), pricing formulas
**Kö** (Queues): waiting list applications, queue admin
**Filer** (Files): file storage, document templates
**Schema** (Schedules): watchman duty schedules, admin
**Inställningar** (Settings): chart of accounts, permissions, custom fields, reference data, email/finance settings, audit log
**Utlåning** (Lending): active loans, lendable item types (keys, etc.)
**Klubb** (Club): club card, annual report, roles/functions, batch edit, import, user accounts
**Hjälp** (Help): wiki manual, support tickets

## Fortnox (apps5.fortnox.se)

BankID login is manual (Fortnox ID, then choose the tenant). The UI lives in an iframe
(`/webapp-ui/<tenantId>?container#/...`) that calls an internal JSON API under `/api/...` with an
`x-token` session header. Page API: `core/src/fortnox.ts` (captureToken, waitForAppFrame, getVoucher,
activePostings, changeFinancialYear, setCostCenters). Learned 2026-09-30:
- `GET /api/bf/vouchers/<series>-<no>?meta=1&year=<yearId>` reads any year; a PUT only works for the
  session's selected year, switched with `PUT /api/bf/financialyears/change {"id":<yearId>}`.
- A booked voucher's cost place (KS) can be changed in place with `PUT /api/bf/vouchers/<series>-<no>?meta=1`
  (whole voucher as body); rows keep their rowNumber, no correction voucher. The public Fortnox API has no
  such PUT.
- Task `tasks/src/fortnox-cost-centers.ts <plan.json> [--apply] [--only 2025:K-6] [--log f]`: dry run by
  default, resolves plan rows by account + amount (+ row text), idempotent, stops at the first deviation,
  refuses to overwrite a different cost place unless the row says `reassign` + `from`. Run with
  `TS_NODE_TRANSPILE_ONLY=1` (the tasks tsconfig rootDir excludes core/).

## Running

```bash
# Start browser server (background)
cd D:/projects/hbk/web-auto && npx ts-node core/src/server.ts

# Start pilot for interactive use (background)
cd D:/projects/hbk/web-auto && npx ts-node core/src/pilot.ts

# Run a task script
cd D:/projects/hbk/web-auto && npx ts-node tasks/src/bas-payment-import.ts

# MCP server is started automatically by Claude Code
```

## Tech notes

- npm workspaces: `core` and `tasks` packages, linked via `@web-auto/core`
- Express 5.x on pilot server
- `curl` with `--data-binary @- <<'EOF'` + `\u00f6` escapes for Swedish characters (ö, ä, å) in JSON
- Screenshots viewable via Claude Code's Read tool (supports PNG)
- Port 3001 for pilot (3000 was taken)
