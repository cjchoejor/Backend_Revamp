import { spawn } from "node:child_process";
import os from "node:os";
import { resolveLocalPort } from "./resolve-port.mjs";

const PORT = resolveLocalPort();
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";

async function checkBackend() {
  try {
    const r = await fetch(`${BACKEND_URL.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function collectLanIpv4() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue;
    for (const addr of iface) {
      if ((addr.family === "IPv4" || addr.family === 4) && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return [...new Set(ips)];
}

const lanIps = collectLanIpv4();

console.log("");
console.log("  LEGPHEL PMS — dev server");
console.log(`  Local:   http://localhost:${PORT}`);
if (lanIps.length > 0) {
  for (const ip of lanIps) {
    console.log(`  Network: http://${ip}:${PORT}  (phone / other devices on Wi‑Fi)`);
  }
} else {
  console.log("  Network: (no LAN IPv4 detected — Wi‑Fi off?)");
}
console.log("");
console.log("  Do NOT open http://0.0.0.0:" + PORT + " — that is bind-only, not a real browser URL.");
console.log("");
console.log("  Other devices cannot connect?");
console.log("    • Easiest: npm run dev:all  (starts API + this server)");
console.log("    • Or: back_end → npm run dev, then this script");
console.log("    • Boss URL: http://<Network-IP-above>:" + PORT);
console.log("    • Test API:  http://localhost:" + PORT + "/api/dev/connectivity");
console.log("");

const apiUp = await checkBackend();
if (!apiUp) {
  console.log("  ⚠ API not reachable at " + BACKEND_URL);
  console.log("    Start:  cd back_end && npm run dev");
  console.log("    Or use: npm run dev:all\n");
} else {
  console.log("  ✓ API reachable at " + BACKEND_URL + "\n");
}

const child = spawn("npx", ["next", "dev", "-H", "0.0.0.0", "-p", PORT], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NEXT_DEV_PORT: PORT, BACKEND_URL },
});

child.on("exit", (code) => process.exit(code ?? 0));
