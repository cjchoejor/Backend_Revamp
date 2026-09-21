/**
 * Remove both services. Administrator terminal, same as install.
 *
 *   node uninstall-services.cjs
 *
 * Stops each service first. The daemon\ log folders are left on disk deliberately — the reason
 * a service was removed is usually in them.
 */
const { execFileSync } = require("node:child_process");
const { SERVICES, buildService } = require("./services.cjs");

function isAdministrator() {
  try {
    execFileSync("net", ["session"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function uninstallOne(def) {
  return new Promise((resolve) => {
    const svc = buildService(def);
    let settled = false;
    const done = (msg) => {
      if (settled) return;
      settled = true;
      console.log(msg);
      resolve();
    };

    svc.on("uninstall", () => done(`  - "${def.name}" removed`));
    svc.on("alreadyuninstalled", () => done(`  = "${def.name}" was not registered`));
    svc.on("stop", () => svc.uninstall());
    svc.on("error", (err) => done(`  ! "${def.name}": ${err?.message ?? err}`));

    // `uninstall` on a running service is unreliable, so stop first; if it is already stopped
    // node-windows emits nothing, hence the fallback.
    svc.stop();
    setTimeout(() => { if (!settled) svc.uninstall(); }, 4_000);
    setTimeout(() => done(`  ? "${def.name}" — no response; check services.msc`), 30_000);
  });
}

async function main() {
  if (!isAdministrator()) {
    console.error("This must be run from an Administrator PowerShell.");
    process.exit(1);
  }
  console.log("Removing services:\n");
  for (const def of SERVICES) {
    await uninstallOne(def);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
