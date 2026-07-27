import type { PrismaClient } from "@prisma/client";
import { NightAuditRunStatus } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

function operatingDateUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

/** Each calendar **stay night** operating date: [checkIn, checkout) in UTC midnights. */
export function listStayNightOperatingDatesUtc(checkIn: Date, checkOut: Date): Date[] {
  const out: Date[] = [];
  let d = operatingDateUtc(checkIn);
  const end = operatingDateUtc(checkOut);
  while (d < end) {
    out.push(d);
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  }
  return out;
}

/**
 * Policy 61 — Night audit completeness for stayed nights (SIG-S8 §4.1 / §6.1).
 * Every stay-night operating date must have a **COMPLETE** `NightAuditRecord`, unless FOM documents an override ref.
 */
export function enforceNightAuditsCompleteForStayBeforeSettlement(input: {
  incompleteOperatingDateIsoList: string[];
  fomNightAuditAcknowledgementRef?: string | null;
}) {
  if (!input.incompleteOperatingDateIsoList.length) return;
  if (input.fomNightAuditAcknowledgementRef?.trim()) return;
  throw new PolicyGateBlockedError(
    "NIGHT_AUDIT_INCOMPLETE_AT_SETTLEMENT",
    `Night audit not COMPLETE for: ${input.incompleteOperatingDateIsoList.join(", ")} — FOM acknowledgement ref required`,
  );
}

/** Operating dates (UTC midnights) in the stay window lacking a **COMPLETE** night-audit row. */
export async function findIncompleteStayNightAuditDatesUtc(prisma: PrismaClient, checkIn: Date, checkOut: Date): Promise<string[]> {
  const dates = listStayNightOperatingDatesUtc(checkIn, checkOut);
  const incomplete: string[] = [];
  for (const d of dates) {
    const rec = await prisma.nightAuditRecord.findUnique({ where: { operatingDate: d } });
    if (!rec || rec.runStatus !== NightAuditRunStatus.COMPLETE) {
      incomplete.push(d.toISOString().slice(0, 10));
    }
  }
  return incomplete;
}
