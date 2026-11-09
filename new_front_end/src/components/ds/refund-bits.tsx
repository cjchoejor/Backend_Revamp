"use client";

/**
 * The small pieces of a refund (2026-11-05, operator: "made a little different with money sign"): the
 * coin that marks one in the bell and on the Refunds tab, and the line a booking carries while its
 * money is going back or after it went. The figures are the server's.
 */
import { money, fmtDateTime } from "@/lib/ds/format";
import type { PaymentStatusSummary } from "@/types/api";

/** The money sign. Nu, the hotel's currency, on a coin. */
export function RefundCoin({ size }: { size?: "sm" | "lg" }) {
  return (
    <span className={`refund-coin${size === "lg" ? " lg" : ""}`} aria-hidden="true">
      Nu
    </span>
  );
}

export const REFUND_METHOD_WORD: Record<string, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank transfer",
  CARD: "Card",
  MOBILE_PAYMENT: "Online payment",
};

/** Where this booking's refund stands, for everyone at the desk. Bank details stay on the tab. */
export function RefundStanding({ status, currency, tz }: { status: PaymentStatusSummary | undefined; currency?: string; tz?: string }) {
  const r = status?.earlierAdvance?.refund ?? null;
  if (!r) return null;
  if (r.status === "WAITING") {
    return (
      <p className="notice next refund-line" role="status" data-refund-standing="waiting">
        <RefundCoin />
        <span>
          <b>{money(r.amountAsked, currency)} is waiting to be refunded</b> · {r.id}. It no longer counts on this booking. The FOM or GM records it.
        </span>
      </p>
    );
  }
  if (r.status === "REFUNDED") {
    return (
      <p className="sm refund-line done" data-refund-standing="refunded">
        <RefundCoin />
        <span>
          Refunded <b>{money(r.refundedAmount, currency)}</b>
          {r.refundMethod ? ` · ${REFUND_METHOD_WORD[r.refundMethod] ?? r.refundMethod}` : ""}
          {r.closedAt ? ` · ${fmtDateTime(r.closedAt, tz)}` : ""} · {r.id}
        </span>
      </p>
    );
  }
  return null;
}
