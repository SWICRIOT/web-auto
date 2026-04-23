/**
 * bas-avi-pdfs-to-mongo
 *
 * Reads BasLedger rows that have an encryptedInvoiceId, fetches each avi's
 * PDF via the Telerik Reporting REST API backing BAS-K's "Granska PDF" viewer,
 * and upserts the bytes into `General.BasAviPdfs`.
 *
 * Idempotent: rows already stored with a fetchedAt newer than STALE_AFTER_DAYS
 * are skipped, so re-running just tops up anything missing.
 *
 * Auth: connects to an existing Chromium session via CDP on port 9222 (the
 * user must be logged into BAS-K). All Telerik calls run inside the browser
 * page context so cookies flow naturally.
 */

import { chromium, Page } from "playwright";
import { MongoClient, Collection, Binary } from "mongodb";
import * as child_process from "child_process";

const CDP_PORT = 9222;
const LEDGER_URL = "https://bas.batunionen.se/Ledger/Ledger";
const LEDGER_COLLECTION = "BasLedger";
const PDF_COLLECTION = "BasAviPdfs";
const REPORT_TYPE =
  "BasCore.Report.Reports.InvoiceBankGiroOCRPrintReport, BasCore.Report";
const STALE_AFTER_DAYS = 7;
const POLL_MS = 250;
const POLL_MAX = 40; // 10s total

interface LedgerRowSubset {
  aviNr: string;
  ocr: string;
  medlem: string;
  medlemsnr: string;
  encryptedInvoiceId?: string;
}

interface BasAviPdf {
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

function getMongoConnectionString(): string {
  return child_process
    .execSync(
      'az keyvault secret show --vault-name "hbk-main" --name "MongoConnectionString" --query "value" -o tsv',
      { encoding: "utf-8" }
    )
    .trim();
}

/**
 * Runs the Telerik Reporting 4-step dance in the page's fetch context,
 * returning the PDF as a base64 string (page.evaluate can't return Uint8Array
 * directly — base64 is the simplest cross-boundary representation).
 */
async function fetchAviPdfBase64(
  page: Page,
  encryptedInvoiceId: string
): Promise<{ base64: string; size: number; contentType: string } | { error: string }> {
  return page.evaluate(
    async ({ encryptedInvoiceId, REPORT_TYPE, POLL_MS, POLL_MAX }) => {
      const params = {
        BatchId: "",
        EncryptedInvoiceId: encryptedInvoiceId,
        ChargeId: "",
        IsShowWaterMark: "False",
        InvoiceReminderId: "0",
      };

      // 1. clientId
      const c = await fetch("/api/reports/clients", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!c.ok)
        return { error: `clients step: ${c.status} ${(await c.text()).substring(0, 200)}` };
      const { clientId } = await c.json();

      // 2. instanceId
      const i = await fetch(
        `/api/reports/clients/${clientId}/instances`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ report: REPORT_TYPE, parameterValues: params }),
        }
      );
      if (!i.ok)
        return { error: `instance step: ${i.status} ${(await i.text()).substring(0, 200)}` };
      const { instanceId } = await i.json();

      // 3. documentId
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
        return { error: `document step: ${d.status} ${(await d.text()).substring(0, 200)}` };
      const { documentId } = await d.json();

      // 4. poll info until ready
      let ready = false;
      for (let k = 0; k < POLL_MAX; k++) {
        const info = await fetch(
          `/api/reports/clients/${clientId}/instances/${instanceId}/documents/${documentId}/info`,
          { credentials: "include" }
        );
        if (!info.ok)
          return { error: `info step: ${info.status} ${(await info.text()).substring(0, 200)}` };
        const js = await info.json();
        if (js.documentReady) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!ready) return { error: "document not ready after poll timeout" };

