/**
 * bas-scrape-all
 *
 * One-shot BAS-K scraper that runs off a single authenticated browser session:
 *   1. Fetches the full ledger via /Ledger/GetFilteredLedgerForGrid  (1 HTTP call)
 *   2. For each ledger row, fetches transaction details + encryptedInvoice
 *      via /Ledger/GetInvoiceDetail + /Ledger/GetInvoiceTransactions (parallel)
 *   3. Upserts into General.BasLedger keyed by invoiceId
 *   4. Fetches missing / stale PDFs via the Telerik Reporting REST API and
 *      upserts into General.BasAviPdfs
 *   5. Writes an IngestionRun audit record to General.IngestionRuns so the
 *      Ingestion Monitor page shows status + duration + errors
 *
 * Every step runs inside the logged-in Chromium page context, so auth is via
 * the browser's session cookies — no credential handling in this script.
 *
 * Prerequisite: Chrome running with --remote-debugging-port=9222, logged in
 * to BAS-K via BankID.
 */

import { chromium, Page } from "playwright";
import {
  MongoClient,
  Collection,
  Binary,
  ObjectId,
} from "mongodb";
import * as child_process from "child_process";
import * as os from "os";

const CDP_PORT = 9222;
const LEDGER_URL = "https://bas.batunionen.se/Ledger/Ledger";
const LEDGER_COLLECTION = "BasLedger";
const PDF_COLLECTION = "BasAviPdfs";
const RUNS_COLLECTION = "IngestionRuns";
const PIPELINE_KEY = "bas-ledger";
const TENANT = "hbk";
const REPORT_TYPE =
  "BasCore.Report.Reports.InvoiceBankGiroOCRPrintReport, BasCore.Report";
const STALE_PDF_AFTER_DAYS = 7;
const DETAIL_CONCURRENCY = 20;
const PDF_CONCURRENCY = 6;

// ── Mongo plumbing ──

function getMongoConnectionString(): string {
  return child_process
    .execSync(
      'az keyvault secret show --vault-name "hbk-main" --name "MongoConnectionString" --query "value" -o tsv',
      { encoding: "utf-8" }
    )
    .trim();
}

// ── Shared evaluate helpers ──

/**
 * Concurrency-capped parallel fetch. Runs `worker(item)` for every item in
 * `items`, never more than `limit` in flight. Returns results in the original
 * order; throws on the first worker exception (caller decides retry).
 */
async function parallelMap<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    });
  await Promise.all(runners);
  return out;
}

// ── Types — only the fields we actually persist ──

interface LedgerMain {
  invoiceId: number;
  chargeId: number | null;
  aviNr: string;
  ocr: string;
  medlem: string;
  medlemsnr: string;
  forfDatum: string;
  belopp: number;
  inbetaltAck: number;
  aterstar: number;
}

interface TxnRow {
  transTyp: string;
  typInfo: string;
  transDatum: string;
  fordran: number;
  inbetalt: number;
  lopnr: string;
  bfo: string;
  bfDatum: string;
  via: string;
  konto: string;
  registeradAv: string;
}

interface LedgerDoc extends LedgerMain {
  details: TxnRow[];
  detailSumMatchesBelopp: boolean;
  encryptedInvoiceId?: string;
  scrapedAt: string;
  detailsScrapedAt: string;
}

interface AviPdfDoc {
  aviNr: string;
  ocr: string;
  medlemsnr: string;
  medlem: string;
  encryptedInvoiceId: string;
  content: Binary;
  size: number;
  contentType: string;
  fetchedAt: string;
}

// ── Phase 1: main ledger table via API ──

