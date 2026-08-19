/**
 * Fetch the OCR-B tesseract model used to read passport MRZs (2026-08-18).
 *
 * The generic `eng` model confuses the MRZ filler `<` with K/L; OCR-B is the MRZ typeface.
 * Drops `ocrb.traineddata` into the backend tessdata dir (server-side W39 extraction) and,
 * uncompressed, into `front_end/public/tessdata/` (on-phone extraction on the capture page).
 * Both locations are gitignored — run this once per machine. Re-run to refresh.
 *
 *   npx tsx scripts/fetch-ocrb-traineddata.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const URL = "https://github.com/Shreeshrii/tessdata_ocrb/raw/master/ocrb.traineddata";
const targets = [
  process.env.OCR_TESSDATA_DIR ?? "./storage/tessdata",
  path.resolve("../front_end/public/tessdata"),
];
const res = await fetch(URL);
if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ocrb.traineddata");
  writeFileSync(file, bytes);
  console.log(`wrote ${file} (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
