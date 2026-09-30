// Tag existing Fortnox voucher rows with cost places, from a plan file. Dry run by default.
//
//   npx ts-node tasks/src/fortnox-cost-centers.ts <plan.json> [--apply] [--only 2023:E-37,2025:K-6] [--log <file>]
//
// Needs the web-auto browser (CDP :9222) with Fortnox open and a tenant selected (BankID login is manual).
// Plan: [{ "fy": 2023, "year": 1, "voucher": "E-37", "rows": [{ "account": 5410, "amount": 130.60,
//          "info": "Datormus", "costCenter": "KONTOR" }, ...] }, ...]
// Each plan row is resolved to one active posting by account + amount (debit or credit), and by the
// posting's transaction info when account + amount is ambiguous. Rows already carrying the wanted cost
// place are skipped (the run is idempotent). Anything unexpected stops the run before that voucher is
// written: a missing row, an ambiguous match, a row that already has a DIFFERENT cost place.
// --apply writes with fortnox.setCostCenters (PUT + read-back verification) and logs every voucher.
import { chromium } from "playwright";
import * as fs from "fs";
import { captureToken, waitForAppFrame, getVoucher, activePostings, setCostCenters, type Posting, type CostCenterChange } from "../../core/src/fortnox";

// reassign + from: explicitly move a row from one cost place to another (e.g. { costCenter: "KONTOR",
// reassign: true, from: "EL" }); without it a row that already has a different cost place stops the run.
interface PlanRow { account: number; amount: number; info?: string; costCenter: string; reassign?: boolean; from?: string; }
interface PlanVoucher { fy: number; year: number; voucher: string; rows: PlanRow[]; }

const args = process.argv.slice(2);
const planPath = args.find(a => !a.startsWith("--"));
const apply = args.includes("--apply");
const onlyArg = args[args.indexOf("--only") + 1];
const only = args.includes("--only") && onlyArg ? new Set(onlyArg.split(",")) : null;
const logPath = args.includes("--log") ? args[args.indexOf("--log") + 1] : "fortnox-cost-centers.log.jsonl";
if (!planPath) { console.error("usage: fortnox-cost-centers.ts <plan.json> [--apply] [--only 2023:E-37] [--log file]"); process.exit(2); }

const amountOf = (p: Posting) => Math.round(((p.debit ?? 0) || -(p.credit ?? 0)) * 100) / 100;
const norm = (s?: string) => (s ?? "").trim().toLowerCase();

function resolve(pv: PlanVoucher, postings: Posting[]): { changes: CostCenterChange[]; skipped: number } {
  const active = activePostings({ postings } as never);
  const used = new Set<number>();
  const changes: CostCenterChange[] = [];
  let skipped = 0;
  for (const r of pv.rows) {
    let cands = active.filter(p => p.account === r.account && Math.abs(Math.abs(amountOf(p)) - Math.abs(r.amount)) < 0.005 && !used.has(p.rowNumber));
    if (cands.length > 1 && r.info) {
      const byInfo = cands.filter(p => norm(p.transactionInformation as string) === norm(r.info));
      if (byInfo.length) cands = byInfo;
    }
    if (cands.length === 0) throw new Error(`${pv.fy} ${pv.voucher}: no active row ${r.account} ${r.amount} ${r.info ?? ""}`);
    if (cands.length > 1) {
      // identical rows with the same wanted cost place are interchangeable
      const same = cands.every(p => (p.costCenter ?? "") === (cands[0].costCenter ?? ""));
      if (!same) throw new Error(`${pv.fy} ${pv.voucher}: ambiguous row ${r.account} ${r.amount}`);
    }
    const p = cands[0];
    used.add(p.rowNumber);
    const cur = (p.costCenter as string) ?? "";
    if (cur === r.costCenter) { skipped++; continue; }
    if (cur !== "" && !(r.reassign && cur === r.from))
      throw new Error(`${pv.fy} ${pv.voucher}: row ${p.rowNumber} already has cost place ${cur}, plan says ${r.costCenter}`);
    changes.push({ rowNumber: p.rowNumber, costCenter: r.costCenter });
  }
  return { changes, skipped };
}

(async () => {
  const plan: PlanVoucher[] = JSON.parse(fs.readFileSync(planPath, "utf-8"));
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("fortnox.se/app/"));
  if (!page) throw new Error("no Fortnox tab with a selected tenant in the web-auto browser");
  const token = await captureToken(page);
  await waitForAppFrame(page);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  let vouchers = 0, rowsChanged = 0, rowsSkipped = 0;
  for (const pv of plan) {
    const key = `${pv.fy}:${pv.voucher}`;
    if (only && !only.has(key)) continue;
    const [series, noStr] = pv.voucher.split("-");
    const { voucher } = await getVoucher(page, token, series, Number(noStr), pv.year);
    const { changes, skipped } = resolve(pv, voucher.postings);
    rowsSkipped += skipped;
    const summary = changes.map(c => { const p = voucher.postings.find(x => x.rowNumber === c.rowNumber)!; return `r${c.rowNumber} ${p.account} ${amountOf(p)} ${p.transactionInformation ?? ""} -> ${c.costCenter}`; });
    if (changes.length === 0) { console.log(`${key}: nothing to change (${skipped} already set)`); continue; }
    if (!apply) { console.log(`${key} [dry run] ${voucher.description}\n  ${summary.join("\n  ")}`); vouchers++; rowsChanged += changes.length; continue; }
    await setCostCenters(page, token, pv.year, series, Number(noStr), changes);
    log.write(JSON.stringify({ at: new Date().toISOString(), voucher: key, changes: summary }) + "\n");
    console.log(`${key}: ${changes.length} rows set, verified`);
    vouchers++; rowsChanged += changes.length;
  }
  console.log(`${apply ? "applied" : "dry run"}: ${vouchers} vouchers, ${rowsChanged} rows to change, ${rowsSkipped} rows already right`);
  log.end();
  await browser.close().catch(() => undefined); // closes the CDP connection only; the browser keeps running
})().catch(e => { console.error("STOPPED:", e.message); process.exit(1); });
