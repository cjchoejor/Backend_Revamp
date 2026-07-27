import type { ActorLevel, EntryUseType } from "@prisma/client";
import { AuthorizationError } from "../../lib/errors.js";

export type CustodianReassignmentAuthorityInput = {
  actorLevel: ActorLevel;
  /** Highest-risk use type among entries under the inquiry, if known. */
  useTypes: EntryUseType[];
  guestCount?: number | null;
};

/**
 * Policy 4 — Custodian reassignment (SIG-S1 §4, §6.1 `assignCustodian`).
 *
 * Standard reassignment: **L1**. Conference / catering or large party ⇒ **L2 (FOM)+**.
 */
export function enforceCustodianReassignmentAuthority(input: CustodianReassignmentAuthorityInput): void {
  const level = input.actorLevel;
  if (level === "L3" || level === "L4" || level === "SYSTEM") return;

  const needsFom =
    input.useTypes.some((u) => u === "CONFERENCE" || u === "CATERING") ||
    (typeof input.guestCount === "number" && Number.isFinite(input.guestCount) && input.guestCount >= 50);

  if (needsFom && level === "L1") {
    throw new AuthorizationError("Custodian reassignment for conference/catering or large party requires FOM (L2) or above");
  }
}
