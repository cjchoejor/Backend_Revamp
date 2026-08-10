import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { InvoiceState, InvoiceType, PaymentDirection, PreArrivalTaskType, Prisma, Stage, TaskStatus } from "@prisma/client";
import { MissingConfigurationError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceCreditExtensionConstraints } from "../../policies/18-credit-extension-ceiling/p42-credit-ceiling-mandatory-set.js";
import { enforceAdvancePaymentReconciliationRequiresPayment } from "../../policies/12-advance-payment/p27-advance-payment-reconciliation.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { maxZeroSub, pctOf, round2, sumMoneyBy, toDecimal } from "../../lib/money.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";

function toNumber(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return NaN;
}

/**
 * The operator-pinned advance requirement, scoped to the CURRENT segment (2026-08-02 operator
 * ruling). The folio is a per-entry singleton, so a requirement pinned in segment 1 would
 * otherwise survive a re-entry and resurface as segment 2's threshold — but each segment must
 * start from the admin-configured `advancePayment.thresholds` until the desk pins one afresh.
 * Scoping is by set-time: a `basis.setAt` before the current segment's `startedAt` is a prior
 * segment's decision and returns null (config applies). Requirements stored before `setAt`
 * existed can't be scoped and stay honored. Shared by the payment evaluation, the
 * requirement-change detection, and the proforma composition so all three agree.
 */
export function resolveOperatorAdvanceRequirement(
  folio: { advanceRequiredAmount: Prisma.Decimal | null; advanceRequiredBasis: unknown },
  currentSegmentStartedAt: Date | null | undefined,
): number | null {
  if (folio.advanceRequiredAmount == null) return null;
  const basis = folio.advanceRequiredBasis as { setAt?: unknown } | null;
  const setAt = typeof basis?.setAt === "string" ? new Date(basis.setAt) : null;
  if (
    setAt &&
    Number.isFinite(setAt.getTime()) &&
    currentSegmentStartedAt &&
    setAt.getTime() < currentSegmentStartedAt.getTime()
  ) {
    return null;
  }
  return Number(folio.advanceRequiredAmount.toString());
}

// ─── Advance payment plan (2026-08-07) ─────────────────────────────────────────────────────
// What the guest SAID about paying the advance, captured with their answer to the proforma:
// the whole amount at once, part now with the rest later, or in installments — and when the
// remainder is coming (a dated promise before check-in, at check-in, or at check-out).
// Advisory facts: the S5/S6 gates still run on money received + credit extension. The plan
// drives the W38 promise timer and the settlement surfaces at S4–S8, and tells the desk which
// credit-extension expiry to suggest for the uncovered remainder.

export type AdvancePaymentPlanKind = "FULL" | "PARTIAL" | "INSTALLMENTS";
/** AT_CHECKOUT is read-side only since 2026-08-08 (operator ruling: the advance settles before
 *  or at check-in — check-out money is normal folio settlement). Stored legacy plans keep it;
 *  new writes are refused. */
export type AdvanceBalanceDueAt = "BEFORE_CHECKIN" | "AT_CHECKIN" | "AT_CHECKOUT";

/**
 * One guest-facing sentence for the plan — printed on the proforma and stated in its email
 * (2026-08-08: "select one and reflect that in the PI"). The date formatter is the caller's
 * (the PDF's `formatDocDate`, the email's `formatDate`) so each document keeps its own style.
 * Null when no plan is recorded — the document then says nothing rather than assuming.
 */
export function describeAdvancePaymentPlan(
  plan: AdvancePaymentPlan | null,
  formatDate: (d: Date) => string,
): string | null {
  if (!plan) return null;
  if (plan.plan === "FULL") return "Full amount at once";
  const head = plan.plan === "PARTIAL" ? "Part now" : "In installments";
  const promised = plan.promisedBy ? new Date(plan.promisedBy) : null;
  const due =
    plan.balanceDueAt === "BEFORE_CHECKIN" && promised && Number.isFinite(promised.getTime())
      ? `by ${formatDate(promised)}`
      : plan.balanceDueAt === "AT_CHECKIN"
        ? "at check-in"
        : plan.balanceDueAt === "AT_CHECKOUT"
          ? "at check-out"
          : null;
  return due ? `${head} — remainder ${due}` : head;
}

export type AdvancePaymentPlan = {
  plan: AdvancePaymentPlanKind;
  balanceDueAt: AdvanceBalanceDueAt | null;
  promisedBy: string | null;
  note: string | null;
  setBy: string;
  setAt: string;
};

/**
 * The guest's payment plan, scoped to the CURRENT segment — same `setAt` scoping as the
 * operator-pinned requirement above: a plan recorded in a sealed segment described a deal
 * that segment superseded, so it does not carry across a re-entry.
 */
export function resolveAdvancePaymentPlan(
  folio: { advancePaymentPlan: unknown },
  currentSegmentStartedAt: Date | null | undefined,
): AdvancePaymentPlan | null {
  const raw = folio.advancePaymentPlan as Partial<AdvancePaymentPlan> | null;
  if (!raw || typeof raw !== "object" || typeof raw.plan !== "string") return null;
  const setAt = typeof raw.setAt === "string" ? new Date(raw.setAt) : null;
  if (
    setAt &&
    Number.isFinite(setAt.getTime()) &&
    currentSegmentStartedAt &&
    setAt.getTime() < currentSegmentStartedAt.getTime()
  ) {
    return null;
  }
  return {
    plan: raw.plan as AdvancePaymentPlanKind,
    balanceDueAt: (raw.balanceDueAt as AdvanceBalanceDueAt | undefined) ?? null,
    promisedBy: typeof raw.promisedBy === "string" ? raw.promisedBy : null,
    note: typeof raw.note === "string" ? raw.note : null,
    setBy: typeof raw.setBy === "string" ? raw.setBy : "",
    setAt: typeof raw.setAt === "string" ? raw.setAt : "",
  };
}

