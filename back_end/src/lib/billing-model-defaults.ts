import type { FolioLineType, Prisma } from "@prisma/client";

/**
 * Split-billing default resolver (Phase 1 of the split-billing feature, 2026-07-25).
 *
 * `Folio.billingModel` is a single string; `FolioLine.billingModel` is per-line. When a
 * new line is posted, its `billingModel` is derived from the folio's `billingModelDefaults`
 * map — which maps `FolioLineType` → billing-model string. This lets one booking split its
 * charges (e.g., a travel-agent booking where ROOM_CHARGE goes DIRECT_BILL to the agent
 * while F_AND_B / SERVICE / OTHER go GUEST_PAY to the guest).
 *
 * Order of resolution:
 *   1. `Folio.billingModelDefaults[lineType]` — the explicit per-type override
 *   2. Sensible default derived from the linked party (travel agent / corporate → split map)
 *   3. Fall back to `Folio.billingModel` (single value from S3 fixation) — preserves
 *      pre-Phase-1 behavior when no split map exists
 *   4. Last-resort `"GUEST_PAY"`
 *
 * ## Adding this to a charge-posting site
 *
 * ```ts
 * import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
 *
 * const billingModel = await resolveBillingModelForNewLine(tx, folio.id, "F_AND_B");
 * await tx.folioLine.create({
 *   data: { folioId: folio.id, lineType: "F_AND_B", ..., billingModel },
 * });
 * ```
 */

type TxClient = Prisma.TransactionClient;

/** The canonical set of billing-model values the runtime special-cases. */
export const BILLING_MODEL_GUEST_PAY = "GUEST_PAY";
export const BILLING_MODEL_DIRECT_BILL = "DIRECT_BILL";
export const BILLING_MODEL_GOVERNMENT = "GOVERNMENT";

/**
 * The default split-map used when a folio has NO `billingModelDefaults` set but its parent
 * inquiry is linked to a travel agent or corporate account. Room charges (which include rate,
 * meal plans, extra beds under the current FolioLineType scheme) go to the third-party payer;
 * everything else stays with the guest.
 *
 * When the primary billing model is `GOVERNMENT`, use the same room→DIRECT_BILL-equivalent
 * pattern but with `GOVERNMENT` in the room slot; guest-pay lines stay `GUEST_PAY`.
 */
function agentDefaults(primaryModel: string): Record<FolioLineType, string> {
  return {
    ROOM_CHARGE: primaryModel,
    F_AND_B: BILLING_MODEL_GUEST_PAY,
    SERVICE: BILLING_MODEL_GUEST_PAY,
    OTHER: BILLING_MODEL_GUEST_PAY,
    CREDIT_NOTE: primaryModel,
  };
}

/**
 * Leisure default — no third-party payer. Every line goes to the primary billing model
 * (which is `GUEST_PAY` in the LEISURE source-config case).
 */
function leisureDefaults(primaryModel: string): Record<FolioLineType, string> {
  return {
    ROOM_CHARGE: primaryModel,
    F_AND_B: primaryModel,
    SERVICE: primaryModel,
    OTHER: primaryModel,
    CREDIT_NOTE: primaryModel,
  };
}

/**
 * Resolve which billing model a NEW folio line should carry when posted.
 *
 * Reads `Folio.billingModelDefaults` first; when absent, derives a sensible default from the
 * inquiry's linked agent/corporate. Never throws — falls back to `Folio.billingModel` or
 * `GUEST_PAY` as a last resort.
 */
export async function resolveBillingModelForNewLine(
  tx: TxClient,
  folioId: string,
  lineType: FolioLineType,
): Promise<string> {
  const folio = await tx.folio.findUnique({
    where: { id: folioId },
    select: {
      billingModel: true,
      billingModelDefaults: true,
      entry: {
        select: {
          inquiry: {
            select: { travelAgentId: true, corporateAccountId: true },
          },
        },
      },
    },
  });
  if (!folio) return BILLING_MODEL_GUEST_PAY;

  // 1. Explicit per-type default on the folio wins.
  const defaults = (folio.billingModelDefaults ?? null) as Record<string, string> | null;
  if (defaults && typeof defaults[lineType] === "string" && defaults[lineType].trim().length > 0) {
    return defaults[lineType];
  }

  // 2. Derive from primary model + party linkage.
  const primary = folio.billingModel?.trim() || BILLING_MODEL_GUEST_PAY;
  const hasThirdParty = !!(folio.entry?.inquiry?.travelAgentId || folio.entry?.inquiry?.corporateAccountId);
  const map = hasThirdParty ? agentDefaults(primary) : leisureDefaults(primary);
  return map[lineType] ?? primary;
}

/**
 * Build the default `billingModelDefaults` map for a folio that's just been created / fixated.
 * Called from `s3-reservation-setup-service` right after `Folio.billingModel` is set — persists
 * the initial per-type split so subsequent line posts have a stable map to read from.
 *
 * When the entry has a linked travel agent / corporate account, the map uses the split shape
 * (ROOM_CHARGE→primary, everything else→GUEST_PAY). Otherwise all types → primary.
 */
export async function buildInitialBillingModelDefaults(
  tx: TxClient,
  folioId: string,
  primaryModel: string,
): Promise<Record<FolioLineType, string>> {
  const folio = await tx.folio.findUnique({
    where: { id: folioId },
    select: {
      entry: {
        select: {
          inquiry: {
            select: { travelAgentId: true, corporateAccountId: true },
          },
        },
      },
    },
  });
  const hasThirdParty = !!(folio?.entry?.inquiry?.travelAgentId || folio?.entry?.inquiry?.corporateAccountId);
  return hasThirdParty ? agentDefaults(primaryModel.trim()) : leisureDefaults(primaryModel.trim());
}
