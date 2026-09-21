/**
 * What the services are doing right now — safe to run from an ordinary terminal.
 *
 *   node status.cjs
 *
 * Reports each service's state and start mode, whether its port is actually listening (a
 * service can read "Running" while the app inside it has crashed — the wrapper stays up), and
 * the last line of its error log, which is usually the whole story after a bad restart.
 */
const { execFileSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const { SERVICES, POSTGRES_SERVICE } = require("./services.cjs");

const PORTS = { backend: 4000, desk: 3002 };

function ps(command) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function serviceState(displayName) {
  const out = ps(
    `$s = Get-Service -DisplayName '${displayName}' -ErrorAction SilentlyContinue; ` +
      `if ($s) { "$($s.Status)|$((Get-CimInstance Win32_Service -Filter "DisplayName='${displayName}'").StartMode)" } else { 'NOT_INSTALLED|' }`,
  );
  const [status, startMode] = out.split("|");
  return { status: status || "UNKNOWN", startMode: startMode || "" };
}

function portListening(port) {
  return ps(`if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`) === "yes";
}

function lastErrorLine(def) {
  // node-windows writes <script-dir>\daemon\<servicename>.err.log, the name lower-cased and
  // stripped of spaces.
  const daemonDir = path.join(path.dirname(def.script), "daemon");
  if (!existsSync(daemonDir)) return null;
  const slug = def.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidate = path.join(daemonDir, `${slug}.err.log`);
  if (!existsSync(candidate)) return null;
  const lines = readFileSync(candidate, "utf8").split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? { line: lines[lines.length - 1], file: candidate } : null;
}

function serviceStatusByName(name) {
  return ps(`(Get-Service -Name '${name}' -ErrorAction SilentlyContinue).Status`) || "NOT FOUND";
}

console.log(`PostgreSQL (${POSTGRES_SERVICE}): ${serviceStatusByName(POSTGRES_SERVICE)}\n`);

for (const def of SERVICES) {
  const { status, startMode } = serviceState(def.name);
  const port = PORTS[def.key];
  const listening = port ? portListening(port) : null;

  console.log(`${def.name}`);
  console.log(`  service : ${status}${startMode ? ` (${startMode} start)` : ""}`);
  if (port) console.log(`  port    : ${port} ${listening ? "listening" : "NOT listening"}`);

  if (status === "Running" && listening === false) {
    console.log("  ⚠ the service is running but nothing is on its port — the app inside it has probably crashed");
  }
  const err = lastErrorLine(def);
  if (err) console.log(`  last err: ${err.line.slice(0, 160)}\n            (${err.file})`);
  console.log("");
}
