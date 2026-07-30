/**
 * A5 · Cancellation Confirmation — generator.
 *
 * WHY THIS EXISTS
 * ---------------
 * The cancellation engine ([cancellation-service.ts](../application/cancellation-service.ts)) already
 * does the commercial work at all three entry points — releases the hold, cancels timers, supersedes
 * in-flight proformas, posts the penalty line, raises the refund payment and closes the entry — but
 * it produced **no guest-facing artifact**. Every other governed money event in the system emits a
 * document (quotation, proforma, voucher, tax invoice); a cancellation that retains part of a
 * guest's advance was the one that did not, so the guest received a refund with nothing stating
 * what was kept or under which band of the ladder.
 *
 * WHERE IT HOOKS IN
 * -----------------
 * Post-transaction and best-effort, exactly like the stage emails and the S4 voucher: the
 * cancellation must never fail because a PDF could not render. `cancelEntryAtS3` and
 * `cancelEntryAtS5` call `generateCancellationConfirmationPdf` after their transaction commits,
 * and `GET /api/entries/:id/cancellation-confirmation-pdf` serves or lazily renders it.
 *
 * PERSISTENCE — A DELIBERATE LIMIT
 * --------------------------------
 * There is no cancellation-event row to hang the artifact pointer on. `CancellationDisclosureRecord`
 * is the S3 *disclosure of terms* (`entryId @unique`, written long before any cancellation), not the
 * event, and the cancellation itself lives only as `Entry.status = CANCELLED` plus a TraceEvent. So
 * unlike Invoice / Quotation / Reservation — each of which owns `pdfStorageKey` + `pdfChecksum`
 * columns — this document's key is DERIVED deterministically from the entry and the storage layer's
 * write-once guarantee is what makes it immutable. The checksum is recorded on the trace event
 * rather than a column.
 *
 * The proper home is a `CancellationConfirmationRecord` model (readable `LH/CX/…` id, the retained /
 * refunded figures, and the standard pdf* columns). That is a migration and a schema decision, so it
 * is flagged rather than invented here — see the note in CLAUDE.md.
 */
