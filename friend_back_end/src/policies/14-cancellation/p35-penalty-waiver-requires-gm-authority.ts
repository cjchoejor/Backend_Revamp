import { AuthorizationError } from "../../lib/errors.js";
import type { ActorLevel } from "../../types/actor.js";

/**
 * SIG-S5 Policy 35 — penalty waiver beyond FOM authority requires GM (L3+).
 * FOM (L2) may cancel with disclosed penalty; waiver of that penalty is L3/L4 only.
 */
export function enforceGmAuthorityForCancellationPenaltyWaiver(input: {
  penaltyWaiverRequested: boolean;
  actorLevel: ActorLevel;
}) {
  if (!input.penaltyWaiverRequested) return;
  if (input.actorLevel === "L3" || input.actorLevel === "L4") return;
  throw new AuthorizationError("Penalty waiver requires GM (L3) or executive (L4) authority");
}
