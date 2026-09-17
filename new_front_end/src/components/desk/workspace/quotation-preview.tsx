"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import {
  fetchFolioDocumentPreviewHtml,
  fetchInvoicePreviewHtml,
  fetchPdfObjectUrl,
  fetchQuotationPreviewHtml,
  type FolioDocumentKind,
} from "@/lib/api/documents";

/**
 * Inline document views (2026-08-01, operator request): the A1 quotation / A2 proforma in
 * house format, rendered right on the stage step WITHOUT generating a PDF. The backend
 * composes the HTML fresh from the record's current data (`GET …/preview-html` — same
 * template as the PDF, zero side effects), so a document can be reviewed before anything is
 * generated or sent, and edits re-preview by refetching.
 *
 * Rendered in a sandboxed iframe (no scripts allowed) via srcDoc. `allow-same-origin` only —
 * needed so we can measure the document and size the frame to it; the document itself is our
 * own backend's static HTML with no scripts.
 */
function DocumentPreviewFrame({
  queryKey,
  fetchHtml,
  title,
  notice,
}: {
  queryKey: readonly unknown[];
  fetchHtml: () => Promise<string>;
  title: string;
  /** Amber caveat strip above the frame — e.g. "reconstruction, no frozen copy exists". */
  notice?: string;
}) {
  const [height, setHeight] = useState(480);
  const query = useQuery({
    queryKey,
    queryFn: fetchHtml,
    // Always recompose — the whole point is tracking the live record.
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (query.isLoading) {
    return (
      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "6px 0" }}>Composing the document…</p>
    );
  }
  if (query.isError || !query.data) {
    return (
      <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "6px 0" }}>
        {query.error instanceof Error ? query.error.message : "Could not load the document preview."}
      </p>
    );
  }

  return (
    <>
    {notice ? (
      <p
        style={{
          fontSize: 11,
          color: "var(--warn)",
          background: "var(--warn-t)",
          border: "1px solid var(--warn)",
          borderRadius: 6,
          padding: "5px 9px",
          margin: "6px auto 0",
          width: "min(100%, 470px)",
          lineHeight: 1.5,
        }}
      >
        {notice}
      </p>
    ) : null}
    <iframe
      title={title}
      sandbox="allow-same-origin"
      srcDoc={query.data}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument;
        const h = doc?.documentElement?.scrollHeight ?? doc?.body?.scrollHeight;
        if (h && Number.isFinite(h)) setHeight(Math.min(1800, Math.max(420, h + 8)));
      }}
      style={{
        // Portrait, like the paper document (and the reference gallery's ~400px cards):
        // constraining the width makes the card inside lay out tall and narrow, and the
        // onLoad measure above stretches the frame to whatever height that produces.
        width: "min(100%, 470px)",
        display: "block",
        height,
        border: "1px solid var(--line-2)",
        borderRadius: 8,
        background: "#FDFDFB",
        margin: "6px auto 4px",
      }}
    />
    </>
  );
}

/**
 * Frozen-artifact inline view (2026-08-01): superseded documents must show what actually
 * went out at the time — recomposing them from current data would print today's figures
 * under yesterday's number. This embeds the STORED PDF (fetched with auth as a blob) in the
 * same portrait frame the live previews use. No sandbox attribute — the browser's built-in
 * PDF viewer doesn't run inside a sandboxed iframe.
 */
function FrozenPdfFrame({ path, title }: { path: string; title: string }) {
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["pdf-inline", path] as const,
    queryFn: () => fetchPdfObjectUrl(session!, path),
    enabled: !!session,
    // The artifact is write-once — it can never change.
    staleTime: Infinity,
  });
  // Revoke the object URL when the frame unmounts (or the URL is replaced).
  useEffect(() => {
    const url = query.data;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [query.data]);

  if (query.isLoading) {
    return <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "6px 0" }}>Loading the sent document…</p>;
  }
  if (query.isError || !query.data) {
    return (
      <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "6px 0" }}>
        {query.error instanceof Error ? query.error.message : "Could not load the document."}
      </p>
    );
  }
  return (
    <iframe
      title={title}
      src={query.data}
      style={{
        width: "min(100%, 470px)",
        display: "block",
        height: 640,
        border: "1px solid var(--line-2)",
        borderRadius: 8,
        background: "#FDFDFB",
        margin: "6px auto 4px",
      }}
    />
  );
}

