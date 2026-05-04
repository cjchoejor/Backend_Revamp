import type { Prisma, PrismaClient } from "@prisma/client";
import { CommissionDueStatus, EntryStatus, FolioState, InvoiceState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, StageGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { randomUUID } from "node:crypto";
import { getTimerEngine } from "./timer-management-service.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

export async function listInvoices(prisma: PrismaClient, folioId: string) {
  return prisma.invoice.findMany({ where: { folioId }, orderBy: { createdAt: "desc" } });
}

export async function dispatchInvoice(prisma: PrismaClient, invoiceId: string, actorId: string, input?: { dispatchedTo?: string }) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice");
  if (invoice.state !== InvoiceState.DRAFT) return invoice;
  const now = new Date();
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      state: InvoiceState.DISPATCHED,
      dispatchedAt: now,
      dispatchedBy: actorId,
      dispatchedTo: input?.dispatchedTo?.trim() ? input.dispatchedTo.trim() : invoice.dispatchedTo,
      metadata: { ...(invoice.metadata as object | null), dispatchedBy: actorId, dispatchedAt: now.toISOString() } as object,
    },
  });
}

export async function recordInvoicePaymentEvent(
  prisma: PrismaClient,
  invoiceId: string,
  actorId: string,
  input: { nextState: "PAYMENT_TRACKED" | "RECONCILED"; paymentRef?: string },
) {
  if (input.nextState !== "PAYMENT_TRACKED" && input.nextState !== "RECONCILED") throw new ValidationError("nextState must be PAYMENT_TRACKED or RECONCILED");
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice");

  if (input.nextState === "PAYMENT_TRACKED" && invoice.state !== InvoiceState.DISPATCHED) {
    throw new StateTransitionError(`Invoice must be DISPATCHED to mark PAYMENT_TRACKED (current: ${invoice.state})`);
  }
  if (input.nextState === "RECONCILED" && invoice.state !== InvoiceState.PAYMENT_TRACKED) {
    throw new StateTransitionError(`Invoice must be PAYMENT_TRACKED to mark RECONCILED (current: ${invoice.state})`);
  }

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      state: input.nextState,
      metadata: { ...(invoice.metadata as object | null), paymentRef: input.paymentRef ?? null, updatedBy: actorId, updatedAt: new Date().toISOString() } as object,
    },
  });
}

export async function writeOffOutstandingBalance(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { amount: number; reason: string },
) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new ValidationError("amount must be a positive number");
  if (!input.reason?.trim()) throw new PolicyGateBlockedError("WRITE_OFF_REASON_REQUIRED", "reason is required");

  const cfg = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "writeOff.authority.thresholds")) ?? {};
  const max = typeof cfg.L3 === "number" ? cfg.L3 : 0;
  if (max > 0 && input.amount > max) {
    throw new PolicyGateBlockedError("WRITE_OFF_EXCEEDS_AUTHORITY_BAND", "write-off amount exceeds GM authority band");
  }

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.state !== FolioState.OUTSTANDING) throw new StateTransitionError("Folio must be OUTSTANDING to write off");

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
    await tx.folio.update({ where: { id: folioId }, data: { state: FolioState.WRITTEN_OFF } });
    return rec;
  });
}

async function ensureNoOpenDisputes(db: DbClient, entryId: string) {
  const open = await db.disputeRecord.findFirst({
    where: { entryId, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] } },
    orderBy: { openedAt: "desc" },
  });
  if (open) throw new StageGateBlockedError("Cannot close entry with an open dispute", "DISPUTE_NOT_TERMINAL");
}

async function ensureInvoicesDispatched(db: DbClient, entryId: string, folioId: string) {
  const bad = await db.invoice.findFirst({ where: { folioId, entryId, state: InvoiceState.DRAFT } });
  if (bad) throw new StageGateBlockedError("Undispatched invoice blocks closure", "INVOICE_NOT_DISPATCHED");
}

async function ensurePaymentsMatched(db: DbClient, entryId: string, folioId: string) {
  const folio = await db.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  // For DIRECT_BILL/GOVERNMENT: all recorded incoming payments must be associated to an invoice.
  if (folio.billingModel === "GOVERNMENT") {
    // AC-S9-031: Government closure requires PAYMENT_TRACKED minimum; RECONCILED not required.
    const inv = await db.invoice.findFirst({ where: { folioId, entryId }, orderBy: { createdAt: "desc" } });
    if (inv && inv.state === "DISPATCHED") throw new StageGateBlockedError("Government invoice must be PAYMENT_TRACKED before closure", "GOV_PAYMENT_NOT_TRACKED");
    return;
  }
  if (folio.billingModel === "DIRECT_BILL") {
    const unmatched = await db.paymentRecord.findFirst({
      where: { folioId, paymentDirection: "IN", invoiceId: null },
      orderBy: { createdAt: "desc" },
    });
    if (unmatched) throw new StageGateBlockedError("Unmatched payment blocks closure", "PAYMENT_NOT_MATCHED");
  }
}

