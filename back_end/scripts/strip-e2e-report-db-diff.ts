import * as fs from "node:fs";
import * as path from "node:path";

type Mode = "KEEP" | "SKIP_DB_BLOCK";

function main() {
  const repoRoot = path.resolve(process.cwd(), "..");
  const relIn = process.argv[2] ?? path.join("Documentation_V2", "E2E-basic-s1-to-s9-test-report.md");
  const inPath = path.isAbsolute(relIn) ? relIn : path.join(repoRoot, relIn);
  const relOut =
    process.argv[3] ??
    (() => {
      if (inPath.toLowerCase().endsWith(".md")) return inPath.slice(0, -3) + ".no-db.md";
      return inPath + ".no-db.md";
    })();
  const outPath = path.isAbsolute(relOut) ? relOut : path.join(repoRoot, relOut);

  const input = fs.readFileSync(inPath, "utf8");
  const lines = input.split(/\r?\n/);

  const out: string[] = [];
  let mode: Mode = "KEEP";
  let fenceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (mode === "KEEP") {
      if (line.trim() === "- **DB changes (diff of snapshots)**:") {
        mode = "SKIP_DB_BLOCK";
        fenceDepth = 0;
        continue;
      }
      out.push(line);
      continue;
    }

    // SKIP_DB_BLOCK: skip the marker, the blank line, and the following ```json ... ``` fence block.
    if (line.trim().startsWith("```")) {
      fenceDepth++;
      continue;
    }

    if (fenceDepth >= 2) {
      // fence opened and closed; now skip trailing blank lines until the next content.
      if (line.trim() === "") continue;
      mode = "KEEP";
      out.push(line);
      continue;
    }

    // still inside the fenced JSON content; skip
  }

  fs.writeFileSync(outPath, out.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main();

