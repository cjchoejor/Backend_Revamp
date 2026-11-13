/**
 * Document download routes — serve the stored PDF artifacts for quotations, invoices, and
 * confirmation vouchers. Every route reads the SAME stored file the guest received (never
 * re-renders on demand). If the file isn't yet rendered, we generate it on first request
 * for internal actors so admin doesn't hit a 404 mid-workflow.
 *
 * Auth: L1+ (any authenticated staff) can download. Guest-facing links come via email
 * attachment, not this API — this surface is for staff reprint / audit only.
 */
import { resolveSendTo } from "../../lib/send-to.js";
import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { NotFoundError } from "../../lib/errors.js";
import { readDocument } from "../../lib/document-storage.js";
import { generateOrLoadQuotationPdf, quotationPriceLines, renderQuotationPdfFace, renderQuotationPreviewHtml } from "../../services/domain/quotation-pdf-service.js";
import { entryNightsShorten, readNightsMode } from "../../lib/room-nights-for-entry.js";
import { describePaperRoomTypes, readRoomTypesQuery, roomTypesHiddenFor } from "../../lib/paper-room-types.js";
import { generateOrLoadInvoicePdf, renderInvoicePreviewHtml, renderProformaPdfFace } from "../../services/domain/invoice-pdf-service.js";
import { generateOrLoadConfirmationVoucherPdf } from "../../services/domain/confirmation-voucher-pdf-service.js";
import { generateCancellationConfirmationPdf } from "../../services/domain/cancellation-confirmation-pdf-service.js";
import { readCancellationFiguresFromTrace } from "../../services/domain/cancellation-confirmation-figures.js";
import {
  isFolioDocumentKind,
  listFolioDocuments,
  printFolioDocumentPdf,
  renderFolioDocumentHtml,
  sendFolioDocument,
} from "../../services/domain/folio-statement-service.js";
import { z } from "zod";
import { validateBody } from "../../middleware/validate-body.js";