async function ensureOutstandingHasW8OrWrittenOff(db: DbClient, entryId: string, folio: { state: FolioState; outstandingBalance: Prisma.Decimal }) {
  if (folio.state !== FolioState.OUTSTANDING) return;
  if (num(folio.outstandingBalance) === 0) throw new StageGateBlockedError("OUTSTANDING folio cannot have zero balance", "OUTSTANDING_ZERO_BALANCE");

  const hasW8 = await db.timerRecord.findFirst({ where: { entryId, timerCode: "PAYMENT_FOLLOW_UP_W8", status: "SCHEDULED" } });
  const hasWriteOff = await db.writeOffRecord.findFirst({ where: { entryId } });
  if (!hasW8 && !hasWriteOff) throw new StageGateBlockedError("OUTSTANDING folio requires active W8 follow-up or write-off", "OUTSTANDING_WITHOUT_W8");
}

async function ensureInspectionResolved(db: DbClient, entryId: string) {
  const insp = await db.roomInspectionRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (!insp) throw new StageGateBlockedError("Missing room inspection record", "INSPECTION_MISSING");
  if (!insp.isDeferred) return;

  const hasCompleted = await db.roomInspectionRecord.findFirst({
    where: { entryId, isDeferred: false },
    orderBy: { createdAt: "desc" },
  });
  if (hasCompleted) return;

  const lapsed = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED" },
    orderBy: { createdAt: "desc" },
  });
  if (lapsed) return;

  // Deferred inspection is not resolved until completed or lapsed is explicitly recorded.
  throw new StageGateBlockedError("Deferred inspection window not resolved", "INSPECTION_DEFERRED_UNRESOLVED");
}

async function ensureH5NotOpen(db: DbClient, entryId: string) {
  const h5 = await db.handoffRecord.findFirst({ where: { entryId, handoffType: "H5" }, orderBy: { createdAt: "desc" } });
  if (!h5) return;
  if (h5.isAutoFulfilled) return;
  if (["CREATED", "ACCEPTED"].includes(h5.state)) {
    throw new StageGateBlockedError("H5 must be fulfilled/closed before entry closure", "H5_NOT_FULFILLED");
  }
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

async function ensureEquipmentReturnResolved(db: DbClient, entryId: string) {
  const alloc = await db.equipmentAllocation.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (!alloc) return;
  if (alloc.returnConfirmedAt) return;
  const breached = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "EQUIPMENT_RETURN.DEADLINE_BREACHED" },
    orderBy: { createdAt: "desc" },
  });
  const resolved = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "EQUIPMENT_RETURN.RESOLVED" },
    orderBy: { createdAt: "desc" },
  });
  if (!breached || !resolved) throw new StageGateBlockedError("Equipment return not resolved", "EQUIPMENT_RETURN_NOT_RESOLVED");
}

