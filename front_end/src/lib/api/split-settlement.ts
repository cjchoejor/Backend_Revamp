import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * Split settlement — what each part of a folio owes, and taking money against one (PMS-237).
 *
 * Every figure here is server-summed. The desk never adds these up: `outstanding` is the
 * slice's own arithmetic, `collectable` is that capped at the folio's balance, and the two
 * differ exactly when money was received against the BOOKING rather than a slice (the S3
 * advance). `unappliedPayments` is that money, and it is shown rather than netted off some
 * arbitrary room.
 */
export type SettlementTargetRow = {
  kind: "ROOM" | "SPACE" | "UNASSIGNED";
  roomId: string | null;
  spaceId: string | null;
  /** Room number or space name; null for the unassigned slice and for a deleted registry row. */
  label: string | null;
  charges: number;
  paid: number;
  outstanding: number;
  /** What may actually be collected now — `outstanding` capped at the folio's own balance. */
  collectable: number;
  lineCount: number;
};

export type SettlementTargets = {
  folioId: string;
  folioState: string;
  currency: string;
  folioOutstanding: number;
  /** Money held against the booking as a whole — not yet applied to any room or space. */
  unappliedPayments: number;
  /** Σ of every row's `outstanding`; exceeds `folioOutstanding` by the unapplied money. */
  targetOutstandingTotal: number;
  targets: SettlementTargetRow[];
};

export async function getSettlementTargets(session: Session, folioId: string) {
  return apiRequest<SettlementTargets>(`/api/folios/${folioId}/settlement-targets`, { session });
}

export type RoomDeparture = {
  roomId: string;
  roomNumber: string | null;
  departureDate: string;
  sleptNights: number;
  unstayedNights: number;
  forgoneSubtotal: number;
  forgoneTotal: number;
  roomReleased: boolean;
  nothingForgone: boolean;
};

export type TargetPaymentOutcome = {
  /** Set when the room was actually released; null when it was not asked for or was refused. */
  departure: RoomDeparture | null;
  /** Why the release was refused — the MONEY still landed. Never conflate the two. */
  departureRefused: string | null;
  roomStatus: "STILL_STAYING" | "LEFT" | null;
  paymentId: string;
  amount: number;
  roomId: string | null;
  spaceId: string | null;
  stage: string;
  targetOutstandingAfter: number;
  folioOutstandingAfter: number;
  targetSettledInFull: boolean;
  folioSettledInFull: boolean;
  summary: {
    folioOutstanding: number;
    unappliedPayments: number;
    targets: SettlementTargetRow[];
  };
};

export async function recordTargetPayment(
  session: Session,
  folioId: string,
  body: {
    entryId: string;
    /** Exactly one of these — the backend refuses both. */
    roomId?: string;
    spaceId?: string;
    amount: number;
    paymentMethod?: string;
    paymentVerificationRef?: string;
    notes?: string;
    /**
     * Is this room's guest still here? Only meaningful with `roomId`. Omitted means "don't
     * touch the room" — a payment must never release a room by accident. LEFT ends the room's
     * assignment today and releases it, which gives up any unstayed nights and needs the GM.
     */
    roomStatus?: "STILL_STAYING" | "LEFT";
    departureReason?: string;
  },
) {
  return apiRequest<TargetPaymentOutcome>(`/api/folios/${folioId}/target-payments`, {
    method: "POST",
    session,
    body,
  });
}
