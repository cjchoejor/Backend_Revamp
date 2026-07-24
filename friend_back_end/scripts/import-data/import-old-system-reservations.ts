/**
 * Import reservations from the OLD system's "Reservation Viewer" API into the new S1-S9 model.
 *
 * Source (live HTTP, read-only):
 *   GET  {BASE}/api/reservation-viewer/list            -> { total, reservations: [{reservation_ref_no, ...}] }
 *   GET  {BASE}/api/reservation-viewer/detail/{ref}    -> { customer_inquiry_table:[{...}], room_reservation:[{...}] }
 *
 * The detail record carries the SAME field names as the legacy-bookings CSV importer
 * (contact_person, guest_type, guest_type_detail, arrival_date, room_no, ...), so this
 * reuses that importer's per-booking write pattern:
 *   GuestProfile -> Inquiry -> Entry -> Segment(s) -> Reservation -> RoomAssignment(s) -> Folio + FolioLines
 *
 * Notes:
 *  - Old reservation ids are NOT carried over — the new system mints its own readable ids.
 *    The original ref is kept in Inquiry.notes for traceability.
 *  - Child ages are GUESSED from the head-count buckets (above-six -> 8, otherwise -> 3),
 *    since the old system stores counts, not exact ages.
 *  - Dates are DD-MM-YYYY.
 *  - Stage: checkout in the past -> S9/CLOSED (completed), else -> S4/ACTIVE (confirmed reservation).
 *  - Rooms/room-types/agents map by number / name against the new DB (same property).
 *
 * Usage:
 *   npx tsx scripts/import-data/import-old-system-reservations.ts              # dry run (all)
 *   npx tsx scripts/import-data/import-old-system-reservations.ts --limit 5    # dry run, first 5
 *   npx tsx scripts/import-data/import-old-system-reservations.ts --limit 5 --commit
 *   npx tsx scripts/import-data/import-old-system-reservations.ts --commit     # write ALL
 *
 * Base URL override: OLD_SYSTEM_URL=http://192.168.0.101:3800
 */
import { PrismaClient, EntryStatus, FolioState, FolioLineType, Stage } from "@prisma/client";
import { allocateReadableId } from "../../src/lib/readable-id.js";

const COMMIT = process.argv.includes("--commit");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Math.max(1, parseInt(process.argv[i + 1] || "0", 10) || 0) : 0;
})();
const BASE = (process.env.OLD_SYSTEM_URL || "http://192.168.0.101:3800").replace(/\/$/, "");
const ACTOR_ID = "actor-seed-system";
const TODAY = new Date();

/* ------------------------------------------------------------------ helpers */

