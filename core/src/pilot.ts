import express from "express";
import { chromium, Browser, Page } from "playwright";
import { getCdpUrl } from "./server";
import * as fs from "fs";
import * as path from "path";

const PORT = 3001;
const SCREENSHOT_PATH = "D:/web-auto/.screenshots/page.png";
const CACHE_DIR = "D:/web-auto/.cache";
const IMPORTED_CACHE = path.join(CACHE_DIR, "imported-payments.json");

interface ImportedPayment {
  id: string;
  filename: string;
  by: string;
  date: string;
  notes?: string;
}

function loadCache(): ImportedPayment[] {
  if (!fs.existsSync(IMPORTED_CACHE)) return [];
  return JSON.parse(fs.readFileSync(IMPORTED_CACHE, "utf-8"));
}

function saveCache(entries: ImportedPayment[]): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(IMPORTED_CACHE, JSON.stringify(entries, null, 2));
}

let browser: Browser;
let page: Page;

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;

  const cdpUrl = getCdpUrl();
  browser = await chromium.connectOverCDP(cdpUrl);

  for (const ctx of browser.contexts()) {
    const pages = ctx.pages();
    if (pages.length > 0) {
      page = pages[0];
      return page;
    }
  }

  const ctx = await browser.newContext();
  page = await ctx.newPage();
  return page;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(express.text());

  // Reconnect on each request if needed
  app.use(async (_req, _res, next) => {
    try {
      await getPage();
      next();
    } catch (err) {
      _res.status(500).json({ error: "Failed to connect to browser", detail: String(err) });
    }
  });

  app.get("/screenshot", async (_req, res) => {
    try {
      fs.mkdirSync("D:/web-auto/.screenshots", { recursive: true });
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
      res.json({ path: SCREENSHOT_PATH });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/url", async (_req, res) => {
    res.json({ url: page.url() });
  });

  app.post("/goto", async (req, res) => {
    try {
      const url = req.body.url || req.body;
      await page.goto(url, { waitUntil: "networkidle" });
      res.json({ url: page.url() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/click", async (req, res) => {
    try {
      const selector = req.body.selector || req.body;
      const options = req.body.options || {};
      await page.click(selector, options);
      res.json({ clicked: selector });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/fill", async (req, res) => {
    try {
      const { selector, value } = req.body;
      await page.fill(selector, value);
      res.json({ filled: selector, value });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/select", async (req, res) => {
    try {
      const { selector, value } = req.body;
      await page.selectOption(selector, value);
      res.json({ selected: selector, value });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/upload", async (req, res) => {
    try {
      const { selector, file } = req.body;
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.locator(selector).click(),
      ]);
      await fileChooser.setFiles(file);
      res.json({ uploaded: file });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/html", async (req, res) => {
    try {
      const selector = (req.query.selector as string) || "body";
      const html = await page.$eval(selector, (el) => el.innerHTML);
      res.type("html").send(html);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/text", async (req, res) => {
    try {
      const selector = (req.query.selector as string) || "body";
      const text = await page.$eval(selector, (el) => (el.textContent || "").trim());
      res.type("text").send(text);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/eval", async (req, res) => {
    try {
      const code = req.body.code || req.body;
      const fn = new Function("page", "browser", `return (async () => { ${code} })()`);
      const result = await fn(page, browser);
      res.json({ result: result ?? null });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/elements", async (req, res) => {
    try {
      const selector = (req.query.selector as string) || "button, a, input, select";
      const els = await page.$$eval(selector, (els) =>
        els
          .filter((e) => {
            const s = window.getComputedStyle(e);
            return s.display !== "none" && s.visibility !== "hidden";
          })
          .map((e) => ({
            tag: e.tagName,
            id: e.id || undefined,
            text: (e.textContent || "").trim().substring(0, 80) || undefined,
            type: (e as HTMLInputElement).type || undefined,
            href: (e as HTMLAnchorElement).href || undefined,
            value: (e as HTMLInputElement).value || undefined,
          }))
      );
      res.json(els);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // === BAS-K domain actions ===

  app.get("/bas/imported-payments", async (_req, res) => {
    try {
      const cache = loadCache();
      res.json({ count: cache.length, entries: cache });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/bas/sync-imported", async (_req, res) => {
    try {
      // Navigate to OCR page
      await page.goto(
        "https://bas.batunionen.se/PaymentProcessing/PaymentProcessing",
        { waitUntil: "networkidle" }
      );

      if (page.url().includes("/Account/Login")) {
        res.status(401).json({ error: "Not logged in." });
        return;
      }

      const allEntries: ImportedPayment[] = [];
      let pageNum = 1;

      while (true) {
        const rows = await page.$$eval("table tbody tr", (trs) =>
          trs.map((tr) => {
            const cells = tr.querySelectorAll("td");
            return {
              id: cells[0]?.textContent?.trim() || "",
              filename: cells[1]?.textContent?.trim() || "",
              by: cells[2]?.textContent?.trim() || "",
              date: cells[3]?.textContent?.trim() || "",
              notes: cells[4]?.textContent?.trim() || "",
            };
          })
        );
        allEntries.push(...rows);

        // Try clicking the next page link (the numbered one, not the arrow)
        const nextLink = page.locator(`.k-pager-numbers a[data-page="${pageNum + 1}"]`);
        if ((await nextLink.count()) === 0) {
          // Try "Fler sidor" (more pages) to load more page numbers
          const moreLink = page.locator("a[title='Fler sidor'], a[title='More pages']");
          if ((await moreLink.count()) > 0) {
            await moreLink.click();
            await page.waitForTimeout(1000);
            const retryLink = page.locator(`.k-pager-numbers a[data-page="${pageNum + 1}"]`);
            if ((await retryLink.count()) === 0) break;
            await retryLink.click();
          } else {
            break;
          }
        } else {
          await nextLink.click();
        }
        await page.waitForTimeout(1000);
        pageNum++;
      }

      saveCache(allEntries);
      res.json({ synced: allEntries.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/bas/import-payment", async (req, res) => {
    try {
      const file: string = req.body.file;
      if (!file) {
        res.status(400).json({ error: "Missing 'file' parameter" });
        return;
      }

      if (!fs.existsSync(file)) {
        res.status(400).json({ error: `File not found: ${file}` });
        return;
      }

      // Check cache for duplicates
      const basename = path.basename(file);
      const cache = loadCache();
      const existing = cache.find((e) => e.filename === basename);
      if (existing) {
        res.json({
          result: "skipped",
          reason: `Already imported on ${existing.date} (ID: ${existing.id})`,
        });
        return;
      }

      // 1. Navigate to OCR import page
      await page.goto(
        "https://bas.batunionen.se/PaymentProcessing/PaymentProcessing",
        { waitUntil: "networkidle" }
      );

      // Check if we got redirected to login
      if (page.url().includes("/Account/Login")) {
        res.status(401).json({ error: "Not logged in. Please log in via the browser first." });
        return;
      }

      // 2. Upload file via Kendo upload widget
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.locator(".k-upload-button").click(),
      ]);
      await fileChooser.setFiles(file);

      // 3. Click "Läs in inbetalningsfil"
      await page.click("#btnLoadFile");
      await page.waitForTimeout(2000);

      // Check for result — dialog or success
      const dialog = await page.$(".k-window, .k-dialog, [role='dialog']");
      if (dialog) {
        const dialogText = await dialog.innerText();
        res.json({ result: "dialog", message: dialogText.trim() });
      } else {
        // Add to cache on success
        const updatedCache = loadCache();
        updatedCache.unshift({ id: "", filename: basename, by: "", date: new Date().toISOString() });
        saveCache(updatedCache);
        res.json({ result: "success", file: basename });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.listen(PORT, () => {
    console.log(`Pilot server running on http://localhost:${PORT}`);
  });
}

main();
