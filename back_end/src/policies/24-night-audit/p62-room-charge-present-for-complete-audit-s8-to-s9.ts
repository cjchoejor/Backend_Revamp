import type { PrismaClient } from "@prisma/client";
import { FolioLineType, NightAuditRunStatus } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { listStayNightOperatingDatesUtc } from "./p61-night-audits-complete-for-stay-before-settlement.js";

export type StayChargeGap = { lineType: "ROOM_CHARGE"; operatingDateIso: string };

/**
 * For each stay-night where night audit is **COMPLETE**, list expected folio lines that are missing:
 * **ROOM_CHARGE** only.
 *
 * A recorded deviation from SIG-S7 AC-S7-04 (operator ruling, 2026-11-03): the check for a missing
 * daily food and drink charge was removed. No step ever marked a booking as expecting one, so it
 * never ran, and the night audit posts a meal plan's charge itself.
 */
export async function listStayChargeGapsForCompleteAuditStayNightsS8ToS9(
  prisma: PrismaClient,
  input: {
    folioId: string;
    checkIn: Date;
    checkOut: Date;
  },
): Promise<StayChargeGap[]> {
  const dates = listStayNightOperatingDatesUtc(input.checkIn, input.checkOut);
  const gaps: StayChargeGap[] = [];
  for (const op of dates) {
    const audit = await prisma.nightAuditRecord.findUnique({ where: { operatingDate: op } });
    if (!audit || audit.runStatus !== NightAuditRunStatus.COMPLETE) continue;

    const roomLine = await prisma.folioLine.findFirst({
      where: { folioId: input.folioId, lineType: FolioLineType.ROOM_CHARGE, chargeDate: op },
    });
    if (!roomLine) gaps.push({ lineType: "ROOM_CHARGE", operatingDateIso: op.toISOString().slice(0, 10) });
  }
  return gaps;
}

/** @deprecated Prefer `listStayChargeGapsForCompleteAuditStayNightsS8ToS9` + aggregate errors. */
export async function enforceRoomChargePostedForCompleteAuditStayNightsS8ToS9(
  prisma: PrismaClient,
  input: { folioId: string; checkIn: Date; checkOut: Date },
) {
  const gaps = await listStayChargeGapsForCompleteAuditStayNightsS8ToS9(prisma, input);
  const roomDates = gaps.map((g) => g.operatingDateIso);
  if (!roomDates.length) return;
  throw new PolicyGateBlockedError(
    "UNPOSTED_ROOM_CHARGE_AT_S8_EXIT",
    `Stay night(s) with COMPLETE night audit but no ROOM_CHARGE folio line: ${roomDates.join(", ")}`,
  );
}
