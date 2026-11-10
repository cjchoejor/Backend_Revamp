import type { Prisma, PrismaClient } from "@prisma/client";
import { ZERO, type MoneyLike, toDecimal } from "./money.js";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * The after-stay handoff follows the money (2026-11-10, operator: "do it", after "do you think it's
 * really needed for someone to manually click it every time after the bill is paid in full").
 *
 * The handoff is raised at check-out when the guest leaves owing money; it says someone has to chase
 * it. Pressing "Mark it done" once nothing was owed recorded nothing the bill did not already say, so
 * the system closes it itself, the moment the bill comes to exactly zero — a payment that clears it,
 * the GM's write-off, or a refund that settles money paid over — and records why and whose act it
 * was. It stays open while the hotel owes the guest money back, until the refund is recorded.
 *
 * A recorded deviation from SIG-S9 §501 ("H5 does not close automatically. FOM must explicitly
 * fulfil H5"). SIG-S9 §223 already closes it automatically at check-out when nothing is owed; this
 * applies that rule at the Closed step too.
 *
 * And the other way: a charge found after departure that leaves money owed again opens it again,
 * so a booking is never sealed reading "done" over a bill someone still has to collect.
 *
 * Called by `recomputeFolioOutstandingBalance`, the one place a bill's balance is worked out, so
 * every act that moves the money — whatever route it came by — keeps the handoff in step.
 */
const OPEN_STATES = new Set(["CREATED", "ACCEPTED", "ESCALATED"]);

export type AfterStayBasis = "PAID_IN_FULL" | "WRITTEN_OFF" | "REFUNDED";

export async function syncAfterStayHandoffTx(
  tx: Tx,
  folioId: string,
  /** The bill's balance before it is floored at zero: above zero owed, below zero paid over. */
  net: MoneyLike,
): Promise<void> {
  const balance = toDecimal(net);
  const folio = await tx.folio.findUnique({ where: { id: folioId }, select: { entryId: true } });
  if (!folio) return;
  const entry = await tx.entry.findUnique({
    where: { id: folio.entryId },
    select: { id: true, currentStage: true, status: true, inquiryId: true },
  });
  // Only on the Closed step, before the seal: that is where the handoff lives.
  if (!entry || entry.currentStage !== "S9" || entry.status === "CLOSED") return;
  const h5 = await tx.handoffRecord.findFirst({
    where: { entryId: entry.id, handoffType: "H5" },
    orderBy: { createdAt: "desc" },
  });
  if (!h5) return;
  const now = new Date();

  if (OPEN_STATES.has(String(h5.state)) && balance.isZero()) {
    const settled = await whatSettledIt(tx, folioId);
    await tx.handoffRecord.update({
      where: { id: h5.id },
      data: {
        state: "FULFILLED",
        fulfilledAt: now,
        fulfilledBy: "SYSTEM",
        fulfilmentEvidence: {
          resolutionBasis: settled.basis,
          autoRecorded: true,
          settledBy: settled.by,
          settledAt: settled.at,
          note: "Closed by the system once nothing was left to settle on the bill",
        } as Prisma.InputJsonValue,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "HANDOFF.H5_FULFILLED",
        actorId: "SYSTEM",
        actorLevel: "L1",
        entityType: "HandoffRecord",
        entityId: h5.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: "S9",
        inquiryId: entry.inquiryId ?? null,
        entryId: entry.id,
        payload: { handoffId: h5.id, entryId: entry.id, type: "H5", auto: true, basis: settled.basis, settledBy: settled.by },
        createdBy: "SYSTEM",
      },
    });
    return;
  }

  if (String(h5.state) === "FULFILLED" && balance.gt(ZERO)) {
    await tx.handoffRecord.update({
      where: { id: h5.id },
      data: { state: "CREATED", fulfilledAt: null, fulfilledBy: null, isAutoFulfilled: false },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "HANDOFF.H5_REOPENED",
        actorId: "SYSTEM",
        actorLevel: "L1",
        entityType: "HandoffRecord",
        entityId: h5.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: "S9",
        inquiryId: entry.inquiryId ?? null,
        entryId: entry.id,
        payload: { handoffId: h5.id, entryId: entry.id, type: "H5", owed: balance.toFixed(2) },
        createdBy: "SYSTEM",
      },
    });
  }
}

/** The last act that moved the money: a write-off, a payment in, or a refund out. */
async function whatSettledIt(tx: Tx, folioId: string): Promise<{ basis: AfterStayBasis; by: string | null; at: string | null }> {
  const [pay, off] = await Promise.all([
    tx.paymentRecord.findFirst({ where: { folioId }, orderBy: { createdAt: "desc" }, select: { paymentDirection: true, recordedBy: true, createdAt: true } }),
    tx.writeOffRecord.findFirst({ where: { folioId }, orderBy: { createdAt: "desc" }, select: { createdBy: true, createdAt: true } }),
  ]);
  if (off && (!pay || off.createdAt >= pay.createdAt)) return { basis: "WRITTEN_OFF", by: off.createdBy, at: off.createdAt.toISOString() };
  if (pay) return { basis: String(pay.paymentDirection) === "OUT" ? "REFUNDED" : "PAID_IN_FULL", by: pay.recordedBy ?? null, at: pay.createdAt.toISOString() };
  return { basis: "PAID_IN_FULL", by: null, at: null };
}
