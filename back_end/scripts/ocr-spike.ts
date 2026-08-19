/**
 * Phase B spike (docs/id-proof-capture-and-ocr.md §2.3) — how well does the layout OCR read
 * REAL document photos? Runs the full server pipeline (QR → MRZ → Florence-2 layout OCR +
 * label anchoring) over a folder of images and prints, per file, the engine that answered,
 * the fields it produced, and the OCR lines the parser saw — so the yes/no on shipping CID
 * extraction is made on numbers, not hope.
 *
 *   npx tsx scripts/ocr-spike.ts <folder-or-file> [--tesseract] [--json out.json]
 *
 * Defaults to the identity-proof photos in the document store. `--tesseract` forces the
 * tesseract page fallback so the two engines can be compared on the same photos. Nothing
 * is written to the database; nothing leaves the machine.
 *
 * Read the tally at the bottom: the plan's threshold is "at least 5 of 10 usable fields on
 * real CID photos", else CID stays manual (rule §2.3.3).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractIdentityFromImage, shutdownIdentityOcr } from "../src/lib/identity-ocr/server-extract.js";
import { layoutEngineChoice, shutdownLayoutOcr } from "../src/lib/identity-ocr/layout-ocr.js";

const args = process.argv.slice(2);
const forceTesseract = args.includes("--tesseract");
if (forceTesseract) process.env.OCR_LAYOUT_ENGINE = "tesseract";
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const target = args.find((a) => !a.startsWith("--") && a !== jsonOut) ?? "./storage/documents";

function collect(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return [p];
  const out: string[] = [];
  for (const f of readdirSync(p)) {
    const full = path.join(p, f);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...collect(full));
    else if (/\.(jpe?g|png|webp)$/i.test(f) && /identity-proof|cid|id-photos|spike/i.test(full)) out.push(full);
  }
  return out;
}

const files = collect(target);
console.log(`Layout engine: ${layoutEngineChoice()} · ${files.length} image(s) under ${target}\n`);
const results: Array<{ file: string; engine: string | null; fields: Record<string, string>; ms: number; ocrLines?: string[] }> = [];
for (const f of files) {
  const t0 = Date.now();
  try {
    const r = await extractIdentityFromImage(readFileSync(f));
    const ms = Date.now() - t0;
    const fields = (r?.extraction.fields ?? {}) as Record<string, string>;
    results.push({ file: f, engine: r?.engine ?? null, fields, ms, ocrLines: r?.extraction.raw.ocrLines });
    console.log(`${path.basename(f)}  →  ${r?.engine ?? "nothing"}  (${ms} ms)`);
    for (const [k, v] of Object.entries(fields)) console.log(`    ${k.padEnd(20)} ${v}   [${r?.extraction.fieldConfidence[k as keyof typeof r.extraction.fieldConfidence]}]`);
    if (r?.extraction.raw.ocrLines?.length) {
      console.log(`    — OCR lines (${r.extraction.raw.ocrLines.length}):`);
      for (const l of r.extraction.raw.ocrLines.slice(0, 12)) console.log(`      | ${l}`);
    }
  } catch (err) {
    console.log(`${path.basename(f)}  →  ERROR ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    results.push({ file: f, engine: "ERROR", fields: {}, ms: Date.now() - t0 });
  }
}

const usable = (r: (typeof results)[number]) => ["documentNumber", "fullName", "dateOfBirth"].filter((k) => r.fields[k]).length;
const layoutRuns = results.filter((r) => r.engine === "SERVER_LAYOUT" || (r.engine === null && r.ocrLines));
console.log(`\n=== Tally ===`);
console.log(`files: ${results.length} · answered: ${results.filter((r) => r.engine && r.engine !== "ERROR").length} · by engine: ${JSON.stringify(Object.fromEntries(Object.entries(results.reduce<Record<string, number>>((m, r) => ((m[r.engine ?? "none"] = (m[r.engine ?? "none"] ?? 0) + 1), m), {}))))}`);
console.log(`layout pass: ${layoutRuns.length} file(s); with ≥2 of (number, name, DOB): ${layoutRuns.filter((r) => usable(r) >= 2).length}; all three: ${layoutRuns.filter((r) => usable(r) === 3).length}`);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  console.log(`written ${jsonOut}`);
}
await shutdownIdentityOcr();
shutdownLayoutOcr();
