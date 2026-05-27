import type { Prisma, PrismaClient } from "@prisma/client";
import { CommissionDueStatus, EntryStatus, FolioState, InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { randomUUID } from "node:crypto";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { schedulePaymentFollowUpW8IfOutstanding } from "../../lib/schedule-payment-followup-w8.js";
import { enforceWriteOffConstraints } from "../../policies/13-billing-model/write-off-policy-constraints.js";
import {
  enforceApartmentSecurityDepositResolvedForS9Closure,
  enforceDirectBillPaymentsMatchedForS9Closure,
  enforceEntryAtS9ForPostStayCharge,
  enforceGovernmentInvoicePaymentTrackedForS9Closure,
  enforceInvoicesDispatchedForS9Closure,
  enforceOutstandingFolioHasW8OrWriteOffForS9Closure,
  enforcePostStayChargeNotWithinStayWindow,
} from "../../policies/13-billing-model/p33-s9-closure-invoice-payment-and-poststay-gates.js";
import { enforceEquipmentReturnResolvedForS9Closure } from "../../policies/01-availability/p01-equipment-return-resolved-for-s9-closure.js";
import { enforceInspectionResolvedForS9Closure } from "../../policies/19-deficient-condition/p51-s9-closure-inspection-resolution.js";
import { enforceNoOpenDisputesForS9Closure } from "../../policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.js";
import { enforceH5NotBlockingS9Closure } from "../../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import { enforceNoShowDeterminationPresentForS9Closure } from "../../policies/22-no-show/p56-no-show-determination-required-for-s9-closure.js";
import { enforceEntryAtS9ForS9Closure, enforceEntryNotAlreadyClosed } from "../../policies/01-availability/p01-entry-at-s9-for-closure.js";
import {
  enforceInvoiceStateForPaymentTracked,
  enforceInvoiceStateForReconciled,
} from "../../policies/13-billing-model/p33-invoice-payment-state-transitions.js";
import { enforceFolioOutstandingForWriteOff } from "../../policies/13-billing-model/p33-folio-outstanding-for-write-off.js";
import { shouldCreateCommissionDueRecord } from "../../policies/28-commission-production/p68-commission-due-record-creation.js";
import { computeGuestDataRetentionDueAt } from "../../policies/07-guest-data-governance/p18-guest-data-retention.js";
import { enforceNoShowFinancialAmountsNonNegative } from "../../policies/22-no-show/p57-no-show-folio-financial.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

async function resolveGuestDataRetentionPeriodDays(db: DbClient): Promise<number> {
  try {
    const v = await requireActiveConfigValue<number>(db as any, "identity.document.retentionPeriodDays");
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* use fallbacks below */
  }
  try {
    const map = await requireActiveConfigValue<Record<string, number>>(db as any, "identity.retentionPeriodDays");
    const n = Number(map?.DEFAULT);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* ignore */
  }
  return 365;
}

export async function listInvoices(prisma: PrismaClient, folioId: string) {
  return prisma.invoice.findMany({ where: { folioId }, orderBy: { createdAt: "desc" } });
}

/** SIG-S9 §8.4 — create a DRAFT final invoice when none was issued at S8 (post-stay / government paths). */
export async function issueInvoiceAtS9(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; templateKey?: string },
) {
  const folio = await prisma.folio.findUnique({ where: { id: folioId }, include: { entry: true } });
  if (!folio?.entry) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");
  enforceEntryAtS9ForS9Closure({ currentStage: folio.entry.currentStage });
  if (folio.state === FolioState.PROVISIONAL) {
    throw new ValidationError("Cannot issue S9 invoice on a provisional folio");
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const invoiceId = await allocateReadableId(tx, READABLE_ID_PREFIXES.INVOICE, now);
    return tx.invoice.create({
      data: {
        id: invoiceId,
        folioId,
        entryId: input.entryId,
        invoiceType: InvoiceType.FINAL,
        state: InvoiceState.DRAFT,
        templateKey: input.templateKey?.trim() || "final-v1",
        issuedAt: now,
        issuedBy: actorId,
        metadata: { basis: "S9 issueInvoice", stage: Stage.S9 },
      },
    });
  });
}

