/**
 * Import legacy bookings from the old DB CSVs into the new system's S1-S9 model.
 *
 * Input files at scripts/import-data/legacy-bookings/:
 *   customer_inquiry.csv      — master record per booking
 *   reservation_billing.csv   — billing-level data (the "reservation" stage)
 *   room_reservation.csv      — day-grain room booking (one row per (booking, room, date))
 *   all_room_billing.csv      — final billing snapshot
 *   registration_form.csv     — check-in record
 *   registration_rooms.csv    — rooms attached to a registration
 *   room.csv                  — old room catalogue (reference only; new DB already has rooms)
 *
 * Output: per-booking transaction creating Inquiry → Entry → Segment(s) → Reservation
 *         → CommittedHold(s) + RoomAssignment(s) → Folio + FolioLines + PaymentRecord(s)
 *         → HandoffRecord(s) for checked-in guests.
 *
 * High-fidelity import:
 *  - Preserves original reservation_date, arrival_date, departure_date timestamps.
 *  - Stages each booking based on actual data state (S1/S4/S5/S6/S9 + TERMINAL/CANCELLED).
 *  - Old `reservation_ref_no` (e.g. "RES_22012026_00976") preserved in notes.
 *  - Guest profiles deduplicated by email/phone within the import.
 *
 * Dry-run by default; pass --commit to write.
 */
import { PrismaClient, EntryStatus, FolioState, FolioLineType, HandoffType, HandoffState, HoldState, InventoryClaimState, PaymentDirection, QuotationState, Stage } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { allocateReadableId } from "../../src/lib/readable-id.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR_ID = "actor-seed-system";
const TODAY = new Date(); // used for stage decisions

const DATA_DIR = path.resolve(process.cwd(), "scripts/import-data/legacy-bookings");
const FILES = {
  customerInquiry: "customer_inquiry.csv",
  reservationBilling: "reservation_billing.csv",
  roomReservation: "room_reservation.csv",
  allRoomBilling: "all_room_billing.csv",
  registrationForm: "registration_form.csv",
  registrationRooms: "registration_rooms.csv",
};

