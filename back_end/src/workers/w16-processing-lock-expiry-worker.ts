import type { PrismaClient } from "@prisma/client";
import * as s1ProcessingLockService from "../services/domain/s1-processing-lock-service.js";

export async function runProcessingLockExpiryWorker(prisma: PrismaClient, input: { lockId: string }) {
  try {
    return await s1ProcessingLockService.expireLock(prisma, input.lockId);
  } catch (e: any) {
    if (e?.name === "NotFoundError") return { skipped: true, reason: "LOCK_NOT_FOUND" } as const;
    throw e;
  }
}

