import type { NextConfig } from "next";
import { collectAllowedDevOrigins } from "./lib/dev-allowed-origins";

/** Use 127.0.0.1 — on Windows `localhost` often resolves to IPv6 ::1 while the API binds IPv4. */
const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  // LAN dev only — do NOT add experimental.serverActions.allowedOrigins (breaks all routes).
  allowedDevOrigins: collectAllowedDevOrigins(),
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
