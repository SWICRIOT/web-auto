// Fortnox web-app page API (apps5.fortnox.se), learned by exploration 2026-09-30.
// The web app is a shell page with the real UI in an iframe (/webapp-ui/<tenantId>?container#/...).
// That iframe calls an internal JSON API under /api/... authenticated by an `x-token` header
// (32 chars, per session) plus the session cookies. The financial year is the one selected in the UI.
//
// Known internal endpoints (read-only so far):
//   GET /api/bf/vouchers?perpage=100&pagenum=1&sortby=id&order=asc   list, selected financial year
//   GET /api/bf/vouchers/<series>-<number>?meta=1&year=<yearId>       one voucher, with postings + meta
//       (without &year= the year selected in the UI is used; financialyear=/fy= are ignored)
//       meta: showAlterButton, showInvertButton, showDeleteButton, accounts, ...
//   GET /api/meta/data?q=costCenters,projects,...                     settings incl. cost centers
// Voucher ids elsewhere are <yearId>-<series>-<number> (e.g. 1-E-35).
// UI route of a voucher: #/bf/voucher/<series>-<number>
// Postings keep their history: an edit ("Ändra") marks old rows removed (removed, removedBy, removedTime)
// and adds new rows inside the same voucher; no correction voucher is created.
import type { Page, Frame } from "playwright";

export const TENANT_APP = "https://apps5.fortnox.se/app";

export interface Posting {
  account: number; description?: string; debit?: number; credit?: number;
  transactionInformation?: string; rowNumber: number; removed?: number;
  costCenter?: string; project?: string; [k: string]: unknown;
}
export interface Voucher {
  id: number; year: number; voucherSeries: string; description: string; transactionDate: string;
  locked: boolean; costCenter: string; postings: Posting[]; [k: string]: unknown;
}

/** The iframe that hosts the Fortnox UI and makes the /api calls. */
export function appFrame(page: Page): Frame {
  const f = page.frames().find(fr => fr.url().includes("/webapp-ui/"));
  if (!f) throw new Error("Fortnox app frame not found; is a tenant open?");
  return f;
}

/** Wait until the app iframe is loaded (after a reload or navigation). */
export async function waitForAppFrame(page: Page, timeoutMs = 30000): Promise<Frame> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = page.frames().find(fr => fr.url().includes("/webapp-ui/"));
    if (f) { await f.waitForLoadState("domcontentloaded"); return f; }
    await page.waitForTimeout(250);
  }
  throw new Error("Fortnox app frame did not appear; is a tenant open?");
}

/** Capture the session's x-token by reloading and watching the app's own requests. */
export async function captureToken(page: Page, timeoutMs = 15000): Promise<string> {
  let tok: string | undefined;
  const h = (r: { headers(): Record<string, string> }) => { const x = r.headers()["x-token"]; if (x) tok = x; };
  page.on("request", h);
  try {
    await page.reload();
    const t0 = Date.now();
    while (!tok && Date.now() - t0 < timeoutMs) await page.waitForTimeout(200);
  } finally { page.off("request", h); }
  if (!tok) throw new Error("no x-token seen; not logged in?");
  return tok;
}

