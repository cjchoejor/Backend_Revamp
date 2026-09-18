import type { Prisma, PrismaClient } from "@prisma/client";
import { EntryStatus, FolioLineType, FolioState, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry, requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceNoShowDeterminationPrereqs, enforceNoShowDeterminationNotAlreadyRecorded } from "../../policies/22-no-show/p56-no-show-determination-prereqs.js";
import { enforceEntryAtS5ForNoShowActions } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { allocateFolioLineId, allocateReadableId } from "../../lib/readable-id.js";
import { round2, toDecimal } from "../../lib/money.js";
import {
  capCancellationPenaltyAtAdvancePayment,
  computeS5PreArrivalCancellationPenalty,
  sumAdvancePaymentInTotalForFolio,
} from "../../policies/14-cancellation/p35-cancellation-penalty-from-commitment.js";
import type { CancellationPolicyTiersConfig } from "../../policies/14-cancellation/p35-cancellation-penalty-from-commitment.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { releaseRoomOnNoShowTerminalTx } from "../../lib/release-room-on-no-show.js";
import { releaseEntryRoomsToFree } from "../../lib/room-claim-state.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { frozenCompositionByRoom, splitFrozenRow } from "../../lib/frozen-room-composition.js";
import { nightsBetweenUtc, utcDateOnly } from "../../lib/stay-dates.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { renderNoShowNoticeEmail } from "../infrastructure/stage-email-templates.js";
import { resolveInvoiceRecipient } from "../domain/s9-service.js";

type ContactAttempt = { channel: string; attemptedAt: string; outcome: string; response?: string };
type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/* ------------------------------------------------------------------ the figures */

/**
 * What a no-show charges and gives back (2026-09-18) — computed, nothing written. The desk shows
 * these before the irreversible click, and the determination books exactly them.
 *
 * Where the charge comes from, first that applies (SIG-S5 Policy 57):
 *   1. **The terms frozen on the reservation** — an explicit same-day / no-show amount the guest
 *      was quoted for this booking.
 *   2. **`noShow.penaltyStructure`** — the hotel's no-show rule for the booking's channel
 *      (`OTA` · `AGENT` · `DIRECT` · `CORPORATE` · `WALK_IN`, else `DEFAULT`):
 *      `{ penaltyPercent, basis? }`, a percentage of the ROOMS for the first night
 *      (`basis: "FIRST_NIGHT"`, the default — one night's room, the common hotel rule) or for the
 *      whole stay (`"WHOLE_STAY"`). The room figure is the booking's own frozen one, taxes
 *      included and any discount applied; meals are left out — a guest who never came ate
 *      nothing.
 *   3. **The same-day cancellation tier** (`cancellation.policyTiers`), the charge the spec
 *      aligns a no-show with when nothing more specific is configured.
 * Always capped at the advance received — the Policy 57 invariant — and the rest is owed back.
 *
 * Before this, only (1) was read. The desk never writes it (a reservation freezes
 * `{ tier: "DEFAULT" }`), so EVERY no-show charged nothing and refunded the whole advance, while
 * `noShow.penaltyStructure` — seeded, and editable in the admin — was consumed by nothing.
 */
export type NoShowFigures = {
  advanceReceived: number;
  /** The rule's charge before the cap. */
  penaltyBeforeCap: number;
  /** What the hotel keeps: the rule's charge, capped at the advance. */
  penalty: number;
  /** What goes back to the guest: advance − penalty. */
  refund: number;
  capped: boolean;
  basis: "TERMS" | "NO_SHOW_RULE" | "SAME_DAY_CANCELLATION" | "NONE";
  /** The channel key the no-show rule was read for. */
  sourceKey: string;
  percent: number | null;
  of: "FIRST_NIGHT" | "WHOLE_STAY" | null;
  /** The room figure the percentage applies to, taxes included. */
  baseAmount: number | null;
  /** Plain words: what the charge is, for the desk and for the folio line. */
  explanation: string;
};

type NoShowRule = { percent: number; of: "FIRST_NIGHT" | "WHOLE_STAY" };

function readNoShowRule(cfg: unknown, sourceKey: string): NoShowRule | null {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const map = cfg as Record<string, unknown>;
  const raw = (map[sourceKey] ?? map.DEFAULT) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const pct = Number(raw.penaltyPercent ?? raw.percent);
  if (!Number.isFinite(pct) || pct < 0) return null;
  const of = String(raw.basis ?? "FIRST_NIGHT").toUpperCase() === "WHOLE_STAY" ? "WHOLE_STAY" : "FIRST_NIGHT";
  return { percent: Math.min(pct, 100), of };
}

