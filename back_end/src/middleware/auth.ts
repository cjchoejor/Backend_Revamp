import type { RequestHandler } from "express";
import { AuthorizationError, ValidationError } from "../lib/errors.js";
import type { ActorLevel, RequestActor } from "../types/actor.js";

export type { ActorLevel, RequestActor };

const rank: Record<ActorLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export function parseActorHeaders(): RequestHandler {
  return (req, _res, next) => {
    const actorId = req.header("x-actor-id")?.trim();
    const levelRaw = req.header("x-actor-level")?.trim().toUpperCase();

    if (!actorId) {
      next(new ValidationError("Missing X-Actor-Id header"));
      return;
    }

    const allowed: ActorLevel[] = ["L1", "L2", "L3", "L4"];
    const level = (allowed.includes(levelRaw as ActorLevel) ? levelRaw : null) as ActorLevel | null;
    if (!level) {
      next(new ValidationError("Missing or invalid X-Actor-Level (use L1, L2, L3, or L4)"));
      return;
    }

    req.actor = { actorId, level };
    next();
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
