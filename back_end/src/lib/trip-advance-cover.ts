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

export type TripMove = { from: string; to: string; amount: Prisma.Decimal };

/**
 * ONE POT WHEN A STAY OF A TRIP IS CANCELLED (2026-11-09, operator). Money. What the desk recorded for
 * the trip is one pot, wherever it was shared to. The moves put the money where it would have been
 * had each stay held its own advance, so the stay's ordinary cancellation (a charge, the rest
 * refunded) then comes out right:
 *   1. a stay covered by another's money brings its covered share onto its own bill;
 *   2. what the cancelled stay holds beyond its charge goes first to the advances the other stays
 *      still lack, and only the rest is refunded;
 *   3. if its bill still cannot pay the charge, the rest of the charge comes from money paid for the
 *      trip on the other bills: the charge is collected even if that leaves another stay short.
 * Only money paid for the trip ever moves. `rows` are in stay order, the bills that can still take
 * or give money. A waived charge is passed as zero.
 */
export function planTripCancelMoves(rows: TripAdvanceRow[], cancelledId: string, charge: Prisma.Decimal): TripMove[] {
  const found = rows.find((r) => r.entryId === cancelledId);
  if (!found || rows.length < 2) return [];
  const x = { ...found };
  const others = rows.filter((r) => r.entryId !== cancelledId).map((r) => ({ ...r }));
  const moves: TripMove[] = [];
  const shift = (from: TripAdvanceRow, to: TripAdvanceRow, amount: Prisma.Decimal) => {
    moves.push({ from: from.entryId, to: to.entryId, amount });
    from.held = from.held.sub(amount);
    from.paidForTrip = from.paidForTrip.sub(amount);
    to.held = to.held.add(amount);
    to.paidForTrip = to.paidForTrip.add(amount);
  };

  bringCoverHome(rows, x, others, shift);

  const covered = shareTripAdvanceCover(others);
  let giveable = Prisma.Decimal.min(maxZeroSub(x.held, charge), x.paidForTrip);
  for (const r of others) {
    if (giveable.lte(0)) break;
    const t = Prisma.Decimal.min(giveable, maxZeroSub(r.asked, r.held.add(covered.get(r.entryId) ?? toDecimal(0))));
    if (t.gt(0)) {
      shift(x, r, t);
      giveable = giveable.sub(t);
    }
  }

  let missing = maxZeroSub(charge, x.held);
  for (const r of [...others].reverse()) {
    if (missing.lte(0)) break;
    const t = Prisma.Decimal.min(missing, Prisma.Decimal.min(r.held, r.paidForTrip));
    if (t.gt(0)) {
      shift(r, x, t);
      missing = missing.sub(t);
    }
  }
  return moves;
}

/** Step 1 of the one pot: a stay covered by another's trip money brings its covered share home. */
function bringCoverHome(
  rows: TripAdvanceRow[],
  x: TripAdvanceRow,
  others: TripAdvanceRow[],
  shift: (from: TripAdvanceRow, to: TripAdvanceRow, amount: Prisma.Decimal) => void,
) {
  let want = shareTripAdvanceCover(rows).get(x.entryId) ?? toDecimal(0);
  for (const r of others) {
    if (want.lte(0)) break;
    const t = Prisma.Decimal.min(want, Prisma.Decimal.min(maxZeroSub(r.held, r.asked), r.paidForTrip));
    if (t.gt(0)) {
      shift(r, x, t);
      want = want.sub(t);
    }
  }
}

/**
 * What a stay holds as its advance paid once its covered share of the trip's money has come home
 * (2026-11-10) — the base a cancellation line "a percent of the advance paid" is taken of, so a stay
 * covered by the trip's payment pays its share as if it had paid its own advance. Null when the stay
 * is not among the rows.
 */
export function heldAfterTripCover(rows: TripAdvanceRow[], cancelledId: string): Prisma.Decimal | null {
  const found = rows.find((r) => r.entryId === cancelledId);
  if (!found) return null;
  if (rows.length < 2) return found.held;
  const x = { ...found };
  const others = rows.filter((r) => r.entryId !== cancelledId).map((r) => ({ ...r }));
  bringCoverHome(rows, x, others, (from, to, amount) => {
    from.held = from.held.sub(amount);
    from.paidForTrip = from.paidForTrip.sub(amount);
    to.held = to.held.add(amount);
    to.paidForTrip = to.paidForTrip.add(amount);
  });
  return x.held;
}

/**
 * A stay's charge, or how to work it out from what it holds once its cover is home — null when the
 * stay is not among the rows (no money was paid for the trip), the caller then takes its own money.
 */
export type TripCancelCharge = Prisma.Decimal | ((paid: Prisma.Decimal | null) => Prisma.Decimal);

/** Several stays cancelled one after another, in the order given: what each would hold, the moves, and its charge. */
export function simulateTripCancels(rows: TripAdvanceRow[], picks: Array<{ entryId: string; charge: TripCancelCharge }>) {
  let live = rows.map((r) => ({ ...r }));
  return picks.map((p) => {
    const charge = typeof p.charge === "function" ? p.charge(heldAfterTripCover(live, p.entryId)) : p.charge;
    const moves = planTripCancelMoves(live, p.entryId, charge);
    for (const m of moves) {
      const from = live.find((r) => r.entryId === m.from)!;
      const to = live.find((r) => r.entryId === m.to)!;
      from.held = from.held.sub(m.amount);
      from.paidForTrip = from.paidForTrip.sub(m.amount);
      to.held = to.held.add(m.amount);
      to.paidForTrip = to.paidForTrip.add(m.amount);
    }
    const x = live.find((r) => r.entryId === p.entryId);
    live = live.filter((r) => r.entryId !== p.entryId);
    return { entryId: p.entryId, moves, held: x?.held ?? null, charge };
  });
}