/** Send the statement so far or the master bill (2026-11-10). */
const sendFolioDocumentSchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  to: z.string().trim().max(200).optional().nullable(),
  nightsEach: z.boolean().optional(),
});

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
    // The price-free copy and the copy with every night named are rendered fresh and never
    // stored: the stored artifact is the priced quotation with the nights written short, the
    // commercial record (2026-10-06, 2026-10-30). So is the copy with no room types an agency or a
    // company receives (`?roomTypes=hidden`, 2026-11-13).
    const hidePrices = String(req.query.prices ?? "") === "none";
    const nightsMode = readNightsMode(req.query.nights);
    const hideRoomTypes = readRoomTypesQuery(req.query.roomTypes) === true;
    if (hidePrices || nightsMode === "EACH" || hideRoomTypes) {
      const out = await renderQuotationPdfFace(prisma, q.id, { hidePrices, nightsMode, hideRoomTypes });
      bytes = out.bytes;
      filename = `${out.referenceNumber}-quotation${hidePrices ? "-no-prices" : ""}${nightsMode === "EACH" ? "-each-night" : ""}.pdf`;
    } else if (q.pdfStorageKey) {
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
    // `?prices=none` is the same document with the money taken off — what a guest who asked for
    // a quotation without prices receives (2026-10-06). Nothing about the offer changes.
    // `?nights=each` names every night instead of writing a run as its first and last (2026-10-30).
    // `?roomTypes=hidden|shown` (2026-11-13); left out, the booking's own: none for an agency or a company.
    const quote = await prisma.quotation.findUnique({ where: { id: req.params.id }, select: { entryId: true } });
    if (!quote) throw new NotFoundError("Quotation");
    const { html } = await renderQuotationPreviewHtml(prisma, req.params.id, {
      hidePrices: String(req.query.prices ?? "") === "none",
      nightsMode: readNightsMode(req.query.nights),
      hideRoomTypes: await roomTypesHiddenFor(prisma, quote.entryId, readRoomTypesQuery(req.query.roomTypes)),
    });
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
 * GET /api/entries/:id/send-to — whom a paper goes to by default (2026-11-07, lib/send-to.ts): the
 * email and the WhatsApp number every send box starts with, and whose they are. Read-only.
 */
documentsRouter.get("/entries/:id/send-to", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await resolveSendTo(prisma, req.params.id));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/papers/nights-shorten?quotationId=|invoiceId=|reservationId=|entryId= — whether the
 * paper reads differently with its nights shortened and with every night named (2026-10-30). On a
 * stay of one or two nights, or rooms never held three nights in a row, the two are the same, and
 * the desk says so instead of offering a choice that changes nothing. Staff-only (L1+).
 */
documentsRouter.get("/papers/nights-shorten", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    let entryId = q.entryId ?? null;
    // A quotation or a proforma is judged on the pick it was made on.
    let asOf: { segmentId?: string | null; asOf?: Date | null } | undefined;
    if (!entryId && q.quotationId) {
      const quote = await prisma.quotation.findUnique({ where: { id: q.quotationId }, select: { entryId: true, segmentId: true, createdAt: true } });
      entryId = quote?.entryId ?? null;
      if (quote) asOf = { segmentId: quote.segmentId, asOf: quote.createdAt };
    }
    if (!entryId && q.invoiceId) {
      const inv = await prisma.invoice.findUnique({ where: { id: q.invoiceId }, select: { entryId: true, createdAt: true } });
      entryId = inv?.entryId ?? null;
      if (inv) asOf = { asOf: inv.createdAt };
    }
    if (!entryId && q.reservationId) entryId = (await prisma.reservation.findUnique({ where: { id: q.reservationId }, select: { entryId: true } }))?.entryId ?? null;
    if (!entryId) throw new NotFoundError("Paper");
    res.setHeader("Cache-Control", "no-store");
    res.json({ entryId, differs: await entryNightsShorten(prisma, entryId, asOf) });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/papers/room-types?quotationId=|invoiceId=|reservationId=|tripPaperId=|entryId= — whether
 * this booking's papers go without room types, and whether this person may send them with (2026-11-13,
 * lib/paper-room-types.ts). The desk draws the preview's Room types choice and the send boxes from it.
 */
documentsRouter.get("/papers/room-types", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    let entryId = q.entryId ?? null;
    if (!entryId && q.quotationId) entryId = (await prisma.quotation.findUnique({ where: { id: q.quotationId }, select: { entryId: true } }))?.entryId ?? null;
    if (!entryId && q.invoiceId) entryId = (await prisma.invoice.findUnique({ where: { id: q.invoiceId }, select: { entryId: true } }))?.entryId ?? null;
    if (!entryId && q.reservationId) entryId = (await prisma.reservation.findUnique({ where: { id: q.reservationId }, select: { entryId: true } }))?.entryId ?? null;
    if (!entryId && q.tripPaperId) {
      const tp = await prisma.tripPaper.findUnique({ where: { id: q.tripPaperId }, select: { members: true } });
      entryId = (tp?.members as Array<{ entryId?: string }> | null)?.[0]?.entryId ?? null;
    }
    if (!entryId) throw new NotFoundError("Paper");
    res.setHeader("Cache-Control", "no-store");
    res.json(await describePaperRoomTypes(prisma, entryId, req.actor?.level ?? null));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/quotations/:id/price-lines — the quotation's rows and the figures under them, as data
 * (2026-10-27): the booking file's Charges tab sets the price out the way the quotation does.
 * Same build as the document; nothing written. Staff-only (L1+).
 */
documentsRouter.get("/quotations/:id/price-lines", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await quotationPriceLines(prisma, req.params.id));
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
      // The voucher with every night named, or with no room types (an agency's or a company's copy,
      // 2026-11-13), is rendered fresh and never stored (2026-10-30).
      const nightsMode = readNightsMode(req.query.nights);
      const hideRoomTypes = readRoomTypesQuery(req.query.roomTypes) === true;
      if (nightsMode === "EACH" || hideRoomTypes) {
        const out = await generateOrLoadConfirmationVoucherPdf(prisma, r.id, req.actor?.actorId ?? "SYSTEM", { nightsMode, hideRoomTypes });
        bytes = out.bytes;
        filename = out.filename;
      } else if (r.confirmationVoucherStorageKey) {
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
    // `?nights=each` names every night on the proforma's Rooms line (2026-10-30); `?roomTypes=hidden|shown`
    // its rooms with or without their types, the booking's own when left out (2026-11-13).
    const invRow = await prisma.invoice.findUnique({ where: { id: req.params.id }, select: { entryId: true } });
    if (!invRow) throw new NotFoundError("Invoice");
    const { html } = await renderInvoicePreviewHtml(prisma, req.params.id, {
      nightsMode: readNightsMode(req.query.nights),
      hideRoomTypes: await roomTypesHiddenFor(prisma, invRow.entryId, readRoomTypesQuery(req.query.roomTypes)),
    });
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
    // A proforma with every night named, or with no room types (2026-11-13), is rendered fresh and never stored (2026-10-30).
    const invNights = readNightsMode(req.query.nights);
    const invHideTypes = readRoomTypesQuery(req.query.roomTypes) === true;
    if (inv.invoiceType === "PROFORMA" && (invNights === "EACH" || invHideTypes)) {
      const out = await renderProformaPdfFace(prisma, inv.id, { nightsMode: invNights, hideRoomTypes: invHideTypes });
      bytes = out.bytes;
      filename = out.filename;
    } else if (inv.pdfStorageKey) {
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

/**
 * FOLIO DOCUMENTS (2026-08-22) — the bills that are VIEWS of the one folio: the in-stay
 * "tentative invoice" (C5 Interim Folio Statement), the Master Bill (C1 rollup) and the Tax
 * Invoice DRAFT (B1 before issue). See folio-statement-service for when each exists and why.
 *
 *   GET /api/entries/:id/folio-documents                      — the index: each document's state + why
 *   GET /api/entries/:id/folio-documents/:kind/preview-html   — inline HTML, pure read
 *   GET /api/entries/:id/folio-documents/:kind/pdf            — rendered fresh, never stored (a sealed
 *                                                               Master Bill print carries a reprint ordinal)
 *
 * The ISSUED tax invoice is deliberately NOT served here — it lives on its Invoice row and is
 * served only from its write-once PDF (`GET /api/invoices/:id/pdf`); the draft route answers
 * 409 TAX_INVOICE_ISSUED naming that invoice once it exists.
 */
documentsRouter.get("/entries/:id/folio-documents", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listFolioDocuments(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

documentsRouter.get("/entries/:id/folio-documents/:kind/preview-html", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (!isFolioDocumentKind(kind)) throw new NotFoundError("Folio document");
    // `?nights=each` names every night on the Rooms line (2026-10-30).
    const { html } = await renderFolioDocumentHtml(prisma, req.params.id, kind, { nightsMode: readNightsMode(req.query.nights) });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/entries/:id/folio-documents/:kind/send — by email with the paper attached, or recorded
 * as sent on WhatsApp (2026-11-10). The statement so far and the master bill only: a tax invoice is
 * sent from its own row once issued.
 */
documentsRouter.post("/entries/:id/folio-documents/:kind/send", requireActorLevel("L1"), validateBody(sendFolioDocumentSchema), async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (!isFolioDocumentKind(kind)) throw new NotFoundError("Folio document");
    const body = req.body as z.infer<typeof sendFolioDocumentSchema>;
    const out = await sendFolioDocument(prisma, req.params.id, kind, req.actor?.actorId ?? "SYSTEM", {
      channel: body.channel,
      to: body.to ?? null,
      nightsMode: body.nightsEach ? "EACH" : "SHORT",
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

documentsRouter.get("/entries/:id/folio-documents/:kind/pdf", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (!isFolioDocumentKind(kind)) throw new NotFoundError("Folio document");
    const actorId = req.actor?.actorId ?? "SYSTEM";
    const { bytes, filename } = await printFolioDocumentPdf(prisma, req.params.id, kind, actorId, { nightsMode: readNightsMode(req.query.nights) });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
  } catch (e) {
    next(e);
  }
});
