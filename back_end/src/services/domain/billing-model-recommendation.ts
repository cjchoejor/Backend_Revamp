/**
 * What billing model should S3 pre-select, and why.
 *
 * WHY THIS IS BACKEND (2026-08-04)
 * --------------------------------
 * The desk previously hardcoded `GUEST_PAY` as the initial value of the S3 picker. That is a
 * business rule — who settles the bill — living in one UI, which the second frontend would have
 * had to reimplement and could have disagreed on. It belongs here, returned as data.
 *
 * PRECEDENCE: who is paying beats how many people are staying.
 *
 *   1. Travel agent attached  -> TOUR_OPERATOR_VOUCHER
 *   2. Corporate attached     -> DIRECT_BILL
 *   3. No party, group-sized  -> DIRECT_BILL
 *   4. Otherwise              -> GUEST_PAY
 *
 * Group detection (Policy 64) is a pure head count and does NOT consider the party, so an agent
 * booking of 18 guests is both GROUP_MASTER and agent-linked. Checking the party first means
 * that booking is recommended a voucher — the agent is settling it — while remaining
 * GROUP_MASTER for everything that genuinely depends on size: per-room check-in and checkout,
 * group invoicing, the advance-payment boost and the credit-ceiling boost. Deliberately NOT
 * solved by excluding agent bookings from group detection, which would switch all of that off
 * for the bookings that need it most.
 *
 * This is a RECOMMENDATION. The operator may choose anything the `billingModel.availablePerSource`
 * allowlist permits; `ensureProvisionalFolioAndBillingModel` remains the authority on what is
 * accepted, and the L3 gate on moving a group off a group-friendly model still applies.
 */
import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

export type BillingModelRecommendation = {
  /** Pre-select this in the picker. */
  recommended: string;
  /** One line the desk can show so the operator understands the suggestion. */
  reason: string;
  /** Everything the config currently permits — the picker should offer only these. */
  allowed: string[];
  /** Context behind the call, for display and for debugging a surprising suggestion. */
  basis: {
    travelAgentName: string | null;
    corporateAccountName: string | null;
    isGroup: boolean;
    guestCount: number | null;
  };
};

export async function recommendBillingModelForEntry(
  prisma: PrismaClient,
  entryId: string,
): Promise<BillingModelRecommendation> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      guestCount: true,
      groupBillingMode: true,
      inquiry: {
        select: {
          travelAgent: { select: { displayName: true } },
          corporateAccount: { select: { displayName: true } },
        },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const agent = entry.inquiry?.travelAgent?.displayName ?? null;
  const corporate = entry.inquiry?.corporateAccount?.displayName ?? null;
  const isGroup = entry.groupBillingMode === "GROUP_MASTER";

  const allowedBySource = await requireActiveConfigValue<Record<string, string[]>>(
    prisma,
    "billingModel.availablePerSource",
  ).catch(() => ({}) as Record<string, string[]>);
  const allowed = [...new Set(Object.values(allowedBySource).flat())];

  let recommended: string;
  let reason: string;
  if (agent) {
    recommended = "TOUR_OPERATOR_VOUCHER";
    reason = `Booked through ${agent} — settled against the operator's voucher.`;
  } else if (corporate) {
    recommended = "DIRECT_BILL";
    reason = `Booked under ${corporate} — invoiced to the company account.`;
  } else if (isGroup) {
    recommended = "DIRECT_BILL";
    reason = `Group booking of ${entry.guestCount ?? "several"} guests — billed as one account rather than per guest.`;
  } else {
    recommended = "GUEST_PAY";
    reason = "No agency or company attached — the guest settles their own bill.";
  }

  // Never recommend something the operator cannot save. If config forbids the natural choice,
  // fall back to the first permitted model and say so, rather than pre-selecting a dead option.
  if (allowed.length > 0 && !allowed.includes(recommended)) {
    const fallback = allowed.includes("GUEST_PAY") ? "GUEST_PAY" : allowed[0]!;
    reason = `${reason} (${recommended} is not permitted by configuration, so ${fallback} is suggested instead.)`;
    recommended = fallback;
  }

  return {
    recommended,
    reason,
    allowed,
    basis: {
      travelAgentName: agent,
      corporateAccountName: corporate,
      isGroup,
      guestCount: entry.guestCount ?? null,
    },
  };
}