export async function dispatchInvoice(prisma: PrismaClient, invoiceId: string, actorId: string, input?: { dispatchedTo?: string }) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice");
  if (invoice.state !== InvoiceState.DRAFT) return invoice;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        state: InvoiceState.DISPATCHED,
        dispatchedAt: now,
        dispatchedBy: actorId,
        dispatchedTo: input?.dispatchedTo?.trim() ? input.dispatchedTo.trim() : invoice.dispatchedTo,
        metadata: { ...(invoice.metadata as object | null), dispatchedBy: actorId, dispatchedAt: now.toISOString() } as object,
      },
    });

    // S3 policy: governed PI dispatch must open an acknowledgement loop (W22),
    // and start W34 payment follow-up timers when advance payment is not yet satisfied.
    if (updated.invoiceType === "PROFORMA") {
      const entry = await tx.entry.findUnique({ where: { id: updated.entryId }, include: { folio: { include: { payments: true } } } });
      if (entry?.folio) {
        const ackWindow = await requireActiveConfigValue<Record<string, number>>(tx as any, "acknowledgement.windowPerType");
        const piSeconds = Number((ackWindow as any)?.pi ?? 86400);
        const ackFireAt = new Date(now.getTime() + piSeconds * 1000);

        const engine = await getTimerEngine();
        const comm = await tx.communicationRecord.create({
          data: {
            entryId: updated.entryId,
            channel: "EMAIL",
            // NOTE: We use an existing commType for now to avoid Prisma client regeneration issues on Windows.
            // Semantically this is a proforma invoice dispatch acknowledgement loop.
            commType: "INVOICE_SUPERSEDED_NOTICE",
            stageContext: Stage.S3,
            direction: "OUTBOUND",
            sendStatus: "DISPATCHED",
            acknowledgementStatus: "PENDING",
            acknowledgementTimeoutAt: ackFireAt,
            acknowledgementReceivedAt: null,
            actorId,
            contentSummary: "Proforma invoice dispatched",
            payload: { invoiceId: updated.id, dispatchedTo: updated.dispatchedTo ?? null },
            createdBy: actorId,
          },
        });

        const w22JobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackFireAt });
        await tx.timerRecord.create({
          data: {
            entryId: updated.entryId,
            entityType: "CommunicationRecord",
            entityId: comm.id,
            timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
            timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
            stageContext: Stage.S3,
            dueAt: ackFireAt,
            firesAt: ackFireAt,
            status: "SCHEDULED",
            createdBy: actorId,
            pgBossJobId: w22JobId,
            payload: { communicationRecordId: comm.id },
          },
        });

        const thresholds = await requireActiveConfigValue<any>(tx as any, "advancePayment.thresholds").catch(() => null);
        const requiredAmount = Number(thresholds?.DEFAULT?.amount ?? thresholds?.amount ?? 0);
        const totalIn = (entry.folio.payments ?? []).filter((p) => p.paymentDirection === "IN").reduce((s, p) => s + Number(p.amount.toString()), 0);
        const credit = await tx.creditExtensionCeilingRecord.findUnique({ where: { folioId: entry.folio.id } }).catch(() => null);
        const satisfied = !!credit || (Number.isFinite(requiredAmount) ? totalIn >= requiredAmount : totalIn > 0);
        if (!satisfied) {
          const followUpSeconds = Number(await requireActiveConfigValue<number>(tx as any, "advancePayment.followUpWindowSeconds"));
          const escalationSeconds = Number(await requireActiveConfigValue<number>(tx as any, "advancePayment.escalationWindowSeconds"));
          const t1At = new Date(now.getTime() + followUpSeconds * 1000);
          const t2At = new Date(now.getTime() + escalationSeconds * 1000);

          const t1Id = randomUUID();
          const t2Id = randomUUID();
          const j1 = await engine.schedule("ADVANCE_PAYMENT_FOLLOW_UP_W34", { entryId: updated.entryId, invoiceId: updated.id, tier: 1, timerRecordId: t1Id }, { startAfter: t1At });
          const j2 = await engine.schedule("ADVANCE_PAYMENT_FOLLOW_UP_W34", { entryId: updated.entryId, invoiceId: updated.id, tier: 2, timerRecordId: t2Id }, { startAfter: t2At });

          await tx.timerRecord.createMany({
            data: [
              {
                id: t1Id,
                entryId: updated.entryId,
                entityType: "Invoice",
                entityId: updated.id,
                timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                stageContext: Stage.S3,
                dueAt: t1At,
                firesAt: t1At,
                status: "SCHEDULED",
                createdBy: actorId,
                pgBossJobId: j1,
                payload: { entryId: updated.entryId, invoiceId: updated.id, tier: 1, timerRecordId: t1Id } as any,
              },
              {
                id: t2Id,
                entryId: updated.entryId,
                entityType: "Invoice",
                entityId: updated.id,
                timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                stageContext: Stage.S3,
                dueAt: t2At,
                firesAt: t2At,
                status: "SCHEDULED",
                createdBy: actorId,
                pgBossJobId: j2,
                payload: { entryId: updated.entryId, invoiceId: updated.id, tier: 2, timerRecordId: t2Id } as any,
              },
            ] as any,
          });
        }
      }
    }

    return updated;
  });
}

