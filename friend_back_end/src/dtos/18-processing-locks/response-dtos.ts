import type { ProcessingLockRecord } from "@prisma/client";

export type PlaceProcessingLockResponseDto = {
  lock: ProcessingLockRecord;
  meta?: { priorityNotice?: string };
};
