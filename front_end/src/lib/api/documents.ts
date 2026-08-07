import type { Session } from "@/types/session";

/**
 * PDF document downloads (quotation / proforma+final invoice / confirmation voucher).
 *
 * These backend routes are guarded by `requireActorLevel("L1")` and authenticate via the
 * `Authorization: Bearer <jwt>` header — the SAME scheme the rest of the desk uses through
 * `apiRequest`. That means a plain `<a href>` or `window.open(url)` would hit the endpoint
 * WITHOUT the token and get a 401. So we fetch the PDF as a blob with the auth header, then
 * open it via an object URL. The backend renders on demand if the artifact isn't stored yet,
 * so these work even before an email dispatch has persisted the file.
 */

function authHeaders(session: Session): Record<string, string> {
  if (session.jwtToken) return { Authorization: `Bearer ${session.jwtToken}` };
  // Legacy header-auth fallback (matches apiRequest) for sessions predating the JWT switch.
  return { "X-Actor-Id": session.userId, "X-Actor-Level": session.actorLevel };
}

/** Fetch a PDF endpoint as a blob and open it in a new browser tab. Throws on non-2xx. */
async function openPdf(session: Session, path: string): Promise<void> {
  const res = await fetch(path, { headers: authHeaders(session), credentials: "same-origin" });
  if (!res.ok) {
    let message = `Could not load PDF (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  // NB: passing "noopener"/"noreferrer" to window.open makes it ALWAYS return null (per spec),
  // which used to trip the popup-blocked fallback below and open the PDF in BOTH a new tab and
  // the current one. Open without the feature string so the return value actually signals whether
  // the tab opened, then sever the opener manually (blob: URLs are same-origin, so this is safe).
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
  } else {
    // Genuinely popup-blocked — fall back to a same-tab navigation so the operator still sees it.
    window.location.href = url;
  }
  // Revoke after a delay so the opened tab has time to load the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** S2 — quotation PDF. `GET /api/quotations/:id/pdf`. */
export function openQuotationPdf(session: Session, quotationId: string): Promise<void> {
  return openPdf(session, `/api/quotations/${quotationId}/pdf`);
}

/**
 * S2 — the quotation document as inline HTML (2026-08-01). Composed server-side from the
 * quotation's CURRENT terms via the same house template as the PDF, but with no PDF render or
 * storage write — so the desk can show the document for a draft before anything is generated.
 * Rendered into a sandboxed iframe via `srcDoc`.
 */
export async function fetchQuotationPreviewHtml(session: Session, quotationId: string): Promise<string> {
  return fetchPreviewHtml(session, `/api/quotations/${quotationId}/preview-html`, "quotation");
}

/**
 * S3 — the proforma document as inline HTML (2026-08-01). Same zero-side-effect composition
 * as the quotation preview: reflects the folio's current payments and the desk's advance
 * requirement live, without generating a PDF.
 */
export async function fetchInvoicePreviewHtml(session: Session, invoiceId: string): Promise<string> {
  return fetchPreviewHtml(session, `/api/invoices/${invoiceId}/preview-html`, "proforma");
}

/**
 * Fetch a stored PDF as a blob object-URL for INLINE embedding (2026-08-01) — used by the
 * "View" on superseded quotations/proformas, where the honest inline view is the FROZEN
 * artifact that actually went out, not a recomposition from current data. Caller owns the
 * URL lifecycle (revoke on unmount).
 */
export async function fetchPdfObjectUrl(session: Session, path: string): Promise<string> {
  const res = await fetch(path, { headers: authHeaders(session), credentials: "same-origin" });
  if (!res.ok) {
    let message = `Could not load the document (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }
  return URL.createObjectURL(await res.blob());
}

async function fetchPreviewHtml(session: Session, path: string, label: string): Promise<string> {
  const res = await fetch(path, { headers: authHeaders(session), credentials: "same-origin" });
  if (!res.ok) {
    let message = `Could not load ${label} preview (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }
  return res.text();
}

/** S3 proforma / S8·S9 final — invoice PDF. `GET /api/invoices/:id/pdf`. */
export function openInvoicePdf(session: Session, invoiceId: string): Promise<void> {
  return openPdf(session, `/api/invoices/${invoiceId}/pdf`);
}

/** S4 — confirmation voucher PDF. `GET /api/reservations/:id/confirmation-voucher-pdf`. */
export function openConfirmationVoucherPdf(session: Session, reservationId: string): Promise<void> {
  return openPdf(session, `/api/reservations/${reservationId}/confirmation-voucher-pdf`);
}

/** A5 — cancellation confirmation PDF. `GET /api/entries/:id/cancellation-confirmation-pdf`. */
export function openCancellationConfirmationPdf(session: Session, entryId: string): Promise<void> {
  return openPdf(session, `/api/entries/${entryId}/cancellation-confirmation-pdf`);
}
