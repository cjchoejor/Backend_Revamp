import type { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { FolioLineType, NightAuditRunStatus } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { listStayNightOperatingDatesUtc } from "./p61-night-audits-complete-for-stay-before-settlement.js";

export type StayChargeGap =
  | { lineType: "ROOM_CHARGE"; operatingDateIso: string }
  | { lineType: "F_AND_B"; operatingDateIso: string };

function expectsDailyFAndB(frozenInclusions: Prisma.JsonValue | null | undefined): boolean {
  return (frozenInclusions as Record<string, unknown> | null | undefined)?.dailyFAndBExpected === true;
}

/**
 * For each stay-night where night audit is **COMPLETE**, list expected folio lines that are missing:
 * - **ROOM_CHARGE** always checked
 * - **F_AND_B** when `frozenInclusions.dailyFAndBExpected === true` (aligns with night-audit worker expectations)
 */
export async function listStayChargeGapsForCompleteAuditStayNightsS8ToS9(
  prisma: PrismaClient,
  input: {
    folioId: string;
    checkIn: Date;
    checkOut: Date;
    frozenInclusions: Prisma.JsonValue | null | undefined;
  },
): Promise<StayChargeGap[]> {
  const wantsFnb = expectsDailyFAndB(input.frozenInclusions);
  const dates = listStayNightOperatingDatesUtc(input.checkIn, input.checkOut);
  const gaps: StayChargeGap[] = [];
  for (const op of dates) {
    const audit = await prisma.nightAuditRecord.findUnique({ where: { operatingDate: op } });
    if (!audit || audit.runStatus !== NightAuditRunStatus.COMPLETE) continue;

    const roomLine = await prisma.folioLine.findFirst({
      where: { folioId: input.folioId, lineType: FolioLineType.ROOM_CHARGE, chargeDate: op },
    });
    if (!roomLine) gaps.push({ lineType: "ROOM_CHARGE", operatingDateIso: op.toISOString().slice(0, 10) });

    if (wantsFnb) {
      const fnb = await prisma.folioLine.findFirst({
        where: { folioId: input.folioId, lineType: FolioLineType.F_AND_B, chargeDate: op },
      });
      if (!fnb) gaps.push({ lineType: "F_AND_B", operatingDateIso: op.toISOString().slice(0, 10) });
    }
  }
  return gaps;
}

/** @deprecated Prefer `listStayChargeGapsForCompleteAuditStayNightsS8ToS9` + aggregate errors. */
export async function enforceRoomChargePostedForCompleteAuditStayNightsS8ToS9(
  prisma: PrismaClient,
  input: { folioId: string; checkIn: Date; checkOut: Date },
) {
  const gaps = await listStayChargeGapsForCompleteAuditStayNightsS8ToS9(prisma, {
    ...input,
    frozenInclusions: null,
  });
  const roomDates = gaps.filter((g) => g.lineType === "ROOM_CHARGE").map((g) => g.operatingDateIso);
  if (!roomDates.length) return;
  throw new PolicyGateBlockedError(
    "UNPOSTED_ROOM_CHARGE_AT_S8_EXIT",
    `Stay night(s) with COMPLETE night audit but no ROOM_CHARGE folio line: ${roomDates.join(", ")}`,
  );
}
