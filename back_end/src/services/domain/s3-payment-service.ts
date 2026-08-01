import type { PrismaClient } from "@prisma/client";
import { InvoiceState, InvoiceType, PaymentDirection, Prisma, Stage } from "@prisma/client";
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
    // "Advance due now" is printed on the proforma, so a changed requirement makes a FROZEN
    // proforma (PDF rendered and/or dispatched) misstate the deal. Those get superseded —
    // kept as read-only history with `supersededById` pointing at a fresh DRAFT that prints
    // the new figures (fresh INV number, versionNumber+1; the desk re-dispatches it, and the
    // bill-before-money guard re-locks payments until it goes out). A never-rendered DRAFT is
    // NOT superseded: nothing frozen exists yet — its preview/PDF composes the new figures on
    // demand, and re-issuing would only mint noise versions.
    let reissued: { newInvoiceId: string; supersededIds: string[]; versionNumber: number } | null = null;
    const proformas = await tx.invoice.findMany({
      where: { folioId: input.folioId, invoiceType: InvoiceType.PROFORMA },
      orderBy: { versionNumber: "desc" },
    });
    const live = proformas.filter((i) => i.state !== InvoiceState.SUPERSEDED);
    // Two triggers for a fresh issue:
    //   1. The requirement CHANGED (2026-08-02 operator ruling: unconditional) — "Set
    //      requirement" mints a fresh proforma every time the figure changes, superseding
    //      whatever was live: a dispatched issue (the guest's bill now misstates the deal)
    //      AND a never-rendered DRAFT (previously kept since it recomposes on demand, but
    //      the desk treats each set as a new issue). Setting the SAME figure again still
    //      doesn't spam versions.
    //   2. Post-re-entry restart — NO live proforma exists at all. A re-entry supersedes
    //      every pending proforma (`supersedePendingInvoicesTx`) and the folio singleton
    //      survives into the new segment, so `ensureProvisionalFolio…` never mints a starter
    //      again. Without this branch, setting the advance in the new segment left nothing
    //      to dispatch and the bill-before-money guard dead-ended the whole S3 flow. Fires
    //      even when the figure is unchanged (the folio remembers the old segment's pin).
    const supersedeLive = requirementChanged && live.length > 0;
    if (requirementChanged || live.length === 0) {
      const basis = requirementChanged ? "ADVANCE_REQUIREMENT_CHANGED" : "REISSUED_AFTER_REENTRY";
      const supersededIds = supersedeLive ? live.map((i) => i.id) : [];
      const nextVersion = proformas.length > 0 ? Math.max(...proformas.map((i) => i.versionNumber ?? 1)) + 1 : 1;
      const newId = await allocateReadableId(tx, "INVOICE" as const, now);
      const created = await tx.invoice.create({
        data: {
          id: newId,
          folioId: input.folioId,
          entryId: input.entryId,
          invoiceType: InvoiceType.PROFORMA,
          state: InvoiceState.DRAFT,
          versionNumber: nextVersion,
          templateKey: (live[0] ?? proformas[0])?.templateKey ?? "proforma-v1",
          issuedAt: now,
          issuedBy: actor.actorId,
          metadata: {
            basis,
            supersedes: supersededIds,
            requiredAmount: requiredDec ? Number(requiredDec.toFixed(2)) : null,
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
              entryId: input.entryId,
              payload: { entryId: input.entryId, invoiceId: old.id, supersededById: created.id, reason: "ADVANCE_REQUIREMENT_CHANGED" },
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
          entryId: input.entryId,
          payload: { folioId: input.folioId, invoiceId: created.id, invoiceType: "PROFORMA", basis },
          createdBy: actor.actorId,
        },
      });
      reissued = { newInvoiceId: created.id, supersededIds, versionNumber: nextVersion };
    }

    return { folio: updated, reissuedProforma: reissued };
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
  input: { entryId: string; folioId: string; ceilingAmount: number; reason: string; validForHours?: number | null },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  enforceCreditExtensionConstraints({ actorLevel: actor.actorLevel, ceilingAmount: input.ceilingAmount, reason: input.reason });

  const now = new Date();
  // Optional time limit (2026-08-01): the extension satisfies the advance condition only
  // until this instant — enforced at read time in the payment evaluation. Null = open-ended.
  const expiresAt =
    input.validForHours != null && Number.isFinite(input.validForHours) && input.validForHours > 0
      ? new Date(now.getTime() + input.validForHours * 3_600_000)
      : null;

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

    await recomputeFolioOutstandingBalance(tx, input.folioId);

    return updated;
  });
}