export async function recordInvoicePaymentEvent(
  prisma: PrismaClient,
  invoiceId: string,
  actorId: string,
  input: {
    nextState: "PAYMENT_TRACKED" | "RECONCILED";
    paymentRef?: string;
    amount?: number;
    paymentMethod?: string;
    receivedAt?: string;
    referenceNumber?: string;
    proofAttachmentId?: string;
  },
) {
  if (input.nextState !== "PAYMENT_TRACKED" && input.nextState !== "RECONCILED") throw new ValidationError("nextState must be PAYMENT_TRACKED or RECONCILED");
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice");

  if (input.nextState === "PAYMENT_TRACKED") {
    enforceInvoiceStateForPaymentTracked({ currentState: invoice.state });
  }
  if (input.nextState === "RECONCILED") {
    enforceInvoiceStateForReconciled({ currentState: invoice.state });
  }

  const now = new Date();
  const receivedAt = input.receivedAt?.trim() ? new Date(input.receivedAt) : null;
  if (receivedAt && Number.isNaN(receivedAt.getTime())) throw new ValidationError("receivedAt must be a valid ISO date");
  const amount = input.amount == null ? null : Number(input.amount);
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) throw new ValidationError("amount must be a positive number when provided");

  return prisma.$transaction(async (tx) => {
    // SIG-S9 §8.6: record a payment event (optional in this repo for backwards compatibility).
    if (amount != null) {
      await tx.paymentRecord.create({
        data: {
          folioId: invoice.folioId,
          invoiceId: invoice.id,
          entryId: invoice.entryId,
          amount: amount as any,
          paymentDirection: "IN",
          paymentMethod: input.paymentMethod?.trim() ? input.paymentMethod.trim() : "CASH",
          receivedAt: receivedAt ?? now,
          recordedBy: actorId,
          stage: Stage.S9,
          notes: input.referenceNumber?.trim()
            ? `POST_STAY_PAYMENT:${input.referenceNumber.trim()}`
            : input.paymentRef?.trim()
              ? `POST_STAY_PAYMENT:${input.paymentRef.trim()}`
              : "POST_STAY_PAYMENT",
        } as any,
      });
      await recomputeFolioOutstandingBalance(tx, invoice.folioId);
      const folio = await tx.folio.findUniqueOrThrow({ where: { id: invoice.folioId } });
      const out = num(folio.outstandingBalance);
      if (out === 0 && folio.state === FolioState.OUTSTANDING) {
        await tx.folio.update({
          where: { id: folio.id },
          data: { state: FolioState.SETTLED, outstandingBalance: 0 } as any,
        });
      }
    }

    return tx.invoice.update({
      where: { id: invoiceId },
      data: {
        state: input.nextState,
        metadata: {
          ...(invoice.metadata as object | null),
          paymentRef: input.paymentRef ?? null,
          referenceNumber: input.referenceNumber ?? null,
          proofAttachmentId: input.proofAttachmentId ?? null,
          updatedBy: actorId,
          updatedAt: now.toISOString(),
        } as object,
      },
    });
  });
}