async function computeAdvancePaymentEvaluation(
  db: PrismaClient | Prisma.TransactionClient,
  input: { entryId: string; folioId: string },
  thresholds: any,
) {
  const folio = await db.folio.findUnique({ where: { id: input.folioId }, include: { payments: true } });
  if (!folio) throw new ValidationError("folioId invalid");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");

  // Resolve the base required amount. The config supports two shapes:
  //   1) Flat: { amount: N }
  //   2) Per-source: { DEFAULT: { amount: N }, OTA: { amount: M }, CORPORATE: { amount: P }, ... }
  // When the entry has an ota/source, per-source overrides the DEFAULT; otherwise DEFAULT wins.
  const entry = await db.entry.findUnique({
    where: { id: input.entryId },
    include: {
      inquiry: { select: { sourceChannel: true } },
      // Current segment's start — scopes the operator-pinned requirement (see helper above).
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { startedAt: true } },
    },
    // groupBillingMode + sourceChannel needed for both boost and per-source resolution.
  });
  const isGroup = entry?.groupBillingMode === "GROUP_MASTER";
  const sourceKey = String(entry?.inquiry?.sourceChannel ?? "").toUpperCase();
  const perSourceAmount = sourceKey && thresholds && typeof thresholds === "object"
    ? toNumber((thresholds as any)[sourceKey]?.amount)
    : NaN;
  const baseRequiredAmount = Number.isFinite(perSourceAmount) && perSourceAmount > 0
    ? perSourceAmount
    : toNumber(thresholds?.DEFAULT?.amount ?? thresholds?.amount ?? 0);

  // Group booking boost — if the parent entry was classified as GROUP_MASTER (Policy 64),
  // multiply the resolved base amount by the policy's `multiplierPercent`. 200 = 2x. This
  // now boosts whichever source shape was resolved above (per-source OTA amount, per-source
  // CORPORATE amount, or DEFAULT) — not only DEFAULT — which was the Loophole 3 bug.
  let requiredAmount = baseRequiredAmount;
  let boostApplied: { multiplierPercent: number; baseAmount: number } | null = null;
  if (isGroup && Number.isFinite(baseRequiredAmount) && baseRequiredAmount > 0) {
    const boostPolicy = await getRegistryPolicy(db as any, "registry.groupBooking.advancePaymentBoost");
    if (boostPolicy && boostPolicy.enabled !== false && typeof boostPolicy.multiplierPercent === "number") {
      const mult = Math.max(0, boostPolicy.multiplierPercent as number) / 100;
      const boosted = baseRequiredAmount * mult;
      if (boosted > baseRequiredAmount) {
        requiredAmount = boosted;
        boostApplied = { multiplierPercent: boostPolicy.multiplierPercent as number, baseAmount: baseRequiredAmount };
      }
    }
  }

  // Operator-set requirement (2026-08-01) — when the desk pinned an advance for THIS booking
  // (flat amount or a percentage resolved at set time), it overrides the config thresholds AND
  // the group boost: an explicit per-booking decision beats every derived default. Segment-
  // scoped (2026-08-02): a pin from a PRIOR segment does not carry across a re-entry — each
  // segment starts from the configured thresholds until the desk pins one afresh.
  const operatorRequired = resolveOperatorAdvanceRequirement(folio, entry?.segments?.[0]?.startedAt ?? null);
  // What the CONFIG demands (thresholds + group boost), before any per-booking pin — carried
  // on the response so the desk can show both figures side by side: the pin lives on this
  // booking's folio alone and never touches the configured minimum (2026-08-03, after an
  // operator read a pinned figure as "the minimum threshold changed").
  const configuredBaseAmount = Number.isFinite(requiredAmount) ? Number(toDecimal(requiredAmount).toFixed(2)) : 0;
  if (operatorRequired != null) {
    requiredAmount = operatorRequired;
    boostApplied = null;
  }

  // Decimal-safe sum — reducing Number(p.amount) with `+` produced 4999.999999999999 for
  // three partial payments totalling exactly 5000 and wrongly blocked check-in at the gate.
  const inPayments = (folio.payments ?? []).filter((p) => p.paymentDirection === PaymentDirection.IN);
  const totalReceivedDec = sumMoneyBy(inPayments, "amount");
  const requiredAmountDec = toDecimal(Number.isFinite(requiredAmount) ? requiredAmount : 0);

  const credit = await db.creditExtensionCeilingRecord.findUnique({ where: { folioId: folio.id } });

  // Advance-payment window (2026-08-01 operator ruling, deadline side): the advance is due
  // BETWEEN the proforma going out and the check-in date. The start is already enforced by
  // p27 (`enforceProformaDispatchedBeforeAdvancePayment` — no money before the bill); the
  // deadline here is a READ-TIME fact like the credit-extension expiry below — no worker,
  // because the S5/S6 arrival gates are the enforcement teeth if check-in arrives unpaid.
  // Superseded proformas don't open the window (a re-issued bill has to go out again).
  const dispatchedProforma = await db.invoice.findFirst({
    where: {
      folioId: folio.id,
      invoiceType: InvoiceType.PROFORMA,
      state: { not: InvoiceState.SUPERSEDED },
      dispatchedAt: { not: null },
    },
    orderBy: { dispatchedAt: "desc" },
    select: { dispatchedAt: true },
  });
  // An extension past its expiry no longer satisfies the condition — enforcement is at read
  // time, so no worker is needed; the clock simply runs out.
  const now = new Date();
  const creditExtensionExpired = !!credit?.expiresAt && credit.expiresAt.getTime() <= now.getTime();
  const creditExtensionActive = !!credit && !creditExtensionExpired;

  const satisfied = creditExtensionActive
    || (Number.isFinite(requiredAmount) ? totalReceivedDec.gte(requiredAmountDec) : totalReceivedDec.gt(0));
  const shortfallDec = Number.isFinite(requiredAmount) ? maxZeroSub(requiredAmountDec, totalReceivedDec) : toDecimal(0);
  // Money alone — `satisfied` can be true on a credit extension while the guest still owes the
  // remainder; `paidInFull` is the fact the promise timer and the settlement ticks care about.
  const paidInFull = Number.isFinite(requiredAmount) ? totalReceivedDec.gte(requiredAmountDec) : totalReceivedDec.gt(0);

  // The guest's stated payment plan (2026-08-07), segment-scoped like the requirement pin.
  // `promiseOverdue` is a read-time fact — the W38 worker traces the lapse, but the desk's red
  // chip must not depend on workers running.
  const plan = resolveAdvancePaymentPlan(folio, entry?.segments?.[0]?.startedAt ?? null);
  const promisedByDate = plan?.promisedBy ? new Date(plan.promisedBy) : null;
  const promiseOverdue =
    !!plan &&
    plan.balanceDueAt === "BEFORE_CHECKIN" &&
    !!promisedByDate &&
    Number.isFinite(promisedByDate.getTime()) &&
    promisedByDate.getTime() <= Date.now() &&
    !paidInFull;

  // Each payment the guest has made so far, oldest first — the installment history the desk
  // shows. Stage tells the story ("2,000 at Set up, 1,500 at Check-in").
  const installments = inPayments
    .slice()
    .sort((a, b) => new Date(a.receivedAt as any).getTime() - new Date(b.receivedAt as any).getTime())
    .map((p) => ({
      id: p.id,
      amount: Number(toDecimal(p.amount as unknown as string).toFixed(2)),
      receivedAt: p.receivedAt instanceof Date ? p.receivedAt.toISOString() : String(p.receivedAt),
      stage: (p as any).stage ?? null,
      notes: (p as any).notes ?? null,
    }));

  // Window facts. `active` = the clock is running (bill went out, money still due, deadline
  // ahead); `overdue` = check-in date passed with the advance still unmet. A satisfied
  // requirement closes the window — nothing to count down.
  const windowOpensAt = dispatchedProforma?.dispatchedAt ?? null;
  const windowDeadline = entry?.checkInDate ?? null;
  const windowOverdue = !!windowOpensAt && !!windowDeadline && !satisfied && windowDeadline.getTime() <= now.getTime();
  const windowActive = !!windowOpensAt && !!windowDeadline && !satisfied && !windowOverdue;

  // Response uses numbers because downstream JSON consumers (frontend, other services) expect
  // number, not Decimal. Precision loss on the SERIALISED value is fine — the GATE decision above
  // was already made in Decimal.
  return {
    satisfied,
    totalReceived: Number(totalReceivedDec.toFixed(2)),
    requiredAmount: Number(requiredAmountDec.toFixed(2)),
    shortfall: Number(shortfallDec.toFixed(2)),
    // Money alone (credit extension NOT counted) — what the settlement surfaces + W38 check.
    paidInFull,
    // What the guest said about paying (FULL / PARTIAL / INSTALLMENTS + when the rest comes),
    // with the read-time promise-overdue fact. Null when nothing recorded this segment.
    paymentPlan: plan ? { ...plan, promiseOverdue } : null,
    // Every payment so far, oldest first — the installment history.
    installments,
    creditExtensionActive,
    ceilingAmount: credit ? Number(credit.ceilingAmount.toString()) : null,
    // Expiry facts so the desk can show the credit-extension countdown honestly. `Expired`
    // distinguishes "there is an extension but its clock ran out" from "no extension".
    creditExtensionExpiresAt: credit?.expiresAt ? credit.expiresAt.toISOString() : null,
    creditExtensionExpired,
    // Where the required amount came from: the operator's per-booking requirement or the
    // configured thresholds. Basis carries the percent/base detail for display.
    requirementSource: operatorRequired != null ? ("OPERATOR" as const) : ("CONFIG" as const),
    requirementBasis: operatorRequired != null ? (folio.advanceRequiredBasis ?? null) : null,
    // The config's own figure, independent of any per-booking pin — always present so the
    // desk can state "hotel minimum unchanged at X" next to a pinned requirement.
    configuredBaseAmount,
    // The payment window: opens at proforma dispatch (p27 blocks money before it), closes at
    // the check-in date. Deadline facts only — the desk renders the countdown from these.
    advanceWindow: {
      opensAt: windowOpensAt ? windowOpensAt.toISOString() : null,
      deadline: windowDeadline ? windowDeadline.toISOString() : null,
      active: windowActive,
      overdue: windowOverdue,
    },
    // Present only when the group boost actually raised the required amount above the base.
    // The frontend can show a hint on the payment card explaining WHY the amount is higher.
    ...(boostApplied ? { groupBoostApplied: boostApplied } : {}),
  };
}

