import { Router } from "express";
import { prisma } from "../db.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { parseActorHeaders, requireActorLevel } from "../middleware/auth.js";
import * as sessionService from "../services/session-service.js";
import * as handoffService from "../services/handoff-service.js";
import * as roomAssignmentService from "../services/room-assignment-service.js";
import * as preArrivalService from "../services/pre-arrival-service.js";
import * as entryService from "../services/entry-service.js";
import * as noShowService from "../services/no-show-service.js";
import * as cancellationService from "../services/cancellation-service.js";
import * as guestProfileService from "../services/guest-profile-service.js";
import * as s7FolioLinesService from "../services/s7-folio-lines-service.js";
import * as s7NightAuditService from "../services/s7-night-audit-service.js";
import * as s7DisputeService from "../services/s7-dispute-service.js";
import * as s7AmendmentService from "../services/s7-amendment-service.js";
import * as s7WorkOrderService from "../services/s7-work-order-service.js";
import * as s8SettlementService from "../services/s8-settlement-service.js";
import * as s8CheckoutService from "../services/s8-checkout-service.js";
import * as s9Service from "../services/s9-service.js";
import * as s1InquiryService from "../services/s1-inquiry-service.js";
import * as s1EntryService from "../services/s1-entry-service.js";
import * as s1AvailabilityService from "../services/s1-availability-service.js";
import * as s1ProcessingLockService from "../services/s1-processing-lock-service.js";
import * as s2QuotationService from "../services/s2-quotation-service.js";
import * as s3ReservationSetupService from "../services/s3-reservation-setup-service.js";
import * as s4ConfirmationService from "../services/s4-confirmation-service.js";
import * as s2HoldService from "../services/s2-hold-service.js";
import * as s3HoldService from "../services/s3-hold-service.js";
import * as s3PaymentService from "../services/s3-payment-service.js";
import * as s3DisclosureService from "../services/s3-cancellation-disclosure-service.js";
import { Stage, WorkOrderToDoStatus } from "@prisma/client";

export const s5Router = Router();

s5Router.get("/health", (_req, res) => {
  res.json({ ok: true, scope: "S5-S6-check-in-slice" });
});