export async function writeOffOutstandingBalance(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { amount: number; reason: string },
) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new ValidationError("amount must be a positive number");
  await enforceWriteOffConstraints(prisma, { amount: input.amount, reason: input.reason });

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  enforceFolioOutstandingForWriteOff({ folioState: folio.state });

  return prisma.$transaction(async (tx) => {
    const rec = await tx.writeOffRecord.create({
      data: {
        folioId,
        entryId: folio.entryId,
        writtenOffAmount: input.amount,
        reason: input.reason.trim(),
        createdBy: actorId,
      },
    });
    await recomputeFolioOutstandingBalance(tx, folioId);
    await tx.folio.update({ where: { id: folioId }, data: { state: FolioState.WRITTEN_OFF } });
    return rec;
  });
}

async function ensureNoOpenDisputes(db: DbClient, entryId: string) {
  const open = await db.disputeRecord.findFirst({
    where: { entryId, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] } },
    orderBy: { openedAt: "desc" },
  });
  enforceNoOpenDisputesForS9Closure({ openDispute: open });
}

async function ensureInvoicesDispatched(db: DbClient, entryId: string, folioId: string) {
  const bad = await db.invoice.findFirst({ where: { folioId, entryId, state: InvoiceState.DRAFT } });
  enforceInvoicesDispatchedForS9Closure({ draftInvoice: bad });
}

async function ensurePaymentsMatched(db: DbClient, entryId: string, folioId: string) {
  const folio = await db.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.billingModel === "GOVERNMENT") {
    const inv = await db.invoice.findFirst({ where: { folioId, entryId }, orderBy: { createdAt: "desc" } });
    enforceGovernmentInvoicePaymentTrackedForS9Closure({ billingModel: folio.billingModel, latestInvoice: inv ?? undefined });
    return;
  }
  if (folio.billingModel === "DIRECT_BILL") {
    const unmatched = await db.paymentRecord.findFirst({
      where: { folioId, paymentDirection: "IN", invoiceId: null },
      orderBy: { createdAt: "desc" },
    });
    enforceDirectBillPaymentsMatchedForS9Closure({ billingModel: folio.billingModel, unmatchedInPayment: unmatched });
  }
}

async function ensureOutstandingHasW8OrWrittenOff(db: DbClient, entryId: string, folio: { state: FolioState; outstandingBalance: Prisma.Decimal }) {
  const hasW8 = await db.timerRecord.findFirst({ where: { entryId, timerCode: "PAYMENT_FOLLOW_UP_W8", status: "SCHEDULED" } });
  const hasWriteOff = await db.writeOffRecord.findFirst({ where: { entryId } });
  enforceOutstandingFolioHasW8OrWriteOffForS9Closure({
    folioState: folio.state,
    outstandingBalance: num(folio.outstandingBalance),
    hasScheduledW8: !!hasW8,
    hasWriteOff: !!hasWriteOff,
  });
}

async function ensureInspectionResolved(db: DbClient, entryId: string) {
  const insp = await db.roomInspectionRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  let hasNonDeferredCompleted = false;
  if (insp?.isDeferred) {
    const hasCompleted = await db.roomInspectionRecord.findFirst({
      where: { entryId, isDeferred: false },
      orderBy: { createdAt: "desc" },
    });
    hasNonDeferredCompleted = !!hasCompleted;
  }
  const lapsed = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED" },
    orderBy: { createdAt: "desc" },
  });
  enforceInspectionResolvedForS9Closure({
    latestInspection: insp ?? undefined,
    hasNonDeferredCompletedInspection: hasNonDeferredCompleted,
    hasPostCheckoutInspectionWindowExpiredTrace: !!lapsed,
  });
}

async function ensureH5NotOpen(db: DbClient, entryId: string) {
  const h5 = await db.handoffRecord.findFirst({ where: { entryId, handoffType: "H5" }, orderBy: { createdAt: "desc" } });
  enforceH5NotBlockingS9Closure({ h5 });
}

async function ensureEquipmentReturnResolved(db: DbClient, entryId: string) {
  const alloc = await db.equipmentAllocation.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  const breached = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "EQUIPMENT_RETURN.DEADLINE_BREACHED" },
    orderBy: { createdAt: "desc" },
  });
  const resolved = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "EQUIPMENT_RETURN.RESOLVED" },
    orderBy: { createdAt: "desc" },
  });
  enforceEquipmentReturnResolvedForS9Closure({
    allocation: alloc ?? undefined,
    hasDeadlineBreachedTrace: !!breached,
    hasResolvedTrace: !!resolved,
  });
}

