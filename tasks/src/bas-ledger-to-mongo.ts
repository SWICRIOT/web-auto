import { chromium, Page } from "playwright";
import { MongoClient, Collection } from "mongodb";
import * as child_process from "child_process";

const CDP_PORT = 9222;
const COLLECTION_NAME = "BasLedger";

interface LedgerDetail {
  transTyp: string;
  typInfo: string;
  transDatum: string;
  fordran: number;
  fordranRaw: string;
  inbetalt: number;
  inbetaltRaw: string;
  lopnr: string;
  bfo: string;
  bfDatum: string;
  via: string;
  konto: string;
  registeradAv: string;
}

interface LedgerRow {
  aviNr: string;
  ocr: string;
  medlem: string;
  medlemsnr: string;
  forfDatum: string;
  pamAvg: string;
  belopp: number;
  beloppRaw: string;
  inbetaltAck: number;
  inbetaltAckRaw: string;
  inbetaltDatum: string;
  aterstar: number;
  aterstarRaw: string;
  details: LedgerDetail[] | null; // null = not yet scraped
  scrapedAt: string;
  detailsScrapedAt?: string;
}

function parseAmount(s: string): number {
  return parseFloat(s.replace(/\s/g, "").replace("kr", "").replace(",", ".")) || 0;
}

function getMongoConnectionString(): string {
  return child_process
    .execSync(
      'az keyvault secret show --vault-name "hbk-main" --name "MongoConnectionString" --query "value" -o tsv',
      { encoding: "utf-8" }
    )
    .trim();
}

// ── Phase 1: Main table ──

async function scrapeMainTable(page: Page): Promise<LedgerRow[]> {
  const summaries = await page.$$eval(
    "table > tbody > tr:not(.k-detail-row)",
    (trs) =>
      trs
        .filter((tr) => tr.querySelectorAll("td").length > 5)
        .map((tr) => {
          // Only visible cells (skip hidden Invoice ID column)
          const cells = Array.from(tr.querySelectorAll("td")).filter(
            (c) => (c as HTMLElement).offsetWidth > 0
          );
          return {
            aviNr: cells[1]?.textContent?.trim() || "",
            ocr: cells[2]?.textContent?.trim() || "",
            medlem: cells[3]?.textContent?.trim() || "",
            medlemsnr: cells[4]?.textContent?.trim() || "",
            forfDatum: cells[5]?.textContent?.trim() || "",
            pamAvg: cells[6]?.textContent?.trim() || "",
            beloppRaw: cells[7]?.textContent?.trim() || "",
            inbetaltAckRaw: cells[8]?.textContent?.trim() || "",
            inbetaltDatum: cells[9]?.textContent?.trim() || "",
            aterstarRaw: cells[10]?.textContent?.trim() || "",
          };
        })
  );

  const now = new Date().toISOString();
  return summaries
    .filter((s) => s.aviNr && s.medlem) // Exclude footer/summary row
    .map((s) => ({
      ...s,
      belopp: parseAmount(s.beloppRaw),
      inbetaltAck: parseAmount(s.inbetaltAckRaw),
      aterstar: parseAmount(s.aterstarRaw),
      details: null,
      scrapedAt: now,
    }));
}

// ── Phase 2: Row details ──

async function collapseAll(page: Page) {
  // Collapse any open detail rows until none remain
  while (true) {
    const collapseBtns = page.locator("a.k-icon.k-i-collapse");
    if ((await collapseBtns.count()) === 0) return;
    try {
      await collapseBtns.first().click();
      await page.waitForTimeout(100);
    } catch {
      return;
    }
  }
}

