/**
 * Runs S8 HTTP acceptance tests against a **temporary** API instance (no manual `npm start`).
 * Uses GET /api/health for readiness; default port **4010** to avoid clashing with a dev server on 4000.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = process.env.TEST_API_PORT ?? "4010";
const baseUrl = `http://127.0.0.1:${port}/api`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForApiReady(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for test API at ${baseUrl}/health (45s). Set TEST_API_PORT if the port is in use.`,
  );
}

function killProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    throw new Error(`Missing ${tsxCli} — run npm install in back_end`);
  }

  const server = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: root,
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

  server.on("error", (err) => {
    console.error("Failed to spawn API server:", err);
  });

  try {
    await waitForApiReady();

    const code = await new Promise<number>((resolve, reject) => {
      const test = spawn(process.execPath, [tsxCli, "scripts/s8-acceptance-tests.ts"], {
        cwd: root,
        env: { ...process.env, API_BASE_URL: baseUrl },
        stdio: "inherit",
      });
      test.on("error", reject);
      test.on("exit", (c) => resolve(c ?? 1));
    });

    if (code !== 0) {
      if (serverLog.trim()) console.error("\n--- API server log (tail) ---\n", serverLog.slice(-6000));
      process.exit(code);
    }
  } catch (e) {
    if (serverLog.trim()) console.error("\n--- API server log (tail) ---\n", serverLog.slice(-6000));
    throw e;
  } finally {
    killProcessTree(server);
    await sleep(400);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
