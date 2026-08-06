import type { PrismaClient } from "@prisma/client";
import { InvoiceState, InvoiceType, Prisma } from "@prisma/client";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";

/**
 * Competing claims on THIS booking's rooms and dates (2026-08-06, operator request).
 *
 * Two operators can work the same rooms for the same nights at the same moment: nothing stops
 * both from sealing a selection, generating a quotation, even reaching S3 and minting a
 * proforma — the first HARD claim (committed hold, then reservation) is what actually takes the
 * inventory, and Policy 26 enforces that race's outcome. Everything before it is paper. This
 * service surfaces the paper: which OTHER live bookings hold a quotation or a proforma invoice
 * (or already a hold/reservation) over any of the same (room, night) pairs, so the desk can say
 * "someone else is selling this room too — first committed hold wins" at the S2→S3 boundary and
 * on the Set up step, instead of the loser finding out at the hold refusal.
 *
 * Pure read — nothing persisted, no trace. Advisory only: the hard gate stays Policy 26.
 */

export type CompetingClaimItem = {
  entryId: string;
  /** The booking's readable reference (inquiry id) for the operator. */
  reference: string | null;
  guestName: string | null;
  currentStage: string;
  /** What the competitor holds, strongest first: hard claims outrank paper. */
  kind: "RESERVED" | "COMMITTED_HOLD" | "SPECULATIVE_HOLD" | "PROFORMA_INVOICE" | "QUOTATION";
  /** QUO- / INV- id when the claim is paper; null on hard claims. */
  documentId: string | null;
  documentState: string | null;
  /** True when the paper was actually sent to a guest (dispatched PI / sent quote). */
  dispatched: boolean;
  /** The contested rooms, as room numbers. */
  roomNumbers: string[];
};

export type CompetingClaims = {
  checkIn: string | null;
  checkOut: string | null;
  /** This booking's own sealed rooms (numbers) — the set being contested. */
  roomNumbers: string[];
  items: CompetingClaimItem[];
};

/** Enumerate stay nights [checkIn, checkOut) as ISO days, capped at a year. */
function nights(checkIn: Date, checkOut: Date): string[] {
  const out: string[] = [];
  const cur = new Date(checkIn.getTime());
  let safety = 0;
  while (cur < checkOut && safety++ < 365) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** roomId → the nights it is claimed for, from a sealed optionSelected (per-night when present). */
function roomNightMap(opt: unknown, checkIn: Date | null, checkOut: Date | null): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const sealed = readOptionSelected(opt);
  if (sealed.perNight && sealed.perNight.length > 0) {
    for (const n of sealed.perNight) {
      const day = String(n.date).slice(0, 10);
      for (const id of n.roomIds) {
        const set = map.get(id) ?? new Set<string>();
        set.add(day);
        map.set(id, set);
      }
    }
    return map;
  }
  const range = checkIn && checkOut ? nights(checkIn, checkOut) : [];
  for (const id of sealed.distinctRoomIds) map.set(id, new Set(range));
  return map;
}

