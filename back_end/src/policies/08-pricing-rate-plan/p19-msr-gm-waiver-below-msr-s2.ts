import type { PrismaClient } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError } from "../../lib/errors.js";

/** SIG-S2 — GM (L3) may approve rates below MSR with an explicit documented waiver. */
export type BelowMsrGmWaiverPayload = {
  acknowledged: true;
  rationale: string;
};

export type MsrGmWaiverRecord = {
  rationale: string;
  waivedAt: string;
  waivedBy: string;
};

/**
 * When `belowMsr` is false, returns `null` (no waiver stored).
 * When true, requires acting user to be **L3 (GM)** and a valid waiver payload.
 */
export async function resolveBelowMsrGmWaiverForS2(
  prisma: PrismaClient,
  input: {
    belowMsr: boolean;
    actorId: string;
    waiver: BelowMsrGmWaiverPayload | null | undefined;
    /** If provided, level is trusted from session (skips DB read). */
    actorLevel?: "L1" | "L2" | "L3" | "L4";
  },
): Promise<MsrGmWaiverRecord | null> {
  if (!input.belowMsr) return null;

  let level = input.actorLevel;
  if (!level) {
    const staff = await prisma.staffUser.findUnique({ where: { id: input.actorId }, select: { actorLevel: true } });
    if (!staff) throw new NotFoundError("StaffUser");
    level = staff.actorLevel as "L1" | "L2" | "L3" | "L4";
  }

  if (level !== "L3") {
    throw new PolicyGateBlockedError(
      "MSR_BREACH",
      "Resolved rate falls below MSR; General Manager (L3) must record an explicit waiver with rationale",
    );
  }

  const rationale = input.waiver?.rationale?.trim() ?? "";
  if (input.waiver?.acknowledged !== true || rationale.length < 3) {
    throw new PolicyGateBlockedError(
      "MSR_WAIVER_REQUIRED",
      "Below-MSR pricing requires GM waiver: acknowledged=true and rationale (minimum 3 characters)",
    );
  }

  return {
    rationale,
    waivedAt: new Date().toISOString(),
    waivedBy: input.actorId,
  };
}