async function fetchMainLedger(page: Page): Promise<LedgerMain[]> {
  const raw = await page.evaluate(async () => {
    const r = await fetch("/Ledger/GetFilteredLedgerForGrid", {
      credentials: "include",
    });
    if (!r.ok) throw new Error(`GetFilteredLedgerForGrid ${r.status}`);
    const js = await r.json();
    return js.Data || [];
  });

  const mapAmount = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "string") return parseFloat(v.replace(",", ".")) || 0;
    return 0;
  };
  const mapDate = (v: unknown): string => {
    if (!v || typeof v !== "string") return "";
    // API returns "2022-02-16T00:00:00" or "2022-01-16"
    return v.substring(0, 10);
  };

  return raw
    .filter((r: any) => r.RowType === "Invoice" && r.InvoiceId)
    .map((r: any): LedgerMain => ({
      invoiceId: r.InvoiceId,
      chargeId: r.ChargeId ?? null,
      aviNr: String(r.InvoiceNr ?? ""),
      ocr: r.OCR != null ? String(r.OCR) : "",
      medlem: r.MemberName || "",
      medlemsnr: r.MemberNo != null ? String(r.MemberNo) : "",
      forfDatum: mapDate(r.ChargeExpireDate),
      belopp: mapAmount(r.Amount),
      inbetaltAck: mapAmount(r.AmountIn),
      aterstar: mapAmount(r.InvoicePayDiffVal ?? r.InvoicePayDiff),
    }));
}

// ── Phase 2: per-invoice detail + encrypted PDF token ──

async function fetchDetailBundle(
  page: Page,
  invoiceId: number
): Promise<{ txns: TxnRow[]; encryptedInvoice: string | null }> {
  return page.evaluate(async (id) => {
    const [dRes, tRes] = await Promise.all([
      fetch(`/Ledger/GetInvoiceDetail/${id}`, { credentials: "include" }),
      fetch(`/Ledger/GetInvoiceTransactions?invoiceId=${id}`, { credentials: "include" }),
    ]);
    if (!dRes.ok) throw new Error(`GetInvoiceDetail/${id} ${dRes.status}`);
    if (!tRes.ok) throw new Error(`GetInvoiceTransactions/${id} ${tRes.status}`);
    const detail = await dRes.json();
    const txn = await tRes.json();
    const encryptedInvoice =
      detail.Data?.[0]?.EncryptedInvoice ?? null;

    const toNum = (v: unknown): number =>
      typeof v === "number"
        ? v
        : typeof v === "string"
        ? parseFloat(v.replace(",", ".")) || 0
        : 0;

    const txns = (txn.Data || []).map((t: any) => ({
      transTyp: t.Transtype || "",
      typInfo: t.TransInfo || "",
      transDatum: typeof t.RegDate === "string" ? t.RegDate.substring(0, 10) : "",
      fordran: toNum(t.Amount),
      inbetalt: toNum(t.AmountIn),
      lopnr: t.RowId != null ? String(t.RowId) : "",
      bfo: t.BkOrderNo || "",
      bfDatum: t.BfRegDate || "",
      via: t.PayMethod || "",
      konto: t.BfAccountNo || "",
      registeradAv: t.RegByName || "",
    }));

    return { txns, encryptedInvoice };
  }, invoiceId);
}

// ── PDF fetch via Telerik Reporting REST ──

async function fetchAviPdfBase64(
  page: Page,
  encryptedInvoiceId: string
): Promise<{ base64: string; size: number; contentType: string } | { error: string }> {
  return page.evaluate(
    async ({ encryptedInvoiceId, REPORT_TYPE }) => {
      const params = {
        BatchId: "",
        EncryptedInvoiceId: encryptedInvoiceId,
        ChargeId: "",
        IsShowWaterMark: "False",
        InvoiceReminderId: "0",
      };

      const c = await fetch("/api/reports/clients", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!c.ok)
        return { error: `clients ${c.status} ${(await c.text()).substring(0, 200)}` };
      const { clientId } = await c.json();

      const i = await fetch(`/api/reports/clients/${clientId}/instances`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report: REPORT_TYPE, parameterValues: params }),
      });
      if (!i.ok)
        return { error: `instance ${i.status} ${(await i.text()).substring(0, 200)}` };
      const { instanceId } = await i.json();

      const d = await fetch(
        `/api/reports/clients/${clientId}/instances/${instanceId}/documents`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ format: "PDF", deviceInfo: {} }),
        }
      );
      if (!d.ok)
        return { error: `document ${d.status} ${(await d.text()).substring(0, 200)}` };
      const { documentId } = await d.json();

      for (let k = 0; k < 40; k++) {
        const info = await fetch(
          `/api/reports/clients/${clientId}/instances/${instanceId}/documents/${documentId}/info`,
          { credentials: "include" }
        );
        if (!info.ok)
          return { error: `info ${info.status} ${(await info.text()).substring(0, 200)}` };
        const js = await info.json();
        if (js.documentReady) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      const pdf = await fetch(
        `/api/reports/clients/${clientId}/instances/${instanceId}/documents/${documentId}`,
        { credentials: "include" }
      );
      if (!pdf.ok) return { error: `pdf ${pdf.status}` };
      const contentType = pdf.headers.get("content-type") || "application/pdf";
      const buf = await pdf.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 5));
      if (!(head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46))
        return { error: "non-PDF response" };
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let p = 0; p < bytes.length; p += chunk) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(p, p + chunk))
        );
      }
      return { base64: btoa(binary), size: bytes.length, contentType };
    },
    { encryptedInvoiceId, REPORT_TYPE }
  );
}