const trim = (v: unknown): string => (v == null ? "" : String(v)).trim();
const naToNull = (v: unknown): string | null => {
  const t = trim(v);
  if (!t || t.toLowerCase() === "na") return null;
  return t;
};
function toNum(v: unknown): number {
  const n = Number(trim(v));
  return Number.isFinite(n) ? n : 0;
}
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const t = trim(v).toLowerCase();
  return t === "t" || t === "true" || t === "1";
}
/** Parse "DD-MM-YYYY" (old-system format) into a UTC Date; null if unparseable. */
function parseDMY(v: unknown): Date | null {
  const t = trim(v);
  const m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) {
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return Number.isFinite(d.getTime()) ? d : null;
}
function splitName(full: string): { firstName: string; lastName: string } {
  // Strip a leading honorific only when it's an explicit "Title." token (with the dot) — e.g.
  // "Mr.Aditi", "Mrs.Geeta". Must NOT match a real name that merely starts with those letters
  // (e.g. "Drean" must stay "Drean", not become "ean").
  const cleaned = (full ?? "").replace(/^(Mrs|Mr|Ms|Dr)\.\s*/i, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  // Single-word / empty names have no surname to split out — leave last name blank rather
  // than inventing a placeholder.
  if (parts.length === 0) return { firstName: "Guest", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
/** Guess an ages array from the head-count buckets. above-six -> 8, the rest -> 3. */
function guessChildAges(children: number, aboveSix: number): number[] {
  const c = Math.max(0, Math.trunc(children));
  const a = Math.min(c, Math.max(0, Math.trunc(aboveSix)));
  return [...Array(a).fill(8), ...Array(c - a).fill(3)];
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Fetch detail records for all refs with a small concurrency pool. */
async function fetchDetails(refs: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const POOL = 12;
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < refs.length) {
      const ref = refs[idx++];
      try {
        out.set(ref, await fetchJson(`${BASE}/api/reservation-viewer/detail/${encodeURIComponent(ref)}`));
      } catch {
        /* leave missing; reported later */
      }
      done++;
      if (done % 200 === 0) console.log(`  fetched ${done}/${refs.length} details…`);
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  return out;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const prisma = new PrismaClient();
  console.log(`\n=== Old-system reservation import (${COMMIT ? "COMMIT" : "DRY RUN"})${LIMIT ? ` — limit ${LIMIT}` : ""} ===`);
  console.log(`Source: ${BASE}\n`);

  const list = await fetchJson(`${BASE}/api/reservation-viewer/list`);
  let refs: string[] = (list.reservations ?? []).map((r: any) => trim(r.reservation_ref_no)).filter(Boolean);
  console.log(`List: ${list.total} reservations (${refs.length} refs)`);
  if (LIMIT) refs = refs.slice(0, LIMIT);

  console.log(`Fetching ${refs.length} detail records…`);
  const details = await fetchDetails(refs);
  console.log(`  got ${details.size} details\n`);

  // Pre-load lookups from the NEW DB.
  const [travelAgents, corporates, rooms, frontDeskStaff, fallbackRatePlan] = await Promise.all([
    prisma.travelAgent.findMany({ select: { id: true, displayName: true } }),
    prisma.corporateAccount.findMany({ select: { id: true, displayName: true } }),
    prisma.room.findMany({ select: { id: true, roomNumber: true } }),
    prisma.staffUser.findFirst({ where: { actorLevel: "L1" } }),
    prisma.ratePlanRegistry.findFirst({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  if (!frontDeskStaff) throw new Error("No L1 staff found for defaultCustodianId");
  if (!fallbackRatePlan) throw new Error("No active rate plan for Reservation.frozenRatePlanId");
  const defaultCustodianId = frontDeskStaff.id;

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const agentByName = new Map<string, string>(travelAgents.map((a) => [norm(a.displayName), a.id]));
  const corpByName = new Map<string, string>(corporates.map((a) => [norm(a.displayName), a.id]));
  const roomByNo = new Map<string, string>(rooms.map((r) => [trim(r.roomNumber), r.id]));

  console.log(`Pre-loaded: ${travelAgents.length} agents, ${corporates.length} corporates, ${rooms.length} rooms`);
  console.log(`Default custodian (L1): ${defaultCustodianId}\n`);

  /** Match guest_type_detail to a travel agent / corporate. Strips a leading "XX-" code. */
  function findParty(header: any): { type: "TRAVEL_AGENT" | "CORPORATE" | null; id: string | null; name: string | null } {
    const gtype = trim(header.guest_type).toLowerCase();
    if (gtype.includes("walk")) return { type: null, id: null, name: null };
    const detail = trim(header.guest_type_detail);
    if (!detail) return { type: null, id: null, name: null };
    const candidates = [norm(detail), norm(detail.replace(/^[A-Z]{1,4}\s*-\s*/i, ""))];
    for (const key of candidates) {
      if (agentByName.has(key)) return { type: "TRAVEL_AGENT", id: agentByName.get(key)!, name: detail };
      if (corpByName.has(key)) return { type: "CORPORATE", id: corpByName.get(key)!, name: detail };
    }
    // contains-match fallback
    for (const [k, id] of agentByName) if (k.includes(candidates[1]) || candidates[1].includes(k)) return { type: "TRAVEL_AGENT", id, name: detail };
    return { type: null, id: null, name: null };
  }

  // ---- Plan / preview ----
  const stageCounts: Record<string, number> = {};
  let matchedParty = 0;
  const unmatched = new Map<string, number>();
  const samples: string[] = [];
  const missing: string[] = [];

  for (const ref of refs) {
    const d = details.get(ref);
    if (!d) { missing.push(ref); continue; }
    const h = (d.customer_inquiry_table ?? [])[0];
    if (!h) { missing.push(ref); continue; }
    const checkOut = parseDMY(h.departure_date);
    const stage = checkOut && checkOut.getTime() < TODAY.getTime() ? "S9/CLOSED" : "S4/ACTIVE";
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    const p = findParty(h);
    if (p.id) matchedParty++;
    else if (trim(h.guest_type_detail) && !trim(h.guest_type).toLowerCase().includes("walk"))
      unmatched.set(trim(h.guest_type_detail), (unmatched.get(trim(h.guest_type_detail)) ?? 0) + 1);
    if (samples.length < 6) {
      const rr = d.room_reservation ?? [];
      const roomNos = [...new Set(rr.map((r: any) => trim(r.room_no)))];
      samples.push(`  ${ref}  ${trim(h.contact_person)}  [${stage}]  ${p.name ? p.type + " " + p.name : "(walk-in)"}  rooms=${roomNos.join(",")}  ${trim(h.arrival_date)}→${trim(h.departure_date)}  adults=${toNum(h.no_of_adults)} children=${toNum(h.no_of_children)}`);
    }
  }

  console.log("Stage breakdown:");
  for (const [k, v] of Object.entries(stageCounts).sort()) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log(`\nParty link: ${matchedParty}/${refs.length} matched to an agent/corporate`);
  if (unmatched.size) {
    console.log(`Unmatched guest_type_detail (land as source-only, no FK link):`);
    for (const [k, v] of [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(v).padStart(4)}× "${k}"`);
  }
  if (missing.length) console.log(`\nDetail fetch failed for ${missing.length} refs (skipped).`);
  console.log(`\nSample:\n${samples.join("\n")}\n`);

  if (!COMMIT) {
    console.log("Dry run only. Re-run with --commit to write.\n");
    await prisma.$disconnect();
    return;
  }

  // ---- Commit ----
  // Idempotency: skip refs already imported (their Inquiry.notes carries "Original ref: <ref>").
  // Makes the importer safe to re-run without creating duplicates.
  const alreadyImported = new Set<string>();
  for (const row of await prisma.inquiry.findMany({ where: { notes: { contains: "Original ref:" } }, select: { notes: true } })) {
    const m = (row.notes ?? "").match(/Original ref:\s*(\S+)/);
    if (m) alreadyImported.add(m[1]);
  }
  if (alreadyImported.size) console.log(`Skipping ${alreadyImported.size} already-imported refs.\n`);

  console.log("Writing…\n");
  let okBookings = 0, okGuests = 0, okRes = 0, okAssign = 0, okFolios = 0, skippedRooms = 0, skippedExisting = 0;
  const errors: { ref: string; error: string }[] = [];
  const guestCache = new Map<string, string>();

  for (const ref of refs) {
    if (alreadyImported.has(ref)) { skippedExisting++; continue; }
    const d = details.get(ref);
    const h = d && (d.customer_inquiry_table ?? [])[0];
    if (!h) continue;
    try {
      const rr: any[] = d.room_reservation ?? [];
      const resvDate = parseDMY(h.reservation_date) ?? new Date();
      const checkIn = parseDMY(h.arrival_date);
      const checkOut = parseDMY(h.departure_date);
      const stagePast = !!(checkOut && checkOut.getTime() < TODAY.getTime());
      const currentStage = stagePast ? Stage.S9 : Stage.S4;
      const entryStatus = stagePast ? EntryStatus.CLOSED : EntryStatus.ACTIVE;
      const folioState = stagePast ? FolioState.SETTLED : FolioState.PROVISIONAL;
      const party = findParty(h);

      const adults = Math.max(0, toNum(h.no_of_adults));
      const children = Math.max(0, toNum(h.no_of_children));
      const childAges = guessChildAges(children, toNum(h.no_of_children_above_six));
      const roomNos = [...new Set(rr.map((r) => trim(r.room_no)).filter(Boolean))];
      const numberOfRooms = Math.max(toNum(h.no_of_rooms) || 0, roomNos.length) || 1;

      await prisma.$transaction(async (tx) => {
        // 1. Guest (dedup by phone+email+name)
        const guestName = trim(h.contact_person) || "Guest (legacy)";
        const phone = naToNull(h.contact_person_phone_no);
        const email = naToNull(h.contact_person_email);
        const gkey = `${phone ?? ""}::${email ?? ""}::${guestName.toLowerCase()}`;
        let guestProfileId = guestCache.get(gkey) ?? "";
        if (guestProfileId) {
          const exists = await tx.guestProfile.findUnique({ where: { id: guestProfileId }, select: { id: true } });
          if (!exists) guestProfileId = "";
        }
        if (!guestProfileId) {
          const { firstName, lastName } = splitName(guestName);
          const g = await tx.guestProfile.create({
            data: { firstName, lastName, email, phone, clientTier: "STANDARD", createdBy: ACTOR_ID },
          });
          guestProfileId = g.id;
          okGuests++;
        }

        // 2. Readable ids (dated by original reservation date)
        const inqId = await allocateReadableId(tx, "INQUIRY" as const, resvDate);
        const entryId = await allocateReadableId(tx, "ENTRY" as const, resvDate);

        // 3. Inquiry
        const sourceChannel = party.type === "TRAVEL_AGENT" ? "AGENT" : party.type === "CORPORATE" ? "CORPORATE" : "WALK_IN";
        const notes = [
          `Imported from old system. Original ref: ${ref}`,
          `guest_type: ${trim(h.guest_type)}`,
          trim(h.guest_type_detail) ? `guest_type_detail: ${trim(h.guest_type_detail)}` : null,
          trim(h.entered_by) ? `entered_by: ${trim(h.entered_by)}` : null,
          childAges.length ? `child ages GUESSED from buckets` : null,
        ].filter(Boolean).join(" | ");
        await tx.inquiry.create({
          data: {
            id: inqId, referenceNumber: inqId, guestProfileId, sourceChannel, defaultCustodianId, notes,
            travelAgentId: party.type === "TRAVEL_AGENT" ? party.id : null,
            corporateAccountId: party.type === "CORPORATE" ? party.id : null,
            createdAt: resvDate, createdBy: ACTOR_ID,
          },
        });

        // 4. Entry
        await tx.entry.create({
          data: {
            id: entryId, inquiryId: inqId, guestProfileId, useType: "LEISURE",
            checkInDate: checkIn, checkOutDate: checkOut,
            guestCount: adults + children || 1, adultCount: adults || null, childCount: children || null, childAges,
            numberOfRooms, segmentNumber: 1, currentStage, status: entryStatus,
            contactPersonName: guestName, contactPersonPhone: phone,
            createdAt: resvDate, updatedAt: resvDate, createdBy: ACTOR_ID,
          },
        });

        // 5. Segment(s)
        const seg1 = await tx.segment.create({
          data: { entryId, segmentNumber: 1, stage: currentStage, startedAt: resvDate, sealedAt: resvDate, sealedBy: ACTOR_ID, createdBy: ACTOR_ID, notes: "Imported (segment 1)" },
        });
        const checkIn2 = parseDMY(h.arrival_date_2);
        const checkOut2 = parseDMY(h.departure_date_2);
        if (trim(h.schedule_type).toLowerCase() === "multiple" && checkIn2 && checkOut2 && checkIn2.getTime() !== checkIn?.getTime()) {
          await tx.segment.create({
            data: { entryId, segmentNumber: 2, stage: currentStage, startedAt: checkIn2, sealedAt: resvDate, sealedBy: ACTOR_ID, createdBy: ACTOR_ID, notes: "Imported (segment 2)" },
          });
        }

        // 6. Reservation (frozen) + point Entry at it
        if (checkIn && checkOut) {
          const nights = Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
          const totalAmount = rr.reduce((s, r) => s + toNum(r.total_room_amount), 0);
          const frozenRate = totalAmount > 0 ? totalAmount / nights : toNum(rr[0]?.room_rate);
          const resId = await allocateReadableId(tx, "RESERVATION" as const, resvDate);
          await tx.reservation.create({
            data: {
              id: resId, entryId, segmentId: seg1.id, frozenRatePlanId: fallbackRatePlan.id,
              frozenBillingModel: party.type ? "DIRECT_BILL" : "GUEST_PAY",
              frozenCheckInDate: checkIn, frozenCheckOutDate: checkOut, frozenRate,
              frozenGuestCount: adults + children || 1,
              frozenInclusions: { imported: true, originalRef: ref } as object,
              confirmedAt: resvDate, confirmedBy: ACTOR_ID, createdAt: resvDate,
            },
          });
          await tx.entry.update({ where: { id: entryId }, data: { currentReservationId: resId } });
          okRes++;
        }

        // 7. Room assignments (one per unique room, date-scoped from its reserved_date rows)
        for (const roomNo of roomNos) {
          const roomId = roomByNo.get(roomNo);
          if (!roomId) { skippedRooms++; continue; }
          const dates = rr.filter((r) => trim(r.room_no) === roomNo).map((r) => parseDMY(r.reserved_date)).filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime());
          const startDate = dates[0] ?? checkIn ?? null;
          const endDate = dates.length ? new Date(dates[dates.length - 1].getTime() + 86_400_000) : checkOut ?? null;
          const raId = await allocateReadableId(tx, "ROOM_ASSIGNMENT" as const, resvDate);
          await tx.roomAssignment.create({
            data: { id: raId, entryId, roomId, assignedBy: ACTOR_ID, assignedAt: resvDate, deficientAtAssignment: false, startDate, endDate, notes: `Imported room ${roomNo}` },
          });
          okAssign++;
        }

        // 8. Folio + lines (aggregate room + meals + tax across rooms)
        const folioId = await allocateReadableId(tx, "FOLIO" as const, resvDate);
        const roomTotal = rr.reduce((s, r) => s + toNum(r.total_without_tax), 0);
        const mealTotal = rr.reduce((s, r) => s + toNum(r.breakfast_price) * toNum(r.breakfast_count) + toNum(r.lunch_price) * toNum(r.lunch_count) + toNum(r.dinner_price) * toNum(r.dinner_count) + toNum(r.map_dinner_rate) + toNum(r.map_lunch_rate) + toNum(r.cp_rate) + toNum(r.ap_rate) + toNum(r.ep_rate), 0);
        const extraBed = rr.reduce((s, r) => s + toNum(r.negotiated_extra_bed_rate) * toNum(r.no_of_extra_beds), 0);
        const taxTotal = rr.reduce((s, r) => s + toNum(r.bst) + toNum(r.service_charge), 0);
        await tx.folio.create({
          data: {
            id: folioId, entryId, state: folioState, billingModel: party.type ? "DIRECT_BILL" : "GUEST_PAY",
            outstandingBalance: 0, advancePaymentReconciliationComplete: stagePast,
            closedAt: stagePast ? checkOut : null, closedBy: stagePast ? ACTOR_ID : null,
            createdAt: resvDate, createdBy: ACTOR_ID,
          },
        });
        const lines: { type: FolioLineType; desc: string; amount: number }[] = [];
        if (roomTotal > 0) lines.push({ type: FolioLineType.ROOM_CHARGE, desc: "Room charge (imported)", amount: roomTotal });
        if (mealTotal > 0) lines.push({ type: FolioLineType.F_AND_B, desc: "Meal plan / F&B (imported)", amount: mealTotal });
        if (extraBed > 0) lines.push({ type: FolioLineType.SERVICE, desc: "Extra bed (imported)", amount: extraBed });
        if (taxTotal > 0) lines.push({ type: FolioLineType.OTHER, desc: "BST + service charge (imported)", amount: taxTotal });
        for (const l of lines) {
          await tx.folioLine.create({
            data: { folioId, lineType: l.type, description: l.desc, amount: l.amount, currency: "BTN", chargeDate: resvDate, stage: Stage.S4, postedBy: ACTOR_ID },
          });
        }
        okFolios++;

        // cache guest after tx body (committed below)
        guestCache.set(gkey, guestProfileId);
      });

      okBookings++;
      if (okBookings % 200 === 0) console.log(`  …${okBookings} bookings written`);
    } catch (e) {
      errors.push({ ref, error: (e as Error).message });
    }
  }

  console.log(`\n✓ Bookings:          ${okBookings}/${refs.length}  (skipped ${skippedExisting} already-imported)`);
  console.log(`✓ Guests created:    ${okGuests}`);
  console.log(`✓ Reservations:      ${okRes}`);
  console.log(`✓ Room assignments:  ${okAssign}  (skipped ${skippedRooms} rooms not in new inventory)`);
  console.log(`✓ Folios:            ${okFolios}`);
  if (errors.length) {
    console.log(`\n✗ Errors (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.log(`  - [${e.ref}] ${e.error}`);
    if (errors.length > 20) console.log(`  …and ${errors.length - 20} more`);
  }

  // Prisma's @updatedAt stamps updatedAt = now on every write, so every freshly-imported
  // booking would sort as "just updated" and bury the real recency signal (the desk lists
  // ORDER BY updatedAt DESC). These records haven't been touched since they were booked, so
  // align updatedAt with the preserved reservation date (createdAt). Scoped to imported rows
  // only (createdBy = seed actor) so genuinely-edited operator bookings keep their real
  // updatedAt. Raw SQL because @updatedAt can't be set through the ORM.
  const aligned = await prisma.$executeRawUnsafe(
    `UPDATE entries SET "updatedAt" = "createdAt" WHERE "createdBy" = $1 AND "updatedAt" <> "createdAt"`,
    ACTOR_ID,
  );
  console.log(`✓ Aligned updatedAt=createdAt on ${aligned} imported entries (for sane desk ordering).`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
