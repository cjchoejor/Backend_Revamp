import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/apartment-admin-service.js";

/** The hotel's service apartments, let by the week or the month (2026-11-25). L4. */
export const adminApartmentRouter = Router();

const L4 = requireActorLevel("L4");

// Shapes only: what is wrong with a value is said in words by the service.
const amount = z.union([z.number(), z.string()]);

const packageSchema = z.object({
  name: z.string().max(200),
  carpetAreaSqft: z.union([z.number().int(), z.string().trim()]).optional().nullable(),
  amenities: z.string().max(4000).optional().nullable(),
  ratesWithTaxes: z.boolean(),
  weeklyRate: amount,
  monthlyRate: amount,
  sortOrder: z.number().optional().nullable(),
  amenityKit: z.array(z.object({ name: z.string().max(200), count: z.number() })).max(100).optional().nullable(),
  units: z
    .array(
      z.object({
        label: z.string().max(60),
        maxOccupants: z.number(),
        roomIds: z.array(z.string().min(1)).max(10),
      }),
    )
    .max(100),
});

const workOutSchema = z.object({
  weekly: z.union([z.number(), z.string()]).optional().nullable(),
  monthly: z.union([z.number(), z.string()]).optional().nullable(),
  withTaxes: z.boolean(),
});

adminApartmentRouter.get("/apartment-packages", L4, async (_req, res, next) => {
  try {
    const [list, rooms] = await Promise.all([svc.listApartmentPackages(prisma), svc.listRoomsForApartments(prisma)]);
    res.set("Cache-Control", "no-store").json({ ...list, rooms });
  } catch (e) {
    next(e);
  }
});

/** The rates as they will be stored and billed, from what was typed. Saves nothing. */
adminApartmentRouter.post("/apartment-packages/work-out", L4, validateBody(workOutSchema), async (req, res, next) => {
  try {
    res.json(await svc.workOutApartmentRates(prisma, req.body));
  } catch (e) {
    next(e);
  }
});

adminApartmentRouter.post("/apartment-packages", L4, validateBody(packageSchema), async (req, res, next) => {
  try {
    res.status(201).json(await svc.createApartmentPackage(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminApartmentRouter.put("/apartment-packages/:id", L4, validateBody(packageSchema), async (req, res, next) => {
  try {
    res.json(await svc.updateApartmentPackage(prisma, req.params.id, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminApartmentRouter.post("/apartment-packages/:id/active", L4, validateBody(z.object({ isActive: z.boolean() })), async (req, res, next) => {
  try {
    res.json(await svc.setApartmentPackageActive(prisma, req.params.id, req.body.isActive, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

/** The hotel's list of items an apartment may hold, and the apartments' extra bed rate (2026-11-27). */
adminApartmentRouter.get("/apartment-extras", L4, async (_req, res, next) => {
  try {
    res.set("Cache-Control", "no-store").json(await svc.getApartmentExtras(prisma));
  } catch (e) {
    next(e);
  }
});

adminApartmentRouter.put("/apartment-extras/amenity-items", L4, validateBody(z.object({ items: z.array(z.string().max(200)).max(300) })), async (req, res, next) => {
  try {
    res.json(await svc.setApartmentAmenityItems(prisma, req.body.items, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminApartmentRouter.put(
  "/apartment-extras/extra-bed-rate",
  L4,
  validateBody(z.object({ rate: z.union([z.number(), z.string()]).optional().nullable(), withTaxes: z.boolean() })),
  async (req, res, next) => {
    try {
      res.json(await svc.setApartmentExtraBedRate(prisma, req.body, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  },
);

adminApartmentRouter.delete("/apartment-packages/:id", L4, async (req, res, next) => {
  try {
    res.json(await svc.deleteApartmentPackage(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
