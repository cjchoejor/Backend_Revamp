import { clearStaleAuth } from "./session";

/** Hard navigation to login so the browser loads fresh JS/CSS chunks (fixes dev 404s). */
export async function redirectToLogin(): Promise<void> {
  await clearStaleAuth();
  if (typeof window === "undefined") return;

  const { pathname, origin } = window.location;
  if (pathname === "/login") {
    window.history.replaceState(null, "", "/login");
    window.location.reload();
    return;
  }
  window.location.replace(`${origin}/login`);
}

/**
 * To the sign-in page, and back to this page afterwards (2026-11-12). It clears nothing: the
 * cookie may hold a good sign-in made a moment ago (or on another tab), and the middleware judges it.
 * Sign out and Lock, which end the sign-in on purpose, use `redirectToLogin`.
 */
export function goToSignIn(opts: { ended?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const { pathname, search, origin } = window.location;
  if (pathname === "/login") return;
  // `ended=1`: the sign-in page says why (a toast here would be lost with the page).
  const ended = opts.ended ? "&ended=1" : "";
  window.location.replace(`${origin}/login?from=${encodeURIComponent(`${pathname}${search}`)}${ended}`);
}

/** A `from` that is a page of the desk (never another site, never the sign-in page itself). */
export function safeFrom(from: string | null | undefined, fallback = "/today"): string {
  if (!from || !from.startsWith("/") || from.startsWith("//") || from.startsWith("/login")) return fallback;
  return from;
}

/** Hard navigation after successful sign-in. */
export function redirectAfterLogin(path = "/today"): void {
  if (typeof window !== "undefined") {
    window.location.replace(path);
  }
}