/**
 * Operator-set advance requirement (2026-08-01): pin how much the guest must pay for THIS
 * booking — a flat amount, or a percentage of the operative quotation's total (resolved to an
 * amount HERE, Decimal-safe, so the stored value is unambiguous even if the quote later
 * changes; re-set the requirement to track a renegotiated quote). CLEAR reverts to the
 * configured `advancePayment.thresholds`. The resolved amount overrides config + group boost
 * in the payment evaluation and prints as "Advance due now" on the proforma.
 */
export async function setAdvanceRequirement(
  prisma: PrismaClient,
  input: { entryId: string; folioId: string; mode: "AMOUNT" | "PERCENT" | "CLEAR"; amount?: number; percent?: number },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  const folio = await prisma.folio.findUnique({ where: { id: input.folioId } });
  if (!folio) throw new ValidationError("folioId invalid");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");

  const now = new Date();
  let requiredDec: Prisma.Decimal | null = null;
  let basis: Record<string, unknown> | null = null;

  if (input.mode === "AMOUNT") {
    if (!Number.isFinite(input.amount) || (input.amount ?? 0) <= 0) throw new ValidationError("amount must be positive");
    requiredDec = round2(toDecimal(input.amount!));
    basis = { mode: "AMOUNT", setBy: actor.actorId, setAt: now.toISOString() };
  } else if (input.mode === "PERCENT") {
    if (!Number.isFinite(input.percent) || (input.percent ?? 0) <= 0 || (input.percent ?? 0) > 100) {
      throw new ValidationError("percent must be in (0, 100]");
    }
    // Percentage of the operative quotation's total (the current segment's commercial basis).
    const entry = await prisma.entry.findUnique({
      where: { id: input.entryId },
      include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 }, quotations: true },
    });
    const segmentId = entry?.segments[0]?.id;
    const operative = segmentId ? resolveOperativeQuotation(entry!.quotations, segmentId) : null;
    if (!operative) {
      throw new ValidationError("No quotation to base a percentage on — create the quote first, or set a flat amount");
    }
    const baseTotalDec = toDecimal(operative.totalAmount as unknown as string);
    requiredDec = round2(pctOf(baseTotalDec, input.percent!));
    basis = {
      mode: "PERCENT",
      percent: input.percent,
      baseTotal: Number(baseTotalDec.toFixed(2)),
      quotationId: operative.id,
      setBy: actor.actorId,
      setAt: now.toISOString(),
    };
  }
  // mode === "CLEAR" leaves requiredDec/basis null → falls back to config thresholds.

  // Did the requirement actually change? Drives the proforma re-issue below — setting the
  // same figure again must not spawn a new document version. The prior is the segment-scoped
  // EFFECTIVE requirement (a prior segment's pin counts as "nothing set"), so re-pinning any
  // amount after a re-entry registers as a change and re-issues correctly.
  const currentSegment = await prisma.segment.findFirst({
    where: { entryId: input.entryId },
    orderBy: { segmentNumber: "desc" },
    select: { startedAt: true },
  });
  const priorEffective = resolveOperatorAdvanceRequirement(folio, currentSegment?.startedAt ?? null);
  const priorStr = priorEffective != null ? toDecimal(priorEffective).toFixed(2) : null;
  const nextStr = requiredDec != null ? requiredDec.toFixed(2) : null;
  const requirementChanged = priorStr !== nextStr;

  // Freeze what the outgoing versions LOOKED LIKE before the change lands (2026-08-02,
  // operator ruling): a superseded proforma without a stored artifact recomposes from
  // current data, so old versions silently adopted every later figure. Rendering their PDFs
  // NOW — before the folio update — captures the figures that were actually on the table.
  // Dynamic import: invoice-pdf-service statically imports this module (evaluation +
  // requirement resolver), so a static import back would create a cycle.
  if (requirementChanged) {
    const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");
    await freezeUnrenderedProformasForEntry(prisma, input.entryId, actor.actorId);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.folio.update({
      where: { id: input.folioId },
      data: { advanceRequiredAmount: requiredDec, advanceRequiredBasis: basis === null ? Prisma.DbNull : (basis as any) },
    });

    await tx.traceEvent.create({
      data: {
        eventType: input.mode === "CLEAR" ? "ADVANCE_PAYMENT.REQUIREMENT_CLEARED" : "ADVANCE_PAYMENT.REQUIREMENT_SET",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Folio",
        entityId: input.folioId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId: input.entryId,
        payload: {
          entryId: input.entryId,
          folioId: input.folioId,
          mode: input.mode,
          requiredAmount: requiredDec ? Number(requiredDec.toFixed(2)) : null,
          basis: basis as any,
        },
        createdBy: actor.actorId,
      },
    });

    // ── Class-1 supersession on a changed advance (2026-08-01, operator request) ─────────
    // "Advance due now" is printed on the proforma, so a changed requirement makes the live
    // proformas misstate the deal — shared re-issue helper below (the payment PLAN prints on
    // the proforma too since 2026-08-08 and runs the same machinery).
    const reissued = await reissueProformaTx(
      tx,
      {
        entryId: input.entryId,
        folioId: input.folioId,
        changed: requirementChanged,
        basisWhenChanged: "ADVANCE_REQUIREMENT_CHANGED",
        extraMetadata: { requiredAmount: requiredDec ? Number(requiredDec.toFixed(2)) : null },
        now,
      },
      actor,
    );

    return { folio: updated, reissuedProforma: reissued };
  });
}

