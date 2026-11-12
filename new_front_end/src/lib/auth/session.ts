import { USER_DISPLAY_NAMES } from "./constants";
import { enrichSession as enrich } from "./session-enrich";
import type { Session } from "@/types/session";

export { enrichSession } from "./session-enrich";

const STORAGE_KEY = "legphel_session";

export function getClientSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setClientSession(session: Session): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearClientSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * The sign-in the cookie holds (2026-11-12). `ok: false` means the cookie could not be read (the
 * desk's server was busy or unreachable) — not that nobody is signed in, so nothing may be cleared on
 * it. Tried three times, a second apart, before giving up.
 */
export async function readServerSession(): Promise<{ ok: boolean; session: Session | null }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { session: Session | null };
        return { ok: true, session: data.session ? enrich(data.session) : null };
      }
    } catch {
      /* try again */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, session: null };
}

export async function hydrateSessionFromServer(): Promise<Session | null> {
  const { session } = await readServerSession();
  if (session) setClientSession(session);
  return session;
}

export async function persistSessionToServer(session: Session): Promise<void> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session),
    credentials: "same-origin",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Failed to save session (${res.status})`);
  }
}

export async function clearSessionOnServer(): Promise<void> {
  await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
}

/** Clear all auth state when cookie exists but client session cannot be restored. */
export async function clearStaleAuth(): Promise<void> {
  clearClientSession();
  await clearSessionOnServer();
}