      // 5. fetch PDF bytes → base64 (page.evaluate can't return binary directly)
      const resp = await fetch(
        `/api/reports/clients/${clientId}/instances/${instanceId}/documents/${documentId}`,
        { credentials: "include" }
      );
      if (!resp.ok)
        return { error: `pdf fetch: ${resp.status}` };
      const contentType = resp.headers.get("content-type") || "application/pdf";
      const buf = await resp.arrayBuffer();
      // Sanity-check PDF magic
      const head = new Uint8Array(buf.slice(0, 5));
      const isPdf =
        head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 &&
        head[4] === 0x2d; // "%PDF-"
      if (!isPdf) return { error: "response was not a PDF (magic bytes mismatch)" };

      // Encode to base64
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let p = 0; p < bytes.length; p += chunk) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(p, p + chunk))
        );
      }
      return {
        base64: btoa(binary),
        size: bytes.length,
        contentType,
      };
    },
    { encryptedInvoiceId, REPORT_TYPE, POLL_MS, POLL_MAX }
  );
}

async function main() {
  // ── Connect to existing Chromium session ──
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  } catch {
    console.error(
      `Chrome not reachable on CDP ${CDP_PORT}. Start Chrome with --remote-debugging-port=${CDP_PORT} and log into BAS-K first.`
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

  // Ensure we're on a BAS-K page so same-origin fetch works
  if (!page.url().startsWith("https://bas.batunionen.se/")) {
    await page.goto(LEDGER_URL, { waitUntil: "networkidle" });
  }
  if (page.url().includes("/Account/Login")) {
    console.error("Not logged in to BAS-K. Aborting.");
    process.exit(1);
  }

  // ── Connect to MongoDB ──
  const mongoClient = new MongoClient(getMongoConnectionString(), {
    tls: true,
    tlsAllowInvalidCertificates: true,
  });
  await mongoClient.connect();
  const db = mongoClient.db("General");
  const ledger: Collection<LedgerRowSubset> = db.collection(LEDGER_COLLECTION);
  const pdfs: Collection<BasAviPdf> = db.collection(PDF_COLLECTION);

  // Ensure the lookup index exists (idempotent).
  await pdfs.createIndex({ aviNr: 1, ocr: 1 }, { unique: true });

  // ── Enumerate candidates ──
  const candidates = await ledger
    .find({ encryptedInvoiceId: { $exists: true, $ne: "" } })
    .project<LedgerRowSubset>({
      aviNr: 1,
      ocr: 1,
      medlem: 1,
      medlemsnr: 1,
      encryptedInvoiceId: 1,
    })
    .toArray();

  console.log(`Found ${candidates.length} ledger rows with encryptedInvoiceId`);

  const staleCutoff = new Date(
    Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    const label = `[${i + 1}/${candidates.length}] avi=${row.aviNr} ${row.medlem.padEnd(30).substring(0, 30)}`;
    process.stdout.write(`\r${label}`);

    // Skip if we already have a fresh PDF
    const existing = await pdfs.findOne({ aviNr: row.aviNr, ocr: row.ocr });
    if (existing && existing.fetchedAt > staleCutoff) {
      skipped++;
      continue;
    }

    const result = await fetchAviPdfBase64(page, row.encryptedInvoiceId!);
    if ("error" in result) {
      console.log(`\n  FAILED ${row.aviNr}: ${result.error}`);
      failed++;
      continue;
    }

    const content = Buffer.from(result.base64, "base64");
    const doc: BasAviPdf = {
      aviNr: row.aviNr,
      ocr: row.ocr,
      medlemsnr: row.medlemsnr,
      medlem: row.medlem,
      encryptedInvoiceId: row.encryptedInvoiceId!,
      content: new Binary(content),
      size: result.size,
      contentType: result.contentType,
      fetchedAt: new Date().toISOString(),
    };
    await pdfs.updateOne(
      { aviNr: row.aviNr, ocr: row.ocr },
      { $set: doc },
      { upsert: true }
    );
    ok++;
  }

  console.log(
    `\n\nDone. ${ok} fetched, ${skipped} skipped (fresh), ${failed} failed.`
  );
  await mongoClient.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
