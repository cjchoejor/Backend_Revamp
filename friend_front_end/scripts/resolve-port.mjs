import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontEndRoot = resolve(scriptsDir, "..");

/**
 * Resolve the dev/start port for THIS machine, without ever baking it into a
 * tracked file. Precedence:
 *   1. process.env.PORT / NEXT_DEV_PORT   (shell / CI override)
 *   2. PORT=… in the git-ignored front_end/.env.local  (per-machine choice)
 *   3. 3001                                (committed team default)
 *
 * This keeps package.json machine-independent, so pushing/pulling never
 * changes anyone's local port.
 */
export function resolveLocalPort() {
  const fromEnv = process.env.PORT ?? process.env.NEXT_DEV_PORT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  try {
    const envLocal = readFileSync(resolve(frontEndRoot, ".env.local"), "utf8");
    const match = envLocal.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (match) return match[1];
  } catch {
    // no .env.local — fall through to the default
  }

  return "3001";
}
