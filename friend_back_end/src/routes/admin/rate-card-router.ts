import { Router } from "express";
import { z } from "zod";
import { PartyType } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/rate-card-admin-service.js";
import { ValidationError } from "../../lib/errors.js";

export const adminRateCardRouter = Router();

const L4 = requireActorLevel("L4");

const partyTypeSchema = z.enum(["TRAVEL_AGENT", "CORPORATE"]);
const decimalSchema = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]);

const createRateCardSchema = z.object({
  partyType: partyTypeSchema,
  partyId: z.string().trim().min(1),
  roomBaseRate: decimalSchema,
  extraBedRate: decimalSchema.optional().nullable(),
  cnbPercent: z.number().int().min(0).max(100).optional().nullable(),
  breakfastRate: decimalSchema.optional().nullable(),
  lunchRate: decimalSchema.optional().nullable(),
  dinnerRate: decimalSchema.optional().nullable(),
  cpRate: decimalSchema.optional().nullable(),
  mapLunchRate: decimalSchema.optional().nullable(),
  mapDinnerRate: decimalSchema.optional().nullable(),
  apRate: decimalSchema.optional().nullable(),
  currency: z.string().trim().min(1).max(10).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const overrideSchema = z.object({
  roomTypeId: z.string().trim().min(1),
  roomBaseRate: decimalSchema,
  notes: z.string().trim().max(500).optional().nullable(),
});

function parsePartyType(s: string): PartyType {
  if (s === "TRAVEL_AGENT") return PartyType.TRAVEL_AGENT;
  if (s === "CORPORATE") return PartyType.CORPORATE;
  throw new ValidationError(`Unknown partyType: ${s}`);
}

/** List all (historical + active) rate cards for a party. */
adminRateCardRouter.get("/rate-cards", L4, async (req, res, next) => {
  try {
    const partyType = parsePartyType(String(req.query.partyType ?? ""));
    const partyId = String(req.query.partyId ?? "");
    if (!partyId) throw new ValidationError("partyId is required");
    res.json({ cards: await svc.listRateCardsForParty(prisma, partyType, partyId) });
  } catch (e) { next(e); }
});

/** Get the currently-active rate card for a party (or null). */
adminRateCardRouter.get("/rate-cards/active", L4, async (req, res, next) => {
  try {
    const partyType = parsePartyType(String(req.query.partyType ?? ""));
    const partyId = String(req.query.partyId ?? "");
    if (!partyId) throw new ValidationError("partyId is required");
    res.json({ active: await svc.getActiveRateCard(prisma, partyType, partyId) });
  } catch (e) { next(e); }
});

/** Create a NEW rate card version. Supersedes the prior active one (if any) automatically. */
adminRateCardRouter.post("/rate-cards", L4, validateBody(createRateCardSchema), async (req, res, next) => {
  try {
    const card = await svc.createRateCardVersion(
      prisma,
      { ...req.body, partyType: parsePartyType(req.body.partyType) },
      req.actor!.actorId,
    );
    res.status(201).json(card);
  } catch (e) { next(e); }
});

/** Set a room-type rate override on a rate card. Idempotent (create-or-update by composite key). */
adminRateCardRouter.put("/rate-cards/:id/overrides", L4, validateBody(overrideSchema), async (req, res, next) => {
  try {
    res.json(await svc.setRoomTypeRateOverride(prisma, req.params.id, req.body, req.actor!.actorId));
  } catch (e) { next(e); }
});

/** Delete an override by its ID. */
adminRateCardRouter.delete("/rate-cards/overrides/:overrideId", L4, async (req, res, next) => {
  try {
    res.json(await svc.deleteRoomTypeRateOverride(prisma, req.params.overrideId, req.actor!.actorId));
  } catch (e) { next(e); }
});
