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
import { generateOrLoadQuotationPdf } from "../../services/domain/quotation-pdf-service.js";
import { generateOrLoadInvoicePdf } from "../../services/domain/invoice-pdf-service.js";
import { generateOrLoadConfirmationVoucherPdf } from "../../services/domain/confirmation-voucher-pdf-service.js";

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