/** The channel a booking came through, as the no-show rule is keyed. */
function noShowSourceKey(entry: { otaSource: boolean; inquiry: { sourceChannel: string } | null }): string {
  if (entry.otaSource) return "OTA";
  const ch = (entry.inquiry?.sourceChannel ?? "DIRECT").trim().toUpperCase();
  return ch === "TRAVEL_AGENT" ? "AGENT" : ch || "DIRECT";
}

const money2 = (d: Prisma.Decimal) => Number(round2(d).toFixed(2));

/**
 * The booking's ROOM money, taxes included: the first night's, and the whole stay's. Read from
 * the frozen assignment rows (what the night audit would have posted from), each row's meals
 * taken out in proportion; with no rows yet, from the reservation's frozen composition.
 */
async function roomMoneyForNoShow(
  db: Db,
  entry: {
    roomAssignments: Array<{
      roomId: string;
      startDate: Date | null;
      endDate: Date | null;
      frozenSubtotal: Prisma.Decimal | null;
      frozenTotal: Prisma.Decimal | null;
      isFoc: boolean;
    }>;
    reservation: {
      frozenCheckInDate: Date;
      frozenCheckOutDate: Date;
      frozenRate: Prisma.Decimal;
      frozenCommercialTerms: Prisma.JsonValue | null;
    };
  },
): Promise<{ firstNight: Prisma.Decimal; wholeStay: Prisma.Decimal }> {
  const r = entry.reservation;
  const checkIn = utcDateOnly(r.frozenCheckInDate);
  const checkOut = utcDateOnly(r.frozenCheckOutDate);
  const stayNights = Math.max(1, nightsBetweenUtc(checkIn, checkOut));
  const { gstRate, serviceChargeRate } = await resolveChargeRates(db as PrismaClient);
  const taxFactor = toDecimal(1).plus(serviceChargeRate).mul(toDecimal(1).plus(gstRate));
  const comp = frozenCompositionByRoom([r.frozenCommercialTerms]);

  let firstNight = toDecimal(0);
  let wholeStay = toDecimal(0);
  let rows = 0;
  for (const a of entry.roomAssignments) {
    const s = a.startDate ? utcDateOnly(a.startDate) : checkIn;
    const e = a.endDate ? utcDateOnly(a.endDate) : checkOut;
    const nights = nightsBetweenUtc(s, e);
    if (nights <= 0) continue;
    rows += 1;
    if (a.isFoc) continue;
    const rowTotal =
      a.frozenTotal != null
        ? toDecimal(a.frozenTotal)
        : a.frozenSubtotal != null
          ? toDecimal(a.frozenSubtotal).mul(taxFactor)
          : toDecimal(r.frozenRate).mul(nights).mul(taxFactor);
    // The rooms' share of the row — meals out, in the composition's proportion.
    const split = splitFrozenRow({ roomId: a.roomId, rowSubtotal: a.frozenSubtotal, rowNights: nights, composition: comp.get(a.roomId) });
    const share = split && split.subtotal.gt(0) ? split.accommodation.div(split.subtotal) : toDecimal(1);
    const roomTotal = rowTotal.mul(share);
    wholeStay = wholeStay.plus(roomTotal);
    if (s.getTime() <= checkIn.getTime() && e.getTime() > checkIn.getTime()) firstNight = firstNight.plus(roomTotal.div(nights));
  }
  if (rows === 0) {
    // No rooms assigned yet — the reservation's own frozen composition, else its flat rate.
    let accommodation = toDecimal(0);
    let subtotal = toDecimal(0);
    for (const c of comp.values()) {
      accommodation = accommodation.plus(c.accommodation);
      subtotal = subtotal.plus(c.subtotal);
    }
    const total = (r.frozenCommercialTerms as { compositionTotals?: { total?: unknown } } | null)?.compositionTotals?.total;
    if (subtotal.gt(0) && total != null) {
      wholeStay = toDecimal(total as number).mul(accommodation.div(subtotal));
    } else {
      const roomCount = Math.max(1, Number((r.frozenCommercialTerms as { roomCount?: unknown } | null)?.roomCount) || 1);
      wholeStay = toDecimal(r.frozenRate).mul(roomCount).mul(stayNights).mul(taxFactor);
    }
    firstNight = wholeStay.div(stayNights);
  }
  return { firstNight: round2(firstNight), wholeStay: round2(wholeStay) };
}

