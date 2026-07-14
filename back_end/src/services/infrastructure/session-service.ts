import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { AuthorizationError, ValidationError } from "../../lib/errors.js";
import { enforceValidPin } from "../../policies/29-session-management/p69-session-management-and-pin-authentication.js";
import { allocateReadableId } from "../../lib/readable-id.js";

/**
 * JWT authentication for staff sessions.
 *
 * Login is `{ username, pin, terminalId }`. Username is the unique handle set by the admin on
 * StaffUser; the 4-digit PIN is bcrypt-hashed per user. Compared to the old PIN-only flow this
 * lets multiple staff share a PIN (10k global space would collide fast) and lets bcrypt-compare
 * against ONE row instead of scanning every active user.
 *
 * Boot-time secret check: refuses to boot in production without a real JWT_SECRET. Dev fallback
 * logged loudly so it's obvious when a deploy skipped the env var.
 */

const DEV_SECRET = "dev-jwt-secret";

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.trim() && secret !== DEV_SECRET) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET must be set to a non-default value in production. Refusing to boot with the dev fallback.",
    );
  }
  // Dev: use the fallback but WARN once at boot so we don't ship it to prod unnoticed.
  if (!(globalThis as any).__legphelJwtDevWarned) {
    // eslint-disable-next-line no-console
    console.warn("[auth] JWT_SECRET is unset or default. Using dev fallback — NOT SAFE for production.");
    (globalThis as any).__legphelJwtDevWarned = true;
  }
  return DEV_SECRET;
}

export type SessionJwtPayload = {
  sessionId: string;
  userId: string;
  username: string;
  actorLevel: string;
  terminalId: string;
};

function signJwt(payload: SessionJwtPayload) {
  return jwt.sign(payload, resolveJwtSecret(), { expiresIn: "12h" });
}

/** Verify a JWT and return the payload, or throw AuthorizationError on any failure. */
export function verifySessionJwt(token: string): SessionJwtPayload {
  try {
    const decoded = jwt.verify(token, resolveJwtSecret()) as jwt.JwtPayload;
    if (
      typeof decoded !== "object" ||
      typeof decoded.sessionId !== "string" ||
      typeof decoded.userId !== "string" ||
      typeof decoded.username !== "string" ||
      typeof decoded.actorLevel !== "string" ||
      typeof decoded.terminalId !== "string"
    ) {
      throw new AuthorizationError("Malformed session token");
    }
    return {
      sessionId: decoded.sessionId,
      userId: decoded.userId,
      username: decoded.username,
      actorLevel: decoded.actorLevel,
      terminalId: decoded.terminalId,
    };
  } catch (e) {
    if (e instanceof AuthorizationError) throw e;
    throw new AuthorizationError("Invalid or expired session token");
  }
}

export async function authenticate(prisma: PrismaClient, input: { username: string; pin: string; terminalId: string }) {
  if (!input.username?.trim()) throw new ValidationError("username is required");
  if (!input.pin?.trim()) throw new ValidationError("pin is required");
  if (!input.terminalId?.trim()) throw new ValidationError("terminalId is required");

  const username = input.username.trim();
  const user = await prisma.staffUser.findUnique({ where: { username } });
  // Uniform failure: don't leak whether username was wrong vs PIN was wrong (timing side channel
  // still exists — bcrypt short-circuits when no user — a follow-up could do a dummy compare).
  const ok = user && user.isActive ? await bcrypt.compare(input.pin, user.pinHash) : false;
  enforceValidPin({ isPinValid: !!ok });

  const sessionId = await allocateReadableId(prisma, "SESSION" as const);
  const session = await prisma.sessionRecord.create({
    data: {
      id: sessionId,
      userId: user!.id,
      terminalId: input.terminalId,
      status: "ACTIVE",
      authenticatedAt: new Date(),
      lastActiveAt: new Date(),
    },
  });

  await prisma.sessionEventRecord.create({
    data: { sessionId: session.id, eventType: "LOGIN", incomingActorId: user!.id, terminalId: input.terminalId, occurredAt: new Date() },
  });

  const jwtToken = signJwt({
    sessionId: session.id,
    userId: user!.id,
    username: user!.username,
    actorLevel: user!.actorLevel,
    terminalId: input.terminalId,
  });
  await prisma.sessionRecord.update({ where: { id: session.id }, data: { jwtToken } });

  return {
    sessionId: session.id,
    userId: user!.id,
    username: user!.username,
    fullName: user!.fullName,
    actorLevel: user!.actorLevel,
    terminalId: input.terminalId,
    authenticatedAt: session.authenticatedAt.toISOString(),
    jwtToken,
  };
}

export async function pinSwitch(prisma: PrismaClient, input: { outgoingActorId: string; incomingUsername: string; incomingPin: string; terminalId: string }) {
  if (!input.outgoingActorId?.trim()) throw new ValidationError("outgoingActorId is required");
  if (!input.incomingUsername?.trim()) throw new ValidationError("incomingUsername is required");
  if (!input.incomingPin?.trim()) throw new ValidationError("incomingPin is required");
  if (!input.terminalId?.trim()) throw new ValidationError("terminalId is required");

  const outgoing = await prisma.staffUser.findUnique({ where: { id: input.outgoingActorId } });
  if (!outgoing) throw new AuthorizationError("Outgoing actor not found");

  const res = await authenticate(prisma, { username: input.incomingUsername, pin: input.incomingPin, terminalId: input.terminalId });
  await prisma.sessionEventRecord.create({
    data: { sessionId: res.sessionId, eventType: "PIN_SWITCH", outgoingActorId: input.outgoingActorId, incomingActorId: res.userId, terminalId: input.terminalId, occurredAt: new Date() },
  });
  return res;
}

export async function manualLock(prisma: PrismaClient, input: { sessionId: string; actorId: string }) {
  if (!input.sessionId?.trim()) throw new ValidationError("sessionId is required");
  if (!input.actorId?.trim()) throw new ValidationError("actorId is required");

  const session = await prisma.sessionRecord.findUnique({ where: { id: input.sessionId } });
  if (!session) throw new AuthorizationError("Session not found");

  const now = new Date();
  await prisma.sessionRecord.update({ where: { id: input.sessionId }, data: { status: "MANUALLY_LOCKED", manuallyLockedAt: now } });
  await prisma.sessionEventRecord.create({ data: { sessionId: input.sessionId, eventType: "MANUAL_LOCK", outgoingActorId: input.actorId, terminalId: session.terminalId, occurredAt: now } });
  return { sessionId: input.sessionId, status: "MANUALLY_LOCKED", manuallyLockedAt: now.toISOString() };
}

export async function hardLogout(prisma: PrismaClient, input: { sessionId: string }) {
  if (!input.sessionId?.trim()) throw new ValidationError("sessionId is required");
  const session = await prisma.sessionRecord.findUnique({ where: { id: input.sessionId } });
  if (!session) throw new AuthorizationError("Session not found");

  const now = new Date();
  await prisma.sessionRecord.update({ where: { id: input.sessionId }, data: { status: "HARD_LOGGED_OUT", hardLoggedOutAt: now } });
  await prisma.sessionEventRecord.create({ data: { sessionId: input.sessionId, eventType: "HARD_LOGOUT", terminalId: session.terminalId, occurredAt: now } });
  return { sessionId: input.sessionId, status: "HARD_LOGGED_OUT", hardLoggedOutAt: now.toISOString() };
}
