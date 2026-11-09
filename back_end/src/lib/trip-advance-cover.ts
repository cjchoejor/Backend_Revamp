import { Prisma } from "@prisma/client";
import { maxZeroSub, toDecimal } from "./money.js";

export type TripAdvanceRow = {
  entryId: string;
  /** The advance asked of this stay. */
  asked: Prisma.Decimal;
  /** What this stay's bill holds for itself: money in, less money gone or waiting to go back. */
  held: Prisma.Decimal;
  /** Of the money in, what the desk recorded as a payment for the whole trip. */
  paidForTrip: Prisma.Decimal;
};

/**
 * HOW MUCH OF EACH STAY'S ADVANCE THE TRIP'S PAYMENT COVERS (2026-11-09, operator: "we asked trips
 * totals 50 percent, and even paid it"). Money.
 *
 * A trip payment can be shared unevenly, so one stay can hold more than its own advance while
 * another holds less. What a stay holds beyond its advance, up to what was paid for the trip,
 * covers the other stays' advances, the earliest stay first (rows arrive in stay order). Each
 * rupee covers once. Only money paid for the trip counts: a stay paid on its own page keeps it.
 *
 * This moves no money. The cash stays on the bill it was shared to.
 */
export function shareTripAdvanceCover(rows: TripAdvanceRow[]): Map<string, Prisma.Decimal> {
  let spare = rows.reduce((sum, r) => sum.add(Prisma.Decimal.min(maxZeroSub(r.held, r.asked), r.paidForTrip)), toDecimal(0));
  const cover = new Map<string, Prisma.Decimal>();
  for (const r of rows) {
    const take = Prisma.Decimal.min(spare, maxZeroSub(r.asked, r.held));
    cover.set(r.entryId, take);
    spare = spare.sub(take);
  }
  return cover;
}