/**
 * Supersede every live proforma and mint a fresh DRAFT, inside the caller's transaction —
 * the Class-1 supersession run whenever something the proforma PRINTS has changed: the
 * advance figure (2026-08-01) or the guest's payment plan (2026-08-08). One helper so the
 * two setters cannot drift.
 *
 * Two triggers for a fresh issue:
 *   1. `changed` (operator rulings, unconditional) — every change mints a fresh proforma,
 *      superseding whatever was live: a dispatched issue (the guest's bill now misstates
 *      the deal) AND a never-rendered DRAFT (it recomposes on demand, but the desk treats
 *      each set as a new issue). Setting the SAME value again doesn't spam versions.
 *   2. Post-re-entry restart — NO live proforma exists at all. A re-entry supersedes every
 *      pending proforma (`supersedePendingInvoicesTx`) and the folio singleton survives into
 *      the new segment, so `ensureProvisionalFolio…` never mints a starter again. Without
 *      this branch the S3 flow dead-ends (nothing to dispatch → bill-before-money locks
 *      payments). Fires even when the value is unchanged.
 *
 * Callers that supersede FROZEN artifacts must run `freezeUnrenderedProformasForEntry`
 * BEFORE their transaction (2026-08-02 ruling — old versions retain their figures).
 */
async function reissueProformaTx(
  tx: Prisma.TransactionClient,
  input: {
    entryId: string;
    folioId: string;
    changed: boolean;
    /** metadata.basis + the supersede traces' reason when `changed` fired the re-issue. */
    basisWhenChanged: string;
    /** Extra fields for the fresh DRAFT's metadata (e.g. the new requirement / plan). */
    extraMetadata?: Record<string, unknown>;
    now: Date;
  },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
): Promise<{ newInvoiceId: string; supersededIds: string[]; versionNumber: number } | null> {
  const { entryId, folioId, changed, basisWhenChanged, now } = input;
  const proformas = await tx.invoice.findMany({
    where: { folioId, invoiceType: InvoiceType.PROFORMA },
    orderBy: { versionNumber: "desc" },
  });
  const live = proformas.filter((i) => i.state !== InvoiceState.SUPERSEDED);
  if (!changed && live.length > 0) return null;
  const supersedeLive = changed && live.length > 0;
  const basis = changed ? basisWhenChanged : "REISSUED_AFTER_REENTRY";
  const supersededIds = supersedeLive ? live.map((i) => i.id) : [];
  const nextVersion = proformas.length > 0 ? Math.max(...proformas.map((i) => i.versionNumber ?? 1)) + 1 : 1;
  const newId = await allocateReadableId(tx, "INVOICE" as const, now);
  const created = await tx.invoice.create({
    data: {
      id: newId,
      folioId,
      entryId,
      invoiceType: InvoiceType.PROFORMA,
      state: InvoiceState.DRAFT,
      versionNumber: nextVersion,
      templateKey: (live[0] ?? proformas[0])?.templateKey ?? "proforma-v1",
      issuedAt: now,
      issuedBy: actor.actorId,
      metadata: {
        basis,
        supersedes: supersededIds,
        ...(input.extraMetadata ?? {}),
      },
    },
  });
  if (supersedeLive) {
    await tx.invoice.updateMany({
      where: { id: { in: supersededIds } },
      data: { state: InvoiceState.SUPERSEDED, supersededById: created.id },
    });
    for (const old of live) {
      await tx.traceEvent.create({
        data: {
          eventType: "INVOICE.SUPERSEDED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "Invoice",
          entityId: old.id,
          operation: "UPDATE",
          timestamp: now,
          stageContext: Stage.S3,
          entryId,
          payload: { entryId, invoiceId: old.id, supersededById: created.id, reason: basisWhenChanged },
          createdBy: actor.actorId,
        },
      });
    }
  }
  await tx.traceEvent.create({
    data: {
      eventType: "INVOICE.CREATED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Invoice",
      entityId: created.id,
      operation: "CREATE",
      timestamp: now,
      stageContext: Stage.S3,
      entryId,
      payload: { folioId, invoiceId: created.id, invoiceType: "PROFORMA", basis },
      createdBy: actor.actorId,
    },
  });
  return { newInvoiceId: created.id, supersededIds, versionNumber: nextVersion };
}

