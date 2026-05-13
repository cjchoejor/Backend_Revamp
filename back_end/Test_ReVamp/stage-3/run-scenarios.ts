/**
 * Stage 3 (S3) — seeds DB, temporary API, `scripts/s3-acceptance-tests.ts`, then splits `Documentation_V2/S3-test-output.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BACK_END_ROOT } from "../lib/report.js";
import { defaultTestApiPort, runDbSeed, withTemporaryTestApi } from "../lib/test-api-harness.js";
import { writePerCaseScenarioReports, type LooseCase } from "../lib/split-acceptance-results.js";

const REF = "LEGPHEL_Implementation_Reference_v1_1.html#s3-deep · Layer 03a (S3 reservation setup)";
const OUT_JSON = path.join(BACK_END_ROOT, "..", "Documentation_V2", "S3-test-output.json");

async function main() {
  runDbSeed();
  const port = defaultTestApiPort();
  await withTemporaryTestApi(port, async (apiBaseUrl) => {
    const r = spawnSync("npx", ["tsx", "scripts/s3-acceptance-tests.ts"], {
      cwd: BACK_END_ROOT,
      shell: true,
      encoding: "utf8",
      maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, API_BASE_URL: apiBaseUrl },
    });
    if (r.stderr) process.stderr.write(r.stderr);
    if (!fs.existsSync(OUT_JSON)) throw new Error(`Missing ${OUT_JSON} after s3 run`);
    const raw = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as { baseUrl?: string; steps?: LooseCase[] };
    const steps = raw.steps ?? [];
    writePerCaseScenarioReports(3, "S3", REF, apiBaseUrl, true, steps);
    if (r.status !== 0 || steps.some((s) => !s.pass)) process.exitCode = 1;
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
