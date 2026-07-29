import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Detach a quotation's rendered PDF so the next request re-renders it (2026-07-28).
 *
 * Document storage is deliberately write-once — the file a guest received must stay on disk
 * byte-for-byte. But a DRAFT quotation's PDF can be rendered early (the desk's "Quotation PDF"
 * preview button renders on demand) and the price can still change afterwards via
 * `applyDiscount`. Without this, the stale preview stayed attached to the quotation and
 * `sendQuotation` emailed the guest a PDF showing the pre-discount price.
 *
 * This does NOT delete anything from disk. It bumps `pdfRenderRevision` — which the PDF
 * service folds into the storage key — and clears the artifact pointers on the row, so the
 * next render writes a fresh file at `…-r2.pdf`. Superseded previews remain on disk,
 * preserving the append-only guarantee.
 *
 * `QuotationLine` rows are deleted because they are the line-item snapshot OF that PDF; the
 * re-render recreates them from the new numbers.
 *
 * Only ever call this while the quotation is still DRAFT. Once SENT, the guest has the file
 * and the correct remedy is a new version via `supersedeQuotationWithNewDraft`.
 */
export async function invalidateQuotationPdfArtifact(tx: Tx, quotationId: string): Promise<void> {
  const q = await tx.quotation.findUnique({
    where: { id: quotationId },
    select: { pdfStorageKey: true, pdfRenderRevision: true },
  });
  // Nothing rendered yet → nothing to invalidate, and no revision to burn.
  if (!q?.pdfStorageKey) return;

  await tx.quotationLine.deleteMany({ where: { quotationId } });
  await tx.quotation.update({
    where: { id: quotationId },
    data: {
      pdfStorageKey: null,
      pdfChecksum: null,
      pdfRenderedAt: null,
      pdfRenderedBy: null,
      renderInputSnapshot: Prisma.DbNull,
      pdfRenderRevision: (q.pdfRenderRevision ?? 1) + 1,
    },
  });
}
