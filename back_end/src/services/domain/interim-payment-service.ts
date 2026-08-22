import type { PrismaClient } from "@prisma/client";
import { InvoiceState, InvoiceType, PaymentDirection, Prisma, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { applyInboundPaymentToFolioOutstanding } from "../../lib/folio-outstanding-from-payment.js";
import { classifyFolioLine } from "../../lib/folio-tax-lines.js";
import { round2, sumMoney, toDecimal, ZERO } from "../../lib/money.js";
import {
  enforceInterimGuestAnswerRecordedBeforePayment,
  enforceInterimInvoiceDispatchedBeforePayment,
  enforceInterimPaymentStage,
} from "../../policies/35-interim-payment/p80-interim-payment-gates.js";
import { buildEntryBillingSummary } from "./entry-billing-summary-service.js";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;
type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

/**
 * Interim payments (2026-08-21, operator ruling): "sometimes when a guest stays for a longer
 * period, the hotel needs to get a certain payment halfway through the stay" — and a stay
 * extension is conditioned on one. The figure is the operator's: a % or a Nu amount of the
 * PROJECTED total — nights slept + nights to come (extension included) + every other charge
 * already on the folio — net of money already received. The backend does the arithmetic and
 * prints it on the INTERIM invoice; the desk shows it, never computes it.
 *
 * Same order as S3's advance: the interim invoice goes out → the guest's answer is recorded →
 * the money is logged (Policy 80). Two triggers: MANUAL (any time) and NIGHT_AUDIT (config
 * `interimPayment.schedule` — every N nights slept, the audit raises a SUGGESTED request for
 * the desk to put a figure on).
 */

export type InterimAsk = { mode: "PERCENT" | "AMOUNT"; value: number };

export type InterimFigures = {
  currency: string;
  checkIn: string | null;
  /** The projected checkout — the NEW date when an extension is being projected. */
  checkOut: string | null;
  nightsTotal: number;
  nightsSlept: number;
  nightsToCome: number;
  /** Whole-stay room total (tax-inclusive, post-discount) — quote/frozen, or the extension projection. */
  projectedRoomTotal: number;
  /** Every non-room charge on the folio so far (F&B, services, extras…), tax included. */
  otherChargesSoFar: number;
  /** = projectedRoomTotal + otherChargesSoFar. */
  projectedTotal: number;
  /** Room nights already posted by the night audit (tax included) — informational. */
  roomChargesPostedSoFar: number;
  billedSoFar: number;
  /** Payments IN − OUT to date (advance + earlier interim payments). */
  receivedSoFar: number;
  outstandingNow: number;
  ask: InterimAsk | null;
  /** What the ask comes to in money (before netting what is already received). */
  askAmount: number | null;
  /** = max(0, askAmount − receivedSoFar), capped at what the stay can still owe. */
  dueNow: number | null;
  /** Left to pay at checkout after the interim payment. */
  balanceAtCheckout: number | null;
  /** "50% of the projected total" / "Nu 20,000.00". */
  askLabel: string | null;
  projectionSource: "QUOTE" | "EXTENSION_PREVIEW" | "LEDGER_RUN_RATE";
};

const DAY_MS = 86_400_000;
const n2 = (d: Prisma.Decimal): number => Number(round2(d));
const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function describeInterimAsk(ask: InterimAsk | null, currency = "BTN"): string | null {
  if (!ask) return null;
  if (ask.mode === "PERCENT") return `${ask.value}% of the projected total`;
  return `${currency === "BTN" ? "Nu" : currency} ${ask.value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The figures behind an interim ask — all Decimal-safe, all from the ledger + the booking's
 * priced basis. `projection` (stay extension) swaps the whole-stay room total and checkout for
 * the extended ones; without it the stay total is what the booking is priced on today.
 */
export async function computeInterimFigures(
  prisma: PrismaClient,
  entryId: string,
  opts?: { projection?: { checkOut: Date; roomTotal: number } | null; ask?: InterimAsk | null },
): Promise<InterimFigures> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      checkInDate: true,
      checkOutDate: true,
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
      folio: { select: { id: true, lines: true, payments: true, outstandingBalance: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  const summary = await buildEntryBillingSummary(prisma, entryId);
  const currency = summary.currency ?? "BTN";

  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null;
  const checkOut = opts?.projection?.checkOut ?? entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? null;
  const nightsTotal = checkIn && checkOut ? Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS)) : 0;
  const today = todayUtcMidnight();
  const nightsSlept = checkIn ? Math.max(0, Math.min(nightsTotal, Math.round((today.getTime() - checkIn.getTime()) / DAY_MS))) : 0;
  const nightsToCome = Math.max(0, nightsTotal - nightsSlept);

  // Room nights posted so far = the ROOM_CHARGE lines + the SC/GST companions the night audit
  // wrote beside them (stamped with the audit run). Everything else on the ledger is "other
  // charges" — F&B, services, extras and their own tax — which the projection carries as-is.
  const lines = entry.folio?.lines ?? [];
  const roomLineTypes = new Set<string>(["ROOM_CHARGE", "STAY"]);
  let roomPosted = ZERO;
  let billed = ZERO;
  for (const l of lines) {
    const amt = toDecimal(l.amount);
    billed = billed.add(amt);
    const cls = classifyFolioLine(l);
    const isRoom = roomLineTypes.has(String(l.lineType)) && cls === "CHARGE";
    const isRoomTax = (cls === "SERVICE_CHARGE" || cls === "GST") && !!l.nightAuditRecordId;
    if (isRoom || isRoomTax) roomPosted = roomPosted.add(amt);
  }
  const otherCharges = billed.sub(roomPosted);

  let projectedRoom: Prisma.Decimal;
  let projectionSource: InterimFigures["projectionSource"];
  if (opts?.projection) {
    projectedRoom = toDecimal(opts.projection.roomTotal);
    projectionSource = "EXTENSION_PREVIEW";
  } else if (summary.stayTotal.amount != null) {
    projectedRoom = toDecimal(summary.stayTotal.amount);
    projectionSource = "QUOTE";
  } else {
    // Legacy booking with no priced quote: run the posted nights' average forward.
    const perNight = nightsSlept > 0 ? roomPosted.div(nightsSlept) : ZERO;
    projectedRoom = roomPosted.add(perNight.mul(nightsToCome));
    projectionSource = "LEDGER_RUN_RATE";
  }
  const projectedTotal = round2(projectedRoom.add(otherCharges));

  const payments = entry.folio?.payments ?? [];
  const paidIn = sumMoney(payments.filter((p) => p.paymentDirection === "IN").map((p) => p.amount));
  const paidOut = sumMoney(payments.filter((p) => p.paymentDirection === "OUT").map((p) => p.amount));
  const received = round2(paidIn.sub(paidOut));

  const ask = opts?.ask ?? null;
  let askAmount: Prisma.Decimal | null = null;
  let dueNow: Prisma.Decimal | null = null;
  let balanceAtCheckout: Prisma.Decimal | null = null;
  if (ask) {
    if (!Number.isFinite(ask.value) || ask.value <= 0) throw new ValidationError("The interim ask must be a positive figure");
    if (ask.mode === "PERCENT" && ask.value > 100) throw new ValidationError("A percentage ask is at most 100%");
    askAmount = ask.mode === "PERCENT" ? round2(projectedTotal.mul(ask.value).div(100)) : round2(toDecimal(ask.value));
    const stillOwed = projectedTotal.sub(received);
    const raw = askAmount.sub(received);
    dueNow = round2(raw.lt(ZERO) ? ZERO : raw.gt(stillOwed) ? (stillOwed.lt(ZERO) ? ZERO : stillOwed) : raw);
    const bal = projectedTotal.sub(received).sub(dueNow);
    balanceAtCheckout = round2(bal.lt(ZERO) ? ZERO : bal);
  }

  return {
    currency,
    checkIn: isoDay(checkIn),
    checkOut: isoDay(checkOut),
    nightsTotal,
    nightsSlept,
    nightsToCome,
    projectedRoomTotal: n2(projectedRoom),
    otherChargesSoFar: n2(otherCharges),
    projectedTotal: n2(projectedTotal),
    roomChargesPostedSoFar: n2(roomPosted),
    billedSoFar: n2(billed),
    receivedSoFar: n2(received),
    outstandingNow: summary.folio?.outstandingBalance ?? n2(toDecimal(entry.folio?.outstandingBalance ?? 0)),
    ask,
    askAmount: askAmount ? n2(askAmount) : null,
    dueNow: dueNow ? n2(dueNow) : null,
    balanceAtCheckout: balanceAtCheckout ? n2(balanceAtCheckout) : null,
    askLabel: describeInterimAsk(ask, currency),
    projectionSource,
  };
}

const OPEN_STATES = ["SUGGESTED", "REQUESTED", "BILLED"] as const;

async function loadEntryForInterim(db: Db, entryId: string) {
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      folio: { select: { id: true, state: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new ValidationError("This booking has no folio");
  return entry as typeof entry & { folio: NonNullable<typeof entry.folio> };
}

/**
 * Inside a transaction: mint the request + its INTERIM invoice (DRAFT). A SUGGESTED request
 * (night-audit prompt) of the same kind is converted in place; any other open LONG_STAY
 * request is withdrawn and its invoice superseded — one open ask at a time.
 */
export async function createInterimPaymentRequestTx(
  tx: Tx,
  actor: Actor,
  input: {
    entryId: string;
    kind: "LONG_STAY" | "EXTENSION";
    ask: InterimAsk;
    figures: InterimFigures;
    note?: string | null;
    stayExtensionRequestId?: string | null;
    promptedBy?: "MANUAL" | "NIGHT_AUDIT";
  },
) {
  const entry = await loadEntryForInterim(tx, input.entryId);
  enforceInterimPaymentStage({ currentStage: entry.currentStage, folioState: entry.folio.state });
  if (entry.status !== "ACTIVE") throw new ValidationError(`The booking is ${entry.status.toLowerCase()} — its record is read-only`);
  if (input.figures.dueNow == null || input.figures.askAmount == null) throw new ValidationError("The interim ask has no figure");
  if (input.figures.dueNow <= 0) {
    throw new ValidationError(
      `Nothing is due now — the guest has already paid ${input.figures.receivedSoFar.toFixed(2)} against an ask of ${input.figures.askAmount.toFixed(2)}`,
    );
  }
  const now = new Date();

  // One open LONG_STAY ask at a time: the night audit's SUGGESTED row becomes this request;
  // an older REQUESTED/BILLED one is withdrawn (its bill superseded) in favour of the new figure.
  let reuseId: string | null = null;
  if (input.kind === "LONG_STAY") {
    const open = await tx.interimPaymentRequest.findMany({
      where: { entryId: input.entryId, kind: "LONG_STAY", state: { in: [...OPEN_STATES] } },
      orderBy: { createdAt: "desc" },
    });
    for (const r of open) {
      if (r.state === "SUGGESTED" && !reuseId) {
        reuseId = r.id;
        continue;
      }
      await tx.interimPaymentRequest.update({
        where: { id: r.id },
        data: { state: "WITHDRAWN", closedAt: now, closedReason: "REPLACED_BY_NEW_ASK" },
      });
      if (r.invoiceId) {
        await tx.invoice.updateMany({
          where: { id: r.invoiceId, state: { in: [InvoiceState.DRAFT, InvoiceState.DISPATCHED] } },
          data: { state: InvoiceState.SUPERSEDED },
        });
      }
    }
  }

  const invoiceId = await allocateReadableId(tx, "INVOICE" as const, now);
  const figuresJson = input.figures as unknown as Prisma.InputJsonValue;
  const data = {
    folioId: entry.folio.id,
    segmentId: entry.segments[0]?.id ?? null,
    kind: input.kind,
    state: "REQUESTED" as const,
    promptedBy: input.promptedBy ?? ("MANUAL" as const),
    askMode: input.ask.mode,
    askValue: new Prisma.Decimal(input.ask.value.toFixed(2)),
    projectedTotal: new Prisma.Decimal(input.figures.projectedTotal.toFixed(2)),
    receivedAtRequest: new Prisma.Decimal(input.figures.receivedSoFar.toFixed(2)),
    dueNow: new Prisma.Decimal(input.figures.dueNow.toFixed(2)),
    figures: figuresJson,
    invoiceId,
    stayExtensionRequestId: input.stayExtensionRequestId ?? null,
    note: input.note?.trim() || null,
    requestedBy: actor.actorId,
    requestedAt: now,
  };
  const invoice = await tx.invoice.create({
    data: {
      id: invoiceId,
      folioId: entry.folio.id,
      entryId: input.entryId,
      invoiceType: InvoiceType.INTERIM,
      state: InvoiceState.DRAFT,
      templateKey: "interim-v1",
      issuedAt: now,
      issuedBy: actor.actorId,
      totalAmount: new Prisma.Decimal(input.figures.dueNow.toFixed(2)),
      metadata: { basis: input.kind === "EXTENSION" ? "STAY_EXTENSION" : "INTERIM", kind: input.kind } as Prisma.InputJsonValue,
    },
  });
  const request = reuseId
    ? await tx.interimPaymentRequest.update({ where: { id: reuseId }, data })
    : await tx.interimPaymentRequest.create({ data: { ...data, entryId: input.entryId } });
  await tx.invoice.update({
    where: { id: invoice.id },
    data: { metadata: { ...(invoice.metadata as object | null), interimPaymentRequestId: request.id } as Prisma.InputJsonValue },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "INTERIM_PAYMENT.REQUESTED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "InterimPaymentRequest",
      entityId: request.id,
      operation: reuseId ? "UPDATE" : "CREATE",
      timestamp: now,
      stageContext: Stage.S7,
      inquiryId: entry.inquiryId,
      entryId: input.entryId,
      payload: {
        entryId: input.entryId,
        kind: input.kind,
        ask: input.ask,
        projectedTotal: input.figures.projectedTotal,
        receivedSoFar: input.figures.receivedSoFar,
        dueNow: input.figures.dueNow,
        invoiceId,
        stayExtensionRequestId: input.stayExtensionRequestId ?? null,
      } as Prisma.InputJsonValue,
      createdBy: actor.actorId,
    },
  });
  return { request, invoice };
}

/** Manual LONG_STAY ask from the Stay step. */
export async function createInterimPaymentRequest(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: { ask: InterimAsk; note?: string | null },
) {
  const figures = await computeInterimFigures(prisma, entryId, { ask: input.ask });
  return prisma.$transaction((tx) => createInterimPaymentRequestTx(tx, actor, { entryId, kind: "LONG_STAY", ask: input.ask, figures, note: input.note }));
}

/** Called by `dispatchInvoice` when an INTERIM invoice goes out: REQUESTED → BILLED. */
export async function markInterimInvoiceDispatchedTx(tx: Tx, invoiceId: string, now: Date) {
  const req = await tx.interimPaymentRequest.findUnique({ where: { invoiceId } });
  if (!req) return null;
  if (req.state === "REQUESTED") {
    await tx.interimPaymentRequest.update({ where: { id: req.id }, data: { state: "BILLED", billedAt: now } });
    if (req.stayExtensionRequestId) {
      await tx.stayExtensionRequest.updateMany({
        where: { id: req.stayExtensionRequestId, state: "REQUESTED" },
        data: { state: "BILLED" },
      });
    }
  }
  return req;
}

/**
 * The money. Gates (Policy 80): in-house, live folio, the interim invoice dispatched, the
 * guest's answer recorded. Partial payments accumulate; the request flips to PAID — and the
 * extension it belongs to with it — once the linked payments reach `dueNow`.
 */
export async function recordInterimPayment(
  prisma: PrismaClient,
  actor: Actor,
  requestId: string,
  input: { amount: number; paymentMethod?: string | null; notes?: string | null },
) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new ValidationError("Payment amount must be a positive number");
  return prisma.$transaction(async (tx) => {
    const req = await tx.interimPaymentRequest.findUnique({
      where: { id: requestId },
      include: { invoice: true, payments: true, entry: { select: { id: true, status: true, currentStage: true, inquiryId: true } }, folio: true },
    });
    if (!req) throw new NotFoundError("InterimPaymentRequest");
    if (req.state === "PAID") throw new ValidationError("This interim payment has already been received in full");
    if (req.state === "WITHDRAWN" || req.state === "LAPSED") throw new ValidationError(`This interim request was ${req.state.toLowerCase()}`);
    if (req.state === "SUGGESTED") throw new ValidationError("Put a figure on the interim payment first — no bill has been generated yet");
    enforceInterimPaymentStage({ currentStage: req.entry.currentStage, folioState: req.folio.state });
    enforceInterimInvoiceDispatchedBeforePayment({ invoice: req.invoice ? { state: req.invoice.state, dispatchedAt: req.invoice.dispatchedAt } : null });
    const latestComm = await tx.communicationRecord.findFirst({
      where: {
        entryId: req.entryId,
        commType: "INTERIM_INVOICE",
        direction: "OUTBOUND",
        sendStatus: "DISPATCHED",
        createdAt: { gte: req.requestedAt },
      },
      orderBy: { createdAt: "desc" },
      select: { acknowledgementStatus: true },
    });
    // The interim invoice is always dispatched through `dispatchInvoice`, which mints the
    // communication — a missing one means the bill never went out (caught above).
    enforceInterimGuestAnswerRecordedBeforePayment({
      latestDispatchedInterimComm: latestComm ?? { acknowledgementStatus: "PENDING" },
    });

    const now = new Date();
    const paymentId = await allocateReadableId(tx, "PAYMENT" as const, now);
    const payment = await tx.paymentRecord.create({
      data: {
        id: paymentId,
        folioId: req.folioId,
        entryId: req.entryId,
        invoiceId: req.invoiceId,
        interimPaymentRequestId: req.id,
        amount: new Prisma.Decimal(input.amount.toFixed(2)),
        currency: "BTN",
        paymentMethod: input.paymentMethod?.trim() || "CASH",
        paymentDirection: PaymentDirection.IN,
        receivedAt: now,
        recordedBy: actor.actorId,
        stage: Stage.S7,
        notes: input.notes?.trim() || null,
      },
    });
    await applyInboundPaymentToFolioOutstanding(tx, req.folioId, input.amount);

    const linked = sumMoney([...req.payments.map((p) => p.amount), payment.amount]);
    const due = toDecimal(req.dueNow ?? 0);
    const paidInFull = linked.gte(due);
    const updated = await tx.interimPaymentRequest.update({
      where: { id: req.id },
      data: paidInFull ? { state: "PAID", paidAt: now } : {},
    });
    if (paidInFull && req.invoiceId) {
      await tx.invoice.updateMany({
        where: { id: req.invoiceId, state: InvoiceState.DISPATCHED },
        data: { state: InvoiceState.PAYMENT_TRACKED },
      });
    }
    if (paidInFull && req.stayExtensionRequestId) {
      await tx.stayExtensionRequest.updateMany({
        where: { id: req.stayExtensionRequestId, state: { in: ["REQUESTED", "BILLED"] } },
        data: { state: "PAID" },
      });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "FOLIO.PAYMENT_RECORDED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "PaymentRecord",
        entityId: payment.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: req.entry.inquiryId,
        entryId: req.entryId,
        payload: {
          folioId: req.folioId,
          entryId: req.entryId,
          amount: input.amount,
          stage: Stage.S7,
          kind: "INTERIM",
          interimKind: req.kind,
          interimPaymentRequestId: req.id,
          stayExtensionRequestId: req.stayExtensionRequestId,
          receivedAgainstAsk: n2(linked),
          dueNow: n2(due),
          paidInFull,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
    return { payment, request: updated, paidInFull, receivedAgainstAsk: n2(linked), remaining: n2(due.sub(linked).lt(ZERO) ? ZERO : due.sub(linked)) };
  });
}

export async function withdrawInterimPaymentRequest(prisma: PrismaClient, actor: Actor, requestId: string, reason?: string | null) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.interimPaymentRequest.findUnique({ where: { id: requestId }, include: { entry: { select: { inquiryId: true } } } });
    if (!req) throw new NotFoundError("InterimPaymentRequest");
    if (req.state === "PAID") throw new ValidationError("A paid interim request cannot be withdrawn — the money is on the folio");
    if (req.state === "WITHDRAWN" || req.state === "LAPSED") return req;
    if (req.stayExtensionRequestId) {
      const ext = await tx.stayExtensionRequest.findUnique({ where: { id: req.stayExtensionRequestId }, select: { state: true } });
      if (ext && (ext.state === "REQUESTED" || ext.state === "BILLED" || ext.state === "PAID")) {
        throw new ValidationError("This bill belongs to a stay extension — withdraw the extension instead");
      }
    }
    const now = new Date();
    const updated = await tx.interimPaymentRequest.update({
      where: { id: req.id },
      data: { state: "WITHDRAWN", closedAt: now, closedReason: reason?.trim() || "WITHDRAWN_BY_DESK" },
    });
    if (req.invoiceId) {
      await tx.invoice.updateMany({
        where: { id: req.invoiceId, state: { in: [InvoiceState.DRAFT, InvoiceState.DISPATCHED] } },
        data: { state: InvoiceState.SUPERSEDED },
      });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "INTERIM_PAYMENT.WITHDRAWN",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "InterimPaymentRequest",
        entityId: req.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: req.entry.inquiryId,
        entryId: req.entryId,
        payload: { entryId: req.entryId, reason: reason ?? null } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
    return updated;
  });
}

/** Inside a transaction (extension lapse / withdrawal): close the extension's bill. */
export async function closeInterimForExtensionTx(tx: Tx, stayExtensionRequestId: string, state: "LAPSED" | "WITHDRAWN", reason: string) {
  const req = await tx.interimPaymentRequest.findUnique({ where: { stayExtensionRequestId } });
  if (!req || req.state === "PAID" || req.state === "WITHDRAWN" || req.state === "LAPSED") return req;
  const now = new Date();
  const updated = await tx.interimPaymentRequest.update({ where: { id: req.id }, data: { state, closedAt: now, closedReason: reason } });
  if (req.invoiceId) {
    await tx.invoice.updateMany({
      where: { id: req.invoiceId, state: { in: [InvoiceState.DRAFT, InvoiceState.DISPATCHED] } },
      data: { state: InvoiceState.SUPERSEDED },
    });
  }
  return updated;
}

/**
 * Night-audit hook (config `interimPayment.schedule`): every `everyNights` nights slept, raise
 * a SUGGESTED LONG_STAY request — the desk puts the figure on it. Skipped on the stay's last
 * night (settlement is tomorrow), while any request is open, when a request was already
 * raised or paid this cycle, or when the outstanding balance is under `minimumOutstanding`.
 */
export async function maybePromptInterimPaymentTx(
  tx: Tx,
  input: { entryId: string; folioId: string; operatingDate: Date; actorId: string },
) {
  type Schedule = { enabled?: boolean; everyNights?: number; minimumOutstanding?: number };
  let schedule: Schedule = { enabled: true, everyNights: 7, minimumOutstanding: 0 };
  try {
    const cfg = await requireActiveConfigValue<Schedule>(tx as unknown as PrismaClient, "interimPayment.schedule");
    if (cfg && typeof cfg === "object") schedule = { ...schedule, ...cfg };
  } catch {
    /* unseeded → defaults */
  }
  const every = Number(schedule.everyNights ?? 7);
  if (schedule.enabled === false || !Number.isFinite(every) || every < 1) return null;

  const entry = await tx.entry.findUnique({
    where: { id: input.entryId },
    select: {
      id: true,
      inquiryId: true,
      status: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
      folio: { select: { state: true, outstandingBalance: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
    },
  });
  if (!entry?.folio || entry.status !== "ACTIVE" || entry.currentStage !== Stage.S7) return null;
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const checkOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!checkIn || !checkOut) return null;
  const nightsTotal = Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS));
  // The audit for `operatingDate` posts THAT night — after it the guest has slept it.
  const nightsSlept = Math.round((input.operatingDate.getTime() - checkIn.getTime()) / DAY_MS) + 1;
  if (nightsSlept < every || nightsSlept >= nightsTotal) return null;
  if (nightsSlept % every !== 0) return null;
  const minimum = Number(schedule.minimumOutstanding ?? 0);
  if (Number.isFinite(minimum) && toDecimal(entry.folio.outstandingBalance).lt(toDecimal(minimum))) return null;

  const open = await tx.interimPaymentRequest.findFirst({
    where: { entryId: input.entryId, state: { in: [...OPEN_STATES] } },
    select: { id: true },
  });
  if (open) return null;
  const recent = await tx.interimPaymentRequest.findFirst({
    where: { entryId: input.entryId, kind: "LONG_STAY", state: "PAID", nightsSleptAtPrompt: { gt: nightsSlept - every } },
    select: { id: true },
  });
  if (recent) return null;

  const now = new Date();
  const created = await tx.interimPaymentRequest.create({
    data: {
      entryId: input.entryId,
      folioId: input.folioId,
      segmentId: entry.segments[0]?.id ?? null,
      kind: "LONG_STAY",
      state: "SUGGESTED",
      promptedBy: "NIGHT_AUDIT",
      nightsSleptAtPrompt: nightsSlept,
      requestedBy: null,
      requestedAt: now,
    },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "INTERIM_PAYMENT.DUE_PROMPTED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "InterimPaymentRequest",
      entityId: created.id,
      operation: "CREATE",
      timestamp: now,
      stageContext: Stage.S7,
      inquiryId: entry.inquiryId,
      entryId: input.entryId,
      payload: {
        entryId: input.entryId,
        nightsSlept,
        nightsTotal,
        everyNights: every,
        outstandingBalance: Number(toDecimal(entry.folio.outstandingBalance).toFixed(2)),
        operatingDate: input.operatingDate.toISOString().slice(0, 10),
      } as Prisma.InputJsonValue,
      createdBy: "SYSTEM",
    },
  });
  return created;
}

/** The Stay step's view: every request (newest first) + today's figures with no ask. */
export async function listInterimPayments(prisma: PrismaClient, entryId: string) {
  const [requests, figures] = await Promise.all([
    prisma.interimPaymentRequest.findMany({
      where: { entryId },
      orderBy: { createdAt: "desc" },
      include: {
        invoice: { select: { id: true, state: true, dispatchedAt: true, dispatchedTo: true, totalAmount: true, pdfStorageKey: true } },
        payments: { select: { id: true, amount: true, receivedAt: true, paymentMethod: true } },
      },
    }),
    computeInterimFigures(prisma, entryId).catch(() => null),
  ]);
  return {
    entryId,
    figures,
    requests: requests.map((r) => ({
      ...r,
      askValue: r.askValue != null ? Number(r.askValue) : null,
      projectedTotal: r.projectedTotal != null ? Number(r.projectedTotal) : null,
      receivedAtRequest: r.receivedAtRequest != null ? Number(r.receivedAtRequest) : null,
      dueNow: r.dueNow != null ? Number(r.dueNow) : null,
      receivedAgainstAsk: n2(sumMoney(r.payments.map((p) => p.amount))),
      payments: r.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
      invoice: r.invoice ? { ...r.invoice, totalAmount: r.invoice.totalAmount != null ? Number(r.invoice.totalAmount) : null } : null,
    })),
  };
}
