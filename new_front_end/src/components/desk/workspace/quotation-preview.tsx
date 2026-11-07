"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import {
  fetchFolioDocumentPreviewHtml,
  fetchInvoicePreviewHtml,
  fetchPdfBlob,
  fetchQuotationPreviewHtml,
  type FolioDocumentKind,
} from "@/lib/api/documents";
import { PdfPages } from "./pdf-pages";

/**
 * Inside the paper's own panel the paper fills the panel's width (2026-11-05, operator: "when
 * previewing it, it is really small, the user has to squint ... many empty white spaces beside and
 * above it"). Elsewhere it keeps the small inline frame.
 */
export const PaperFill = createContext<false | "preview" | "send">(false);

/** The width the paper lays out at before it is scaled up to its panel: its own proportions, kept. */
const PAPER_LAYOUT_WIDTH = 540;
/** The room the paper's own page margin takes on paper is empty space on a screen. */
const PAPER_FILL_CSS = ".sheet{padding:8px 12px 12px 8px}html,body{background:#fff}";
/**
 * The desk knows its own hotel (2026-11-05, operator: "when user previews the paper, can it not show
 * the hotel logo and name address ... that way it saves more screen. but while sending it can show").
 * Only the screen's copy: the PDF and what the guest receives keep it.
 */
const PAPER_NO_MASTHEAD_CSS = ".dmast{display:none}";

function fillPaper(html: string, mode: "preview" | "send"): string {
  const style = `<style>${PAPER_FILL_CSS}${mode === "preview" ? PAPER_NO_MASTHEAD_CSS : ""}</style>`;
  return html.includes("</head>") ? html.replace("</head>", `${style}</head>`) : style + html;
}

