/**
 * Stage 7 (S7) — seeds DB, temporary API, `scripts/s7-acceptance-tests.ts`, reads `Documentation/S7-test-output.json`, splits `results[]`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BACK_END_ROOT } from "../lib/report.js";
import { defaultTestApiPort, runDbSeed, withTemporaryTestApi } from "../lib/test-api-harness.js";
import { writePerCaseScenarioReports, type LooseCase } from "../lib/split-acceptance-results.js";

const REF = "LEGPHEL_Implementation_Reference_v1_1.html#s7-deep · Layer 03c (S7 live stay)";
const OUT_JSON = path.join(BACK_END_ROOT, "..", "Documentation", "S7-test-output.json");

async function main() {
  runDbSeed();
  const port = defaultTestApiPort();
  await withTemporaryTestApi(port, async (apiBaseUrl) => {
    const r = spawnSync("npx", ["tsx", "scripts/s7-acceptance-tests.ts"], {
      cwd: BACK_END_ROOT,
      shell: true,
      encoding: "utf8",
      maxBuffer: 48 * 1024 * 1024,
      env: { ...process.env, API_BASE_URL: apiBaseUrl },
    });
    if (r.stderr) process.stderr.write(r.stderr);
    if (!fs.existsSync(OUT_JSON)) throw new Error(`Missing ${OUT_JSON} after s7 run`);
    const raw = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as { baseUrl?: string; results?: LooseCase[] };
    const results = raw.results ?? [];
    writePerCaseScenarioReports(7, "S7", REF, apiBaseUrl, true, results);
    if (r.status !== 0 || results.some((x) => !x.pass)) process.exitCode = 1;
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
