import type { RequestHandler } from "express";
import { AuthorizationError, ValidationError } from "../lib/errors.js";
import { verifySessionJwt } from "../services/infrastructure/session-service.js";
import { prisma } from "../db.js";
import type { ActorLevel, RequestActor } from "../types/actor.js";

export type { ActorLevel, RequestActor };

const rank: Record<ActorLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

/**
 * Auth middleware.
 *
 * Primary path: `Authorization: Bearer <jwt>`. Verifies signature, looks up the SessionRecord,
 * enforces status === ACTIVE, and populates `req.actor` from the DB row — never from headers.
 *
 * Legacy path (guarded by `AUTH_ALLOW_HEADER_FALLBACK=true`): the old X-Actor-Id / X-Actor-Level
 * behaviour. Kept temporarily so the friend's production frontend can migrate at its own pace.
 * The variable defaults to OFF. Delete this whole branch once both frontends ship Bearer tokens.
 *
 * Also throttles `SessionRecord.lastActiveAt` writes to at most once per 30 s per session so
 * every-request auth doesn't hammer the DB.
 */

const lastActiveTouchAt = new Map<string, number>();
const TOUCH_THROTTLE_MS = 30_000;

async function touchSessionLastActive(sessionId: string, now: Date): Promise<void> {
  const last = lastActiveTouchAt.get(sessionId) ?? 0;
  if (now.getTime() - last < TOUCH_THROTTLE_MS) return;
  lastActiveTouchAt.set(sessionId, now.getTime());
  await prisma.sessionRecord.update({ where: { id: sessionId }, data: { lastActiveAt: now } }).catch(() => {
    // If update fails, drop the entry from the throttle cache so the next request retries.
    lastActiveTouchAt.delete(sessionId);
  });
}

function parseHeaderFallback(actorId: string | undefined, levelRaw: string | undefined): RequestActor | null {
  if (!actorId) return null;
  const allowed: ActorLevel[] = ["L1", "L2", "L3", "L4"];
  const level = (allowed.includes(levelRaw as ActorLevel) ? levelRaw : null) as ActorLevel | null;
  if (!level) return null;
  return { actorId, level };
}

export function parseActorHeaders(): RequestHandler {
  const allowHeaderFallback = String(process.env.AUTH_ALLOW_HEADER_FALLBACK ?? "").toLowerCase() === "true";

  return async (req, _res, next) => {
    try {
      // --- Primary: Bearer token ---
      const authHeader = req.header("authorization") ?? req.header("Authorization");
      if (authHeader && /^Bearer\s+/i.test(authHeader)) {
        const token = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (!token) throw new AuthorizationError("Empty bearer token");

        const payload = verifySessionJwt(token);
        const session = await prisma.sessionRecord.findUnique({
          where: { id: payload.sessionId },
          include: { user: { select: { id: true, actorLevel: true, isActive: true, username: true } } },
        });
        if (!session) throw new AuthorizationError("Session not found");
        if (session.status !== "ACTIVE") throw new AuthorizationError(`Session is ${session.status}`);
        if (!session.user || !session.user.isActive) throw new AuthorizationError("Staff user inactive");
        // DB is authoritative for level — token could be stale if the admin changed it.
        req.actor = { actorId: session.user.id, level: session.user.actorLevel as ActorLevel };
        // Fire-and-forget lastActive touch; the caller shouldn't wait on it.
        void touchSessionLastActive(session.id, new Date());
        next();
        return;
      }

      // --- Legacy: X-Actor-* headers (temporary bridge) ---
      if (allowHeaderFallback) {
        const actorId = req.header("x-actor-id")?.trim();
        const levelRaw = req.header("x-actor-level")?.trim().toUpperCase();
        const parsed = parseHeaderFallback(actorId, levelRaw);
        if (!parsed) {
          next(new ValidationError("Missing X-Actor-Id/X-Actor-Level headers (legacy path)"));
          return;
        }
        req.actor = parsed;
        next();
        return;
      }

      next(new AuthorizationError("Missing Authorization: Bearer <token>"));
    } catch (e) {
      next(e);
    }
  };
}

export function requireActorLevel(min: ActorLevel): RequestHandler {
  return (req, _res, next) => {
    const actor = req.actor;
    if (!actor) {
      next(new AuthorizationError("Actor context missing"));
      return;
    }
    if (rank[actor.level as ActorLevel] < rank[min]) {
      next(new AuthorizationError());
      return;
    }
    next();
  };
}
