import { chromium } from "playwright";
import { MongoClient } from "mongodb";
import * as child_process from "child_process";

const CDP_PORT = 9222;
const COLLECTION_NAME = "BasAvvikelser";

interface Avvikelse {
  medlemsnr: string;
  medlem: string;
  belopp: number;
  beloppRaw: string;
  transDatum: string;
  regDatum: string;
  transTyp: string;
  transaktionstext: string;
  transId: string;
  scrapedAt: string;
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

async function main() {
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

  // Navigate
  await page.goto(
    "https://bas.batunionen.se/MemberBalance/GetBalanceTransactionList",
    { waitUntil: "networkidle" }
  );

  if (page.url().includes("/Account/Login")) {
    console.log("Not logged in. Please log in first.");
    return;
  }

  console.log("On Avvikelser page. Scraping...");

  // Scrape all visible rows
  const rows: Avvikelse[] = await page.$$eval(
    "table tbody tr",
    (trs) => {
      const now = new Date().toISOString();
      return trs.map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td")).filter(
          (c) => (c as HTMLElement).offsetWidth > 0
        );
        return {
          medlemsnr: cells[0]?.textContent?.trim() || "",
          medlem: cells[1]?.textContent?.trim() || "",
          belopp: 0,
          beloppRaw: cells[2]?.textContent?.trim() || "",
          transDatum: cells[3]?.textContent?.trim() || "",
          regDatum: cells[4]?.textContent?.trim() || "",
          transTyp: cells[5]?.textContent?.trim() || "",
          transaktionstext: cells[6]?.textContent?.trim() || "",
          transId: cells[7]?.textContent?.trim() || "",
          scrapedAt: now,
        };
      });
    }
  );

  // Parse amounts (can't do in $$eval since parseAmount is outside browser context)
  for (const row of rows) {
    row.belopp = parseAmount(row.beloppRaw);
  }

  console.log(`Scraped ${rows.length} rows.`);

  // Store in MongoDB — clear and replace
  const connStr = getMongoConnectionString();
  const mongoClient = new MongoClient(connStr, {
    tls: true,
    tlsAllowInvalidCertificates: true,
  });
  await mongoClient.connect();
  const collection = mongoClient.db("General").collection(COLLECTION_NAME);

  await collection.deleteMany({});
  if (rows.length > 0) {
    await collection.insertMany(rows);
  }

  console.log(
    `Replaced ${COLLECTION_NAME} collection: ${rows.length} documents.`
  );
  await mongoClient.close();
}

main();
