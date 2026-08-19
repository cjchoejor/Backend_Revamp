/**
 * Server-side extraction from a stored ID photo (2026-08-18) — the fallback for photos that
 * arrived WITHOUT phone-side extraction (desk uploads, older captures, re-runs).
 *
 * Order, cheapest and most certain first:
 *   1. QR — decode any QR on the image (jsQR over sharp's raw pixels); an Aadhaar QR yields
 *      name / DOB / gender / (last-4 or full) number without any character recognition.
 *   2. MRZ — tesseract.js over a preprocessed crop of the lower part of the page (where the
 *      MRZ lives), whitelisted to the MRZ character set; parsed + check-digit-verified by
 *      `mrz.ts`. Falls back to the whole page when the crop finds nothing.
 *
 * Everything runs locally (no cloud, rule §2.4 of docs/id-proof-capture-and-ocr.md). Slow is
 * fine — this runs in the W39 worker, never in a request. tesseract.js downloads its `eng`
 * traineddata on first use (cached under `OCR_TESSDATA_DIR`, default ./storage/tessdata).
 */
import sharp from "sharp";
import jsQRImport, { type Options as JsQrOptions, type QRCode } from "jsqr";
// jsqr ships a CJS `export default`; under NodeNext interop the callable is either the module
// itself or its `.default` — resolve once, typed off the package's own declarations.
type JsQrFn = (data: Uint8ClampedArray, width: number, height: number, options?: JsQrOptions) => QRCode | null;
const jsQR: JsQrFn =
  typeof jsQRImport === "function"
    ? (jsQRImport as unknown as JsQrFn)
    : ((jsQRImport as unknown as { default: JsQrFn }).default as JsQrFn);
import { createWorker, PSM, type Worker } from "tesseract.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseAadhaarQrText, parseGenericQrText } from "./aadhaar-qr.js";
import { extractMrzLines, parseMrzLines } from "./mrz.js";
import { layoutOcr } from "./layout-ocr.js";
import { parseLayoutText, type LayoutDocKind } from "./layout-parse.js";
import type { IdentityExtraction, OcrEngine } from "./types.js";

const MRZ_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

export type ServerExtractionResult = { engine: OcrEngine; extraction: IdentityExtraction } | null;

