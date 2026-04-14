import { chromium, Browser, Page } from "playwright";
import { getCdpUrl } from "./server";

export interface LiveSession {
  browser: Browser;
  /** Returns the first open page, or creates one if none exist. */
  activePage: () => Promise<Page>;
}

export async function connectBrowser(): Promise<LiveSession> {
  const cdpUrl = getCdpUrl();
  const browser = await chromium.connectOverCDP(cdpUrl);

  const activePage = async (): Promise<Page> => {
    for (const ctx of browser.contexts()) {
      const pages = ctx.pages();
      if (pages.length > 0) return pages[0];
    }
    const ctx = await browser.newContext();
    return await ctx.newPage();
  };

  return { browser, activePage };
}
