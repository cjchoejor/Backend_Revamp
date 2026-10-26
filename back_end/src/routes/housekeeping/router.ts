import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import {
  listHousekeepingRooms,
  markRoomCleaned,
  markRoomNeedsCleaning,
} from "../../services/domain/housekeeping-service.js";

/**
 * Housekeeping (2026-10-26) — which rooms need cleaning, and marking one clean. Room-level, not
 * booking-level, so the desk's Housekeeping page today and a housekeeping phone app later read and
 * write the same thing. Front desk (L1) and up; the actor is always the verified session's.
 */
export const housekeepingRouter = Router();

const actorOf = (req: { actor?: { actorId: string; level: any } }) => ({
  actorId: req.actor!.actorId,
  actorLevel: String(req.actor!.level),
});

housekeepingRouter.get("/housekeeping/rooms", requireActorLevel("L1"), async (_req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await listHousekeepingRooms(prisma));
  } catch (e) {
    next(e);
  }
});

housekeepingRouter.post(
  "/housekeeping/rooms/:roomId/cleaned",
  requireActorLevel("L1"),
  validateBody(z.object({ note: z.string().trim().max(500).nullable().optional() })),
  async (req, res, next) => {
    try {
      res.json(await markRoomCleaned(prisma, String(req.params.roomId), actorOf(req), { note: req.body.note ?? null }));
    } catch (e) {
      next(e);
    }
  },
);

housekeepingRouter.post(
  "/housekeeping/rooms/:roomId/needs-cleaning",
  requireActorLevel("L1"),
  validateBody(z.object({ reason: z.string().trim().min(1, "Say why the room needs cleaning again").max(500) })),
  async (req, res, next) => {
    try {
      res.json(await markRoomNeedsCleaning(prisma, String(req.params.roomId), actorOf(req), { reason: req.body.reason }));
    } catch (e) {
      next(e);
    }
  },
);
