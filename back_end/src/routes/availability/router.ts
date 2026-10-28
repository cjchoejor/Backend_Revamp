import { Router } from "express";
import { prisma } from "../../db.js";
import {
  queryAvailabilityByEntryRequestSchema,
  priceRoomPickRequestSchema,
  houseByTypeRequestSchema,
  sealByTypeRequestSchema,
  chooseQuietRoomRequestSchema,
  queryAvailabilitySearchRequestSchema,
  selectAvailabilityOptionRequestSchema,
} from "../../dtos/04-availability/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s1AvailabilityService from "../../services/domain/s1-availability-service.js";
import { priceRoomPick } from "../../services/domain/pick-pricing-service.js";
import { releaseRoomBlock } from "../../services/domain/room-block-release-service.js";
import { buildRoomChart } from "../../services/domain/room-chart-service.js";
import { answerHouseByType } from "../../services/domain/room-placement-service.js";
import { chooseQuietRooms, describeBookingRooms, listQuietRoomChoices, sealBookingRoomsByType } from "../../services/domain/quiet-rooms-service.js";
import { ROOM_BED_TYPES, allowedBedTypesSource, effectiveAllowedBedTypes, setRoomBedType, usualBedTypeFor } from "../../services/domain/room-bed-type-service.js";

export const availabilityRouter = Router();

/**
 * Put a blocked room back in service — GM and above.
 *
 * Blocking lives in the L4 admin console; unblocking is a decision the desk hits mid-booking,
 * with a guest waiting and no admin on shift. Same authority bar as releasing another booking's
 * committed hold, and the reason is recorded on a trace against the room.
 */
availabilityRouter.post("/rooms/:id/release-block", requireActorLevel("L3"), async (req, res, next) => {
  try {
    const out = await releaseRoomBlock(
      prisma,
      req.params.id,
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      { releaseReason: String(req.body?.releaseReason ?? "") },
    );
    res.json(out);
  } catch (e) {
    next(e);
  }
});

/**
 * Change a room's physical bed setup from the desk (2026-08-10) — L1: a housekeeping fact,
 * decided where the beds actually get moved. The full room editor stays L4 admin.
 */
availabilityRouter.post("/rooms/:id/bed-type", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await setRoomBedType(
      prisma,
      req.params.id,
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      {
        bedType: String(req.body?.bedType ?? ""),
        bedCount: req.body?.bedCount != null ? Number(req.body.bedCount) : null,
        // The booking the change is for — its departure puts the room back to its usual setup.
        entryId: typeof req.body?.entryId === "string" && req.body.entryId.trim() ? req.body.entryId.trim() : null,
      },
    );
    res.json(out);
  } catch (e) {
    next(e);
  }
});

/**
 * The house chart — every room, night by night (2026-10-12). Read-only, L1: who holds each room on
 * each night of the window and how firmly (in house · reserved · held · provisional · checked
 * out · parked), the out-of-order nights, and the per-night figures ("House booked 3/28"). Built
 * from the same claim helpers the S1 search reads, so the chart and the search agree.
 * `?from=YYYY-MM-DD` (default: the hotel's today) and `?nights=` (default 14, at most 62).
 */
availabilityRouter.get("/rooms/chart", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const from = typeof req.query.from === "string" && req.query.from ? req.query.from : undefined;
    const nights = typeof req.query.nights === "string" && req.query.nights ? Number(req.query.nights) : undefined;
    res.setHeader("Cache-Control", "no-store");
    res.json(await buildRoomChart(prisma, { from, nights: Number.isFinite(nights) ? nights : undefined }));
  } catch (e) {
    next(e);
  }
});

