import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import {
  listIdPrefixAssignments,
  setIdPrefix,
  resetIdPrefix,
} from "../../services/admin/id-prefix-admin-service.js";
import { READABLE_ID_ENTITIES, type ReadableIdEntity } from "../../lib/readable-id.js";

export const adminIdPrefixRouter = Router();

const ENTITY_SET = new Set<string>(READABLE_ID_ENTITIES);

const setPrefixSchema = z.object({
  entity: z.string().refine((v) => ENTITY_SET.has(v), { message: "Unknown entity" }),
  prefix: z.string().trim().min(2).max(4),
  notes: z.string().trim().min(1).max(500).optional(),
});

const resetPrefixSchema = z.object({
  entity: z.string().refine((v) => ENTITY_SET.has(v), { message: "Unknown entity" }),
});

adminIdPrefixRouter.get("/id-prefixes", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    res.json({ assignments: await listIdPrefixAssignments(prisma) });
  } catch (e) {
    next(e);
  }
});

adminIdPrefixRouter.put("/id-prefixes", requireActorLevel("L4"), validateBody(setPrefixSchema), async (req, res, next) => {
  try {
    const assignments = await setIdPrefix(
      prisma,
      req.body.entity as ReadableIdEntity,
      req.body.prefix,
      req.actor!.actorId,
      req.body.notes ?? null,
    );
    res.json({ assignments });
  } catch (e) {
    next(e);
  }
});

adminIdPrefixRouter.post("/id-prefixes/reset", requireActorLevel("L4"), validateBody(resetPrefixSchema), async (req, res, next) => {
  try {
    const assignments = await resetIdPrefix(prisma, req.body.entity as ReadableIdEntity, req.actor!.actorId);
    res.json({ assignments });
  } catch (e) {
    next(e);
  }
});
