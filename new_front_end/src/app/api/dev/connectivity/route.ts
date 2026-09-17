import { NextResponse } from "next/server";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";

/** Dev-only: verify Next → API proxy path (open /api/dev/connectivity in browser). */
export async function GET() {
  const healthUrl = `${BACKEND.replace(/\/$/, "")}/api/health`;
  try {
    const res = await fetch(healthUrl, { cache: "no-store" });
    const body = await res.text();
    return NextResponse.json({
      ok: res.ok,
      backendUrl: BACKEND,
      healthStatus: res.status,
      healthBody: body.slice(0, 200),
      hint: res.ok
        ? "API reachable from Next.js. If the app still fails, hard-refresh (Ctrl+Shift+R)."
        : "Start back_end: cd back_end && npm run dev",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        backendUrl: BACKEND,
        error: message,
        hint: "Run: cd back_end && npm run dev — then restart front_end",
      },
      { status: 503 },
    );
  }
}
