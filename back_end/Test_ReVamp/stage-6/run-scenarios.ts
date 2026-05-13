/**
 * Stage 6 (S6) — seeds DB, temporary API, `scripts/s6-acceptance-tests.ts` (JSON stdout), splits `results[]`.
 */
import { spawnSync } from "node:child_process";
import { BACK_END_ROOT } from "../lib/report.js";
import { defaultTestApiPort, runDbSeed, withTemporaryTestApi } from "../lib/test-api-harness.js";
import { parseJsonStdout, writePerCaseScenarioReports, type LooseCase } from "../lib/split-acceptance-results.js";

const REF = "LEGPHEL_Implementation_Reference_v1_1.html#s6-deep · Layer 03b (S6 check-in)";

async function main() {
  runDbSeed();
  const port = defaultTestApiPort();
  await withTemporaryTestApi(port, async (apiBaseUrl) => {
    const r = spawnSync("npx", ["tsx", "scripts/s6-acceptance-tests.ts"], {
      cwd: BACK_END_ROOT,
      shell: true,
      encoding: "utf8",
      maxBuffer: 48 * 1024 * 1024,
      env: { ...process.env, API_BASE_URL: apiBaseUrl },
    });
    if (r.stderr) process.stderr.write(r.stderr);
    const out = parseJsonStdout(r.stdout ?? "") as { baseUrl?: string; results?: LooseCase[] };
    const results = out.results ?? [];
    writePerCaseScenarioReports(6, "S6", REF, apiBaseUrl, true, results);
    if (r.status !== 0 || results.some((x) => !x.pass)) process.exitCode = 1;
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
