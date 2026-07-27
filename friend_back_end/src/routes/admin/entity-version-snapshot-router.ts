import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import {
  listSnapshots,
  restoreSnapshot,
  isTrackedEntityType,
  type TrackedEntityType,
} from "../../lib/admin/entity-version-snapshot.js";
import { ValidationError } from "../../lib/errors.js";

export const adminEntityVersionSnapshotRouter = Router();

/** GET /admin/version-snapshots?entityType=X&entityId=Y */
adminEntityVersionSnapshotRouter.get(
  "/version-snapshots",
  requireActorLevel("L4"),
  async (req, res, next) => {
    try {
      const entityType = String(req.query.entityType ?? "");
      const entityId = String(req.query.entityId ?? "");
      if (!entityType || !entityId) {
        throw new ValidationError("entityType and entityId are required");
      }
      if (!isTrackedEntityType(entityType)) {
        throw new ValidationError(`entityType '${entityType}' is not tracked for version history`);
      }
      const snapshots = await listSnapshots(prisma, entityType as TrackedEntityType, entityId);
      res.json({ snapshots });
    } catch (e) {
      next(e);
    }
  },
);

const restoreBodySchema = z.object({
  snapshotId: z.string().min(1),
  changeNote: z.string().trim().min(1).max(500).optional(),
});

/** POST /admin/version-snapshots/restore  body: { snapshotId, changeNote? } */
adminEntityVersionSnapshotRouter.post(
  "/version-snapshots/restore",
  requireActorLevel("L4"),
  validateBody(restoreBodySchema),
  async (req, res, next) => {
    try {
      const restored = await restoreSnapshot(prisma, {
        snapshotId: req.body.snapshotId,
        actorId: req.actor!.actorId,
        changeNote: req.body.changeNote ?? null,
      });
      res.json({ restored });
    } catch (e) {
      next(e);
    }
  },
);