/** Try to decode a QR anywhere on the image (also on a 2× upscale for small codes). */
export async function decodeQrFromImage(bytes: Buffer): Promise<string | null> {
  const base = sharp(bytes, { failOn: "none" }).rotate();
  const meta = await base.metadata();
  const w = meta.width ?? 0;
  const attempts: number[] = [];
  // Work at ~1200px and ~2000px wide — jsQR wants the finder patterns a few px each.
  attempts.push(Math.min(1200, w || 1200), Math.min(2000, w || 2000));
  for (const width of Array.from(new Set(attempts))) {
    try {
      const { data, info } = await sharp(bytes, { failOn: "none" })
        .rotate()
        .resize({ width, withoutEnlargement: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, {
        inversionAttempts: "attemptBoth",
      });
      if (code?.data) return code.data;
    } catch {
      /* try the next size */
    }
  }
  return null;
}

function tessdataDir(): string {
  return process.env.OCR_TESSDATA_DIR ?? "./storage/tessdata";
}

/**
 * Which traineddata reads the MRZ. OCR-B is the MRZ typeface, and the generic `eng` model
 * confuses its `<` filler with K/L and Z with 2; when an OCR-B model
 * (`ocrb.traineddata`, e.g. from github.com/Shreeshrii/tessdata_ocrb) is dropped into the
 * tessdata dir it is used automatically, otherwise `eng` (auto-downloaded once) is the fallback.
 * `OCR_MRZ_LANG` overrides.
 */
export function mrzLanguage(): { lang: string; local: boolean } {
  const forced = process.env.OCR_MRZ_LANG?.trim();
  if (forced) return { lang: forced, local: existsSync(path.join(tessdataDir(), `${forced}.traineddata`)) };
  if (existsSync(path.join(tessdataDir(), "ocrb.traineddata"))) return { lang: "ocrb", local: true };
  return { lang: "eng", local: false };
}

let tessWorker: Promise<Worker> | null = null;
async function getTesseract(): Promise<Worker> {
  if (!tessWorker) {
    tessWorker = (async () => {
      const { lang, local } = mrzLanguage();
      const w = await createWorker(lang, 1, {
        cachePath: tessdataDir(),
        // A locally-provided model is read straight from the tessdata dir (uncompressed);
        // otherwise tesseract.js fetches + caches the standard gzip'd traineddata.
        ...(local ? { langPath: tessdataDir(), gzip: false } : {}),
        logger: () => {},
      });
      await w.setParameters({
        tessedit_char_whitelist: MRZ_WHITELIST,
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
      });
      return w;
    })();
    tessWorker.catch(() => {
      tessWorker = null;
    });
  }
  return tessWorker;
}

/** Release the tesseract worker (tests / graceful shutdown). */
export async function shutdownIdentityOcr(): Promise<void> {
  const w = tessWorker;
  tessWorker = null;
  if (w) await (await w).terminate().catch(() => {});
}

async function preprocessForMrz(bytes: Buffer, region: "bottom" | "full"): Promise<Buffer> {
  // Materialise the EXIF-rotated frame first: `metadata()` reports the stored (pre-rotation)
  // dimensions, so a portrait phone photo would get a crop box past its edge.
  const rotated = await sharp(bytes, { failOn: "none" }).rotate().toBuffer();
  const img = sharp(rotated, { failOn: "none" });
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  let pipeline = img;
  if (region === "bottom" && w > 0 && h > 0) {
    const top = Math.floor(h * 0.55);
    pipeline = pipeline.extract({ left: 0, top, width: w, height: h - top });
  }
  return pipeline
    .resize({ width: 1800, withoutEnlargement: false })
    .grayscale()
    .normalise()
    .sharpen()
    .threshold(150)
    .png()
    .toBuffer();
}

/** OCR the MRZ off the image; returns the parsed extraction or null. */
export async function readMrzFromImage(bytes: Buffer): Promise<IdentityExtraction | null> {
  const worker = await getTesseract();
  for (const region of ["bottom", "full"] as const) {
    const png = await preprocessForMrz(bytes, region);
    const { data } = await worker.recognize(png);
    const lines = extractMrzLines(data.text ?? "");
    if (!lines) continue;
    const parsed = parseMrzLines(lines);
    if (parsed && !parsed.empty) return parsed;
  }
  return null;
}

/**
 * Run the whole server pipeline over the stored bytes: QR (exact) → MRZ (check-digit
 * verified) → layout OCR + label anchoring (Phase B — CID / voter card / birth certificate,
 * READ only). `kindHint` (a document type the desk row already names) skips the layout
 * pass's keyword detection.
 */
export async function extractIdentityFromImage(
  bytes: Buffer,
  opts: { kindHint?: LayoutDocKind } = {},
): Promise<ServerExtractionResult> {
  const qrText = await decodeQrFromImage(bytes);
  let genericQr: ReturnType<typeof parseGenericQrText> = null;
  if (qrText) {
    // Aadhaar's QR is the whole record — nothing more to read. Any OTHER ID's QR usually
    // carries less than the printed face (a number, a verify URL), so hold what it yields
    // and keep going: the layout pass reads the printed labels and the two MERGE below.
    const aadhaar = parseAadhaarQrText(qrText);
    if (aadhaar && !aadhaar.empty) return { engine: "SERVER_QR", extraction: aadhaar };
    genericQr = parseGenericQrText(qrText);
  }
  const mrz = await readMrzFromImage(bytes);
  if (mrz) return { engine: "SERVER_MRZ", extraction: mrz };
  const layout = await layoutOcr(bytes);
  if (layout && layout.lines.length) {
    const parsed = parseLayoutText(
      layout.lines.map((l) => l.text),
      opts.kindHint ?? null,
    );
    if (parsed && !parsed.empty) {
      // QR values beat OCR values on overlap (an exact decode has no character errors) —
      // except the document TYPE, which the QR payload almost never names.
      if (genericQr && !genericQr.empty) {
        const { documentType: _ignored, ...qrFields } = genericQr.fields;
        parsed.fields = { ...parsed.fields, ...qrFields };
        for (const k of Object.keys(qrFields) as (keyof typeof qrFields)[]) parsed.fieldConfidence[k] = "READ";
        parsed.raw = { ...parsed.raw, qrText: genericQr.raw.qrText, source: `${parsed.raw.source} + ${genericQr.raw.source}` };
      }
      parsed.raw = { ...parsed.raw, source: `${parsed.raw.source} via ${layout.engine} (${layout.ms} ms)`, ocrLines: layout.lines.map((l) => l.text).slice(0, 60) };
      return { engine: "SERVER_LAYOUT", extraction: parsed };
    }
  }
  // No readable layout — a generic QR alone is still worth suggesting.
  if (genericQr && !genericQr.empty) return { engine: "SERVER_QR", extraction: genericQr };
  return null;
}
