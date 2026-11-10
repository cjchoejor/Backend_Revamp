import type { Prisma } from "@prisma/client";
import { parentChargeOf } from "./folio-ledger-view.js";
import { CORRECTION_LINE_PREFIX, NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX, classifyFolioLine, companionBaseDescription } from "./folio-tax-lines.js";
import { round2, toDecimal, ZERO, type MoneyLike } from "./money.js";

/**
 * The bill, split into the stay as priced and what was added to it (2026-11-10, operator: "when
 * charges are added to the folio, in the charges tab in the price sub tab, it should also get
 * updated"). ONE rule, read by the mid-stay payment's projected total and by the billing summary's
 * "added during the stay", so the two cannot disagree.
 *
 * The stay as priced = what the night audit posts for each night: the room charge, the meal plan's
 * own line, and the service charge and GST beside each. The quoted stay total already holds all of
 * it. Everything else — food and drink ordered, services, extras, a fee, a correction or a credit
 * note — is added to the stay, each with its own service charge and GST.
 */
export type StayLedgerLine = {
  id: string;
  lineType: string;
  description: string;
  amount: MoneyLike;
  chargeDate: Date;
  postedAt: Date;
  createdAt: Date;
  nightAuditRecordId: string | null;
  roomId: string | null;
};

export type StayExtra<L extends StayLedgerLine> = {
  /** The charge; for a tax line with no charge to sit under, the tax line itself. */
  line: L;
  net: Prisma.Decimal;
  serviceCharge: Prisma.Decimal;
  gst: Prisma.Decimal;
  /** net + serviceCharge + gst. */
  total: Prisma.Decimal;
};

export type StayAndExtras<L extends StayLedgerLine> = {
  /** Every line on the bill. */
  billed: Prisma.Decimal;
  /** The stay as priced: the night audit's room and meal-plan lines with their tax. */
  stayPosted: Prisma.Decimal;
  /** billed − stayPosted: what was added, each charge with its own tax. */
  extrasTotal: Prisma.Decimal;
  extras: Array<StayExtra<L>>;
};

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export function splitStayAndExtras<L extends StayLedgerLine>(lines: readonly L[]): StayAndExtras<L> {
  const roomLineTypes = new Set<string>(["ROOM_CHARGE", "STAY"]);
  const stayKey = (roomId: string | null, chargeDate: Date, description: string) => `${roomId ?? ""}|${dayOf(chargeDate)}|${description}`;
  const isStayCharge = (l: L) =>
    classifyFolioLine(l) === "CHARGE" &&
    (roomLineTypes.has(String(l.lineType)) ||
      (String(l.lineType) === "F_AND_B" && l.description.startsWith(NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX)));
  const stayKeys = new Set(lines.filter(isStayCharge).map((l) => stayKey(l.roomId ?? null, l.chargeDate, l.description)));
  const isStayTax = (l: L) => {
    const cls = classifyFolioLine(l);
    if (cls !== "SERVICE_CHARGE" && cls !== "GST") return false;
    const base = companionBaseDescription(l.description);
    return (!!base && stayKeys.has(stayKey(l.roomId ?? null, l.chargeDate, base))) || !!l.nightAuditRecordId;
  };

  let billed = ZERO;
  let stayPosted = ZERO;
  const extraCharges: Array<{ line: L; isCorrection: boolean; sc: Prisma.Decimal; gst: Prisma.Decimal }> = [];
  const extraTax: L[] = [];
  for (const l of lines) {
    const amt = toDecimal(l.amount);
    billed = billed.add(amt);
    if (isStayCharge(l) || isStayTax(l)) {
      stayPosted = stayPosted.add(amt);
      continue;
    }
    if (classifyFolioLine(l) === "CHARGE") extraCharges.push({ line: l, isCorrection: l.description.startsWith(CORRECTION_LINE_PREFIX), sc: ZERO, gst: ZERO });
    else extraTax.push(l);
  }
  // Each tax line sits under the charge it belongs to; one with no charge here stands on its own.
  const loose: Array<StayExtra<L>> = [];
  for (const t of extraTax) {
    const amt = toDecimal(t.amount);
    const parent = parentChargeOf({ description: t.description, roomId: t.roomId, chargeDate: t.chargeDate, postedAt: t.postedAt }, extraCharges);
    const cls = classifyFolioLine(t);
    if (parent && cls === "SERVICE_CHARGE") parent.sc = parent.sc.add(amt);
    else if (parent && cls === "GST") parent.gst = parent.gst.add(amt);
    else loose.push({ line: t, net: ZERO, serviceCharge: cls === "SERVICE_CHARGE" ? amt : ZERO, gst: cls === "SERVICE_CHARGE" ? ZERO : amt, total: amt });
  }
  const extras: Array<StayExtra<L>> = [
    ...extraCharges.map((c) => {
      const net = toDecimal(c.line.amount);
      return { line: c.line, net, serviceCharge: c.sc, gst: c.gst, total: net.add(c.sc).add(c.gst) };
    }),
    ...loose,
  ].sort((a, b) => a.line.chargeDate.getTime() - b.line.chargeDate.getTime() || a.line.postedAt.getTime() - b.line.postedAt.getTime());

  return { billed: round2(billed), stayPosted: round2(stayPosted), extrasTotal: round2(billed.sub(stayPosted)), extras };
}
