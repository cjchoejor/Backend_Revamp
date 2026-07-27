import type { FolioDetail, FolioLineSummary } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * Split-billing API client (Phase 2 + 4, 2026-07-25).
 *
 * These wrap the PATCH endpoints on `/api/folios/:id/...` that manage per-line billing-model
 * assignments and the folio's per-line-type defaults map. All three write endpoints go through
 * `enforceSplitBillingEditAllowed` on the backend — L1 at S3/S5/S6/S7, L2+ at S8/S9.
 */

/**
 * Update the folio's per-line-type default map. Partial merge — send only the keys you want
 * to change. Affects FUTURE line posts only; existing lines are not touched.
 */
export async function updateBillingModelDefaults(
  session: Session,
  folioId: string,
  body: {
    defaults: Partial<Record<"ROOM_CHARGE" | "F_AND_B" | "SERVICE" | "OTHER" | "CREDIT_NOTE", string>>;
    reason?: string;
  },
) {
  return apiRequest<FolioDetail>(`/api/folios/${folioId}/billing-model-defaults`, {
    method: "PATCH",
    session,
    body,
  });
}

/**
 * Reassign ONE folio line to a different billing model. `reason` mandatory — money
 * implications need audit context. Backend writes a per-line `BillingModelTransitionRecord`.
 */
export async function reassignFolioLineBillingModel(
  session: Session,
  folioId: string,
  lineId: string,
  body: { billingModel: string; reason: string },
) {
  return apiRequest<FolioLineSummary>(
    `/api/folios/${folioId}/lines/${lineId}/billing-model`,
    { method: "PATCH", session, body },
  );
}

/**
 * Bulk reassign — typical use "agent agreed to cover all F&B lines". Same reason applies to
 * every update in the batch. Returns counts of what actually moved (already-at-target lines
 * are silently skipped by the backend).
 */
export async function reassignFolioLinesBillingModelBulk(
  session: Session,
  folioId: string,
  body: {
    updates: Array<{ folioLineId: string; billingModel: string }>;
    reason: string;
  },
) {
  return apiRequest<{ reassigned: number; skipped: number }>(
    `/api/folios/${folioId}/lines/billing-model-bulk`,
    { method: "PATCH", session, body },
  );
}

/**
 * Canonical billing-model values the runtime special-cases. Kept in sync with the backend's
 * `SPLIT_BILLING_ALLOWED_VALUES` in `p32-split-billing-edit-authority.ts`.
 */
export const SPLIT_BILLING_MODELS = ["GUEST_PAY", "DIRECT_BILL", "GOVERNMENT"] as const;
export type SplitBillingModel = (typeof SPLIT_BILLING_MODELS)[number];

/** Line types that can carry a per-line billing model (matches backend's FolioLineType enum). */
export const FOLIO_LINE_TYPES = ["ROOM_CHARGE", "F_AND_B", "SERVICE", "OTHER", "CREDIT_NOTE"] as const;
export type FolioLineTypeKey = (typeof FOLIO_LINE_TYPES)[number];
