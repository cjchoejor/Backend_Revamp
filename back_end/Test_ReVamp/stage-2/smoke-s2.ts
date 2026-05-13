import { spawnSync } from "node:child_process";
import { BACK_END_ROOT } from "../lib/report.js";
import { runDbSeed, withTemporaryTestApi } from "../lib/test-api-harness.js";

async function go() {
  runDbSeed();
  await withTemporaryTestApi("4019", (apiBaseUrl) => {
    const r = spawnSync("npx", ["tsx", "scripts/s2-acceptance-tests.ts"], {
      cwd: BACK_END_ROOT,
      shell: true,
      encoding: "utf8",
      maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, API_BASE_URL: apiBaseUrl },
    });
    console.log("s2 exit", r.status);
    if (r.stderr) console.error("stderr", r.stderr.slice(0, 2000));
    if (r.stdout) console.log("stdout tail", r.stdout.slice(-1500));
  });
}

go().catch((e) => {
  console.error(e);
  process.exit(1);
});
