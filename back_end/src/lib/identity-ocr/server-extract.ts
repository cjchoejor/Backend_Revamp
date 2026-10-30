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

/**
 * One strip read at a time (2026-10-23). Two photos are read side by side now, and the page
 * segmentation is a setting on the one shared worker: without this, one photo's "one line" could
 * be applied to the other's block read between its setting and its read.
 */
let stripQueue: Promise<unknown> = Promise.resolve();
function recogniseStrip(png: Buffer, psm: PSM = PSM.SINGLE_BLOCK): Promise<string> {
  const run = stripQueue.then(() => recogniseStripNow(png, psm));
  stripQueue = run.catch(() => {});
  return run;
}

/** OCR an image with the strip reader; a failing model is set aside and the read retried once. */
async function recogniseStripNow(png: Buffer, psm: PSM): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getTesseract();
    try {
      await t.worker.setParameters({ tessedit_pageseg_mode: psm });
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
  // Already upright and small enough (the phone sends 1800 px): the photo itself — re-encoding it
  // changed enough pixels for Florence-2 to miss the printed number on one photo and read it on another.
  const meta = await sharp(bytes, { failOn: "none" }).metadata();
  if ((meta.orientation ?? 1) === 1 && (meta.width ?? 0) <= 2400 && (meta.height ?? 0) <= 2400 && meta.format === "jpeg") return bytes;
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

async function preprocessForMrz(work: Buffer, region: "bottom" | "full", from = 0.55, threshold = true): Promise<Buffer> {
  const img = sharp(work, { failOn: "none" });
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (region === "bottom" && w > 0 && h > 0) {
    const top = Math.floor(h * from);
    return stripPng(img.extract({ left: 0, top, width: w, height: h - top }), threshold);
  }
  return stripPng(img, threshold);
}

/**
 * The foot of the page, cropped tighter first (2026-10-29, operator: "it is really slow — 30 s to a
 * minute"). A passport photographed whole has its strip in the last fifth; read alone, without the
 * page's other print, it comes back nearly clean in a third of a second, where the bottom half read
 * as one block came back as noise and sent the photo to the page reader (20 s and more). Each crop
 * is tried in turn and the first strip its check digits prove wins.
 */
const STRIP_CROPS: Array<{ from: number; threshold: boolean }> = [
  { from: 0.82, threshold: false },
  { from: 0.72, threshold: false },
  { from: 0.55, threshold: false },
  { from: 0.55, threshold: true },
];
async function readFootStrip(work: Buffer): Promise<{ parsed: IdentityExtraction | null; lines: string[]; complete: boolean }> {
  const lines: string[] = [];
  let best: IdentityExtraction | null = null;
  for (const c of STRIP_CROPS) {
    const r = await readStrip(await preprocessForMrz(work, "bottom", c.from, c.threshold));
    lines.push(...r.lines);
    if (!r.parsed) continue;
    const complete = r.parsed.fieldConfidence.documentNumber === "VERIFIED" && r.parsed.fieldConfidence.dateOfBirth === "VERIFIED";
    if (complete) return { parsed: r.parsed, lines, complete: true };
    best ??= r.parsed;
  }
  return { parsed: best, lines, complete: false };
}

/** The strip read off the image: the strict parse when it holds, and the raw lines either way. */
async function readStrip(png: Buffer, psm: PSM = PSM.SINGLE_BLOCK): Promise<{ parsed: IdentityExtraction | null; lines: string[] }> {
  const text = await recogniseStrip(png, psm);
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
  const foot = await readFootStrip(work);
  if (foot.parsed) return foot.parsed;
  return (await readStrip(await preprocessForMrz(work, "full"))).parsed;
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
  // Line by line (2026-10-23): on a blurred photo the block read came back as noise while each line
  // read alone gave the strip nearly whole. Three treatments, since each misreads different letters.
  const rows: string[][] = [];
  for (const b of [...boxes].sort((p, q) => p[1] - q[1])) {
    const ly0 = b[1] / scale;
    const ly1 = b[3] / scale;
    const lpad = Math.max((ly1 - ly0) * 0.3, 6);
    const lt = Math.max(0, Math.floor(ly0 - lpad));
    const lh = Math.min(H - lt, Math.ceil(ly1 - ly0 + 2 * lpad));
    if (lh < 8) continue;
    const reads: string[] = [];
    for (const treat of LINE_TREATMENTS) {
      const png = await treat(sharp(work).extract({ left, top: lt, width, height: lh })).png().toBuffer();
      const text = (await recogniseStrip(png, PSM.SINGLE_LINE)).replace(/\s+/g, " ").trim();
      if (text) reads.push(text);
    }
    rows.push(reads);
    lines.push(...reads);
  }
  // Every pairing of a first-line read with a second-line read, through the strict parser.
  if (rows.length >= 2) {
    for (const a of rows[rows.length - 2]) {
      for (const b of rows[rows.length - 1]) {
        const mrz = extractMrzLines(`${a}\n${b}`);
        const parsed = mrz ? parseMrzLines(mrz) : null;
        if (parsed && parsed.fieldConfidence.documentNumber === "VERIFIED" && parsed.fieldConfidence.dateOfBirth === "VERIFIED") return { parsed, lines };
      }
    }
  }
  return { parsed: null, lines };
}

/**
 * The text pass over the whole page (2026-10-23). Florence-2 writes at most 768 tokens, and a long
 * run of misread script (a passport's Hindi labels) can use them all up: on one photo it stopped
 * after the surname, and the given name, the dates and the strip were never read. When its lines
 * end well above the foot of the page, the rest is read on its own and joined on, its boxes put back
 * into the first pass's frame.
 */
async function layoutWholePage(work: Buffer): Promise<Awaited<ReturnType<typeof layoutOcr>>> {
  const first = await layoutOcr(work);
  if (!first || !first.lines.length) return first;
  const meta = await sharp(work).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return first;
  const scale = Math.min(1, 1600 / W, 1600 / H);
  const reached = Math.max(...first.lines.map((l) => l.box?.[3] ?? 0));
  if (reached >= H * scale * 0.8) return first;
  const top = Math.max(0, Math.floor(reached / scale) - 20);
  if (H - top < 60) return first;
  const crop = await sharp(work).extract({ left: 0, top, width: W, height: H - top }).jpeg({ quality: 92 }).toBuffer();
  const rest = await layoutOcr(crop);
  if (!rest?.lines.length) return first;
  const cropScale = Math.min(1, 1600 / W, 1600 / (H - top));
  const back = (b: [number, number, number, number]): [number, number, number, number] => [
    (b[0] / cropScale) * scale,
    (b[1] / cropScale + top) * scale,
    (b[2] / cropScale) * scale,
    (b[3] / cropScale + top) * scale,
  ];
  return { engine: first.engine, lines: [...first.lines, ...rest.lines.map((l) => ({ text: l.text, box: l.box ? back(l.box) : undefined }))], ms: first.ms + rest.ms };
}

/** How a single strip line is prepared for tesseract — each misreads different characters. */
const LINE_TREATMENTS: Array<(img: sharp.Sharp) => sharp.Sharp> = [
  (i) => i.resize({ width: 1200 }).grayscale().normalise(),
  (i) => i.resize({ width: 1800 }).grayscale().median(3).normalise(),
  (i) => i.resize({ width: 1800 }).grayscale().normalise(),
];

/**
 * The page above the strip, read again at twice the detail (2026-10-23): Florence-2 reads the whole
 * page at 768 px, and on one photo it missed the passport number printed at the top — clear to a
 * person. Run only for a passport whose number is still not proven.
 */
async function readPageAbove(work: Buffer, lines: Array<{ box?: [number, number, number, number] }>, stripTop: number | null): Promise<string[]> {
  const meta = await sharp(work).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const boxes = lines.map((l) => l.box).filter((b): b is [number, number, number, number] => !!b && (stripTop == null || b[3] <= stripTop));
  if (!W || !H || boxes.length < 3) return [];
  const scale = Math.min(1, 1600 / W, 1600 / H);
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b[0])) / scale) - 10);
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b[1])) / scale) - 10);
  const x1 = Math.min(W, Math.ceil(Math.max(...boxes.map((b) => b[2])) / scale) + 10);
  const y1 = Math.min(H, Math.ceil(Math.max(...boxes.map((b) => b[3])) / scale) + 10);
  // The upper half of that area, where the type, the code and the number print.
  const h = Math.floor((y1 - y0) / 2);
  if (x1 - x0 < 100 || h < 60) return [];
  const crop = await sharp(work).extract({ left: x0, top: y0, width: x1 - x0, height: h }).jpeg({ quality: 92 }).toBuffer();
  const r = await layoutOcr(crop);
  return (r?.lines ?? []).map((l) => l.text);
}

