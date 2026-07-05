import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as path from "path";
import * as fs from "fs";

export interface BrowserOptions {
  headless?: boolean;
  defaultTimeout?: number;
  storageDir?: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cleanup: () => Promise<void>;
}

const DEFAULT_STORAGE_DIR = path.join(process.cwd(), ".browser-state");

export async function launchBrowser(
  options: BrowserOptions = {}
): Promise<BrowserSession> {
  const {
    headless = false,
    defaultTimeout = 30_000,
    storageDir = DEFAULT_STORAGE_DIR,
  } = options;

  // Prefer the system Chrome (real GPU stack) over Playwright's bundled Chromium, which
  // falls back to SwiftShader software rendering (WebGL-heavy pages crawl). The args force
  // hardware ANGLE/D3D11 past the bundled build's conservative defaults; if Chrome isn't
  // installed, fall back to the bundled Chromium with the same flags.
  const gpuArgs = ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless, channel: "chrome", args: gpuArgs });
  } catch {
    browser = await chromium.launch({ headless, args: gpuArgs });
  }

  const statePath = path.join(storageDir, "state.json");
  const hasState = fs.existsSync(statePath);

  const context = await browser.newContext({
    ...(hasState ? { storageState: statePath } : {}),
  });

  context.setDefaultTimeout(defaultTimeout);

  const page = await context.newPage();

  const cleanup = async () => {
    fs.mkdirSync(storageDir, { recursive: true });
    await context.storageState({ path: statePath });
    await browser.close();
  };

  return { browser, context, page, cleanup };
}
