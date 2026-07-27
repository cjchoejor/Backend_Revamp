import jwt from "jsonwebtoken";
import type { ActorLevel } from "../types/actor.js";

/**
 * Centralised session-token signing/verification. The actor's LEVEL travels inside this signed
 * token (set from the StaffUser record at login), so it can be trusted on later requests instead
 * of being read from a client-controlled header. This closes the "self-asserted actor level" hole
 * (docs/issues.md C1).
 */

export type SessionTokenPayload = {
  sessionId: string;
  userId: string;
  actorLevel: ActorLevel;
  terminalId: string;
};

let cachedSecret: string | null = null;

/** Resolve the signing secret lazily (so dotenv has loaded) and cache it. */
function secret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.trim().length >= 16) {
    cachedSecret = fromEnv.trim();
    return cachedSecret;
  }
  // No usable secret configured. Fail closed in production; allow a loud dev-only default otherwise
  // so local development still works (the old silent "dev-jwt-secret" fallback is removed).
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set to at least 16 characters in production");
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[auth-token] JWT_SECRET is not set (or too short) — using an INSECURE development default. " +
      "Set JWT_SECRET (>=16 chars) in .env before deploying.",
  );
  cachedSecret = "legphel-dev-only-insecure-secret";
  return cachedSecret;
}

export function signSessionToken(payload: SessionTokenPayload, expiresIn: string = "12h"): string {
  return jwt.sign(payload, secret(), { expiresIn } as jwt.SignOptions);
}

/** Verify a token and return its payload, or null if missing/invalid/expired. */
export function verifySessionToken(token: string | null | undefined): SessionTokenPayload | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, secret());
    if (decoded && typeof decoded === "object") {
      const p = decoded as Record<string, unknown>;
      const userId = typeof p.userId === "string" ? p.userId : null;
      const actorLevel = typeof p.actorLevel === "string" ? (p.actorLevel as ActorLevel) : null;
      if (userId && actorLevel && ["L1", "L2", "L3", "L4"].includes(actorLevel)) {
        return {
          sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
          userId,
          actorLevel,
          terminalId: typeof p.terminalId === "string" ? p.terminalId : "",
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
