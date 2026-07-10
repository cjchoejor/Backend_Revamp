import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { AuthorizationError, ValidationError } from "../../lib/errors.js";
import { enforceValidPin } from "../../policies/29-session-management/p69-session-management-and-pin-authentication.js";
import { signSessionToken } from "../../lib/auth-token.js";
import type { ActorLevel } from "../../types/actor.js";

export async function authenticate(prisma: PrismaClient, input: { pin: string; terminalId: string }) {
  if (!input.pin?.trim()) throw new ValidationError("pin is required");
  if (!input.terminalId?.trim()) throw new ValidationError("terminalId is required");

  const users = await prisma.staffUser.findMany({ where: { isActive: true } });
  const matched = await Promise.all(users.map(async (u) => ({ u, ok: await bcrypt.compare(input.pin, u.pinHash) })));
  const matchedUser = matched.find((m) => m.ok)?.u;
  enforceValidPin({ isPinValid: !!matchedUser });
  const user = matchedUser!;

  const session = await prisma.sessionRecord.create({
    data: { userId: user.id, terminalId: input.terminalId, status: "ACTIVE", authenticatedAt: new Date(), lastActiveAt: new Date() },
  });

  await prisma.sessionEventRecord.create({
    data: { sessionId: session.id, eventType: "LOGIN", incomingActorId: user.id, terminalId: input.terminalId, occurredAt: new Date() },
  });

  const jwtToken = signSessionToken({
    sessionId: session.id,
    userId: user.id,
    actorLevel: user.actorLevel as ActorLevel,
    terminalId: input.terminalId,
  });
  await prisma.sessionRecord.update({ where: { id: session.id }, data: { jwtToken } });

  return {
    sessionId: session.id,
    userId: user.id,
    actorLevel: user.actorLevel,
    terminalId: input.terminalId,
    authenticatedAt: session.authenticatedAt.toISOString(),
    jwtToken,
  };
}

export async function pinSwitch(prisma: PrismaClient, input: { outgoingActorId: string; incomingPin: string; terminalId: string }) {
  if (!input.outgoingActorId?.trim()) throw new ValidationError("outgoingActorId is required");
  if (!input.incomingPin?.trim()) throw new ValidationError("incomingPin is required");
  if (!input.terminalId?.trim()) throw new ValidationError("terminalId is required");

  const outgoing = await prisma.staffUser.findUnique({ where: { id: input.outgoingActorId } });
  if (!outgoing) throw new AuthorizationError("Outgoing actor not found");

  const res = await authenticate(prisma, { pin: input.incomingPin, terminalId: input.terminalId });
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

