import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import {
  executeRoomMove,
  getRoomMove,
  listRoomMovesForEntry,
  previewRoomMove,
  resolveRoomMove,
  retryRoomMoveLeg,
} from "../../services/domain/room-move-service.js";
import { decideHeldDocument, listHeldDocuments } from "../../services/domain/held-document-service.js";
import { executeDateMove, previewDateMove } from "../../services/domain/date-move-service.js";
import { executeRoomSplit, previewRoomSplit } from "../../services/domain/room-split-service.js";
import { executeNightMove, previewNightMove } from "../../services/domain/night-move-service.js";

/**
 * Room moves from the house chart, and the papers every room-change walk holds for the desk
 * (2026-10-12). The level on the route is the floor; the service raises it — any switch of two
 * bookings needs the FOM, and a one-booking move follows the room-change rule (same type → desk,
 * different type → FOM). The actor's level is always the verified session's.
 */
export const roomMovesRouter = Router();

const actorOf = (req: { actor?: { actorId: string; level: any } }) => ({
  actorId: req.actor!.actorId,
  actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4",
});

const legSchema = z.object({
  entryId: z.string().trim().min(1).max(64),
  fromRoomId: z.string().trim().min(1).max(64),
  toRoomId: z.string().trim().min(1).max(64),
  priceMode: z.enum(["KEEP", "NEW_TYPE"]).optional(),
  guestAgreedNote: z.string().trim().max(1000).nullable().optional(),
  displacedBy: z.string().trim().max(64).nullable().optional(),
  // The stay's new first night when it moves to other dates too (2026-10-19, trading stays).
  newCheckInDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "newCheckInDate must be a date (YYYY-MM-DD)")
    .nullable()
    .optional(),
});
const legsSchema = z.array(legSchema).min(1).max(12);

