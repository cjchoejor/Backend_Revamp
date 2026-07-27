import type { FolioLineType, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import {
  enforceSplitBillingEditAllowed,
  enforceSplitBillingValueAllowed,
  SPLIT_BILLING_ALLOWED_VALUES,
  type SplitBillingModel,
} from "../../policies/13-billing-model/p32-split-billing-edit-authority.js";

/**
 * Split-billing service (Phase 2 of split-billing, 2026-07-25).
 *
 * Provides three operator-facing operations for adjusting a folio's split-billing config:
 *
 *   1. `updateBillingModelDefaults` — replace the per-line-type default map.
 *      Affects FUTURE line posts only; existing lines are NOT touched.
 *   2. `reassignFolioLineBillingModel` — reassign ONE existing line.
 *   3. `reassignFolioLinesBillingModelBulk` — reassign many lines in one call
 *      (e.g., "agent agreed to cover all F&B → flip all F_AND_B lines").
 *
 * Every write:
 *   - Runs `enforceSplitBillingEditAllowed` (stage + authority gate)
 *   - Runs `enforceSplitBillingValueAllowed` on each new value (only GUEST_PAY, DIRECT_BILL,
 *     GOVERNMENT accepted)
 *   - Writes one `BillingModelTransitionRecord` per affected line (or one folio-level for
 *     defaults update), with `changeSource` distinguishing DEFAULTS_UPDATE / PER_LINE_OVERRIDE
 *   - Runs inside a single Prisma transaction so audit + update commit together
 */

type ActorLevel = "L1" | "L2" | "L3" | "L4" | "SYSTEM";

type Actor = { actorId: string; actorLevel: ActorLevel };

type LineTypeString = FolioLineType;

/** Common fetch helper — pulls the entry + current segment we need for both stage-gate and
 *  segmentId population on the audit rows. */
async function loadFolioContext(prisma: PrismaClient, folioId: string) {
  const folio = await prisma.folio.findUnique({
    where: { id: folioId },
    include: {
      entry: {
        select: {
          id: true,
          currentStage: true,
          segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
        },
      },
    },
  });
  if (!folio) throw new NotFoundError("Folio");
  if (!folio.entry) throw new NotFoundError("Entry");
  const segmentId = folio.entry.segments[0]?.id;
  if (!segmentId) throw new NotFoundError("Segment");
  return { folio, segmentId, currentStage: folio.entry.currentStage };
}

/**
 * Replace the folio's per-line-type default map. Any line-type key can be omitted
 * (partial update), but the value on each present key must be a recognised billing model.
 * Only affects lines posted AFTER this call — existing lines stay assigned.
 */
export async function updateBillingModelDefaults(
  prisma: PrismaClient,
  folioId: string,
  actor: Actor,
  input: { defaults: Partial<Record<LineTypeString, string>>; reason?: string },
) {
  const { folio, segmentId, currentStage } = await loadFolioContext(prisma, folioId);
  enforceSplitBillingEditAllowed({ currentStage, actorLevel: actor.actorLevel });

  // Validate every value in the incoming map. Reject the whole call if any is bad
  // (all-or-nothing to keep the caller's mental model simple).
  const validated: Partial<Record<string, SplitBillingModel>> = {};
  for (const [k, v] of Object.entries(input.defaults ?? {})) {
    if (v == null) continue;
    validated[k] = enforceSplitBillingValueAllowed(v);
  }
  if (Object.keys(validated).length === 0) {
    throw new ValidationError("At least one line-type default must be supplied");
  }

  // Merge into existing map (partial update semantics).
  const existing = (folio.billingModelDefaults ?? {}) as Record<string, string>;
  const merged = { ...existing, ...validated };

  return prisma.$transaction(async (tx) => {
    const updatedFolio = await tx.folio.update({
      where: { id: folioId },
      data: { billingModelDefaults: merged },
    });

    // One audit row summarising the map change. `fromModel`/`toModel` carry the JSON-encoded
    // partial diff so an auditor can see exactly which types moved to which model.
    await tx.billingModelTransitionRecord.create({
      data: {
        folioId,
        segmentId,
        fromModel: JSON.stringify(existing),
        toModel: JSON.stringify(merged),
        createdBy: actor.actorId,
        reason: input.reason?.trim() || null,
        changeSource: "DEFAULTS_UPDATE",
      },
    });

    return updatedFolio;
  });
}

/**
 * Reassign ONE folio line to a different billing model. Writes a `BillingModelTransitionRecord`
 * with `folioLineId` populated so the audit trail shows exactly which line moved when + why.
 */
export async function reassignFolioLineBillingModel(
  prisma: PrismaClient,
  folioId: string,
  lineId: string,
  actor: Actor,
  input: { billingModel: string; reason: string },
) {
  const { segmentId, currentStage } = await loadFolioContext(prisma, folioId);
  enforceSplitBillingEditAllowed({ currentStage, actorLevel: actor.actorLevel });
  const newModel = enforceSplitBillingValueAllowed(input.billingModel);
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("reason is required for per-line reassignment");

  const line = await prisma.folioLine.findUnique({ where: { id: lineId } });
  if (!line) throw new NotFoundError("FolioLine");
  if (line.folioId !== folioId) {
    throw new ValidationError("FolioLine does not belong to this folio");
  }
  if (line.billingModel === newModel) {
    // No-op — return the line unchanged. Silent success is friendlier than an error.
    return line;
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.folioLine.update({
      where: { id: lineId },
      data: { billingModel: newModel },
    });
    await tx.billingModelTransitionRecord.create({
      data: {
        folioId,
        segmentId,
        folioLineId: lineId,
        fromModel: line.billingModel ?? null,
        toModel: newModel,
        createdBy: actor.actorId,
        reason,
        changeSource: "PER_LINE_OVERRIDE",
      },
    });
    return updated;
  });
}

