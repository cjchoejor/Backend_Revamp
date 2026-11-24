import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * Billing › Vouchers (2026-11-24): every agency voucher taken at check-out, and whether the agency's
 * money for it has come in. Recording it never moves a guest's bill. Every figure is the server's.
 */
export type VoucherRow = {
  paymentId: string;
  amount: number;
  currency: string;
  takenAt: string;
  stage: string | null;
  booking: { entryId: string; inquiryId: string; guestName: string; checkIn: string | null; checkOut: string | null; status: string; stage: string } | null;
  party: { kind: "TRAVEL_AGENT" | "CORPORATE" | null; id: string | null; name: string | null };
  received: {
    receivedOn: string;
    paymentMethod: string;
    bankName: string | null;
    journalNumber: string | null;
    reference: string | null;
    notes: string | null;
    batchId: string;
    batch: { count: number; total: number };
    recordedBy: string;
    recordedAt: string;
  } | null;
};

export type VoucherList = {
  items: VoucherRow[];
  totals: {
    open: { count: number; amount: number };
    received: { count: number; amount: number };
    byParty: Array<{ partyId: string | null; name: string; openCount: number; openAmount: number }>;
  };
};

export type VoucherMoneyBody = {
  paymentIds: string[];
  receivedOn: string;
  paymentMethod: string;
  bankName?: string;
  journalNumber?: string;
  reference?: string;
  notes?: string;
};

export async function listVouchers(session: Session, view: "open" | "received" | "all") {
  return apiRequest<VoucherList>(`/api/vouchers?view=${view}`, { session });
}

export async function previewVoucherMoney(session: Session, body: { paymentIds: string[] }) {
  return apiRequest<{ count: number; total: number; party: VoucherRow["party"]; currency: string }>(`/api/vouchers/money/preview`, {
    method: "POST",
    session,
    body,
  });
}

export async function recordVoucherMoney(session: Session, body: VoucherMoneyBody) {
  return apiRequest<{ batchId: string; count: number; total: number; party: VoucherRow["party"] }>(`/api/vouchers/money`, { method: "POST", session, body });
}

export async function undoVoucherMoney(session: Session, paymentId: string, reason: string) {
  return apiRequest<{ paymentId: string; undone: boolean }>(`/api/vouchers/${encodeURIComponent(paymentId)}/money/undo`, {
    method: "POST",
    session,
    body: { reason },
  });
}
