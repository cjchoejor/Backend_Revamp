/**
 * Puppeteer PDF render pipeline.
 *
 * Wraps a single long-lived Chromium browser instance behind `renderHtmlToPdf(html)`. The
 * browser boots on first call and stays open — Chromium takes ~1–2 s to launch cold, so
 * every subsequent render is ~200–400 ms. Call `closeRenderBrowser()` at process shutdown
 * (server exit / test teardown).
 *
 * The A4 defaults + inline CSS match the reference bills. Templates should embed their own
 * fonts / colours; this wrapper does not inject any styling.
 *
 * Windows note: Puppeteer 25 bundles Chromium and downloads it on `npm install`. On this
 * machine it lives under `back_end/node_modules/puppeteer/.local-chromium/`. No system
 * Chrome required.
 */
import type { Browser, LaunchOptions } from "puppeteer";
import { launch } from "puppeteer";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const opts: LaunchOptions = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    };
    browserPromise = launch(opts);
  }
  return browserPromise;
}

/** Convert an HTML string to PDF bytes. `html` should be a self-contained document with CSS inline. */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Wait for DOM parsing + any local resource loads to finish. Templates don't fetch any
    // remote assets (fonts are default, logo is base64) so `load` is sufficient.
    await page.setContent(html, { waitUntil: "load" });
    // A4 with 12 mm margins matches the reference bill aspect ratio; tweak per template if
    // a specific document needs a different size.
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "14mm", left: "12mm", right: "12mm" },
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Close the shared browser. Call from process signal handlers or test teardown. */
export async function closeRenderBrowser(): Promise<void> {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}
