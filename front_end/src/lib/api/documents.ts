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
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) {
    // Popup blocked — fall back to a same-tab navigation so the operator still sees the PDF.
    window.location.href = url;
  }
  // Revoke after a delay so the opened tab has time to load the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** S2 — quotation PDF. `GET /api/quotations/:id/pdf`. */
export function openQuotationPdf(session: Session, quotationId: string): Promise<void> {
  return openPdf(session, `/api/quotations/${quotationId}/pdf`);
}

/** S3 proforma / S8·S9 final — invoice PDF. `GET /api/invoices/:id/pdf`. */
export function openInvoicePdf(session: Session, invoiceId: string): Promise<void> {
  return openPdf(session, `/api/invoices/${invoiceId}/pdf`);
}

/** S4 — confirmation voucher PDF. `GET /api/reservations/:id/confirmation-voucher-pdf`. */
export function openConfirmationVoucherPdf(session: Session, reservationId: string): Promise<void> {
  return openPdf(session, `/api/reservations/${reservationId}/confirmation-voucher-pdf`);
}
