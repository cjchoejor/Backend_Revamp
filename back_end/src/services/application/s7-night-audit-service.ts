import type { Prisma, PrismaClient } from "@prisma/client";
import { enforceNightAuditOperatingDateEnded } from "../../policies/24-night-audit/p61-night-audit-complete-before-s7-to-s8.js";
import { effectiveCheckOutDate, hotelTodayUtc } from "../../lib/stay-dates.js";
import { FolioLineType, NightAuditAnomalyType, NightAuditRunStatus, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { randomUUID } from "node:crypto";
import { recalculateNextDayTimers } from "../infrastructure/next-day-timer-service.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { maybePromptInterimPaymentTx } from "../domain/interim-payment-service.js";
import { enforceFolioLiveForNightAuditProcessing } from "../../policies/13-billing-model/p31-folio-live-charge-and-night-audit-context.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { maybeWriteCreditCeilingEvents } from "../domain/s7-folio-lines-service.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { mulMoney, round2, toDecimal, ZERO } from "../../lib/money.js";
import { gstLineDescription, serviceChargeLineDescription } from "../../lib/folio-tax-lines.js";

function operatingDateUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

export async function runNightAudit(prisma: PrismaClient, actorId: string, input: { operatingDate: string }) {
  if (!input.operatingDate?.trim()) throw new ValidationError("operatingDate is required");
  const d = new Date(input.operatingDate);
  if (Number.isNaN(d.getTime())) throw new ValidationError("operatingDate must be a valid ISO date");
  const operatingDate = operatingDateUtc(d);

  // Policy 61 (2026-08-22): only a night that has ENDED on the hotel calendar is auditable. The
  // desk used "run it for today" to audit the final night in the morning and check a guest out a
  // day early through the standard route; and because this record is hotel-wide and the rerun
  // below is idempotent, the real nightly run then posted nothing for everyone else that night.
  enforceNightAuditOperatingDateEnded({ operatingDate, hotelToday: hotelTodayUtc() });

  const existing = await prisma.nightAuditRecord.findUnique({ where: { operatingDate } });
  if (existing) {
    // idempotent rerun: do not create additional folio lines
    return existing;
  }

  const expected = (await requireActiveConfigValue<{ amount?: number; currency?: string } | undefined>(prisma, "nightAudit.expectedDailyFAndBCharge")) ?? {};
  const expectedAmount = typeof expected.amount === "number" ? expected.amount : 0;
  // Service charge + GST companion lines (2026-08-18): the per-room ROOM_CHARGE is the NET
  // per-night figure (`frozenSubtotal` / nights, or the net `frozenRate`), so on its own the
  // folio under-billed every stay by SC + GST on the rooms while the quotation, the S8 final
  // invoice and every guest-facing email carried them — the S8/S9 figures could not agree.
  // The audit now posts the same two companions `postCharge` posts for a manual charge, so
  // the ledger's room bucket equals the room's frozen tax-inclusive total. Same rates, same
  // compound rule (GST on net + service charge), same descriptions.
  const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);

  const entries = await prisma.entry.findMany({
    where: { currentStage: Stage.S7, status: "ACTIVE" },
    include: {
      reservation: true,
      folio: true,
      // Phase C (2026-07-27): include room assignments so we can post per-room charges
      // using each assignment's frozen composition subtotal. Fall back to reservation
      // frozenRate for assignments with no composition (pre-Phase-A rows).
      roomAssignments: {
        include: { room: { select: { roomNumber: true } } },
      },
    },
  });

  // Pre-compute processing decisions outside transaction so the NightAuditRecord can be created in its final (immutable) form.
  const notProcessed: string[] = [];
  type PerRoomPost = {
    assignmentId: string;
    roomId: string;
    roomNumber: string;
    amount: number;
    /** Description string used for both display and idempotency (per-room lookup). */
    description: string;
    /** The room's own tax toggles from its composition (S2 negotiation) — default apply. */
    serviceChargeApplies: boolean;
    gstApplies: boolean;
  };
  const plan: Array<{
    entryId: string;
    folioId: string;
    /** One per room active on operatingDate. Empty when no assignments cover this date. */
    perRoomPosts: PerRoomPost[];
    shouldWriteFnbMissingAnomaly: boolean;
    ceiling: Prisma.Decimal | null;
  }> = [];

  for (const entry of entries) {
    try {
      if (!entry.folio) throw new NotFoundError("Folio");
      enforceFolioLiveForNightAuditProcessing({ folioState: entry.folio.state });

      // Assignments active on operatingDate: startDate <= operatingDate < endDate.
      // Assignments with NULL startDate (legacy whole-stay) are active for every date the
      // entry is in S7 — same behaviour as before.
      const opTime = operatingDate.getTime();
      // A room charge for a night outside the ENTRY's own stay window is always wrong —
      // found live 2026-08-24: a catch-up audit for a past date posted room charges onto a
      // stay that began days later, because its extension-run assignment row carries a null
      // startDate, which the legacy whole-stay rule below reads as "active on every date".
      // The stay window clamps first; the per-row ranges refine within it.
      const stayStart = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null;
      const stayEnd = effectiveCheckOutDate(entry);
      const withinStay =
        (stayStart == null || operatingDateUtc(stayStart).getTime() <= opTime) &&
        (stayEnd == null || opTime < operatingDateUtc(stayEnd).getTime());
      const activeAssignments = !withinStay
        ? []
        : (entry.roomAssignments ?? []).filter((a) => {
            if (a.startDate == null || a.endDate == null) return true; // legacy whole-stay
            return a.startDate.getTime() <= opTime && opTime < a.endDate.getTime();
          });

      // Build per-room post plan. For each active assignment:
      //   - Preferred: use its `frozenSubtotal` (stay-total from composition) divided by
      //     the assignment's night count → per-night amount for THIS room.
      //   - Fall back to reservation.frozenRate when composition wasn't populated
      //     (single-room legacy bookings pre-Phase-A).
      const fallbackRate = num(entry.reservation?.frozenRate ?? null);
      const perRoomPostCandidates: PerRoomPost[] = [];
      for (const a of activeAssignments) {
        const roomNumber = a.room.roomNumber ?? a.roomId.slice(0, 6);
        let amount = fallbackRate;
        if (a.frozenSubtotal != null && a.startDate && a.endDate) {
          const totalNights = Math.max(
            1,
            Math.round((a.endDate.getTime() - a.startDate.getTime()) / 86_400_000),
          );
          amount = num(a.frozenSubtotal) / totalNights;
        }
        perRoomPostCandidates.push({
          assignmentId: a.id,
          roomId: a.roomId,
          roomNumber,
          amount,
          description: `Night audit room charge · Room ${roomNumber}`,
          // An FOC room prices to 0 already; a room negotiated SC- or GST-exempt at S2 keeps
          // that exemption on the ledger, exactly as its frozenTotal was computed.
          serviceChargeApplies: a.isFoc ? false : a.serviceChargeApplies !== false,
          gstApplies: a.isFoc ? false : a.gstApplies !== false,
        });
      }

      // Idempotency: skip any per-room post whose (folioId, description, chargeDate) already exists.
      // Uses `description` as the discriminator since FolioLine has no roomId column.
      const perRoomPosts: PerRoomPost[] = [];
      for (const p of perRoomPostCandidates) {
        const already = await prisma.folioLine.findFirst({
          where: {
            folioId: entry.folio.id,
            lineType: FolioLineType.ROOM_CHARGE,
            chargeDate: operatingDate,
            description: p.description,
          },
        });
        if (!already) perRoomPosts.push(p);
      }

      // No assignments today (pre-check-in or checkout complete) → nothing to post; but the
      // entry itself is still "processed" as long as the folio is LIVE.
      const expectsFnb = expectedAmount > 0 && (entry.reservation?.frozenInclusions as Record<string, unknown> | null | undefined)?.dailyFAndBExpected === true;
      const hasFnb = expectsFnb
        ? await prisma.folioLine.findFirst({ where: { folioId: entry.folio.id, lineType: FolioLineType.F_AND_B, chargeDate: operatingDate } })
        : null;
      const shouldWriteFnbMissingAnomaly = expectsFnb && !hasFnb;

      plan.push({
        entryId: entry.id,
        folioId: entry.folio.id,
        perRoomPosts,
        shouldWriteFnbMissingAnomaly,
        // SIG-S7 Policy 45 — carried so the post-charge ceiling re-check below still runs.
        ceiling: entry.reservation?.creditCeilingIfExtended ?? null,
      });
    } catch {
      notProcessed.push(entry.id);
    }
  }

  const processedCount = plan.length;

  await prisma.$transaction(async (tx) => {
    const recordId = await allocateReadableId(tx, "NIGHT_AUDIT" as const);
    await tx.nightAuditRecord.create({
      data: {
        id: recordId,
        operatingDate,
        runStatus: notProcessed.length === 0 ? NightAuditRunStatus.COMPLETE : NightAuditRunStatus.PARTIAL,
        entriesProcessedCount: processedCount,
        entriesNotProcessed: notProcessed,
        createdBy: actorId,
      },
    });

    for (const p of plan) {
      // Post one FolioLine per active room assignment (Phase C, 2026-07-27). When no
      // assignments are active on operatingDate (pre-check-in / post-checkout / all rooms
      // already posted today), this loop is a no-op.
      if (p.perRoomPosts.length > 0) {
        // Split billing: room charges inherit the folio's per-line-type default. One resolve
        // per folio — every room line on this folio settles under the same model.
        const billingModel = await resolveBillingModelForNewLine(tx, p.folioId, FolioLineType.ROOM_CHARGE);
        for (const post of p.perRoomPosts) {
          // Decimal-safe: the stored room amount and the base the tax is computed on are the
          // same rounded figure (a float per-night split would otherwise be rounded by the
          // column and taxed on the unrounded value).
          const roomAmount = round2(toDecimal(post.amount));
          await tx.folioLine.create({
            data: {
              folioId: p.folioId,
              lineType: FolioLineType.ROOM_CHARGE,
              description: post.description,
              amount: roomAmount,
              currency: "BTN",
              chargeDate: operatingDate,
              stage: Stage.S7,
              postedBy: actorId,
              nightAuditRecordId: recordId,
              billingModel,
              // Per-room folio attribution (2026-08-14) — the room this night's charge is for.
              roomId: post.roomId,
            },
          });
          if (roomAmount.gt(0)) {
            // Same companion pair `postCharge` writes, stamped with the audit record so the
            // invoice can pair them with their room line. Service charge first, then GST on
            // (net + service charge) — the hotel-wide compound rule.
            const serviceCharge =
              post.serviceChargeApplies && serviceChargeRate > 0
                ? round2(mulMoney(roomAmount, serviceChargeRate))
                : ZERO;
            if (serviceCharge.gt(0)) {
              await tx.folioLine.create({
                data: {
                  folioId: p.folioId,
                  lineType: FolioLineType.SERVICE,
                  description: serviceChargeLineDescription(serviceChargeRate, post.description),
                  amount: serviceCharge,
                  currency: "BTN",
                  chargeDate: operatingDate,
                  stage: Stage.S7,
                  postedBy: actorId,
                  nightAuditRecordId: recordId,
                  billingModel,
                  roomId: post.roomId,
                },
              });
            }
            const gst =
              post.gstApplies && gstRate > 0 ? round2(mulMoney(roomAmount.add(serviceCharge), gstRate)) : ZERO;
            if (gst.gt(0)) {
              await tx.folioLine.create({
                data: {
                  folioId: p.folioId,
                  lineType: FolioLineType.OTHER,
                  description: gstLineDescription(gstRate, post.description),
                  amount: gst,
                  currency: "BTN",
                  chargeDate: operatingDate,
                  stage: Stage.S7,
                  postedBy: actorId,
                  nightAuditRecordId: recordId,
                  billingModel,
                  roomId: post.roomId,
                },
              });
            }
          }
        }
        await recomputeFolioOutstandingBalance(tx, p.folioId);
        // SIG-S7 Policy 45 — the credit ceiling must be evaluated "per night audit cycle", not
        // only at point-of-service postCharge. The room charge just raised the outstanding balance,
        // so re-check the tier thresholds and emit CreditCeilingThresholdEvent (+ W12) on crossing.
        if (p.ceiling != null) {
          const updatedFolio = await tx.folio.findUniqueOrThrow({ where: { id: p.folioId } });
          await maybeWriteCreditCeilingEvents(tx, {
            entryId: p.entryId,
            folioId: p.folioId,
            ceilingAmount: p.ceiling,
            outstandingBalance: updatedFolio.outstandingBalance,
            actorId,
          });
        }
      }
      // Long stays (2026-08-21, operator ruling): every `interimPayment.schedule.everyNights`
      // nights slept, raise an "interim payment due" prompt on the Stay step — the forgetting-
      // proof default; the desk can always ask earlier by hand. Best-effort: a prompt that
      // can't be written must not fail the audit.
      await maybePromptInterimPaymentTx(tx, { entryId: p.entryId, folioId: p.folioId, operatingDate, actorId }).catch(() => {});
      if (p.shouldWriteFnbMissingAnomaly) {
        await tx.nightAuditAnomaly.create({
          data: {
            nightAuditRecordId: recordId,
            entryId: p.entryId,
            anomalyType: NightAuditAnomalyType.MISSING_EXPECTED_CHARGE,
            description: "Expected daily F&B charge missing for operating date",
          },
        });
      }
    }

    // AC-S7-06: PARTIAL run escalates to FOM (modelled as an immutable TraceEvent).
    if (notProcessed.length > 0) {
      await (tx as any).traceEvent.create({
        data: {
          eventType: "NIGHT_AUDIT.PARTIAL_FOM_ESCALATED",
          actorId: "SYSTEM",
          actorLevel: "SYSTEM",
          entityType: "NightAuditRecord",
          entityId: recordId,
          operation: "ALERT",
          timestamp: new Date(),
          stageContext: Stage.S7,
          inquiryId: null,
          entryId: null,
          payload: { operatingDate: operatingDate.toISOString(), entriesNotProcessed: notProcessed },
          createdBy: "SYSTEM",
        },
      });
    }
  });

  // AC-S7-07: after COMPLETE run, next-day timers are recalculated.
  if (notProcessed.length === 0) {
    await recalculateNextDayTimers(prisma, "SYSTEM", { operatingDate });
  }

  return prisma.nightAuditRecord.findUniqueOrThrow({ where: { operatingDate } });
}

/** GET snapshot for an operating date (UTC calendar day). */
export async function getNightAuditRecordByOperatingDate(prisma: PrismaClient, operatingDateIsoDay: string) {
  const d = new Date(operatingDateIsoDay);
  if (Number.isNaN(d.getTime())) throw new ValidationError("operatingDate must be a valid YYYY-MM-DD");
  const operatingDate = operatingDateUtc(d);
  const rec = await prisma.nightAuditRecord.findUnique({
    where: { operatingDate },
    include: { anomalies: true, folioLines: { take: 500, orderBy: { postedAt: "desc" } } },
  });
  if (!rec) throw new NotFoundError("NightAuditRecord");
  return rec;
}

