import { Router } from "express";
import { prisma } from "../../db.js";
import {
  advancePaymentReconcileRequestSchema,
  correctFolioChargeRequestSchema,
  dispatchInvoiceRequestSchema,
  initiateSettlementRequestSchema,
  issueProformaInvoiceRequestSchema,
  postCreditNoteRequestSchema,
  postFolioChargesBodySchema,
  postStayChargeRequestSchema,
  recordCreditExtensionRequestSchema,
  recordFolioPaymentRequestSchema,
  recordInvoicePaymentEventRequestSchema,
  writeOffOutstandingBalanceRequestSchema,
} from "../../dtos/07-folios/request-schemas.js";
import { AuthorizationError, NotFoundError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s7FolioLinesService from "../../services/domain/s7-folio-lines-service.js";
import * as s3FolioService from "../../services/domain/s3-folio-service.js";
import * as s3PaymentService from "../../services/domain/s3-payment-service.js";
import * as s8SettlementService from "../../services/domain/s8-settlement-service.js";
import * as s9Service from "../../services/domain/s9-service.js";
import { Stage } from "@prisma/client";

export const foliosRouter = Router();

foliosRouter.post("/folios/:id/payments", requireActorLevel("L1"), validateBody(recordFolioPaymentRequestSchema), async (req, res, next) => {
  try {
    const { entryId, amount, notes } = req.body;
    const rec = await s3FolioService.recordPayment(prisma, req.params.id, req.actor!.actorId, { entryId, amount, notes: notes ?? null });
    res.status(201).json(rec);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post(
  "/folios/:id/invoices",
  requireActorLevel("L1"),
  validateBody(issueProformaInvoiceRequestSchema),
  async (req, res, next) => {
    try {
      const { entryId, templateKey } = req.body;
      const entry = await prisma.entry.findUnique({ where: { id: entryId } });
      if (!entry) throw new NotFoundError("Entry");
      const inv =
        entry.currentStage === Stage.S9
          ? await s9Service.issueInvoiceAtS9(prisma, req.params.id, req.actor!.actorId, { entryId, templateKey })
          : entry.currentStage === Stage.S8
            ? await s8SettlementService.issueInvoiceAtS8(prisma, req.params.id, req.actor!.actorId, { entryId, templateKey })
            : await s3FolioService.issueInvoice(prisma, req.params.id, req.actor!.actorId, { entryId, templateKey });
      res.status(201).json(inv);
    } catch (e) {
      next(e);
    }
  },
);

foliosRouter.post(
  "/folios/:id/advance-payment/reconcile",
  requireActorLevel("L1"),
  validateBody(advancePaymentReconcileRequestSchema),
  async (req, res, next) => {
    try {
      const { entryId, note } = req.body;
      const updated = await s3PaymentService.markAdvancePaymentReconciled(
        prisma,
        { entryId, folioId: req.params.id, note },
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      );
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

foliosRouter.get("/entries/:id/payment-status", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, include: { folio: true } });
    if (!entry || !entry.folio) {
      next(new NotFoundError("Entry/folio"));
      return;
    }
    const out = await s3PaymentService.getPaymentStatus(prisma, { entryId: entry.id, folioId: entry.folio.id });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/entries/:id/credit-extension", requireActorLevel("L2"), validateBody(recordCreditExtensionRequestSchema), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, include: { folio: true } });
    if (!entry || !entry.folio) {
      next(new NotFoundError("Entry/folio"));
      return;
    }
    const { ceilingAmount, reason } = req.body;
    const out = await s3PaymentService.recordCreditExtensionApproval(
      prisma,
      { entryId: entry.id, folioId: entry.folio.id, ceilingAmount, reason },
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
    );
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/folios/:id/charges", requireActorLevel("L1"), validateBody(postFolioChargesBodySchema), async (req, res, next) => {
  try {
    const { entryId } = req.body;
    const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
    if (!entry) throw new NotFoundError("Entry");

    if (entry.currentStage === Stage.S9) {
      if (req.actor!.level === "L1") {
        next(new AuthorizationError("FOM authority required for S9 post-stay charges"));
        return;
      }
      const { lineType, description, amount, currency, postedAt, isPostStay } = req.body;
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

    const { lineType, description, amount, currency, chargeDate } = req.body;
    const allowSoftGateBypass = req.actor!.level === "L2" || req.actor!.level === "L3";
    const created = await s7FolioLinesService.postCharge(prisma, req.params.id, req.actor!.actorId, {
      entryId,
      lineType,
      description,
      amount,
      currency,
      chargeDate,
      allowSoftGateBypass,
    } as any);
    res.json(created);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/folios/:id/corrections", requireActorLevel("L1"), validateBody(correctFolioChargeRequestSchema), async (req, res, next) => {
  try {
    const created = await s7FolioLinesService.correctCharge(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(created);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/folios/:id/credit-notes", requireActorLevel("L2"), validateBody(postCreditNoteRequestSchema), async (req, res, next) => {
  try {
    const created = await s7FolioLinesService.postCreditNote(prisma, req.params.id, req.actor!.actorId, req.body);
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

foliosRouter.post("/folios/:id/settle", requireActorLevel("L1"), validateBody(initiateSettlementRequestSchema), async (req, res, next) => {
  try {
    const updated = await s8SettlementService.initiateSettlement(prisma, req.params.id, req.actor!.actorId, req.body);
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

foliosRouter.post("/folios/:id/write-off", requireActorLevel("L3"), validateBody(writeOffOutstandingBalanceRequestSchema), async (req, res, next) => {
  try {
    const created = await s9Service.writeOffOutstandingBalance(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(created);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/folios/:id/post-stay-charges", requireActorLevel("L2"), validateBody(postStayChargeRequestSchema), async (req, res, next) => {
  try {
    const created = await s9Service.postStayCharge(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(created);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post("/invoices/:id/dispatch", requireActorLevel("L1"), validateBody(dispatchInvoiceRequestSchema), async (req, res, next) => {
  try {
    const updated = await s9Service.dispatchInvoice(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

foliosRouter.post(
  "/invoices/:id/record-payment-event",
  requireActorLevel("L2"),
  validateBody(recordInvoicePaymentEventRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await s9Service.recordInvoicePaymentEvent(prisma, req.params.id, req.actor!.actorId, req.body);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
