import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/house-tariff-admin-service.js";

export const adminHouseTariffRouter = Router();

const L4 = requireActorLevel("L4");

const decimalSchema = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]);
/** `null` is meaningful (not configured) and distinct from 0 (deliberately free). */
const rate = decimalSchema.optional().nullable();

const saveHouseTariffSchema = z.object({
  extraBedRate: rate,
  breakfastRate: rate,
  lunchRate: rate,
  dinnerRate: rate,
  cpRate: rate,
  mapLunchRate: rate,
  mapDinnerRate: rate,
  apRate: rate,
  currency: z.string().trim().min(1).max(10).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

/**
 * Currently-active house tariff, or null when none has been configured yet. `asOf` (ISO date)
 * resolves the tariff in force at a past moment — used to re-derive a historical quotation.
 */
adminHouseTariffRouter.get("/house-tariff", L4, async (req, res, next) => {
  try {
    const raw = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
    const asOf = raw && !Number.isNaN(raw.getTime()) ? raw : undefined;
    res.json({ active: await svc.getActiveHouseTariff(prisma, asOf) });
  } catch (e) {
    next(e);
  }
});

/** Full version history, newest first. */
adminHouseTariffRouter.get("/house-tariff/versions", L4, async (_req, res, next) => {
  try {
    res.json({ versions: await svc.listHouseTariffVersions(prisma) });
  } catch (e) {
    next(e);
  }
});

/** Save a new version. Supersedes the current one automatically (append-only). */
adminHouseTariffRouter.post("/house-tariff", L4, validateBody(saveHouseTariffSchema), async (req, res, next) => {
  try {
    res.status(201).json(await svc.saveHouseTariffVersion(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
