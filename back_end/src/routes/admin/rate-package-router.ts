import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/rate-package-admin-service.js";

export const adminRatePackageRouter = Router();

const L4 = requireActorLevel("L4");

const decimal = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]);
const rate = decimal.optional().nullable();

const savePackageSchema = z.object({
  // Owner: exactly one, or neither for the house COMMON package. The service derives `scope`
  // from these and the DB check constraint refuses any mismatch.
  travelAgentId: z.string().trim().min(1).optional().nullable(),
  corporateAccountId: z.string().trim().min(1).optional().nullable(),
  name: z.string().trim().min(1).max(120),
  roomBaseRate: decimal,
  extraBedRate: rate,
  cnbPercent: z.number().int().min(0).max(100).optional().nullable(),
  breakfastRate: rate,
  lunchRate: rate,
  dinnerRate: rate,
  cpRate: rate,
  mapLunchRate: rate,
  mapDinnerRate: rate,
  apRate: rate,
  currency: z.string().trim().min(1).max(10).optional(),
  rateIsTaxInclusive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const overrideSchema = z.object({
  roomTypeId: z.string().trim().min(1),
  roomBaseRate: decimal,
  notes: z.string().trim().max(500).optional().nullable(),
});

/** Owner comes from the query string on reads: ?travelAgentId= | ?corporateAccountId= | neither = COMMON. */
function ownerFromQuery(q: Record<string, unknown>) {
  const ta = typeof q.travelAgentId === "string" && q.travelAgentId ? q.travelAgentId : null;
  const ca = typeof q.corporateAccountId === "string" && q.corporateAccountId ? q.corporateAccountId : null;
  return { travelAgentId: ta, corporateAccountId: ca };
}

/** Active packages for a party, or the house COMMON package when no owner is given. */
adminRatePackageRouter.get("/rate-packages", L4, async (req, res, next) => {
  try {
    res.json({ items: await svc.listPackages(prisma, ownerFromQuery(req.query as never)) });
  } catch (e) {
    next(e);
  }
});

/** Every version ever, for the audit view. */
adminRatePackageRouter.get("/rate-packages/history", L4, async (req, res, next) => {
  try {
    res.json({ items: await svc.listPackageHistory(prisma, ownerFromQuery(req.query as never)) });
  } catch (e) {
    next(e);
  }
});

/** Create a package, or a new version of one with the same name. Supersedes rather than edits. */
adminRatePackageRouter.post("/rate-packages", L4, validateBody(savePackageSchema), async (req, res, next) => {
  try {
    const { travelAgentId, corporateAccountId, ...input } = req.body;
    const saved = await svc.savePackage(prisma, { travelAgentId, corporateAccountId }, input, req.actor!.actorId);
    res.status(201).json(saved);
  } catch (e) {
    next(e);
  }
});

adminRatePackageRouter.post("/rate-packages/:id/default", L4, async (req, res, next) => {
  try {
    res.json(await svc.setDefaultPackage(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

/** Retire = close with effectiveTo. Never deleted — quotes and inquiries reference it. */
adminRatePackageRouter.post("/rate-packages/:id/retire", L4, async (req, res, next) => {
  try {
    res.json(await svc.retirePackage(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminRatePackageRouter.put("/rate-packages/:id/overrides", L4, validateBody(overrideSchema), async (req, res, next) => {
  try {
    res.json(await svc.setRoomTypeOverride(prisma, req.params.id, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminRatePackageRouter.delete("/rate-packages/overrides/:overrideId", L4, async (req, res, next) => {
  try {
    res.json(await svc.deleteRoomTypeOverride(prisma, req.params.overrideId));
  } catch (e) {
    next(e);
  }
});
