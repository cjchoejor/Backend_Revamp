import { Router } from "express";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { parseActorHeaders, requireActorLevel } from "../middleware/auth.js";
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
import { Stage, WorkOrderToDoStatus } from "@prisma/client";

export const s5Router = Router();

s5Router.get("/health", (_req, res) => {
  res.json({ ok: true, scope: "S5-S6-check-in-slice" });
});

s5Router.use(parseActorHeaders());

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

s5Router.post("/handoffs/:id/fulfil", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await handoffService.fulfilHandoff(prisma, req.params.id, req.actor!.actorId, req.body?.fulfilmentEvidence);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/room-assignments", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { roomId, notes, deficientAcknowledgement } = req.body ?? {};
    if (!roomId || typeof roomId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "roomId is required" }));
      return;
    }
    const created = await roomAssignmentService.assignRoom(
      prisma,
      req.params.id,
      roomId,
      req.actor!.actorId,
      typeof notes === "string" ? notes : undefined,
      deficientAcknowledgement,
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
        message: 'targetStage must be "S6" (S5→S6), "S7" (S6→S7 check-in completion), "S8" (S7→S8 stay exit), or "S9" (S8→S9 closure)',
      }),
    );
  } catch (e) {
    next(e);
  }
});

// ------------------------- S7 routes -------------------------

s5Router.post("/folios/:id/charges", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId, lineType, description, amount, currency, chargeDate } = req.body ?? {};
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
