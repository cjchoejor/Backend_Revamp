/**
 * Server-side extraction from a stored ID photo (2026-08-18) — the fallback for photos that
 * arrived WITHOUT phone-side extraction (desk uploads, older captures, re-runs).
 *
 * Order, cheapest and most certain first:
 *   1. QR — decode any QR on the image (jsQR over sharp's raw pixels); an Aadhaar QR yields
 *      name / DOB / gender / (last-4 or full) number without any character recognition.
 *   2. MRZ — tesseract.js over a preprocessed crop of the lower part of the page (where the
 *      MRZ lives), whitelisted to the MRZ character set; parsed + check-digit-verified by
 *      `mrz.ts`.
 *   3. The page — Florence-2 reads every line (`layout-ocr.ts`); where it found the strip, that
 *      spot is read again closely with OCR-B, and every strip-like line goes through the
 *      passport reader (`passport-text.ts`) before the label-anchored parse (2026-10-23).
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
import { detectLayoutDocKind, parseLayoutText, type LayoutDocKind } from "./layout-parse.js";
import { looksLikeStrip, readPassportFromText } from "./passport-text.js";
import type { IdentityExtraction, OcrEngine } from "./types.js";

const MRZ_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

export type ServerExtractionResult = { engine: OcrEngine; extraction: IdentityExtraction } | null;

/** Try to decode a QR anywhere on the image (also on a 2× upscale for small codes). */
export async function decodeQrFromImage(bytes: Buffer): Promise<string | null> {
  const base = sharp(bytes, { failOn: "none" }).rotate();
  const meta = await base.metadata();
  const w = meta.width ?? 0;
  const attempts: number[] = [];
  // Work at ~1000px and ~1600px wide — jsQR wants the finder patterns a few px each, and an ID's
  // QR is large; a bigger pass found nothing more and cost seconds on a 12 MP photo (2026-10-23).
  attempts.push(Math.min(1000, w || 1000), Math.min(1600, w || 1600));
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
 * confuses its `<` filler with K/L and Z with 2; when an OCR-B model is in the tessdata dir it is
 * used automatically, otherwise `eng` (auto-downloaded once) is the fallback. `OCR_MRZ_LANG`
 * overrides. The model must be an INTEGER build (`fetch-ocrb-traineddata.ts` fetches
 * `ocrb_int`): a floating-point one aborts the relaxed-SIMD engine Node 22 picks — and a model
 * that fails is set aside for the rest of the process, so the next read uses `eng`.
 */
const failedLangs = new Set<string>();
export function mrzLanguage(): { lang: string; local: boolean } {
  const forced = process.env.OCR_MRZ_LANG?.trim();
  if (forced && !failedLangs.has(forced)) return { lang: forced, local: existsSync(path.join(tessdataDir(), `${forced}.traineddata`)) };
  if (!failedLangs.has("ocrb") && existsSync(path.join(tessdataDir(), "ocrb.traineddata"))) return { lang: "ocrb", local: true };
  return { lang: "eng", local: false };
}

let tessWorker: Promise<{ worker: Worker; lang: string }> | null = null;
async function getTesseract(): Promise<{ worker: Worker; lang: string }> {
  if (!tessWorker) {
    tessWorker = (async () => {
      const { lang, local } = mrzLanguage();
      const w = await createWorker(lang, 1, {
        cachePath: tessdataDir(),
        // A locally-provided model is read straight from the tessdata dir (uncompressed);
        // otherwise tesseract.js fetches + caches the standard gzip'd traineddata.
        ...(local ? { langPath: tessdataDir(), gzip: false } : {}),
        logger: () => {},
        // Without a handler a failed job THROWS inside the worker's message listener, which no
        // caller can catch — it took the whole process down (2026-10-23). With one, the job's
        // own promise rejects and the reader below sets the model aside.
        errorHandler: (e: unknown) => console.warn(`[identity-ocr] tesseract (${lang}) failed:`, String(e).slice(0, 200)),
      });
      await w.setParameters({
        tessedit_char_whitelist: MRZ_WHITELIST,
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
      });
      return { worker: w, lang };
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
  if (w) await (await w).worker.terminate().catch(() => {});
}

/** OCR an image with the strip reader; a failing model is set aside and the read retried once. */
async function recogniseStrip(png: Buffer): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getTesseract();
    try {
      const { data } = await t.worker.recognize(png);
      return data.text ?? "";
    } catch (err) {
      failedLangs.add(t.lang);
      tessWorker = null;
      await t.worker.terminate().catch(() => {});
      console.warn(`[identity-ocr] the ${t.lang} model could not read — using ${mrzLanguage().lang} from now on:`, err instanceof Error ? err.message : String(err).slice(0, 200));
      if (t.lang === "eng") break;
    }
  }
  return "";
}

/**
 * The image every stage reads (2026-10-23): EXIF-rotated and capped at 2400 px on its long edge.
 * A phone photo arrives at 12 MP; decoding it afresh for the QR, the strip and the text passes
 * cost seconds each, and none of them reads better above this size.
 */
async function workingCopy(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function stripPng(img: sharp.Sharp, threshold: boolean): Promise<Buffer> {
  let p = img.resize({ width: 1800, withoutEnlargement: false }).grayscale().normalise().sharpen();
  if (threshold) p = p.threshold(150);
  return p.png().toBuffer();
}

async function preprocessForMrz(work: Buffer, region: "bottom" | "full"): Promise<Buffer> {
  const img = sharp(work, { failOn: "none" });
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (region === "bottom" && w > 0 && h > 0) {
    const top = Math.floor(h * 0.55);
    return stripPng(img.extract({ left: 0, top, width: w, height: h - top }), true);
  }
  return stripPng(img, true);
}

/** The strip read off the image: the strict parse when it holds, and the raw lines either way. */
async function readStrip(png: Buffer): Promise<{ parsed: IdentityExtraction | null; lines: string[] }> {
  const text = await recogniseStrip(png);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const mrz = extractMrzLines(text);
  const parsed = mrz ? parseMrzLines(mrz) : null;
  // The strict parser also answers for a strip it misread (found: "BE1120452" for T1204522) —
  // it counts only when a check digit proved the number or the date of birth.
  const proven = parsed && (parsed.fieldConfidence.documentNumber === "VERIFIED" || parsed.fieldConfidence.dateOfBirth === "VERIFIED");
  return { parsed: proven ? parsed : null, lines };
}

/** OCR the MRZ off the image; returns the parsed extraction or null. */
export async function readMrzFromImage(bytes: Buffer): Promise<IdentityExtraction | null> {
  const work = await workingCopy(bytes);
  for (const region of ["bottom", "full"] as const) {
    const r = await readStrip(await preprocessForMrz(work, region));
    if (r.parsed) return r.parsed;
  }
  return null;
}

/**
 * A close read of the strip where the layout engine found it (2026-10-23). Florence-2 reads the
 * whole page at 768 px, so the strip's small characters come back garbled — but it says WHERE
 * the strip is. That region, cut from the working copy and enlarged, is what OCR-B reads well.
 */
async function readStripAt(work: Buffer, boxes: Array<[number, number, number, number]>): Promise<{ parsed: IdentityExtraction | null; lines: string[] }> {
  const meta = await sharp(work).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H || !boxes.length) return { parsed: null, lines: [] };
  // The layout engine read the copy fitted inside 1600 px (`rawRgbForOcr`); its boxes are in that frame.
  const scale = Math.min(1, 1600 / W, 1600 / H);
  const x0 = Math.min(...boxes.map((b) => b[0])) / scale;
  const y0 = Math.min(...boxes.map((b) => b[1])) / scale;
  const x1 = Math.max(...boxes.map((b) => b[2])) / scale;
  const y1 = Math.max(...boxes.map((b) => b[3])) / scale;
  const padX = (x1 - x0) * 0.04;
  const padY = Math.max((y1 - y0) * 0.35, 12);
  const left = Math.max(0, Math.floor(x0 - padX));
  const top = Math.max(0, Math.floor(y0 - padY));
  const width = Math.min(W - left, Math.ceil(x1 - x0 + 2 * padX));
  const height = Math.min(H - top, Math.ceil(y1 - y0 + 2 * padY));
  if (width < 40 || height < 12) return { parsed: null, lines: [] };
  const lines: string[] = [];
  for (const threshold of [false, true]) {
    const png = await stripPng(sharp(work).extract({ left, top, width, height }), threshold);
    const r = await readStrip(png);
    if (r.parsed) return { parsed: r.parsed, lines: r.lines };
    lines.push(...r.lines);
  }
  return { parsed: null, lines };
}

/** Where a reading has got to — the desk draws it (2026-10-23). */
export type ReadStage = "QR" | "STRIP" | "TEXT";

/** Layer extractions: earlier ones win field by field; a VERIFIED value always beats a READ one. */
function mergeExtractions(source: string, ...xs: Array<IdentityExtraction | null | undefined>): IdentityExtraction | null {
  const fields: IdentityExtraction["fields"] = {};
  const conf: IdentityExtraction["fieldConfidence"] = {};
  for (const pass of ["VERIFIED", "READ"] as const) {
    for (const x of xs) {
      if (!x) continue;
      for (const [k, v] of Object.entries(x.fields) as Array<[keyof IdentityExtraction["fields"], string | undefined]>) {
        if (!v || fields[k]) continue;
        const c = x.fieldConfidence[k] ?? "READ";
        if (pass === "VERIFIED" && c !== "VERIFIED") continue;
        fields[k] = v;
        conf[k] = c;
      }
    }
  }
  if (!Object.keys(fields).length) return null;
  const firstRaw = xs.find((x) => x)?.raw ?? {};
  return { fields, fieldConfidence: conf, raw: { ...firstRaw, source }, empty: false };
}

/**
 * Run the whole server pipeline over the stored bytes: QR (exact) → the strip (OCR-B, check
 * digits) → the page's text (Florence-2), then a close read of the strip where the text pass
 * found it, the passport reader over every strip-like line, and the label-anchored parse of the
 * page (CID / voter card / birth certificate / work permit, READ only). `kindHint` is the
 * document type the desk row or the phone already names. `onStage` hears each stage begin.
 */
export async function extractIdentityFromImage(
  bytes: Buffer,
  opts: { kindHint?: LayoutDocKind; onStage?: (stage: ReadStage) => void | Promise<void> } = {},
): Promise<ServerExtractionResult> {
  const work = await workingCopy(bytes);
  await opts.onStage?.("QR");
  const qrText = await decodeQrFromImage(work);
  let genericQr: ReturnType<typeof parseGenericQrText> = null;
  if (qrText) {
    // Aadhaar's QR is the whole record — nothing more to read. Any OTHER ID's QR usually
    // carries less than the printed face (a number, a verify URL), so hold what it yields
    // and keep going: the layout pass reads the printed labels and the two MERGE below.
    const aadhaar = parseAadhaarQrText(qrText);
    if (aadhaar && !aadhaar.empty) return { engine: "SERVER_QR", extraction: aadhaar };
    genericQr = parseGenericQrText(qrText);
  }
  await opts.onStage?.("STRIP");
  const bottom = await readStrip(await preprocessForMrz(work, "bottom"));
  // A clean strip with every field proven — but its names are still checked against the page below.
  const bottomComplete = bottom.parsed && bottom.parsed.fieldConfidence.documentNumber === "VERIFIED" && bottom.parsed.fieldConfidence.dateOfBirth === "VERIFIED";
  if (bottomComplete && bottom.parsed) return { engine: "SERVER_MRZ", extraction: bottom.parsed };
  await opts.onStage?.("TEXT");
  const layout = await layoutOcr(work);
  const lines = layout?.lines ?? [];
  const texts = lines.map((l) => l.text);
  const stripBoxes = lines.filter((l) => l.box && looksLikeStrip(l.text)).map((l) => l.box!);
  const close = stripBoxes.length ? await readStripAt(work, stripBoxes) : { parsed: bottom.parsed, lines: [] as string[] };
  const kind = detectLayoutDocKind(texts.join("\n")) ?? opts.kindHint ?? null;
  const passport = readPassportFromText([...close.lines, ...bottom.lines], texts, { isPassport: kind === "PASSPORT" || !!close.parsed });
  const layoutParsed = texts.length ? parseLayoutText(texts, opts.kindHint ?? null) : null;
  const via = layout ? ` via ${layout.engine} (${layout.ms} ms)` : "";
  if (close.parsed) {
    // The strip read cleanly at its own spot: its check digits stand; the page adds the rest.
    // Names matched against the printed page beat the strip's own spelling of them.
    const strict = passport?.fields.fullName
      ? { ...close.parsed, fields: { ...close.parsed.fields, fullName: undefined } }
      : close.parsed;
    const merged = mergeExtractions(`${close.parsed.raw.source ?? "MRZ"} (strip located${via})`, strict, passport, layoutParsed);
    if (merged) return { engine: "SERVER_MRZ", extraction: { ...merged, raw: { ...merged.raw, mrzLines: close.parsed.raw.mrzLines, ocrLines: texts.slice(0, 60) } } };
  }
  const fromStrip = !!passport && Object.values(passport.fieldConfidence).includes("VERIFIED");
  const parsed = mergeExtractions(`${passport ? passport.raw.source : layoutParsed?.raw.source ?? "LAYOUT"}${via}`, passport, layoutParsed);
  if (parsed) {
    // QR values beat OCR values on overlap (an exact decode has no character errors) —
    // except the document TYPE, which the QR payload almost never names.
    if (genericQr && !genericQr.empty) {
      const { documentType: _ignored, ...qrFields } = genericQr.fields;
      parsed.fields = { ...parsed.fields, ...qrFields };
      for (const k of Object.keys(qrFields) as (keyof typeof qrFields)[]) parsed.fieldConfidence[k] = "READ";
      parsed.raw = { ...parsed.raw, qrText: genericQr.raw.qrText, source: `${parsed.raw.source} + ${genericQr.raw.source}` };
    }
    parsed.raw = { ...parsed.raw, mrzLines: passport?.raw.mrzLines, ocrLines: texts.slice(0, 60) };
    return { engine: fromStrip ? "SERVER_MRZ" : "SERVER_LAYOUT", extraction: parsed };
  }
  // No readable layout — a generic QR alone is still worth suggesting.
  if (genericQr && !genericQr.empty) return { engine: "SERVER_QR", extraction: genericQr };
  return null;
}