function useElementWidth() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    const o = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    o.observe(el);
    observer.current = o;
  }, []);
  return [ref, width] as const;
}

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
  const fill = useContext(PaperFill);
  const [height, setHeight] = useState(480);
  const [wrapRef, wrapWidth] = useElementWidth();
  const query = useQuery({
    queryKey,
    queryFn: fetchHtml,
    // Always recompose — the whole point is tracking the live record.
    staleTime: 0,
    refetchOnMount: "always",
    // Changing a paper's face keeps the paper on screen until the new one is here.
    placeholderData: (previous) => previous,
  });
  const srcDoc = useMemo(() => (fill && query.data ? fillPaper(query.data, fill) : query.data), [fill, query.data]);

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
          width: fill ? "100%" : "min(100%, 470px)",
          lineHeight: 1.5,
        }}
      >
        {notice}
      </p>
    ) : null}
    {fill ? (
      // Laid out at the paper's own width and scaled to the panel, so every proportion stays as
      // printed and only the size changes. A paper shorter than the frame leaves no gap under it.
      <div ref={wrapRef} style={{ width: "100%", height: wrapWidth ? height * (wrapWidth / PAPER_LAYOUT_WIDTH) : height, overflow: "hidden" }}>
        <iframe
          title={title}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          scrolling="no"
          onLoad={(e) => {
            const frame = e.currentTarget;
            const measure = () => {
              const doc = frame.contentDocument;
              const h = (doc?.querySelector(".sheet") ?? doc?.body)?.getBoundingClientRect().height;
              if (h && Number.isFinite(h)) setHeight(Math.ceil(h));
            };
            measure();
            void frame.contentDocument?.fonts?.ready.then(measure);
          }}
          style={{
            width: PAPER_LAYOUT_WIDTH,
            height,
            display: "block",
            border: 0,
            background: "#fff",
            transform: `scale(${wrapWidth ? wrapWidth / PAPER_LAYOUT_WIDTH : 1})`,
            transformOrigin: "top left",
          }}
        />
      </div>
    ) : (
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
    )}
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
  const fill = useContext(PaperFill);
  const query = useQuery({
    queryKey: ["pdf-blob", path] as const,
    queryFn: () => fetchPdfBlob(session!, path),
    enabled: !!session,
    // The artifact is write-once — it can never change.
    staleTime: Infinity,
  });
  // A fresh address for each time the frame is shown, freed when it goes. The file stays cached;
  // caching the address instead handed a revoked one to the next opening — the broken-file icon.
  const [url, setUrl] = useState<string | null>(null);
  // The browser's own viewer, when the paper could not be drawn on the page.
  const [viewerOnly, setViewerOnly] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    const u = URL.createObjectURL(query.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [query.data]);

  if (query.isLoading || (query.data && !url)) {
    return <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "6px 0" }}>Loading the sent document…</p>;
  }
  if (query.isError || !query.data || !url) {
    return (
      <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "6px 0" }}>
        {query.error instanceof Error ? query.error.message : "Could not load the document."}
      </p>
    );
  }
  if (fill && !viewerOnly) {
    // Drawn on the page, so a preview can leave the hotel's heading off as a live paper does
    // (2026-11-07); beside a send the heading stays.
    return <PdfPages blob={query.data} title={title} hideHeading={fill === "preview"} onFail={() => setViewerOnly(true)} />;
  }
  if (fill) {
    return (
      <iframe
        title={title}
        // The viewer's own bar and thumbnails take room from the paper; the panel has PDF and Print.
        src={`${url}#toolbar=0&view=FitH`}
        style={{ width: "100%", height: "100%", minHeight: 480, display: "block", border: 0, background: "#fff" }}
      />
    );
  }
  return (
    <iframe
      title={title}
      src={url}
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
export function QuotationPreview({
  quotationId,
  frozenPdf,
  hidePrices,
  nightsEach,
}: {
  quotationId: string;
  frozenPdf?: boolean;
  /** The copy a guest who asked for a quotation without prices receives (2026-10-06). */
  hidePrices?: boolean;
  /** Every night named instead of a run as its first and last (2026-10-30). */
  nightsEach?: boolean;
}) {
  const { session } = useSession();
  if (frozenPdf && !hidePrices && !nightsEach) {
    return <FrozenPdfFrame path={`/api/quotations/${quotationId}/pdf`} title="Quotation (as sent)" />;
  }
  return (
    <DocumentPreviewFrame
      queryKey={["quotation-preview", quotationId, hidePrices ? "no-prices" : "priced", nightsEach ? "each" : "short"] as const}
      fetchHtml={() => fetchQuotationPreviewHtml(session!, quotationId, { hidePrices, nightsEach })}
      title={hidePrices ? "Quotation · without prices" : "Quotation document"}
    />
  );
}

/**
 * S4 — the confirmation voucher, embedded inline as its PDF (2026-08-07, operator request:
 * "view like PI and quotation"). The voucher is write-once; the route lazily renders + stores
 * it on first view, so this works both before and after the artifact exists.
 */
export function VoucherPreview({ reservationId, nightsEach }: { reservationId: string; nightsEach?: boolean }) {
  return (
    <FrozenPdfFrame
      path={`/api/reservations/${reservationId}/confirmation-voucher-pdf${nightsEach ? "?nights=each" : ""}`}
      title="Confirmation voucher"
    />
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
export function ProformaPreview({
  invoiceId,
  frozenPdf,
  notice,
  title,
  nightsEach,
}: {
  invoiceId: string;
  frozenPdf?: boolean;
  notice?: string;
  title?: string;
  nightsEach?: boolean;
}) {
  const { session } = useSession();
  if (frozenPdf) {
    return <FrozenPdfFrame path={`/api/invoices/${invoiceId}/pdf`} title={title ? `${title} (as sent)` : "Proforma invoice (as sent)"} />;
  }
  return (
    <DocumentPreviewFrame
      queryKey={["invoice-preview", invoiceId, nightsEach ? "each" : "short"] as const}
      fetchHtml={() => fetchInvoicePreviewHtml(session!, invoiceId, { nightsEach })}
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
  nightsEach,
}: {
  entryId: string;
  kind: FolioDocumentKind;
  title: string;
  refreshKey: string;
  nightsEach?: boolean;
}) {
  const { session } = useSession();
  return (
    <DocumentPreviewFrame
      queryKey={["folio-document-preview", entryId, kind, refreshKey, nightsEach ? "each" : "short"] as const}
      fetchHtml={() => fetchFolioDocumentPreviewHtml(session!, entryId, kind, { nightsEach })}
      title={title}
    />
  );
}

/** The ISSUED tax invoice — served only from its write-once PDF (a fiscal document is never recomposed). */
export function IssuedInvoicePreview({ invoiceId }: { invoiceId: string }) {
  return <FrozenPdfFrame path={`/api/invoices/${invoiceId}/pdf`} title="Tax invoice (as issued)" />;
}
