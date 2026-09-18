import type { PrismaClient } from "@prisma/client";
import { PaymentDirection } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { toDecimal } from "../../lib/money.js";

/**
 * What a folio has been paid ABOVE its bill (2026-09-18): the money the hotel holds for the guest.
 *
 * The stored balance floors at zero — `max(0, lines − in + out − write-offs)` — so a guest who
 * prepaid the whole stay and left on the first day (bill: one night's fee) had the rest of their
 * money vanish from every figure: "received 4,851 · still owed 0", and nothing said the hotel owed
 * them 2,425.50. This is the other side of that floor, computed from the same sums.
 */
export async function computeFolioOverpaid(db: PrismaClient, folioId: string) {
  const [lines, paidIn, paidOut, writtenOff] = await Promise.all([
    db.folioLine.aggregate({ where: { folioId }, _sum: { amount: true } }),
    db.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.IN }, _sum: { amount: true } }),
    db.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.OUT }, _sum: { amount: true } }),
    db.writeOffRecord.aggregate({ where: { folioId }, _sum: { writtenOffAmount: true } }),
  ]);
  const raw = toDecimal(lines._sum.amount)
    .sub(toDecimal(paidIn._sum.amount))
    .add(toDecimal(paidOut._sum.amount))
    .sub(toDecimal(writtenOff._sum.writtenOffAmount));
  return raw.lt(0) ? raw.neg().toDecimalPlaces(2) : toDecimal(0);
}

/**
 * Give back money a guest paid above the bill (2026-09-18) — FOM (the route). Recorded as money
 * OUT with how it went back and why; never more than was overpaid, so a refund can only return
 * the guest's own money. Automatic refunds stay deliberately unbuilt (docs/early-departure.md):
 * this is the desk recording a refund it has made.
 */
export async function recordFolioRefund(
  prisma: PrismaClient,
  folioId: string,
  actor: { actorId: string; actorLevel: string },
  input: { amount: number; paymentMethod: string; reference?: string | null; reason: string },
) {
  const folio = await prisma.folio.findUnique({
    where: { id: folioId },
    select: { id: true, entryId: true, entry: { select: { id: true, status: true, currentStage: true, inquiryId: true } } },
  });
  if (!folio?.entry) throw new NotFoundError("Folio");
  if (folio.entry.status !== "ACTIVE") {
    throw new StateTransitionError("A refund is recorded while the booking is open — this record is sealed");
  }
  if (!input.reason?.trim()) throw new ValidationError("Say why the money goes back");
  const amount = toDecimal(input.amount);
  if (!amount.gt(0)) throw new ValidationError("A refund is a positive amount");
  const overpaid = await computeFolioOverpaid(prisma, folioId);
  if (amount.gt(overpaid)) {
    throw new ValidationError(
      overpaid.gt(0)
        ? `That is more than the ${overpaid.toFixed(2)} paid above the bill — refund at most ${overpaid.toFixed(2)}`
        : "Nothing has been paid above the bill — there is nothing to refund",
    );
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const id = await allocateReadableId(tx, "PAYMENT" as const, now);
    const created = await tx.paymentRecord.create({
      data: {
        id,
        folioId,
        entryId: folio.entryId,
        amount,
        paymentDirection: PaymentDirection.OUT,
        paymentMethod: input.paymentMethod.trim(),
        receivedAt: now,
        recordedBy: actor.actorId,
        stage: folio.entry!.currentStage,
        notes: `REFUND:${input.reason.trim()}${input.reference?.trim() ? `:${input.reference.trim()}` : ""}`,
      },
    });
    await recomputeFolioOutstandingBalance(tx, folioId);
    await tx.traceEvent.create({
      data: {
        eventType: "FOLIO.REFUND_RECORDED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as never,
        entityType: "Folio",
        entityId: folioId,
        operation: "CREATE",
        timestamp: now,
        stageContext: folio.entry!.currentStage,
        inquiryId: folio.entry!.inquiryId,
        entryId: folio.entryId,
        payload: {
          folioId,
          paymentId: created.id,
          amount: amount.toFixed(2),
          overpaidBefore: overpaid.toFixed(2),
          paymentMethod: input.paymentMethod,
          reason: input.reason.trim(),
          reference: input.reference?.trim() || null,
        },
        createdBy: actor.actorId,
      },
    });
    return created;
  });
}
