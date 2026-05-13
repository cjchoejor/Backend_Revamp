/**
 * Stage 2 (S2) — seeds DB, starts a temporary API, runs `scripts/s2-acceptance-tests.ts`,
 * then splits `Documentation_V2/S2-test-output.json` into one JSON report per step.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BACK_END_ROOT } from "../lib/report.js";
import { defaultTestApiPort, runDbSeed, withTemporaryTestApi } from "../lib/test-api-harness.js";
import { writePerCaseScenarioReports, type LooseCase } from "../lib/split-acceptance-results.js";

const REF = "LEGPHEL_Implementation_Reference_v1_1.html#s2-deep · Layer 03a (S2 negotiation & quotation)";
const OUT_JSON = path.join(BACK_END_ROOT, "..", "Documentation_V2", "S2-test-output.json");

async function main() {
  runDbSeed();

  const port = defaultTestApiPort();
  await withTemporaryTestApi(port, async (apiBaseUrl) => {
    const r = spawnSync("npx", ["tsx", "scripts/s2-acceptance-tests.ts"], {
      cwd: BACK_END_ROOT,
      shell: true,
      encoding: "utf8",
      maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, API_BASE_URL: apiBaseUrl },
    });
    if (r.stderr) process.stderr.write(r.stderr);

    if (!fs.existsSync(OUT_JSON)) {
      throw new Error(`Expected ${OUT_JSON} after s2 acceptance run.`);
    }
    const raw = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as { baseUrl?: string; steps?: LooseCase[] };
    const steps = raw.steps ?? [];
    writePerCaseScenarioReports(2, "S2", REF, apiBaseUrl, true, steps);

    const anyFail = steps.some((s) => !s.pass);
    if (r.status !== 0 || anyFail) {
      process.exitCode = 1;
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
