import { Router } from "express";
import { prisma } from "../../db.js";
import {
  allocateConferenceSpaceRequestSchema,
  approveFocGmRequestSchema,
  conferenceVerifyRequestSchema,
  confirmCoordinatorRequestSchema,
  confirmReservationRequestSchema,
  createRoomAssignmentRequestSchema,
  ensureProvisionalFolioRequestSchema,
  multiBookingAckRequestSchema,
  patchPreArrivalTaskRequestSchema,
  placeCommittedHoldRequestSchema,
  progressStageRequestSchema,
  s3ReEntryRequestSchema,
  schedulePaymentMilestonesRequestSchema,
} from "../../dtos/06-reservations/request-schemas.js";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceEntryNotClosedForStageProgression } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as entryService from "../../services/domain/entry-service.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";
import * as preArrivalService from "../../services/domain/pre-arrival-service.js";
import * as roomAssignmentService from "../../services/domain/room-assignment-service.js";
import * as spaceAllocationService from "../../services/domain/space-allocation-service.js";
import * as s3HoldService from "../../services/domain/s3-hold-service.js";
import * as s3ReEntryService from "../../services/domain/s3-reentry-service.js";
import * as s3ReservationSetupService from "../../services/domain/s3-reservation-setup-service.js";
import * as s3UseTypeService from "../../services/domain/s3-use-type-service.js";
import * as reservationService from "../../services/domain/reservation-service.js";
import * as s8CheckoutService from "../../services/domain/s8-checkout-service.js";
import * as s8S9StateMachine from "../../state-machines/s8-s9-state-machine.js";
import { Stage } from "@prisma/client";

export const reservationsRouter = Router();

