import { Router } from "express";
import { z } from "zod";
import { DeficientConditionCategory } from "@prisma/client";
import { prisma } from "../../db.js";
import { finalizeDeficientConditionRequestSchema } from "../../dtos/16-deficient/request-schemas.js";
import { NotFoundError } from "../../lib/errors.js";
import { enforceDeficientResolutionEvidence } from "../../policies/19-deficient-condition/p50-deficient-resolution-tracking.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as deficientService from "../../services/domain/deficient-condition-service.js";

export const deficientConditionsRouter = Router();

/**
 * Operational deficiency surface (2026-08-04). Previously reporting a fault was L4-only, on the
 * admin console — so a broken room stayed sellable until an admin was available. Front desk now
 * reports directly; L2+ confirms. See `deficient-condition-service.ts` for the two rules.
 */

const reportSchema = z.object({
  category: z.nativeEnum(DeficientConditionCategory),
  description: z.string().trim().min(1).max(2000),
  resolutionDeadline: z.string().datetime().optional().nullable(),
});

const verifySchema = z.object({
  accept: z.boolean(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

/** `RequestActor` carries `level`; the services take `actorLevel`. Map once, here. */
function actorOf(req: { actor?: { actorId: string; level: "L1" | "L2" | "L3" | "L4" } }) {
  return { actorId: req.actor!.actorId, actorLevel: req.actor!.level };
}

function deadlineOf(body: { resolutionDeadline?: string | null }) {
  return body.resolutionDeadline ? new Date(body.resolutionDeadline) : undefined;
}

/** Report a fault on a room. L1+ — the whole point is that front desk need not wait for admin. */
deficientConditionsRouter.post(
  "/rooms/:id/deficient-conditions",
  requireActorLevel("L1"),
  validateBody(reportSchema),
  async (req, res, next) => {
    try {
      const record = await deficientService.reportDeficiency(
        prisma,
        { roomId: req.params.id },
        { category: req.body.category, description: req.body.description, resolutionDeadline: deadlineOf(req.body) },
        actorOf(req),
      );
      res.status(201).json(record);
    } catch (e) {
      next(e);
    }
  },
);

/** Report a fault on a space. Same authority as rooms. */
deficientConditionsRouter.post(
  "/spaces/:id/deficient-conditions",
  requireActorLevel("L1"),
  validateBody(reportSchema),
  async (req, res, next) => {
    try {
      const record = await deficientService.reportDeficiency(
        prisma,
        { spaceId: req.params.id },
        { category: req.body.category, description: req.body.description, resolutionDeadline: deadlineOf(req.body) },
        actorOf(req),
      );
      res.status(201).json(record);
    } catch (e) {
      next(e);
    }
  },
);

/** Confirm or reject a pending report. L2+. Rejecting returns the target to service. */
deficientConditionsRouter.post(
  "/deficient-conditions/:id/verify",
  requireActorLevel("L2"),
  validateBody(verifySchema),
  async (req, res, next) => {
    try {
      const updated = await deficientService.verifyDeficiency(
        prisma,
        req.params.id,
        { accept: req.body.accept, notes: req.body.notes ?? null },
        actorOf(req),
      );
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

/** The supervisor's queue: reports still awaiting confirmation. */
deficientConditionsRouter.get("/deficient-conditions/pending-verification", requireActorLevel("L1"), async (_req, res, next) => {
  try {
    const items = await deficientService.listPendingVerification(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

/** Faults recorded against one room or space. */
deficientConditionsRouter.get("/rooms/:id/deficient-conditions", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json({ items: await deficientService.listForTarget(prisma, { roomId: req.params.id }) });
  } catch (e) {
    next(e);
  }
});

deficientConditionsRouter.get("/spaces/:id/deficient-conditions", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json({ items: await deficientService.listForTarget(prisma, { spaceId: req.params.id }) });
  } catch (e) {
    next(e);
  }
});

/**
 * Pre-existing finalize route. Kept for compatibility, now delegating the flag recomputation to
 * the shared service so a room with a SECOND open fault is not returned to service by resolving
 * only the first — the old inline code set `isDeficient = false` unconditionally.
 */
deficientConditionsRouter.patch(
  "/deficient-conditions/:id/finalize",
  requireActorLevel("L1"),
  validateBody(finalizeDeficientConditionRequestSchema),
  async (req, res, next) => {
    try {
      const { status, resolutionNotes } = req.body;
      const record = await prisma.deficientConditionRecord.findUnique({ where: { id: req.params.id } });
      if (!record) {
        next(new NotFoundError("DeficientConditionRecord"));
        return;
      }

      const now = new Date();
      const resolvedAt = status === "RESOLVED" ? now : null;
      const resolvedBy = status === "RESOLVED" ? req.actor!.actorId : null;
      enforceDeficientResolutionEvidence({ nextStatus: status, resolvedAt, resolvedBy });

      if (status === "RESOLVED") {
        res.json(
          await deficientService.resolveDeficiency(prisma, req.params.id, { resolutionNotes }, actorOf(req)),
        );
        return;
      }

      const updated = await prisma.deficientConditionRecord.update({
        where: { id: req.params.id },
        data: { status, resolvedAt, resolvedBy, resolutionNotes: resolutionNotes?.trim() || null },
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
