import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

export async function enforceHighValueConfirmationAuthority(
  prisma: PrismaClient,
  input: { actorId: string; nightlyRate: number; thresholds: { highValueAmount?: unknown } | null | undefined },
) {
  const highValueAmount = Number(input.thresholds?.highValueAmount ?? 0);
  if (!(highValueAmount > 0)) return;
  if (!(input.nightlyRate >= highValueAmount)) return;

  const actorLevel = await prisma.staffUser
    .findUnique({ where: { id: input.actorId } })
    .then((u) => (u as any)?.actorLevel)
    .catch(() => null);

  if (actorLevel === "L1" || actorLevel == null) {
    throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "High-value confirmation requires FOM");
  }
}