reservationsRouter.post("/entries/:id/confirm", requireActorLevel("L1"), validateBody(confirmReservationRequestSchema), async (req, res, next) => {
  try {
    const out = await reservationService.confirmReservation(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json({ reservation: out.reservation, entry: out.entry });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/progress-stage", requireActorLevel("L1"), validateBody(progressStageRequestSchema), async (req, res, next) => {
  try {
    const current = await prisma.entry.findUnique({ where: { id: req.params.id } });
    if (current) enforceEntryNotClosedForStageProgression({ status: current.status });
    const { targetStage, version, guestPhysicallyPresent, transitionData } = req.body;
    const guestPresent =
      guestPhysicallyPresent === true ||
      (transitionData && typeof transitionData === "object" && transitionData.guestPresentConfirmation === true);

    if (!current) {
      next(new NotFoundError("Entry"));
      return;
    }

    if (targetStage === "S7" && current.currentStage === Stage.S8) {
      const td = transitionData && typeof transitionData === "object" ? transitionData : {};
      const r = typeof td.reEntryReason === "string" ? td.reEntryReason : "";
      if (!r.trim()) {
        next(new ValidationError("transitionData.reEntryReason is required for S8→S7 re-entry"));
        return;
      }
      const updated = await entryService.reEnterS8ToS7(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
        r,
      );
      res.json(updated);
      return;
    }

    if (targetStage === "S2" && current.currentStage === Stage.S8) {
      if (!["L2", "L3", "L4"].includes(req.actor!.level)) {
        next(new AuthorizationError("S8→S2 re-entry requires L2+ authority"));
        return;
      }
      const td = transitionData && typeof transitionData === "object" ? transitionData : {};
      const r = typeof td.reEntryReason === "string" ? td.reEntryReason : "";
      if (!r.trim()) {
        next(new ValidationError("transitionData.reEntryReason is required for S8→S2 re-entry"));
        return;
      }
      const updated = await entryService.reEnterS8ToS2(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
        r,
      );
      res.json(updated);
      return;
    }

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

    if (targetStage === "S4") {
      if (typeof version !== "number") {
        next(new ValidationError("version is required for S3→S4 progression"));
        return;
      }
      await reservationService.confirmReservation(prisma, req.params.id, req.actor!.actorId, { version });
      const entryAfterConfirm = await prisma.entry.findUnique({
        where: { id: req.params.id },
        include: {
          reservation: true,
          folio: {
            include: {
              invoices: { orderBy: { createdAt: "desc" } },
              payments: { orderBy: { createdAt: "desc" } },
              billingModelTransitions: { orderBy: { createdAt: "desc" }, take: 10 },
            },
          },
          cancellationDisclosure: true,
          guestProfile: true,
          handoffs: { orderBy: { createdAt: "desc" } },
          committedHold: true,
          quotations: { orderBy: { versionNumber: "desc" } },
          segments: { orderBy: { segmentNumber: "desc" }, take: 5 },
        },
      });
      if (!entryAfterConfirm) {
        next(new NotFoundError("Entry"));
        return;
      }
      res.json(entryAfterConfirm);
      return;
    }

    if (targetStage === "S7") {
      const td = transitionData && typeof transitionData === "object" ? transitionData : {};
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
      const updated = await entryService.progressStageS7ToS8(prisma, req.params.id, req.actor!.actorId, typeof version === "number" ? version : undefined);
      res.json(updated);
      return;
    }

    if (targetStage === "S9") {
      const updated = await s8S9StateMachine.progressStageS8ToS9(prisma, req.params.id, req.actor!.actorId, typeof version === "number" ? version : undefined);
      res.json(updated);
      return;
    }

    next(
      new ValidationError(
        'targetStage must be "S2" (S1→S2 or S8→S2 with L2+), "S3" (S2→S3), "S4" (S3→S4 confirm), "S6" (S5→S6), "S7" (S6→S7 or S8→S7 re-entry), "S8" (S7→S8 stay exit), or "S9" (S8→S9 closure)',
      ),
    );
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/multi-booking/ack", requireActorLevel("L2"), validateBody(multiBookingAckRequestSchema), async (req, res, next) => {
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
        payload: { entryId: req.params.id, note: req.body.note ?? null },
        createdBy: req.actor!.actorId,
      },
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/conference/verify", requireActorLevel("L2"), validateBody(conferenceVerifyRequestSchema), async (req, res, next) => {
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
        payload: { entryId: req.params.id, checklist: req.body.checklist ?? null },
        createdBy: req.actor!.actorId,
      },
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

reservationsRouter.patch("/pre-arrival-tasks/:id", requireActorLevel("L1"), validateBody(patchPreArrivalTaskRequestSchema), async (req, res, next) => {
  try {
    const { action, waivedReason } = req.body;
    const updated = await preArrivalService.updatePreArrivalTask(prisma, req.params.id, req.actor!.actorId, action, waivedReason);
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

reservationsRouter.post("/entries/:id/room-assignments", requireActorLevel("L1"), validateBody(createRoomAssignmentRequestSchema), async (req, res, next) => {
  try {
    const { roomId, notes, deficientAcknowledgement, reEntryToS1 } = req.body;
    if (reEntryToS1 === true) {
      await entryService.reEnterS6ToS1(prisma, req.params.id, req.actor!.actorId);
    }
    const created = await roomAssignmentService.assignRoom(
      prisma,
      req.params.id,
      roomId,
      req.actor!.actorId,
      notes,
      deficientAcknowledgement,
      { reEntryToS1: reEntryToS1 === true },
    );
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post(
  "/entries/:id/spaces/allocate",
  requireActorLevel("L1"),
  validateBody(allocateConferenceSpaceRequestSchema),
  async (req, res, next) => {
    try {
      const created = await spaceAllocationService.allocateConferenceSpace(prisma, req.params.id, req.actor!.actorId, req.body);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

reservationsRouter.post("/entries/:id/folio/provisional", requireActorLevel("L1"), validateBody(ensureProvisionalFolioRequestSchema), async (req, res, next) => {
  try {
    const created = await s3ReservationSetupService.ensureProvisionalFolioAndBillingModel(prisma, req.params.id, req.actor!.actorId, req.body);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/holds/committed", requireActorLevel("L1"), validateBody(placeCommittedHoldRequestSchema), async (req, res, next) => {
  try {
    const out = await s3HoldService.placeCommittedHold(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/re-entry/s2", requireActorLevel("L2"), validateBody(s3ReEntryRequestSchema), async (req, res, next) => {
  try {
    const result = await s3ReEntryService.initiateS3ToS2Backflow(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/re-entry/s1", requireActorLevel("L2"), validateBody(s3ReEntryRequestSchema), async (req, res, next) => {
  try {
    const updated = await s3ReEntryService.initiateS3ToS1Backflow(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post("/entries/:id/foc/gm-approve", requireActorLevel("L3"), validateBody(approveFocGmRequestSchema), async (req, res, next) => {
  try {
    const out = await s3UseTypeService.approveFocGm(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reservationsRouter.post(
  "/entries/:id/coordinator/confirm",
  requireActorLevel("L1"),
  validateBody(confirmCoordinatorRequestSchema),
  async (req, res, next) => {
    try {
      const out = await s3UseTypeService.confirmCoordinator(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
      res.json(out);
    } catch (e) {
      next(e);
    }
  },
);

reservationsRouter.post(
  "/entries/:id/payment-milestones/schedule",
  requireActorLevel("L1"),
  validateBody(schedulePaymentMilestonesRequestSchema),
  async (req, res, next) => {
    try {
      const out = await s3UseTypeService.schedulePaymentMilestones(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
      res.status(201).json(out);
    } catch (e) {
      next(e);
    }
  },
);
