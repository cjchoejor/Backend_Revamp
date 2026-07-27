import type { PrismaClient } from "@prisma/client";
import { EntryStatus } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

/** Entry rows that still participate in operational duplicate detection. */
const ACTIVE_ENTRY_STATUSES: EntryStatus[] = [EntryStatus.ACTIVE, EntryStatus.PARKED];

function parseDay(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("invalid date");
  return d;
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export type InquiryDuplicateGateInput = {
  guestProfileId: string;
  /** When set, compared against dated entries on other inquiries for the same guest (Policy 12). */
  proposedCheckIn?: string;
  proposedCheckOut?: string;
};

/**
 * Policy 12 — Duplicate inquiry / entry gate at **`InquiryService.create()`** time (SIG-S1 §4, §6.1).
 *
 * Runs **before** the inquiry row is written. **Confirmed** overlapping stay window → hard block.
 * Without `proposedCheckIn` / `proposedCheckOut`, no date overlap can be computed → **APPROVED** (caller may still attach an explicit duplicate flag via controlled path).
 */
export async function assertNoConfirmedDuplicateInquiryForCreation(
  prisma: PrismaClient,
  input: InquiryDuplicateGateInput,
): Promise<void> {
  if (!input.proposedCheckIn?.trim() || !input.proposedCheckOut?.trim()) {
    return;
  }
  const newStart = parseDay(input.proposedCheckIn.trim());
  const newEnd = parseDay(input.proposedCheckOut.trim());
  if (newStart.getTime() >= newEnd.getTime()) {
    throw new ValidationError("proposedCheckIn must be before proposedCheckOut for duplicate detection");
  }

  const others = await prisma.inquiry.findMany({
    where: { guestProfileId: input.guestProfileId },
    select: {
      id: true,
      referenceNumber: true,
      entries: {
        where: { status: { in: ACTIVE_ENTRY_STATUSES } },
        select: { id: true, checkInDate: true, checkOutDate: true },
      },
    },
  });

  for (const inq of others) {
    for (const en of inq.entries) {
      if (!en.checkInDate || !en.checkOutDate) continue;
      if (rangesOverlap(newStart, newEnd, en.checkInDate, en.checkOutDate)) {
        throw new PolicyGateBlockedError(
          "DUPLICATE_INQUIRY_CONFIRMED",
          "An active entry on another inquiry overlaps the proposed stay window for this guest profile.",
          { conflictingInquiryId: inq.id, conflictingEntryId: en.id, referenceNumber: inq.referenceNumber },
        );
      }
    }
  }
}
