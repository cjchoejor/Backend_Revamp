import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { validateFoc } from "../../engines/foc-validation-engine.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

export async function enforceFocReverificationBeforeConfirmation(
  prisma: PrismaClient,
  input: {
    entryId: string;
    useType: string;
    roomsRequested: number;
    focRoomsRequested: number;
  },
) {
  if (!(input.useType === "GROUP" || input.useType === "CONFERENCE")) return;

  const cfg = await requireActiveConfigValue<any>(prisma, "foc.configuration").catch(() => null);
  if (cfg?.enabled !== true) return;
  if (!(input.focRoomsRequested > 0)) return;

  const foc = await validateFoc(prisma, {
    entryId: input.entryId,
    roomsRequested: input.roomsRequested,
    focRoomsRequested: input.focRoomsRequested,
  });
  if (!foc.isValid) throw new PolicyGateBlockedError("FOC_INVALID", `FOC validation failed: ${foc.reasons.join(",")}`);

  const gm = await prisma.traceEvent.findFirst({
    where: { entryId: input.entryId, eventType: "FOC.GM_APPROVED" },
    orderBy: { timestamp: "desc" },
  });
  if (!gm) throw new PolicyGateBlockedError("FOC_GM_APPROVAL_REQUIRED", "FOC requires GM approval before S4 confirmation");
}

