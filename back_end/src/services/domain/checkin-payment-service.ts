import type { PrismaClient } from "@prisma/client";
import { PaymentDirection, Prisma, Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { maxZeroSub, round2, toDecimal } from "../../lib/money.js";
import { effectiveCheckOutDate } from "../../lib/stay-dates.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { buildEntryBillingSummary } from "./entry-billing-summary-service.js";
import { loadInterimReminderPolicy } from "./interim-payment-service.js";
import { recordCreditExtensionApproval, resolveAdvancePaymentPlan, type AdvancePaymentPlan } from "./s3-payment-service.js";

/**
 * The rest of the bill at check-in (2026-10-29, operator: "this registration promised to pay the
 * remaining amount of the bill when it reached check-in … it should prompt the user that the
 * guest said that as well; if they can't pay here, the issue should be raised to the FOM, GM or
 * admin to let them pay during the stay, at check-out or later").
 *
 * Rulings: check-in WAITS for the FOM (L2+) — it stays shut until the money is in or an FOM has
 * said when it will come; "later" is a new due date the desk is reminded on:
 *  - DURING_STAY — by `dueBy`; the W42 clock reminds the desk then, every N hours up to a cap
 *    (the mid-stay payment's `interimPayment.reminder` cadence);
 *  - AT_CHECKOUT — said on the Check-out bill, where the settlement collects it;
 *  - AFTER_STAY — by `dueBy`; the FOM's credit extension is recorded so check-out may settle
 *    part and leave the rest owing (Policy 46).
 *
 * "The rest" is the stay total (the billing summary's — the operative quotation, else the frozen
 * terms) less the money received (payments in − refunds out), Decimal, never below zero. Nothing
 * here is worked out on the desk.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
type Db = PrismaClient;

export type CheckInPayBy = "DURING_STAY" | "AT_CHECKOUT" | "AFTER_STAY";
const PAY_BY = new Set<CheckInPayBy>(["DURING_STAY", "AT_CHECKOUT", "AFTER_STAY"]);
const REMINDER_TIMER_CODE = "CHECKIN_PAYMENT_REMINDER_W42" as const;
const isFom = (level: string) => level === "L2" || level === "L3" || level === "L4";

export function nuWords(v: Prisma.Decimal | number): string {
  return `Nu ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const DEFERRAL_SELECT = {
  id: true,
  status: true,
  segmentId: true,
  stillToPay: true,
  reason: true,
  requestedBy: true,
  requestedLevel: true,
  requestedAt: true,
  payBy: true,
  dueBy: true,
  decisionNote: true,
  decidedBy: true,
  decidedLevel: true,
  decidedAt: true,
  creditExtensionId: true,
  remindersSent: true,
  lastReminderAt: true,
} satisfies Prisma.CheckInPaymentDeferralSelect;

type DeferralRow = Prisma.CheckInPaymentDeferralGetPayload<{ select: typeof DEFERRAL_SELECT }>;

async function loadEntry(prisma: Db, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      checkOutDate: true,
      actualCheckOutDate: true,
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
      folio: { select: { id: true, advancePaymentPlan: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true, startedAt: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/** Money received on the folio, net of refunds — Decimal, from the payment rows themselves. */
async function netReceived(prisma: Db, folioId: string) {
  const [inAgg, outAgg] = await Promise.all([
    prisma.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.IN }, _sum: { amount: true } }),
    prisma.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.OUT }, _sum: { amount: true } }),
  ]);
  return round2(toDecimal(inAgg._sum.amount).sub(toDecimal(outAgg._sum.amount)));
}

function shapeDeferral(d: DeferralRow) {
  return {
    ...d,
    stillToPay: Number(round2(d.stillToPay)),
    requestedAt: d.requestedAt.toISOString(),
    dueBy: d.dueBy?.toISOString() ?? null,
    decidedAt: d.decidedAt?.toISOString() ?? null,
    lastReminderAt: d.lastReminderAt?.toISOString() ?? null,
  };
}

export type CheckInPaymentStanding = Awaited<ReturnType<typeof readCheckInPayment>>;

/**
 * Where the rest of the bill stands for this booking's pass: the guest's promise, the figures,
 * the open request and the decision in force, and whether check-in may go on. Read-only.
 */
