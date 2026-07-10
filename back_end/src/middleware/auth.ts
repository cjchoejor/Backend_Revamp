import type { RequestHandler } from "express";
import { AuthorizationError, ValidationError } from "../lib/errors.js";
import type { ActorLevel, RequestActor } from "../types/actor.js";
import { verifySessionToken } from "../lib/auth-token.js";

export type { ActorLevel, RequestActor };

const rank: Record<ActorLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const ALLOWED_LEVELS: ActorLevel[] = ["L1", "L2", "L3", "L4"];

/**
 * Authenticate the actor for every request. The actor's LEVEL is taken from the cryptographically
 * verified session token (`Authorization: Bearer <jwt>`), which was signed from the StaffUser record
 * at login — NOT from a client-supplied `X-Actor-Level` header. This closes the self-asserted-level
 * hole (docs/issues.md C1).
 *
 * Dev-only fallback: when `ALLOW_HEADER_AUTH=true`, the legacy `X-Actor-Id` / `X-Actor-Level` header
 * path is honoured (for local scripts/tests). It is OFF by default and must NEVER be enabled in a
 * deployed environment — it re-opens the spoofing hole.
 */
export function authenticateActor(): RequestHandler {
  const headerAuthAllowed = process.env.ALLOW_HEADER_AUTH === "true";
  if (headerAuthAllowed) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] ALLOW_HEADER_AUTH=true — actor level may be supplied via X-Actor-Level header. " +
        "This is INSECURE and must only be used for local development/testing.",
    );
  }
  return (req, _res, next) => {
    // Primary path: verify the bearer session token and trust ONLY its signed payload.
    const authz = req.header("authorization");
    const bearer =
      authz && authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : null;

    if (bearer) {
      const payload = verifySessionToken(bearer);
      if (!payload) {
        next(new AuthorizationError("Invalid or expired session token"));
        return;
      }
      req.actor = { actorId: payload.userId, level: payload.actorLevel };
      next();
      return;
    }

    // Dev-only header fallback (opt-in).
    if (headerAuthAllowed) {
      const actorId = req.header("x-actor-id")?.trim();
      const levelRaw = req.header("x-actor-level")?.trim().toUpperCase();
      const level = ALLOWED_LEVELS.includes(levelRaw as ActorLevel) ? (levelRaw as ActorLevel) : null;
      if (!actorId) {
        next(new ValidationError("Missing X-Actor-Id header"));
        return;
      }
      if (!level) {
        next(new ValidationError("Missing or invalid X-Actor-Level (use L1, L2, L3, or L4)"));
        return;
      }
      req.actor = { actorId, level };
      next();
      return;
    }

    next(new AuthorizationError("Authentication required — present a valid session token"));
  };
}

/**
 * Back-compat alias. Historically the global middleware was `parseActorHeaders()`; it now
 * authenticates via the verified token. Kept so existing mount points don't need to change.
 */
export const parseActorHeaders = authenticateActor;

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
