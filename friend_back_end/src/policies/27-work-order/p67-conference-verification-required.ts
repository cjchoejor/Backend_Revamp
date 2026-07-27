import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/** Atlas Cat 06 group 27 (§5.2.27) — P67 conference verification before confirmation. */
export async function enforceConferenceVerificationBeforeConfirmation(
  prisma: PrismaClient,
  input: { entryId: string; useType: string },
) {
  if (input.useType !== "CONFERENCE") return;

  const ok = await prisma.traceEvent.findFirst({
    where: { entryId: input.entryId, eventType: "CONFERENCE.VERIFIED" },
    orderBy: { timestamp: "desc" },
  });
  if (!ok) throw new PolicyGateBlockedError("CONFERENCE_VERIFICATION_REQUIRED", "Conference verification must be completed by FOM before confirmation");
}