async function ensureApartmentDepositResolved(db: DbClient, entry: { id: string; useType: string }, folioId: string) {
  const held = await db.paymentRecord.findFirst({
    where: { folioId, paymentDirection: "IN", notes: { contains: "SECURITY_DEPOSIT_HELD" } },
    orderBy: { createdAt: "desc" },
  });
  const returned = await db.paymentRecord.findFirst({
    where: { folioId, paymentDirection: "OUT", notes: { contains: "SECURITY_DEPOSIT_RETURN" } },
    orderBy: { createdAt: "desc" },
  });
  const zero = await (db as any).traceEvent.findFirst({
    where: { entryId: entry.id, eventType: "SECURITY_DEPOSIT.ZERO_BALANCE_RECORDED" },
    orderBy: { createdAt: "desc" },
  });
  enforceApartmentSecurityDepositResolvedForS9Closure({
    useType: entry.useType,
    hasHeldDeposit: !!held,
    hasReturnOrZeroBalanceEvidence: !!(returned || zero),
  });
}

async function registerW28FeedbackTimer(db: DbClient, entryId: string, actorId: string) {
  const delay = Number(await requireActiveConfigValue<number>(db as any, "feedback.solicitation.delaySeconds"));
  if (!Number.isFinite(delay) || delay < 1) throw new MissingConfigurationError("feedback.solicitation.delaySeconds");
  const dueAt = new Date(Date.now() + delay * 1000);
  const timerRecordId = randomUUID();
  const engine = await getTimerEngine();
  const pgBossJobId = await engine.schedule("FEEDBACK_SOLICITATION_W28", { entryId, timerRecordId }, { startAfter: dueAt });
  await db.timerRecord.create({
    data: {
      id: timerRecordId,
      entryId,
      entityType: "Entry",
      entityId: entryId,
      timerType: "FEEDBACK_SOLICITATION_W28",
      timerCode: "FEEDBACK_SOLICITATION_W28",
      dueAt,
      firesAt: dueAt,
      status: "SCHEDULED",
      pgBossJobId,
      createdBy: actorId,
      payload: { entryId, timerRecordId } as any,
    },
  });
}

async function maybeCreateFollowUpTask(db: DbClient, entry: { id: string; useType: string }, actorId: string) {
  if (entry.useType !== "CONFERENCE" && entry.useType !== "GROUP") return;
  const days = Number(await requireActiveConfigValue<number>(db as any, "followUp.deadlineDays"));
  if (!Number.isFinite(days) || days < 1) throw new MissingConfigurationError("followUp.deadlineDays");
  await db.followUpTaskRecord.create({
    data: { entryId: entry.id, dueAt: new Date(Date.now() + days * 86400_000), createdBy: actorId },
  });
}

async function maybeCreateCommissionDue(db: DbClient, entryId: string, actorId: string) {
  const entry = await db.entry.findUnique({ where: { id: entryId }, include: { inquiry: { include: { agentProfile: true } }, folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  const agent = entry.inquiry.agentProfile;
  const commissionRateNum = agent?.commissionRate != null ? Number(agent.commissionRate) : null;
  if (!shouldCreateCommissionDueRecord({ hasAgentProfile: !!agent, commissionRate: commissionRateNum })) {
    return { created: false as const };
  }

  const profile = agent!;

  const existing = await db.commissionDueRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (existing) return { created: false as const, existing };

  // If commission basis not configured, create RATE_MISSING and schedule W11.
  const now = new Date();
  const isBasisMissing = profile.commissionBasis == null;
  const created = await db.commissionDueRecord.create({
    data: {
      entryId,
      agentProfileId: profile.id,
      commissionRate: profile.commissionRate!,
      commissionBasis: profile.commissionBasis ?? null,
      calculatedAmount: isBasisMissing ? null : (entry.folio ? entry.folio.outstandingBalance : null),
      currency: "BTN",
      status: isBasisMissing ? CommissionDueStatus.RATE_MISSING : CommissionDueStatus.PENDING,
      createdBy: "SYSTEM",
    },
  });

  if (created.status === CommissionDueStatus.RATE_MISSING) {
    const resolutionSeconds = Number((await requireActiveConfigValue<number>(db as any, "commission.rateMissing.resolutionSeconds").catch(() => 3600)) ?? 3600);
    const dueAt = new Date(now.getTime() + resolutionSeconds * 1000);
    const timerRecordId = randomUUID();
    const engine = await getTimerEngine();
    const pgBossJobId = await engine.schedule("COMMISSION_RATE_MISSING_W11", { commissionDueId: created.id, timerRecordId }, { startAfter: dueAt });
    await db.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId,
        entityType: "CommissionDueRecord",
        entityId: created.id,
        timerType: "COMMISSION_RATE_MISSING_W11",
        timerCode: "COMMISSION_RATE_MISSING_W11",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        createdBy: "SYSTEM",
        pgBossJobId,
        payload: { commissionDueId: created.id, entryId, timerRecordId },
      },
    });
  }

  return { created: true as const, record: created };
}

