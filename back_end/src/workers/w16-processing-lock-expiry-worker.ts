import type { PrismaClient } from "@prisma/client";
import * as s1ProcessingLockService from "../services/domain/s1-processing-lock-service.js";

export async function runProcessingLockExpiryWorker(prisma: PrismaClient, input: { lockId: string }) {
  try {
    return await s1ProcessingLockService.expireLock(prisma, input.lockId);
  } catch (e: any) {
    // Same trap as w20: verify the LOCK is actually missing before mapping to SKIPPED, so a
    // NotFoundError from an unrelated downstream policy doesn't silently drop the expiry work.
    if (e?.name === "NotFoundError") {
      const lock = await prisma.processingLockRecord.findUnique({ where: { id: input.lockId }, select: { id: true } }).catch(() => null);
      if (!lock) return { skipped: true, reason: "LOCK_NOT_FOUND" } as const;
    }
    throw e;
  }
}

