import { chromium, Page } from "playwright";
import { MongoClient } from "mongodb";
import * as fs from "fs";
import * as child_process from "child_process";

const CDP_PORT = 9222;
const CACHE_FILE = "D:/web-auto/.cache/imported-payments.json";
const BAS_BASE = "https://bas.batunionen.se";

interface BasPayment {
  avi: string;
  ocr: string;
  amount: number;
  lopnr: string;
  name: string;
  address: string;
  member: string;
}

interface BasBgmaxFile {
  fileId: string;
  filename: string;
  accountingDate: string;
  importedAt: string;
  importedBy: string;
  notes: string;
  paymentCount: number;
  payments: BasPayment[];
  scrapedAt: string;
}

function parseAmount(s: string): number {
  // "2 916,00" -> 2916.00
  return parseFloat(s.replace(/\s/g, "").replace(",", ".")) || 0;
}

function getMongoConnectionString(): string {
  const result = child_process.execSync(
    'az keyvault secret show --vault-name "hbk-main" --name "MongoConnectionString" --query "value" -o tsv',
    { encoding: "utf-8" }
  ).trim();
  return result;
}

async function scrapeDetailPage(page: Page): Promise<BasPayment[]> {
  const rows = await page.$$eval("table tbody tr", (trs) =>
    trs.map((tr) => {
      const c = tr.querySelectorAll("td");
      return {
        avi: c[0]?.textContent?.trim() || "",
        ocr: c[1]?.textContent?.trim() || "",
        amount: c[2]?.textContent?.trim() || "0",
        lopnr: c[3]?.textContent?.trim() || "",
        name: c[4]?.textContent?.trim() || "",
        address: c[5]?.textContent?.trim() || "",
        member: c[6]?.textContent?.trim() || "",
      };
    })
  );

  return rows.map((r) => ({
    ...r,
    amount: parseAmount(r.amount as unknown as string),
  }));
}

async function main() {
  // Load cache
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  const bgmaxDateRegex = /BGC_(\d{2,4}-\d{2}-\d{2})\.txt$/;
  const bgmaxFiles = cache.filter(
    (e: any) => e.filename.match(bgmaxDateRegex)
  );

  console.log(`Found ${bgmaxFiles.length} BGMax files with payment data in cache.`);

  // Connect to MongoDB
  const connStr = getMongoConnectionString();
  const mongoClient = new MongoClient(connStr, {
    tls: true,
    tlsAllowInvalidCertificates: true,
  });
  await mongoClient.connect();
  const collection = mongoClient.db("General").collection<BasBgmaxFile>("BasBgmaxPayments");

  // Create indexes (ignore errors if they already exist)
  try {
    await collection.createIndex({ fileId: 1 }, { unique: true });
    await collection.createIndex({ accountingDate: 1 });
    await collection.createIndex({ "payments.ocr": 1 });
  } catch {
    console.log("Indexes already exist, continuing.");
  }

  // Check which files are already scraped
  const existing = new Set(
    (await collection.find({}, { projection: { fileId: 1 } }).toArray()).map(
      (d) => d.fileId
    )
  );
  const toScrape = bgmaxFiles.filter((e: any) => !existing.has(e.id));
  console.log(`Already scraped: ${existing.size}. Remaining: ${toScrape.length}.`);

  if (toScrape.length === 0) {
    console.log("Nothing to do.");
    await mongoClient.close();
    return;
  }

  // Connect to browser
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  } catch {
    const launched = await chromium.launch({
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

  // Navigate to OCR page to get detail links
  await page.goto(`${BAS_BASE}/PaymentProcessing/PaymentProcessing`, {
    waitUntil: "networkidle",
  });

  if (page.url().includes("/Account/Login")) {
    console.log("Not logged in. Please log in first.");
    await mongoClient.close();
    return;
  }

  // Phase 1: Collect all detail links by paginating through the table
  console.log("Phase 1: Collecting detail links...");
  const allLinks: Array<{ id: string; href: string; filename: string }> = [];
  let pageNum = 1;

  while (true) {
    const links = await page.$$eval("table tbody tr", (trs) =>
      trs.map((tr) => {
        const cells = tr.querySelectorAll("td");
        const link = cells[1]?.querySelector("a");
        return {
          id: cells[0]?.textContent?.trim() || "",
          href: link?.getAttribute("href") || "",
          filename: cells[1]?.textContent?.trim() || "",
        };
      })
    );
    allLinks.push(...links.filter((l) => l.href));
    process.stdout.write(`\rCollected ${allLinks.length} links (page ${pageNum})`);

    pageNum++;
    const nextLink = page.locator(`.k-pager-numbers a[data-page="${pageNum}"]`);
    if ((await nextLink.count()) === 0) {
      const moreLink = page.locator("a[title='Fler sidor']");
      if ((await moreLink.count()) > 0) {
        await moreLink.click();
        await page.waitForTimeout(500);
        const retry = page.locator(`.k-pager-numbers a[data-page="${pageNum}"]`);
        if ((await retry.count()) === 0) break;
        await retry.click();
      } else {
        break;
      }
    } else {
      await nextLink.click();
    }
    await page.waitForTimeout(800);
  }
  console.log(`\nCollected ${allLinks.length} total links.`);

  // Phase 2: Visit each detail page directly
  console.log("Phase 2: Scraping detail pages...");
  const toScrapeIds = new Set(toScrape.map((e: any) => e.id));
  const toVisit = allLinks.filter((l) => toScrapeIds.has(l.id));
  console.log(`${toVisit.length} files to scrape.`);

  let scraped = 0;
  for (const link of toVisit) {
    const entry = toScrape.find((e: any) => e.id === link.id);
    const dateMatch = entry.filename.match(bgmaxDateRegex);
    let accountingDate = dateMatch ? dateMatch[1] : "";
    if (accountingDate.length === 8) accountingDate = "20" + accountingDate;

    try {
      await page.goto(`${BAS_BASE}${link.href}`, { waitUntil: "networkidle" });
      const payments = await scrapeDetailPage(page);

      const doc: BasBgmaxFile = {
        fileId: link.id,
        filename: entry.filename,
        accountingDate,
        importedAt: entry.date,
        importedBy: entry.by,
        notes: entry.notes || "",
        paymentCount: payments.length,
        payments,
        scrapedAt: new Date().toISOString(),
      };

      await collection.replaceOne({ fileId: link.id }, doc, { upsert: true });
      scraped++;
      process.stdout.write(
        `\r[${scraped}/${toVisit.length}] ${accountingDate} — ${payments.length} payments`
      );
    } catch (err) {
      console.log(`\nError scraping ${link.id} (${accountingDate}): ${err}`);
    }
  }

  console.log(`\nDone. Scraped ${scraped} BGMax files into MongoDB.`);
  await mongoClient.close();
}

main();