/**
 * The strip's boxes: the LOWEST strip-like line and its neighbours within a couple of line heights
 * — the two lines of a passport's strip sit together at the foot of the page, and a stray line
 * higher up must not stretch the crop over the whole page.
 */
function stripRegion(lines: Array<{ text: string; box?: [number, number, number, number] }>): Array<[number, number, number, number]> {
  const hits = lines.filter((l) => l.box && looksLikeStrip(l.text)).map((l) => l.box!);
  if (!hits.length) return [];
  hits.sort((a, b) => b[3] - a[3]);
  const lowest = hits[0];
  const h = Math.max(8, lowest[3] - lowest[1]);
  return hits.filter((b) => lowest[1] - b[3] <= h * 2.5);
}

/**
 * The numbers printed on the page, read with the strip reader (2026-10-29) — for a strip cut short
 * at its left edge, whose own copy of the number is gone. The strip's reader reads the bold print
 * of "10602591" in about a second where the page reader missed it. Eight-character tokens with at
 * least six digits; the strip's check digit then says which, if any, is the number.
 */
async function readPageNumbers(work: Buffer): Promise<string[]> {
  const meta = await sharp(work).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return [];
  const top = Math.floor(H * 0.25);
  const png = await sharp(work)
    .extract({ left: 0, top, width: W, height: Math.floor(H * 0.88) - top })
    .resize({ width: 2000 })
    .grayscale()
    .normalise()
    .png()
    .toBuffer();
  const text = await recogniseStrip(png, PSM.SPARSE_TEXT);
  return [...new Set([...text.matchAll(/[A-Z0-9]{8}/g)].map((m) => m[0]).filter((t) => (t.match(/\d/g)?.length ?? 0) >= 6))];
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
  // A document the desk already names as one without a strip (a CID, a voter card, a birth
  // certificate, a work permit) goes straight to the page reader (2026-10-29) — the strip's crops
  // cost seconds and find nothing on it.
  const noStrip = !!opts.kindHint && opts.kindHint !== "PASSPORT";
  if (!noStrip) await opts.onStage?.("STRIP");
  const bottom = noStrip ? { parsed: null, lines: [] as string[], complete: false } : await readFootStrip(work);
  // A strip with its number and birth date proven by their check digits is the whole passport —
  // the names, the nationality, the sex and the expiry are on it too. No page reader is needed.
  if (bottom.complete && bottom.parsed) return { engine: "SERVER_MRZ", extraction: bottom.parsed };
  // A strip read in part — cut at its left edge, or a line the strict parse could not take — can
  // still be the whole passport without the page reader (2026-10-29): the dates from the second
  // line, the names from the first, and the number printed on the page proven by the strip's
  // check digit. Only when that falls short does the page reader run.
  if (!noStrip && bottom.lines.length) {
    let quick = readPassportFromText(bottom.lines, [], { isPassport: true });
    const datesProven = quick?.fieldConfidence.dateOfBirth === "VERIFIED" && quick?.fieldConfidence.expiryDate === "VERIFIED";
    if (quick && datesProven && quick.fieldConfidence.documentNumber !== "VERIFIED") {
      const numbers = await readPageNumbers(work);
      if (numbers.length) quick = readPassportFromText(bottom.lines, numbers, { isPassport: true }) ?? quick;
    }
    if (quick && datesProven && quick.fieldConfidence.documentNumber === "VERIFIED" && quick.fields.fullName) {
      const merged = mergeExtractions(`${quick.raw.source} · page number`, quick, bottom.parsed);
      if (merged) return { engine: "SERVER_MRZ", extraction: { ...merged, raw: { ...merged.raw, mrzLines: quick.raw.mrzLines } } };
    }
  }
  await opts.onStage?.("TEXT");
  const layout = await layoutWholePage(work);
  const lines = layout?.lines ?? [];
  const texts = lines.map((l) => l.text);
  const stripBoxes = stripRegion(lines);
  const close = stripBoxes.length ? await readStripAt(work, stripBoxes) : { parsed: bottom.parsed, lines: [] as string[] };
  const kind = detectLayoutDocKind(texts.join("\n")) ?? opts.kindHint ?? null;
  let passport = readPassportFromText([...close.lines, ...bottom.lines], texts, { isPassport: kind === "PASSPORT" || !!close.parsed });
  const numberProven = close.parsed?.fieldConfidence.documentNumber === "VERIFIED" || passport?.fieldConfidence.documentNumber === "VERIFIED";
  if (passport && !numberProven) {
    const stripTop = stripBoxes.length ? Math.min(...stripBoxes.map((b) => b[1])) : null;
    const above = await readPageAbove(work, lines, stripTop);
    if (above.length) passport = readPassportFromText([...close.lines, ...bottom.lines], [...texts, ...above], { isPassport: true }) ?? passport;
  }
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
  // The strip's own reading of the names, nationality and sex counts here too (2026-10-29): the first
  // line can read cleanly while the second does not, and its names were dropped on this path.
  const parsed = mergeExtractions(`${passport ? passport.raw.source : layoutParsed?.raw.source ?? "LAYOUT"}${via}`, passport, bottom.parsed, layoutParsed);
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