export async function readCheckInPayment(prisma: Db, entryId: string) {
  const entry = await loadEntry(prisma, entryId);
  const segment = entry.segments[0] ?? null;
  const plan: AdvancePaymentPlan | null = entry.folio ? resolveAdvancePaymentPlan(entry.folio, segment?.startedAt) : null;
  const promisedAtCheckIn = plan?.balanceDueAt === "AT_CHECKIN";

  const summary = await buildEntryBillingSummary(prisma, entryId);
  const stayTotal = summary.stayTotal.amount != null ? round2(toDecimal(summary.stayTotal.amount)) : null;
  const received = entry.folio ? await netReceived(prisma, entry.folio.id) : round2(toDecimal(0));
  const stillToPay = stayTotal != null ? round2(maxZeroSub(stayTotal, received)) : null;

  const all = await prisma.checkInPaymentDeferral.findMany({
    where: { entryId },
    orderBy: { createdAt: "desc" },
    select: DEFERRAL_SELECT,
  });
  // The gate reads this pass's (the plan is per pass too); the later steps read the FOM's latest
  // word whatever pass it was given in — a room change mid-stay opens a new pass.
  const rows = segment ? all.filter((r) => r.segmentId === segment.id) : all;
  const latestApproved = all.find((r) => r.status === "APPROVED") ?? null;
  const open = rows.find((r) => r.status === "REQUESTED") ?? null;
  const approved = rows.find((r) => r.status === "APPROVED") ?? null;

  // Unknown stay total (an import with no priced terms): there is no figure to hold check-in on.
  const owed = stillToPay != null && stillToPay.gt(0);
  const gateMet = !promisedAtCheckIn || !owed || !!approved;

  return {
    entryId,
    stage: entry.currentStage,
    plan: plan ? { plan: plan.plan, balanceDueAt: plan.balanceDueAt, promisedBy: plan.promisedBy, note: plan.note, setAt: plan.setAt } : null,
    promisedAtCheckIn,
    stayTotal: stayTotal != null ? Number(stayTotal) : null,
    received: Number(received),
    stillToPay: stillToPay != null ? Number(stillToPay) : null,
    open: open ? shapeDeferral(open) : null,
    approved: approved ? shapeDeferral(approved) : null,
    /** The FOM's latest "pay later" on this booking, any pass — for Stay and Check-out. */
    decision: latestApproved ? shapeDeferral(latestApproved) : null,
    history: rows.filter((r) => r.status === "REJECTED" || r.status === "WITHDRAWN").map(shapeDeferral),
    gateMet,
    /** What check-in waits for, in words — null when nothing. */
    waitsFor: gateMet
      ? null
      : open
        ? `The FOM's word — the desk asked to let the guest pay ${nuWords(stillToPay!)} later`
        : `${nuWords(stillToPay!)} still to pay — the guest said they would pay the rest at check-in`,
  };
}

/** Before the guest is checked in, and only while the booking is live. */
function assertBeforeCheckIn(entry: { status: string; currentStage: Stage }) {
  if (entry.status !== "ACTIVE") {
    throw new PolicyGateBlockedError("ENTRY_NOT_ACTIVE", "This booking is not active — nothing can be decided about its payment");
  }
  if (entry.currentStage !== Stage.S5 && entry.currentStage !== Stage.S6) {
    throw new PolicyGateBlockedError(
      "NOT_BEFORE_CHECKIN",
      entry.currentStage === Stage.S7 || entry.currentStage === Stage.S8
        ? "The guest is already checked in — the rest of the bill is settled at Stay or Check-out"
        : "This is decided at Arrival or Check-in",
    );
  }
}

