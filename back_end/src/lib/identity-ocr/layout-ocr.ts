/**
 * Phase B — layout OCR of documents with no MRZ / QR (2026-08-18).
 *
 * Engine: **Florence-2** (`onnx-community/Florence-2-base-ft`, ~0.23 B params) through
 * transformers.js + onnxruntime-node, task `<OCR_WITH_REGION>` — returns text regions with
 * quad boxes; we sort them into reading order and hand the lines to `layout-parse.ts`. It
 * reads a rotated phone photo of a card well (probe 2026-08-18: a 4032×3024 receipt shot,
 * rotated 90°, came back with every line right — 4.3 s on a 16-core CPU) and is an order of
 * magnitude lighter than a VLM. Runs LOCALLY — the model (~800 MB) is downloaded ONCE into
 * `OCR_MODELS_DIR` (default ./storage/models) and served from there; nothing leaves the
 * server. Load takes a couple of seconds warm, minutes on the very first (download) run.
 *
 * Fallback: when the model can't load (offline first run, `OCR_LAYOUT_ENGINE=tesseract`),
 * tesseract's generic `eng` model reads the whole page — noticeably worse on photographed
 * cards, but the label-anchored parser still gets a chance.
 *
 * Deliberately CPU-only, one image at a time (the W39 worker runs at concurrency 1), and
 * loaded lazily so the API process never pays for it.
 */
import sharp from "sharp";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork, type ChildProcess } from "node:child_process";

export type LayoutOcrLine = { text: string; box?: [number, number, number, number] };
export type LayoutOcrResult = { engine: "FLORENCE2" | "TESSERACT"; lines: LayoutOcrLine[]; ms: number };

const MODEL_ID = "onnx-community/Florence-2-base-ft";

function modelsDir(): string {
  return process.env.OCR_MODELS_DIR ?? "./storage/models";
}

/** Whether Florence-2 is already on disk (so a first run offline won't try to download). */
export function florenceModelCached(): boolean {
  return existsSync(path.join(modelsDir(), MODEL_ID.replace("/", "--"))) || existsSync(path.join(modelsDir(), MODEL_ID));
}

export function layoutEngineChoice(): "florence2" | "tesseract" | "off" {
  const v = process.env.OCR_LAYOUT_ENGINE?.trim().toLowerCase();
  if (v === "off" || v === "none") return "off";
  if (v === "tesseract") return "tesseract";
  return "florence2";
}

type Florence = {
  model: any;
  processor: any;
  tokenizer: any;
  RawImage: any;
};
let florence: Promise<Florence> | null = null;

async function getFlorence(): Promise<Florence> {
  if (!florence) {
    florence = (async () => {
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = modelsDir();
      // fp32 vision encoder + embeddings: the fp16 variants fail to initialise on CPU
      // onnxruntime ("InsertedPrecisionFreeCast … does not exist"); q4 text side keeps it light.
      const model = await tf.Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
        dtype: { embed_tokens: "fp32", vision_encoder: "fp32", encoder_model: "q4", decoder_model_merged: "q4" },
        device: "cpu",
      } as any);
      const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID);
      const tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL_ID);
      return { model, processor, tokenizer, RawImage: tf.RawImage };
    })();
    florence.catch(() => {
      florence = null;
    });
  }
  return florence;
}

/** Sort regions into reading order: by row (quad top), then left → right. */
function orderRegions(labels: string[], quads: number[][]): LayoutOcrLine[] {
  const rows = labels.map((text, i) => {
    const q = quads[i] ?? [];
    const xs = [q[0], q[2], q[4], q[6]].filter((n) => Number.isFinite(n)) as number[];
    const ys = [q[1], q[3], q[5], q[7]].filter((n) => Number.isFinite(n)) as number[];
    const x0 = xs.length ? Math.min(...xs) : 0;
    const y0 = ys.length ? Math.min(...ys) : i;
    const x1 = xs.length ? Math.max(...xs) : 0;
    const y1 = ys.length ? Math.max(...ys) : i;
    return { text: text.trim(), box: [x0, y0, x1, y1] as [number, number, number, number], cy: (y0 + y1) / 2, h: Math.max(1, y1 - y0) };
  });
  rows.sort((a, b) => {
    // Same visual row when centres are within half a line height.
    if (Math.abs(a.cy - b.cy) < Math.min(a.h, b.h) * 0.5) return a.box[0] - b.box[0];
    return a.cy - b.cy;
  });
  return rows.filter((r) => r.text).map(({ text, box }) => ({ text, box }));
}

