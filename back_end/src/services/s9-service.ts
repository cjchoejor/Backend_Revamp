import type { Prisma, PrismaClient } from "@prisma/client";
import { EntryStatus, FolioState, InvoiceState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, StageGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

export async function listInvoices(prisma: PrismaClient, folioId: string) {
  return prisma.invoice.findMany({ where: { folioId }, orderBy: { createdAt: "desc" } });
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

  const thresholds = await prisma.configurationEntry.findUnique({ where: { configKey: "writeOff.authority.thresholds" } });
  if (!thresholds) throw new MissingConfigurationError("writeOff.authority.thresholds");
  const cfg = (thresholds.value as Record<string, number> | undefined) ?? {};
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

  // For this slice: treat deferred inspection as resolved if a W9 timer exists (we don't model lapse events yet).
  const hasW9 = await db.timerRecord.findFirst({ where: { entryId, timerCode: "POST_CHECKOUT_INSPECTION_W9" } });
  if (!hasW9) throw new StageGateBlockedError("Deferred inspection requires W9 timer", "INSPECTION_DEFERRED_NO_W9");
}

async function ensureH5NotOpen(db: DbClient, entryId: string) {
  const h5 = await db.handoffRecord.findFirst({ where: { entryId, handoffType: "H5" }, orderBy: { createdAt: "desc" } });
  if (!h5) return;
  if (h5.isAutoFulfilled) return;
  if (["CREATED", "ACCEPTED"].includes(h5.state)) throw new StageGateBlockedError("H5 must be fulfilled/closed before entry closure", "H5_NOT_FULFILLED");
}

async function registerW28FeedbackTimer(db: DbClient, entryId: string, actorId: string) {
  const cfg = await db.configurationEntry.findUnique({ where: { configKey: "feedback.solicitation.delaySeconds" } });
  if (!cfg) throw new MissingConfigurationError("feedback.solicitation.delaySeconds");
  const delay = Number(cfg.value);
  if (!Number.isFinite(delay) || delay < 1) throw new MissingConfigurationError("feedback.solicitation.delaySeconds");
  await db.timerRecord.create({
    data: { entryId, timerCode: "FEEDBACK_SOLICITATION_W28", dueAt: new Date(Date.now() + delay * 1000), status: "SCHEDULED", createdBy: actorId },
  });
}

async function maybeCreateFollowUpTask(db: DbClient, entry: { id: string; useType: string }, actorId: string) {
  if (entry.useType !== "CONFERENCE" && entry.useType !== "GROUP") return;
  const cfg = await db.configurationEntry.findUnique({ where: { configKey: "followUp.deadlineDays" } });
  if (!cfg) throw new MissingConfigurationError("followUp.deadlineDays");
  const days = Number(cfg.value);
  if (!Number.isFinite(days) || days < 1) throw new MissingConfigurationError("followUp.deadlineDays");
  await db.followUpTaskRecord.create({
    data: { entryId: entry.id, dueAt: new Date(Date.now() + days * 86400_000), createdBy: actorId },
  });
}

export async function closeEntryAtS9(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CLOSED) throw new StateTransitionError("Entry is already CLOSED");
  if (entry.currentStage !== Stage.S9) throw new StageGateBlockedError("Entry must be at S9 to close", "NOT_AT_S9");
  if (!entry.folio) throw new NotFoundError("Folio");

  await ensureNoOpenDisputes(prisma, entryId);
  await ensureInvoicesDispatched(prisma, entryId, entry.folio.id);
  await ensureInspectionResolved(prisma, entryId);
  await ensureH5NotOpen(prisma, entryId);
  await ensureOutstandingHasW8OrWrittenOff(prisma, entryId, entry.folio);

  // Register retention + feedback timers (stubs), and close the entry + release room claim.
  return prisma.$transaction(async (tx) => {
    await registerW28FeedbackTimer(tx, entryId, actorId);
    await tx.timerRecord.create({
      data: { entryId, timerCode: "GUEST_DATA_RETENTION_P18", dueAt: new Date(Date.now() + 365 * 86400_000), status: "SCHEDULED", createdBy: "system" },
    });
    await maybeCreateFollowUpTask(tx, { id: entryId, useType: entry.useType }, "system");

    // Release room inventory claim at closure (AC-S9-016). In this slice, claim is on Room.currentClaimState.
    const ra = await tx.roomAssignment.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
    if (ra) await tx.room.update({ where: { id: ra.roomId }, data: { currentClaimState: "FREE" } });

    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.CLOSED, closedAt: new Date(), closedBy: actorId, version: { increment: 1 } },
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
  if (entry.status === EntryStatus.CLOSED) throw new StateTransitionError("Cannot post to a CLOSED entry");

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