async function maybeCreateCommissionDue(db: DbClient, entryId: string, actorId: string) {
  const entry = await db.entry.findUnique({ where: { id: entryId }, include: { inquiry: { include: { agentProfile: true } }, folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  const agent = entry.inquiry.agentProfile;
  if (!agent || agent.commissionRate == null) return { created: false as const };

  const existing = await db.commissionDueRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (existing) return { created: false as const, existing };

  // If commission basis not configured, create RATE_MISSING and schedule W11.
  const now = new Date();
  const isBasisMissing = agent.commissionBasis == null;
  const created = await db.commissionDueRecord.create({
    data: {
      entryId,
      agentProfileId: agent.id,
      commissionRate: agent.commissionRate,
      commissionBasis: agent.commissionBasis ?? null,
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

async function ensureApartmentDepositResolved(db: DbClient, entry: { id: string; useType: string }, folioId: string) {
  if (entry.useType !== "APARTMENT") return;
  const held = await db.paymentRecord.findFirst({
    where: { folioId, paymentDirection: "IN", notes: { contains: "SECURITY_DEPOSIT_HELD" } },
    orderBy: { createdAt: "desc" },
  });
  if (!held) return;
  const returned = await db.paymentRecord.findFirst({
    where: { folioId, paymentDirection: "OUT", notes: { contains: "SECURITY_DEPOSIT_RETURN" } },
    orderBy: { createdAt: "desc" },
  });
  const zero = await (db as any).traceEvent.findFirst({
    where: { entryId: entry.id, eventType: "SECURITY_DEPOSIT.ZERO_BALANCE_RECORDED" },
    orderBy: { createdAt: "desc" },
  });
  if (!returned && !zero) throw new StageGateBlockedError("Apartment security deposit not resolved", "SECURITY_DEPOSIT_NOT_RESOLVED");
}

async function processNoShowS9IfNeeded(db: DbClient, entryId: string, actorId: string) {
  const entry = await db.entry.findUnique({ where: { id: entryId }, include: { folio: true, noShowDetermination: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new NotFoundError("Folio");
  if (entry.folio.state !== FolioState.NO_SHOW_CLOSED) return { handled: false as const };
  if (!entry.noShowDetermination) throw new StageGateBlockedError("No-show entries require NoShowDeterminationRecord", "NO_SHOW_DETERMINATION_MISSING");

  // AC-S9-033/034/035: create penalty invoice if retained, ensure refund record if owed, and anchor metadata.
  const determinationId = entry.noShowDetermination.id;
  const penalty = num(entry.folio.noShowPenaltyAmount);
  const net = num(entry.folio.noShowNetPosition);

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
    }
  }

  return { handled: true as const, noShowDeterminationId: determinationId, penalty, net };
}

export async function closeEntryAtS9(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CLOSED) throw new StateTransitionError("Entry is already CLOSED");
  if (entry.currentStage !== Stage.S9) throw new StageGateBlockedError("Entry must be at S9 to close", "NOT_AT_S9");
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

    // AC-S8-07: OUTSTANDING folios schedule payment follow-up W8 at S9 closure.
    if (entry.folio?.state === FolioState.OUTSTANDING) {
      const ttl = Number(await requireActiveConfigValue<number>(tx as any, "payment.followUp.ttlDays").catch(() => 7));
      const dueAt = new Date(Date.now() + ttl * 86400_000);
      const existing = await tx.timerRecord.findFirst({ where: { entryId, timerCode: "PAYMENT_FOLLOW_UP_W8", status: "SCHEDULED" } });
      if (!existing) {
        const timerRecordId = randomUUID();
        const engine = await getTimerEngine();
        const pgBossJobId = await engine.schedule("PAYMENT_FOLLOW_UP_W8", { entryId, timerRecordId }, { startAfter: dueAt });
        await tx.timerRecord.create({
          data: {
            id: timerRecordId,
            entryId,
            entityType: "Entry",
            entityId: entryId,
            timerType: "PAYMENT_FOLLOW_UP_W8",
            timerCode: "PAYMENT_FOLLOW_UP_W8",
            dueAt,
            firesAt: dueAt,
            status: "SCHEDULED",
            createdBy: "system",
            pgBossJobId,
            payload: { entryId, folioId: entry.folio.id, outstandingBalance: entry.folio.outstandingBalance.toString(), timerRecordId },
          },
        });
      }
    }

    if (entry.folio) {
      await ensureOutstandingHasW8OrWrittenOff(tx, entryId, entry.folio);
    }

    // AC-S9-029: exclude no-show closed folios from W28 solicitation.
    if (entry.folio?.state !== FolioState.NO_SHOW_CLOSED) {
      await registerW28FeedbackTimer(tx, entryId, actorId);
    }
    const retentionDueAt = new Date(Date.now() + 365 * 86400_000);
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
    await maybeCreateFollowUpTask(tx, { id: entryId, useType: entry.useType }, "system");
    await maybeCreateCommissionDue(tx, entryId, "SYSTEM");

    // Release room inventory claim at closure (AC-S9-016). In this slice, claim is on Room.currentClaimState.
    const ra = await tx.roomAssignment.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
    if (ra) await tx.room.update({ where: { id: ra.roomId }, data: { currentClaimState: "FREE" } });

    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.CLOSED, closedAt: new Date(), closedBy: actorId, version: { increment: 1 } },
    });

    const now = new Date();
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
        payload: { entryId, closedAt: now.toISOString() },
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
  if (entry.currentStage !== Stage.S9) throw new StageGateBlockedError("Entry must be at S9 for post-stay charges", "NOT_AT_S9");

  // Backdating into stay window is forbidden.
  if (entry.checkInDate && entry.checkOutDate && postedAt >= entry.checkInDate && postedAt <= entry.checkOutDate) {
    throw new ValidationError("postedAt cannot be within the original stay period");
  }

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
    return line;
  });
  return created;
}

