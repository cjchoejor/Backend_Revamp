import { Router } from "express";
import { prisma } from "../../db.js";
import { amendEntryRequestSchema, s7RoomChangeReEnterS1RequestSchema } from "../../dtos/08-amendments/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s7AmendmentService from "../../services/application/s7-amendment-service.js";
import { Stage } from "@prisma/client";

export const amendmentsRouter = Router();

amendmentsRouter.post("/entries/:id/amend", requireActorLevel("L2"), validateBody(amendEntryRequestSchema), async (req, res, next) => {
  try {
    const body = req.body;
    if (body.amendmentType === "ROOM_CHANGE") {
      const updated = await s7AmendmentService.roomChangeReEntryToS1(prisma, req.actor!.actorId, {
        entryId: req.params.id,
        newRoomId: body.newRoomId,
        reason: body.reason,
      });
      res.json(updated);
      return;
    }

    const {
      amendmentType,
      segmentId,
      amendmentPath,
      requestedBy,
      authorisedBy,
      authorityBasis,
      reason,
      priorTermsRef,
      newTermsSummary,
      folioLineId,
      stageAtAmendment,
    } = body;
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
      stageAtAmendment: stageAtAmendment ?? Stage.S7,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

amendmentsRouter.post(
  "/entries/:id/s7-room-change/re-enter-s1",
  requireActorLevel("L2"),
  validateBody(s7RoomChangeReEnterS1RequestSchema),
  async (req, res, next) => {
    try {
      const { newRoomId, reason } = req.body;
      const updated = await s7AmendmentService.roomChangeReEntryToS1(prisma, req.actor!.actorId, {
        entryId: req.params.id,
        newRoomId,
        reason,
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
