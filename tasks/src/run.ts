import { connectBrowser } from "@web-auto/core";

async function main() {
  const { activePage } = await connectBrowser();
  const page = await activePage();

  await page.click("#btnLoadFile");
  console.log("Clicked 'Läs in inbetalningsfil'.");

  await page.waitForTimeout(5000);
  await page.screenshot({ path: "D:/web-auto/.screenshots/page.png" });
  console.log("Screenshot saved.");
}

main();
