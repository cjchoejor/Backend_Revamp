import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/** Who pays, read and changed while the guest is staying (2026-10-26). */

export type PayerRead = {
  current: string | null;
  /** Which payer each kind of charge goes to — ROOM_CHARGE, F_AND_B, SERVICE, OTHER, CREDIT_NOTE. */
  map: Record<string, string> | null;
  allowed: string[];
  linesOnBill: number;
  canChange: boolean;
};

export type PayerShare = { billingModel: string; before: string; after: string };

export type PayerChangePreview = {
  from: string;
  to: string;
  moveExisting: boolean;
  newMap: Record<string, string>;
  linesMoving: number;
  linesOnBill: number;
  byPayer: PayerShare[];
};

export function getPayer(session: Session, entryId: string) {
  return apiRequest<PayerRead>(`/api/entries/${encodeURIComponent(entryId)}/payer`, { session });
}

export function previewPayerChange(session: Session, entryId: string, body: { billingModel: string; moveExisting: boolean }) {
  return apiRequest<PayerChangePreview>(`/api/entries/${encodeURIComponent(entryId)}/payer-change/preview`, { session, method: "POST", body });
}

export function changePayer(session: Session, entryId: string, body: { billingModel: string; moveExisting: boolean; reason: string }) {
  return apiRequest<{ from: string; to: string; linesMoved: number; byPayer: PayerShare[] }>(
    `/api/entries/${encodeURIComponent(entryId)}/payer-change`,
    { session, method: "POST", body },
  );
}
