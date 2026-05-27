/**
 * Start API + LAN front-end together (demo / boss on Wi‑Fi).
 * Usage: npm run dev:all   (from front_end)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontRoot = path.resolve(__dirname, "..");
const backRoot = path.resolve(frontRoot, "..", "back_end");
const BACKEND = "http://127.0.0.1:4000";

async function isBackendUp() {
  try {
    const r = await fetch(`${BACKEND}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForBackend(maxMs = 45_000) {
  const url = `${BACKEND}/api/health`;
  const start = Date.now();
  process.stdout.write("  Starting API on 127.0.0.1:4000");
  while (Date.now() - start < maxMs) {
    if (await isBackendUp()) {
      console.log(" — OK\n");
      return true;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 600));
  }
  console.log("\n  API did not start in time. Check back_end for errors.\n");
  return false;
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
  } catch {
    child.kill("SIGTERM");
  }
}

console.log("\n  LEGPHEL PMS — dev:all (API + front-end for LAN demo)\n");

let back = null;
let weStartedBack = false;

if (await isBackendUp()) {
  console.log("  ✓ API already running on port 4000 (using existing process)\n");
} else {
  back = spawn("npm", ["run", "dev"], {
    cwd: backRoot,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, HOST: "0.0.0.0" },
  });
  weStartedBack = true;
  if (!(await waitForBackend())) {
    killTree(back);
    process.exit(1);
  }
}

let front = spawn("npm", ["run", "dev:lan"], {
  cwd: frontRoot,
  shell: true,
  stdio: "inherit",
  env: { ...process.env, BACKEND_URL: BACKEND },
});

const shutdown = () => {
  killTree(front);
  if (weStartedBack) killTree(back);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

front.on("exit", (code) => {
  if (weStartedBack) killTree(back);
  process.exit(code ?? 0);
});
