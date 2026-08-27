import { chromium, Page, BrowserContext } from "playwright";
import { MongoClient } from "mongodb";
import * as child_process from "child_process";

const CDP_PORT = 9222;
const BANKGIRO_URL_PATTERN = "insup.bgonline.se";

interface BankgiroTransaction {
  transactionDate: string;
  senderName: string;
  bankgironummer: string;
  avinummer: string;
  amount: number;
  meddelande: string;
  address: string;
  referenceNumber: string;
  hasImage: boolean;
  scrapedAt: string;
}

interface BankgiroTransactionImage {
  referenceNumber: string;
  fileData: string;
  transactionDate: string;
  displayTransactionDate: string;
}

interface DayItem {
  date: string;
  totalAmount: number;
  slipNumbers: string;
  transactionCount: number;
}

function getMongoConnectionString(): string {
  return child_process
    .execSync(
      'az keyvault secret show --vault-name "hbk-main" --name "MongoConnectionString" --query "value" -o tsv',
      { encoding: "utf-8" }
    )
    .trim();
}

function parseSwedishDecimal(text: string): number {
  return parseFloat(text.replace(/\s/g, "").replace(",", ".")) || 0;
}

// ── Page detection ──

async function waitForBankgiroPage(context: BrowserContext): Promise<Page> {
  console.log("Waiting for Bankgiro page (insup.bgonline.se)...");

  // Check existing pages first
  for (const p of context.pages()) {
    if (p.url().includes(BANKGIRO_URL_PATTERN)) {
      console.log("Found existing Bankgiro tab.");
      await p.waitForSelector("div[name='daylist']", { timeout: 30000 });
      return p;
    }
  }

  // Wait for new tab
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for Bankgiro page")), 300000);

    context.on("page", async (newPage) => {
      try {
        await newPage.waitForLoadState("domcontentloaded");
        if (newPage.url().includes(BANKGIRO_URL_PATTERN)) {
          console.log("Bankgiro tab detected.");
          await newPage.waitForSelector("div[name='daylist']", { timeout: 30000 });
          clearTimeout(timeout);
          resolve(newPage);
        }
      } catch {}
    });

    // Also poll existing pages in case it loaded in current tab
    const poll = setInterval(async () => {
      for (const p of context.pages()) {
        if (p.url().includes(BANKGIRO_URL_PATTERN)) {
          try {
            await p.waitForSelector("div[name='daylist']", { timeout: 2000 });
            clearInterval(poll);
            clearTimeout(timeout);
            resolve(p);
          } catch {}
        }
      }
    }, 2000);
  });
}

// ── Day list ──

async function getDayListItems(page: Page): Promise<DayItem[]> {
  const items = await page.$$eval(
    "div[name='daylist'] div.scrollview-item",
    (nodes) =>
      nodes.map((item) => {
        // The bank rebuilt this list in Angular. The old span.item-top-left /
        // item-top-right / item-bottom-left / item-bottom-right are gone; each row is now
        //   <div class="row"><div class="col-6"><b>2026-08-27</b></div>
        //                    <div class="col-6"><b>13 956,00</b></div></div>
        //   <div class="row"><div class="col-8 f-6">Löpnummer 82 - 83</div>
        //                    <div class="col-4 f-6">6 st</div></div>
        const cols6 = item.querySelectorAll("div.col-6");
        const dateText = (cols6[0]?.textContent || "").trim();
        const amountText = (cols6[1]?.textContent || "").trim();
        const slipText = (item.querySelector("div.col-8")?.textContent || "").trim();
        const countText = (item.querySelector("div.col-4")?.textContent || "").trim();

        return {
          date: dateText,
          totalAmount: parseFloat(
            amountText.replace(/\s/g, "").replace(",", ".") || "0"
          ),
          slipNumbers: slipText.replace("Löpnummer ", "").trim(),
          transactionCount: parseInt(countText.replace("st", "").trim() || "0", 10),
        };
      })
  );

  // A LIST THAT PARSED TO NOTHING IS A BROKEN SELECTOR, NOT AN EMPTY DAY LIST.
  //
  // This is how the scrape silently did nothing on 2026-08-27. The stale selectors yielded
  // date:"" for every row, and the caller's "past the start of our range" test compares
  // date < startDate — which "" satisfies — so it stopped on the FIRST row and reported
  // "Done. Scraped 0 new transactions" while the page displayed 70 days of deposits,
  // including 50 584,00 SEK two days earlier. No error, no warning, no clue.
  //
  // Refusing here converts that into something a human can see.
  const parsed = items.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (items.length > 0 && parsed.length === 0) {
    throw new Error(
      `Day list has ${items.length} row(s) but not one yielded a date — the bgonline DOM ` +
        `has changed again. Refusing to report an empty scrape.`
    );
  }
  return parsed;
}

