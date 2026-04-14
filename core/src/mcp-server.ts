import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = "D:/web-auto/.cache";
const IMPORTED_CACHE = path.join(CACHE_DIR, "imported-payments.json");
const SCREENSHOT_DIR = "D:/web-auto/.screenshots";
const SCREENSHOT_PATH = path.join(SCREENSHOT_DIR, "page.png");
const STATE_FILE = path.join("D:/web-auto/.browser-state", "server.json");
const CDP_PORT = 9222;

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

async function ensureBrowser(): Promise<void> {
  if (page && !page.isClosed()) return;

  // Try connecting to existing browser
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  } catch {
    // Launch a new browser with CDP
    const launched = await chromium.launch({
      headless: false,
      args: [`--remote-debugging-port=${CDP_PORT}`],
    });
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ cdpUrl: `http://localhost:${CDP_PORT}` }));
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    // Keep a reference so the browser doesn't close
    (global as any).__browserProcess = launched;
  }

  for (const ctx of browser.contexts()) {
    const pages = ctx.pages();
    if (pages.length > 0) {
      page = pages[0];
      return;
    }
  }
  const ctx = await browser.newContext();
  page = await ctx.newPage();
}

async function getPage(): Promise<Page> {
  await ensureBrowser();
  return page;
}

// ── Server ──

const server = new McpServer({
  name: "bas-k",
  version: "1.0.0",
});

// ── Generic browser tools ──

server.tool("screenshot", "Take a screenshot of the current browser page", {}, async () => {
  const p = await getPage();
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await p.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  return { content: [{ type: "text", text: `Screenshot saved to ${SCREENSHOT_PATH}` }] };
});

server.tool(
  "browser_goto",
  "Navigate the browser to a URL",
  { url: z.string().describe("URL to navigate to") },
  async ({ url }) => {
    const p = await getPage();
    await p.goto(url, { waitUntil: "networkidle" });
    return { content: [{ type: "text", text: `Navigated to ${p.url()}` }] };
  }
);

server.tool(
  "browser_click",
  "Click an element on the page",
  { selector: z.string().describe("CSS selector or text selector") },
  async ({ selector }) => {
    const p = await getPage();
    await p.click(selector);
    return { content: [{ type: "text", text: `Clicked: ${selector}` }] };
  }
);

server.tool("browser_url", "Get the current page URL", {}, async () => {
  const p = await getPage();
  return { content: [{ type: "text", text: p.url() }] };
});

server.tool(
  "browser_eval",
  "Evaluate JavaScript code in the browser page context",
  { code: z.string().describe("JavaScript code to evaluate. Use 'page' and 'browser' variables.") },
  async ({ code }) => {
    const p = await getPage();
    const fn = new Function("page", "browser", `return (async () => { ${code} })()`);
    const result = await fn(p, browser);
    return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
  }
);

server.tool(
  "browser_text",
  "Get text content of an element",
  { selector: z.string().describe("CSS selector").default("body") },
  async ({ selector }) => {
    const p = await getPage();
    const text = await p.$eval(selector, (el) => (el.textContent || "").trim());
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "browser_elements",
  "List visible interactive elements on the page",
  { selector: z.string().describe("CSS selector to filter elements").default("button, a, input, select") },
  async ({ selector }) => {
    const p = await getPage();
    const els = await p.$$eval(selector, (els) =>
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
        }))
    );
    return { content: [{ type: "text", text: JSON.stringify(els, null, 2) }] };
  }
);

// ── BAS-K domain tools ──

server.tool(
  "bas_import_payment",
  "Import a payment file (ISO20022/BG MAX/Plusgiro) into BAS-K. Checks local cache first to avoid duplicates.",
  { file: z.string().describe("Absolute path to the payment file") },
  async ({ file }) => {
    if (!fs.existsSync(file)) {
      return { content: [{ type: "text", text: `Error: File not found: ${file}` }] };
    }

    // Check cache
    const basename = path.basename(file);
    const cache = loadCache();
    const existing = cache.find((e) => e.filename === basename);
    if (existing) {
      return {
        content: [{
          type: "text",
          text: `Skipped: "${basename}" already imported on ${existing.date} (ID: ${existing.id})`,
        }],
      };
    }

    const p = await getPage();

    // 1. Navigate
    await p.goto("https://bas.batunionen.se/PaymentProcessing/PaymentProcessing", {
      waitUntil: "networkidle",
    });

    if (p.url().includes("/Account/Login")) {
      return { content: [{ type: "text", text: "Error: Not logged in. Please log in via the browser first." }] };
    }

    // 2. Upload
    const [fileChooser] = await Promise.all([
      p.waitForEvent("filechooser"),
      p.locator(".k-upload-button").click(),
    ]);
    await fileChooser.setFiles(file);

    // 3. Submit
    await p.click("#btnLoadFile");
    await p.waitForTimeout(2000);

    // Check for dialog
    const dialog = await p.$(".k-window, .k-dialog, [role='dialog']");
    if (dialog) {
      const dialogText = await dialog.innerText();
      return { content: [{ type: "text", text: `Dialog: ${dialogText.trim()}` }] };
    }

    // Success — update cache
    const updatedCache = loadCache();
    updatedCache.unshift({ id: "", filename: basename, by: "", date: new Date().toISOString() });
    saveCache(updatedCache);

    return { content: [{ type: "text", text: `Success: imported "${basename}"` }] };
  }
);

server.tool(
  "bas_sync_imported",
  "Sync the local cache of imported payment files from the BAS-K website. Scrapes all pages of the import history.",
  {},
  async () => {
    const p = await getPage();

    await p.goto("https://bas.batunionen.se/PaymentProcessing/PaymentProcessing", {
      waitUntil: "networkidle",
    });

    if (p.url().includes("/Account/Login")) {
      return { content: [{ type: "text", text: "Error: Not logged in." }] };
    }

    const allEntries: ImportedPayment[] = [];
    let pageNum = 1;

    while (true) {
      const rows = await p.$$eval("table tbody tr", (trs) =>
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

      const nextLink = p.locator(`.k-pager-numbers a[data-page="${pageNum + 1}"]`);
      if ((await nextLink.count()) === 0) {
        const moreLink = p.locator("a[title='Fler sidor'], a[title='More pages']");
        if ((await moreLink.count()) > 0) {
          await moreLink.click();
          await p.waitForTimeout(1000);
          const retryLink = p.locator(`.k-pager-numbers a[data-page="${pageNum + 1}"]`);
          if ((await retryLink.count()) === 0) break;
          await retryLink.click();
        } else {
          break;
        }
      } else {
        await nextLink.click();
      }

      await p.waitForTimeout(1000);
      pageNum++;
    }

    saveCache(allEntries);
    return { content: [{ type: "text", text: `Synced ${allEntries.length} imported payment records.` }] };
  }
);

server.tool(
  "bas_list_imported",
  "List imported payment files from local cache. Use bas_sync_imported first if cache is empty.",
  { limit: z.number().describe("Max entries to return").default(20) },
  async ({ limit }) => {
    const cache = loadCache();
    const entries = cache.slice(0, limit);
    const summary = `${cache.length} total imported files. Showing ${entries.length}:\n\n` +
      entries.map((e) => `[${e.id}] ${e.filename} — ${e.date} by ${e.by}`).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