async function processNoShowS9IfNeeded(db: DbClient, entryId: string, actorId: string) {
  const entry = await db.entry.findUnique({ where: { id: entryId }, include: { folio: true, noShowDetermination: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new NotFoundError("Folio");
  if (entry.folio.state !== FolioState.NO_SHOW_CLOSED) return { handled: false as const };
  enforceNoShowDeterminationPresentForS9Closure({
    folioState: entry.folio.state,
    noShowDetermination: entry.noShowDetermination,
  });
  const noShowDetermination = entry.noShowDetermination!;

  // AC-S9-033/034/035: create penalty invoice if retained, ensure refund record if owed, and anchor metadata.
  const determinationId = noShowDetermination.id;
  const penalty = num(entry.folio.noShowPenaltyAmount);
  const net = num(entry.folio.noShowNetPosition);
  enforceNoShowFinancialAmountsNonNegative({ penalty, net });

  if (penalty > 0) {
    const existing = await db.invoice.findFirst({
      where: { entryId, folioId: entry.folio.id, invoiceType: "FINAL", state: "DISPATCHED" },
      orderBy: { createdAt: "desc" },
    });
    if (!existing) {
      await db.invoice.create({
        data: {
          folioId: entry.folio.id,
          entryId,
          invoiceType: "FINAL",
          state: "DISPATCHED",
          templateKey: "final-v1",
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata: { noShowDeterminationId: determinationId, penaltyAmount: penalty } as any,
        },
      });
    }
  }

  if (net > 0) {
    const existingRefund = await db.paymentRecord.findFirst({
      where: { folioId: entry.folio.id, paymentDirection: "OUT", notes: { contains: "NO_SHOW_REFUND" } },
      orderBy: { createdAt: "desc" },
    });
    if (!existingRefund) {
      await db.paymentRecord.create({
        data: {
          folioId: entry.folio.id,
          entryId,
          amount: net as any,
          paymentDirection: "OUT",
          notes: `NO_SHOW_REFUND:${determinationId}`,
          stage: Stage.S9,
          recordedBy: actorId,
        } as any,
      });
      await recomputeFolioOutstandingBalance(db, entry.folio.id);
    }
  }

  return { handled: true as const, noShowDeterminationId: determinationId, penalty, net };
}

export async function closeEntryAtS9(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotAlreadyClosed({ status: entry.status });
  enforceEntryAtS9ForS9Closure({ currentStage: entry.currentStage });
  if (!entry.folio) throw new NotFoundError("Folio");

  await ensureNoOpenDisputes(prisma, entryId);
  await ensureInvoicesDispatched(prisma, entryId, entry.folio.id);
  await ensurePaymentsMatched(prisma, entryId, entry.folio.id);
  await ensureInspectionResolved(prisma, entryId);
  await ensureH5NotOpen(prisma, entryId);
  await ensureEquipmentReturnResolved(prisma, entryId);
  await ensureApartmentDepositResolved(prisma, { id: entryId, useType: entry.useType }, entry.folio.id);

  // Register retention + feedback timers (stubs), and close the entry + release room claim.
  return prisma.$transaction(async (tx) => {
    await processNoShowS9IfNeeded(tx, entryId, actorId);

    // AC-S8-07: OUTSTANDING folios schedule payment follow-up W8 at S9 closure (may already exist from S8→S9).
    if (entry.folio) {
      await schedulePaymentFollowUpW8IfOutstanding(tx, {
        entryId,
        folioId: entry.folio.id,
        folioState: entry.folio.state,
        outstandingBalance: entry.folio.outstandingBalance,
      });
    }

    if (entry.folio) {
      await ensureOutstandingHasW8OrWrittenOff(tx, entryId, entry.folio);
    }

    // AC-S9-029: exclude no-show closed folios from W28 solicitation.
    if (entry.folio?.state !== FolioState.NO_SHOW_CLOSED) {
      await registerW28FeedbackTimer(tx, entryId, actorId);
    }
    await maybeCreateFollowUpTask(tx, { id: entryId, useType: entry.useType }, "system");
    await maybeCreateCommissionDue(tx, entryId, "SYSTEM");

    // Release room inventory claim at closure (AC-S9-016). In this slice, claim is on Room.currentClaimState.
    const ra = await tx.roomAssignment.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
    if (ra) await tx.room.update({ where: { id: ra.roomId }, data: { currentClaimState: "FREE" } });

    const retentionPeriodDays = await resolveGuestDataRetentionPeriodDays(tx);
    const closedAtInstant = new Date();
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.CLOSED, closedAt: closedAtInstant, closedBy: actorId, version: { increment: 1 } },
    });

    const retentionDueAt = computeGuestDataRetentionDueAt({ closedAt: closedAtInstant, retentionPeriodDays });
    const retentionTimerId = randomUUID();
    const retentionEngine = await getTimerEngine();
    const retentionPgBossJobId = await retentionEngine.schedule(
      "GUEST_DATA_RETENTION_P18",
      { entryId, timerRecordId: retentionTimerId },
      { startAfter: retentionDueAt },
    );
    await tx.timerRecord.create({
      data: {
        id: retentionTimerId,
        entryId,
        entityType: "Entry",
        entityId: entryId,
        timerType: "GUEST_DATA_RETENTION_P18",
        timerCode: "GUEST_DATA_RETENTION_P18",
        dueAt: retentionDueAt,
        firesAt: retentionDueAt,
        status: "SCHEDULED",
        pgBossJobId: retentionPgBossJobId,
        createdBy: "system",
        payload: { entryId, timerRecordId: retentionTimerId },
      },
    });

    const now = closedAtInstant;
    await (tx as any).traceEvent.create({
      data: {
        eventType: "ENTRY_CLOSED",
        actorId,
        actorLevel: "L2",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, closedAt: closedAtInstant.toISOString() },
        createdBy: actorId,
      },
    });
    await (tx as any).traceEvent.create({
      data: {
        eventType: "FOLIO_SEALED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Folio",
        entityId: entry.folio!.id,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { folioId: entry.folio!.id, entryId },
        createdBy: "SYSTEM",
      },
    });
    return updated;
  });
}

