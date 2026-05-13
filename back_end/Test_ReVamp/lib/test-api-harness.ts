/**
 * Spins up a temporary Express API (no workers) for acceptance scripts that need HTTP.
 * Default port **4010** to avoid clashing with a dev server on 4000.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { BACK_END_ROOT } from "./report.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function runDbSeed(): void {
  const r = spawnSync("npm", ["run", "db:seed"], { cwd: BACK_END_ROOT, shell: true, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`db:seed failed with exit code ${r.status ?? "unknown"}`);
}

function killProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

async function waitForApiHealth(apiBaseUrl: string, timeoutMs = 60_000): Promise<void> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not listening */
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${base}/health (${timeoutMs}ms).`);
}

/**
 * @param port — host port (not including `/api`)
 * @param fn — receives e.g. `http://127.0.0.1:4010/api`
 */
export async function withTemporaryTestApi<T>(port: string, fn: (apiBaseUrl: string) => Promise<T>): Promise<T> {
  const apiBaseUrl = `http://127.0.0.1:${port}/api`;
  const tsxCli = path.join(BACK_END_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    throw new Error(`Missing ${tsxCli} — run npm install in back_end`);
  }

  const server = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: BACK_END_ROOT,
    env: { ...process.env, PORT: port, RUN_WORKERS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLog = "";
  server.stdout?.on("data", (d: Buffer) => {
    serverLog += d.toString();
  });
  server.stderr?.on("data", (d: Buffer) => {
    serverLog += d.toString();
  });

  try {
    await waitForApiHealth(apiBaseUrl);
    return await fn(apiBaseUrl);
  } catch (e) {
    if (serverLog.trim()) {
      process.stderr.write("\n--- Test API server log (tail) ---\n");
      process.stderr.write(serverLog.slice(-8000));
      process.stderr.write("\n");
    }
    throw e;
  } finally {
    killProcessTree(server);
    await sleep(400);
  }
}

export function defaultTestApiPort(): string {
  return process.env.TEST_API_PORT ?? "4010";
}