s5Router.post("/auth/authenticate", async (req, res, next) => {
  try {
    const out = await sessionService.authenticate(prisma, req.body ?? {});
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/auth/switch", async (req, res, next) => {
  try {
    const out = await sessionService.pinSwitch(prisma, req.body ?? {});
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/auth/lock", async (req, res, next) => {
  try {
    const out = await sessionService.manualLock(prisma, req.body ?? {});
    res.status(200).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/auth/logout", async (req, res, next) => {
  try {
    const out = await sessionService.hardLogout(prisma, req.body ?? {});
    res.status(200).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.use(parseActorHeaders());

s5Router.post("/inquiries", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s1InquiryService.createInquiry(prisma, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s1EntryService.createEntry(prisma, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/park", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s1EntryService.parkEntry(prisma, req.params.id, req.actor!.actorId, req.body?.reason);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/unpark", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s1EntryService.unparkEntry(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/availability/query", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.queryAvailability(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// SIG-S1 route alias
s5Router.post("/availability/search", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.queryAvailability(prisma, req.body?.entryId, req.actor!.actorId, req.body ?? {});
    res.json({
      configurationId: out.configuration.id,
      entryId: out.configuration.entryId,
      queriedAt: out.configuration.createdAt.toISOString(),
      isStale: out.configuration.isStale,
      results: out.result,
    });
  } catch (e) {
    next(e);
  }
});

s5Router.patch("/availability/configurations/:id/select", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s1AvailabilityService.selectOption(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// ------------------------- S1 processing locks -------------------------

s5Router.post("/processing-locks", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1ProcessingLockService.placeLock(
      prisma,
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      req.body ?? {},
    );
    res.status(out.meta?.priorityNotice ? 200 : 201).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/processing-locks/:id/reconfirm", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1ProcessingLockService.reconfirm(prisma, req.actor!.actorId, req.params.id);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.get("/processing-locks/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1ProcessingLockService.status(prisma, req.params.id);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// ------------------------- S2 routes -------------------------

s5Router.post("/entries/:id/quotations", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s2QuotationService.createQuotation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/quotations/:id/send", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s2QuotationService.sendQuotation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/quotations/:id/accept", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s2QuotationService.acceptQuotation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/holds/speculative", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s2HoldService.placeSpeculativeHold(
      prisma,
      req.params.id,
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      req.body ?? {},
    );
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/holds/speculative/:holdId/release", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await s2HoldService.releaseSpeculativeHold(
      prisma,
      req.params.id,
      req.params.holdId,
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      req.body ?? {},
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// ------------------------- S3 routes -------------------------

s5Router.post("/entries/:id/folio/provisional", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s3ReservationSetupService.ensureProvisionalFolioAndBillingModel(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/disclosures/cancellation", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({
      where: { id: req.params.id },
      include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } },
    });
    if (!entry) {
      next(new AppError(404, { error: "NotFoundError", message: "Entry not found" }));
      return;
    }
    const segmentId = entry.segments[0]?.id;
    if (!segmentId) {
      next(new AppError(400, { error: "ValidationError", message: "Entry has no segment" }));
      return;
    }
    const out = await s3DisclosureService.recordCancellationDisclosure(
      prisma,
      { entryId: req.params.id, segmentId, noShowTreatmentStatement: req.body?.noShowTreatmentStatement, disclosedTerms: req.body?.disclosedTerms },
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
    );
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/holds/committed", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s3HoldService.placeCommittedHold(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/folios/:id/payments", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId, amount, notes } = req.body ?? {};
    if (!entryId || typeof entryId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "entryId is required" }));
      return;
    }
    const amt = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      next(new AppError(400, { error: "ValidationError", message: "amount must be positive" }));
      return;
    }
    const rec = await prisma.paymentRecord.create({
      data: {
        folioId: req.params.id,
        entryId,
        amount: amt,
        paymentDirection: "IN",
        currency: "BTN",
        receivedAt: new Date(),
        recordedBy: req.actor!.actorId,
        stage: Stage.S3,
        notes: typeof notes === "string" ? notes : null,
      },
    });
    res.status(201).json(rec);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/folios/:id/advance-payment/reconcile", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId, note } = req.body ?? {};
    if (!entryId || typeof entryId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "entryId is required" }));
      return;
    }
    const updated = await s3PaymentService.markAdvancePaymentReconciled(
      prisma,
      { entryId, folioId: req.params.id, note: typeof note === "string" ? note : undefined },
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.get("/entries/:id/payment-status", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, include: { folio: true } });
    if (!entry || !entry.folio) {
      next(new AppError(404, { error: "NotFoundError", message: "Entry/folio not found" }));
      return;
    }
    const out = await s3PaymentService.evaluateAdvancePaymentCondition(prisma, { entryId: entry.id, folioId: entry.folio.id });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/credit-extension", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, include: { folio: true } });
    if (!entry || !entry.folio) {
      next(new AppError(404, { error: "NotFoundError", message: "Entry/folio not found" }));
      return;
    }
    const { ceilingAmount, reason } = req.body ?? {};
    const amt = typeof ceilingAmount === "number" ? ceilingAmount : Number(ceilingAmount);
    const out = await s3PaymentService.recordCreditExtensionApproval(
      prisma,
      { entryId: entry.id, folioId: entry.folio.id, ceilingAmount: amt, reason },
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
    );
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/confirm", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s4ConfirmationService.confirmReservation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

s5Router.get("/entries/:id", async (req, res, next) => {
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

s5Router.post("/guest-profiles/:id/verify-identity", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId, verificationPath, documentType, documentNumber, issuingCountry, expiryDate } = req.body ?? {};
    if (!entryId || typeof entryId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "entryId is required" }));
      return;
    }
    if (!verificationPath || typeof verificationPath !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "verificationPath is required" }));
      return;
    }
    const allowed = ["FIRST_TIME", "RETURNING_VALID", "RETURNING_EXPIRED", "VIP"];
    if (!allowed.includes(verificationPath)) {
      next(new AppError(400, { error: "ValidationError", message: "verificationPath must be one of FIRST_TIME, RETURNING_VALID, RETURNING_EXPIRED, VIP" }));
      return;
    }
    const updated = await guestProfileService.recordVerification(prisma, req.params.id, req.actor!.actorId, {
      entryId,
      verificationPath: verificationPath as "FIRST_TIME" | "RETURNING_VALID" | "RETURNING_EXPIRED" | "VIP",
      documentType: typeof documentType === "string" ? documentType : undefined,
      documentNumber: typeof documentNumber === "string" ? documentNumber : undefined,
      issuingCountry: typeof issuingCountry === "string" ? issuingCountry : undefined,
      expiryDate: typeof expiryDate === "string" ? expiryDate : undefined,
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/handoffs/:id/accept", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await handoffService.acceptHandoff(prisma, req.params.id, req.actor!.actorId, req.body?.checklistCompletion);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/handoffs/:id/reject", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const reason = req.body?.rejectionReason;
    if (typeof reason !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "rejectionReason is required" }));
      return;
    }
    const updated = await handoffService.rejectHandoff(prisma, req.params.id, req.actor!.actorId, reason);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/handoffs/h2", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const roomNumber = typeof b.roomNumber === "string" ? b.roomNumber : null;
    if (!roomNumber?.trim()) {
      next(new AppError(400, { error: "ValidationError", message: "roomNumber is required" }));
      return;
    }
    const created = await handoffService.createH2(prisma, req.params.id, req.actor!.actorId, {
      roomNumber: roomNumber.trim(),
      guestProfileId: b.guestProfileId,
      deficientConditionStatus: b.deficientConditionStatus == null ? null : String(b.deficientConditionStatus),
      specialHousekeepingRequests: b.specialHousekeepingRequests,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/handoffs/:id/fulfil", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await handoffService.fulfilHandoff(prisma, req.params.id, req.actor!.actorId, req.body?.fulfilmentEvidence);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/handoffs/h4", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const created = await handoffService.createH4(prisma, req.params.id, req.actor!.actorId, {
      autoFulfilForSameDayDeparture: b.autoFulfilForSameDayDeparture === true,
      notes: typeof b.notes === "string" ? b.notes : undefined,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/room-assignments", requireActorLevel("L1"), async (req, res, next) => {
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

s5Router.patch("/pre-arrival-tasks/:id", requireActorLevel("L1"), async (req, res, next) => {
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

s5Router.post("/entries/:id/progress-stage", requireActorLevel("L1"), async (req, res, next) => {
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

// ------------------------- S7 routes -------------------------

s5Router.post("/folios/:id/charges", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId } = req.body ?? {};
    if (!entryId) {
      next(new AppError(400, { error: "ValidationError", message: "entryId is required" }));
      return;
    }
    const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
    if (!entry) throw new NotFoundError("Entry");

    // S9 additive post-stay charges (AC-S9-036/043): same route, but governed by stage + actor authority.
    if (entry.currentStage === Stage.S9) {
      if (req.actor!.level === "L1") {
        next(new AppError(403, { error: "AuthorizationError", message: "FOM authority required for S9 post-stay charges" }));
        return;
      }
      const { lineType, description, amount, currency, postedAt, isPostStay } = req.body ?? {};
      const created = await s9Service.postStayCharge(prisma, req.params.id, req.actor!.actorId, {
        entryId,
        lineType,
        description,
        amount,
        currency,
        postedAt,
        isPostStay,
      } as any);
      res.json(created);
      return;
    }

    // Default: S7 charge posting.
    const { lineType, description, amount, currency, chargeDate } = req.body ?? {};
    const allowSoftGateBypass = req.actor!.level === "L2" || req.actor!.level === "L3";
    const created = await s7FolioLinesService.postCharge(prisma, req.params.id, req.actor!.actorId, {
      entryId,
      lineType,
      description,
      amount,
      currency,
      chargeDate,
      allowSoftGateBypass,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/folios/:id/corrections", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId, originalFolioLineId, reason, correctionAmount, correctionDate } = req.body ?? {};
    const created = await s7FolioLinesService.correctCharge(prisma, req.params.id, req.actor!.actorId, {
      entryId,
      originalFolioLineId,
      reason,
      correctionAmount,
      correctionDate,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/folios/:id/credit-notes", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const { entryId, description, amount, currency, creditDate } = req.body ?? {};
    const created = await s7FolioLinesService.postCreditNote(prisma, req.params.id, req.actor!.actorId, {
      entryId,
      description,
      amount,
      currency,
      creditDate,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/night-audit/run", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const record = await s7NightAuditService.runNightAudit(prisma, req.actor!.actorId, req.body ?? {});
    res.json(record);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/disputes/open", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7DisputeService.openDispute(prisma, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/disputes/:id/close", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s7DisputeService.closeDispute(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/disputes/:id/gate-override", requireActorLevel("L3"), async (req, res, next) => {
  try {
    const { targetStage, freeTextReason } = req.body ?? {};
    if (targetStage !== "S8" && targetStage !== "S9") {
      next(new AppError(400, { error: "ValidationError", message: 'targetStage must be "S8" or "S9"' }));
      return;
    }
    const created = await s7DisputeService.createGateOverride(prisma, req.params.id, req.actor!.actorId, {
      targetStage: targetStage === "S9" ? Stage.S9 : Stage.S8,
      freeTextReason,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

// ------------------------- S8 routes -------------------------

s5Router.get("/folios/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const folio = await s8SettlementService.getFolio(prisma, req.params.id);
    res.json(folio);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/folios/:id/settle", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s8SettlementService.initiateSettlement(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/key-return", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { keyCountReturned, reconciliationNote } = req.body ?? {};
    const created = await s8CheckoutService.recordKeyReturn(prisma, req.params.id, req.actor!.actorId, { keyCountReturned, reconciliationNote });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/room-inspection", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s8CheckoutService.recordInspection(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

// ------------------------- S9 routes -------------------------

s5Router.post("/entries/:id/close", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await s9Service.closeEntryAtS9(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.get("/folios/:id/invoices", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const inv = await s9Service.listInvoices(prisma, req.params.id);
    res.json(inv);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/invoices/:id/dispatch", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s9Service.dispatchInvoice(prisma, req.params.id, req.actor!.actorId, { dispatchedTo: req.body?.dispatchedTo });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/invoices/:id/record-payment-event", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await s9Service.recordInvoicePaymentEvent(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/folios/:id/write-off", requireActorLevel("L3"), async (req, res, next) => {
  try {
    const created = await s9Service.writeOffOutstandingBalance(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/folios/:id/post-stay-charges", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const created = await s9Service.postStayCharge(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/amend", requireActorLevel("L2"), async (req, res, next) => {
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

s5Router.post("/entries/:id/s7-room-change/re-enter-s1", requireActorLevel("L2"), async (req, res, next) => {
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

s5Router.post("/work-orders", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.createWorkOrder(prisma, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/work-orders/:id/todos", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.addToDoItem(prisma, req.actor!.actorId, { workOrderId: req.params.id, ...(req.body ?? {}) });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/work-order-todos/:id/status", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { status, cancelReason } = req.body ?? {};
    if (!status || typeof status !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "status is required" }));
      return;
    }
    if (!Object.values(WorkOrderToDoStatus).includes(status as WorkOrderToDoStatus)) {
      next(new AppError(400, { error: "ValidationError", message: `status must be one of: ${Object.values(WorkOrderToDoStatus).join(", ")}` }));
      return;
    }
    const updated = await s7WorkOrderService.updateToDoStatus(prisma, req.actor!.actorId, req.params.id, { status: status as WorkOrderToDoStatus, cancelReason });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/work-orders/:id/consumption", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.recordConsumption(prisma, req.actor!.actorId, { workOrderId: req.params.id, ...(req.body ?? {}) });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/work-orders/:id/close", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s7WorkOrderService.closeWorkOrder(prisma, req.params.id);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/no-show", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const result = await noShowService.determineNoShow(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(result);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/cancel", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await cancellationService.cancelEntryAtS5(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/credit-ceiling-tier2-ack", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await preArrivalService.acknowledgeCreditCeilingTier2(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});
