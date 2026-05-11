import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s7FolioLinesService from "../../services/domain/s7-folio-lines-service.js";
import * as s3PaymentService from "../../services/domain/s3-payment-service.js";
import * as s8SettlementService from "../../services/domain/s8-settlement-service.js";
import * as s9Service from "../../services/domain/s9-service.js";
import { Stage } from "@prisma/client";

export const foliosRouter = Router();

foliosRouter.post("/folios/:id/payments", requireActorLevel("L1"), async (req, res, next) => {
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

foliosRouter.post("/folios/:id/advance-payment/reconcile", requireActorLevel("L1"), async (req, res, next) => {
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

foliosRouter.get("/entries/:id/payment-status", requireActorLevel("L1"), async (req, res, next) => {
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

foliosRouter.post("/entries/:id/credit-extension", requireActorLevel("L2"), async (req, res, next) => {
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

foliosRouter.post("/folios/:id/charges", requireActorLevel("L1"), async (req, res, next) => {
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

foliosRouter.post("/folios/:id/corrections", requireActorLevel("L1"), async (req, res, next) => {
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

foliosRouter.post("/folios/:id/credit-notes", requireActorLevel("L2"), async (req, res, next) => {
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

foliosRouter.get("/folios/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const folio = await s8SettlementService.getFolio(prisma, req.params.id);
    res.json(folio);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/folios/:id/settle", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s8SettlementService.initiateSettlement(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

foliosRouter.get("/folios/:id/invoices", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const inv = await s9Service.listInvoices(prisma, req.params.id);
    res.json(inv);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/folios/:id/write-off", requireActorLevel("L3"), async (req, res, next) => {
  try {
    const created = await s9Service.writeOffOutstandingBalance(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/folios/:id/post-stay-charges", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const created = await s9Service.postStayCharge(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/invoices/:id/dispatch", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s9Service.dispatchInvoice(prisma, req.params.id, req.actor!.actorId, { dispatchedTo: req.body?.dispatchedTo });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/invoices/:id/record-payment-event", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await s9Service.recordInvoicePaymentEvent(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