async function scrapeRowDetails(
  page: Page,
  rowIndex: number
): Promise<LedgerDetail[] | null> {
  // Ensure clean state
  await collapseAll(page);

  const expandBtns = page.locator("a.k-icon.k-i-expand");
  if (rowIndex >= (await expandBtns.count())) return null;

  const btn = expandBtns.nth(rowIndex);
  await btn.scrollIntoViewIfNeeded();

  // Find the master row this button belongs to
  const masterRowId = await btn.evaluate((el) => el.closest("tr")?.getAttribute("data-uid") || "");

  await btn.click();

  // Wait for THIS master row's detail to appear with data
  try {
    await page.waitForFunction(
      (uid) => {
        // Find the master row
        const masterRow = uid
          ? document.querySelector(`tr[data-uid="${uid}"]`)
          : null;
        if (!masterRow) return false;

        // Detail row is the next sibling
        const detailRow = masterRow.nextElementSibling;
        if (!detailRow || !detailRow.classList.contains("k-detail-row")) return false;

        // Find the grid with Trans.typ
        const tables = detailRow.querySelectorAll(".k-detail-cell table");
        for (const t of tables) {
          const hasTransTyp = Array.from(t.querySelectorAll("thead th"))
            .some((h) => h.textContent?.trim() === "Trans.typ");
          if (!hasTransTyp) continue;

          // Check loading mask is gone
          const cell = t.closest(".k-detail-cell") as HTMLElement | null;
          const mask = cell?.querySelector(".k-loading-mask") as HTMLElement | null;
          const maskHidden = !mask || mask.style.display === "none" || !(mask as HTMLElement).offsetParent;

          const rows = t.querySelectorAll("tbody tr");
          if (maskHidden && rows.length > 0) return true;
        }
        return false;
      },
      masterRowId,
      { timeout: 10000 }
    );
  } catch {
    console.log(`\n  Row ${rowIndex}: timeout waiting for details`);
  }

  // Extract from THIS master row's detail only
  const details = await page.evaluate((uid) => {
    const masterRow = document.querySelector(`tr[data-uid="${uid}"]`);
    if (!masterRow) return [];
    const detailRow = masterRow.nextElementSibling;
    if (!detailRow) return [];

    for (const table of detailRow.querySelectorAll(".k-detail-cell table")) {
      const headers = Array.from(table.querySelectorAll("thead th"))
        .filter((h) => (h as HTMLElement).offsetWidth > 0)
        .map((h) => h.textContent?.trim() || "");
      if (!headers.includes("Trans.typ")) continue;

      return Array.from(table.querySelectorAll("tbody tr"))
        .map((tr) => {
          const cells = Array.from(tr.querySelectorAll("td")).filter(
            (c) => (c as HTMLElement).offsetWidth > 0
          );
          return cells.map((c) => c.textContent?.trim() || "");
        })
        .filter((r) => r.length >= 5 && r[0] !== "")
        .map((cells) => ({
          transTyp: cells[0] || "",
          typInfo: cells[1] || "",
          transDatum: cells[2] || "",
          fordranRaw: cells[3] || "",
          inbetaltRaw: cells[4] || "",
          lopnr: cells[5] || "",
          bfo: cells[6] || "",
          bfDatum: cells[7] || "",
          via: cells[8] || "",
          konto: cells[9] || "",
          registeradAv: cells[10] || "",
        }));
    }
    return [];
  }, masterRowId);

  return details.map((d) => ({
    ...d,
    fordran: parseAmount(d.fordranRaw),
    inbetalt: parseAmount(d.inbetaltRaw),
  }));
}

// ── Validation ──

function validateDetails(_row: LedgerRow, details: LedgerDetail[]): boolean {
  // Details are valid if we got at least one row with real data.
  // Sum of fordran may not equal belopp — some avis have missing breakdown data.
  return details.length > 0;
}

// ── Main ──

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  } catch {
    await chromium.launch({
      headless: false,
      args: [`--remote-debugging-port=${CDP_PORT}`],
    });
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  }

  let page;
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

  await page.goto("https://bas.batunionen.se/Ledger/Ledger", {
    waitUntil: "networkidle",
  });

  if (page.url().includes("/Account/Login")) {
    console.log("Not logged in.");
    return;
  }

  // Connect MongoDB
  const mongoClient = new MongoClient(getMongoConnectionString(), {
    tls: true,
    tlsAllowInvalidCertificates: true,
  });
  await mongoClient.connect();
  const collection: Collection<LedgerRow> = mongoClient
    .db("General")
    .collection(COLLECTION_NAME);

  // ── PHASE 1: Main table ──
  console.log("Phase 1: Scraping main table...");
  const rows = await scrapeMainTable(page);
  console.log(`  Found ${rows.length} rows.`);

  // Clear and insert
  await collection.deleteMany({});
  if (rows.length > 0) {
    await collection.insertMany(rows);
  }
  console.log(`  Inserted ${rows.length} rows (details = null).`);

  // ── PHASE 2: Details, one row at a time, validate, save ──
  console.log("\nPhase 2: Scraping details per row...");

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stdout.write(`\r[${i + 1}/${rows.length}] avi=${row.aviNr} ${row.medlem.padEnd(30).substring(0, 30)}`);

    let details: LedgerDetail[] | null = null;
    let valid = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      details = await scrapeRowDetails(page, i);
      if (details && details.length > 0) {
        valid = validateDetails(row, details);
        if (valid) break;
      }
      if (attempt < 3) {
        console.log(`\n  Retry ${attempt} for row ${i} (${row.medlem})`);
        await page.waitForTimeout(500 * attempt);
      }
    }

    if (valid && details) {
      const detailSum = details.reduce((s, d) => s + d.fordran, 0);
      const sumMatch = Math.abs(detailSum - row.belopp) < 0.02;
      if (!sumMatch) {
        console.log(
          `\n  Note: ${row.medlem} avi=${row.aviNr} detail sum ${detailSum.toFixed(2)} != belopp ${row.belopp.toFixed(2)}`
        );
      }
      await collection.updateOne(
        { aviNr: row.aviNr, ocr: row.ocr },
        { $set: { details, detailsScrapedAt: new Date().toISOString(), detailSumMatchesBelopp: sumMatch } }
      );
      ok++;
    } else {
      console.log(`\n  FAILED: row ${i} avi=${row.aviNr} ${row.medlem}`);
      failed++;
      // Save what we got anyway
      if (details) {
        await collection.updateOne(
          { aviNr: row.aviNr, ocr: row.ocr },
          { $set: { details, detailsScrapedAt: new Date().toISOString() } }
        );
      }
    }
  }

  console.log(`\n\nDone. ${ok} OK, ${failed} failed out of ${rows.length}.`);
  await mongoClient.close();
}

main();
