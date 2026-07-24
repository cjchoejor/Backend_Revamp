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

export async function hydrateSessionFromServer(): Promise<Session | null> {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = (await res.json()) as { session: Session | null };
    if (!data.session) return null;
    const enriched = enrich(data.session);
    setClientSession(enriched);
    return enriched;
  } catch {
    return null;
  }
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
