import { USER_DISPLAY_NAMES } from "./constants";
import type { ActorLevel, Session } from "@/types/session";

/**
 * Fill in `displayName` for the session. Precedence:
 *   1. Caller-supplied `displayName` (from the auth response's `fullName`) — this is the truth
 *      for real staff added via /admin/staff, whose IDs are UUIDs the constants map doesn't know.
 *   2. Hardcoded seed lookup (kept so the 4 dev seed accounts still show "Front Desk 1" etc).
 *   3. Username, if the auth response carried it.
 *   4. Fall back to the raw userId as a last resort.
 *
 * Previously this ALWAYS ran `USER_DISPLAY_NAMES[userId] ?? userId`, which discarded any real
 * name the caller passed in — so newly created staff got a raw UUID everywhere in the UI.
 */
export function enrichSession(raw: Omit<Session, "displayName"> & Partial<Session>): Session {
  const displayName =
    raw.displayName?.trim() ||
    USER_DISPLAY_NAMES[raw.userId] ||
    raw.username ||
    raw.userId;
  return {
    ...raw,
    actorLevel: raw.actorLevel as ActorLevel,
    displayName,
  };
}
