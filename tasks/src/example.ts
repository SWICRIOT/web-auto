import { launchBrowser, goTo } from "@web-auto/core";

async function main() {
  const { page, cleanup } = await launchBrowser();
  try {
    await goTo(page, "https://example.com");

    const title = await page.title();
    console.log(`Page title: ${title}`);

    const headings = await page.$$eval("h1", (els) =>
      els.map((e) => e.textContent)
    );
    console.log("Headings:", headings);
  } finally {
    await cleanup();
  }
}

main();
