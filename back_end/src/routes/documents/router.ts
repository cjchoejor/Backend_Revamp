/**
 * Document download routes — serve the stored PDF artifacts for quotations, invoices, and
 * confirmation vouchers. Every route reads the SAME stored file the guest received (never
 * re-renders on demand). If the file isn't yet rendered, we generate it on first request
 * for internal actors so admin doesn't hit a 404 mid-workflow.
 *
 * Auth: L1+ (any authenticated staff) can download. Guest-facing links come via email
 * attachment, not this API — this surface is for staff reprint / audit only.
 */
import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { NotFoundError } from "../../lib/errors.js";
import { readDocument } from "../../lib/document-storage.js";
import { generateOrLoadQuotationPdf, renderQuotationPreviewHtml } from "../../services/domain/quotation-pdf-service.js";
import { generateOrLoadInvoicePdf, renderInvoicePreviewHtml } from "../../services/domain/invoice-pdf-service.js";
import { generateOrLoadConfirmationVoucherPdf } from "../../services/domain/confirmation-voucher-pdf-service.js";
import { generateCancellationConfirmationPdf } from "../../services/domain/cancellation-confirmation-pdf-service.js";
import { readCancellationFiguresFromTrace } from "../../services/domain/cancellation-confirmation-figures.js";

export const documentsRouter = Router();

/**
 * GET /api/quotations/:id/pdf — stream the stored quotation PDF. If it hasn't been rendered
 * yet (e.g. quotation is still DRAFT and never sent), we render it on demand for internal
 * viewing. Guest-facing quotations are already rendered at send time.
 */
documentsRouter.get("/quotations/:id/pdf", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const q = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      select: { id: true, referenceNumber: true, pdfStorageKey: true, pdfChecksum: true },
    });
    if (!q) throw new NotFoundError("Quotation");

    let bytes: Buffer;
    let filename = `${q.referenceNumber}-quotation.pdf`;
    if (q.pdfStorageKey) {
      bytes = await readDocument(q.pdfStorageKey);
    } else {
      // On-demand render for internal preview. Attaches to the same immutability contract
      // once rendered — the stored file becomes the authoritative artifact.
      const actorId = req.actor?.actorId ?? "SYSTEM";
      const artifact = await generateOrLoadQuotationPdf(prisma, q.id, actorId);
      bytes = artifact.bytes;
      filename = `${artifact.invoiceNumber}-quotation.pdf`;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(bytes);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/quotations/:id/preview-html — the quotation document as inline HTML (2026-08-01).
 * Composed fresh from the quotation's CURRENT commercialTerms via the same A1 house-format
 * template the PDF uses, but with NO side effects: no PDF render, no storage write, no
 * QuotationLine snapshot, no trace. Lets the desk show the document for a DRAFT before
 * anything is generated or sent — and always reflects the latest terms (a stored PDF, by
 * contrast, is frozen at dispatch). Staff-only (L1+), same as the PDF routes.
 */
documentsRouter.get("/quotations/:id/preview-html", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { html } = await renderQuotationPreviewHtml(prisma, req.params.id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Never cache — the preview must track live edits to the draft terms.
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/reservations/:id/confirmation-voucher-pdf — stream the stored voucher for the
 * reservation. Same idempotent-render-on-demand pattern.
 */
documentsRouter.get(
  "/reservations/:id/confirmation-voucher-pdf",
  requireActorLevel("L1"),
  async (req, res, next) => {
    try {
      const r = await prisma.reservation.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          entryId: true,
          entry: { select: { inquiryId: true } },
          confirmationVoucherStorageKey: true,
          confirmationVoucherChecksum: true,
        },
      });
      if (!r) throw new NotFoundError("Reservation");

      let bytes: Buffer;
      let filename = `${r.entry.inquiryId ?? r.id}-confirmation-voucher.pdf`;
      if (r.confirmationVoucherStorageKey) {
        bytes = await readDocument(r.confirmationVoucherStorageKey);
      } else {
        const actorId = req.actor?.actorId ?? "SYSTEM";
        const artifact = await generateOrLoadConfirmationVoucherPdf(prisma, r.id, actorId);
        bytes = artifact.bytes;
        filename = artifact.filename;
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(bytes);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * GET /api/invoices/:id/preview-html — the proforma document as inline HTML (2026-08-01).
 * Composed fresh from the invoice's CURRENT data (folio payments, the desk's advance
 * requirement, accepted quote terms) via the same A2 house-format template the PDF uses,
 * with NO side effects — so the desk shows the live document, including "Advance received"
 * and "Advance due now", without generating a PDF. Proforma only; staff-only (L1+).
 */
documentsRouter.get("/invoices/:id/preview-html", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { html } = await renderInvoicePreviewHtml(prisma, req.params.id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Never cache — the preview must track payments and requirement changes live.
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/invoices/:id/pdf — stream the stored invoice PDF (PROFORMA at S3, FINAL/ROOM at
 * S8/S9). Same idempotent-render-on-demand pattern as the quotation route above.
 */
documentsRouter.get("/invoices/:id/pdf", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, invoiceNumber: true, invoiceType: true, pdfStorageKey: true, pdfChecksum: true },
    });
    if (!inv) throw new NotFoundError("Invoice");

    let bytes: Buffer;
    let filename = `${inv.invoiceNumber ?? inv.id}.pdf`;
    if (inv.pdfStorageKey) {
      bytes = await readDocument(inv.pdfStorageKey);
    } else {
      const actorId = req.actor?.actorId ?? "SYSTEM";
      const artifact = await generateOrLoadInvoicePdf(prisma, inv.id, actorId);
      bytes = artifact.bytes;
      filename = artifact.filename;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(bytes);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/entries/:id/cancellation-confirmation-pdf — the A5 Cancellation Confirmation.
 *
 * Unlike the other three, this document has no row of its own to carry a `pdfStorageKey` (see the
 * header note in cancellation-confirmation-pdf-service), so the generator derives its key from the
 * entry and the storage layer's write-once rule keeps it immutable. Figures are recovered from the
 * cancellation's own TraceEvent rather than recomputed — the document must restate the decision the
 * engine actually made, even if the ladder config has changed since.
 */
documentsRouter.get("/entries/:id/cancellation-confirmation-pdf", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, inquiryId: true },
    });
    if (!entry) throw new NotFoundError("Entry");
    if (entry.status !== "CANCELLED") {
      throw new NotFoundError("Cancellation Confirmation (entry is not cancelled)");
    }

    const figures = await readCancellationFiguresFromTrace(prisma, entry.id);
    const artifact = await generateCancellationConfirmationPdf(prisma, entry.id, figures);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${artifact.filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(artifact.bytes);
  } catch (e) {
    next(e);
  }
});