availabilityRouter.get("/rooms", requireActorLevel("L1"), async (_req, res, next) => {
  try {
    const items = await prisma.room.findMany({
      orderBy: { roomNumber: "asc" },
      select: {
        id: true,
        roomNumber: true,
        physicalState: true,
        roomTypeId: true,
        floorNumber: true,
        bedType: true,
        bedCount: true,
        allowedBedTypes: true,
        defaultBedType: true,
        currentClaimState: true,
        isBlocked: true,
        blockedReason: true,
        isDeficient: true,
        isUnderMaintenance: true,
        roomType: {
          select: {
            id: true,
            code: true,
            name: true,
            standardCapacity: true,
            maxCapacity: true,
            maxChildren: true,
            requiredAccompanyingAdults: true,
            maxExtraBeds: true,
            defaultBedType: true,
            allowedBedTypes: true,
          },
        },
      },
    });
    // Per room (2026-09-19, operator ruling): the setups it can be made up in — its own list,
    // else its type's, else every setup — and its type's USUAL setup. `bedType` is how the
    // room is made up now. All three come from room-bed-type-service, so the desk and the
    // admin console read one rule. `allowedBedTypes` is REPLACED here by the effective list;
    // the room's own configured list is `ownAllowedBedTypes`.
    const withAllowed = items.map((r) => ({
      ...r,
      ownAllowedBedTypes: r.allowedBedTypes,
      allowedBedTypes: effectiveAllowedBedTypes(r.allowedBedTypes, r.roomType.allowedBedTypes),
      allowedBedTypesSource: allowedBedTypesSource(r.allowedBedTypes, r.roomType.allowedBedTypes),
      // The room's usual setup: its own, else its type's.
      defaultBedType: usualBedTypeFor(r.defaultBedType, r.roomType.defaultBedType),
    }));
    // `bedTypes` is the full vocabulary; a room's dropdown reads its own `allowedBedTypes`.
    res.json({ items: withAllowed, count: items.length, bedTypes: ROOM_BED_TYPES });
  } catch (e) {
    next(e);
  }
});

availabilityRouter.get("/availability/configurations/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.getConfiguration(prisma, req.params.id);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

availabilityRouter.post("/availability/configurations/:id/recall", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.recallConfiguration(
      prisma,
      req.params.id,
      req.actor!.actorId,
      req.actor!.level as "L1" | "L2" | "L3" | "L4" | "SYSTEM",
    );
    res.json({
      configurationId: out.configuration.id,
      entryId: out.configuration.entryId,
      queriedAt: out.configuration.createdAt.toISOString(),
      isStale: out.configuration.isStale,
      results: out.result,
      ...("spaceAllocation" in out && out.spaceAllocation ? { spaceAllocation: out.spaceAllocation } : {}),
    });
  } catch (e) {
    next(e);
  }
});

availabilityRouter.post(
  "/entries/:id/availability/query",
  requireActorLevel("L1"),
  validateBody(queryAvailabilityByEntryRequestSchema),
  async (req, res, next) => {
    try {
      const out = await s1AvailabilityService.queryAvailability(prisma, req.params.id, req.actor!.actorId, req.actor!.level as any, req.body);
      res.json(out);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * What the rooms on the S1 table cost, night by night and for the stay (2026-10-10). A pure read:
 * the picks need not be saved, nothing is written. Room only, at the rate the quotation defaults to.
 */
availabilityRouter.post(
  "/entries/:id/availability/price-pick",
  requireActorLevel("L1"),
  validateBody(priceRoomPickRequestSchema),
  async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await priceRoomPick(prisma, req.params.id, req.body));
    } catch (e) {
      next(e);
    }
  },
);

/**
 * The house by room type, night by night, over the booking's stay — and whether its rooms fit with
 * one room for each guest's whole stay (2026-10-28, docs/room-types-until-arrival.md, stage 1).
 * Read-only: nothing is held, moved or written. The booking's own claims are left out.
 */