export async function postStayCharge(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; lineType: string; description: string; amount: number; currency?: string; postedAt: string; isPostStay: boolean },
) {
  if (input.isPostStay !== true) throw new ValidationError("isPostStay must be true for S9 post-stay charge");
  const postedAt = new Date(input.postedAt);
  if (Number.isNaN(postedAt.getTime())) throw new ValidationError("postedAt must be a valid ISO date");

  const entry = await prisma.entry.findUnique({ where: { id: input.entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS9ForPostStayCharge({ currentStage: entry.currentStage });
  enforcePostStayChargeNotWithinStayWindow({
    checkInDate: entry.checkInDate,
    checkOutDate: entry.checkOutDate,
    postedAt,
  });

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");

  const created = await prisma.$transaction(async (tx) => {
    const line = await tx.folioLine.create({
      data: {
        folioId,
        lineType: input.lineType as any,
        description: input.description,
        amount: input.amount,
        currency: input.currency?.trim() ? input.currency.trim() : "BTN",
        chargeDate: postedAt,
        stage: Stage.S9,
        postedBy: actorId,
        isPostStay: true,
        postedAt,
      },
    });
    await tx.communicationRecord.create({
      data: {
        entryId: input.entryId,
        channel: "EMAIL",
        commType: "POST_STAY_CHARGE_NOTICE",
        payload: { folioId, folioLineId: line.id, amount: input.amount, currency: input.currency ?? "BTN" },
        createdBy: actorId,
      },
    });
    await recomputeFolioOutstandingBalance(tx, folioId);
    return line;
  });
  return created;
}