// ── IngestionRun audit ──

async function beginRun(
  runsCol: Collection<any>,
  triggeredBy: string
): Promise<ObjectId> {
  const doc = {
    _id: new ObjectId(),
    pipeline: PIPELINE_KEY,
    tenantId: TENANT,
    startedAt: new Date(),
    status: "running",
    recordsAdded: 0,
    recordsUpdated: 0,
    recordsDeleted: 0,
    triggeredBy,
  };
  await runsCol.insertOne(doc);
  return doc._id;
}

async function completeRun(
  runsCol: Collection<any>,
  runId: ObjectId,
  patch: Record<string, unknown>
): Promise<void> {
  await runsCol.updateOne(
    { _id: runId },
    { $set: { ...patch, completedAt: new Date() } }
  );
}

// ── Main ──

async function main() {
  const startMs = Date.now();

  // Connect to logged-in Chromium
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  } catch {
    console.error(
      `Chrome not on CDP ${CDP_PORT}. Launch Chrome with --remote-debugging-port=${CDP_PORT} and BankID to BAS-K first.`
    );
    process.exit(1);
  }
  let page: Page | undefined;
  for (const ctx of browser.contexts()) {
    if (ctx.pages().length > 0) {
      page = ctx.pages()[0];
      break;
    }
  }
  if (!page) {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  }
  if (!page.url().startsWith("https://bas.batunionen.se/")) {
    await page.goto(LEDGER_URL, { waitUntil: "domcontentloaded" });
  }
  if (page.url().includes("/Account/Login")) {
    console.error("Not logged in to BAS-K.");
    process.exit(1);
  }

  // Mongo
  const mongoClient = new MongoClient(getMongoConnectionString(), {
    tls: true,
    tlsAllowInvalidCertificates: true,
  });
  await mongoClient.connect();
  const db = mongoClient.db("General");
  const ledgerCol: Collection<LedgerDoc> = db.collection(LEDGER_COLLECTION);
  const pdfCol: Collection<AviPdfDoc> = db.collection(PDF_COLLECTION);
  const runsCol: Collection<any> = db.collection(RUNS_COLLECTION);

  // Cosmos's Mongo API rejects createIndex once a collection has been written
  // without it — the only way to change unique indexes there is to drop+recreate
  // the collection. Try; silently tolerate failure. Upserts below filter by the
  // intended keys anyway, so correctness doesn't depend on server-side uniqueness.
  try { await pdfCol.createIndex({ aviNr: 1, ocr: 1 }, { unique: true }); } catch {}
  try { await ledgerCol.createIndex({ invoiceId: 1 }, { unique: true }); } catch {}

  // Audit: begin run
  const triggeredBy = `manual:${os.userInfo().username || "unknown"}`;
  const runId = await beginRun(runsCol, triggeredBy);

  try {
    // Phase 1
    console.log("Phase 1: fetch main ledger...");
    const main = await fetchMainLedger(page);
    console.log(`  ${main.length} invoice rows`);

    // Phase 2: details in parallel (capped)
    console.log(`Phase 2: fetch details for ${main.length} invoices (concurrency=${DETAIL_CONCURRENCY})...`);
    let detailsOk = 0;
    let detailsFailed = 0;
    const bundles = await parallelMap(main, DETAIL_CONCURRENCY, async (r) => {
      try {
        const b = await fetchDetailBundle(page!, r.invoiceId);
        detailsOk++;
        return b;
      } catch (e) {
        detailsFailed++;
        console.log(`  detail failed invoiceId=${r.invoiceId}: ${String(e).substring(0, 200)}`);
        return { txns: [], encryptedInvoice: null };
      }
    });
    console.log(`  details: ${detailsOk} ok, ${detailsFailed} failed`);

    // Upsert to BasLedger
    console.log("Phase 3: upsert BasLedger...");
    const nowIso = new Date().toISOString();
    let added = 0;
    let updated = 0;
    for (let i = 0; i < main.length; i++) {
      const r = main[i];
      const b = bundles[i];
      const detailSum = b.txns.reduce((s, t) => s + t.fordran, 0);
      const sumMatch = Math.abs(detailSum - r.belopp) < 0.02;
      const set: LedgerDoc = {
        ...r,
        details: b.txns,
        detailSumMatchesBelopp: sumMatch,
        encryptedInvoiceId: b.encryptedInvoice ?? undefined,
        scrapedAt: nowIso,
        detailsScrapedAt: nowIso,
      };
      const res = await ledgerCol.updateOne(
        { invoiceId: r.invoiceId },
        { $set: set },
        { upsert: true }
      );
      if (res.upsertedCount > 0) added++;
      else if (res.modifiedCount > 0) updated++;
    }
    console.log(`  added=${added} updated=${updated}`);

    // Phase 4: PDFs
    console.log(`Phase 4: fetch PDFs (concurrency=${PDF_CONCURRENCY}, stale-after=${STALE_PDF_AFTER_DAYS}d)...`);
    const staleCutoff = new Date(
      Date.now() - STALE_PDF_AFTER_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const pdfCandidates: Array<{ row: LedgerMain; encryptedInvoiceId: string }> = [];
    for (let i = 0; i < main.length; i++) {
      const r = main[i];
      const b = bundles[i];
      if (!b.encryptedInvoice) continue;
      const existing = await pdfCol.findOne({ aviNr: r.aviNr, ocr: r.ocr });
      if (existing && existing.fetchedAt > staleCutoff) continue;
      pdfCandidates.push({ row: r, encryptedInvoiceId: b.encryptedInvoice });
    }
    console.log(`  ${pdfCandidates.length} PDFs to fetch`);

    let pdfsOk = 0;
    let pdfsFailed = 0;
    await parallelMap(pdfCandidates, PDF_CONCURRENCY, async ({ row, encryptedInvoiceId }, idx) => {
      process.stdout.write(`\r  [${idx + 1}/${pdfCandidates.length}] ${row.aviNr}`.padEnd(60));
      const result = await fetchAviPdfBase64(page!, encryptedInvoiceId);
      if ("error" in result) {
        pdfsFailed++;
        console.log(`\n    FAILED ${row.aviNr}: ${result.error}`);
        return;
      }
      const content = Buffer.from(result.base64, "base64");
      const doc: AviPdfDoc = {
        aviNr: row.aviNr,
        ocr: row.ocr,
        medlemsnr: row.medlemsnr,
        medlem: row.medlem,
        encryptedInvoiceId,
        content: new Binary(content),
        size: result.size,
        contentType: result.contentType,
        fetchedAt: new Date().toISOString(),
      };
      await pdfCol.updateOne(
        { aviNr: row.aviNr, ocr: row.ocr },
        { $set: doc },
        { upsert: true }
      );
      pdfsOk++;
    });
    console.log(`\n  pdfs: ${pdfsOk} ok, ${pdfsFailed} failed`);

    // Audit: complete run
    const elapsedS = Math.round((Date.now() - startMs) / 1000);
    const hadFailures = detailsFailed > 0 || pdfsFailed > 0;
    const status = main.length === 0 ? "empty" : hadFailures ? "failure" : "success";
    await completeRun(runsCol, runId, {
      status,
      recordsAdded: added,
      recordsUpdated: updated,
      recordsDeleted: 0,
      errorType: hadFailures ? "PartialFailure" : null,
      errorMessage: hadFailures
        ? `details failed=${detailsFailed}, pdfs failed=${pdfsFailed}`
        : null,
    });
    console.log(`\nDone in ${elapsedS}s. status=${status}`);
  } catch (err) {
    const e = err as Error;
    await completeRun(runsCol, runId, {
      status: "failure",
      errorType: e.name,
      errorMessage: (e.message || String(e)).substring(0, 500),
    });
    console.error("Scrape failed:", e);
    process.exit(1);
  } finally {
    await mongoClient.close();
  }
}

main();
