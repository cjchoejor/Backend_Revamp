import fs from "node:fs";
import path from "node:path";

function readIfExists(p: string) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function main() {
  const repoRoot = path.resolve(process.cwd(), "..");
  const outDir = path.join(repoRoot, "Documentation_V2", "test");
  ensureDir(outDir);

  const workerReportPath = path.join(repoRoot, "Documentation_V2", "test", "realtime-worker-timer-test-report.ALL.md");
  const e2eReportPath = path.join(repoRoot, "Documentation_V2", "E2E-S1-to-S9-test-report.md");

  const workerReport = readIfExists(workerReportPath);
  const e2eReport = readIfExists(e2eReportPath);

  const outPath = path.join(outDir, "Worker_test.md");

  const lines: string[] = [];
  lines.push("# Worker_test");
  lines.push("");
  lines.push(`- **Generated at**: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Inputs used");
  lines.push("");
  lines.push(`- **Worker realtime suite**: \`${workerReportPath}\``);
  lines.push(`- **S1→S9 E2E API suite**: \`${e2eReportPath}\``);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("- This report combines:");
  lines.push("  - a **realtime pg-boss worker execution** validation (seconds-scale, ≤5 minutes), and");
  lines.push("  - an **S1→S9 API lifecycle** run that exercises the business flow.");
  lines.push("");

  lines.push("## Section A — Realtime worker execution suite (ALL)");
  lines.push("");
  lines.push(workerReport ?? "_Missing worker realtime report file; ensure `scripts/realtime-worker-timer-test-all.ts` ran successfully._");
  lines.push("");

  lines.push("## Section B — S1→S9 E2E API run");
  lines.push("");
  lines.push(e2eReport ?? "_Missing E2E report file; ensure `scripts/e2e-s1-to-s9.ts` ran successfully against a running API server._");
  lines.push("");

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

