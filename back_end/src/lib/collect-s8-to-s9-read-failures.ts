import type { Prisma } from "@prisma/client";
import { HandoffType, Stage } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { InventoryClaimState } from "@prisma/client";
import type { StageGateFailureItem } from "./errors.js";
import * as disputeGateEngine from "../engines/dispute-gate-engine.js";
import { listStayChargeGapsForCompleteAuditStayNightsS8ToS9 } from "../policies/24-night-audit/p62-room-charge-present-for-complete-audit-s8-to-s9.js";
import { peekH4S8ExitFailure } from "../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import { getEntryWithRoom } from "../services/domain/s8-checkout-service.js";
import { readBookingInspectionStanding, roomListWords } from "./room-inspection-standing.js";
import { readBookingDamages, unansweredDamageRooms } from "./damage-standing.js";
import { damageNotAnsweredForS8Exit } from "../policies/36-damage-assessment/p81-damage-assessment-gates.js";

export type EntryWithFolioReservation = Prisma.EntryGetPayload<{
  include: { folio: true; reservation: true };
}>;

/**
 * Read-only S8→S9 gate collection (SIG “collect failures” slice).
 * Mutating steps (H5 build) must run **after** this returns an empty array.
 */
export async function collectS8ToS9ReadOnlyFailures(
  prisma: PrismaClient,
  args: { entryId: string; entry: EntryWithFolioReservation },
): Promise<StageGateFailureItem[]> {
  const { entryId, entry } = args;
  const failures: StageGateFailureItem[] = [];

  const unresolvedAnomalyCount = await prisma.nightAuditAnomaly.count({
    where: { entryId, resolvedAt: null },
  });
  if (unresolvedAnomalyCount > 0) {
    failures.push({
      blockingCondition: "NIGHT_AUDIT_ANOMALY_UNRESOLVED",
      message: `Unresolved night audit anomalies for this entry (${unresolvedAnomalyCount}) block S8→S9`,
    });
  }

  const folio = entry.folio;
  if (folio && entry.reservation) {
    const gaps = await listStayChargeGapsForCompleteAuditStayNightsS8ToS9(prisma, {
      folioId: folio.id,
      checkIn: entry.reservation.frozenCheckInDate,
      checkOut: entry.reservation.frozenCheckOutDate,
      frozenInclusions: entry.reservation.frozenInclusions,
    });
    const roomDates = gaps.filter((g) => g.lineType === "ROOM_CHARGE").map((g) => g.operatingDateIso);
    const fnbDates = gaps.filter((g) => g.lineType === "F_AND_B").map((g) => g.operatingDateIso);
    if (roomDates.length) {
      failures.push({
        blockingCondition: "UNPOSTED_ROOM_CHARGE_AT_S8_EXIT",
        message: `Stay night(s) with COMPLETE night audit but no ROOM_CHARGE folio line: ${roomDates.join(", ")}`,
      });
    }
    if (fnbDates.length) {
      failures.push({
        blockingCondition: "UNPOSTED_F_AND_B_AT_S8_EXIT",
        message: `Stay night(s) with COMPLETE night audit but no F_AND_B line (daily F&B expected): ${fnbDates.join(", ")}`,
      });
    }
  }

  const key = await prisma.keyReturnRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (!key) {
    failures.push({ blockingCondition: "KEY_RETURN_NOT_RECORDED", message: "Key return not recorded" });
  }

  try {
    const { room } = await getEntryWithRoom(prisma, entryId);
    if (room.currentClaimState !== InventoryClaimState.DEPARTED_DIRTY) {
      failures.push({
        blockingCondition: "ROOM_NOT_DEPARTED_DIRTY",
        message: "Room must be DEPARTED_DIRTY before S9",
      });
    }
  } catch {
    failures.push({
      blockingCondition: "ROOM_ASSIGNMENT_OR_ROOM_MISSING",
      message: "Entry has no room assignment or room record for checkout gate",
    });
  }

  // Every room the guest leaves is inspected, or its inspection put off (2026-10-26 — one
  // inspection per room; it had been one per booking).
  const inspections = await readBookingInspectionStanding(prisma, entryId);
  if (!inspections.allRecorded) {
    const missing = inspections.rooms.filter((r) => r.standing.state === "NOT_RECORDED").map((r) => r.roomNumber);
    failures.push({
      blockingCondition: "INSPECTION_NOT_COMPLETE_OR_DEFERRED",
      message: missing.length
        ? `${roomListWords(missing)} not inspected — inspect ${missing.length > 1 ? "each" : "it"}, or put the inspection off to after departure`
        : "Room inspection not complete or deferred",
    });
  }

  // A damage found is answered — charged, waived, or left to decide after departure (2026-10-26).
  const damageFail = damageNotAnsweredForS8Exit({ unansweredRooms: unansweredDamageRooms(await readBookingDamages(prisma, entryId)) });
  if (damageFail) failures.push(damageFail);

  const gate = await disputeGateEngine.canProgressStage(prisma, entryId, Stage.S9);
  if (gate.result !== "CLEAR") {
    failures.push({
      blockingCondition: "DISPUTE_GATE_BLOCKED",
      message: "Dispute gate blocks S8→S9 — disputes must be RESOLVED or CLOSED (no override at this transition)",
    });
  }

  const h4 = await prisma.handoffRecord.findFirst({
    where: { entryId, handoffType: HandoffType.H4 },
    orderBy: { createdAt: "desc" },
  });
  const h4Fail = peekH4S8ExitFailure({ h4 });
  if (h4Fail) failures.push(h4Fail);

  return failures;
}