availabilityRouter.post(
  "/entries/:id/availability/by-type",
  requireActorLevel("L1"),
  validateBody(houseByTypeRequestSchema),
  async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const body = req.body as import("../../dtos/04-availability/request-schemas.js").HouseByTypeRequestDto;
      res.json(
        await answerHouseByType(prisma, req.params.id, {
          checkInDate: body.checkInDate,
          checkOutDate: body.checkOutDate,
          bookingRooms: body.bookingRooms?.map((r) => ({
            key: r.key,
            nights: r.nights.map((n) => ({
              date: n.date,
              roomTypeId: n.roomTypeId,
              roomId: n.roomId ?? null,
              fixed: n.fixed === true && !!n.roomId,
            })),
          })),
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);

/** Save (or, with `preview`, try) the Inquiry step's pick BY TYPE; the system chooses the rooms. */
availabilityRouter.post(
  "/entries/:id/availability/by-type/seal",
  requireActorLevel("L1"),
  validateBody(sealByTypeRequestSchema),
  async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
      res.json(await sealBookingRoomsByType(prisma, req.params.id, actor, req.body, { preview: req.body.preview === true }));
    } catch (e) {
      next(e);
    }
  },
);

/** This booking's rooms: chosen by the system (and still movable) or fixed, with their labels. */
availabilityRouter.get("/entries/:id/booking-rooms", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await describeBookingRooms(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/**
 * For "Give it this room": the other rooms of the type over the room's nights, and what giving each
 * would do (free, another booking's quiet room moved out of the way, held, out of order).
 */
availabilityRouter.get("/entries/:id/booking-rooms/choices", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const fromRoomId = String(req.query.fromRoomId ?? "");
    if (!fromRoomId) {
      res.status(400).json({ message: "Name the room (fromRoomId)" });
      return;
    }
    res.json(await listQuietRoomChoices(prisma, req.params.id, fromRoomId));
  } catch (e) {
    next(e);
  }
});

/** The desk chooses the booking's rooms itself (same type, before Arrival) — one, or several from the chart; they become fixed. */
availabilityRouter.post(
  "/entries/:id/booking-rooms/choose",
  requireActorLevel("L1"),
  validateBody(chooseQuietRoomRequestSchema),
  async (req, res, next) => {
    try {
      const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
      const picks = req.body.picks ?? [{ fromRoomId: req.body.fromRoomId, toRoomId: req.body.toRoomId }];
      res.json(await chooseQuietRooms(prisma, req.params.id, actor, picks));
    } catch (e) {
      next(e);
    }
  },
);

// SIG-S1 route alias
availabilityRouter.post("/availability/search", requireActorLevel("L1"), validateBody(queryAvailabilitySearchRequestSchema), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.queryAvailability(prisma, req.body.entryId, req.actor!.actorId, req.actor!.level as any, req.body);
    res.json({
      configurationId: out.configuration.id,
      entryId: out.configuration.entryId,
      queriedAt: out.configuration.createdAt.toISOString(),
      isStale: out.configuration.isStale,
      results: out.result,
      ...("spaceAllocation" in out && out.spaceAllocation ? { spaceAllocation: out.spaceAllocation } : {}),
    });
  } catch (e) {
    next(e);
  }
});

availabilityRouter.patch(
  "/availability/configurations/:id/select",
  requireActorLevel("L1"),
  validateBody(selectAvailabilityOptionRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await s1AvailabilityService.selectOption(prisma, req.params.id, req.actor!.actorId, req.body);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Operational space list (L1+), mirroring `/rooms`.
 *
 * `/admin/spaces` is L4-only — correct for editing the inventory, but the desk needs to SEE
 * spaces to report faults against them, and front desk are not admins. Read-only: creating,
 * renaming and deleting spaces stay on the admin surface.
 */
availabilityRouter.get("/spaces", requireActorLevel("L1"), async (_req, res, next) => {
  try {
    const items = await prisma.space.findMany({
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        spaceType: true,
        capacity: true,
        defaultCapacity: true,
        isAvailable: true,
        isEventInProgress: true,
        isDeficient: true,
      },
    });
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});
