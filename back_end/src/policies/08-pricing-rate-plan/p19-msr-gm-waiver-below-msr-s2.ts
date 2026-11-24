import type { PrismaClient } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * SIG-S2 — selling below the house's minimum sellable rate (MSR) needs an explicit waiver.
 *
 * Who may give it (2026-11-24, operator: "GM and admin can sell the rooms below the msr"): the GM
 * (L3) and an admin (L4). The person's own price IS the waiver — it is recorded on the quotation
 * with who, when and the rooms it covers, and traced; no separate form is asked for. A reason
 * typed with it is kept; without one the record says who sold below the floor.
 *
 * It had been the GM alone, with a written waiver the desk never sent — so a GM's discount under
 * the floor was refused ("waiver required"), and an admin was refused outright.
 */
export type BelowMsrGmWaiverPayload = {
  acknowledged: true;
  rationale: string;
};

/** A room priced below its type's floor. */
export type BelowFloorRoom = {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  rate: number;
  floor: number;
};

export type MsrGmWaiverRecord = {
  rationale: string;
  waivedAt: string;
  waivedBy: string;
  /** The level that gave it: L3 (GM) or L4 (admin). Absent on a waiver carried from an earlier quotation. */
  level?: "L3" | "L4";
  /** The rooms priced below their floor and what each was sold at (2026-11-24). */
  rooms?: BelowFloorRoom[];
  /** The quotation whose waiver this carries, when a later re-quote kept the same rates. */
  carriedFrom?: string;
};

export function mayPriceBelowMsr(level: string | null | undefined): boolean {
  return level === "L3" || level === "L4";
}

const money = (n: number) => `Nu ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The refusal, in words: which room, at what, under what floor. */
export function belowMsrRefusalWords(rooms: BelowFloorRoom[] | null | undefined): string {
  if (rooms && rooms.length) {
    const r = rooms[0];
    const more = rooms.length > 1 ? ` (and ${rooms.length - 1} more room${rooms.length > 2 ? "s" : ""})` : "";
    return `Room ${r.roomNumber} is priced at ${money(r.rate)}, below the house's minimum of ${money(r.floor)} for its type${more} — only the GM or an admin may sell below it.`;
  }
  return "The rate is below the house's minimum sellable rate — only the GM or an admin may sell below it.";
}

/**
 * When `belowMsr` is false, returns `null` (no waiver stored). When true, the acting person must
 * be the GM or an admin; the waiver is recorded in their name.
 */
export async function resolveBelowMsrGmWaiverForS2(
  prisma: PrismaClient,
  input: {
    belowMsr: boolean;
    actorId: string;
    waiver: BelowMsrGmWaiverPayload | null | undefined;
    /** If provided, level is trusted from session (skips DB read). */
    actorLevel?: "L1" | "L2" | "L3" | "L4";
    /** The rooms under their floor, for the record and the words. */
    rooms?: BelowFloorRoom[];
  },
): Promise<MsrGmWaiverRecord | null> {
  if (!input.belowMsr) return null;

  let level = input.actorLevel;
  if (!level) {
    const staff = await prisma.staffUser.findUnique({ where: { id: input.actorId }, select: { actorLevel: true } });
    if (!staff) throw new NotFoundError("StaffUser");
    level = staff.actorLevel as "L1" | "L2" | "L3" | "L4";
  }

  if (!mayPriceBelowMsr(level)) {
    throw new PolicyGateBlockedError("MSR_BREACH", belowMsrRefusalWords(input.rooms));
  }

  const typed = input.waiver?.rationale?.trim() ?? "";
  return {
    rationale: typed.length >= 3 ? typed : `Sold below the house's minimum by the ${level === "L4" ? "admin" : "GM"}`,
    waivedAt: new Date().toISOString(),
    waivedBy: input.actorId,
    level: level as "L3" | "L4",
    ...(input.rooms && input.rooms.length ? { rooms: input.rooms } : {}),
  };
}
