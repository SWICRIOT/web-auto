import { connectBrowser } from "@web-auto/core";

async function main() {
  const { activePage } = await connectBrowser();
  const page = await activePage();
  await page.screenshot({ path: "D:/web-auto/.screenshots/page.png" });
  console.log("Done. URL:", page.url());
}

main();
