import type { Prisma, PrismaClient } from "@prisma/client";
import { PaymentDirection } from "@prisma/client";
import { maxZeroSub, round2, sumMoney, toDecimal } from "./money.js";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Per-TARGET outstanding — "what does Room 205 still owe?" (2026-09-09, PMS-237).
 *
 * Companion to `folio-outstanding-per-billing-model.ts`, which answers the same question for a
 * split-billing bucket ("what does the agent still owe?"). The two axes are independent and
 * deliberately so: a booking can be split by WHO PAYS (billing model) and by WHAT WAS USED
 * (room / space), and the operator's ask — "the guest in 205 wants to pay for 205 and leave" —
 * is the second one.
 *
 * A target is one of:
 *   { roomId }   — the charges posted against that room
 *   { spaceId }  — the charges posted against that conference room / hall
 *   "UNASSIGNED" — the lines that name neither, i.e. the booking as a whole
 *
 * Every folio line lands in exactly one target (the DB's `folio_line_target_xor` constraint
 * guarantees a line never names both), so the targets partition the ledger and their charge
 * totals always sum to `billedSoFar`.
 *
 * ## Money received is NOT partitioned the same way, and that matters
 *
 * A charge always knows what it was for. A PAYMENT often does not: the S3 advance is money
 * against the BOOKING, taken before anyone knows which room will run up a minibar bill.
 * `PaymentRecord.roomId` / `.spaceId` are therefore written only when the operator settles a
 * specific slice; an advance carries neither.
 *
 * So an unattributed payment reduces the folio's balance without reducing any one target's,
 * and `Σ targetOutstanding ≥ folio.outstandingBalance`. That gap is not an error — it is
 * money the hotel holds that has not been applied to a slice yet — but it must be SHOWN, never
 * silently netted off one target. `summariseSettlementTargets` returns it as `unappliedPayments`
 * so the desk can say so, and settlement caps what a slice can take at the folio's own balance.
 *
 * ## Applying the advance is the deliberate act that closes that gap (2026-09-11)
 *
 * The operator can now say "the guest in 301 is leaving early — take it out of what they already
 * paid". That writes an `AdvanceApplication`: the slice's `paid` rises, `unappliedPayments`
 * falls by the same figure, and the FOLIO'S BALANCE DOES NOT MOVE, because no new money arrived.
 * It is attribution, not a receipt — which is exactly why an application is not a PaymentRecord
 * (a second IN row would be summed again and the hotel would believe it was paid twice).
 *
 * The automatic netting this module refuses is still refused. Nothing is applied unless someone
 * chooses to apply it, and every application says who, when, how much, and against what.
 */
export type SettlementTarget = { roomId: string; spaceId?: never } | { spaceId: string; roomId?: never } | "UNASSIGNED";

export type SettlementTargetSummary = {
  target: SettlementTarget;
  /** Room number / space name for the desk; null when the row is gone from the registry. */
  label: string | null;
  /** Σ of this target's folio lines — charges, taxes, corrections and credit notes alike. */
  charges: Prisma.Decimal;
  /** Money already applied to THIS target — payments scoped to it, plus applied advance. */
  paid: Prisma.Decimal;
  /** The part of `paid` that came from the advance rather than a fresh payment (2026-09-11). */
  advanceApplied: Prisma.Decimal;
  /** max(0, charges − paid). */
  outstanding: Prisma.Decimal;
  lineCount: number;
};

function targetWhere(target: SettlementTarget) {
  if (target === "UNASSIGNED") return { roomId: null, spaceId: null };
  if ("roomId" in target && target.roomId) return { roomId: target.roomId };
  return { spaceId: (target as { spaceId: string }).spaceId };
}

/**
 * Applied advance for one target: applications minus their reversals. A reversal is its own
 * row (amounts are positive by DB check), so it is subtracted here rather than stored negative.
 */
export async function computeAdvanceAppliedToTarget(
  tx: Tx,
  folioId: string,
  target: SettlementTarget,
): Promise<Prisma.Decimal> {
  if (target === "UNASSIGNED") return round2(toDecimal(0)); // nothing is applied to "the booking"
  const scope = targetWhere(target);
  const [applied, reversed] = await Promise.all([
    tx.advanceApplication.aggregate({ where: { folioId, reversalOfId: null, ...scope }, _sum: { amount: true } }),
    tx.advanceApplication.aggregate({
      where: { folioId, reversalOfId: { not: null }, ...scope },
      _sum: { amount: true },
    }),
  ]);
  return round2(toDecimal(applied._sum.amount).sub(toDecimal(reversed._sum.amount)));
}

