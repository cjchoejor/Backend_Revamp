import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveLocalPort } from "./resolve-port.mjs";

/**
 * Launch `next <subcommand>` on the machine-local port (see resolve-port.mjs),
 * passing through any extra flags. Invokes the local next binary directly with
 * the current node executable so it works cross-platform (no npx / .cmd / shell
 * quirks).
 *
 * Usage: node scripts/with-port.mjs dev [extra next flags...]
 */
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontEndRoot = resolve(scriptsDir, "..");

const [subcommand, ...extra] = process.argv.slice(2);
if (!subcommand) {
  console.error("with-port.mjs: missing next subcommand (dev | start | build)");
  process.exit(1);
}

const port = resolveLocalPort();
const nextBin = resolve(frontEndRoot, "node_modules/next/dist/bin/next");

const child = spawn(process.execPath, [nextBin, subcommand, "-p", port, ...extra], {
  stdio: "inherit",
  cwd: frontEndRoot,
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