/** Stages where the advance can still be planned/collected — S3 (setup) through S6 (check-in);
 *  from S7 the folio is LIVE and money flows through in-stay charges / S8 settlement. */
const ADVANCE_COLLECTION_STAGES: ReadonlySet<Stage> = new Set([Stage.S3, Stage.S4, Stage.S5, Stage.S6]);

/** Mirror of `cancelScheduledAdvancePaymentFollowUpForEntry` for the W38 promise deadline. */
export async function cancelScheduledAdvancePromiseDeadlinesForEntry(
  tx: Prisma.TransactionClient,
  entryId: string,
  cancelledBy: string,
  reason: string,
) {
  const now = new Date();
  const timers = await tx.timerRecord.findMany({
    where: { entryId, timerType: "ADVANCE_PROMISE_DEADLINE_W38", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (timers.length === 0) return { cancelled: 0 } as const;
  const engine = await getTimerEngine();
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy, cancelledReason: reason },
  });
  return { cancelled: timers.length } as const;
}

/**
 * Once the advance is genuinely settled (or FOM explicitly reconciled it), the S5 handoff's
 * "Payment reconciliation" tick should not sit PENDING waiting for someone to notice — flip it
 * COMPLETE with a trace saying why. No-op when the task doesn't exist yet (tasks are seeded at
 * S4 confirmation) or was already worked.
 */
export async function autoCompletePaymentReconciliationTaskTx(
  tx: Prisma.TransactionClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  cause: "ADVANCE_PAID_IN_FULL" | "ADVANCE_RECONCILED",
) {
  const now = new Date();
  const pending = await tx.preArrivalTask.findFirst({
    where: { entryId, taskType: PreArrivalTaskType.PAYMENT_RECONCILIATION, status: TaskStatus.PENDING },
    select: { id: true },
  });
  if (!pending) return { completed: false } as const;
  await tx.preArrivalTask.update({
    where: { id: pending.id },
    data: { status: TaskStatus.COMPLETE, completedAt: now, completedBy: actor.actorId },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "PRE_ARRIVAL_TASK.COMPLETED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "PreArrivalTask",
      entityId: pending.id,
      operation: "UPDATE",
      timestamp: now,
      entryId,
      payload: { entryId, taskType: "PAYMENT_RECONCILIATION", auto: true, cause },
      createdBy: actor.actorId,
    },
  });
  return { completed: true } as const;
}

