import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * Damage found at a room inspection and how each was answered (2026-10-26). The backend decides
 * which answers are open and whose they are (`ways`); the desk shows them.
 */
export type DamageAnswer = "CHARGED" | "WAIVED" | "LATER";
export type DamageWay = { open: boolean; level: "L1" | "L2"; why: string | null };

export type BookingDamage = {
  inspectionId: string;
  roomId: string;
  roomNumber: string;
  damageNotes: string | null;
  inspectedAt: string;
  inspectedBy: string;
  answer: DamageAnswer | null;
  answerNote: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  folioLineId: string | null;
  faultId: string | null;
  charge: { folioLineId: string; amount: string; withServiceCharge: boolean; withGst: boolean; chargeDate: string } | null;
};

export type BookingDamages = {
  entryId: string;
  ways: { charge: DamageWay; waive: DamageWay; later: DamageWay };
  rates: { serviceChargeRate: number; gstRate: number };
  damages: BookingDamage[];
};

export type DamageChargePreview = {
  amount: string;
  serviceCharge: string;
  gst: string;
  total: string;
  serviceChargeRate: number;
  gstRate: number;
};

export function getBookingDamages(session: Session, entryId: string) {
  return apiRequest<BookingDamages>(`/api/entries/${entryId}/damages`, { session });
}

export function previewDamageCharge(session: Session, entryId: string, body: { amount: number; serviceCharge: boolean; gst: boolean }) {
  return apiRequest<DamageChargePreview>(`/api/entries/${entryId}/damages/preview`, { method: "POST", session, body });
}

export function answerDamage(
  session: Session,
  entryId: string,
  inspectionId: string,
  body:
    | { answer: "CHARGE"; amount: number; serviceCharge: boolean; gst: boolean; description?: string; note?: string }
    | { answer: "WAIVE"; note: string }
    | { answer: "LATER"; note?: string },
) {
  return apiRequest<BookingDamages>(`/api/entries/${entryId}/damages/${inspectionId}/answer`, { method: "POST", session, body });
}