async function loadMoreDays(page: Page): Promise<boolean> {
  const btn = page.locator("xpath=//div[@name='daylist_loadmore_btn']");
  if ((await btn.count()) === 0) return false;
  if (!(await btn.isVisible())) return false;

  const before = await page
    .locator(
      "xpath=//div[@name='daylist']//div[@class='scrollview-item' or contains(@class, 'scrollview-item ')]"
    )
    .count();

  await btn.click();
  await page.waitForTimeout(1000);

  // Wait for new items
  try {
    await page.waitForFunction(
      (prevCount) => {
        const items = document.querySelectorAll(
          "div[name='daylist'] div.scrollview-item, div[name='daylist'] div[class*='scrollview-item ']"
        );
        return items.length > prevCount;
      },
      before,
      { timeout: 5000 }
    );
  } catch {
    return false;
  }
  return true;
}

// ── Transaction scraping ──

interface ScrapeDayResult {
  transactions: BankgiroTransaction[];
  images: BankgiroTransactionImage[];
}

async function scrapeDay(
  page: Page,
  dayIndex: number
): Promise<ScrapeDayResult> {
  // Click the day item
  const dayItems = page.locator(
    "xpath=//div[@name='daylist']//div[@class='scrollview-item' or contains(@class, 'scrollview-item ')]"
  );
  // Capture first row's content before clicking to detect refresh
  const oldContent = await page.$$eval("tr.hidden-sm.row-hover td:first-child", (cells) =>
    cells.map((c) => c.textContent?.trim() || "").join("|")
  ).catch(() => "");

  await dayItems.nth(dayIndex).click();

  // Wait for content to change (not IDs — those are always trans_0, trans_1...)
  try {
    await page.waitForFunction(
      (prev) => {
        const cells = document.querySelectorAll("tr.hidden-sm.row-hover td:first-child");
        const now = Array.from(cells).map((c) => c.textContent?.trim() || "").join("|");
        return now !== prev && now.length > 0;
      },
      oldContent,
      { timeout: 3000 }
    );
  } catch {
    await page.waitForTimeout(200);
  }

  // Get date from the day item
  const dateText = await dayItems
    .nth(dayIndex)
    .locator("span.item-top-left")
    .textContent();
  const transactionDate = dateText?.trim() || "";

  // Extract ALL summary data in one shot — only desktop rows (hidden-sm)
  const summaries = await page.$$eval(
    "tr.hidden-sm.row-hover",
    (rows) => {
      const seen = new Set<string>();
      return rows
        .filter((r) => {
          if (!r.id || seen.has(r.id)) return false;
          seen.add(r.id);
          return true;
        })
        .map((r) => {
          const cells = r.querySelectorAll("td");
          const amountSpan = cells[3]?.querySelector("span");
          return {
            rowId: r.id,
            senderName: cells[0]?.textContent?.trim() || "",
            referenceNumber: cells[1]?.textContent?.trim() || "",
            bankgiroOrAvi: cells[2]?.textContent?.trim() || "",
            amountText: amountSpan?.textContent?.trim() || cells[3]?.textContent?.trim() || "0",
          };
        });
    }
  );

  // Now expand each row for details — quick toggle, grab, collapse
  const transactions: BankgiroTransaction[] = [];
  const images: BankgiroTransactionImage[] = [];

  for (const summary of summaries) {
    const { rowId } = summary;
    let address = "";
    let meddelande = "";
    let hasImage = false;
    let imageData = "";

    try {
      const row = page.locator(`tr#${rowId}.hidden-sm`);
      const toggleBtn = row.locator(".transactionlistrow-toggle");

      if ((await toggleBtn.count()) > 0) {
        await toggleBtn.click();

        const detailsXpath = `xpath=//tr[@id='${rowId}' and contains(@class,'hidden-sm')]/following-sibling::tr[1]//transaction-details`;
        await page.waitForSelector(detailsXpath, { timeout: 2000 });

        // Extract all detail data in one eval
        const details = await page.$eval(
          `xpath=//tr[@id='${rowId}' and contains(@class,'hidden-sm')]/following-sibling::tr[1]//transaction-details`,
          (el) => {
            // Address
            const addrLabel = el.querySelector("span b");
            let address = "";
            if (addrLabel) {
              const spans = addrLabel.closest("span")?.parentElement?.querySelectorAll("span") || [];
              const parts: string[] = [];
              let foundLabel = false;
              for (const s of spans) {
                if (s.querySelector("b")) { foundLabel = true; continue; }
                if (foundLabel) {
                  const t = s.textContent?.trim();
                  if (t) parts.push(t);
                }
              }
              address = parts.join(" ");
            }

            // Meddelande
            let meddelande = "";
            const allBolds = el.querySelectorAll("b");
            for (const b of allBolds) {
              if (b.textContent?.includes("Meddelande")) {
                const row = b.closest(".row");
                const nextRow = row?.nextElementSibling;
                if (nextRow) {
                  const span = nextRow.querySelector("span");
                  meddelande = span?.textContent?.trim() || "";
                }
                break;
              }
            }

            // Avi-bild
            const imgEl = el.querySelector("img[src*='data:image']") as HTMLImageElement | null;
            const hasImage = !!imgEl || !!el.textContent?.includes("Avi-bild");
            const imageData = imgEl?.src || "";

            return { address, meddelande, hasImage, imageData };
          }
        );

        address = details.address;
        meddelande = details.meddelande;
        hasImage = details.hasImage;
        imageData = details.imageData;

        // Collapse
        await toggleBtn.click();
      }
    } catch {
      // Details didn't load, continue with summary data
    }

    const isBankgiro = summary.bankgiroOrAvi.includes("-");

    transactions.push({
      transactionDate,
      senderName: summary.senderName,
      bankgironummer: isBankgiro ? summary.bankgiroOrAvi : "",
      avinummer: isBankgiro ? "" : summary.bankgiroOrAvi,
      amount: parseSwedishDecimal(summary.amountText),
      meddelande,
      address,
      referenceNumber: summary.referenceNumber,
      hasImage,
      scrapedAt: new Date().toISOString(),
    });

    if (hasImage && imageData) {
      images.push({
        referenceNumber: summary.referenceNumber,
        fileData: imageData,
        transactionDate,
        displayTransactionDate: transactionDate,
      });
    }
  }

  return { transactions, images };
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] || "";
  const endDate = args[1] || "";

  if (!startDate || !endDate) {
    console.log("Usage: npx ts-node tasks/src/bankgiro-scraper.ts <start-date> <end-date>");
    console.log("Example: npx ts-node tasks/src/bankgiro-scraper.ts 2025-01-01 2025-12-31");
    return;
  }

  // Connect to browser
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
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    if (ctx.pages().length > 0) {
      page = ctx.pages()[0];
      break;
    }
  }
  if (!page) {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  }

  // Navigate to Swedbank
  await page.goto("https://www.swedbank.se", { waitUntil: "domcontentloaded" });
  console.log("Opened Swedbank. Please:");
  console.log("  1. Log in with BankID");
  console.log("  2. Navigate to: Företag → Inbetalningar → Insättningsuppgifter");
  console.log("Waiting for Bankgiro page...\n");

  // Wait for Bankgiro page (in any tab)
  const bgPage = await waitForBankgiroPage(page.context());
  console.log("Bankgiro page ready.\n");

  // Connect to MongoDB
  const connStr = getMongoConnectionString();
  const mongoClient = new MongoClient(connStr, {
    tls: true,
    tlsAllowInvalidCertificates: true,
  });
  await mongoClient.connect();

  // Load financial years
  const financialYears = await mongoClient
    .db("General")
    .collection("FinancialYears")
    .find({})
    .toArray();

  interface FY { id: number; from: Date; to: Date; }
  const fys: FY[] = financialYears
    .map((fy) => ({
      id: fy._id as unknown as number,
      from: new Date(fy.FromDate),
      to: new Date(fy.ToDate),
    }))
    .sort((a, b) => b.from.getTime() - a.from.getTime());

  function getFinancialYear(dateStr: string): FY | null {
    const d = new Date(dateStr + "T12:00:00Z");
    return fys.find((fy) => d >= fy.from && d <= fy.to) || null;
  }

  function getDbForDate(dateStr: string) {
    const fy = getFinancialYear(dateStr);
    if (!fy) return null;
    return mongoClient.db(`Year_${fy.id}`);
  }

  console.log(`Loaded ${fys.length} financial years.`);

  // Build set of already-scraped dates across all year databases
  const existingDates = new Set<string>();
  for (const fy of fys) {
    const db = mongoClient.db(`Year_${fy.id}`);
    try {
      const dates = await db.collection("BankgiroTransactions").distinct("transactionDate");
      for (const d of dates) existingDates.add(d as string);
    } catch {}
  }
  console.log(`Found ${existingDates.size} dates already scraped across all years.`);

  // Scrape from the top, load more as needed
  console.log(`Scraping days in range ${startDate} to ${endDate}...`);
  let totalScraped = 0;
  let reachedEnd = false;

  while (!reachedEnd) {
    const days = await getDayListItems(bgPage);

    for (let i = 0; i < days.length; i++) {
      const day = days[i];

      // Past the start of our range — done
      if (day.date < startDate) {
        reachedEnd = true;
        break;
      }

      // Not in range yet (newer than endDate)
      if (day.date > endDate) continue;

      // Already in MongoDB — validate against sidebar
      if (existingDates.has(day.date)) {
        const db = getDbForDate(day.date);
        if (db) {
          const coll = db.collection("BankgiroTransactions");
          const existing = await coll.find({ transactionDate: day.date }).toArray();
          const existingTotal = existing.reduce((s: number, t: any) => s + t.amount, 0);
          const countOk = existing.length === day.transactionCount;
          const amountOk = Math.abs(existingTotal - day.totalAmount) < 0.02;

          if (countOk && amountOk) {
            console.log(`[${day.date}] Verified in Year_${getFinancialYear(day.date)!.id} (${existing.length} tx, ${existingTotal.toFixed(2)} SEK). Skipping.`);
            continue;
          }

          console.log(
            `[${day.date}] MongoDB MISMATCH: ` +
            `count ${existing.length}/${day.transactionCount}, ` +
            `amount ${existingTotal.toFixed(2)}/${day.totalAmount.toFixed(2)}. Re-scraping...`
          );
          await coll.deleteMany({ transactionDate: day.date });
          await db.collection("BankgiroTransactionImages").deleteMany({ transactionDate: day.date });
          existingDates.delete(day.date);
        }
      }

      console.log(
        `[${day.date}] ${day.transactionCount} transactions, ${day.totalAmount} SEK...`
      );

      let result: ScrapeDayResult = { transactions: [], images: [] };
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        result = await scrapeDay(bgPage, i);

        const scrapedTotal = result.transactions.reduce((s, t) => s + t.amount, 0);
        const countMatch = result.transactions.length === day.transactionCount;
        const amountMatch = Math.abs(scrapedTotal - day.totalAmount) < 0.02;

        if (countMatch && amountMatch) {
          break;
        }

        console.log(
          `  MISMATCH (attempt ${attempt}/${maxRetries}): ` +
          `count ${result.transactions.length}/${day.transactionCount}, ` +
          `amount ${scrapedTotal.toFixed(2)}/${day.totalAmount.toFixed(2)}`
        );

        if (attempt < maxRetries) {
          await bgPage.waitForTimeout(1000 * attempt);
          const dayItems = bgPage.locator(
            "xpath=//div[@name='daylist']//div[@class='scrollview-item' or contains(@class, 'scrollview-item ')]"
          );
          await dayItems.nth(i).click();
          await bgPage.waitForTimeout(500);
        }
      }

      if (result.transactions.length > 0) {
        const db = getDbForDate(day.date);
        if (!db) {
          console.log(`  WARNING: No financial year for ${day.date}, skipping insert.`);
        } else {
          await db.collection("BankgiroTransactions").insertMany(result.transactions);
          totalScraped += result.transactions.length;
          existingDates.add(day.date);

          if (result.images.length > 0) {
            await db.collection("BankgiroTransactionImages").insertMany(result.images);
            console.log(`  ${result.images.length} image(s) saved.`);
          }
        }
      }

      console.log(`  Scraped ${result.transactions.length} transactions.`);
    }

    if (reachedEnd) break;

    // Load more days
    const loaded = await loadMoreDays(bgPage);
    if (!loaded) break;

    const newDays = await getDayListItems(bgPage);
    console.log(`  Loaded ${newDays.length} days total`);
  }

  console.log(`\nDone. Scraped ${totalScraped} new transactions into MongoDB.`);
  await mongoClient.close();
}

main();
