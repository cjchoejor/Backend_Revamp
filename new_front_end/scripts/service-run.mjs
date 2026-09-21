/**
 * Service entrypoint for the desk — what the Windows service actually runs.
 *
 * Serves the PRODUCTION build (`next start`), not the dev server: after a power cut nobody is
 * at the keyboard to notice a page taking two seconds to compile, and dev mode also holds a
 * file watcher open for no reason on a machine that is only serving.
 *
 * That means `.next` must exist. A missing or half-written build is reported here, loudly and
 * once, instead of letting `next start` fail with a stack trace inside a service log nobody
 * reads — so after every `git pull` the drill is: `npm run build`, then restart the service.
 *
 * It waits for the backend's own health endpoint first. The desk is useless without the API,
 * and on a cold boot the backend is still waiting for Postgres; starting in order means the
 * first person to open the page gets a working screen rather than a wall of failed requests.
 * The wait is deliberately NOT fatal — if the backend never comes up, the desk still serves and
 * shows its own error states, which is more use than no site at all.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocalPort } from "./resolve-port.mjs";

const FRONT_END = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_HEALTH = process.env.BACKEND_URL
  ? `${process.env.BACKEND_URL.replace(/\/$/, "")}/api/health`
  : "http://127.0.0.1:4000/api/health";

const API_WAIT_TIMEOUT_MS = 3 * 60_000;
const API_RETRY_DELAY_MS = 3_000;

const stamp = () => new Date().toISOString();
const log = (msg) => console.log(`${stamp()} [service] ${msg}`);
const fail = (msg) => console.error(`${stamp()} [service] ${msg}`);

function assertBuildPresent() {
  const buildId = path.join(FRONT_END, ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    throw new Error(
      "no production build found (.next/BUILD_ID is missing). Run `npm run build` in new_front_end, then start the service again.",
    );
  }
  return readFileSync(buildId, "utf8").trim();
}

/** Best-effort: give the backend a head start, but never refuse to serve because of it. */
async function waitForBackend() {
  const deadline = Date.now() + API_WAIT_TIMEOUT_MS;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch(BACKEND_HEALTH, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        log(`backend answered after ${attempt} attempt(s)`);
        return true;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) {
      fail("backend did not answer in time — serving the desk anyway; its screens will show their own errors");
      return false;
    }
    if (attempt === 1 || attempt % 5 === 0) log(`waiting for the backend at ${BACKEND_HEALTH}`);
    await new Promise((r) => setTimeout(r, API_RETRY_DELAY_MS));
  }
}

async function main() {
  const buildId = assertBuildPresent();
  const port = resolveLocalPort();
  log(`desk service starting · build ${buildId} · port ${port}`);

  await waitForBackend();

  const child = spawn(
    process.execPath,
    [path.join(FRONT_END, "node_modules", "next", "dist", "bin", "next"), "start", "-p", port, "-H", "0.0.0.0"],
    { cwd: FRONT_END, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
  );

  const forward = (signal) => () => { if (!child.killed) child.kill(signal); };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));

  child.on("exit", (code, signal) => {
    fail(`desk exited (code ${code}, signal ${signal ?? "none"}) — the service wrapper will restart it`);
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    fail(`could not start the desk: ${err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  fail(err?.message ?? String(err));
  process.exit(1);
});
