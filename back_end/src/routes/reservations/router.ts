import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as entryService from "../../services/domain/entry-service.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";
import * as preArrivalService from "../../services/domain/pre-arrival-service.js";
import * as roomAssignmentService from "../../services/domain/room-assignment-service.js";
import * as spaceAllocationService from "../../services/domain/space-allocation-service.js";
import * as s3HoldService from "../../services/domain/s3-hold-service.js";
import * as s3ReEntryService from "../../services/domain/s3-reentry-service.js";
import * as s3ReservationSetupService from "../../services/domain/s3-reservation-setup-service.js";
import * as s3UseTypeService from "../../services/domain/s3-use-type-service.js";
import * as s4ConfirmationService from "../../services/domain/s4-confirmation-service.js";
import * as s8CheckoutService from "../../services/domain/s8-checkout-service.js";
import { Stage } from "@prisma/client";

export const reservationsRouter = Router();

reservationsRouter.get("/entries/:id", async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({
      where: { id: req.params.id },
      include: {
        reservation: true,
        folio: true,
        guestProfile: true,
        handoffs: { orderBy: { createdAt: "desc" } },
        preArrivalTasks: true,
        roomAssignments: { include: { room: true } },
        committedHold: true,
        vipArrivalNotifications: { orderBy: { createdAt: "desc" }, take: 3 },
      },
    });
    if (!entry) {
      next(new AppError(404, { error: "NotFoundError", message: "Entry not found" }));
      return;
    }
    res.json(entry);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/confirm", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s4ConfirmationService.confirmReservation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/progress-stage", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const current = await prisma.entry.findUnique({ where: { id: req.params.id } });
    if (current?.status === "CLOSED") {
      next(new AppError(409, { error: "StateTransitionError", message: "Cannot progress stage for CLOSED entry", blockingCondition: "ENTRY_ALREADY_CLOSED" }));
      return;
    }
    const { targetStage, version, guestPhysicallyPresent, transitionData } = req.body ?? {};
    const guestPresent =
      guestPhysicallyPresent === true ||
      (transitionData && typeof transitionData === "object" && (transitionData as { guestPresentConfirmation?: boolean }).guestPresentConfirmation === true);

    if (targetStage === "S6") {
      const updated = await entryService.progressStageS5ToS6(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
        guestPresent,
      );
      res.json(updated);
      return;
    }

    if (targetStage === "S2") {
      const updated = await s1EntryService.progressS1ToS2(prisma, req.params.id, req.actor!.actorId, typeof version === "number" ? version : undefined);
      res.json(updated);
      return;
    }

    if (targetStage === "S3") {
      const updated = await s3ReservationSetupService.progressS2ToS3(prisma, req.params.id, req.actor!.actorId, typeof version === "number" ? version : undefined);
      res.json(updated);
      return;
    }

    if (targetStage === "S7") {
      const td = transitionData && typeof transitionData === "object" ? (transitionData as { keyCount?: number; registrationConfirmed?: boolean }) : {};
      const updated = await entryService.progressStageS6ToS7(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
        typeof td.keyCount === "number" ? td.keyCount : undefined,
        td.registrationConfirmed === true,
      );
      res.json(updated);
      return;
    }

    if (targetStage === "S8") {
      const updated = await entryService.progressStageS7ToS8(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
      );
      res.json(updated);
      return;
    }

    if (targetStage === "S9") {
      const updated = await s8CheckoutService.progressStageS8ToS9(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
      );
      res.json(updated);
      return;
    }

    next(
      new AppError(400, {
        error: "ValidationError",
        message:
          'targetStage must be "S2" (S1→S2), "S3" (S2→S3), "S6" (S5→S6), "S7" (S6→S7 check-in completion), "S8" (S7→S8 stay exit), or "S9" (S8→S9 closure)',
      }),
    );
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/multi-booking/ack", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const now = new Date();
    await prisma.traceEvent.create({
      data: {
        eventType: "MULTI_BOOKING.ACKNOWLEDGED",
        actorId: req.actor!.actorId,
        actorLevel: req.actor!.level,
        entityType: "Entry",
        entityId: req.params.id,
        operation: "ACK",
        timestamp: now,
        stageContext: Stage.S4,
        inquiryId: null,
        entryId: req.params.id,
        payload: { entryId: req.params.id, note: req.body?.note ?? null },
        createdBy: req.actor!.actorId,
      },
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/conference/verify", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const now = new Date();
    await prisma.traceEvent.create({
      data: {
        eventType: "CONFERENCE.VERIFIED",
        actorId: req.actor!.actorId,
        actorLevel: req.actor!.level,
        entityType: "Entry",
        entityId: req.params.id,
        operation: "VERIFY",
        timestamp: now,
        stageContext: Stage.S4,
        inquiryId: null,
        entryId: req.params.id,
        payload: { entryId: req.params.id, checklist: req.body?.checklist ?? null },
        createdBy: req.actor!.actorId,
      },
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.patch("/pre-arrival-tasks/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { action, waivedReason } = req.body ?? {};
    if (action !== "COMPLETE" && action !== "WAIVE") {
      next(new AppError(400, { error: "ValidationError", message: "action must be COMPLETE or WAIVE" }));
      return;
    }
    const updated = await preArrivalService.updatePreArrivalTask(
      prisma,
      req.params.id,
      req.actor!.actorId,
      action,
      typeof waivedReason === "string" ? waivedReason : undefined,
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/credit-ceiling-tier2-ack", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await preArrivalService.acknowledgeCreditCeilingTier2(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/room-assignments", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { roomId, notes, deficientAcknowledgement, reEntryToS1 } = req.body ?? {};
    if (!roomId || typeof roomId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "roomId is required" }));
      return;
    }
    if (reEntryToS1 === true) {
      await entryService.reEnterS6ToS1(prisma, req.params.id, req.actor!.actorId);
    }
    const created = await roomAssignmentService.assignRoom(
      prisma,
      req.params.id,
      roomId,
      req.actor!.actorId,
      typeof notes === "string" ? notes : undefined,
      deficientAcknowledgement,
      { reEntryToS1: reEntryToS1 === true },
    );
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/spaces/allocate", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { spaceCode, attendeeCount, seatingConfig } = req.body ?? {};
    const created = await spaceAllocationService.allocateConferenceSpace(prisma, req.params.id, req.actor!.actorId, {
      spaceCode,
      attendeeCount,
      seatingConfig,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/folio/provisional", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s3ReservationSetupService.ensureProvisionalFolioAndBillingModel(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/holds/committed", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s3HoldService.placeCommittedHold(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/re-entry/s2", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await s3ReEntryService.initiateS3ToS2Backflow(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/re-entry/s1", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await s3ReEntryService.initiateS3ToS1Backflow(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/foc/gm-approve", requireActorLevel("L3"), async (req, res, next) => {
  try {
    const out = await s3UseTypeService.approveFocGm(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/coordinator/confirm", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s3UseTypeService.confirmCoordinator(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/payment-milestones/schedule", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s3UseTypeService.schedulePaymentMilestones(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

