import os from "node:os";

function isIpv4(addr: os.NetworkInterfaceInfo): boolean {
  return addr.family === "IPv4";
}

/**
 * Hosts allowed to load `/_next/*` and HMR in development (Next.js 15+).
 * LAN IPs change when switching Wi‑Fi; private-range wildcards keep network URLs working.
 */
export function collectAllowedDevOrigins(): string[] {
  const fromEnv =
    process.env.ALLOWED_DEV_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];

  const lan: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue;
    for (const addr of iface) {
      if (isIpv4(addr) && !addr.internal) {
        lan.push(addr.address);
      }
    }
  }

  const ports = [
    process.env.PORT,
    process.env.NEXT_DEV_PORT,
    "3000",
    "3001",
    "3002",
  ]
    .map((p) => (p ? String(p).trim() : ""))
    .filter(Boolean);

  const hostWithPorts: string[] = [];
  for (const ip of lan) {
    hostWithPorts.push(ip);
    for (const port of ports) {
      hostWithPorts.push(`${ip}:${port}`);
    }
  }

  /**
   * One `*` = one hostname label. `192.168.*` does NOT match `192.168.0.113` (0 ≠ 168).
   * Use four labels for typical home/office LAN IPs.
   */
  const privateWildcards = [
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
  ];

  return [
    ...new Set([
      ...fromEnv,
      ...hostWithPorts,
      ...privateWildcards,
      "0.0.0.0",
      "127.0.0.1",
      "localhost",
      "*.localhost",
    ]),
  ];
}