/**
 * Record what the guest SAID about paying the advance (2026-08-07): FULL (the whole amount at
 * once), PARTIAL (part now, rest later) or INSTALLMENTS (several payments) — and for the
 * non-full plans, WHEN the remainder is coming:
 *
 *  - BEFORE_CHECKIN + a `promisedBy` date → a real W38 deadline timer is armed; if the money
 *    hasn't arrived by then the lapse is traced and the desk shows the promise overdue.
 *  - AT_CHECKIN → no timer. The S5/S6 arrival gates are the enforcement teeth — the plan tells
 *    the desk to collect at that desk, and which credit-extension expiry to suggest.
 *  - AT_CHECKOUT is REFUSED since 2026-08-08 (operator ruling): the advance settles before or
 *    at check-in; money due at check-out is ordinary folio settlement, not an advance plan.
 *    Legacy stored plans keep the value read-side.
 *
 * Since 2026-08-08 the plan is captured BEFORE the proforma goes out and the proforma PRINTS
 * it ("Payment plan: Part now — remainder by …"), so at S3 a plan CHANGE re-issues the
 * proforma exactly like a requirement change does (shared `reissueProformaTx`; the desk
 * re-dispatches, and the bill-before-money guard re-locks payments until it goes out). The
 * canonical case: the PI went out saying "full amount", the guest replies they can't pay full
 * right now — recording the new plan mints the corrected PI to send. At S4–S6 the plan still
 * updates (advisory + W38) but no proforma is re-issued — post-freeze the voucher is the
 * binding document.
 *
 * Advisory, deliberately NOT a gate: the booking still needs the money or an FOM credit
 * extension to pass S5/S6, exactly as before. CLEAR wipes the plan (guest changed their mind).
 * Segment-scoped by `setAt` — a re-entry starts with no plan.
 */
export async function setAdvancePaymentPlan(
  prisma: PrismaClient,
  input: {
    entryId: string;
    folioId: string;
    plan: AdvancePaymentPlanKind | "CLEAR";
    balanceDueAt?: AdvanceBalanceDueAt | null;
    promisedBy?: string | Date | null;
    note?: string | null;
  },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  const folio = await prisma.folio.findUnique({ where: { id: input.folioId } });
  if (!folio) throw new ValidationError("folioId invalid");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");

  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    select: { id: true, status: true, currentStage: true, checkInDate: true },
  });
  if (!entry) throw new ValidationError("entryId invalid");
  if (entry.status !== "ACTIVE") {
    throw new ValidationError("The payment plan can only be recorded on an active booking");
  }
  if (!ADVANCE_COLLECTION_STAGES.has(entry.currentStage)) {
    throw new ValidationError(
      "The advance payment plan applies between setup and check-in (S3–S6) — from the stay onward money flows through the folio",
    );
  }

  const now = new Date();
  let stored: AdvancePaymentPlan | null = null;

  if (input.plan !== "CLEAR") {
    const balanceDueAt = input.balanceDueAt ?? null;
    let promisedByIso: string | null = null;

    // 2026-08-08 operator ruling: the advance settles before or at check-in. See the doc above.
    if (balanceDueAt === "AT_CHECKOUT") {
      throw new ValidationError(
        "The advance is settled before or at check-in — money due at check-out is ordinary folio settlement, not an advance plan",
      );
    }

    if (input.plan === "FULL") {
      if (balanceDueAt || input.promisedBy) {
        throw new ValidationError("A full-payment plan carries no remainder — leave the timing fields empty");
      }
    } else {
      if (!balanceDueAt) {
        throw new ValidationError("Say when the remainder is coming: before check-in, or at check-in");
      }
      if (balanceDueAt === "BEFORE_CHECKIN") {
        if (!input.promisedBy) {
          throw new ValidationError("A before-check-in promise needs the date the guest gave");
        }
        const promised = input.promisedBy instanceof Date ? input.promisedBy : new Date(input.promisedBy);
        if (!Number.isFinite(promised.getTime())) throw new ValidationError("promisedBy is not a valid date");
        if (promised.getTime() <= now.getTime()) {
          throw new ValidationError("The promised date is already in the past — pick a future date");
        }
        // The advance window closes at check-in; a promise beyond it means "before check-in"
        // in name only. Clamp rather than reject — the guest's words were "before check-in".
        // A check-in already in the past makes the whole framing impossible (the clamp would
        // land in the past and the timer would fire immediately) — refuse with the right
        // alternatives instead.
        const checkIn = entry.checkInDate ?? null;
        if (checkIn && checkIn.getTime() <= now.getTime()) {
          throw new ValidationError(
            "Check-in has already arrived — record the remainder as due at the check-in desk instead",
          );
        }
        const clamped = checkIn && promised.getTime() > checkIn.getTime() ? checkIn : promised;
        promisedByIso = clamped.toISOString();
      } else if (input.promisedBy) {
        throw new ValidationError("An at-check-in plan doesn't take a date — the desk itself is the deadline");
      }
    }

    stored = {
      plan: input.plan,
      balanceDueAt,
      promisedBy: promisedByIso,
      note: input.note?.trim() || null,
      setBy: actor.actorId,
      setAt: now.toISOString(),
    };
  }

  // Did the plan MATERIALLY change? The proforma prints plan + timing, so those three fields
  // decide the re-issue; a note-only edit re-saves without minting a new document version.
  // Prior = the segment-scoped EFFECTIVE plan (a prior segment's plan counts as "nothing").
  const currentSegment = await prisma.segment.findFirst({
    where: { entryId: input.entryId },
    orderBy: { segmentNumber: "desc" },
    select: { startedAt: true },
  });
  const prior = resolveAdvancePaymentPlan(folio, currentSegment?.startedAt ?? null);
  const planChanged =
    (prior?.plan ?? null) !== (stored?.plan ?? null) ||
    (prior?.balanceDueAt ?? null) !== (stored?.balanceDueAt ?? null) ||
    (prior?.promisedBy ?? null) !== (stored?.promisedBy ?? null);

  // Re-issue is an S3 concern only: post-freeze the voucher is the binding document, and the
  // p40/p27 proforma gates are S3-scoped — minting proforma versions at S4–S6 would be noise.
  const reissueAtS3 = entry.currentStage === Stage.S3;
  if (reissueAtS3 && planChanged) {
    // Freeze what the outgoing versions LOOKED LIKE before the change lands (2026-08-02 ruling;
    // dynamic import — invoice-pdf-service statically imports this module).
    const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");
    await freezeUnrenderedProformasForEntry(prisma, input.entryId, actor.actorId);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.folio.update({
      where: { id: input.folioId },
      data: { advancePaymentPlan: stored === null ? Prisma.DbNull : (stored as any) },
    });

    // One live promise clock at most: whatever was armed before this plan is superseded by it.
    await cancelScheduledAdvancePromiseDeadlinesForEntry(
      tx,
      input.entryId,
      actor.actorId,
      stored ? "PLAN_REPLACED" : "PLAN_CLEARED",
    );

    if (stored?.balanceDueAt === "BEFORE_CHECKIN" && stored.promisedBy) {
      const firesAt = new Date(stored.promisedBy);
      const timerRecordId = randomUUID();
      const engine = await getTimerEngine();
      const jobId = await engine.schedule(
        "ADVANCE_PROMISE_DEADLINE_W38",
        { entryId: input.entryId, folioId: input.folioId, timerRecordId },
        { startAfter: firesAt },
      );
      await tx.timerRecord.create({
        data: {
          id: timerRecordId,
          entryId: input.entryId,
          entityType: "Folio",
          entityId: input.folioId,
          timerType: "ADVANCE_PROMISE_DEADLINE_W38",
          timerCode: "ADVANCE_PROMISE_DEADLINE_W38",
          stageContext: entry.currentStage,
          firesAt,
          dueAt: firesAt,
          status: "SCHEDULED",
          payload: { entryId: input.entryId, folioId: input.folioId, promisedBy: stored.promisedBy },
          pgBossJobId: jobId,
          createdBy: actor.actorId,
        },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: stored ? "ADVANCE_PAYMENT.PLAN_RECORDED" : "ADVANCE_PAYMENT.PLAN_CLEARED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Folio",
        entityId: input.folioId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        entryId: input.entryId,
        payload: {
          entryId: input.entryId,
          folioId: input.folioId,
          plan: stored?.plan ?? null,
          balanceDueAt: stored?.balanceDueAt ?? null,
          promisedBy: stored?.promisedBy ?? null,
          note: stored?.note ?? null,
        },
        createdBy: actor.actorId,
      },
    });

    // The proforma prints the plan (2026-08-08), so a changed plan re-issues it — same
    // machinery as the requirement change; S3 only (see the doc above).
    const reissued = reissueAtS3
      ? await reissueProformaTx(
          tx,
          {
            entryId: input.entryId,
            folioId: input.folioId,
            changed: planChanged,
            basisWhenChanged: "ADVANCE_PAYMENT_PLAN_CHANGED",
            extraMetadata: {
              paymentPlan: stored?.plan ?? null,
              balanceDueAt: stored?.balanceDueAt ?? null,
              promisedBy: stored?.promisedBy ?? null,
            },
            now,
          },
          actor,
        )
      : null;

    return { folio: updated, plan: stored, reissuedProforma: reissued };
  });
}