roomMovesRouter.post(
  "/room-moves/preview",
  requireActorLevel("L1"),
  validateBody(z.object({ legs: legsSchema, reason: z.string().trim().max(1000).nullable().optional() })),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewRoomMove(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

roomMovesRouter.post(
  "/room-moves",
  requireActorLevel("L1"),
  validateBody(z.object({ legs: legsSchema, reason: z.string().trim().min(1).max(1000) })),
  async (req, res, next) => {
    try {
      res.status(201).json(await executeRoomMove(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Moving a booking to other dates from the house chart (2026-10-13). L1 on the route; the service
 * decides — the FOM from Set up on, Negotiation's own rule before.
 */
const dateMoveSchema = z.object({
  entryId: z.string().trim().min(1).max(64),
  fromRoomId: z.string().trim().min(1).max(64),
  toRoomId: z.string().trim().min(1).max(64).nullable().optional(),
  // The block (2026-10-13): every room that changes row, old → new.
  roomMap: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(64)).nullable().optional(),
  newCheckInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "newCheckInDate must be YYYY-MM-DD"),
  priceMode: z.enum(["KEEP", "NEW_DATES"]).optional(),
  // The price choice per room, keyed by the room as it is now.
  priceModes: z.record(z.string().trim().min(1).max(64), z.enum(["KEEP", "NEW_DATES"])).nullable().optional(),
  guestAgreedNote: z.string().trim().max(1000).nullable().optional(),
});

roomMovesRouter.post(
  "/date-moves/preview",
  requireActorLevel("L1"),
  validateBody(dateMoveSchema.extend({ reason: z.string().trim().max(1000).nullable().optional() })),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewDateMove(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

roomMovesRouter.post(
  "/date-moves",
  requireActorLevel("L1"),
  validateBody(dateMoveSchema.extend({ reason: z.string().trim().min(1).max(1000) })),
  async (req, res, next) => {
    try {
      res.status(201).json(await executeDateMove(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Splitting rooms off a booking to other dates (2026-10-14): the rooms leave with their guests,
 * as a booking of their own under the same enquiry (walked to the original's step) or a new
 * enquiry (started at Inquiry, filled in). L1 on the route; the service decides who may — the FOM
 * from Set up on, and at Negotiation once a quotation went out.
 */
const roomSplitSchema = z.object({
  entryId: z.string().trim().min(1).max(64),
  fromRoomId: z.string().trim().min(1).max(64),
  roomMap: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(64)),
  newCheckInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "newCheckInDate must be YYYY-MM-DD"),
  priceMode: z.enum(["KEEP", "NEW_DATES"]).optional(),
  priceModes: z.record(z.string().trim().min(1).max(64), z.enum(["KEEP", "NEW_DATES"])).nullable().optional(),
  guestAgreedNote: z.string().trim().max(1000).nullable().optional(),
  target: z.enum(["SAME_ENQUIRY", "NEW_ENQUIRY"]).optional(),
});

roomMovesRouter.post(
  "/date-moves/split/preview",
  requireActorLevel("L1"),
  validateBody(roomSplitSchema.extend({ reason: z.string().trim().max(1000).nullable().optional() })),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewRoomSplit(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

roomMovesRouter.post(
  "/date-moves/split",
  requireActorLevel("L1"),
  validateBody(roomSplitSchema.extend({ reason: z.string().trim().min(1).max(1000), target: z.enum(["SAME_ENQUIRY", "NEW_ENQUIRY"]) })),
  async (req, res, next) => {
    try {
      res.status(201).json(await executeRoomSplit(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

// A night (or a run of nights) of one room moved on the house chart (2026-10-14): to another room on
// the same dates (a room change for those nights), or to other dates — the stays cut apart, each new
// one a booking of its own on the same enquiry or a new one.
const nightsList = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "nights are YYYY-MM-DD")).min(1).max(60);
// One room's nights (fromRoomId + nights), or several rooms' together (picks, the room dragged
// first — 2026-10-15). Exactly one of the two.
const nightMoveSchema = z
  .object({
    entryId: z.string().trim().min(1).max(64),
    fromRoomId: z.string().trim().min(1).max(64).optional(),
    nights: nightsList.optional(),
    toRoomId: z.string().trim().min(1).max(64).nullable().optional(),
    picks: z
      .array(
        z.object({
          fromRoomId: z.string().trim().min(1).max(64),
          nights: nightsList,
          toRoomId: z.string().trim().min(1).max(64).nullable().optional(),
        }),
      )
      .min(1)
      .max(8)
      .optional(),
    newFirstNight: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "newFirstNight must be YYYY-MM-DD"),
    priceMode: z.enum(["KEEP", "NEW_DATES", "NEW_TYPE"]).optional(),
    guestAgreedNote: z.string().trim().max(1000).nullable().optional(),
    target: z.enum(["SAME_ENQUIRY", "NEW_ENQUIRY"]).optional(),
  })
  .refine((v) => (v.picks ? !v.fromRoomId && !v.nights : !!v.fromRoomId && !!v.nights), {
    message: "Name one room's nights (fromRoomId + nights) or several rooms' (picks) — not both",
  });

roomMovesRouter.post(
  "/date-moves/nights/preview",
  requireActorLevel("L1"),
  validateBody(nightMoveSchema.and(z.object({ reason: z.string().trim().max(1000).nullable().optional() }))),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewNightMove(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

roomMovesRouter.post(
  "/date-moves/nights",
  requireActorLevel("L1"),
  validateBody(nightMoveSchema.and(z.object({ reason: z.string().trim().min(1).max(1000) }))),
  async (req, res, next) => {
    try {
      res.status(201).json(await executeNightMove(prisma, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);

roomMovesRouter.get("/room-moves/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await getRoomMove(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

roomMovesRouter.get("/entries/:id/room-moves", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await listRoomMovesForEntry(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

roomMovesRouter.post(
  "/room-moves/:id/resolve",
  requireActorLevel("L2"),
  validateBody(z.object({ note: z.string().trim().min(1).max(1000) })),
  async (req, res, next) => {
    try {
      res.json(await resolveRoomMove(prisma, actorOf(req), req.params.id, req.body.note));
    } catch (e) {
      next(e);
    }
  },
);

roomMovesRouter.post(
  "/room-moves/:id/legs/:legId/retry",
  requireActorLevel("L2"),
  validateBody(z.object({ reason: z.string().trim().max(1000).nullable().optional() })),
  async (req, res, next) => {
    try {
      res.json(await retryRoomMoveLeg(prisma, actorOf(req), req.params.id, req.params.legId, req.body.reason ?? null));
    } catch (e) {
      next(e);
    }
  },
);

/* ---- held papers: every walk's voucher / proforma, waiting for the desk's answer ---- */

roomMovesRouter.get("/entries/:id/held-documents", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await listHeldDocuments(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

roomMovesRouter.post(
  "/held-documents/:id/decide",
  requireActorLevel("L1"),
  validateBody(
    z.object({
      action: z.enum(["EMAIL", "WHATSAPP", "NONE"]),
      sentTo: z.string().trim().max(320).nullable().optional(),
      note: z.string().trim().max(1000).nullable().optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      res.json(await decideHeldDocument(prisma, req.params.id, actorOf(req), req.body));
    } catch (e) {
      next(e);
    }
  },
);