export async function buildCompetingClaims(prisma: PrismaClient, entryId: string): Promise<CompetingClaims> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      checkInDate: true,
      checkOutDate: true,
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { optionSelected: true },
      },
    },
  });
  const empty: CompetingClaims = { checkIn: null, checkOut: null, roomNumbers: [], items: [] };
  if (!entry) return empty;

  const myMap = roomNightMap(entry.availabilityConfigs[0]?.optionSelected ?? null, entry.checkInDate, entry.checkOutDate);
  const myRoomIds = [...myMap.keys()];
  if (myRoomIds.length === 0 || !entry.checkInDate || !entry.checkOutDate) {
    return { ...empty, checkIn: entry.checkInDate?.toISOString() ?? null, checkOut: entry.checkOutDate?.toISOString() ?? null };
  }

  // ---- Hard claims: reservations + committed/speculative holds (the real inventory) --------
  const hard = await findRoomBookingConflicts(prisma, {
    roomIds: myRoomIds,
    checkIn: entry.checkInDate,
    checkOut: entry.checkOutDate,
    excludeEntryId: entryId,
  });
  const hardByEntry = new Map<string, { kind: CompetingClaimItem["kind"]; rooms: Set<string>; ref: string | null; guest: string | null }>();
  for (const c of hard) {
    /**
     * The helper answers "overlaps the whole stay range" — too coarse for a per-night seal.
     * A hold on 205 for the 6th does NOT compete with a booking that claims 205 only on the
     * 7th (S1 showed the hold and the operator sealed around it). Keep a conflict only when
     * its span covers a night THIS booking actually claims for that room — the same
     * per-(room,night) rule selectOption and placeCommittedHold got on 2026-08-06; without it
     * the banner re-flagged exactly the rooms the partial-availability flow legitimately took.
     */
    const mine = myMap.get(c.roomId);
    if (!mine) continue;
    const touchesClaimedNight = [...mine].some((night) => {
      const t = new Date(`${night}T00:00:00.000Z`).getTime();
      return Number.isFinite(t) && t >= c.startDate.getTime() && t < c.endDate.getTime();
    });
    if (!touchesClaimedNight) continue;
    const kind: CompetingClaimItem["kind"] =
      c.source === "RESERVED" ? "RESERVED" : c.holdKind === "SPECULATIVE" ? "SPECULATIVE_HOLD" : "COMMITTED_HOLD";
    const cur = hardByEntry.get(c.entryId);
    if (cur) {
      cur.rooms.add(c.roomId);
      // Reservation outranks a hold for the same entry.
      if (kind === "RESERVED") cur.kind = "RESERVED";
    } else {
      hardByEntry.set(c.entryId, { kind, rooms: new Set([c.roomId]), ref: c.entryReferenceNumber, guest: c.guestName });
    }
  }

  // ---- Paper claims: other live bookings whose SEALED selection intersects mine and which
  // have a live quotation or proforma. Hard-claim entries are excluded — the hold/reservation
  // is the stronger statement about the same booking. -----------------------------------------
  const others = await prisma.entry.findMany({
    where: {
      id: { not: entryId, notIn: [...hardByEntry.keys()] },
      status: "ACTIVE",
      checkInDate: { lt: entry.checkOutDate },
      checkOutDate: { gt: entry.checkInDate },
    },
    select: {
      id: true,
      inquiryId: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      guestProfile: { select: { firstName: true, lastName: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { optionSelected: true },
      },
      quotations: {
        where: { state: { in: ["DRAFT", "SENT", "ACCEPTED"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, state: true, sentAt: true },
      },
      invoices: {
        where: { invoiceType: InvoiceType.PROFORMA, state: { not: InvoiceState.SUPERSEDED }, supersededById: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, state: true, dispatchedAt: true },
      },
    },
  });

  type PaperRow = {
    entryId: string;
    ref: string | null;
    guest: string | null;
    stage: string;
    rooms: Set<string>;
    quote: { id: string; state: string; sentAt: Date | null } | null;
    proforma: { id: string; state: string; dispatchedAt: Date | null } | null;
  };
  const paper: PaperRow[] = [];
  for (const o of others) {
    const quote = o.quotations[0] ?? null;
    const proforma = o.invoices[0] ?? null;
    if (!quote && !proforma) continue; // a bare selection isn't a claim on anything yet
    const theirMap = roomNightMap(o.availabilityConfigs[0]?.optionSelected ?? null, o.checkInDate, o.checkOutDate);
    const contested = new Set<string>();
    for (const [roomId, mine] of myMap) {
      const theirs = theirMap.get(roomId);
      if (!theirs) continue;
      for (const night of mine) {
        if (theirs.has(night)) {
          contested.add(roomId);
          break;
        }
      }
    }
    if (contested.size === 0) continue;
    const guest = [o.guestProfile?.firstName, o.guestProfile?.lastName].filter(Boolean).join(" ").trim() || null;
    paper.push({ entryId: o.id, ref: o.inquiryId, guest, stage: o.currentStage, rooms: contested, quote, proforma });
  }

  // ---- Resolve room numbers + assemble, strongest claims first ------------------------------
  const allRoomIds = new Set<string>(myRoomIds);
  for (const h of hardByEntry.values()) h.rooms.forEach((r) => allRoomIds.add(r));
  for (const p of paper) p.rooms.forEach((r) => allRoomIds.add(r));
  const rooms = await prisma.room.findMany({ where: { id: { in: [...allRoomIds] } }, select: { id: true, roomNumber: true } });
  const numberOf = new Map(rooms.map((r) => [r.id, r.roomNumber]));
  const toNumbers = (ids: Iterable<string>) =>
    [...ids].map((id) => numberOf.get(id) ?? id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // Hard-claim entries were excluded from the paper query, so their stage is fetched here.
  const hardEntries = hardByEntry.size
    ? await prisma.entry.findMany({
        where: { id: { in: [...hardByEntry.keys()] } },
        select: { id: true, currentStage: true },
      })
    : [];
  const stageOf = new Map<string, string>([
    ...hardEntries.map((e) => [e.id, e.currentStage] as const),
    ...others.map((o) => [o.id, o.currentStage] as const),
  ]);
  const items: CompetingClaimItem[] = [];
  for (const [id, h] of hardByEntry) {
    items.push({
      entryId: id,
      reference: h.ref,
      guestName: h.guest,
      currentStage: stageOf.get(id) ?? "",
      kind: h.kind,
      documentId: null,
      documentState: null,
      dispatched: false,
      roomNumbers: toNumbers(h.rooms),
    });
  }
  for (const p of paper) {
    // One item per booking, its strongest paper: a proforma outranks a quotation.
    if (p.proforma) {
      items.push({
        entryId: p.entryId,
        reference: p.ref,
        guestName: p.guest,
        currentStage: p.stage,
        kind: "PROFORMA_INVOICE",
        documentId: p.proforma.id,
        documentState: p.proforma.state,
        dispatched: p.proforma.dispatchedAt != null,
        roomNumbers: toNumbers(p.rooms),
      });
    } else if (p.quote) {
      items.push({
        entryId: p.entryId,
        reference: p.ref,
        guestName: p.guest,
        currentStage: p.stage,
        kind: "QUOTATION",
        documentId: p.quote.id,
        documentState: p.quote.state,
        dispatched: p.quote.sentAt != null,
        roomNumbers: toNumbers(p.rooms),
      });
    }
  }
  const rank: Record<CompetingClaimItem["kind"], number> = {
    RESERVED: 0,
    COMMITTED_HOLD: 1,
    SPECULATIVE_HOLD: 2,
    PROFORMA_INVOICE: 3,
    QUOTATION: 4,
  };
  items.sort((a, b) => rank[a.kind] - rank[b.kind]);

  return {
    checkIn: entry.checkInDate.toISOString(),
    checkOut: entry.checkOutDate.toISOString(),
    roomNumbers: toNumbers(myRoomIds),
    items,
  };
}
