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
  s6RoomChangeReEnterS1RequestSchema,
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
import { entryDetailInclude } from "../../lib/entry-detail-include.js";
import { getTimerEngine } from "../../services/infrastructure/timer-management-service.js";
import { runPreArrivalWindowActivationWorker } from "../../workers/w4-pre-arrival-window-activation-worker.js";

export const reservationsRouter = Router();

async function loadEntryDetail(entryId: string) {
  return prisma.entry.findUnique({ where: { id: entryId }, include: entryDetailInclude });
}

/** SIG-S4→S5 — manual / same-day activation (runs W4 pre-arrival worker). */
reservationsRouter.post("/entries/:id/activate-pre-arrival", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const entryId = req.params.id;
    const actorId = req.actor!.actorId;
    const before = await prisma.entry.findUnique({
      where: { id: entryId },
      select: { currentStage: true, status: true },
    });
    if (!before) {
      next(new NotFoundError("Entry"));
      return;
    }
    enforceEntryNotClosedForStageProgression({ status: before.status });

    const engine = await getTimerEngine();
    const activation = await runPreArrivalWindowActivationWorker(prisma, engine, { entryId });

    let entry = await loadEntryDetail(entryId);
    if (!entry) {
      next(new NotFoundError("Entry"));
      return;
    }

    if (activation.skipped) {
      const ok =
        activation.reason === "ALREADY_FIRED" ||
        (activation.reason === "NOT_AT_S4" && entry.currentStage === Stage.S5);
      if (!ok && entry.currentStage !== Stage.S5) {
        // Special-case the contact-person block so the operator sees a clear, actionable
        // message rather than the raw enum name.
        if (activation.reason === "MISSING_CONTACT_PERSON") {
          const detail = (activation as unknown as { detail?: { message?: string } }).detail;
          next(new ValidationError(detail?.message ?? "Contact person is mandatory before S5 activation."));
          return;
        }
        next(new ValidationError(`Pre-arrival activation could not run: ${activation.reason ?? "unknown"}`));
        return;
      }
    }

    if (entry.currentStage === Stage.S5) {
      const taskCount = await prisma.preArrivalTask.count({ where: { entryId } });
      if (taskCount === 0) {
        await preArrivalService.initialiseTasks(prisma, entryId, actorId);
        entry = await loadEntryDetail(entryId);
      }
    }

    if (!entry || entry.currentStage !== Stage.S5) {
      next(
        new ValidationError(
          "Entry must be at S4 (with confirmed reservation) to activate pre-arrival, or already at S5.",
        ),
      );
      return;
    }

    res.json(entry);
  } catch (e) {
    next(e);
  }
});

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
      const entryAfterConfirm = await loadEntryDetail(req.params.id);
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

// S6 room change — request a re-entry to S1 with a required reason. The new room is chosen
// fresh at S1; no room is selected here. Reason is recorded (AmendmentEventRecord) and traced.
reservationsRouter.post(
  "/entries/:id/s6-room-change/re-enter-s1",
  requireActorLevel("L2"),
  validateBody(s6RoomChangeReEnterS1RequestSchema),
  async (req, res, next) => {
    try {
      await entryService.reEnterS6ToS1(prisma, req.params.id, req.actor!.actorId, req.body.reason);
      const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, include: entryDetailInclude });
      if (!entry) {
        next(new NotFoundError("Entry"));
        return;
      }
      res.json(entry);
    } catch (e) {
      next(e);
    }
  },
);

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

/**
 * Bulk-assign rooms from the entry's sealed per-night AvailabilityConfiguration. Reads the
 * config's `optionSelected.perNight` and creates one RoomAssignment row per contiguous
 * (roomId, date range) slice — so a mid-stay room change is properly represented as two
 * date-scoped rows instead of one un-dated assignment. Idempotent on retry.
 */
reservationsRouter.post("/entries/:id/room-assignments/from-sealed-per-night", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await roomAssignmentService.assignRoomsFromSealedPerNight(
      prisma,
      req.params.id,
      req.actor!.actorId,
    );
    res.status(201).json({ assignments: created, count: created.length });
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
    const created = await s3ReservationSetupService.ensureProvisionalFolioAndBillingModel(
      prisma,
      req.params.id,
      req.actor!.actorId,
      req.actor!.level as "L1" | "L2" | "L3" | "L4",
      req.body,
    );
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
