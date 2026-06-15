// Generic browser-automation MCP — the domain-free sibling of mcp-server.ts (bas-k).
//
// Why this exists: mcp-server.ts drives the LIVE accounting browser (CDP port 9222,
// the logged-in BAS-K session) and also bundles bas_* domain tools. Pointing those
// generic browser tools at unrelated pages (e.g. screenshotting a localhost dashboard)
// hijacks that accounting session. This server is fully isolated: ONLY the generic
// browser tools, its OWN dedicated browser on a separate CDP port + profile, headless
// by default. Register it as a distinct MCP (e.g. "browser") and use it for any
// general browsing/screenshotting without touching the accounting browser.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

// Isolated from the bas-k server: separate root, separate CDP port (never 9222).
const ROOT = process.env.GENERIC_ROOT || "D:/web-auto/.generic";
const SCREENSHOT_DIR = path.join(ROOT, "screenshots");
const SCREENSHOT_PATH = path.join(SCREENSHOT_DIR, "page.png");
const STATE_FILE = path.join(ROOT, "server.json");
const CDP_PORT = Number(process.env.GENERIC_CDP_PORT || 9333);
const HEADLESS = (process.env.GENERIC_HEADLESS || "1") !== "0";

let browser: Browser;
let page: Page;

async function ensureBrowser(): Promise<void> {
  if (page && !page.isClosed()) return;

  // Reconnect to our OWN browser if it's already running (its dedicated CDP port —
  // this can never resolve to the bas-k browser on 9222).
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  } catch {
    // Dedicated browser on its own CDP port — isolation is by port (never 9222).
    // Playwright manages the profile; do NOT pass --user-data-dir to launch() (it throws).
    const launched = await chromium.launch({
      headless: HEADLESS,
      args: [`--remote-debugging-port=${CDP_PORT}`],
    });
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ cdpUrl: `http://localhost:${CDP_PORT}`, headless: HEADLESS }));
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    (global as any).__browserProcess = launched; // keep the launched process alive
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

const server = new McpServer({ name: "browser", version: "1.0.0" });

server.tool(
  "screenshot",
  "Take a screenshot of the current browser page (isolated generic browser, not the accounting session)",
  { fullPage: z.boolean().describe("Capture the full scrollable page").default(false) },
  async ({ fullPage }) => {
    const p = await getPage();
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await p.screenshot({ path: SCREENSHOT_PATH, fullPage });
    return { content: [{ type: "text", text: `Screenshot saved to ${SCREENSHOT_PATH}` }] };
  }
);

server.tool(
  "browser_goto",
  "Navigate the browser to a URL",
  {
    url: z.string().describe("URL to navigate to"),
    // domcontentloaded by default: 'networkidle' hangs on pages with open streams
    // (SSE/websockets, e.g. a live dashboard) because the network never goes idle.
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"])
      .describe("Playwright load state to wait for").default("domcontentloaded"),
  },
  async ({ url, waitUntil }) => {
    const p = await getPage();
    await p.goto(url, { waitUntil });
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

server.tool("browser_close", "Close the generic browser and free its resources", {}, async () => {
  try {
    const proc = (global as any).__browserProcess;
    if (proc) await proc.close();
    else if (browser) await browser.close();
  } catch { /* already gone */ }
  (global as any).__browserProcess = undefined;
  page = undefined as any;
  return { content: [{ type: "text", text: "Browser closed." }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