export async function computeNoShowFigures(db: Db, entryId: string): Promise<NoShowFigures> {
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: true,
      reservation: true,
      inquiry: { select: { sourceChannel: true } },
      roomAssignments: { select: { roomId: true, startDate: true, endDate: true, frozenSubtotal: true, frozenTotal: true, isFoc: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new NotFoundError("Folio");
  if (!entry.reservation) throw new ValidationError("No reservation on the booking — a no-show follows a confirmed booking");

  const advanceReceived = await sumAdvancePaymentInTotalForFolio(db as PrismaClient, entry.folio.id);
  const sourceKey = noShowSourceKey(entry);
  const terms = (entry.reservation.frozenCancellationTerms as Record<string, unknown> | null) ?? {};
  const fromTerms = Number(toDecimal((terms.noShowPenaltyAmount ?? terms.sameDayPenaltyAmount) as number | string | null | undefined).toFixed(2));

  let penaltyBeforeCap = 0;
  let basis: NoShowFigures["basis"] = "NONE";
  let percent: number | null = null;
  let of: NoShowFigures["of"] = null;
  let baseAmount: number | null = null;
  let explanation: string;

  if (fromTerms > 0) {
    penaltyBeforeCap = fromTerms;
    basis = "TERMS";
    explanation = `the no-show charge in the terms this booking was confirmed on`;
  } else {
    const ruleCfg = (await getActiveConfigEntry(db as PrismaClient, "noShow.penaltyStructure"))?.configValue ?? null;
    const rule = readNoShowRule(ruleCfg, sourceKey);
    if (rule) {
      const roomMoney = await roomMoneyForNoShow(db, { roomAssignments: entry.roomAssignments, reservation: entry.reservation });
      const base = rule.of === "WHOLE_STAY" ? roomMoney.wholeStay : roomMoney.firstNight;
      penaltyBeforeCap = money2(base.mul(rule.percent).div(100));
      basis = "NO_SHOW_RULE";
      percent = rule.percent;
      of = rule.of;
      baseAmount = money2(base);
      const what = rule.of === "WHOLE_STAY" ? "the whole stay's rooms" : "one night's room";
      explanation = `${rule.percent === 100 ? what : `${rule.percent}% of ${what}`}, taxes included`;
    } else {
      // Nothing more specific configured — the same-day cancellation tier (spec: a no-show is
      // aligned with it). Judged at the check-in instant.
      const tiers = await requireActiveConfigValue<CancellationPolicyTiersConfig>(db as PrismaClient, "cancellation.policyTiers").catch(() => null);
      const { rawPenalty } = computeS5PreArrivalCancellationPenalty({
        now: entry.reservation.frozenCheckInDate,
        checkInDate: entry.reservation.frozenCheckInDate,
        frozenCancellationTerms: terms,
        policyTiers: tiers,
      });
      penaltyBeforeCap = Number(toDecimal(rawPenalty).toFixed(2));
      basis = penaltyBeforeCap > 0 ? "SAME_DAY_CANCELLATION" : "NONE";
      explanation = penaltyBeforeCap > 0 ? "the same-day cancellation charge" : "no no-show charge is configured";
    }
  }

  const penalty = capCancellationPenaltyAtAdvancePayment(penaltyBeforeCap, advanceReceived);
  const refund = Number(toDecimal(advanceReceived).sub(toDecimal(penalty)).toFixed(2));
  return {
    advanceReceived,
    penaltyBeforeCap,
    penalty,
    refund,
    capped: penalty < penaltyBeforeCap,
    basis,
    sourceKey,
    percent,
    of,
    baseAmount,
    explanation,
  };
}

/** What recording a no-show now would charge and give back — for the desk, nothing written. */
export async function previewNoShow(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { currentStage: true, noShowCutoffReachedAt: true, noShowDetermination: { select: { id: true } } },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S5) {
    throw new ValidationError("A no-show is recorded at Arrival — this booking is not there");
  }
  const figures = await computeNoShowFigures(prisma, entryId);
  return {
    ...figures,
    cutoffReachedAt: entry.noShowCutoffReachedAt,
    alreadyRecorded: !!entry.noShowDetermination,
  };
}

/* ------------------------------------------------------------------ the finalisation */

/**
 * Book a no-show (SIG-S5 §6.5 processNoShowFolio + SIG-S9 Route 2), inside the caller's
 * transaction — shared by the FOM's determination and the W5 auto-finalisation (Sub-path 2b),
 * so the two can never close a no-show differently.
 *
 *   - The charge is POSTED to the folio as a line, before the folio closes (Policy 57 "penalty
 *     posted to folio"). It used to exist only as a number on the folio, so the ledger, the
 *     invoice issued for it at S9 and the bill's figures all read nothing kept.
 *   - The money owed back is recorded as money out, tagged `NO_SHOW_REFUND:<determination>` —
 *     the tag the S9 closure looks for. It was written untagged, so the closure would have
 *     recorded the refund a second time.
 *   - The booking moves to the **Closed step (S9)**, still open: "arrives at S9 for financial
 *     closure" (SIG-S9 §1.3 Route 2), where the Closed step's "Close & seal" finishes it. It used
 *     to be parked at TERMINAL with status ACTIVE — a stage nothing closes from, so a no-show
 *     could never be sealed and sat "active" for ever.
 *   - Every clock the booking still had running stops (the night audit, the quote validity, the
 *     reply windows); the rooms and the hold are released, and the booking's date claims end with
 *     the determination record (see `stillHoldsInventory`).
 */
export async function finaliseNoShowTx(
  tx: Tx,
  input: {
    entryId: string;
    actorId: string;
    path: "SUB_PATH_1" | "SUB_PATH_2B_AUTO";
    contactAttemptLog: ContactAttempt[];
    decisionReason: string;
    figures: NoShowFigures;
    now: Date;
  },
): Promise<{ determinationId: string; timerJobIds: string[] }> {
  const { entryId, actorId, figures, now } = input;
  const entry = await tx.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, committedHold: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");

  const determinationId = await allocateReadableId(tx, "NO_SHOW" as const, now);
  await tx.noShowDeterminationRecord.create({
    data: {
      id: determinationId,
      entryId,
      determinationPath: input.path,
      fomActorId: actorId,
      contactAttemptLog: input.contactAttemptLog as object[],
      decisionReason: input.decisionReason,
      otaNotificationRequired: entry.otaSource,
      otaNotificationStatus: entry.otaSource ? "OPEN" : null,
      createdBy: actorId,
    },
  });

  // The charge, on the ledger. Owed by whoever pays the rooms — a term of the stay as booked,
  // like the early-departure fee.
  if (figures.penalty > 0) {
    const payer = await resolveBillingModelForNewLine(tx, folio.id, FolioLineType.ROOM_CHARGE);
    await tx.folioLine.create({
      data: {
        id: await allocateFolioLineId(tx, folio.id),
        folioId: folio.id,
        lineType: FolioLineType.SERVICE,
        description: `No-show charge · ${figures.explanation}${figures.capped ? " (capped at the advance received)" : ""}`,
        amount: figures.penalty,
        currency: "BTN",
        chargeDate: now,
        stage: Stage.S5,
        postedBy: actorId,
        billingModel: payer,
      },
    });
  }

  if (figures.refund > 0) {
    await tx.paymentRecord.create({
      data: {
        id: await allocateReadableId(tx, "PAYMENT" as const, now),
        folioId: folio.id,
        entryId,
        amount: figures.refund,
        paymentDirection: "OUT",
        receivedAt: now,
        recordedBy: actorId,
        stage: Stage.S5,
        notes: `NO_SHOW_REFUND:${determinationId}`,
      },
    });
  }
  await recomputeFolioOutstandingBalance(tx, folio.id);

  await tx.folio.update({
    where: { id: folio.id },
    data: {
      state: FolioState.NO_SHOW_CLOSED,
      noShowPenaltyAmount: figures.penalty,
      noShowAdvancePaymentAmount: figures.advanceReceived,
      noShowNetPosition: figures.refund,
      noShowFomDetermination: actorId,
      closedAt: now,
      closedBy: actorId,
    },
  });

  // To the Closed step, still open — the S9 closure seals it.
  await tx.stageDwellRecord.updateMany({ where: { entryId, exitedAt: null }, data: { exitedAt: now } });
  await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S9, enteredAt: now } });
  await tx.entry.update({
    where: { id: entryId },
    data: {
      currentStage: Stage.S9,
      status: EntryStatus.ACTIVE,
      awaitingWrittenConfirmationActive: false,
      version: { increment: 1 },
    },
  });

  await releaseEntryRoomsToFree(tx, {
    entryId,
    actorId,
    reason: input.path === "SUB_PATH_1" ? "NO_SHOW_FOM_FINALISED" : "NO_SHOW_AUTO_FINALISED",
    now,
  });
  // SIG-S5 §1.5 (no-show #5) — the room release above puts inventory back to FREE; this
  // additionally closes out the CommittedHold record, which `releaseEntryRoomsToFree` leaves alone.
  await releaseRoomOnNoShowTerminalTx(tx, { entryId, committedHold: entry.committedHold, actorId, now });

  // Every clock the booking still had stops — a no-show has no night to audit, no quote to
  // expire and no reply to wait for. pg-boss jobs are cancelled after the commit.
  const timers = await tx.timerRecord.findMany({ where: { entryId, status: "SCHEDULED" }, select: { id: true, pgBossJobId: true } });
  if (timers.length > 0) {
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "No-show recorded" } as never,
    });
  }

  await tx.traceEvent.create({
    data: {
      eventType: input.path === "SUB_PATH_1" ? "NO_SHOW.DETERMINED" : "NO_SHOW.AUTO_FINALISED",
      actorId,
      actorLevel: input.path === "SUB_PATH_1" ? "L2" : "SYSTEM",
      entityType: "Entry",
      entityId: entryId,
      operation: "TRANSITION",
      timestamp: now,
      stageContext: Stage.S5,
      inquiryId: entry.inquiryId,
      entryId,
      payload: {
        entryId,
        determinationId,
        path: input.path,
        reason: input.decisionReason,
        contactAttempts: input.contactAttemptLog.length,
        advanceReceived: figures.advanceReceived,
        penalty: figures.penalty,
        penaltyBeforeCap: figures.penaltyBeforeCap,
        refund: figures.refund,
        basis: figures.basis,
        sourceKey: figures.sourceKey,
        percent: figures.percent,
        of: figures.of,
        explanation: figures.explanation,
        fromStage: "S5",
        toStage: "S9",
      },
      createdBy: actorId,
    },
  });

  return { determinationId, timerJobIds: timers.map((t) => t.pgBossJobId).filter((j): j is string => !!j) };
}

