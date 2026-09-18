import { apiRequest } from "@/lib/api/client";
import type { Session } from "@/types/session";

/** What recording a no-show now would charge and give back — the backend's figures (2026-09-18). */
export type NoShowPreview = {
  advanceReceived: number;
  penaltyBeforeCap: number;
  /** What the hotel keeps. */
  penalty: number;
  /** What is owed back to the guest. */
  refund: number;
  capped: boolean;
  basis: "TERMS" | "NO_SHOW_RULE" | "SAME_DAY_CANCELLATION" | "NONE";
  sourceKey: string;
  percent: number | null;
  of: "FIRST_NIGHT" | "WHOLE_STAY" | null;
  baseAmount: number | null;
  /** What the charge is, in words — "one night's room, taxes included". */
  explanation: string;
  cutoffReachedAt: string | null;
  alreadyRecorded: boolean;
};

export async function previewNoShow(session: Session, entryId: string) {
  return apiRequest<NoShowPreview>(`/api/entries/${entryId}/no-show-preview`, { session });
}

/** `POST /api/entries/:id/no-show` (FOM) — the booking moves to Closed, still open, to be sealed there. */
export async function determineNoShow(
  session: Session,
  entryId: string,
  body: {
    determinationPath: "SUB_PATH_1";
    contactAttemptLog: Array<{ channel: string; attemptedAt: string; outcome: string; response?: string }>;
    decisionReason: string;
  },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/no-show`, { method: "POST", session, body });
}
