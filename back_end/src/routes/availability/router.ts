import { Router } from "express";
import { prisma } from "../../db.js";
import {
  queryAvailabilityByEntryRequestSchema,
  queryAvailabilitySearchRequestSchema,
  selectAvailabilityOptionRequestSchema,
} from "../../dtos/04-availability/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s1AvailabilityService from "../../services/domain/s1-availability-service.js";
import { releaseRoomBlock } from "../../services/domain/room-block-release-service.js";
import { ROOM_BED_TYPES, bedTypeConversionGroup, setRoomBedType } from "../../services/domain/room-bed-type-service.js";

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
      },
    );
    res.json(out);
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
          },
        },
      },
    });
    // Per-room ALLOWED bed types (2026-08-12, operator ruling): every setup THIS room's own
    // bed stock can be arranged into — King ⇄ Twin are the same beds arranged differently,
    // so a Twin room offers both; 301's Queen converts into nothing, so 301 offers Queen
    // alone and no other room ever shows it. The convertibility fact lives in
    // `bedTypeConversionGroup` (room-bed-type-service); everything here derives from each
    // room's live registry row, so adding a room or changing a bed moves every dropdown
    // automatically — nothing hardcoded, no config key.
    const withAllowed = items.map((r) => ({ ...r, allowedBedTypes: bedTypeConversionGroup(r.bedType).sort() }));
    // `bedTypes` stays the full vocabulary the write endpoint accepts (API-level truth);
    // the desk's dropdowns read the per-room `allowedBedTypes` above.
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
