import { USER_DISPLAY_NAMES } from "./constants";
import type { ActorLevel, Session } from "@/types/session";

export function enrichSession(raw: Omit<Session, "displayName"> & Partial<Session>): Session {
  return {
    ...raw,
    actorLevel: raw.actorLevel as ActorLevel,
    displayName: USER_DISPLAY_NAMES[raw.userId] ?? raw.userId,
  };
}