export async function evaluateAdvancePaymentCondition(
  prisma: PrismaClient,
  input: { entryId: string; folioId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const thresholds = await requireActiveConfigValue<any>(prisma, "advancePayment.thresholds", { now }).catch(() => {
    throw new MissingConfigurationError("advancePayment.thresholds");
  });
  return computeAdvancePaymentEvaluation(prisma, input, thresholds);
}

/** Reads folio/payments on `tx` (including uncommitted rows) while loading thresholds from the root client. */
export async function evaluateAdvancePaymentConditionTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: { entryId: string; folioId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const thresholds = await requireActiveConfigValue<any>(prisma, "advancePayment.thresholds", { now }).catch(() => {
    throw new MissingConfigurationError("advancePayment.thresholds");
  });
  return computeAdvancePaymentEvaluation(tx, input, thresholds);
}

/** SIG §6.4 — façade name for API / callers. */
export async function getPaymentStatus(prisma: PrismaClient, input: { entryId: string; folioId: string; now?: Date }) {
  return evaluateAdvancePaymentCondition(prisma, input);
}

export async function cancelScheduledAdvancePaymentFollowUpForEntry(
  tx: Prisma.TransactionClient,
  entryId: string,
  cancelledBy: string,
  reason: string,
) {
  const now = new Date();
  const timers = await tx.timerRecord.findMany({
    where: { entryId, timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (timers.length === 0) return { cancelled: 0 } as const;
  const engine = await getTimerEngine();
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy, cancelledReason: reason },
  });
  return { cancelled: timers.length } as const;
}

/**
 * Advisory: given a base tier-derived ceiling amount, return the recommended ceiling to
 * suggest to the approving actor. For group entries (Policy 64 → GROUP_MASTER) the
 * `registry.groupBooking.creditCeilingBoost` policy multiplies the base — a 20-room group
 * needs a proportionally higher ceiling than a single guest. Approvers can still enter any
 * value at `recordCreditExtensionApproval` — this is a suggestion, not a lock.
 */
export async function recommendCreditCeilingForEntry(
  prisma: PrismaClient,
  entryId: string,
  baseCeilingAmount: number,
): Promise<{ recommended: number; boostApplied: { multiplierPercent: number; baseAmount: number } | null }> {
  if (!Number.isFinite(baseCeilingAmount) || baseCeilingAmount <= 0) {
    return { recommended: baseCeilingAmount, boostApplied: null };
  }
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { groupBillingMode: true } });
  if (entry?.groupBillingMode !== "GROUP_MASTER") {
    return { recommended: baseCeilingAmount, boostApplied: null };
  }
  const boostPolicy = await getRegistryPolicy(prisma, "registry.groupBooking.creditCeilingBoost");
  if (!boostPolicy || boostPolicy.enabled === false || typeof boostPolicy.multiplierPercent !== "number") {
    return { recommended: baseCeilingAmount, boostApplied: null };
  }
  const mult = Math.max(0, boostPolicy.multiplierPercent as number) / 100;
  const boosted = baseCeilingAmount * mult;
  if (boosted <= baseCeilingAmount) return { recommended: baseCeilingAmount, boostApplied: null };
  return {
    recommended: boosted,
    boostApplied: { multiplierPercent: boostPolicy.multiplierPercent as number, baseAmount: baseCeilingAmount },
  };
}

