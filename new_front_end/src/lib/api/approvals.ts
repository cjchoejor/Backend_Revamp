/**
 * Who may approve what (2026-11-26) — the admin console's toggles, as the server reads them for the
 * person signed in. back_end/src/lib/approval-roles.ts.
 */
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type ApprovalAct =
  | "LEAVE_OWING"
  | "CHARGE_CORRECTION"
  | "CHECKIN_PAY_LATER"
  | "NEGOTIATION_CHANGE"
  | "ROOM_REMOVE"
  | "ROOM_ADD"
  | "LEAVING_EARLY"
  | "WAIVE_EARLY_FEE";

export type ApprovalRule = { levels: string[]; words: string; what: string; may: boolean };

export function getApprovals(session: Session) {
  return apiRequest<{ acts: Record<ApprovalAct, ApprovalRule> }>("/api/lookups/approvals", { session });
}
