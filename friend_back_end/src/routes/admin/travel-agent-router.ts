import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/travel-agent-admin-service.js";

export const adminTravelAgentRouter = Router();

const L4 = requireActorLevel("L4");

const contactModeSchema = z.enum(["PHONE", "EMAIL", "WHATSAPP", "IN_PERSON", "OTHER"]).optional().nullable();

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  contactNumber: z.string().trim().max(50).optional().nullable(),
  contactEmail: z.string().trim().email().max(200).optional().nullable(),
  modeOfContact: contactModeSchema,
  notes: z.string().trim().max(1000).optional().nullable(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

adminTravelAgentRouter.get("/travel-agents", L4, async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    res.json({ agents: await svc.listTravelAgents(prisma, { includeInactive }) });
  } catch (e) { next(e); }
});

adminTravelAgentRouter.get("/travel-agents/search", L4, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    res.json({ matches: await svc.searchTravelAgents(prisma, q) });
  } catch (e) { next(e); }
});

adminTravelAgentRouter.get("/travel-agents/:id", L4, async (req, res, next) => {
  try { res.json(await svc.getTravelAgent(prisma, req.params.id)); } catch (e) { next(e); }
});

adminTravelAgentRouter.post("/travel-agents", L4, validateBody(createSchema), async (req, res, next) => {
  try {
    const created = await svc.createTravelAgent(prisma, req.body, req.actor!.actorId);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

adminTravelAgentRouter.put("/travel-agents/:id", L4, validateBody(updateSchema), async (req, res, next) => {
  try { res.json(await svc.updateTravelAgent(prisma, req.params.id, req.body, req.actor!.actorId)); } catch (e) { next(e); }
});

adminTravelAgentRouter.post("/travel-agents/:id/deactivate", L4, async (req, res, next) => {
  try { res.json(await svc.deactivateTravelAgent(prisma, req.params.id, req.actor!.actorId)); } catch (e) { next(e); }
});

adminTravelAgentRouter.post("/travel-agents/:id/reactivate", L4, async (req, res, next) => {
  try { res.json(await svc.reactivateTravelAgent(prisma, req.params.id, req.actor!.actorId)); } catch (e) { next(e); }
});
