/** Successful session API payloads (explicit subsets, not Prisma row dumps). */

export type AuthenticateResponseDto = {
  sessionId: string;
  userId: string;
  actorLevel: string;
  terminalId: string;
  authenticatedAt: string;
  jwtToken: string;
};

export type ManualLockResponseDto = {
  sessionId: string;
  status: "MANUALLY_LOCKED";
  manuallyLockedAt: string;
};

export type HardLogoutResponseDto = {
  sessionId: string;
  status: "HARD_LOGGED_OUT";
  hardLoggedOutAt: string;
};
