# Playwright Lessons Learned

Hard-won patterns from building browser automation scrapers with Playwright on Windows.

## Batch DOM reads — don't chat with the browser

**Problem:** Reading each table cell with individual `locator.textContent()` calls is slow. Each call is a round-trip to the browser process.

**Solution:** Use `$$eval` or `$eval` to extract everything in one shot.

```typescript
// SLOW — 8+ round-trips per row
const name = await columns.nth(0).textContent();
const ref = await columns.nth(1).textContent();
const amount = await columns.nth(3).locator("span").textContent();

// FAST — 1 round-trip for all rows
const summaries = await page.$$eval("tr.row-hover", rows =>
  rows.map(r => {
    const cells = r.querySelectorAll("td");
    return {
      name: cells[0]?.textContent?.trim() || "",
      ref: cells[1]?.textContent?.trim() || "",
      amount: cells[3]?.querySelector("span")?.textContent?.trim() || "0",
    };
  })
);
```

Same applies to detail extraction — when expanding a row, grab everything in one `$eval` instead of multiple locator queries.

## Detect page refresh by content, not element IDs

**Problem:** Many SPAs reuse the same element IDs across state changes. Bankgiro's transaction table uses `trans_0, trans_1, trans_2...` regardless of which day is selected. Comparing IDs to detect a page refresh will never see a change and hit the timeout.

**Solution:** Compare actual text content of cells, not structural IDs.

```typescript
// BAD — IDs are always trans_0, trans_1... across all days
const oldIds = await page.$$eval("tr.row-hover", rows => rows.map(r => r.id).join(","));
await dayItem.click();
await page.waitForFunction(prev => {
  const newIds = ...; // Same as prev! Waits full timeout.
  return newIds !== prev;
}, oldIds, { timeout: 5000 });

// GOOD — content actually changes between days
const oldContent = await page.$$eval("tr.row-hover td:first-child", cells =>
  cells.map(c => c.textContent?.trim() || "").join("|")
);
await dayItem.click();
await page.waitForFunction(prev => {
  const now = document.querySelectorAll("tr.row-hover td:first-child");
  const content = Array.from(now).map(c => c.textContent?.trim() || "").join("|");
  return content !== prev && content.length > 0;
}, oldContent, { timeout: 3000 });
```

## Responsive design creates duplicate elements

**Problem:** Sites with responsive design render two versions of each element — one for mobile (`hidden-md hidden-lg`) and one for desktop (`hidden-sm`). Playwright's strict mode fails when a selector matches both.

**Solution:** Target the visible variant explicitly.

```typescript
// FAILS — strict mode: 2 elements
const row = page.locator(`#trans_0`);

// WORKS — targets desktop version only
const row = page.locator(`tr#trans_0.hidden-sm`);
```

Also applies to XPaths in detail expansion:
```typescript
// Include the class filter in following-sibling lookups
const xpath = `//tr[@id='${rowId}' and contains(@class,'hidden-sm')]/following-sibling::tr[1]//transaction-details`;
```

## Kendo UI widgets need special handling

BAS-K uses Kendo UI extensively. Key gotchas:

**File upload:** Don't use `setInputFiles` + `dispatchEvent('change')` — it bypasses Kendo's internal state and crashes the widget. Use the file chooser event instead:
```typescript
const [fc] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.locator(".k-upload-button").click(),
]);
await fc.setFiles(filePath);
```

**Dropdowns:** The visible element is a Kendo wrapper, the actual `<select>` is hidden. Read values via `$eval`, don't use `selectOption` on the hidden element.

**Pagination:** Page numbers live in `.k-pager-numbers`. The "more pages" link has `title='Fler sidor'`. Must click it to reveal page numbers beyond the initial set.

**Dialogs:** Appear as `.k-window` elements. Read with `.innerText()`, dismiss by clicking the button inside.

## Remove artificial waits

**Problem:** Defensive `waitForTimeout(500)` calls add up fast. A scraper with 3 waits per row × 20 rows = 30 seconds of pure waiting per day.

**Solution:** Only wait for actual conditions. Playwright's `waitForSelector` and `waitForFunction` are the right tools — fixed sleeps are almost never needed.

```typescript
// BAD — sleeping "just in case"
await toggle.click();
await page.waitForTimeout(500);
await page.waitForSelector(detailsXpath, { timeout: 5000 });
await page.waitForTimeout(300);
// ... extract ...
await toggle.click();
await page.waitForTimeout(400);

// GOOD — wait only for the actual signal
await toggle.click();
await page.waitForSelector(detailsXpath, { timeout: 2000 });
// ... extract ...
await toggle.click();
```

## Validate scraped data against the source

**Problem:** Stale DOM reads, partial loads, and race conditions produce silently wrong data. You won't know until reconciliation fails later.

**Solution:** Compare scraped totals against a known-good summary from the page itself.

```typescript
const scrapedTotal = transactions.reduce((s, t) => s + t.amount, 0);
const countMatch = transactions.length === sidebar.transactionCount;
const amountMatch = Math.abs(scrapedTotal - sidebar.totalAmount) < 0.02;

if (!countMatch || !amountMatch) {
  // Re-click the day and retry
}
```

Also validate existing data in the database before skipping — if it doesn't match, delete and re-scrape.

## Multi-tab detection

**Problem:** Some sites open features in new tabs (e.g., Swedbank opens Bankgiro in a separate tab after login). Playwright doesn't automatically switch to new tabs.

**Solution:** Listen for new pages on the browser context and poll existing pages.

```typescript
async function waitForPage(context, urlPattern) {
  // Check existing tabs
  for (const p of context.pages()) {
    if (p.url().includes(urlPattern)) return p;
  }
  // Listen for new tabs
  return new Promise((resolve) => {
    context.on("page", async (newPage) => {
      await newPage.waitForLoadState("domcontentloaded");
      if (newPage.url().includes(urlPattern)) resolve(newPage);
    });
  });
}
```

## CDP connection for persistent browsers

**Problem:** `chromium.connect()` WebSocket connections lose pages when the connecting process exits. Each new connection sees an empty browser.

**Solution:** Use CDP (`--remote-debugging-port` + `connectOverCDP`) — pages persist across connections because they belong to the browser process, not the connection.

```typescript
// Launch once
const browser = await chromium.launch({
  headless: false,
  args: ["--remote-debugging-port=9222"],
});

// Connect from anywhere, any time — pages survive
const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = browser.contexts()[0].pages()[0]; // existing page
```

## Screenshots as a debugging tool

When DOM queries return unexpected results, take a screenshot and view it with Claude Code's Read tool. This is faster than guessing at selectors:

```typescript
await page.screenshot({ path: "debug.png" });
// Then: Read tool on debug.png shows exactly what the browser sees
```

## Swedish characters in curl/JSON

When passing file paths with å, ä, ö through curl to an HTTP API, use Unicode escapes in the JSON body:

```bash
curl -X POST http://localhost:3001/upload --data-binary @- <<'EOF'
{"file": "C:/path/Kass\u00f6r/file.xml"}
EOF
```

PowerShell's `Invoke-RestMethod` handles UTF-8 natively — no escaping needed.

## Financial year routing for MongoDB

Store scraped data in the correct per-year database (`Year_{id}`), not a shared collection. Load the financial year definitions from MongoDB and route each transaction by its date:

```typescript
const fys = await generalDb.collection("FinancialYears").find({}).toArray();

function getDbForDate(dateStr: string) {
  const d = new Date(dateStr);
  const fy = fys.find(f => d >= f.FromDate && d <= f.ToDate);
  return fy ? client.db(`Year_${fy._id}`) : null;
}
```