/** The desk asks the FOM to let the guest pay later (L1). */
export async function requestCheckInPaymentDeferral(prisma: Db, actor: Actor, input: { entryId: string; reason: string }) {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say what the guest said — why they cannot pay now");
  const entry = await loadEntry(prisma, input.entryId);
  assertBeforeCheckIn(entry);
  if (!entry.folio) throw new PolicyGateBlockedError("NO_FOLIO", "This booking has no bill yet");
  const standing = await readCheckInPayment(prisma, input.entryId);
  if (!standing.promisedAtCheckIn) {
    throw new PolicyGateBlockedError("NOT_PROMISED_AT_CHECKIN", "The guest's payment plan does not say the rest comes at check-in — nothing waits on it");
  }
  if (standing.stillToPay == null || standing.stillToPay <= 0) {
    throw new PolicyGateBlockedError("NOTHING_TO_PAY", "Nothing is left to pay — the guest can be checked in");
  }
  if (standing.approved) throw new PolicyGateBlockedError("ALREADY_APPROVED", "The FOM has already let the guest pay later");
  if (standing.open) throw new PolicyGateBlockedError("ALREADY_ASKED", "The FOM has already been asked — wait for their answer, or take the request back");

  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.checkInPaymentDeferral.create({
      data: {
        entryId: entry.id,
        folioId: entry.folio!.id,
        segmentId: entry.segments[0]?.id ?? null,
        status: "REQUESTED",
        stillToPay: new Prisma.Decimal(standing.stillToPay!),
        reason,
        requestedBy: actor.actorId,
        requestedLevel: actor.actorLevel,
        requestedAt: now,
      },
      select: DEFERRAL_SELECT,
    });
    const payload = { entryId: entry.id, requestId: created.id, stillToPay: standing.stillToPay, stayTotal: standing.stayTotal, received: standing.received, reason };
    await tx.traceEvent.create({
      data: {
        eventType: "CHECKIN_PAYMENT.DEFERRAL_REQUESTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "CheckInPaymentDeferral",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload,
        createdBy: actor.actorId,
      },
    });
    // Raised to the FOM, GM and admin — the "Alerts sent" feed reads the NOTIFICATION.* traces.
    await tx.traceEvent.create({
      data: {
        eventType: "NOTIFICATION.CHECKIN_PAYMENT_DEFERRAL_REQUESTED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "CheckInPaymentDeferral",
        entityId: created.id,
        operation: "NOTIFY",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { ...payload, targets: ["FOM", "GM"], dispatchedAt: now.toISOString() },
        createdBy: "SYSTEM",
      },
    });
    return created;
  });
  return { request: shapeDeferral(row), standing: await readCheckInPayment(prisma, input.entryId) };
}

/** The desk takes its own request back before the FOM answers. */
export async function withdrawCheckInPaymentDeferral(prisma: Db, actor: Actor, input: { entryId: string; requestId: string; note?: string | null }) {
  const row = await prisma.checkInPaymentDeferral.findUnique({ where: { id: input.requestId }, select: { id: true, entryId: true, status: true } });
  if (!row || row.entryId !== input.entryId) throw new NotFoundError("CheckInPaymentDeferral");
  if (row.status !== "REQUESTED") throw new PolicyGateBlockedError("NOT_OPEN", "This request has already been answered");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.checkInPaymentDeferral.update({
      where: { id: row.id },
      data: { status: "WITHDRAWN", decisionNote: input.note?.trim() || "Taken back by the desk", decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now },
    });
    const entry = await tx.entry.findUnique({ where: { id: input.entryId }, select: { currentStage: true, inquiryId: true } });
    await tx.traceEvent.create({
      data: {
        eventType: "CHECKIN_PAYMENT.DEFERRAL_WITHDRAWN",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "CheckInPaymentDeferral",
        entityId: row.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry?.currentStage ?? Stage.S6,
        inquiryId: entry?.inquiryId ?? null,
        entryId: input.entryId,
        payload: { entryId: input.entryId, requestId: row.id, note: input.note?.trim() || null },
        createdBy: actor.actorId,
      },
    });
  });
  return readCheckInPayment(prisma, input.entryId);
}

/**
 * The FOM decides (L2+): let the guest pay later — during the stay by a date, at check-out, or
 * after the stay by a date — or turn the request down. With no open request the FOM may decide
 * directly. A refused request leaves check-in shut until the money is in.
 */
