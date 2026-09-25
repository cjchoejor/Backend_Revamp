/**
 * Service entrypoint for the backend — what the Windows service actually runs.
 *
 * WHY THIS EXISTS, rather than pointing the service straight at the server
 * ----------------------------------------------------------------------
 * On this machine the power goes out and comes back, and every Automatic service starts at
 * once. Postgres takes several seconds to finish recovery, and during that window it ACCEPTS
 * TCP connections while answering "the database system is starting up". A server that opens its
 * pool in that window throws, the wrapper restarts it a few times, exhausts its restart budget
 * and the service is left Stopped until somebody notices — which is exactly how ProductionAPI
 * (the sibling service in C:\Users\DELL\Documents\intern) died with exit code 1067 in the
 * 2026-09-21 outage, while HotelAPI survived only because its retries happened to cover it.
 *
 * So the service depends on the Postgres SERVICE (that gets the ordering roughly right) and
 * this script waits for the database to actually answer a query before starting anything. A
 * service dependency alone is not enough: Windows considers a service "started" the moment it
 * reports running, which for Postgres is before recovery finishes.
 *
 * It runs `tsx src/index.ts` — deliberately NOT `node dist/index.js`. This project is edited
 * and pulled most days; a dist build would serve whatever was last compiled, so a pull followed
 * by a power cut would quietly bring the OLD code back up. Running the source means a restart
 * always serves what is on disk. `npm run build` + `node dist/index.js` is the faster, more
 * conventional choice once the code settles down — swap RUNNER below.
 *
 * Nothing here is specific to the service manager: `node scripts/service-run.mjs` behaves
 * identically from a terminal, which is how it should be tested.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const BACK_END = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(BACK_END, "package.json"));

/** How long to keep waiting for Postgres before giving up and letting the wrapper retry. */
const DB_WAIT_TIMEOUT_MS = 5 * 60_000;
const DB_RETRY_DELAY_MS = 3_000;

const stamp = () => new Date().toISOString();
const log = (msg) => console.log(`${stamp()} [service] ${msg}`);
const fail = (msg) => console.error(`${stamp()} [service] ${msg}`);

/**
 * Read DATABASE_URL out of .env without pulling in dotenv — the value contains an unencoded
 * '@' in the password, so it is taken verbatim to the end of the line rather than parsed.
 */
function databaseUrlFromEnv() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const raw = readFileSync(path.join(BACK_END, ".env"), "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL is not set and was not found in back_end/.env");
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

/** Resolve when the database answers a query — not merely when the port opens. */
async function waitForDatabase(connectionString) {
  const { Client } = require("pg");
  const deadline = Date.now() + DB_WAIT_TIMEOUT_MS;
  let attempt = 0;
  let lastError = "";

  for (;;) {
    attempt++;
    const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      log(`database ready after ${attempt} attempt(s)`);
      return;
    } catch (err) {
      lastError = err?.message ?? String(err);
      try { await client.end(); } catch { /* the connection never opened */ }
    }
    if (Date.now() >= deadline) {
      throw new Error(`database not ready after ${Math.round(DB_WAIT_TIMEOUT_MS / 1000)}s — last error: ${lastError}`);
    }
    if (attempt === 1 || attempt % 5 === 0) log(`waiting for the database (${lastError})`);
    await new Promise((r) => setTimeout(r, DB_RETRY_DELAY_MS));
  }
}

/**
 * Where Puppeteer's browser actually lives — the service cannot find it on its own.
 *
 * Every PDF this system produces (confirmation voucher, quotation, proforma, tax invoice) is
 * rendered by `chrome-headless-shell`, which `npm install` downloads into the INSTALLING USER's
 * cache (`C:\Users\<name>\.cache\puppeteer`). A Windows service runs as LocalSystem, whose home
 * is `C:\WINDOWS\system32\config\systemprofile` — an empty cache. So under the service every
 * render failed with "Could not find chrome-headless-shell", the mails went out with no
 * attachment, and the only trace of it was `…_PDF_RENDER_FAILED` on the booking.
 *
 * The browser is 525 MB, so it is found rather than copied: an explicit `PUPPETEER_CACHE_DIR`
 * wins, then a cache kept beside the repo, then the first user profile that actually holds the
 * browser. Returns null when there is none, and the server starts anyway — a hotel that cannot
 * print a voucher still has to take bookings.
 */
function puppeteerCacheDir() {
  if (process.env.PUPPETEER_CACHE_DIR) return process.env.PUPPETEER_CACHE_DIR;
  const holdsBrowser = (dir) => { try { return existsSync(path.join(dir, "chrome-headless-shell")); } catch { return false; } };

  const beside = path.join(BACK_END, ".puppeteer");
  if (holdsBrowser(beside)) return beside;

  const users = path.join(process.env.SystemDrive ?? "C:", "\\", "Users");
  try {
    for (const name of readdirSync(users)) {
      const cache = path.join(users, name, ".cache", "puppeteer");
      if (holdsBrowser(cache)) return cache;
    }
  } catch { /* unreadable — fall through */ }
  return null;
}

/** `tsx src/index.ts`, with workers on. See the note above about dist. */
const RUNNER = {
  command: process.execPath,
  args: [path.join(BACK_END, "node_modules", "tsx", "dist", "cli.mjs"), path.join(BACK_END, "src", "index.ts")],
};

async function main() {
  log(`backend service starting · cwd ${BACK_END}`);
  const connectionString = databaseUrlFromEnv();
  const dbName = connectionString.replace(/^.*\//, "").replace(/\?.*$/, "");
  log(`database: ${dbName}`);

  await waitForDatabase(connectionString);

  const browserCache = puppeteerCacheDir();
  if (browserCache) log(`pdf browser cache: ${browserCache}`);
  else log(`pdf browser NOT found — PDFs will fail to render; run: npx puppeteer browsers install chrome-headless-shell`);

  const child = spawn(RUNNER.command, RUNNER.args, {
    cwd: BACK_END,
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_WORKERS: "true",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ...(browserCache ? { PUPPETEER_CACHE_DIR: browserCache } : {}),
    },
  });

  // The wrapper stops the service by signalling THIS process; pass it on so the server closes
  // its pg-boss queue and HTTP listener instead of being killed outright.
  const forward = (signal) => () => { if (!child.killed) child.kill(signal); };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));

  child.on("exit", (code, signal) => {
    fail(`backend exited (code ${code}, signal ${signal ?? "none"}) — the service wrapper will restart it`);
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    fail(`could not start the backend: ${err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  fail(err?.message ?? String(err));
  process.exit(1);
});
