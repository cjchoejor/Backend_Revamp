/**
 * A guest's reply is awaited only for the paper in force (2026-10-13, operator: "suppose a
 * quotation is sent, but before the guest's reply is noted the quotation was changed, which
 * supersedes the previous quote — then you don't have to wait for the old quotation's reply, don't
 * run timers for it or show awaiting reply for it; only for the new one. Do the same for all the
 * papers that await the guest's reply").
 *
 * A sent paper is REPLACED when:
 *   - a quotation: it was superseded, it belongs to an earlier pass, or it lapsed and a newer
 *     quotation exists;
 *   - a proforma, interim bill or final invoice: it was superseded;
 *   - a confirmation voucher or a pre-arrival reminder: it was issued for a reservation that is no
 *     longer the booking's current one (a re-confirmation made a new voucher).
 *
 * Its waiting record moves PENDING → SUPERSEDED (not TIMED_OUT — nobody failed to answer), every
 * reply clock on it is cancelled, and `COMMUNICATION.REPLY_NO_LONGER_AWAITED` is traced with the
 * paper and what replaced it. An answer already RECEIVED is history and is left alone, as is a
 * window that had already TIMED_OUT.
 *
 * `isReplyAwaitedPaperReplaced` is the same rule read-only, for the communications list, so the
 * desk is right even before a write site has run.
 */
import type { CommunicationType, Prisma, PrismaClient } from "@prisma/client";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

type Db = PrismaClient | Prisma.TransactionClient;

const AWAITING_TYPES: CommunicationType[] = [
  "QUOTATION",
  "PROFORMA_INVOICE",
  "CONFIRMATION_VOUCHER",
  "PRE_ARRIVAL_REMINDER",
  "INTERIM_INVOICE",
  "FINAL_INVOICE",
] as CommunicationType[];

type CommRow = { id: string; commType: string; payload: unknown; createdAt: Date };

export type ReplacedPaper = { communicationId: string; commType: string; paperId: string | null; replacedBy: string | null };

/** Which of these communications are about a paper that has been replaced. Reads only. */
export async function findReplacedPapers(db: Db, entryId: string, comms: CommRow[]): Promise<ReplacedPaper[]> {
  if (!comms.length) return [];
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      currentReservationId: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      quotations: { select: { id: true, state: true, segmentId: true, createdAt: true } },
      folio: { select: { invoices: { select: { id: true, state: true, supersededById: true } } } },
    },
  });
  if (!entry) return [];
  const currentSegment = entry.segments[0]?.id ?? null;
  const quotes = new Map(entry.quotations.map((q) => [q.id, q]));
  const newestQuote = [...entry.quotations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  const invoices = new Map((entry.folio?.invoices ?? []).map((i) => [i.id, i]));

  const out: ReplacedPaper[] = [];
  for (const c of comms) {
    const p = (c.payload ?? {}) as { quotationId?: string; invoiceId?: string; reservationId?: string };
    if (c.commType === "QUOTATION" && p.quotationId) {
      const q = quotes.get(p.quotationId);
      if (!q) continue;
      const replaced =
        q.state === "SUPERSEDED" ||
        (!!currentSegment && q.segmentId !== currentSegment) ||
        (q.state === "EXPIRED" && !!newestQuote && newestQuote.id !== q.id);
      if (replaced) out.push({ communicationId: c.id, commType: c.commType, paperId: q.id, replacedBy: newestQuote && newestQuote.id !== q.id ? newestQuote.id : null });
    } else if ((c.commType === "PROFORMA_INVOICE" || c.commType === "INTERIM_INVOICE" || c.commType === "FINAL_INVOICE") && p.invoiceId) {
      const inv = invoices.get(p.invoiceId);
      if (inv && (inv.state === "SUPERSEDED" || !!inv.supersededById)) {
        out.push({ communicationId: c.id, commType: c.commType, paperId: inv.id, replacedBy: inv.supersededById ?? null });
      }
    } else if ((c.commType === "CONFIRMATION_VOUCHER" || c.commType === "PRE_ARRIVAL_REMINDER") && p.reservationId) {
      if (entry.currentReservationId && p.reservationId !== entry.currentReservationId) {
        out.push({ communicationId: c.id, commType: c.commType, paperId: p.reservationId, replacedBy: entry.currentReservationId });
      }
    }
  }
  return out;
}

/**
 * The newest paper of a kind that went out AND is still in force — what every "the guest's answer
 * is recorded" gate reads (2026-10-13). A replaced paper's answer is never demanded: it may not be
 * recorded any more (Policy 52), so a gate keyed on it would hold the booking for good. When the
 * paper in force has not gone out, there is nothing to answer, which is the generate-vs-send rule.
 */