export async function decideCheckInPaymentDeferral(
  prisma: Db,
  actor: Actor,
  input: { entryId: string; requestId?: string | null; decision: "APPROVE" | "REJECT"; payBy?: CheckInPayBy | null; dueBy?: string | null; note?: string | null },
) {
  if (!isFom(actor.actorLevel)) {
    throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "Letting the guest pay later is the FOM's call — an FOM, the GM or an admin decides it");
  }
  const note = input.note?.trim() || null;
  const entry = await loadEntry(prisma, input.entryId);
  assertBeforeCheckIn(entry);
  if (!entry.folio) throw new PolicyGateBlockedError("NO_FOLIO", "This booking has no bill yet");
  const standing = await readCheckInPayment(prisma, input.entryId);

  let open = standing.open;
  if (input.requestId) {
    if (!open || open.id !== input.requestId) throw new PolicyGateBlockedError("NOT_OPEN", "This request has already been answered, or was taken back");
  }

  const now = new Date();
  if (input.decision === "REJECT") {
    if (!open) throw new PolicyGateBlockedError("NOTHING_TO_TURN_DOWN", "No request is waiting — nothing to turn down");
    if (!note) throw new ValidationError("Say why — the desk reads it");
    await prisma.$transaction(async (tx) => {
      await tx.checkInPaymentDeferral.update({
        where: { id: open!.id },
        data: { status: "REJECTED", decisionNote: note, decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "CHECKIN_PAYMENT.DEFERRAL_REJECTED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "CheckInPaymentDeferral",
          entityId: open!.id,
          operation: "UPDATE",
          timestamp: now,
          stageContext: entry.currentStage,
          inquiryId: entry.inquiryId,
          entryId: entry.id,
          payload: { entryId: entry.id, requestId: open!.id, note, stillToPay: standing.stillToPay },
          createdBy: actor.actorId,
        },
      });
    });
    return readCheckInPayment(prisma, input.entryId);
  }

  // APPROVE
  if (!standing.promisedAtCheckIn) {
    throw new PolicyGateBlockedError("NOT_PROMISED_AT_CHECKIN", "The guest's payment plan does not say the rest comes at check-in — nothing waits on it");
  }
  if (standing.stillToPay == null || standing.stillToPay <= 0) {
    throw new PolicyGateBlockedError("NOTHING_TO_PAY", "Nothing is left to pay — the guest can be checked in");
  }
  if (standing.approved) throw new PolicyGateBlockedError("ALREADY_APPROVED", "The guest has already been let pay later");
  const payBy = input.payBy ?? null;
  if (!payBy || !PAY_BY.has(payBy)) throw new ValidationError("Pick when the guest will pay — during the stay, at check-out, or after the stay");
  if (!note) throw new ValidationError("Say why the guest may pay later — it goes on the booking's history");

  const checkout = effectiveCheckOutDate(entry);
  let dueBy: Date | null = null;
  if (payBy === "DURING_STAY" || payBy === "AFTER_STAY") {
    if (!input.dueBy) throw new ValidationError(payBy === "DURING_STAY" ? "Pick the day and time the guest will pay by" : "Pick the date the guest will pay by");
    dueBy = new Date(input.dueBy);
    if (!Number.isFinite(dueBy.getTime())) throw new ValidationError("That date is not a real date");
    if (dueBy.getTime() <= now.getTime() + 60_000) throw new ValidationError("The date must be ahead of now");
    if (payBy === "DURING_STAY" && checkout && dueBy.getTime() > checkout.getTime() + 24 * 3_600_000) {
      throw new ValidationError("That is after the guest leaves — pick a time during the stay, or let them pay at check-out or after the stay");
    }
    if (payBy === "AFTER_STAY" && checkout && dueBy.getTime() <= checkout.getTime()) {
      throw new ValidationError("That is before the guest leaves — pick a date after the stay, or let them pay during the stay");
    }
  }

  // AFTER_STAY: the FOM's credit so check-out may settle part (Policy 46). It covers at least
  // what is still to pay, and never lowers an extension already on the bill.
  let creditExtensionId: string | null = null;
  if (payBy === "AFTER_STAY") {
    const existing = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: entry.folio.id }, select: { ceilingAmount: true, expiresAt: true } });
    const live = existing && (!existing.expiresAt || existing.expiresAt.getTime() > now.getTime());
    const ceiling = live && toDecimal(existing!.ceilingAmount).gt(standing.stillToPay) ? Number(round2(existing!.ceilingAmount)) : standing.stillToPay;
    const rec = await recordCreditExtensionApproval(
      prisma,
      { entryId: entry.id, folioId: entry.folio.id, ceilingAmount: ceiling, reason: `Pay after the stay — ${note}`, validUntil: dueBy },
      actor,
    );
    creditExtensionId = rec.id;
  }

  const saved = await prisma.$transaction(async (tx) => {
    const data = {
      status: "APPROVED",
      payBy,
      dueBy,
      decisionNote: note,
      decidedBy: actor.actorId,
      decidedLevel: actor.actorLevel,
      decidedAt: now,
      creditExtensionId,
    };
    const row = open
      ? await tx.checkInPaymentDeferral.update({ where: { id: open.id }, data, select: DEFERRAL_SELECT })
      : await tx.checkInPaymentDeferral.create({
          data: {
            ...data,
            entryId: entry.id,
            folioId: entry.folio!.id,
            segmentId: entry.segments[0]?.id ?? null,
            stillToPay: new Prisma.Decimal(standing.stillToPay!),
            reason: note!,
            requestedBy: actor.actorId,
            requestedLevel: actor.actorLevel,
            requestedAt: now,
          },
          select: DEFERRAL_SELECT,
        });
    await tx.traceEvent.create({
      data: {
        eventType: "CHECKIN_PAYMENT.DEFERRAL_APPROVED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "CheckInPaymentDeferral",
        entityId: row.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          entryId: entry.id,
          requestId: row.id,
          askedByDesk: !!open,
          payBy,
          dueBy: dueBy?.toISOString() ?? null,
          note,
          stillToPay: standing.stillToPay,
          creditExtensionId,
        },
        createdBy: actor.actorId,
      },
    });
    return row;
  });

  if (payBy === "DURING_STAY" && dueBy) {
    await armCheckInPaymentReminder(prisma, { deferralId: saved.id, actorId: actor.actorId, firesAt: dueBy }).catch(() => {});
  }
  return readCheckInPayment(prisma, input.entryId);
}

