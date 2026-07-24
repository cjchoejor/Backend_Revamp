import { Router } from "express";
import { prisma } from "../../db.js";
import { finalizeDeficientConditionRequestSchema } from "../../dtos/16-deficient/request-schemas.js";
import { NotFoundError } from "../../lib/errors.js";
import { enforceDeficientResolutionEvidence } from "../../policies/19-deficient-condition/p50-deficient-resolution-tracking.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";

export const deficientConditionsRouter = Router();

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

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.deficientConditionRecord.update({
          where: { id: req.params.id },
          data: {
            status,
            resolvedAt,
            resolvedBy,
            resolutionNotes: resolutionNotes?.trim() || null,
          },
        });
        if (status === "RESOLVED") {
          await tx.room.update({
            where: { id: record.roomId },
            data: { isDeficient: false, updatedAt: now },
          });
        }
        return row;
      });

      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
