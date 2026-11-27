import type { Prisma } from "@prisma/client";
import { NIGHT_AUDIT_APARTMENT_BED_PREFIX, NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX, NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX } from "./folio-tax-lines.js";
import { sumMoney, toDecimal, type MoneyLike } from "./money.js";
import { labelRoomNights, type NightsMode } from "./room-nights-for-entry.js";

/**
 * A bill's rows (2026-11-25, moved here from the bill page so the papers set the charges out the
 * same way). A room's nights at one figure are one row ("3 nights × 3,000.00"), so a long stay stays
 * readable; every other charge keeps its own line and date. Rooms first, by their first night and
 * then number; the rest in the order they were posted. Each row's amount is its lines added up, so the rows add up to the
 * ledger's net to the chhertum.
 */
export type BillRow = {
  key: string;
  /** "09 Nov", or "10–12 Apr" for nights set out on one row. */
  when: string;
  /** A room number or a hall's name. */
  place: string | null;
  description: string;
  /** Nights on this row and the figure of each, when there is more than one. */
  qty: number;
  rate: number;
  amount: number;
  /** A room's nights or meal plan set out on one row — the paper prints its nights and rate. */
  repeats: boolean;
};

export type BillRowLine = {
  id: string;
  description: string;
  amount: MoneyLike;
  chargeDate: Date;
  room?: { roomNumber: string } | null;
  space?: { name: string } | null;
};

export type BillRowCharge<L extends BillRowLine = BillRowLine> = { line: L; isRoom: boolean; isCorrection: boolean };

const n = (v: MoneyLike) => Number(toDecimal(v).toFixed(2));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const firstNight = (lines: ReadonlyArray<{ chargeDate: Date }>) => Math.min(...lines.map((l) => l.chargeDate.getTime()));

/** Plain words for a line: the desk's working names never reach a bill. */
export function billWordsFor(description: string): { words: string; repeats: boolean; group?: string; place?: string; oneRow?: boolean } {
  // An apartment's rent (2026-11-27): one row per period, named for the apartment, never its lead room.
  const rent = description.startsWith(NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX)
    ? /· rent, apartment (\S+) · (.+)$/.exec(description)
    : null;
  if (rent) return { words: `Rent · ${rent[2]}`, repeats: false, place: `Apartment ${rent[1]}`, oneRow: true };
  if (description.startsWith(NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX)) return { words: "Room charge", repeats: true };
  if (description.startsWith(NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX)) return { words: "Meal plan", repeats: true };
  // An apartment's extra bed (2026-11-27): "Extra bed · 2 beds", its nights grouped like a room's.
  if (description.startsWith(NIGHT_AUDIT_APARTMENT_BED_PREFIX)) {
    const parts = description.split(" · ");
    const beds = parts.find((p) => /^\d+ beds?$/.test(p));
    const apartment = parts.find((p) => p.startsWith("Apartment "));
    // Each bed's own nights make one row; two beds on one night are two rows, not "2 nights".
    return { words: beds ? `Extra bed · ${beds}` : "Extra bed", repeats: true, group: description, place: apartment };
  }
  // A correction of an apartment's line names the apartment it was for.
  const apt = /^Correction for \S+: .*\bapartment (\S+)/i.exec(description);
  return { words: description.replace(/^Correction for \S+: /, "Correction: "), repeats: false, place: apt ? `Apartment ${apt[1]}` : undefined };
}

/** The rows of a bill, from the ledger view's charges (in its bill order). */
export function billRowsOf<L extends BillRowLine>(charges: ReadonlyArray<BillRowCharge<L>>, mode: NightsMode = "SHORT"): BillRow[] {
  const grouped = new Map<string, { place: string | null; words: string; isRoom: boolean; amount: Prisma.Decimal; lines: L[] }>();
  const single: BillRow[] = [];
  const rent: BillRow[] = [];
  for (const c of charges) {
    const { words, repeats, group, place: named, oneRow } = billWordsFor(c.line.description);
    const place = named ?? c.line.room?.roomNumber ?? c.line.space?.name ?? null;
    if (!c.isCorrection && !oneRow && (repeats || c.isRoom)) {
      const key = `${place ?? ""}|${group ?? (c.isRoom ? words || "Room" : words)}|${toDecimal(c.line.amount).toFixed(2)}`;
      const g = grouped.get(key) ?? { place, words, isRoom: c.isRoom, amount: toDecimal(c.line.amount), lines: [] };
      g.lines.push(c.line);
      grouped.set(key, g);
    } else {
      (oneRow && !c.isCorrection ? rent : single).push({
        key: c.line.id,
        when: labelRoomNights([ymd(c.line.chargeDate)], mode),
        place,
        description: words,
        qty: 1,
        rate: n(c.line.amount),
        amount: n(c.line.amount),
        repeats: false,
      });
    }
  }
  const rows = [...grouped.values()]
    // By the first night, then the room, the room charge before its meal plan — the order a guest
    // reads a hotel bill in (2026-11-25; it was by room number alone).
    .sort(
      (a, b) =>
        firstNight(a.lines) - firstNight(b.lines) ||
        byNumber(a.place ?? "", b.place ?? "") ||
        Number(b.isRoom) - Number(a.isRoom),
    )
    .map((g) => ({
      key: g.lines[0]!.id,
      when: labelRoomNights(
        g.lines.map((l) => ymd(l.chargeDate)),
        mode,
      ),
      place: g.place,
      description: g.words,
      qty: g.lines.length,
      rate: n(g.amount),
      amount: n(sumMoney(g.lines.map((l) => l.amount))),
      repeats: true,
    }));
  // An apartment's rent first, by its period's first night (2026-11-27).
  return [...rent, ...rows, ...single];
}
