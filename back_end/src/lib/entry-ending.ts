/**
 * How a booking ended — the vocabulary behind `Entry.closedAs` (2026-10-01).
 *
 * `Entry.status` says only CANCELLED or EXPIRED, and the stage is wiped to TERMINAL by the
 * cancellation routes, so neither could tell a lead the guest turned down from an enquiry
 * nobody ever answered. Every one of them read "Expired" or "Cancelled" on the desk. This
 * column records which it was, and `closedReason` keeps what the operator said.
 *
 * It is written beside `closedAt` / `closedBy` by every path that ends a booking early. A
 * normal close after the stay (status CLOSED at S9) writes nothing here: that ending is not
 * ambiguous and the desk has always had its own words for it.
 *
 * Null is expected and must stay readable — every booking ended before this column existed
 * has none, and the desk falls back to the bare status word for those.
 */
export const ENTRY_ENDINGS = {
  /** The inquiry window ran out with nobody having answered. A clock, not a person. */
  INQUIRY_LAPSED: "INQUIRY_LAPSED",
  /** The negotiation window ran out — the offer was never taken up. A clock, not a person. */
  NEGOTIATION_LAPSED: "NEGOTIATION_LAPSED",
  /** A park ran its full window and nobody resumed it. A clock, not a person. */
  PARK_LAPSED: "PARK_LAPSED",
  /** The guest said no, before anything was committed. The desk's own act, with their words. */
  DECLINED: "DECLINED",
  /** Cancelled from Set up onward — the priced act, with its penalty and refund. */
  CANCELLED: "CANCELLED",
  /** Checked in, then left for good without settling through check-out. */
  WALKED_OUT: "WALKED_OUT",
} as const;

export type EntryEnding = (typeof ENTRY_ENDINGS)[keyof typeof ENTRY_ENDINGS];
