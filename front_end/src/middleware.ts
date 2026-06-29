import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, hasValidSessionCookie } from "@/lib/auth/cookie";

const AUTH_PATHS = ["/login"];

function isProtected(pathname: string) {
  return pathname.startsWith("/desk") || pathname.startsWith("/admin");
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionRaw = request.cookies.get(SESSION_COOKIE)?.value;
  const hasAuth = hasValidSessionCookie(sessionRaw);

  if (pathname === "/") {
    return NextResponse.redirect(new URL(hasAuth ? "/desk" : "/login", request.url));
  }

  if (isProtected(pathname) && !hasAuth) {
    const login = new URL("/login", request.url);
    login.searchParams.set("from", pathname);
    return NextResponse.redirect(login);
  }

  if (AUTH_PATHS.includes(pathname) && hasAuth) {
    return NextResponse.redirect(new URL("/desk", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"],
};