/** `max(0, charges − payments IN + payments OUT − applied advance)` for one target. */
export async function computeOutstandingForTarget(
  tx: Tx,
  folioId: string,
  target: SettlementTarget,
): Promise<Prisma.Decimal> {
  const scope = targetWhere(target);
  const [lineAgg, inAgg, outAgg, advance] = await Promise.all([
    tx.folioLine.aggregate({ where: { folioId, ...scope }, _sum: { amount: true } }),
    tx.paymentRecord.aggregate({
      where: { folioId, paymentDirection: PaymentDirection.IN, ...scope },
      _sum: { amount: true },
    }),
    tx.paymentRecord.aggregate({
      where: { folioId, paymentDirection: PaymentDirection.OUT, ...scope },
      _sum: { amount: true },
    }),
    computeAdvanceAppliedToTarget(tx, folioId, target),
  ]);
  return round2(
    maxZeroSub(
      toDecimal(lineAgg._sum.amount).add(toDecimal(outAgg._sum.amount)),
      toDecimal(inAgg._sum.amount).add(advance),
    ),
  );
}

/**
 * Every target a folio actually has, with its charges, what has been applied to it and what
 * it still owes — the list the settlement UI renders one row per.
 *
 * "UNASSIGNED" is included ONLY when lines name neither a room nor a space; a single-room
 * booking with everything on the room does not get an empty extra row. Rooms sort by number
 * (numerically), spaces by name, and the unassigned slice sorts last — it is the leftover.
 */
