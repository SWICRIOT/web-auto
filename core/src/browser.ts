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

  const browser = await chromium.launch({ headless });

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
