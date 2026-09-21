/**
 * Register both services with Windows. Must be run from an ADMINISTRATOR terminal —
 * registering a service is a privileged operation and there is no way around that.
 *
 *   cd ops
 *   npm install          (once)
 *   node install-services.cjs
 *
 * Idempotent: a service that already exists is left alone rather than re-registered, so this
 * is safe to re-run. To change a definition, uninstall first.
 *
 * Installing also STARTS each service, which will fail if the ports are already taken by a dev
 * server — so stop `npm run dev:workers` / `npm run start:lan` before running this.
 */
const { execFileSync } = require("node:child_process");
const { SERVICES, POSTGRES_SERVICE, buildService } = require("./services.cjs");

function isAdministrator() {
  try {
    execFileSync("net", ["session"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function serviceExists(displayName) {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `if (Get-Service -DisplayName '${displayName}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`],
      { encoding: "utf8" },
    );
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

function postgresIsPresent() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `if (Get-Service -Name '${POSTGRES_SERVICE}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`],
      { encoding: "utf8" },
    );
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

async function installOne(def) {
  return new Promise((resolve) => {
    if (serviceExists(def.name)) {
      console.log(`  = "${def.name}" is already registered — leaving it alone`);
      return resolve(false);
    }
    const svc = buildService(def);
    svc.on("install", () => {
      console.log(`  + "${def.name}" registered — starting it`);
      svc.start();
    });
    svc.on("alreadyinstalled", () => {
      console.log(`  = "${def.name}" is already registered — leaving it alone`);
      resolve(false);
    });
    svc.on("start", () => {
      console.log(`  ✓ "${def.name}" started`);
      resolve(true);
    });
    svc.on("error", (err) => {
      console.error(`  ! "${def.name}" failed: ${err?.message ?? err}`);
      resolve(false);
    });
    svc.install();
  });
}

async function main() {
  if (!isAdministrator()) {
    console.error("This must be run from an Administrator PowerShell — registering a Windows service needs elevation.");
    console.error("Right-click PowerShell → Run as administrator, then:");
    console.error(`  cd "${require("node:path").resolve(__dirname)}"`);
    console.error("  node install-services.cjs");
    process.exit(1);
  }

  if (!postgresIsPresent()) {
    console.error(`The Postgres service "${POSTGRES_SERVICE}" was not found.`);
    console.error("Both services declare it as a dependency; fix the name in services.cjs before installing.");
    process.exit(1);
  }

  console.log(`Registering ${SERVICES.length} service(s), each depending on ${POSTGRES_SERVICE}:\n`);
  for (const def of SERVICES) {
    await installOne(def);
  }

  console.log("\nDone. Check them with:  node status.cjs");
  console.log("Logs are written next to each service-run.mjs, in its own daemon\\ folder.");
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