/** GET an internal endpoint from inside the app frame (same origin, same cookies). */
export async function apiGet<T = unknown>(page: Page, token: string, path: string): Promise<T> {
  return appFrame(page).evaluate(async ([p, t]) => {
    const r = await fetch(p, { headers: { "x-token": t, "x-requested-with": "XMLHttpRequest", Accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${p}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }, [path, token] as const) as Promise<T>;
}

/** One voucher of the selected financial year, e.g. getVoucher(page, tok, "E", 35). */
export async function getVoucher(page: Page, token: string, series: string, no: number, year?: number): Promise<{ voucher: Voucher; meta: Record<string, unknown> }> {
  const d = await apiGet<{ result: Voucher; meta: Record<string, unknown> }>(page, token, `/api/bf/vouchers/${series}-${no}?meta=1${year ? `&year=${year}` : ""}`);
  if (year && d.result.year !== year) throw new Error(`asked for year ${year}, got ${d.result.year}`);
  return { voucher: d.result, meta: d.meta };
}

/** Rows that are still in force (history rows marked removed are excluded). */
export function activePostings(v: Voucher): Posting[] {
  return v.postings.filter(p => !p.removed);
}

// ---- Writing: cost places on existing rows ------------------------------------------------------
// Learned 2026-09-30 from the E-35 pilot: "Ändra" + "Bokför" sends ONE request,
//   PUT /api/bf/vouchers/<series>-<no>?meta=1   body = the whole voucher (fields as from GET, plus
//   per posting: costCenter, projectFollowUpId, removed 0/1, quantity, ...), with locked:false.
// The rows keep their rowNumber; a cost-place change is made in place, no new rows, no correction
// voucher. Before saving, the UI shows "OBSERVERA: Ändringarna i verifikationen kommer inte att påverka
// reskontran ..." for vouchers linked to the supplier ledger; harmless when only costCenter changes.

export interface CostCenterChange { rowNumber: number; costCenter: string; }

/** Switch the session's selected financial year (what the year menu in the header does).
 *  Learned 2026-09-30: reads accept &year=, but a PUT on a voucher is refused with
 *  "Fel räkenskapsår" (code 2001923) unless the session's year is the voucher's year. */
export async function changeFinancialYear(page: Page, token: string, yearId: number): Promise<void> {
  await appFrame(page).evaluate(async ([t, y]) => {
    const r = await fetch("/api/bf/financialyears/change", { method: "PUT", body: JSON.stringify({ id: y }),
      headers: { "x-token": t, "x-requested-with": "XMLHttpRequest", Accept: "application/json", "Content-Type": "application/json" } });
    if (!r.ok) throw new Error(`financial year change to ${y}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }, [token, yearId] as const);
}

/** Fields that may differ between the stored voucher and what we send; everything else must be equal. */
const ALLOWED_DIFF = new Set(["costCenter"]);

/** Set cost places on specific rows of one voucher (selected financial year) and verify by read-back.
 *  Refuses if a row is missing, removed, or if anything except costCenter would change. */
export async function setCostCenters(page: Page, token: string, year: number, series: string, no: number,
                                     changes: CostCenterChange[]): Promise<{ before: Posting[]; after: Posting[] }> {
  const { voucher } = await getVoucher(page, token, series, no, year);
  const byRow = new Map(voucher.postings.map(p => [p.rowNumber, p]));
  for (const c of changes) {
    // (a row may already carry a cost place; the caller decides whether reassigning it is intended)
    const p = byRow.get(c.rowNumber);
    if (!p) throw new Error(`${series}-${no}: row ${c.rowNumber} not found`);
    if (p.removed) throw new Error(`${series}-${no}: row ${c.rowNumber} is removed`);
  }
  const want = new Map(changes.map(c => [c.rowNumber, c.costCenter]));
  const body = {
    ...voucher, locked: false, lastmodified: null,
    postings: voucher.postings.map(p => ({ ...p, removed: p.removed ? 1 : 0,
      costCenter: want.has(p.rowNumber) ? want.get(p.rowNumber)! : (p.costCenter ?? "") })),
  };
  // guard: only costCenter may differ per posting
  body.postings.forEach((p, i) => {
    const o = voucher.postings[i];
    for (const k of Object.keys(o)) if (!ALLOWED_DIFF.has(k) && k !== "removed" && JSON.stringify(o[k]) !== JSON.stringify((p as Record<string, unknown>)[k]))
      throw new Error(`${series}-${no}: field ${k} of row ${o.rowNumber} would change`);
  });
  await changeFinancialYear(page, token, year);
  await appFrame(page).evaluate(async ([s, n, t, b, y]) => {
    const r = await fetch(`/api/bf/vouchers/${s}-${n}?meta=1&year=${y}`, { method: "PUT", body: b,
      headers: { "x-token": t, "x-requested-with": "XMLHttpRequest", Accept: "application/json", "Content-Type": "application/json" } });
    if (!r.ok) throw new Error(`PUT ${s}-${n}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  }, [series, no, token, JSON.stringify(body), year] as const);
  const after = (await getVoucher(page, token, series, no, year)).voucher;
  // verify: same rows, same amounts/accounts, cost places as wanted
  if (after.postings.length !== voucher.postings.length) throw new Error(`${series}-${no}: row count changed`);
  for (const p of after.postings) {
    const o = byRow.get(p.rowNumber);
    if (!o || o.account !== p.account || (o.debit ?? 0) !== (p.debit ?? 0) || (o.credit ?? 0) !== (p.credit ?? 0) || !!o.removed !== !!p.removed)
      throw new Error(`${series}-${no}: row ${p.rowNumber} differs after save`);
    if (want.has(p.rowNumber) && (p.costCenter ?? "") !== want.get(p.rowNumber)) throw new Error(`${series}-${no}: row ${p.rowNumber} cost place not set`);
  }
  return { before: voucher.postings, after: after.postings };
}

/** Open a voucher in the UI (the app frame navigates by hash). */
export async function openVoucherUi(page: Page, series: string, no: number): Promise<void> {
  const f = appFrame(page);
  await f.evaluate(h => { location.hash = h; }, `#/bf/voucher/${series}-${no}`);
  await page.waitForTimeout(1500);
}
