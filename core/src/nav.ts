import { Page } from "playwright";

/**
 * Navigate to a URL and wait until the page is idle.
 */
export async function goTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle" });
}

/**
 * Retry an action up to `maxAttempts` times.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${i + 1}/${maxAttempts} failed: ${err}`);
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Fill a login form and submit. Waits for navigation after submit.
 */
export async function login(
  page: Page,
  opts: {
    usernameSelector: string;
    passwordSelector: string;
    submitSelector: string;
    username: string;
    password: string;
  }
): Promise<void> {
  await page.fill(opts.usernameSelector, opts.username);
  await page.fill(opts.passwordSelector, opts.password);
  await Promise.all([
    page.waitForURL(/.*/),
    page.click(opts.submitSelector),
  ]);
}

/**
 * Wait for a selector to appear, with a custom timeout.
 */
export async function waitFor(
  page: Page,
  selector: string,
  timeoutMs: number = 10_000
): Promise<void> {
  await page.waitForSelector(selector, { timeout: timeoutMs });
}
