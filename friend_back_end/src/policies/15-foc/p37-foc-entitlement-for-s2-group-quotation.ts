import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { validateFoc } from "../../engines/foc-validation-engine.js";

/**
 * SIG-S2 Policy 37 — FOC entitlement (group quotation path at S2).
 * Blocks quotation creation when FOC allocation exceeds engine entitlement.
 */
export async function enforceFocEntitlementForS2GroupQuotation(
  prisma: PrismaClient,
  input: { entryId: string; roomsRequested: number; focRoomsRequested: number },
) {
  const foc = await validateFoc(prisma, {
    entryId: input.entryId,
    roomsRequested: input.roomsRequested,
    focRoomsRequested: input.focRoomsRequested,
  });
  if (!foc.isValid) {
    throw new PolicyGateBlockedError("FOC_ENTITLEMENT", `FOC validation failed: ${foc.reasons.join(", ")}`);
  }
}
