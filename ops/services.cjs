/**
 * The two service definitions, in one place so install, uninstall and status cannot disagree
 * about what a service is called or what it runs.
 *
 * Modelled on the HotelAPI service already on this machine (node-windows, which wraps WinSW):
 * same wrapper, same `daemon\` folder of rotating logs, same Automatic start. Two differences,
 * both deliberate and both aimed at the failure that left ProductionAPI Stopped after the
 * 2026-09-21 outage:
 *
 *   1. `dependencies` — Windows starts Postgres before either service. Necessary, not
 *      sufficient: "started" for Postgres means the service reported running, which happens
 *      before crash recovery finishes. The real wait lives in each service-run.mjs.
 *
 *   2. `maxRestarts` is raised well above node-windows' default of 3. ProductionAPI died by
 *      spending all three restarts inside the window where Postgres was still recovering.
 *      With the readiness wait in front, a restart now means something is genuinely wrong —
 *      but on a machine nobody is watching, retrying for longer is the friendlier failure.
 */
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");

/** The Postgres instance back_end/.env points at (port 5432, the default install). */
const POSTGRES_SERVICE = "postgresql-x64-16";

const SERVICES = [
  {
    key: "backend",
    name: "LegphelPMS Backend",
    description:
      "LEGPHEL PMS — backend API and background workers (port 4000). Waits for PostgreSQL to finish starting before it runs.",
    script: path.join(REPO, "back_end", "scripts", "service-run.mjs"),
    workingDirectory: path.join(REPO, "back_end"),
    dependencies: [POSTGRES_SERVICE],
  },
  {
    key: "desk",
    name: "LegphelPMS Desk",
    description:
      "LEGPHEL PMS — the front-desk web app, production build (port 3002). Waits for the backend before it serves.",
    script: path.join(REPO, "new_front_end", "scripts", "service-run.mjs"),
    workingDirectory: path.join(REPO, "new_front_end"),
    dependencies: [POSTGRES_SERVICE],
  },
];

/** Restart policy — see the note above about ProductionAPI. */
const RESTART_POLICY = {
  maxRestarts: 40, // node-windows default is 3
  wait: 5, // seconds before the first retry
  grow: 0.25, // back off gradually
  abortOnError: false,
};

function buildService(def) {
  // Required lazily: `node-windows` is only needed by the scripts that touch the service
  // control manager, and requiring it here would make `status` fail before it can explain
  // that dependencies are not installed.
  const { Service } = require("node-windows");
  return new Service({
    name: def.name,
    description: def.description,
    script: def.script,
    workingDirectory: def.workingDirectory,
    dependencies: def.dependencies,
    ...RESTART_POLICY,
  });
}

module.exports = { SERVICES, POSTGRES_SERVICE, RESTART_POLICY, buildService, REPO };
