import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/types/session";
import type { Session } from "@/types/session";

const COOKIE_MAX_AGE = 60 * 60 * 12;

export async function POST(request: Request) {
  const session = (await request.json()) as Session;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, JSON.stringify(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

export async function GET() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) return NextResponse.json({ session: null });
  try {
    return NextResponse.json({ session: JSON.parse(raw) as Session });
  } catch {
    return NextResponse.json({ session: null });
  }
}