export async function latestDispatchedInForce(
  db: Db,
  args: { entryId: string; commType: CommunicationType; since?: Date | null },
): Promise<{ id: string; acknowledgementStatus: string | null } | null> {
  const rows = await db.communicationRecord.findMany({
    where: {
      entryId: args.entryId,
      commType: args.commType,
      direction: "OUTBOUND",
      sendStatus: "DISPATCHED",
      OR: [{ acknowledgementStatus: null }, { acknowledgementStatus: { not: "SUPERSEDED" } }],
      ...(args.since ? { createdAt: { gte: args.since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, commType: true, payload: true, createdAt: true, acknowledgementStatus: true },
  });
  if (!rows.length) return null;
  const replaced = new Set((await findReplacedPapers(db, args.entryId, rows)).map((r) => r.communicationId));
  const inForce = rows.find((r) => !replaced.has(r.id));
  return inForce ? { id: inForce.id, acknowledgementStatus: inForce.acknowledgementStatus } : null;
}

/**
 * Stop waiting for replies to replaced papers on this booking. Safe to call after any act that
 * makes, sends or replaces a paper; idempotent. Returns how many waits it stopped.
 */
export async function retireSupersededReplyWaits(prisma: PrismaClient, entryId: string, actorId: string): Promise<number> {
  const pending = await prisma.communicationRecord.findMany({
    where: { entryId, acknowledgementStatus: "PENDING", commType: { in: AWAITING_TYPES } },
    select: { id: true, commType: true, payload: true, createdAt: true, stageContext: true },
  });
  const replaced = await findReplacedPapers(prisma, entryId, pending);
  if (!replaced.length) return 0;

  const ids = replaced.map((r) => r.communicationId);
  const quoteIds = replaced.filter((r) => r.commType === "QUOTATION" && r.paperId).map((r) => r.paperId!);
  const timers = await prisma.timerRecord.findMany({
    where: {
      status: "SCHEDULED",
      OR: [
        { entityType: "CommunicationRecord", entityId: { in: ids } },
        // A quotation's own reply tracker is anchored on the quotation, not the email.
        ...(quoteIds.length ? [{ entityType: "Quotation", entityId: { in: quoteIds }, timerCode: { contains: "ACK" } }] : []),
      ],
    },
    select: { id: true, pgBossJobId: true },
  });
  if (timers.length) {
    const engine = await getTimerEngine();
    await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId).catch(() => {}) : Promise.resolve())));
  }

  // A voucher is named by its own number, not its reservation's id.
  const resIds = replaced
    .filter((r) => r.commType === "CONFIRMATION_VOUCHER" || r.commType === "PRE_ARRIVAL_REMINDER")
    .flatMap((r) => [r.paperId, r.replacedBy])
    .filter((x): x is string => !!x);
  const voucherNo = new Map(
    resIds.length
      ? (
          await prisma.reservation.findMany({ where: { id: { in: resIds } }, select: { id: true, confirmationVoucherNumber: true } })
        ).map((r) => [r.id, r.confirmationVoucherNumber ?? r.id])
      : [],
  );
  const numberOf = (id: string | null) => (id ? voucherNo.get(id) ?? id : null);

  const now = new Date();
  const stageOf = new Map(pending.map((p) => [p.id, p.stageContext]));
  await prisma.$transaction(async (tx) => {
    await tx.communicationRecord.updateMany({
      where: { id: { in: ids }, acknowledgementStatus: "PENDING" },
      data: { acknowledgementStatus: "SUPERSEDED" },
    });
    if (timers.length) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) } },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "PAPER_REPLACED" },
      });
    }
    for (const r of replaced) {
      await tx.traceEvent.create({
        data: {
          eventType: "COMMUNICATION.REPLY_NO_LONGER_AWAITED",
          actorId,
          actorLevel: actorId === "SYSTEM" ? "SYSTEM" : "L1",
          entityType: "CommunicationRecord",
          entityId: r.communicationId,
          operation: "UPDATE",
          timestamp: now,
          stageContext: stageOf.get(r.communicationId) ?? undefined,
          entryId,
          payload: {
            communicationId: r.communicationId,
            commType: r.commType,
            paperId: r.paperId,
            replacedBy: r.replacedBy,
            paperNumber: numberOf(r.paperId),
            replacedByNumber: numberOf(r.replacedBy),
          },
          createdBy: actorId,
        } as never,
      });
    }
  });
  return replaced.length;
}

/** The same, never failing the act that called it — a stale wait is untidy, not dangerous. */
export async function retireSupersededReplyWaitsBestEffort(prisma: PrismaClient, entryId: string, actorId: string): Promise<void> {
  try {
    await retireSupersededReplyWaits(prisma, entryId, actorId);
  } catch (e) {
    console.warn(`[reply-waits] could not retire replaced papers' waits on ${entryId}:`, e);
  }
}