/**
 * Reassign many lines in one call. Every line must belong to this folio; every value must
 * be recognised. Emits one audit row per line (same `changeSource: PER_LINE_OVERRIDE` as
 * the single-line path). Lines already at the target model are skipped silently.
 *
 * Returns `{ reassigned: number, skipped: number }` so the caller can show a toast summary.
 */
export async function reassignFolioLinesBillingModelBulk(
  prisma: PrismaClient,
  folioId: string,
  actor: Actor,
  input: {
    updates: Array<{ folioLineId: string; billingModel: string }>;
    reason: string;
  },
) {
  const { segmentId, currentStage } = await loadFolioContext(prisma, folioId);
  enforceSplitBillingEditAllowed({ currentStage, actorLevel: actor.actorLevel });
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("reason is required for bulk reassignment");
  if (!Array.isArray(input.updates) || input.updates.length === 0) {
    throw new ValidationError("At least one update is required");
  }

  // Validate every value up-front so a bad string aborts before any DB write.
  const validated = input.updates.map((u) => ({
    folioLineId: u.folioLineId,
    billingModel: enforceSplitBillingValueAllowed(u.billingModel),
  }));

  const lines = await prisma.folioLine.findMany({
    where: { id: { in: validated.map((u) => u.folioLineId) } },
  });
  const lineById = new Map(lines.map((l) => [l.id, l]));
  for (const u of validated) {
    const l = lineById.get(u.folioLineId);
    if (!l) throw new NotFoundError(`FolioLine ${u.folioLineId}`);
    if (l.folioId !== folioId) {
      throw new ValidationError(`FolioLine ${u.folioLineId} does not belong to this folio`);
    }
  }

  return prisma.$transaction(async (tx) => {
    let reassigned = 0;
    let skipped = 0;
    for (const u of validated) {
      const line = lineById.get(u.folioLineId)!;
      if (line.billingModel === u.billingModel) {
        skipped += 1;
        continue;
      }
      await tx.folioLine.update({
        where: { id: u.folioLineId },
        data: { billingModel: u.billingModel },
      });
      await tx.billingModelTransitionRecord.create({
        data: {
          folioId,
          segmentId,
          folioLineId: u.folioLineId,
          fromModel: line.billingModel ?? null,
          toModel: u.billingModel,
          createdBy: actor.actorId,
          reason,
          changeSource: "PER_LINE_OVERRIDE",
        },
      });
      reassigned += 1;
    }
    return { reassigned, skipped };
  });
}

/** Re-export so DTOs / routes can validate values against the same allowlist. */
export { SPLIT_BILLING_ALLOWED_VALUES };
