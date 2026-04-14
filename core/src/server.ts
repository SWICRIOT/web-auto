import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.join(process.cwd(), ".browser-state", "server.json");
const CDP_PORT = 9222;

export async function startServer(): Promise<void> {
  const browser = await chromium.launch({
    headless: false,
    args: [`--remote-debugging-port=${CDP_PORT}`],
  });

  const cdpUrl = `http://localhost:${CDP_PORT}`;

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ cdpUrl }));

  console.log(`Browser started with CDP at ${cdpUrl}`);
  console.log(`Endpoint saved to ${STATE_FILE}`);

  // Create an initial page so the browser doesn't close
  const context = browser.contexts()[0] ?? await browser.newContext();
  await context.newPage();

  process.on("SIGINT", () => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
    browser.close();
    process.exit();
  });
}

export function getCdpUrl(): string {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error("No browser server running. Start one first.");
  }
  const { cdpUrl } = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  return cdpUrl;
}

if (require.main === module) {
  startServer();
}
