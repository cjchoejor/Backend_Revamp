/**
 * Who pays, changed while the guest is staying (2026-10-26, operator ruling: "change who pays in
 * place at Stay — the desk picks each time whether the charges already on the bill move too").
 *
 * It replaces the Stay → Set up re-entry ("Change billing model"), which sent the booking back to
 * Set up with no way back to Stay: ENT-20260912-0001 sat there 43 days with its guest's charges
 * unsettled. Nothing here leaves the step.
 *
 * What it changes, and what it never does:
 * - The bill's main payer (`Folio.billingModel`) and its per-kind map (`billingModelDefaults`)
 *   are rebuilt exactly as Set up builds them (`buildInitialBillingModelDefaults`), so every
 *   charge posted from now on follows the new payer.
 * - **Charges already on the bill** (the desk's choice):
 *     - moved — each charge takes the payer its kind maps to under the new map; each tax line
 *       (service charge, GST and their corrections) follows the charge it belongs to
 *       (`parentChargeOf`, the ledger view's own rule), never its own kind, so a charge and its
 *       tax can never end up with different payers;
 *     - kept — each stays with the payer it is billed to now.
 * - **Money already received never moves**: a payment stays with whoever paid it. A guest whose
 *   advance covered a room now billed to the company is shown as paid over on their share.
 * - A line or payment with no payer label counts toward the bill's main payer, so changing the
 *   main payer would quietly drag it along. Before the change every such row is pinned to the
 *   payer it counts toward now; only then is anything moved.
 * - Amounts never change — only the payer label of a line (the one field the ledger guard lets a
 *   change write, db.ts). Every moved line gets a BillingModelTransitionRecord, and the change as a
 *   whole one more, with the reason; the whole bill's balance is untouched.
 *
 * Gates: the Stay step, a booking still live, the bill open; the FOM (a group booking moving off
 * an account or a voucher needs the GM, as at Set up); a payer the hotel's settings allow; a reason.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, Stage } from "@prisma/client";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { buildInitialBillingModelDefaults } from "../../lib/billing-model-defaults.js";
import { chargeLineCount, classifyFolioLine, CORRECTION_LINE_PREFIX } from "../../lib/folio-tax-lines.js";
import { parentChargeOf } from "../../lib/folio-ledger-view.js";
import { round2, toDecimal, ZERO } from "../../lib/money.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { enforceBillingModelAllowlistFromConfig } from "../../policies/13-billing-model/p30-billing-model-allowlist-from-config.js";
import { enforceBillingModelMidStayTransitionAllowed } from "../../policies/13-billing-model/p32-billing-model-mid-stay-transition.js";

type ActorLevel = "L1" | "L2" | "L3" | "L4";
type Actor = { actorId: string; actorLevel: ActorLevel };

const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const GROUP_FRIENDLY = new Set(["DIRECT_BILL", "TOUR_OPERATOR_VOUCHER"]);
/** The order the desk offers the payers in. */
const MODEL_ORDER = ["GUEST_PAY", "DIRECT_BILL", "TOUR_OPERATOR_VOUCHER", "GOVERNMENT"];
const byModelOrder = (a: string, b: string) => {
  const ia = MODEL_ORDER.indexOf(a);
  const ib = MODEL_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};

export type PayerChangeInput = { billingModel: string; moveExisting: boolean; reason?: string | null };