/* ============================================================================
 * CSV parsing
 * ============================================================================ */

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ""; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(filename: string): Record<string, string>[] {
  const fp = path.join(DATA_DIR, filename);
  if (!existsSync(fp)) throw new Error(`CSV not found: ${fp}`);
  const text = readFileSync(fp, "utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

/* ============================================================================
 * Field helpers
 * ============================================================================ */

const trim = (v: string | undefined | null): string => (v ?? "").trim();
const nullIfEmpty = (v: string): string | null => v.trim() === "" ? null : v.trim();
const naToNull = (v: string): string | null => {
  const t = v.trim();
  if (!t) return null;
  if (t.toLowerCase() === "na") return null;
  return t;
};

function toBool(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t === "t" || t === "true" || t === "1";
}

function toNumber(v: string): number {
  const t = (v ?? "").trim();
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

function toDate(v: string): Date | null {
  const t = (v ?? "").trim();
  if (!t || t.toLowerCase() === "na") return null;
  // Try ISO first, then YYYY-MM-DD
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : null;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const cleaned = (full ?? "").replace(/^Mrs\.?|^Mr\.?|^Ms\.?|^Dr\.?/i, "").trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] || "Guest", lastName: "(legacy)" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/* ============================================================================
 * Index builders
 * ============================================================================ */

type LegacyData = {
  inquiries: Map<string, Record<string, string>>;
  billings: Map<string, Record<string, string>>;
  allRoomBillings: Map<string, Record<string, string>>;
  roomReservations: Map<string, Record<string, string>[]>;        // ref_no -> rows (day-grain)
  registrations: Map<string, Record<string, string>[]>;            // ref_no -> rows
  registrationRooms: Map<string, Record<string, string>[]>;        // reg_no -> rows
};

function loadAll(): LegacyData {
  console.log(`Reading CSVs from ${DATA_DIR}`);
  const inquiries = new Map<string, Record<string, string>>();
  for (const r of readCsv(FILES.customerInquiry)) {
    const ref = trim(r.reservation_ref_no);
    if (ref) inquiries.set(ref, r);
  }

  const billings = new Map<string, Record<string, string>>();
  for (const r of readCsv(FILES.reservationBilling)) {
    const ref = trim(r.reservation_ref_no);
    if (ref) billings.set(ref, r); // last wins if dup
  }

  const allRoomBillings = new Map<string, Record<string, string>>();
  for (const r of readCsv(FILES.allRoomBilling)) {
    const ref = trim(r.reservation_ref_no);
    if (ref) allRoomBillings.set(ref, r);
  }

  const roomReservations = new Map<string, Record<string, string>[]>();
  for (const r of readCsv(FILES.roomReservation)) {
    const ref = trim(r.reservation_ref_no);
    if (!ref) continue;
    if (!roomReservations.has(ref)) roomReservations.set(ref, []);
    roomReservations.get(ref)!.push(r);
  }

  const registrations = new Map<string, Record<string, string>[]>();
  for (const r of readCsv(FILES.registrationForm)) {
    const ref = trim(r.reservation_ref_no);
    if (!ref) continue;
    if (!registrations.has(ref)) registrations.set(ref, []);
    registrations.get(ref)!.push(r);
  }

  const registrationRooms = new Map<string, Record<string, string>[]>();
  for (const r of readCsv(FILES.registrationRooms)) {
    const regNo = trim(r.registration_no);
    if (!regNo) continue;
    if (!registrationRooms.has(regNo)) registrationRooms.set(regNo, []);
    registrationRooms.get(regNo)!.push(r);
  }

  console.log(`  inquiries: ${inquiries.size}`);
  console.log(`  reservation_billings: ${billings.size}`);
  console.log(`  all_room_billings: ${allRoomBillings.size}`);
  console.log(`  room_reservations: ${[...roomReservations.values()].reduce((s, a) => s + a.length, 0)} rows in ${roomReservations.size} bookings`);
  console.log(`  registrations: ${[...registrations.values()].reduce((s, a) => s + a.length, 0)} rows in ${registrations.size} bookings`);
  console.log(`  registration_rooms: ${[...registrationRooms.values()].reduce((s, a) => s + a.length, 0)} rows in ${registrationRooms.size} registrations`);

  return { inquiries, billings, allRoomBillings, roomReservations, registrations, registrationRooms };
}

/* ============================================================================
 * Per-booking transformation + write
 * ============================================================================ */

type PartyLink = {
  partyType: "TRAVEL_AGENT" | "CORPORATE" | null;
  partyId: string | null;
  matchedName: string | null;
};

type StageDecision = {
  currentStage: Stage;
  entryStatus: EntryStatus;
  /** Whether to create a Reservation row. */
  withReservation: boolean;
  /** Whether to create CommittedHold + RoomAssignment per room. */
  withRoomHolds: boolean;
  /** Whether to create a Folio + FolioLines. */
  withFolio: boolean;
  /** Whether to create H1 handoff (check-in occurred). */
  withCheckIn: boolean;
  /** Final folio state (PROVISIONAL / LIVE / SETTLED / OUTSTANDING / NO_SHOW_CLOSED). */
  folioState: FolioState;
  reason: string;
};

function decideStage(
  inquiry: Record<string, string>,
  billing: Record<string, string> | null,
  allRoomBilling: Record<string, string> | null,
  rooms: Record<string, string>[],
  registrations: Record<string, string>[],
): StageDecision {
  const inquirySuccess = toBool(inquiry.inquiry_status);
  const arrival = toDate(inquiry.arrival_date);
  const departure = toDate(inquiry.departure_date);
  const hasCheckIn = registrations.length > 0;
  const hasBilling = !!billing || !!allRoomBilling;
  const hasRooms = rooms.length > 0;
  const finalStatus = trim(allRoomBilling?.final_payment_status ?? "").toLowerCase();
  const bookingStatus = trim(allRoomBilling?.booking_status ?? "").toLowerCase();

  // Failed inquiry — never converted to a booking.
  if (!inquirySuccess && !hasBilling && !hasRooms) {
    return {
      currentStage: Stage.TERMINAL,
      entryStatus: EntryStatus.EXPIRED,
      withReservation: false,
      withRoomHolds: false,
      withFolio: false,
      withCheckIn: false,
      folioState: FolioState.PROVISIONAL,
      reason: "Inquiry did not convert (inquiry_status=f, no billing/rooms)",
    };
  }

  // Has check-in → either in-house now (S6/S7) or already checked out (S9).
  if (hasCheckIn && departure) {
    const past = departure.getTime() < TODAY.getTime();
    if (past) {
      return {
        currentStage: Stage.S9,
        entryStatus: EntryStatus.CLOSED,
        withReservation: true,
        withRoomHolds: true,
        withFolio: true,
        withCheckIn: true,
        folioState: finalStatus === "settled" || bookingStatus === "close" ? FolioState.SETTLED : FolioState.OUTSTANDING,
        reason: "Checked-in, departure past — landing at S9",
      };
    }
    return {
      currentStage: Stage.S7,
      entryStatus: EntryStatus.ACTIVE,
      withReservation: true,
      withRoomHolds: true,
      withFolio: true,
      withCheckIn: true,
      folioState: FolioState.LIVE,
      reason: "Checked-in, in-house now — landing at S7",
    };
  }

  // Has reservation_billing but no check-in → S4 (confirmed) or S5 (past arrival, no-show)
  if (hasBilling) {
    if (arrival && arrival.getTime() < TODAY.getTime() && !hasCheckIn) {
      return {
        currentStage: Stage.TERMINAL,
        entryStatus: EntryStatus.EXPIRED,
        withReservation: true,
        withRoomHolds: true,
        withFolio: true,
        withCheckIn: false,
        folioState: FolioState.NO_SHOW_CLOSED,
        reason: "Reserved but never checked in, arrival past — no-show",
      };
    }
    return {
      currentStage: Stage.S4,
      entryStatus: EntryStatus.ACTIVE,
      withReservation: true,
      withRoomHolds: true,
      withFolio: true,
      withCheckIn: false,
      folioState: FolioState.PROVISIONAL,
      reason: "Confirmed reservation, future arrival — S4",
    };
  }

  // Has room_reservation but no reservation_billing → S3 (committed hold)
  if (hasRooms) {
    return {
      currentStage: Stage.S3,
      entryStatus: EntryStatus.ACTIVE,
      withReservation: false,
      withRoomHolds: true,
      withFolio: false,
      withCheckIn: false,
      folioState: FolioState.PROVISIONAL,
      reason: "Room held, no billing — S3",
    };
  }

  // Just inquiry, success but nothing else
  return {
    currentStage: Stage.S1,
    entryStatus: EntryStatus.ACTIVE,
    withReservation: false,
    withRoomHolds: false,
    withFolio: false,
    withCheckIn: false,
    folioState: FolioState.PROVISIONAL,
    reason: "Inquiry-only, no follow-through",
  };
}

/* ============================================================================
 * Main
 * ============================================================================ */

async function main() {
  const prisma = new PrismaClient();
  console.log(`\n=== Legacy bookings import (${COMMIT ? "COMMIT" : "DRY RUN"}) ===\n`);

  const data = loadAll();
  console.log();

  // Pre-load lookups: travel agents, corporates, rooms, staff (for defaultCustodianId)
  const travelAgents = await prisma.travelAgent.findMany({ select: { id: true, displayName: true } });
  const corporates  = await prisma.corporateAccount.findMany({ select: { id: true, displayName: true } });
  const rooms        = await prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true } });
  const frontDeskStaff = await prisma.staffUser.findFirst({ where: { actorLevel: "L1" } });

  if (!frontDeskStaff) throw new Error("No L1 staff found — need at least one front-desk staff as defaultCustodianId");
  const defaultCustodianId = frontDeskStaff.id;

  // Pick a fallback rate plan for Reservation.frozenRatePlanId. Agent rate cards override this
  // at quote time on real bookings, but the schema still requires a FK. Walk-in plan is the cleanest.
  const fallbackRatePlan = await prisma.ratePlanRegistry.findFirst({ where: { isActive: true }, orderBy: { name: "asc" } });
  if (!fallbackRatePlan) throw new Error("No active rate plan found — need at least one for Reservation.frozenRatePlanId");
  const fallbackRatePlanId = fallbackRatePlan.id;

  const agentByName = new Map<string, string>(travelAgents.map((a) => [a.displayName.toLowerCase().replace(/\s+/g, " ").trim(), a.id]));
  const corpByName  = new Map<string, string>(corporates.map((a) => [a.displayName.toLowerCase().replace(/\s+/g, " ").trim(), a.id]));
  const roomById    = new Map<string, { id: string; roomTypeId: string }>(
    rooms.map((r) => [r.roomNumber, { id: r.id, roomTypeId: r.roomTypeId }]),
  );

  console.log(`  Pre-loaded: ${travelAgents.length} agents, ${corporates.length} corporates, ${rooms.length} rooms`);
  console.log(`  Default custodian (L1): ${defaultCustodianId}\n`);

  function findParty(inquiry: Record<string, string>): PartyLink {
    const type = trim(inquiry.guest_type).toLowerCase();
    // Walk-in: never link a party, regardless of what's in guest_type_detail.
    if (type === "walk-in" || type === "walkin" || type === "walk in") {
      return { partyType: null, partyId: null, matchedName: null };
    }
    const detail = trim(inquiry.guest_type_detail);
    if (!detail) return { partyType: null, partyId: null, matchedName: null };
    const key = detail.toLowerCase().replace(/\s+/g, " ").trim();
    const agentId = agentByName.get(key);
    if (agentId) return { partyType: "TRAVEL_AGENT", partyId: agentId, matchedName: detail };
    const corpId = corpByName.get(key);
    if (corpId) return { partyType: "CORPORATE", partyId: corpId, matchedName: detail };
    return { partyType: null, partyId: null, matchedName: null };
  }

  // ====== Plan ======
  const inquiryRefs = [...data.inquiries.keys()];
  const stageBreakdown: Record<string, number> = {};
  const matchedAgents = new Map<string, number>();
  const unmatchedDetails = new Map<string, number>();
  const errors: { ref: string; error: string }[] = [];

  // Sample for spot-check
  const samples: { ref: string; name: string; party: string; stage: string; reason: string }[] = [];

  for (const ref of inquiryRefs) {
    try {
      const inq = data.inquiries.get(ref)!;
      const billing = data.billings.get(ref) ?? null;
      const arb = data.allRoomBillings.get(ref) ?? null;
      const rms = data.roomReservations.get(ref) ?? [];
      const regs = data.registrations.get(ref) ?? [];

      const decision = decideStage(inq, billing, arb, rms, regs);
      const stageKey = `${decision.currentStage} / ${decision.entryStatus}`;
      stageBreakdown[stageKey] = (stageBreakdown[stageKey] ?? 0) + 1;

      const link = findParty(inq);
      if (link.matchedName) matchedAgents.set(link.matchedName, (matchedAgents.get(link.matchedName) ?? 0) + 1);
      else if (trim(inq.guest_type_detail)) unmatchedDetails.set(trim(inq.guest_type_detail), (unmatchedDetails.get(trim(inq.guest_type_detail)) ?? 0) + 1);

      if (samples.length < 6) {
        samples.push({
          ref,
          name: trim(inq.contact_person),
          party: link.matchedName ? `${link.partyType} ${link.matchedName}` : "(walk-in)",
          stage: stageKey,
          reason: decision.reason,
        });
      }
    } catch (e) {
      errors.push({ ref, error: (e as Error).message });
    }
  }

  console.log("Stage breakdown:");
  for (const [k, v] of Object.entries(stageBreakdown).sort()) console.log(`  ${v.toString().padStart(4)}  ${k}`);
  console.log();

  console.log(`Agent/corporate link rate: ${[...matchedAgents.values()].reduce((s, n) => s + n, 0)} of ${inquiryRefs.length}`);
  console.log(`  Top matched: ${[...matchedAgents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (unmatchedDetails.size > 0) {
    console.log(`  Unmatched details (will land as walk-in):`);
    for (const [k, v] of [...unmatchedDetails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${v.toString().padStart(3)}× "${k}"`);
    }
  }
  console.log();

  console.log("Sample bookings:");
  for (const s of samples) console.log(`  ${s.ref}  ${s.name}  [${s.stage}]  ${s.party}  // ${s.reason}`);
  console.log();

  if (errors.length > 0) {
    console.log(`Planning errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log(`  - [${e.ref}] ${e.error}`);
    console.log();
  }

  if (!COMMIT) {
    console.log("Dry run only. Re-run with --commit to write.\n");
    await prisma.$disconnect();
    return;
  }

  // ====== Commit phase ======
  // Sync readable-id sequences past existing rows for TODAY so allocations don't collide.
  // Bookings dated BEFORE today will use their original reservation_date when allocating,
  // and there are no existing INQ/ENT/RES/FOL rows for those past dates, so collisions
  // only matter for TODAY (where a few admin-ish rows may already exist).
  await syncSequencesForToday(prisma);

  console.log("Writing bookings...\n");
  let okBookings = 0;
  let okGuests = 0;
  let okFolios = 0;
  let okPayments = 0;
  let okHoldsAssignments = 0;
  let okHandoffs = 0;
  const writeErrors: { ref: string; error: string }[] = [];

  // Guest dedup cache — by phone+email key so the same person across multiple bookings
  // gets the same GuestProfile.
  const guestCache = new Map<string, string>();

  for (const ref of inquiryRefs) {
    try {
      const inq = data.inquiries.get(ref)!;
      const billing = data.billings.get(ref) ?? null;
      const arb = data.allRoomBillings.get(ref) ?? null;
      const rms = data.roomReservations.get(ref) ?? [];
      const regs = data.registrations.get(ref) ?? [];
      const link = findParty(inq);
      const decision = decideStage(inq, billing, arb, rms, regs);
      const reservationDate = toDate(inq.reservation_date) ?? new Date();

      await prisma.$transaction(async (tx) => {
        /* ---- 1. Guest profile (dedup by phone+email) ---- */
        const guestName = trim(inq.contact_person) || trim(arb?.name) || "Guest (legacy)";
        const phone = naToNull(trim(inq.contact_person_phone_no));
        const email = naToNull(trim(inq.contact_person_email));
        const guestKey = `${phone ?? ""}::${email ?? ""}::${guestName.toLowerCase()}`;
        let guestProfileId: string;
        let createdNewGuest = false;
        if (guestCache.has(guestKey)) {
          guestProfileId = guestCache.get(guestKey)!;
          // Verify still exists — if a prior tx rolled back, the cache could be stale.
          const exists = await tx.guestProfile.findUnique({ where: { id: guestProfileId }, select: { id: true } });
          if (!exists) {
            guestCache.delete(guestKey);
            guestProfileId = ""; // fall through to creation below
          }
        }
        if (!guestProfileId) {
          const { firstName, lastName } = splitName(guestName);
          const guest = await tx.guestProfile.create({
            data: {
              firstName,
              lastName,
              email,
              phone,
              nationality: naToNull(trim(arb?.nationality ?? "")) ?? naToNull(trim(regs[0]?.nationality ?? "")) ?? null,
              clientTier: "STANDARD",
              createdBy: ACTOR_ID,
            },
          });
          guestProfileId = guest.id;
          createdNewGuest = true;
        }

        /* ---- 2. Allocate readable IDs (with original dates for high-fidelity) ---- */
        const inqId = await allocateReadableId(tx, "INQUIRY" as const, reservationDate);
        const entryId = await allocateReadableId(tx, "ENTRY" as const, reservationDate);

        /* ---- 3. Create Inquiry ---- */
        const noteParts = [
          `Imported from legacy DB. Original reservation_ref_no: ${ref}`,
          `guest_type: ${trim(inq.guest_type)}`,
          trim(inq.guest_type_detail) ? `guest_type_detail: ${trim(inq.guest_type_detail)}` : null,
          trim(inq.inquiry_remarks) ? `remarks: ${trim(inq.inquiry_remarks)}` : null,
          trim(inq.entered_by) ? `entered_by: ${trim(inq.entered_by)}` : null,
        ].filter(Boolean).join(" | ");
        const sourceChannel = link.partyType === "TRAVEL_AGENT" ? "AGENT" : link.partyType === "CORPORATE" ? "CORPORATE" : "WALK_IN";

        await tx.inquiry.create({
          data: {
            id: inqId,
            referenceNumber: inqId,
            guestProfileId,
            sourceChannel,
            defaultCustodianId,
            notes: noteParts,
            travelAgentId: link.partyType === "TRAVEL_AGENT" ? link.partyId : null,
            corporateAccountId: link.partyType === "CORPORATE" ? link.partyId : null,
            createdAt: reservationDate,
            createdBy: ACTOR_ID,
          },
        });

        /* ---- 4. Create Entry ---- */
        const checkInDate = toDate(inq.arrival_date);
        const checkOutDate = toDate(inq.departure_date);
        const guestCount = toNumber(inq.no_of_adults) + toNumber(inq.no_of_children);
        await tx.entry.create({
          data: {
            id: entryId,
            inquiryId: inqId,
            guestProfileId,
            useType: "LEISURE",
            checkInDate: checkInDate ?? null,
            checkOutDate: checkOutDate ?? null,
            guestCount: guestCount > 0 ? guestCount : 1,
            segmentNumber: 1,
            currentStage: decision.currentStage,
            status: decision.entryStatus,
            otaSource: false,
            createdAt: reservationDate,
            updatedAt: reservationDate,
            createdBy: ACTOR_ID,
          },
        });

        /* ---- 5. Create Segment(s) ---- */
        const segment1 = await tx.segment.create({
          data: {
            entryId,
            segmentNumber: 1,
            stage: decision.currentStage,
            startedAt: reservationDate,
            createdBy: ACTOR_ID,
            notes: "Imported from legacy",
          },
        });
        // Multi-segment trips: schedule_type='multiple' with arrival_date_2/departure_date_2
        const scheduleType = trim(inq.schedule_type).toLowerCase();
        const checkIn2 = toDate(inq.arrival_date_2);
        const checkOut2 = toDate(inq.departure_date_2);
        if (scheduleType === "multiple" && checkIn2 && checkOut2 && checkIn2.getTime() !== checkInDate?.getTime()) {
          await tx.segment.create({
            data: {
              entryId,
              segmentNumber: 2,
              stage: decision.currentStage,
              startedAt: checkIn2,
              createdBy: ACTOR_ID,
              notes: "Imported from legacy (segment 2)",
            },
          });
        }

        /* ---- 6. Reservation ---- */
        if (decision.withReservation && checkInDate && checkOutDate) {
          const nights = Math.max(1, Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86400_000));
          const totalNegotiated = toNumber(billing?.total_negotiated ?? "0") || toNumber(arb?.total_negotiated_price ?? "0");
          const frozenRate = totalNegotiated > 0 ? totalNegotiated / nights : 0;
          const reservationId = await allocateReadableId(tx, "RESERVATION" as const, reservationDate);
          await tx.reservation.create({
            data: {
              id: reservationId,
              entryId,
              segmentId: segment1.id,
              frozenRatePlanId: fallbackRatePlanId,
              frozenBillingModel: "GUEST_PAY",
              frozenCheckInDate: checkInDate,
              frozenCheckOutDate: checkOutDate,
              frozenRate,
              frozenGuestCount: guestCount > 0 ? guestCount : 1,
              frozenInclusions: {
                imported: true,
                originalRef: ref,
                fnbAmount: toNumber(arb?.fnb_summary_amount ?? "0"),
              } as object,
              confirmedAt: reservationDate,
              confirmedBy: ACTOR_ID,
              createdAt: reservationDate,
            },
          });
        }

        /* ---- 7. Committed holds + room assignments per unique room ---- */
        if (decision.withRoomHolds && rms.length > 0) {
          // Group by room_no (each unique room → one hold + assignment).
          const byRoom = new Map<string, Record<string, string>[]>();
          for (const r of rms) {
            const rn = trim(r.room_no);
            if (!rn) continue;
            if (!byRoom.has(rn)) byRoom.set(rn, []);
            byRoom.get(rn)!.push(r);
          }
          for (const [roomNo, rows] of byRoom) {
            const room = roomById.get(roomNo);
            if (!room) continue; // Skip if the old room isn't in new DB.
            // Note: CommittedHold is skipped for historical imports — it's a stage-3 concept that's
            // already past, and the schema constrains it to ONE per Entry which doesn't fit
            // multi-room bookings. RoomAssignment (supports many per Entry) carries the assignment.
            const holdId = await allocateReadableId(tx, "ROOM_ASSIGNMENT" as const, reservationDate);
            await tx.roomAssignment.create({
              data: {
                id: holdId,
                entryId,
                roomId: room.id,
                assignedBy: ACTOR_ID,
                assignedAt: reservationDate,
                deficientAtAssignment: false,
              },
            });
            okHoldsAssignments++;
          }
        }

        /* ---- 8. Folio + FolioLines (enriched per Q5) + Payments ---- */
        if (decision.withFolio) {
          const folioId = await allocateReadableId(tx, "FOLIO" as const, reservationDate);
          const totalNegotiated = toNumber(billing?.total_negotiated ?? "0") || toNumber(arb?.total_negotiated_price ?? "0");
          const totalWithoutTax = toNumber(arb?.total_without_tax ?? "0") || toNumber(billing?.total_without_tax ?? "0");
          const tax = toNumber(arb?.tax ?? "0") || toNumber(billing?.tax ?? "0");
          const fnb = toNumber(arb?.fnb_summary_amount ?? "0");
          const laundry = toNumber(arb?.laundry_summary_amount ?? "0");
          const fine = toNumber(arb?.fine_amount ?? "0");
          const foc = toNumber(arb?.foc_amount ?? "0");
          const advance = toNumber(billing?.amount ?? "0");
          const settled = toNumber(arb?.settled_payment ?? "0");

          await tx.folio.create({
            data: {
              id: folioId,
              entryId,
              state: decision.folioState,
              billingModel: "GUEST_PAY",
              outstandingBalance: 0,
              advancePaymentReconciliationComplete: settled > 0 || decision.folioState === FolioState.SETTLED,
              closedAt: decision.folioState === FolioState.SETTLED || decision.folioState === FolioState.NO_SHOW_CLOSED ? checkOutDate ?? reservationDate : null,
              closedBy: decision.folioState === FolioState.SETTLED || decision.folioState === FolioState.NO_SHOW_CLOSED ? ACTOR_ID : null,
              createdAt: reservationDate,
              createdBy: ACTOR_ID,
            },
          });
          okFolios++;

          // Enriched FolioLines. (FolioLineType enum: ROOM_CHARGE | F_AND_B | SERVICE | OTHER | CREDIT_NOTE)
          const lines: { type: FolioLineType; desc: string; amount: number; stage: Stage }[] = [];
          if (totalWithoutTax > 0 || totalNegotiated > 0) {
            lines.push({ type: FolioLineType.ROOM_CHARGE, desc: "Room charge (imported)", amount: totalWithoutTax || totalNegotiated, stage: Stage.S4 });
          }
          if (tax > 0) lines.push({ type: FolioLineType.OTHER, desc: `Tax (imported — BST + service charge)`, amount: tax, stage: Stage.S4 });
          if (fnb > 0) lines.push({ type: FolioLineType.F_AND_B, desc: "F&B summary (imported)", amount: fnb, stage: Stage.S7 });
          if (laundry > 0) lines.push({ type: FolioLineType.SERVICE, desc: "Laundry summary (imported)", amount: laundry, stage: Stage.S7 });
          if (fine > 0) lines.push({ type: FolioLineType.OTHER, desc: "Fine (imported)", amount: fine, stage: Stage.S7 });
          if (foc > 0) lines.push({ type: FolioLineType.CREDIT_NOTE, desc: "FOC discount (imported)", amount: -foc, stage: Stage.S4 });

          for (const l of lines) {
            await tx.folioLine.create({
              data: {
                folioId,
                lineType: l.type,
                description: l.desc,
                amount: l.amount,
                currency: "BTN",
                chargeDate: reservationDate,
                stage: l.stage,
                postedBy: ACTOR_ID,
              },
            });
          }

          // Payment records.
          if (advance > 0) {
            const pid = await allocateReadableId(tx, "PAYMENT" as const, reservationDate);
            await tx.paymentRecord.create({
              data: {
                id: pid,
                folioId,
                entryId,
                amount: advance,
                paymentDirection: PaymentDirection.IN,
                paymentMethod: naToNull(trim(billing?.advance_payment_mode ?? "")) ?? "CASH",
                receivedAt: reservationDate,
                recordedBy: ACTOR_ID,
                stage: Stage.S3,
                notes: "Advance payment (imported)",
              },
            });
            okPayments++;
          }
          if (settled > 0) {
            const pid = await allocateReadableId(tx, "PAYMENT" as const, checkOutDate ?? reservationDate);
            await tx.paymentRecord.create({
              data: {
                id: pid,
                folioId,
                entryId,
                amount: settled,
                paymentDirection: PaymentDirection.IN,
                paymentMethod: naToNull(trim(arb?.advance_payment_mode ?? "")) ?? "CASH",
                receivedAt: checkOutDate ?? reservationDate,
                recordedBy: ACTOR_ID,
                stage: Stage.S8,
                notes: "Final settlement (imported)",
              },
            });
            okPayments++;
          }
        }

        /* ---- 9. Handoff H1 (created in CONFIRMED → FULFILLED at check-in) ---- */
        if (decision.withCheckIn) {
          const handoffId = await allocateReadableId(tx, "HANDOFF" as const, reservationDate);
          await tx.handoffRecord.create({
            data: {
              id: handoffId,
              entryId,
              handoffType: HandoffType.H1,
              state: HandoffState.FULFILLED,
              fromRole: "RESERVATIONS",
              fromActorId: ACTOR_ID,
              toRole: "FRONT_DESK",
              acceptedAt: reservationDate,
              acceptedBy: ACTOR_ID,
              fulfilledAt: checkInDate ?? reservationDate,
              fulfilledBy: ACTOR_ID,
              checklistContent: { imported: true, originalRef: ref } as object,
              stageContext: Stage.S4,
              createdBy: ACTOR_ID,
              isAutoFulfilled: false,
            },
          });
          okHandoffs++;
        }
      });

      // Cache the guest ID only after the surrounding transaction succeeds.
      const inq2 = data.inquiries.get(ref)!;
      const arb2 = data.allRoomBillings.get(ref) ?? null;
      const guestNameC = trim(inq2.contact_person) || trim(arb2?.name) || "Guest (legacy)";
      const phoneC = naToNull(trim(inq2.contact_person_phone_no));
      const emailC = naToNull(trim(inq2.contact_person_email));
      const keyC = `${phoneC ?? ""}::${emailC ?? ""}::${guestNameC.toLowerCase()}`;
      if (!guestCache.has(keyC)) {
        const guestRow = await prisma.guestProfile.findFirst({ where: { phone: phoneC, email: emailC, firstName: splitName(guestNameC).firstName }, select: { id: true } });
        if (guestRow) {
          guestCache.set(keyC, guestRow.id);
          okGuests++;
        }
      }

      okBookings++;
    } catch (e) {
      writeErrors.push({ ref, error: (e as Error).message });
    }
  }

  console.log(`✓ Bookings imported:           ${okBookings} / ${inquiryRefs.length}`);
  console.log(`✓ Guest profiles created:      ${okGuests}`);
  console.log(`✓ Holds + assignments:         ${okHoldsAssignments}`);
  console.log(`✓ Folios created:              ${okFolios}`);
  console.log(`✓ Payment records:             ${okPayments}`);
  console.log(`✓ Handoff records (H1):        ${okHandoffs}`);
  if (writeErrors.length > 0) {
    console.log(`\n✗ Write errors (${writeErrors.length}):`);
    for (const e of writeErrors.slice(0, 20)) console.log(`  - [${e.ref}] ${e.error}`);
    if (writeErrors.length > 20) console.log(`  ...and ${writeErrors.length - 20} more`);
  }

  // Room state reconciliation: S7-in-house bookings → OCCUPIED; everything else stays FREE.
  console.log("\nReconciling room states...");
  const inHouseEntries = await prisma.entry.findMany({
    where: { currentStage: Stage.S7, status: EntryStatus.ACTIVE },
    include: { roomAssignments: true },
  });
  for (const e of inHouseEntries) {
    for (const a of e.roomAssignments) {
      await prisma.room.update({ where: { id: a.roomId }, data: { currentClaimState: InventoryClaimState.OCCUPIED } });
    }
  }
  console.log(`  Set ${inHouseEntries.reduce((s, e) => s + e.roomAssignments.length, 0)} room(s) to OCCUPIED`);

  await prisma.$disconnect();
}

/** Sync readable-id sequences for today to be past whatever already exists. */
async function syncSequencesForToday(prisma: PrismaClient) {
  const d = new Date();
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const lookups = [
    { prefix: "INQ", delegate: prisma.inquiry },
    { prefix: "ENT", delegate: prisma.entry },
    { prefix: "RES", delegate: prisma.reservation },
    { prefix: "FOL", delegate: prisma.folio },
    { prefix: "PMT", delegate: prisma.paymentRecord },
    { prefix: "HND", delegate: prisma.handoffRecord },
    { prefix: "RA", delegate: prisma.roomAssignment },
  ] as const;
  for (const { prefix, delegate } of lookups) {
    const rows = await (delegate as { findMany: (args: { select: { id: true } }) => Promise<{ id: string }[]> }).findMany({ select: { id: true } });
    const max = rows.reduce((m, r) => {
      const match = r.id.match(new RegExp(`^${prefix}-${yyyymmdd}-(\\d+)$`));
      if (!match) return m;
      const n = Number.parseInt(match[1], 10);
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    if (max > 0) {
      await prisma.readableIdSequence.upsert({
        where: { prefix_sequenceDate: { prefix, sequenceDate: yyyymmdd } },
        create: { prefix, sequenceDate: yyyymmdd, lastValue: max },
        update: { lastValue: { set: max } },
      });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
