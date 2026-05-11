import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s7AmendmentService from "../../services/application/s7-amendment-service.js";
import { Stage } from "@prisma/client";

export const amendmentsRouter = Router();

amendmentsRouter.post("/entries/:id/amend", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const { amendmentType } = req.body ?? {};
    if (amendmentType === "ROOM_CHANGE") {
      const { newRoomId, reason } = req.body ?? {};
      const updated = await s7AmendmentService.roomChangeReEntryToS1(prisma, req.actor!.actorId, {
        entryId: req.params.id,
        newRoomId,
        reason,
      });
      res.json(updated);
      return;
    }

    const { segmentId, amendmentPath, requestedBy, authorisedBy, authorityBasis, reason, priorTermsRef, newTermsSummary, folioLineId, stageAtAmendment } =
      req.body ?? {};
    const created = await s7AmendmentService.createAmendmentEvent(prisma, req.actor!.actorId, {
      entryId: req.params.id,
      segmentId,
      amendmentPath,
      amendmentType,
      requestedBy,
      authorisedBy,
      authorityBasis,
      reason,
      priorTermsRef,
      newTermsSummary,
      folioLineId,
      stageAtAmendment: stageAtAmendment === "S7" ? Stage.S7 : Stage.S7,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

amendmentsRouter.post("/entries/:id/s7-room-change/re-enter-s1", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const { newRoomId, reason } = req.body ?? {};
    if (typeof newRoomId !== "string" || !newRoomId.trim()) {
      next(new AppError(400, { error: "ValidationError", message: "newRoomId is required" }));
      return;
    }
    if (typeof reason !== "string" || !reason.trim()) {
      next(new AppError(400, { error: "ValidationError", message: "reason is required" }));
      return;
    }
    const updated = await s7AmendmentService.roomChangeReEntryToS1(prisma, req.actor!.actorId, {
      entryId: req.params.id,
      newRoomId: newRoomId.trim(),
      reason: reason.trim(),
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