import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import {
  buildStorageKey,
  documentExists,
  hashSha256,
  readDocument,
  writeDocument,
} from "../../lib/document-storage.js";
import { formatMoney, loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { renderLegphelCancellationConfirmationHtml } from "../infrastructure/pdf-templates/legphel-cancellation-confirmation-template.js";
import { mastheadFromHotelProfile } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import {
  formatDocDate,
  formatNoticeGiven,
  formatStayRange,
} from "../infrastructure/pdf-templates/legphel-document-format.js";

export type CancellationFigures = {
  /** Total advance held against the folio at the moment of cancellation. */
  advanceHeld: number;
  /** Penalty retained per the disclosed terms. */
  retained: number;
  /** Net refunded to the guest (`advanceHeld - retained`, floored at 0 by the engine). */
  refundIssued: number;
  /**
   * The band that applied, e.g. "30–44 days · 50%". Comes from the cancellation policy the engine
   * evaluated — this service never re-derives it, because the document must state the decision that
   * was actually made.
   */
  bandLabel?: string | null;
  /** Readable id of the refund PAYMENT the engine raised, when one was raised. */
  refundReceiptNo?: string | null;
  /** Readable id of the money receipt the advance came in on, when known. */
  advanceReceiptRef?: string | null;
  /** Set when a GM waived the penalty — surfaced in the closing note. */
  penaltyWaived?: boolean;
  /** When the cancellation was committed. Defaults to now. */
  cancelledAt?: Date;
};

export type CancellationPdfResult = {
  storageKey: string;
  checksum: string;
  bytes: Buffer;
  filename: string;
};

/** Deterministic key — no DB column holds it, so it must be reproducible from the entry alone. */
export function cancellationStorageKey(entryId: string, at: Date): string {
  return buildStorageKey("cancellation-confirmation", `${entryId}-cancellation`, at);
}

/**
 * Render (or return the already-stored) Cancellation Confirmation for an entry.
 *
 * Idempotent: once the file exists it is streamed back byte-for-byte, never re-rendered — the
 * document the guest received must not change if the ladder config later does.
 */
export async function generateCancellationConfirmationPdf(
  prisma: PrismaClient,
  entryId: string,
  figures: CancellationFigures,
): Promise<CancellationPdfResult> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      guestProfile: true,
      inquiry: { include: { travelAgent: true, corporateAccount: true } },
      roomAssignments: { include: { room: { include: { roomType: true } } }, take: 4 },
      cancellationDisclosure: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const cancelledAt = figures.cancelledAt ?? entry.closedAt ?? new Date();
  const storageKey = cancellationStorageKey(entryId, cancelledAt);
  const filename = `${entry.inquiryId}-cancellation.pdf`;

  // Already rendered → serve the stored artifact.
  if (await documentExists(storageKey)) {
    const bytes = await readDocument(storageKey);
    return { storageKey, checksum: hashSha256(bytes), bytes, filename };
  }

  const hotel = await loadHotelProfileForRender(prisma);
  const guestName =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") || "Guest";

  const roomTypeName =
    entry.roomAssignments.find((a) => a.room?.roomType?.name)?.room?.roomType?.name ?? null;
  const nights =
    entry.checkInDate && entry.checkOutDate
      ? Math.max(
          1,
          Math.round((entry.checkOutDate.getTime() - entry.checkInDate.getTime()) / 86_400_000),
        )
      : null;
  const cancelledStay = [formatStayRange(entry.checkInDate, entry.checkOutDate, nights), roomTypeName]
    .filter(Boolean)
    .join(" · ");

  const refundableLabel = figures.bandLabel
    ? `Refundable per terms (${figures.bandLabel})`
    : "Refundable per terms";

  const closingNote = [
    "Refund by bank transfer within 7 working days to the account the advance was received from.",
    figures.penaltyWaived ? "Cancellation penalty waived by the General Manager." : null,
    "Cancellation terms as disclosed for this booking.",
  ]
    .filter(Boolean)
    .join(" ");

  const html = renderLegphelCancellationConfirmationHtml({
    masthead: mastheadFromHotelProfile(hotel),
    // Until a CancellationConfirmationRecord exists to mint an LH/CX/… number, the entry's own
    // readable id identifies the document. Swapping this for the real series is a one-line change
    // once that model lands.
    cancellationNo: `${entry.inquiryId}/CX`,
    bookingRef: entry.inquiryId,
    date: formatDocDate(cancelledAt),
    guest: guestName,
    cancelledStay: cancelledStay || "—",
    noticeGiven: formatNoticeGiven(cancelledAt, entry.checkInDate),
    advanceReceiptRef: figures.advanceReceiptRef ?? null,
    advanceHeld: formatMoney(figures.advanceHeld),
    refundableLabel,
    refundable: formatMoney(figures.refundIssued),
    retained: formatMoney(figures.retained),
    refundIssued: formatMoney(figures.refundIssued),
    refundReceiptNo: figures.refundReceiptNo ?? null,
    closingNote,
    tariffVersion: "T1.0",
  });

  const bytes = await renderHtmlToPdf(html);
  const checksum = hashSha256(bytes);
  await writeDocument(storageKey, bytes);

  // The checksum has no column to live in (see the header note), so the trace event carries it —
  // that is what makes a later integrity check possible.
  await prisma.traceEvent.create({
    data: {
      eventType: "CANCELLATION_CONFIRMATION.RENDERED",
      actorId: "SYSTEM",
      entityType: "Entry",
      entityId: entryId,
      operation: "CREATE",
      entryId,
      inquiryId: entry.inquiryId,
      payload: { storageKey, checksum, checksumAlgo: "SHA-256", ...figures },
    },
  });

  return { storageKey, checksum, bytes, filename };
}