/**
 * S2 — the quotation document. Live rows compose from current terms; pass `frozenPdf` on a
 * superseded row that has a stored PDF to show the artifact that actually went out.
 */
export function QuotationPreview({ quotationId, frozenPdf }: { quotationId: string; frozenPdf?: boolean }) {
  const { session } = useSession();
  if (frozenPdf) {
    return <FrozenPdfFrame path={`/api/quotations/${quotationId}/pdf`} title="Quotation (as sent)" />;
  }
  return (
    <DocumentPreviewFrame
      queryKey={["quotation-preview", quotationId] as const}
      fetchHtml={() => fetchQuotationPreviewHtml(session!, quotationId)}
      title="Quotation document"
    />
  );
}

/**
 * S4 — the confirmation voucher, embedded inline as its PDF (2026-08-07, operator request:
 * "view like PI and quotation"). The voucher is write-once; the route lazily renders + stores
 * it on first view, so this works both before and after the artifact exists.
 */
export function VoucherPreview({ reservationId }: { reservationId: string }) {
  return (
    <FrozenPdfFrame path={`/api/reservations/${reservationId}/confirmation-voucher-pdf`} title="Confirmation voucher" />
  );
}

/**
 * The A5 cancellation confirmation — generated when the booking is cancelled (or lazily on
 * first view). Embedded inline on the cancelled booking's read-only record.
 */
export function CancellationVoucherPreview({ entryId }: { entryId: string }) {
  return (
    <FrozenPdfFrame path={`/api/entries/${entryId}/cancellation-confirmation-pdf`} title="Cancellation confirmation" />
  );
}

/**
 * S3 — the proforma document. Live rows compose from folio payments + the desk's advance
 * requirement; pass `frozenPdf` on a superseded row to show the stored artifact instead.
 */
export function ProformaPreview({ invoiceId, frozenPdf, notice, title }: { invoiceId: string; frozenPdf?: boolean; notice?: string; title?: string }) {
  const { session } = useSession();
  if (frozenPdf) {
    return <FrozenPdfFrame path={`/api/invoices/${invoiceId}/pdf`} title={title ? `${title} (as sent)` : "Proforma invoice (as sent)"} />;
  }
  return (
    <DocumentPreviewFrame
      queryKey={["invoice-preview", invoiceId] as const}
      fetchHtml={() => fetchInvoicePreviewHtml(session!, invoiceId)}
      title={title ?? "Proforma invoice document"}
      notice={notice}
    />
  );
}

/**
 * S7/S8 — a folio document (tentative invoice · master bill · tax-invoice draft) composed live
 * from the ledger (2026-08-22). `refreshKey` changes whenever the folio moves, so an open
 * preview re-composes after a charge is posted or money is taken.
 */
export function FolioDocumentPreview({
  entryId,
  kind,
  title,
  refreshKey,
}: {
  entryId: string;
  kind: FolioDocumentKind;
  title: string;
  refreshKey: string;
}) {
  const { session } = useSession();
  return (
    <DocumentPreviewFrame
      queryKey={["folio-document-preview", entryId, kind, refreshKey] as const}
      fetchHtml={() => fetchFolioDocumentPreviewHtml(session!, entryId, kind)}
      title={title}
    />
  );
}

/** The ISSUED tax invoice — served only from its write-once PDF (a fiscal document is never recomposed). */
export function IssuedInvoicePreview({ invoiceId }: { invoiceId: string }) {
  return <FrozenPdfFrame path={`/api/invoices/${invoiceId}/pdf`} title="Tax invoice (as issued)" />;
}
