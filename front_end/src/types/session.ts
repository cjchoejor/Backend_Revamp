export type ActorLevel = "L1" | "L2" | "L3" | "L4";

export type Session = {
  sessionId: string;
  userId: string;
  actorLevel: ActorLevel;
  terminalId: string;
  jwtToken: string;
  authenticatedAt: string;
  displayName?: string;
};

export const SESSION_COOKIE = "legphel_session";