/** Close an open request once nothing is left to pay, or once the guest is checked in. Best-effort. */
export async function closeMootCheckInPaymentRequests(prisma: Db, entryId: string, why: "PAID" | "CHECKED_IN") {
  const open = await prisma.checkInPaymentDeferral.findMany({ where: { entryId, status: "REQUESTED" }, select: { id: true } });
  if (open.length === 0) return 0;
  if (why === "PAID") {
    const standing = await readCheckInPayment(prisma, entryId);
    if (standing.stillToPay == null || standing.stillToPay > 0) return 0;
  }
  const now = new Date();
  await prisma.checkInPaymentDeferral.updateMany({
    where: { id: { in: open.map((o) => o.id) }, status: "REQUESTED" },
    data: { status: "WITHDRAWN", decisionNote: why === "PAID" ? "The rest of the bill was paid" : "The guest was checked in", decidedBy: "SYSTEM", decidedLevel: "SYSTEM", decidedAt: now },
  });
  return open.length;
}

// ── The W42 reminder (DURING_STAY) ───────────────────────────────────────────────────────────

export async function cancelCheckInPaymentReminder(prisma: Db, deferralId: string, cancelledBy: string, reason: string) {
  const timers = await prisma.timerRecord.findMany({
    where: { entityType: "CheckInPaymentDeferral", entityId: deferralId, timerCode: REMINDER_TIMER_CODE, status: "SCHEDULED" },
  });
  if (timers.length === 0) return 0;
  const engine = await getTimerEngine();
  const now = new Date();
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId).catch(() => {}) : Promise.resolve())));
  await prisma.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy, cancelledReason: reason },
  });
  await prisma.checkInPaymentDeferral.updateMany({ where: { id: deferralId }, data: { reminderTimerRecordId: null } });
  return timers.length;
}

/** Arm (or re-arm) the W42 reminder — post-transaction and best-effort, like W41. */
export async function armCheckInPaymentReminder(prisma: Db, input: { deferralId: string; actorId: string; firesAt?: Date | null }) {
  const row = await prisma.checkInPaymentDeferral.findUnique({
    where: { id: input.deferralId },
    select: { id: true, entryId: true, status: true, payBy: true, dueBy: true, entry: { select: { currentStage: true } } },
  });
  if (!row || row.status !== "APPROVED" || row.payBy !== "DURING_STAY") return null;
  const firesAt = input.firesAt ?? row.dueBy;
  if (!firesAt) return null;
  await cancelCheckInPaymentReminder(prisma, row.id, input.actorId, "RE_ARMED");
  const engine = await getTimerEngine();
  const timer = await prisma.timerRecord.create({
    data: {
      entryId: row.entryId,
      entityType: "CheckInPaymentDeferral",
      entityId: row.id,
      timerType: REMINDER_TIMER_CODE,
      timerCode: REMINDER_TIMER_CODE,
      stageContext: row.entry.currentStage,
      dueAt: firesAt,
      firesAt,
      status: "SCHEDULED",
      createdBy: input.actorId,
      payload: { deferralId: row.id, dueBy: row.dueBy?.toISOString() ?? null },
    },
  });
  const jobId = await engine.schedule(REMINDER_TIMER_CODE, { deferralId: row.id, timerRecordId: timer.id }, { startAfter: firesAt });
  await prisma.timerRecord.update({ where: { id: timer.id }, data: { pgBossJobId: jobId } });
  await prisma.checkInPaymentDeferral.update({ where: { id: row.id }, data: { reminderTimerRecordId: timer.id } });
  return timer;
}

export { loadInterimReminderPolicy as loadCheckInReminderPolicy };