export async function summariseSettlementTargets(
  tx: Tx,
  folioId: string,
): Promise<{
  targets: SettlementTargetSummary[];
  /** Money on the folio applied to no target — the advance, typically. Never negative. */
  unappliedPayments: Prisma.Decimal;
  /** The folio's own balance; a slice can never take more than this. */
  folioOutstanding: Prisma.Decimal;
}> {
  const [lines, payments, applications, folio] = await Promise.all([
    tx.folioLine.findMany({
      where: { folioId },
      select: { amount: true, roomId: true, spaceId: true },
    }),
    tx.paymentRecord.findMany({
      where: { folioId },
      select: { amount: true, paymentDirection: true, roomId: true, spaceId: true },
    }),
    tx.advanceApplication.findMany({
      where: { folioId },
      select: { amount: true, roomId: true, spaceId: true, reversalOfId: true },
    }),
    tx.folio.findUnique({ where: { id: folioId }, select: { outstandingBalance: true } }),
  ]);

  type Bucket = {
    charges: Prisma.Decimal;
    paid: Prisma.Decimal;
    advanceApplied: Prisma.Decimal;
    lineCount: number;
  };
  const empty = (): Bucket => ({
    charges: toDecimal(0),
    paid: toDecimal(0),
    advanceApplied: toDecimal(0),
    lineCount: 0,
  });
  const byRoom = new Map<string, Bucket>();
  const bySpace = new Map<string, Bucket>();
  let unassigned: Bucket = empty();
  const bucket = (m: Map<string, Bucket>, k: string) => m.get(k) ?? empty();

  for (const l of lines) {
    const amt = toDecimal(l.amount);
    if (l.roomId) {
      const b = bucket(byRoom, l.roomId);
      byRoom.set(l.roomId, { ...b, charges: b.charges.add(amt), lineCount: b.lineCount + 1 });
    } else if (l.spaceId) {
      const b = bucket(bySpace, l.spaceId);
      bySpace.set(l.spaceId, { ...b, charges: b.charges.add(amt), lineCount: b.lineCount + 1 });
    } else {
      unassigned = { ...unassigned, charges: unassigned.charges.add(amt), lineCount: unassigned.lineCount + 1 };
    }
  }

  // A refund (OUT) against a slice puts money back onto its balance, so it counts negatively
  // against "paid" — the same sign convention the whole-folio recompute uses.
  const signed = (p: { amount: unknown; paymentDirection: PaymentDirection }) =>
    p.paymentDirection === PaymentDirection.IN ? toDecimal(p.amount as never) : toDecimal(p.amount as never).neg();

  let unapplied = toDecimal(0);
  for (const p of payments) {
    const amt = signed(p);
    if (p.roomId) {
      const b = bucket(byRoom, p.roomId);
      byRoom.set(p.roomId, { ...b, paid: b.paid.add(amt) });
    } else if (p.spaceId) {
      const b = bucket(bySpace, p.spaceId);
      bySpace.set(p.spaceId, { ...b, paid: b.paid.add(amt) });
    } else {
      unapplied = unapplied.add(amt);
    }
  }

  // Applied advance moves money from the unattributed pool onto a slice. It is the SAME money,
  // so it is added to that slice's `paid` and taken off `unapplied` — the folio's own balance
  // is untouched by design (see the header). A reversal row gives its amount back to the pool.
  for (const a of applications) {
    const amt = a.reversalOfId ? toDecimal(a.amount).neg() : toDecimal(a.amount);
    if (a.roomId) {
      const b = bucket(byRoom, a.roomId);
      byRoom.set(a.roomId, { ...b, paid: b.paid.add(amt), advanceApplied: b.advanceApplied.add(amt) });
    } else if (a.spaceId) {
      const b = bucket(bySpace, a.spaceId);
      bySpace.set(a.spaceId, { ...b, paid: b.paid.add(amt), advanceApplied: b.advanceApplied.add(amt) });
    }
    unapplied = unapplied.sub(amt);
  }

  const [rooms, spaces] = await Promise.all([
    byRoom.size > 0
      ? tx.room.findMany({ where: { id: { in: [...byRoom.keys()] } }, select: { id: true, roomNumber: true } })
      : Promise.resolve([] as Array<{ id: string; roomNumber: string }>),
    bySpace.size > 0
      ? tx.space.findMany({ where: { id: { in: [...bySpace.keys()] } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  const roomNumber = new Map(rooms.map((r) => [r.id, r.roomNumber]));
  const spaceName = new Map(spaces.map((s) => [s.id, s.name]));

  const shape = (target: SettlementTarget, label: string | null, b: Bucket): SettlementTargetSummary => ({
    target,
    label,
    charges: round2(b.charges),
    paid: round2(b.paid),
    advanceApplied: round2(b.advanceApplied),
    outstanding: round2(maxZeroSub(b.charges, b.paid)),
    lineCount: b.lineCount,
  });

  const targets: SettlementTargetSummary[] = [
    ...[...byRoom.entries()]
      .map(([roomId, b]) => shape({ roomId }, roomNumber.get(roomId) ?? null, b))
      .sort((a, z) => (a.label ?? "").localeCompare(z.label ?? "", undefined, { numeric: true })),
    ...[...bySpace.entries()]
      .map(([spaceId, b]) => shape({ spaceId }, spaceName.get(spaceId) ?? null, b))
      .sort((a, z) => (a.label ?? "").localeCompare(z.label ?? "")),
  ];
  // The leftover slice earns a row only when something is actually in it.
  if (unassigned.lineCount > 0) targets.push(shape("UNASSIGNED", null, unassigned));

  return {
    targets,
    // Money held against the booking as a whole. Clamped at zero: a net-refunded folio would
    // otherwise report negative "unapplied", which reads as the guest owing the hotel a credit.
    unappliedPayments: round2(maxZeroSub(unapplied, 0)),
    folioOutstanding: round2(toDecimal(folio?.outstandingBalance)),
  };
}

/**
 * What a slice can actually be asked for right now: its own outstanding, capped at the folio's
 * balance. The cap is what keeps unattributed money honest — an advance already reduced the
 * folio, so charging a slice its full gross would collect that money twice.
 */
export function collectableForTarget(targetOutstanding: Prisma.Decimal, folioOutstanding: Prisma.Decimal) {
  return round2(targetOutstanding.gt(folioOutstanding) ? folioOutstanding : targetOutstanding);
}

/** Σ of every target's outstanding — for the reconciliation note, never for a demand. */
export function sumTargetOutstanding(targets: readonly SettlementTargetSummary[]): Prisma.Decimal {
  return round2(sumMoney(targets.map((t) => t.outstanding)));
}
