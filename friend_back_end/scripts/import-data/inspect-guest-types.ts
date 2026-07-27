import { readFileSync } from "node:fs";
import path from "node:path";

function parse(line: string): string[] {
  const o: string[] = []; let c = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else { if (ch === ",") { o.push(c); c = ""; } else if (ch === '"') q = true; else c += ch; }
  }
  o.push(c); return o;
}

const fp = path.resolve("scripts/import-data/legacy-bookings/customer_inquiry.csv");
const lines = readFileSync(fp, "utf-8").split(/\r?\n/).filter((l) => l.trim() !== "");
const h = parse(lines[0]);
const idx = Object.fromEntries(h.map((n, i) => [n, i]));

const counts: Record<string, Record<string, number>> = {};
for (const line of lines.slice(1)) {
  const c = parse(line);
  const gt = (c[idx.guest_type] || "").trim() || "(empty)";
  const gd = (c[idx.guest_type_detail] || "").trim() || "(empty)";
  if (!counts[gt]) counts[gt] = {};
  counts[gt][gd] = (counts[gt][gd] || 0) + 1;
}

for (const gt of Object.keys(counts)) {
  const total = Object.values(counts[gt]).reduce((s, n) => s + n, 0);
  console.log(`\nguest_type="${gt}"  (${total} rows)`);
  for (const [gd, n] of Object.entries(counts[gt]).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(3)}x  "${gd}"`);
  }
}
