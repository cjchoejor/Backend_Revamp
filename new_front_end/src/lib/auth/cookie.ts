import { SESSION_COOKIE, type Session } from "@/types/session";

/** Parse session from the httpOnly cookie value (middleware / server). */
export function parseSessionCookieValue(raw: string | undefined): Session | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Session;
    if (!parsed?.userId || !parsed?.sessionId || !parsed?.actorLevel) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasValidSessionCookie(cookieValue: string | undefined): boolean {
  return parseSessionCookieValue(cookieValue) !== null;
}

export { SESSION_COOKIE };
