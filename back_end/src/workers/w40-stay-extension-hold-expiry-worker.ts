import type { PrismaClient } from "@prisma/client";
import { lapseStayExtensionRequest } from "../services/domain/stay-extension-service.js";

/**
 * W40 — stay-extension hold expiry (2026-08-21).
 *
 * A requested extension CLAIMS its extra nights for the guest while the interim invoice goes out
 * and the payment comes in (config `stayExtension.holdTtlSeconds`). When the clock runs out and
 * the money never arrived, the claim is released and the request marked LAPSED — nothing else
 * about the booking moved, so there is nothing to undo. A PAID request never lapses: money was
 * taken, the commit is the operator's next act.
 */
export async function runStayExtensionHoldExpiryWorker(
  prisma: PrismaClient,
  input: { stayExtensionRequestId?: string; timerRecordId?: string },
) {
  const now = new Date();
  const requestId = typeof input.stayExtensionRequestId === "string" ? input.stayExtensionRequestId : undefined;
  const markFired = async () => {
    if (typeof input.timerRecordId === "string") {
      await prisma.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }
  };
  if (!requestId) {
    await markFired();
    return { skipped: true, reason: "MISSING_ID" } as const;
  }
  const req = await prisma.stayExtensionRequest.findUnique({ where: { id: requestId }, select: { state: true, holdExpiresAt: true } });
  if (!req) {
    await markFired();
    return { skipped: true, reason: "REQUEST_GONE" } as const;
  }
  if (req.state !== "REQUESTED" && req.state !== "BILLED") {
    await markFired();
    return { skipped: true, reason: `STATE_${req.state}` } as const;
  }
  if (req.holdExpiresAt.getTime() > now.getTime() + 1000) {
    // Re-armed after a later request edit — this fire is stale.
    await markFired();
    return { skipped: true, reason: "RE_ARMED" } as const;
  }
  await lapseStayExtensionRequest(prisma, requestId, "HOLD_EXPIRED");
  await markFired();
  return { lapsed: true } as const;
}
