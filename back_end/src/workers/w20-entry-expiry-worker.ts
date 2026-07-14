import type { PrismaClient } from "@prisma/client";
import * as s1EntryService from "../services/domain/s1-entry-service.js";

export async function runEntryExpiryWorker(prisma: PrismaClient, input: { entryId: string }) {
  try {
    return await s1EntryService.expireEntry(prisma, input.entryId);
  } catch (e: any) {
    // Only skip when the ENTRY itself is missing — verify the entry doesn't exist before
    // treating this as SKIPPED. Previously, ANY NotFoundError (a policy that couldn't find a
    // dependent record, e.g. a missing folio) mapped to SKIPPED, so pg-boss never retried and
    // real expire-this-entry work silently dropped. If the entry does exist and something
    // downstream is missing, let the error bubble so pg-boss retries with backoff.
    if (e?.name === "NotFoundError") {
      const entry = await prisma.entry.findUnique({ where: { id: input.entryId }, select: { id: true } });
      if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;
    }
    throw e;
  }
}

