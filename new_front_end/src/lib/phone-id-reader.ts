/**
 * On-phone document reading for the capture page (2026-08-18).
 *
 * The phone is a SENSOR: it decodes the QR (jsQR) and dumps the OCR text of the lower part
 * of the page (tesseract.js, OCR-B model when served from /tessdata) — and hands the RAW
 * result to the server, which does the interpreting (MRZ parse + check digits, Aadhaar QR
 * unpack, document-type allowlist). Nothing here decides what a field means.
 *
 * Everything is best-effort: an old browser, a missing model, or a slow phone simply yields
 * `null` and the server-side W39 pass reads the stored bytes instead. All work stays on the
 * device — the image is never sent anywhere but the hotel's own upload route.
 */
import jsQR from "jsqr";

export type PhoneReading = {
  qrText: string | null;
  /** tesseract text of the lower ~45% of the page (where a passport MRZ sits), if run. */
  ocrText: string | null;
  /** The downscaled JPEG actually uploaded (smaller than the camera original). */
  blob: Blob;
  ms: number;
};

const MAX_LONG_EDGE = 1800;

/**
 * Let the browser PAINT before the next heavy synchronous chunk. jsQR and getImageData run
 * on the main thread — without these yields the preview + "Analysing…" spinner never render
 * until the whole scan is over, which reads as "the photo didn't take" (operator report:
 * a 15–20 s blank gap on a mid-range phone). Double-rAF = the previous frame has painted.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function decodeToCanvas(file: Blob): Promise<HTMLCanvasElement | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas;
  } catch {
    return null;
  }
}

/**
 * Progressive QR scan, cheap sizes first: a QR's finder patterns only need a few pixels per
 * module, so a ~900px frame finds the typical card QR in a fraction of the time the full
 * frame takes; the full frame and a 1.5× upscale are fallbacks for small/far codes. One
 * paint-yield before every attempt keeps the page responsive between the synchronous passes.
 */
async function readQr(canvas: HTMLCanvasElement): Promise<string | null> {
  const widths = Array.from(
    new Set([Math.min(900, canvas.width), canvas.width, Math.round(canvas.width * 1.5)]),
  );
  for (const w of widths) {
    await nextPaint();
    try {
      let img: ImageData;
      if (w === canvas.width) {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) continue;
        img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } else {
        const c2 = document.createElement("canvas");
        c2.width = w;
        c2.height = Math.round((canvas.height * w) / canvas.width);
        const cx = c2.getContext("2d", { willReadFrequently: true });
        if (!cx) continue;
        cx.drawImage(canvas, 0, 0, c2.width, c2.height);
        img = cx.getImageData(0, 0, c2.width, c2.height);
      }
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
      if (code?.data) return code.data;
    } catch {
      /* next try */
    }
  }
  return null;
}

/** Lower part of the page, grayscale + contrast-stretched, upscaled — what tesseract reads. */
function mrzCrop(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const top = Math.floor(canvas.height * 0.55);
  const c = document.createElement("canvas");
  const targetW = 1800;
  const scale = targetW / canvas.width;
  c.width = targetW;
  c.height = Math.round((canvas.height - top) * scale);
  const cx = c.getContext("2d")!;
  cx.drawImage(canvas, 0, top, canvas.width, canvas.height - top, 0, 0, c.width, c.height);
  const img = cx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // Grayscale + simple threshold (the MRZ is black on white by design).
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = g > 150 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

let tesseractWorker: Promise<import("tesseract.js").Worker> | null = null;
async function getTesseract() {
  if (!tesseractWorker) {
    tesseractWorker = (async () => {
      const { createWorker, PSM } = await import("tesseract.js");
      // OCR-B (the MRZ typeface) when the hotel served it under /tessdata; else the generic
      // English model (fetched from the tesseract CDN — needs internet on the phone).
      let lang = "eng";
      let langOpts: Record<string, unknown> = {};
      try {
        const head = await fetch("/tessdata/ocrb.traineddata", { method: "HEAD" });
        if (head.ok) {
          lang = "ocrb";
          langOpts = { langPath: "/tessdata", gzip: false };
        }
      } catch {
        /* CDN eng */
      }
      const w = await createWorker(lang, 1, {
        workerPath: "/tesseract/worker.min.js",
        // Explicit SIMD+LSTM build: letting tesseract.js auto-pick chose the relaxed-SIMD variant,
        // which aborted ("missing function DotProductSSE") in headless Chromium; plain SIMD runs
        // everywhere a phone browser runs since 2021.
        corePath: "/tesseract-core/tesseract-core-simd-lstm.wasm.js",
        ...langOpts,
        logger: () => {},
      });
      await w.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      });
      return w;
    })();
    tesseractWorker.catch(() => {
      tesseractWorker = null;
    });
  }
  return tesseractWorker;
}

/** Warm the OCR worker while the person is still framing the shot. */
export function warmPhoneReader(): void {
  void getTesseract().catch(() => {});
}

/**
 * Read a captured image on the phone. Returns the (downscaled) blob to upload plus whatever
 * raw payload was found — QR text first (cheap, exact), else the OCR dump of the MRZ area.
 * `onStage` reports progress for the UI.
 */
export async function readIdOnPhone(file: File, onStage?: (s: "decoding" | "qr" | "mrz") => void): Promise<PhoneReading | null> {
  const t0 = performance.now();
  if (!file.type.startsWith("image/")) return null;
  onStage?.("decoding");
  // First yield: the caller just flipped to the preview — let it PAINT (photo + spinner)
  // before any decode work starts, so the person immediately sees the shot registered.
  await nextPaint();
  const canvas = await decodeToCanvas(file);
  if (!canvas) return null;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) return null;
  onStage?.("qr");
  const qrText = await readQr(canvas);
  let ocrText: string | null = null;
  if (!qrText) {
    onStage?.("mrz");
    await nextPaint(); // mrzCrop is another synchronous getImageData + threshold pass
    try {
      const worker = await getTesseract();
      const { data } = await worker.recognize(mrzCrop(canvas));
      ocrText = data.text ?? null;
    } catch {
      ocrText = null;
    }
  }
  return { qrText, ocrText, blob, ms: Math.round(performance.now() - t0) };
}
