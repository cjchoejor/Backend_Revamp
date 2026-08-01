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
  reassignFolioLineBillingModelRequestSchema,
  reassignFolioLinesBulkRequestSchema,
  recordCreditExtensionRequestSchema,
  recordFolioPaymentRequestSchema,
  setAdvanceRequirementRequestSchema,
  recordInvoicePaymentEventRequestSchema,
  updateBillingModelDefaultsRequestSchema,
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
import * as splitBillingService from "../../services/domain/split-billing-service.js";
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
      const { entryId, templateKey, billingModel } = req.body;
      const entry = await prisma.entry.findUnique({ where: { id: entryId } });
      if (!entry) throw new NotFoundError("Entry");
      // `billingModel` is only meaningful at S8/S9 — the proforma at S3 is always whole-folio
      // per the fixation model.
      const inv =
        entry.currentStage === Stage.S9
          ? await s9Service.issueInvoiceAtS9(prisma, req.params.id, req.actor!.actorId, { entryId, templateKey, billingModel })
          : entry.currentStage === Stage.S8
            ? await s8SettlementService.issueInvoiceAtS8(prisma, req.params.id, req.actor!.actorId, { entryId, templateKey, billingModel })
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
    const { ceilingAmount, reason, validForHours } = req.body;
    const out = await s3PaymentService.recordCreditExtensionApproval(
      prisma,
      { entryId: entry.id, folioId: entry.folio.id, ceilingAmount, reason, validForHours },
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
    );
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

/**
 * Operator-set advance requirement (2026-08-01): pin how much the guest must pay before the
 * booking confirms — a flat amount, or a percentage of the operative quotation's total
 * (converted to an amount server-side, Decimal-safe). CLEAR reverts to the configured
 * thresholds. Overrides the config default in the payment evaluation and prints as
 * "Advance due now" on the proforma. Returns the fresh payment-status so the desk shows
 * the new figure without a second round-trip.
 */
foliosRouter.post(
  "/entries/:id/advance-requirement",
  requireActorLevel("L1"),
  validateBody(setAdvanceRequirementRequestSchema),
  async (req, res, next) => {
    try {
      const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, include: { folio: true } });
      if (!entry || !entry.folio) {
        next(new NotFoundError("Entry/folio"));
        return;
      }
      const { mode, amount, percent } = req.body;
      await s3PaymentService.setAdvanceRequirement(
        prisma,
        { entryId: entry.id, folioId: entry.folio.id, mode, amount, percent },
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      );
      const status = await s3PaymentService.getPaymentStatus(prisma, { entryId: entry.id, folioId: entry.folio.id });
      res.json(status);
    } catch (e) {
      next(e);
    }
  },
);

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

// ─── Split-billing (Phase 2) ────────────────────────────────────────────────────
// Router-level auth is L1 minimum — the service escalates to L2+ when the folio's entry
// is at S8/S9 (settlement/closure). All three routes go through the same policy
// (`enforceSplitBillingEditAllowed`) which does the stage-aware authority check.

foliosRouter.patch(
  "/folios/:id/billing-model-defaults",
  requireActorLevel("L1"),
  validateBody(updateBillingModelDefaultsRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await splitBillingService.updateBillingModelDefaults(
        prisma,
        req.params.id,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
        req.body,
      );
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

foliosRouter.patch(
  "/folios/:id/lines/:lineId/billing-model",
  requireActorLevel("L1"),
  validateBody(reassignFolioLineBillingModelRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await splitBillingService.reassignFolioLineBillingModel(
        prisma,
        req.params.id,
        req.params.lineId,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
        req.body,
      );
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

foliosRouter.patch(
  "/folios/:id/lines/billing-model-bulk",
  requireActorLevel("L1"),
  validateBody(reassignFolioLinesBulkRequestSchema),
  async (req, res, next) => {
    try {
      const summary = await splitBillingService.reassignFolioLinesBillingModelBulk(
        prisma,
        req.params.id,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
        req.body,
      );
      res.json(summary);
    } catch (e) {
      next(e);
    }
  },
);
