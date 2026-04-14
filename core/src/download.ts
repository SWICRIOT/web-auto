import { Page } from "playwright";
import * as path from "path";
import * as fs from "fs";

export interface DownloadOptions {
  /** Directory to save to. Created if it doesn't exist. */
  destDir: string;
  /** Override the filename. Uses the browser-suggested name if omitted. */
  filename?: string;
  /** What to do when a file with the same name exists. Default: "rename". */
  onConflict?: "overwrite" | "rename" | "skip";
}

function resolveFilename(destDir: string, filename: string, onConflict: string): string {
  const target = path.join(destDir, filename);

  if (!fs.existsSync(target) || onConflict === "overwrite") {
    return target;
  }

  if (onConflict === "skip") {
    return "";
  }

  // rename: append (1), (2), etc.
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let i = 1;
  while (fs.existsSync(path.join(destDir, `${base} (${i})${ext}`))) {
    i++;
  }
  return path.join(destDir, `${base} (${i})${ext}`);
}

/**
 * Click a locator that triggers a download, then save the file to disk.
 * Returns the full path of the saved file, or null if skipped.
 */
export async function downloadFile(
  page: Page,
  clickTarget: string,
  options: DownloadOptions
): Promise<string | null> {
  const { destDir, filename, onConflict = "rename" } = options;

  fs.mkdirSync(destDir, { recursive: true });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click(clickTarget),
  ]);

  const name = filename ?? download.suggestedFilename();
  const dest = resolveFilename(destDir, name, onConflict);

  if (!dest) {
    await download.cancel();
    console.log(`Skipped (exists): ${name}`);
    return null;
  }

  await download.saveAs(dest);
  console.log(`Saved: ${dest}`);
  return dest;
}

/**
 * Download from a direct URL (no click needed).
 */
export async function downloadUrl(
  page: Page,
  url: string,
  options: DownloadOptions
): Promise<string> {
  const { destDir, filename, onConflict = "rename" } = options;

  fs.mkdirSync(destDir, { recursive: true });

  const response = await page.context().request.get(url);
  const buffer = await response.body();

  const name = filename ?? (path.basename(new URL(url).pathname) || "download");
  const dest = resolveFilename(destDir, name, onConflict);

  if (!dest) {
    console.log(`Skipped (exists): ${name}`);
    return "";
  }

  fs.writeFileSync(dest, buffer);
  console.log(`Saved: ${dest}`);
  return dest;
}
