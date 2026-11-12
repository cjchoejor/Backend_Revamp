import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, hasValidSessionCookie } from "@/lib/auth/cookie";

const AUTH_PATHS = ["/login"];
/** Reachable without a desk session: sign-in, the phone capture page (token-scoped), the API proxy. */
const OPEN_PREFIXES = ["/login", "/capture", "/api"];
const HOME = "/today";

function isProtected(pathname: string) {
  return !OPEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionRaw = request.cookies.get(SESSION_COOKIE)?.value;
  const hasAuth = hasValidSessionCookie(sessionRaw);

  if (pathname === "/") {
    return NextResponse.redirect(new URL(hasAuth ? HOME : "/login", request.url));
  }

  // The old desk addresses still open the same screens.
  if (pathname === "/desk" || pathname.startsWith("/desk/")) {
    const rest = pathname.slice("/desk".length) || HOME;
    const url = new URL(rest === "/" ? HOME : rest, request.url);
    url.search = request.nextUrl.search;
    return NextResponse.redirect(url);
  }

  if (isProtected(pathname) && !hasAuth) {
    const login = new URL("/login", request.url);
    // The page and its query (2026-11-12) — a booking opens again on the step it was on.
    login.searchParams.set("from", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }

  if (AUTH_PATHS.includes(pathname) && hasAuth) {
    const from = request.nextUrl.searchParams.get("from");
    const back = from && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/login") ? from : HOME;
    return NextResponse.redirect(new URL(back, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|tessdata/|tesseract|.*\\.(?:png|jpg|jpeg|svg|mp4|woff2?|wasm|js|traineddata)$).*)"],
};
