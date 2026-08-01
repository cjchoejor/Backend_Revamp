"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { fetchInvoicePreviewHtml, fetchQuotationPreviewHtml } from "@/lib/api/documents";

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
}: {
  queryKey: readonly unknown[];
  fetchHtml: () => Promise<string>;
  title: string;
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
  );
}

/** S2 — the quotation document, live from its current terms. */
export function QuotationPreview({ quotationId }: { quotationId: string }) {
  const { session } = useSession();
  return (
    <DocumentPreviewFrame
      queryKey={["quotation-preview", quotationId] as const}
      fetchHtml={() => fetchQuotationPreviewHtml(session!, quotationId)}
      title="Quotation document"
    />
  );
}

/** S3 — the proforma document, live from folio payments + the desk's advance requirement. */
export function ProformaPreview({ invoiceId }: { invoiceId: string }) {
  const { session } = useSession();
  return (
    <DocumentPreviewFrame
      queryKey={["invoice-preview", invoiceId] as const}
      fetchHtml={() => fetchInvoicePreviewHtml(session!, invoiceId)}
      title="Proforma invoice document"
    />
  );
}
