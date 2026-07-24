import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/corporate-account-admin-service.js";

export const adminCorporateAccountRouter = Router();

const L4 = requireActorLevel("L4");

const contactModeSchema = z.enum(["PHONE", "EMAIL", "WHATSAPP", "IN_PERSON", "OTHER"]).optional().nullable();

const coordinatorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().max(200).optional().nullable(),
});

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  contactNumber: z.string().trim().max(50).optional().nullable(),
  contactEmail: z.string().trim().email().max(200).optional().nullable(),
  modeOfContact: contactModeSchema,
  gstNumber: z.string().trim().max(50).optional().nullable(),
  billingAddress: z.string().trim().max(500).optional().nullable(),
  // Spec §2.6.2 — contract references + coordinator contacts on the standing account.
  contractRefs: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  coordinators: z.array(coordinatorSchema).max(50).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

adminCorporateAccountRouter.get("/corporate-accounts", L4, async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    res.json({ accounts: await svc.listCorporateAccounts(prisma, { includeInactive }) });
  } catch (e) { next(e); }
});

adminCorporateAccountRouter.get("/corporate-accounts/search", L4, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    res.json({ matches: await svc.searchCorporateAccounts(prisma, q) });
  } catch (e) { next(e); }
});

adminCorporateAccountRouter.get("/corporate-accounts/:id", L4, async (req, res, next) => {
  try { res.json(await svc.getCorporateAccount(prisma, req.params.id)); } catch (e) { next(e); }
});

adminCorporateAccountRouter.post("/corporate-accounts", L4, validateBody(createSchema), async (req, res, next) => {
  try {
    const created = await svc.createCorporateAccount(prisma, req.body, req.actor!.actorId);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

adminCorporateAccountRouter.put("/corporate-accounts/:id", L4, validateBody(updateSchema), async (req, res, next) => {
  try { res.json(await svc.updateCorporateAccount(prisma, req.params.id, req.body, req.actor!.actorId)); } catch (e) { next(e); }
});

adminCorporateAccountRouter.post("/corporate-accounts/:id/deactivate", L4, async (req, res, next) => {
  try { res.json(await svc.deactivateCorporateAccount(prisma, req.params.id, req.actor!.actorId)); } catch (e) { next(e); }
});

adminCorporateAccountRouter.post("/corporate-accounts/:id/reactivate", L4, async (req, res, next) => {
  try { res.json(await svc.reactivateCorporateAccount(prisma, req.params.id, req.actor!.actorId)); } catch (e) { next(e); }
});
