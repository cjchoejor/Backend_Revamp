import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import {
  executeCombineBookings,
  listSameGuestBookings,
  previewCombineBookings,
} from "../../services/domain/combine-bookings-service.js";
import { answerBothMeant, describeOpenDuplicates } from "../../services/domain/duplicate-check-service.js";

/**
 * The same guest's other bookings, and combining two of them while both are still at Inquiry or
 * Negotiation (2026-10-19). L1 is the floor; the service raises it — once this booking's
 * quotation has gone to the guest, combining is the FOM's (Negotiation's own rule).
 */
export const guestBookingsRouter = Router();

const actorOf = (req: { actor?: { actorId: string; level: any } }) => ({
  actorId: req.actor!.actorId,
  actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4",
});

guestBookingsRouter.get("/entries/:id/guest-bookings", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await listSameGuestBookings(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/** The open "same booking twice?" questions, each with the other booking (2026-11-24). */
guestBookingsRouter.get("/entries/:id/duplicate-check", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await describeOpenDuplicates(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/** "Both are meant" — the desk's answer; the booking may then move on. */
guestBookingsRouter.post(
  "/entries/:id/duplicate-check/:flagId/both-meant",
  requireActorLevel("L1"),
  validateBody(z.object({ note: z.string().trim().max(500).optional().nullable() })),
  async (req, res, next) => {
    try {
      res.json(await answerBothMeant(prisma, actorOf(req), req.params.id, req.params.flagId, req.body.note));
    } catch (e) {
      next(e);
    }
  },
);

guestBookingsRouter.post(
  "/entries/:id/combine/preview",
  requireActorLevel("L1"),
  validateBody(z.object({ otherEntryId: z.string().trim().min(1).max(64) })),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewCombineBookings(prisma, actorOf(req), req.params.id, req.body.otherEntryId));
    } catch (e) {
      next(e);
    }
  },
);

guestBookingsRouter.post(
  "/entries/:id/combine",
  requireActorLevel("L1"),
  validateBody(
    z.object({
      otherEntryId: z.string().trim().min(1).max(64),
      reason: z.string().trim().min(1, "Say why the bookings are being combined").max(500),
      expectedVersion: z.coerce.number().int().optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(
        await executeCombineBookings(prisma, actorOf(req), {
          keptId: req.params.id,
          otherId: req.body.otherEntryId,
          reason: req.body.reason,
          expectedVersion: req.body.expectedVersion,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);