export async function recordCreditExtensionApproval(
  prisma: PrismaClient,
  input: {
    entryId: string;
    folioId: string;
    ceilingAmount: number;
    reason: string;
    validForHours?: number | null;
    /** Absolute expiry (2026-08-07) — lets the desk align the extension with the guest's
     *  promise ("covered until the check-in date"). Wins over validForHours when both given. */
    validUntil?: string | Date | null;
  },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  enforceCreditExtensionConstraints({ actorLevel: actor.actorLevel, ceilingAmount: input.ceilingAmount, reason: input.reason });

  const now = new Date();
  // Optional time limit (2026-08-01): the extension satisfies the advance condition only
  // until this instant — enforced at read time in the payment evaluation. Null = open-ended.
  let expiresAt: Date | null = null;
  if (input.validUntil != null) {
    const parsed = input.validUntil instanceof Date ? input.validUntil : new Date(input.validUntil);
    if (!Number.isFinite(parsed.getTime())) throw new ValidationError("validUntil is not a valid date");
    if (parsed.getTime() <= now.getTime()) throw new ValidationError("validUntil is already in the past");
    expiresAt = parsed;
  } else if (input.validForHours != null && Number.isFinite(input.validForHours) && input.validForHours > 0) {
    expiresAt = new Date(now.getTime() + input.validForHours * 3_600_000);
  }

  return prisma.$transaction(async (tx) => {
    // Pre-allocate a readable ID; if upsert hits the update path it's discarded harmlessly.
    const crId = await allocateReadableId(tx, "CREDIT_EXTENSION" as const, now);
    const rec = await tx.creditExtensionCeilingRecord.upsert({
      where: { folioId: input.folioId },
      create: {
        id: crId,
        folioId: input.folioId,
        entryId: input.entryId,
        ceilingAmount: input.ceilingAmount,
        approvedBy: actor.actorId,
        approvedAt: now,
        reason: input.reason.trim(),
        expiresAt,
      },
      update: {
        ceilingAmount: input.ceilingAmount,
        approvedBy: actor.actorId,
        approvedAt: now,
        reason: input.reason.trim(),
        // A re-approval resets the clock (or removes it when no duration is given).
        expiresAt,
      },
    });

    await cancelScheduledAdvancePaymentFollowUpForEntry(tx, input.entryId, actor.actorId, "CREDIT_EXTENSION_APPROVED");

    await tx.traceEvent.create({
      data: {
        eventType: "CREDIT_EXTENSION.APPROVED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "CreditExtensionCeilingRecord",
        entityId: rec.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId: input.entryId,
        payload: {
          entryId: input.entryId,
          folioId: input.folioId,
          ceilingAmount: input.ceilingAmount,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
        createdBy: actor.actorId,
      },
    });

    return rec;
  });
}

export async function markAdvancePaymentReconciled(
  prisma: PrismaClient,
  input: { entryId: string; folioId: string; note?: string },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  const folio = await prisma.folio.findUnique({ where: { id: input.folioId }, include: { payments: true } });
  if (!folio) throw new ValidationError("folioId invalid");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");

  const totalIn = (folio.payments ?? [])
    .filter((p) => p.paymentDirection === PaymentDirection.IN)
    .reduce((sum, p) => sum + Number(p.amount.toString()), 0);
  const billingModel = String((folio as any).billingModel ?? "").trim();
  const isDirectBillLike = billingModel === "DIRECT_BILL" || billingModel === "GOVERNMENT";
  enforceAdvancePaymentReconciliationRequiresPayment({ isDirectBillLike, totalInPayments: totalIn });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.folio.update({
      where: { id: input.folioId },
      data: { advancePaymentReconciliationComplete: true },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "ADVANCE_PAYMENT.RECONCILED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Folio",
        entityId: input.folioId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId: input.entryId,
        payload: { entryId: input.entryId, folioId: input.folioId, note: input.note ?? null, totalReceived: totalIn },
        createdBy: actor.actorId,
      },
    });

    await cancelScheduledAdvancePaymentFollowUpForEntry(tx, input.entryId, actor.actorId, "ADVANCE_PAYMENT_RECONCILED");

    // Reconciling IS the settlement decision — the S5 handoff's "Payment reconciliation" tick
    // must not sit PENDING after it (2026-08-07).
    await autoCompletePaymentReconciliationTaskTx(tx, input.entryId, actor, "ADVANCE_RECONCILED");

    await recomputeFolioOutstandingBalance(tx, input.folioId);

    return updated;
  });
}

