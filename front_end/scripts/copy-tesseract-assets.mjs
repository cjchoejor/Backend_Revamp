// Copy tesseract.js's browser worker + WASM core into public/ so the phone capture page can
// read passport MRZs ON THE PHONE without reaching a CDN (2026-08-18). Runs on postinstall;
// safe to re-run. The OCR-B language model itself comes from
// back_end/scripts/fetch-ocrb-traineddata.ts (11 MB, fetched per machine, gitignored).
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const nm = path.join(root, "node_modules");
const targets = [
  { from: path.join(nm, "tesseract.js", "dist"), to: path.join(root, "public", "tesseract"), only: (f) => f === "worker.min.js" },
  { from: path.join(nm, "tesseract.js-core"), to: path.join(root, "public", "tesseract-core"), only: (f) => /^tesseract-core.*\.(js|wasm)$/.test(f) },
];
for (const t of targets) {
  if (!existsSync(t.from)) {
    console.warn(`[tesseract-assets] ${t.from} not found — skipping`);
    continue;
  }
  mkdirSync(t.to, { recursive: true });
  let n = 0;
  for (const f of readdirSync(t.from)) {
    if (!t.only(f)) continue;
    copyFileSync(path.join(t.from, f), path.join(t.to, f));
    n += 1;
  }
  console.log(`[tesseract-assets] ${n} file(s) → ${path.relative(root, t.to)}`);
}
