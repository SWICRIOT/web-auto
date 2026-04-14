import { connectBrowser, goTo } from "@web-auto/core";

async function main() {
  const { activePage } = await connectBrowser();
  const page = await activePage();

  await goTo(page, "https://bas.batunionen.se");
  console.log("Navigated to bas.batunionen.se — log in manually, then tell me to continue.");
}

main();