/** EXIF-rotated, long edge capped (Florence resizes to 768² internally anyway), raw RGB. */
async function rawRgbForOcr(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function ocrWithFlorence(bytes: Buffer): Promise<LayoutOcrLine[]> {
  const f = await getFlorence();
  // Build the RawImage from OUR sharp's pixels — transformers.js's own decode path
  // (`RawImage.fromBlob`) trips over the nested sharp/vips version here ("colourspace:
  // parameter space not set"); raw RGB sidesteps it entirely.
  const rgb = await rawRgbForOcr(bytes);
  const image = new f.RawImage(new Uint8ClampedArray(rgb.data.buffer, rgb.data.byteOffset, rgb.data.byteLength), rgb.width, rgb.height, 3);
  const task = "<OCR_WITH_REGION>";
  const prompts = f.processor.construct_prompts(task);
  const textInputs = f.tokenizer(prompts);
  const visionInputs = await f.processor(image);
  const generated = await f.model.generate({ ...textInputs, ...visionInputs, max_new_tokens: 768 });
  const decoded = f.tokenizer.batch_decode(generated, { skip_special_tokens: false })[0];
  const result = f.processor.post_process_generation(decoded, task, image.size);
  const r = result?.[task] ?? { labels: [], quad_boxes: [] };
  return orderRegions(r.labels ?? [], r.quad_boxes ?? []);
}

/** Whole-page tesseract (generic `eng`), used only as the fallback engine. */
export async function ocrWithTesseractPage(bytes: Buffer): Promise<LayoutOcrLine[]> {
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, { cachePath: process.env.OCR_TESSDATA_DIR ?? "./storage/tessdata", logger: () => {} });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const png = await sharp(bytes, { failOn: "none" }).rotate().resize({ width: 2000, withoutEnlargement: false }).grayscale().normalise().png().toBuffer();
    const { data } = await worker.recognize(png);
    return (data.text ?? "")
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text) => ({ text }));
  } finally {
    await worker.terminate().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------
// Process isolation: the model runs in a forked child (`layout-ocr-child.ts`), lazily
// started, killed after IDLE_MS, restarted on the next photo. `OCR_LAYOUT_INPROCESS=true`
// runs it in this process instead (the spike script, tests).
// ---------------------------------------------------------------------------------------
const IDLE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 180_000;
type Pending = { resolve: (lines: LayoutOcrLine[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
let child: ChildProcess | null = null;
let childReady: Promise<void> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function childScriptPath(): string {
  // Sibling of this module; the extension follows however this module itself was loaded
  // (.ts under tsx, .js when compiled).
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), path.basename(here).endsWith(".ts") ? "layout-ocr-child.ts" : "layout-ocr-child.js");
}

function stopChild(reason: string): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const c = child;
  child = null;
  childReady = null;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(`layout OCR child ${reason}`));
    pending.delete(id);
  }
  if (c && !c.killed) c.kill();
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stopChild("idle — released"), IDLE_MS);
  idleTimer.unref?.();
}

async function ensureChild(): Promise<ChildProcess> {
  if (child && childReady) {
    await childReady;
    return child;
  }
  const c = fork(childScriptPath(), [], {
    // Inherit the tsx loader flags when the parent runs under tsx; nothing when compiled.
    execArgv: process.execArgv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, OCR_LAYOUT_INPROCESS: "true" },
  });
  child = c;
  childReady = new Promise<void>((resolve, reject) => {
    const onMsg = (m: any) => {
      if (m?.ready) {
        c.off("message", onMsg);
        resolve();
      }
    };
    c.on("message", onMsg);
    c.once("exit", () => reject(new Error("layout OCR child exited before ready")));
  });
  c.on("message", (m: any) => {
    if (typeof m?.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(String(m.error)));
    else p.resolve((m.lines ?? []) as LayoutOcrLine[]);
  });
  c.on("exit", (code, signal) => {
    if (child === c) stopChild(`exited (${code ?? signal})`);
  });
  await childReady;
  return c;
}

async function ocrInChild(bytes: Buffer, engine: "florence2" | "tesseract"): Promise<LayoutOcrLine[]> {
  const c = await ensureChild();
  touchIdle();
  const id = ++seq;
  return new Promise<LayoutOcrLine[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      stopChild("timed out");
      reject(new Error("layout OCR timed out"));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    c.send({ id, bytesB64: bytes.toString("base64"), engine });
  });
}

/** Stop the child (graceful shutdown / tests). */
export function shutdownLayoutOcr(): void {
  stopChild("shut down");
}

/** Run the configured layout engine; null when switched off. */
export async function layoutOcr(bytes: Buffer): Promise<LayoutOcrResult | null> {
  const choice = layoutEngineChoice();
  if (choice === "off") return null;
  const inProcess = process.env.OCR_LAYOUT_INPROCESS === "true";
  const run = (engine: "florence2" | "tesseract") =>
    inProcess ? (engine === "florence2" ? ocrWithFlorence(bytes) : ocrWithTesseractPage(bytes)) : ocrInChild(bytes, engine);
  const t0 = Date.now();
  if (choice === "florence2") {
    try {
      const lines = await run("florence2");
      return { engine: "FLORENCE2", lines, ms: Date.now() - t0 };
    } catch (err) {
      console.warn("[identity-ocr] Florence-2 unavailable, falling back to tesseract:", err instanceof Error ? err.message.slice(0, 200) : err);
    }
  }
  const lines = await run("tesseract");
  return { engine: "TESSERACT", lines, ms: Date.now() - t0 };
}
