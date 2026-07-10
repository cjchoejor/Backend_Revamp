import type { PrismaClient } from "@prisma/client";
import * as s1EntryService from "../services/domain/s1-entry-service.js";

export async function runEntryExpiryWorker(
  prisma: PrismaClient,
  input: { entryId: string; parkFollowUp?: boolean },
) {
  try {
    return await s1EntryService.expireEntry(prisma, input.entryId, {
      fromParkFollowUp: input.parkFollowUp === true,
    });
  } catch (e: any) {
    if (e?.name === "NotFoundError") return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;
    throw e;
  }
}