/**
 * Tell the guest — or the agency or company that booked — that the booking was recorded as a
 * no-show, with what is kept and what goes back (SIG-S5 §6.5 step 5, 2026-09-18). After the
 * commit and best-effort: the decision stands whatever the mail server does, and the send (or why
 * it was skipped) is traced as NO_SHOW_NOTICE_EMAIL.*.
 */
export async function sendNoShowNoticeBestEffort(prisma: PrismaClient, entryId: string, actorId: string, figures: NoShowFigures) {
  try {
    const entry = await prisma.entry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        inquiryId: true,
        checkInDate: true,
        checkOutDate: true,
        contactPersonName: true,
        reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
        guestProfile: { select: { firstName: true, lastName: true } },
        inquiry: { select: { travelAgentId: true, corporateAccountId: true } },
      },
    });
    if (!entry) return;
    const recipient = await resolveInvoiceRecipient(prisma, entryId);
    const guestName =
      [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ").trim() || entry.contactPersonName?.trim() || null;
    const partyBooked = !!(entry.inquiry?.travelAgentId || entry.inquiry?.corporateAccountId);
    await dispatchStageEmailBestEffort(
      {
        prisma,
        entryId,
        actorId,
        inquiryId: entry.inquiryId,
        guestEmail: recipient.to,
        skipReason: recipient.skipReason,
        stage: Stage.S5,
        eventTypePrefix: "NO_SHOW_NOTICE_EMAIL",
      },
      renderNoShowNoticeEmail({
        recipientName: recipient.greetName,
        guestName: partyBooked ? guestName : null,
        bookingRef: entry.id,
        checkInDate: entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? new Date(),
        checkOutDate: entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? new Date(),
        currency: "BTN",
        advanceReceived: figures.advanceReceived,
        kept: figures.penalty,
        keptWhat: figures.explanation,
        owedBack: figures.refund,
      }),
    );
  } catch {
    // best-effort — the no-show is recorded either way
  }
}