async function loadContext(db: PrismaClient | Prisma.TransactionClient, entryId: string) {
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      groupBillingMode: true,
      inquiry: { select: { travelAgentId: true, corporateAccountId: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      folio: {
        select: {
          id: true,
          state: true,
          billingModel: true,
          billingModelDefaults: true,
          lines: {
            select: {
              id: true,
              lineType: true,
              description: true,
              amount: true,
              chargeDate: true,
              postedAt: true,
              createdAt: true,
              nightAuditRecordId: true,
              roomId: true,
              billingModel: true,
            },
          },
          payments: { select: { id: true, amount: true, paymentDirection: true, billingModel: true } },
        },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

type Ctx = Awaited<ReturnType<typeof loadContext>>;
type Line = NonNullable<Ctx["folio"]>["lines"][number];

/** The payers the hotel's settings allow (`billingModel.availablePerSource`, as at Set up). */
async function allowedPayers(db: PrismaClient | Prisma.TransactionClient): Promise<string[]> {
  const cfg = await requireActiveConfigValue<Record<string, string[]>>(db as PrismaClient, "billingModel.availablePerSource").catch(
    () => ({}) as Record<string, string[]>,
  );
  const flat = Array.from(new Set(Object.values(cfg ?? {}).flat().map((v) => String(v).trim()).filter(Boolean)));
  return flat.sort(byModelOrder);
}

/** Which payer each line is billed to after the change — the whole plan, nothing written. */
function planLineModels(lines: Line[], oldPrimary: string, newMap: Record<string, string>, newPrimary: string, moveExisting: boolean) {
  const current = (l: Line) => l.billingModel?.trim() || oldPrimary;
  if (!moveExisting) return new Map(lines.map((l) => [l.id, current(l)]));
  const charges = lines
    .filter((l) => classifyFolioLine(l) === "CHARGE")
    .map((l) => ({ line: l, isCorrection: (l.description ?? "").startsWith(CORRECTION_LINE_PREFIX) }));
  const forCharge = (l: Line) => newMap[l.lineType] ?? newPrimary;
  const out = new Map<string, string>();
  for (const c of charges) out.set(c.line.id, forCharge(c.line));
  for (const l of lines) {
    if (out.has(l.id)) continue;
    const kind = classifyFolioLine(l);
    if (kind === "LEGACY_COMBINED_TAX") {
      // The imported room charge's tax — it goes where room nights go.
      out.set(l.id, newMap.ROOM_CHARGE ?? newPrimary);
      continue;
    }
    const parent = parentChargeOf(l, charges);
    out.set(l.id, parent ? forCharge(parent.line) : l.nightAuditRecordId ? (newMap.ROOM_CHARGE ?? newPrimary) : forCharge(l));
  }
  return out;
}

/** What each payer owes — charges minus money in plus money out — under a given attribution. */
function owedByPayer(ctx: Ctx, lineModel: (l: Line) => string, paymentPrimary: string) {
  const folio = ctx.folio!;
  const by = new Map<string, Prisma.Decimal>();
  const add = (k: string, v: Prisma.Decimal) => by.set(k, (by.get(k) ?? ZERO).add(v));
  for (const l of folio.lines) add(lineModel(l), toDecimal(l.amount));
  for (const p of folio.payments) {
    const k = p.billingModel?.trim() || paymentPrimary;
    add(k, p.paymentDirection === "OUT" ? toDecimal(p.amount) : toDecimal(p.amount).neg());
  }
  return by;
}

function gate(ctx: Ctx, actor: Actor) {
  enforceEntryNotSealedForWorkingAction({ status: ctx.status });
  if (ctx.currentStage !== Stage.S7) {
    throw new ValidationError("Who pays is changed while the guest is staying — this booking is not on the Stay step.");
  }
  if (!ctx.folio) throw new ValidationError("There is no bill on this booking.");
  if (ctx.folio.state !== FolioState.LIVE) throw new ValidationError("Who pays can be changed only while the bill is open.");
  if ((RANK[actor.actorLevel] ?? 0) < 2) throw new AuthorizationError("Changing who pays needs the FOM.");
  // Policy 32: governed by authority; never at check-out or after (enforced again here).
  enforceBillingModelMidStayTransitionAllowed({ currentStage: ctx.currentStage, hasAuthority: true });
}

async function plan(db: PrismaClient | Prisma.TransactionClient, ctx: Ctx, actor: Actor, input: PayerChangeInput) {
  gate(ctx, actor);
  const folio = ctx.folio!;
  const to = input.billingModel?.trim();
  if (!to) throw new ValidationError("Choose who pays.");
  const allowed = await allowedPayers(db);
  enforceBillingModelAllowlistFromConfig({ billingModel: to, allowedFlattened: allowed });
  if (ctx.groupBillingMode === "GROUP_MASTER" && !GROUP_FRIENDLY.has(to) && (RANK[actor.actorLevel] ?? 0) < 3) {
    throw new AuthorizationError("This is a group booking — moving it off the account or the voucher needs the GM.");
  }
  const from = folio.billingModel?.trim() || "GUEST_PAY";
  const newMap = (await buildInitialBillingModelDefaults(db as Prisma.TransactionClient, folio.id, to)) as Record<string, string>;
  const lineModels = planLineModels(folio.lines, from, newMap, to, input.moveExisting);
  const moves = folio.lines
    .map((l) => ({ line: l, from: l.billingModel?.trim() || from, to: lineModels.get(l.id)! }))
    .filter((m) => m.from !== m.to);
  // The same payer again with nothing to move changes nothing (re-picking it would only rewrite
  // the per-kind map to the one Set up builds for it).
  if (to === from && moves.length === 0) {
    throw new ValidationError("Nothing would change — the bill is already billed this way.");
  }
  const before = owedByPayer(ctx, (l) => l.billingModel?.trim() || from, from);
  const after = owedByPayer(ctx, (l) => lineModels.get(l.id)!, from);
  const payers = Array.from(new Set([...before.keys(), ...after.keys()])).sort(byModelOrder);
  const pinLines = folio.lines.filter((l) => !l.billingModel?.trim() && !moves.some((m) => m.line.id === l.id));
  const pinPayments = folio.payments.filter((p) => !p.billingModel?.trim());
  return {
    from,
    to,
    newMap,
    moves,
    pinLines,
    pinPayments,
    moveExisting: input.moveExisting,
    byPayer: payers.map((k) => ({
      billingModel: k,
      before: round2(before.get(k) ?? ZERO).toFixed(2),
      after: round2(after.get(k) ?? ZERO).toFixed(2),
    })),
    // Charges, not ledger lines — a charge's service charge and GST move with it (2026-10-30).
    linesOnBill: chargeLineCount(folio.lines),
    chargesMoving: chargeLineCount(moves.map((m) => m.line)),
    allowed,
  };
}

/** The payers offered, what the bill is billed to now, and the per-kind map — nothing written. */
export async function readPayer(prisma: PrismaClient, entryId: string) {
  const ctx = await loadContext(prisma, entryId);
  const folio = ctx.folio;
  return {
    current: folio?.billingModel ?? null,
    map: (folio?.billingModelDefaults ?? null) as Record<string, string> | null,
    allowed: await allowedPayers(prisma),
    linesOnBill: folio ? chargeLineCount(folio.lines) : 0,
    canChange: !!folio && folio.state === FolioState.LIVE && ctx.currentStage === Stage.S7 && ctx.status === "ACTIVE",
  };
}

export async function previewPayerChange(prisma: PrismaClient, entryId: string, actor: Actor, input: PayerChangeInput) {
  const ctx = await loadContext(prisma, entryId);
  const p = await plan(prisma, ctx, actor, input);
  return {
    from: p.from,
    to: p.to,
    moveExisting: p.moveExisting,
    newMap: p.newMap,
    linesMoving: p.chargesMoving,
    linesOnBill: p.linesOnBill,
    byPayer: p.byPayer,
  };
}

export async function changePayerInStay(prisma: PrismaClient, entryId: string, actor: Actor, input: PayerChangeInput) {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why who pays is changing.");
  return prisma.$transaction(async (tx) => {
    const ctx = await loadContext(tx, entryId);
    const p = await plan(tx, ctx, actor, input);
    const folio = ctx.folio!;
    const segmentId = ctx.segments[0]?.id;
    if (!segmentId) throw new ValidationError("The booking has no pass on record.");
    const now = new Date();

    // 1. Pin every unlabelled row to the payer it counts toward NOW, so moving the main payer
    //    drags nothing along. Lines that are about to move are written once, below, instead.
    for (const l of p.pinLines) await tx.folioLine.update({ where: { id: l.id }, data: { billingModel: p.from } });
    if (p.pinPayments.length) {
      await tx.paymentRecord.updateMany({ where: { id: { in: p.pinPayments.map((x) => x.id) } }, data: { billingModel: p.from } });
    }

    // 2. Move the charges the desk asked to move, each with its own audit row.
    for (const m of p.moves) {
      await tx.folioLine.update({ where: { id: m.line.id }, data: { billingModel: m.to } });
      await tx.billingModelTransitionRecord.create({
        data: {
          folioId: folio.id,
          segmentId,
          folioLineId: m.line.id,
          fromModel: m.from,
          toModel: m.to,
          createdBy: actor.actorId,
          reason,
          changeSource: "MID_STAY_CHANGE",
        },
      });
    }

    // 3. The bill's own payer and its map — what every new charge follows.
    await tx.folio.update({ where: { id: folio.id }, data: { billingModel: p.to, billingModelDefaults: p.newMap } });
    await tx.billingModelTransitionRecord.create({
      data: {
        folioId: folio.id,
        segmentId,
        fromModel: p.from,
        toModel: p.to,
        createdBy: actor.actorId,
        reason,
        changeSource: "MID_STAY_CHANGE",
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "FOLIO.PAYER_CHANGED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as never,
        entityType: "Folio",
        entityId: folio.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        entryId,
        payload: {
          from: p.from,
          to: p.to,
          moveExisting: p.moveExisting,
          linesMoved: p.chargesMoving,
          linesPinned: p.pinLines.length,
          paymentsPinned: p.pinPayments.length,
          byPayer: p.byPayer,
          newMap: p.newMap,
          reason,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });

    return { from: p.from, to: p.to, linesMoved: p.chargesMoving, byPayer: p.byPayer };
  });
}
