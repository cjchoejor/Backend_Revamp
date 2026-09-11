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
 * Windows note: Puppeteer 25 downloads its browsers on `npm install`, into the per-user cache
 * (`~/.cache/puppeteer`), not into `node_modules`. No system Chrome required.
 *
 * WHY `headless: "shell"` AND NOT `true` (2026-09-11, operator report — "whenever I send a mail
 * a black box appears"). Since Puppeteer 22, `headless: true` means Chrome's **new** headless:
 * the full `chrome.exe` run with `--headless=new`. It is not windowless — it creates a real
 * platform window and merely tries to keep it off-screen, and on this Windows box that window
 * paints as a black rectangle over the desk. Because the browser is deliberately kept alive
 * between renders (below), the box did not flash and vanish — it sat there until the backend
 * restarted, appearing on the first mail sent after every boot.
 *
 * `"shell"` runs `chrome-headless-shell` instead — the old headless binary, which has no window
 * surface at all. Puppeteer downloads it alongside Chrome, so nothing new is installed. It is
 * the right tool here: this module only ever loads a self-contained HTML string and prints it,
 * and every API it uses (setContent, fonts.ready, emulateMediaType, setViewport, pdf) is
 * supported there.
 *
 * `PDF_HEADLESS=chrome` forces the new-headless path back on, as an escape hatch if a future
 * template ever needs something only full Chrome renders. Expect the black window to return.
 */
import type { Browser, LaunchOptions } from "puppeteer";
import { launch } from "puppeteer";

let browserPromise: Promise<Browser> | null = null;

/** `true` = new headless (full Chrome, opens a window on Windows); `"shell"` = windowless. */
const HEADLESS_MODE: LaunchOptions["headless"] = process.env.PDF_HEADLESS === "chrome" ? true : "shell";

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const opts: LaunchOptions = {
      headless: HEADLESS_MODE,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    };
    browserPromise = launch(opts);
  }
  return browserPromise;
}

/** A4 printable area (page minus the 12/14mm margins below) in CSS px — 1mm = 96/25.4 px. */
const MM_TO_PX = 96 / 25.4;
const PRINTABLE_W_PX = (210 - 24) * MM_TO_PX; // ≈ 703
const PRINTABLE_H_PX = (297 - 26) * MM_TO_PX; // ≈ 1024

export type RenderPdfOptions = {
  /**
   * Scale the document so its content spans the full A4 page (the Legphel house documents —
   * the reference gallery lays the card out ~386px wide, tall and dense; unscaled on A4 it
   * floats small over an empty page). The pass measures the card's natural height, picks the
   * pdf scale that makes it fill the printable height, and sets a min-height so shorter
   * content still stretches its frame to the bottom edge (the shell pins .dfoot there).
   * Selector-based: documents without a `.doc` card fall back to the plain render.
   */
  fitToPage?: boolean;
};

/** Convert an HTML string to PDF bytes. `html` should be a self-contained document with CSS inline. */
export async function renderHtmlToPdf(html: string, opts: RenderPdfOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Wait for DOM parsing + resource loads. The Legphel document shell @imports its webfonts
    // (Spectral / IBM Plex), which finish AFTER `load`, so also wait on document.fonts.ready —
    // capped at 5s so an offline host degrades to the CSS fallback stacks instead of hanging.
    await page.setContent(html, { waitUntil: "load" });
    await Promise.race([
      page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready),
      new Promise((r) => setTimeout(r, 5000)),
    ]);

    // `page.pdf({ scale })` lays the page out at printableWidth/scale and magnifies by scale, so
    // the right scale depends on the content height AT that layout width. Chromium caps scale at
    // 2; the lower clamp of 1 lets an over-long document paginate naturally instead of shrinking.
    let scale = 1;
    if (opts.fitToPage) {
      await page.emulateMediaType("print"); // measure under the print rules (sheet padding off)
      const hasDoc = await page.evaluate(() => !!document.querySelector(".doc"));
      if (hasDoc) {
        // Two passes: height changes with layout width (rows wrap), so measure → pick scale →
        // re-measure at the width that scale implies → settle. Converges in two iterations for
        // these single-column documents.
        for (let i = 0; i < 2; i++) {
          await page.setViewport({ width: Math.ceil(PRINTABLE_W_PX / scale), height: 800 });
          const h = await page.evaluate(() => {
            const el = document.querySelector(".doc") as HTMLElement;
            el.style.minHeight = "0"; // natural content height, not a previously set stretch
            return el.getBoundingClientRect().height;
          });
          scale = Math.min(2, Math.max(1, PRINTABLE_H_PX / Math.max(1, h)));
        }
        // Stretch the frame to the bottom edge for content shorter than the page (the shell's
        // print rules pin .dfoot there via margin-top:auto). -2 keeps rounding from spilling a
        // hair onto a second page.
        await page.evaluate((minH: number) => {
          (document.querySelector(".doc") as HTMLElement).style.minHeight = `${minH}px`;
        }, Math.floor(PRINTABLE_H_PX / scale) - 2);
      }
    }

    // A4 with 12 mm margins matches the reference bill aspect ratio; tweak per template if
    // a specific document needs a different size.
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      scale,
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
