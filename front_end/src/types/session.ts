export type ActorLevel = "L1" | "L2" | "L3" | "L4";

export type Session = {
  sessionId: string;
  userId: string;
  // Login handle (unique). Populated by `authenticate` responses; falls back to userId in older
  // sessions that predate the username field.
  username?: string;
  actorLevel: ActorLevel;
  terminalId: string;
  jwtToken: string;
  authenticatedAt: string;
  // Human-readable name shown in headers / welcome toast / sidebar. `enrichSession` fills it in.
  displayName?: string;
};

export const SESSION_COOKIE = "legphel_session";