/** Cancel the pg-boss jobs behind cancelled timer records — after the commit, best-effort. */
export async function cancelTimerJobsBestEffort(jobIds: string[]) {
  if (jobIds.length === 0) return;
  try {
    const engine = await getTimerEngine();
    await Promise.all(jobIds.map((j) => engine.cancel(j).catch(() => undefined)));
  } catch {
    // best-effort — every worker re-checks the booking's state before acting
  }
}

/* ------------------------------------------------------------------ the determination */

export async function determineNoShow(
  prisma: PrismaClient,
  entryId: string,
  fomActorId: string,
  body: {
    determinationPath: "SUB_PATH_1" | "DEFER" | "REACTIVATE";
    contactAttemptLog: ContactAttempt[];
    decisionReason: string;
    awaitingConfirmationWindowMinutes?: number;
  },
) {
  await requireActiveConfigValue<number>(prisma, "noShow.cutoffWindowMinutes");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, noShowDetermination: true, committedHold: true },
  });

  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS5ForNoShowActions({ currentStage: entry.currentStage });

  enforceNoShowDeterminationNotAlreadyRecorded({ hasExistingDetermination: !!entry.noShowDetermination });

  enforceNoShowDeterminationPrereqs({
    hasCutoffReached: !!entry.noShowCutoffReachedAt,
    contactAttemptCount: body.contactAttemptLog?.length ?? 0,
  });

  if (body.determinationPath === "DEFER") {
    const now = new Date();
    const minutes =
      body.awaitingConfirmationWindowMinutes ??
      (await requireActiveConfigValue<number>(prisma, "noShow.awaitingConfirmationWindowMinutes", { now }));
    if (minutes < 1) throw new ValidationError("awaitingConfirmationWindowMinutes must be >= 1");

    const engine = await getTimerEngine();
    const firesAt = new Date(now.getTime() + minutes * 60_000);
    const jobId = await engine.schedule("AWAITING_WRITTEN_CONFIRMATION_W5", { entryId }, { startAfter: firesAt });

    await prisma.$transaction(async (tx) => {
      await tx.timerRecord.create({
        data: {
          entryId,
          entityType: "Entry",
          entityId: entryId,
          timerType: "AWAITING_WRITTEN_CONFIRMATION_W5",
          timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5",
          stageContext: Stage.S5,
          firesAt,
          dueAt: firesAt,
          status: "SCHEDULED",
          payload: { entryId, firesAt: firesAt.toISOString() },
          pgBossJobId: jobId,
          createdBy: fomActorId,
        },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "NO_SHOW.DEFERRAL_AWAITING_WRITTEN_CONFIRMATION",
          actorId: fomActorId,
          actorLevel: "L2",
          entityType: "Entry",
          entityId: entryId,
          operation: "UPDATE",
          timestamp: now,
          stageContext: Stage.S5,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId, firesAt: firesAt.toISOString(), minutes },
          createdBy: fomActorId,
        },
      });
    });

    // SIG-S5 AC-S5-008: sub-state is not expressed via Entry field changes.
    return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  }

  if (body.determinationPath === "REACTIVATE") {
    const now = new Date();
    const timers = await prisma.timerRecord.findMany({
      where: { entryId, status: "SCHEDULED", timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5" },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    const engine = await getTimerEngine();
    for (const t of timers) {
      if (t.pgBossJobId) await engine.cancel(t.pgBossJobId);
    }

    await prisma.$transaction(async (tx) => {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: fomActorId, cancelledReason: "FOM reactivated S5" },
      });
      await tx.entry.update({
        where: { id: entryId },
        data: { awaitingWrittenConfirmationActive: false, noShowCutoffReachedAt: null, version: { increment: 1 } },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "NO_SHOW.REACTIVATED",
          actorId: fomActorId,
          actorLevel: "L2",
          entityType: "Entry",
          entityId: entryId,
          operation: "UPDATE",
          timestamp: now,
          stageContext: Stage.S5,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId },
          createdBy: fomActorId,
        },
      });
    });
    return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  }

  // SUB_PATH_1
  if (!body.decisionReason?.trim()) {
    throw new ValidationError("decisionReason is required for SUB_PATH_1");
  }
  if (!entry.folio) throw new NotFoundError("Folio");
  if (!entry.reservation) {
    throw new ValidationError("No reservation on the booking — a no-show is priced from the confirmed booking's frozen terms");
  }

  const figures = await computeNoShowFigures(prisma, entryId);
  const now = new Date();
  const { timerJobIds } = await prisma.$transaction((tx) =>
    finaliseNoShowTx(tx, {
      entryId,
      actorId: fomActorId,
      path: "SUB_PATH_1",
      contactAttemptLog: body.contactAttemptLog,
      decisionReason: body.decisionReason.trim(),
      figures,
      now,
    }),
  );
  await cancelTimerJobsBestEffort(timerJobIds);
  await sendNoShowNoticeBestEffort(prisma, entryId, fomActorId, figures);

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId }, include: { noShowDetermination: true, folio: true } });
}
