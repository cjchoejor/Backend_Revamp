/**
 * Child process that hosts the layout OCR model (Phase B, 2026-08-18).
 *
 * Florence-2 is ~1 GB resident once loaded and CPU-hungry while it runs; under `dev:workers`
 * the pg-boss workers live INSIDE the API process, so running the model there would drag
 * every request. `layout-ocr.ts` forks this file on first use and talks to it over IPC:
 *   parent → { id, bytesB64, engine: "florence2" | "tesseract" }
 *   child  → { id, lines } | { id, error }
 * The parent kills it after an idle period so the RAM goes back when the desk is quiet, and
 * restarts it on the next photo. A crash here (bad image, OOM) is a FAILED suggestion, not a
 * dead API.
 */
import { ocrWithFlorence, ocrWithTesseractPage } from "./layout-ocr.js";

type Req = { id: number; bytesB64: string; engine: "florence2" | "tesseract" };

process.on("message", async (msg: Req) => {
  if (!msg || typeof msg.id !== "number") return;
  try {
    const bytes = Buffer.from(msg.bytesB64, "base64");
    const lines = msg.engine === "florence2" ? await ocrWithFlorence(bytes) : await ocrWithTesseractPage(bytes);
    process.send?.({ id: msg.id, lines });
  } catch (err) {
    process.send?.({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});

process.send?.({ ready: true });
