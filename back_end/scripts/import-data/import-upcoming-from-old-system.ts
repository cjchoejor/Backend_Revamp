/**
 * Bring the hotel's UPCOMING bookings across from the old PMS (`beta_legphel`) into this system.
 *
 * WHY A NEW IMPORTER, next to `import-legacy-bookings.ts`
 * ------------------------------------------------------
 * That one imports HISTORY — finished stays kept as a record — and for that it is right. It is
 * wrong for a booking the desk will actually work:
 *   - it posts the whole stay's room charge at import, so the night audit would charge every
 *     night a SECOND time;
 *   - it keeps no per-room composition, so a multi-room booking would be charged the whole
 *     booking's nightly rate for EVERY room;
 *   - a return visit becomes a label, so its nights are not reserved and the room reads free.
 *
 * This one writes what the desk itself would have written at "Reserve": a priced quotation
 * carrying each room's composition, a frozen reservation, a confirmed hold, dated room
 * assignments with their frozen figures, and a folio holding only money actually received.
 * Nothing is charged up front — the night audit bills each night as it passes, exactly as it
 * does for a booking made here.
 *
 * WHAT COMES ACROSS (operator's answers, 2026-09-25)
 *   - every confirmed booking whose stay reaches today or later, to July 2027;
 *   - the guests already in the hotel, landing in-house at Stay, billed from tonight onward
 *     (nights already slept stay billed in the old system);
 *   - the prices AGREED in the old system — room, meals, extra beds, per room;
 *   - a return trip as TWO bookings under ONE enquiry, per the 2026-09-25 return-stay ruling;
 *   - agencies missing from this system are created, with their old rate list as a package.
 *   - rooms held out of sale ("National Day block") are NOT bookings and are skipped.
 *
 * SAFETY
 *   - The old database is opened read-only (`default_transaction_read_only=on`); it backs the
 *     LIVE system and is never written.
 *   - Dry run by default. `--commit` writes, one transaction per booking, so a failure leaves
 *     that booking absent rather than half-made.
 *   - Re-running skips bookings already imported (matched on the old reference).
 *
 * USAGE
 *   npx tsx scripts/import-data/import-upcoming-from-old-system.ts               # dry run
 *   npx tsx scripts/import-data/import-upcoming-from-old-system.ts --limit 5     # first 5
 *   npx tsx scripts/import-data/import-upcoming-from-old-system.ts --commit
 */
import { PrismaClient, Prisma, EntryStatus, FolioState, HoldState, InventoryClaimState, PaymentDirection, QuotationState, Stage } from "@prisma/client";
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { allocateReadableId } from "../../src/lib/readable-id.js";
import { deriveCameInAs } from "../../src/lib/inquiry-came-in-as.js";
import { loadChildPolicyBundle } from "../../src/services/domain/child-policy-service.js";
import { recomputeFolioOutstandingBalance } from "../../src/lib/folio-outstanding-from-payment.js";
import { computeQuotationCompositionTotals, type RoomCompositionInput, type RoomCompositionRateContext } from "../../src/lib/room-composition.js";

const COMMIT = process.argv.includes("--commit");
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i >= 0 ? Math.max(1, parseInt(process.argv[i + 1] ?? "0", 10) || 0) : 0; })();
const ACTOR_ID = "actor-seed-system";
const IMPORT_TAG = "Imported from the old PMS";

/** The hotel's own address, entered as the "guest" email on 251 of 264 bookings. Deduplicating
 *  guests on it would merge hundreds of different people into one, so it is not an address. */
const HOUSE_EMAIL = "legphel.hotel@gmail.com";

/**
 * Hand DATE columns back as plain 'YYYY-MM-DD' text.
 *
 * By default node-pg turns a bare date into a JS Date at the MACHINE's midnight, and this PC
 * runs at UTC+6, so every later conversion moves the day backwards — a stay read as the 25th
 * becomes the 24th. Stay dates are the whole point of this import, so the driver never gets to
 * interpret them. (1082 = date, 1114 = timestamp without time zone.)
 */
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v);

const D = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n);
const money = (v: Prisma.Decimal) => v.toDecimalPlaces(2).toFixed(2);

/* ---------------------------------------------------------------- old system */

type OldRow = Record<string, unknown>;

function oldConnectionString(): string {
  const env = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.trim().startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found in back_end/.env");
  const url = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  return url.replace(/\/[^/?]+(\?|$)/, "/beta_legphel$1");
}

/** A date column read as text — never as a Date. node-pg reads a bare date at the machine's
 *  local midnight, and this PC runs at UTC+6, so converting it back to text moves it a day. */
const ymd = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 10));
/** Stay dates are stored at UTC midnight throughout this system. */
const utc = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number): string => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();
const clean = (v: unknown): string | null => { const s = str(v); return !s || s.toLowerCase() === "na" || s === "-" ? null : s; };

/* ------------------------------------------------------- agency name parsing */

/** A trailing parenthetical that reads like a RATE VARIANT is the package, not the name — the
 *  same rule `migrate-rate-cards-to-packages.ts` used when it merged the agencies. */
const VARIANT = /season|premium|room|apartment|standard|deluxe|executive|suite|map|\bep\b|\bcp\b|\bap\b|rate|group|backpacker|\d/i;

export function splitAgencyAndPackage(detail: string): { agency: string; pkg: string | null } {
  const raw = detail.trim();
  // "Pathik trips (Season)_Room" / "TRP Global connect(Traveller paradise)room" — a variant word
  // may trail the bracket, and then the bracket itself belongs to the name.
  const trailing = /^(.*\))\s*[_\-\s]*([A-Za-z][A-Za-z\s]*)$/.exec(raw);
  if (trailing && VARIANT.test(trailing[2])) {
    const inner = /^(.*?)\s*\(([^)]*)\)$/.exec(trailing[1].trim());
    if (inner && VARIANT.test(inner[2])) return { agency: inner[1].trim(), pkg: `${inner[2].trim()} ${trailing[2].trim()}`.trim() };
    return { agency: trailing[1].trim(), pkg: trailing[2].trim() };
  }
  const closed = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw);
  if (closed && VARIANT.test(closed[2])) return { agency: closed[1].trim(), pkg: closed[2].trim() };
  // "Time Traveller Holiday Experts (Premium" — the bracket was never closed.
  const open = /^(.*?)\s*\(([^)]+)$/.exec(raw);
  if (open && VARIANT.test(open[2])) return { agency: open[1].trim(), pkg: open[2].trim() };
  return { agency: raw, pkg: null };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* ------------------------------------------------------------- plan building */

type VisitRoom = {
  roomNo: string;
  nights: string[];            // ymd, ascending, unique
  rows: OldRow[];              // one per night (occasionally more — see `duplicated`)
  duplicated: boolean;         // the old data holds this room twice on at least one night
};

type Visit = {
  index: number;               // 1 or 2
  checkIn: string;
  checkOut: string;
  rooms: VisitRoom[];
  registration: OldRow | null;
  inHouse: boolean;
};

type Booking = {
  ref: string;
  reservationDate: string;
  inquiry: OldRow;
  billing: OldRow | null;
  /** The advances actually taken, in billing-row order — one per visit where there are two. */
  advances: { amount: number; mode: string }[];
  visits: Visit[];
  agencyDetail: string | null;
  guestType: string;
};

/** Split a booking's room-nights into its one or two visits. */
function buildVisits(inq: OldRow, rows: OldRow[], regs: OldRow[], today: string): Visit[] {
  const windows: { index: number; checkIn: string; checkOut: string }[] = [];
  const a1 = ymd(inq.arrival_date), d1 = ymd(inq.departure_date);
  if (a1 && d1) windows.push({ index: 1, checkIn: a1, checkOut: d1 });
  const a2 = ymd(inq.arrival_date_2), d2 = ymd(inq.departure_date_2);
  if (a2 && d2 && a2 !== a1) windows.push({ index: 2, checkIn: a2, checkOut: d2 });

  const visits: Visit[] = [];
  for (const w of windows) {
    if (w.checkOut <= today) continue;                       // that visit is over
    // The check-in record belongs to the visit whose window contains its arrival date; a guest
    // already in the hotel keeps only the nights STILL TO COME. The nights they have slept are
    // billed in the old system, and importing them would either bill them a second time here or
    // leave two systems claiming the same money.
    const reg = regs.find((r) => { const d = ymd(r.arrival_date); return d != null && d >= w.checkIn && d < w.checkOut; }) ?? null;
    const inHouse = !!reg && w.checkIn <= today && today < w.checkOut;
    const from = inHouse ? today : w.checkIn;
    const mine = rows.filter((r) => { const d = ymd(r.reserved_date)!; return d >= from && d < w.checkOut; });
    if (mine.length === 0) continue;
    const byRoom = new Map<string, OldRow[]>();
    for (const r of mine) {
      const rn = str(r.room_no);
      if (!byRoom.has(rn)) byRoom.set(rn, []);
      byRoom.get(rn)!.push(r);
    }
    const rooms: VisitRoom[] = [...byRoom.entries()].map(([roomNo, rs]) => {
      rs.sort((x, y) => ymd(x.reserved_date)!.localeCompare(ymd(y.reserved_date)!));
      // The old data sometimes holds the SAME room twice on one night (room 201 on 27 Sep, once
      // with an extra bed and once without). One night is one row here, so the duplicates are
      // reported rather than silently summed or dropped.
      const nights = [...new Set(rs.map((r) => ymd(r.reserved_date)!))];
      const duplicated = nights.length !== rs.length;
      return { roomNo, nights, rows: rs, duplicated };
    });
    visits.push({ ...w, rooms, registration: reg, inHouse });
  }
  return visits;
}

/**
 * A room's nights, cut into runs that can each be described by ONE composition row.
 *
 * A run breaks on a gap (the room is given up and taken again) and ALSO when the agreed figures
 * change — a 29-night stay that moves from 721.50 to 1,443.10 a night is two rows, not one, or
 * the whole stay would be priced at whichever night happened to be read first. Meals are the
 * exception: those are carried as per-night overrides inside the run.
 */
function runsOf(room: VisitRoom): { from: string; to: string; nights: string[] }[] {
  const sig = (n: string) => {
    const r = room.rows.find((x) => ymd(x.reserved_date) === n);
    if (!r) return "";
    return [r.negotiated_price, r.no_of_extra_beds, r.negotiated_extra_bed_rate, r.no_of_occupant,
      r.no_of_adults, r.cnb_count_six_to_ten, r.cnb_count_below_six, r.service_charge, r.bst].map(String).join("|");
  };
  const out: { from: string; to: string; nights: string[] }[] = [];
  let run: string[] = [];
  const close = () => { if (run.length) out.push({ from: run[0], to: addDays(run[run.length - 1], 1), nights: [...run] }); };
  for (const n of room.nights) {
    const contiguous = run.length > 0 && addDays(run[run.length - 1], 1) === n;
    const same = run.length > 0 && sig(run[0]) === sig(n);
    if (run.length === 0 || (contiguous && same)) run.push(n);
    else { close(); run = [n]; }
  }
  close();
  return out;
}

/** The per-guest, per-night price the old system actually charged for each meal plan.
 *
 *  Its plan columns hold the TOTAL for the covers, so the per-head price is that over the
 *  count — and a plan with a count but a rate of 0.00 was charged nothing at all (breakfast
 *  thrown in). This system honours a plan rate of 0 as deliberately free, so passing these
 *  through reproduces the agreed price rather than re-deriving one from the meal prices. */
function planRatesOf(r: OldRow): { cp: number | null; mapl: number | null; mapd: number | null; ap: number | null } {
  const per = (total: unknown, count: unknown) => { const c = num(count); return c > 0 ? num(total) / c : null; };
  return {
    cp: per(r.cp_rate, r.cp_count),
    mapl: per(r.map_lunch_rate, r.map_lunch_count),
    mapd: per(r.map_dinner_rate, r.map_dinner_count),
    ap: per(r.ap_rate, r.ap_count),
  };
}

/** One composition row per (room, contiguous run), from the old per-night rows. */
function compositionFor(room: VisitRoom, run: { from: string; to: string; nights: string[] }, roomId: string): RoomCompositionInput & { roomId: string } {
  const rows = run.nights.map((n) => room.rows.find((r) => ymd(r.reserved_date) === n)!).filter(Boolean);
  const first = rows[0];
  // The night that carries the most people decides the room-level composition; nights that
  // differ are recorded as per-night meal overrides below.
  const lead = rows.reduce((best, r) => (num(r.no_of_occupant) > num(best.no_of_occupant) ? r : best), first);
  const mealsOf = (r: OldRow) => ({
    mealPlanCpCount: num(r.cp_count), mealPlanMaplCount: num(r.map_lunch_count),
    mealPlanMapdCount: num(r.map_dinner_count), mealPlanApCount: num(r.ap_count),
    mealPlanOthersCount: num(r.other_meal_count),
  });
  const leadMeals = mealsOf(lead);
  // A plan with covers but no price = the meals were thrown in; its constituents cost nothing.
  const leadPlans = planRatesOf(lead);
  const freeRoom = (["cp", "mapl", "mapd", "ap"] as const).some((k) => leadPlans[k] === 0);
  const overrides = rows
    .filter((r) => JSON.stringify(mealsOf(r)) !== JSON.stringify(leadMeals))
    .map((r) => ({ date: utc(ymd(r.reserved_date)!), ...mealsOf(r), extraBedCount: num(r.no_of_extra_beds) }));

  return {
    roomId,
    // Real Dates, not strings: the pricing core reads these to place each night.
    startDate: utc(run.from),
    endDate: utc(run.to),
    occupantCount: num(lead.no_of_occupant),
    adultCount: num(lead.no_of_adults),
    cnb6To10Count: num(lead.cnb_count_six_to_ten),
    cnbUnder6Count: num(lead.cnb_count_below_six),
    extraBedCount: num(lead.no_of_extra_beds),
    ...leadMeals,
    othersBreakfastPax: 0, othersLunchPax: 0, othersDinnerPax: 0,
    // The agreed prices. Meal-plan rates in the old system are totals for the covers; the
    // per-head prices sit in their own columns, which is what this system wants.
    negotiatedRoomRate: num(lead.negotiated_price),
    negotiatedExtraBedRate: num(lead.negotiated_extra_bed_rate),
    // The agreed per-meal prices — but ZEROED when the plan using them was given away. A
    // negotiated constituent meal BEATS a plan rate in this system's pricing, so a room whose
    // plan carries a count with a 0.00 rate (breakfast thrown in) would otherwise be charged
    // for it.
    negotiatedBreakfastRate: freeRoom ? 0 : num(lead.breakfast_price),
    negotiatedLunchRate: freeRoom ? 0 : num(lead.lunch_price),
    negotiatedDinnerRate: freeRoom ? 0 : num(lead.dinner_price),
    serviceChargeApplies: num(lead.service_charge) > 0,
    gstApplies: num(lead.bst) > 0,
    // The old system's `foc` flag does NOT mean the room was free — flagged rooms are still
    // charged in full on their own row (any concession is taken at billing level instead). So
    // it is carried as a note, not as a price: treating it as free undercharged the stay by a
    // whole room-night. A room genuinely priced at nothing is free here too.
    isFoc: num(lead.total_without_tax) === 0,
    nightMealOverrides: overrides.length ? overrides : undefined,
    planRates: planRatesOf(lead),
  } as RoomCompositionInput & { roomId: string; planRates: ReturnType<typeof planRatesOf> };
}

/* ----------------------------------------------------------------- the script */

async function main() {
  const prisma = new PrismaClient();
  const old = new pg.Client({ connectionString: oldConnectionString(), options: "-c default_transaction_read_only=on" });
  await old.connect();
  const q = async (sql: string, params: unknown[] = []): Promise<OldRow[]> => (await old.query(sql, params)).rows;

  const today = String((await q(`select ((now() at time zone 'Asia/Thimphu')::date)::text d`))[0].d);
  console.log(`\n=== Upcoming bookings from the old PMS (${COMMIT ? "COMMIT" : "DRY RUN"}) ===`);
  console.log(`today at the hotel: ${today}\n`);

  /* ---- scope: confirmed, has real (non-blocked) room-nights, stay reaches today ---- */
  const inquiries = await q(
    `select ci.* from customer_inquiry_table ci
      where greatest(ci.departure_date, coalesce(ci.departure_date_2, ci.departure_date)) > $1::date
        and ci.inquiry_status
        and exists (select 1 from room_reservation rr
                     where rr.reservation_ref_no = ci.reservation_ref_no and rr.reservation_status <> 'blocked')
      order by ci.arrival_date`, [today]);
  const refs = inquiries.map((r) => str(r.reservation_ref_no));
  const roomRows = await q(`select * from room_reservation where reservation_ref_no = any($1) and reservation_status <> 'blocked'`, [refs]);
  const billings = await q(`select * from reservation_billing where reservation_ref_no = any($1)`, [refs]);
  const registrations = await q(`select * from registration_form where reservation_ref_no = any($1)`, [refs]);
  const packageRates = await q(`select * from package_rate`);
  await old.end();

  const rowsByRef = new Map<string, OldRow[]>();
  for (const r of roomRows) { const k = str(r.reservation_ref_no); if (!rowsByRef.has(k)) rowsByRef.set(k, []); rowsByRef.get(k)!.push(r); }
  // A booking can carry several billing rows (a return trip bills each visit; some are simply
  // entered twice), so they are kept as a list rather than last-one-wins.
  const billsByRef = new Map<string, OldRow[]>();
  for (const x of billings) { const k = str(x.reservation_ref_no); if (!billsByRef.has(k)) billsByRef.set(k, []); billsByRef.get(k)!.push(x); }
  const regsByRef = new Map<string, OldRow[]>();
  for (const r of registrations) { const k = str(r.reservation_ref_no); if (!regsByRef.has(k)) regsByRef.set(k, []); regsByRef.get(k)!.push(r); }
  const rateByName = new Map(packageRates.map((p) => [norm(str(p.travel_agent_name)), p]));

  const bookings: Booking[] = [];
  for (const inq of inquiries) {
    const ref = str(inq.reservation_ref_no);
    const visits = buildVisits(inq, rowsByRef.get(ref) ?? [], regsByRef.get(ref) ?? [], today);
    if (visits.length === 0) continue;
    bookings.push({
      ref,
      reservationDate: ymd(inq.reservation_date) ?? today,
      inquiry: inq,
      billing: billsByRef.get(ref)?.[0] ?? null,
      advances: advancesOf(billsByRef.get(ref) ?? []),
      visits,
      agencyDetail: clean(inq.guest_type_detail),
      guestType: str(inq.guest_type),
    });
  }
  console.log(`bookings in scope: ${bookings.length}  ·  stays to create: ${bookings.reduce((s, b) => s + b.visits.length, 0)}`);
  console.log(`  of those, guests already in the hotel: ${bookings.filter((b) => b.visits.some((v) => v.inHouse)).length}`);
  console.log(`  return trips (two stays, one enquiry): ${bookings.filter((b) => b.visits.length > 1).length}\n`);

  /* ---- what this system already has ---- */
  const [roomsDb, agentsDb, ratePlan, childPolicy, scRate, gstRate, alreadyImported] = await Promise.all([
    prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true } }),
    prisma.travelAgent.findMany({ select: { id: true, displayName: true, ratePackages: { where: { effectiveTo: null }, select: { id: true, name: true, isDefault: true } } } }),
    prisma.ratePlanRegistry.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } }),
    loadChildPolicyBundle(prisma),
    prisma.configurationEntry.findFirst({ where: { configKey: "billing.serviceChargeRate", effectiveTo: null }, select: { configValue: true } }),
    prisma.configurationEntry.findFirst({ where: { configKey: "billing.salesTaxRate", effectiveTo: null }, select: { configValue: true } }),
    prisma.inquiry.findMany({ where: { notes: { contains: IMPORT_TAG } }, select: { id: true, notes: true } }),
  ]);
  if (!ratePlan) throw new Error("no active rate plan — Reservation.frozenRatePlanId needs one");
  const roomByNo = new Map(roomsDb.map((r) => [r.roomNumber, r]));
  const agentByName = new Map(agentsDb.map((a) => [norm(a.displayName), a]));
  const serviceChargeRate = Number(scRate?.configValue ?? 0.1);
  const salesTaxRate = Number(gstRate?.configValue ?? 0.05);
  const doneRefs = new Set<string>();
  for (const i of alreadyImported) { const m = /old reference: (\S+)/.exec(i.notes ?? ""); if (m) doneRefs.add(m[1]); }
  if (doneRefs.size) console.log(`already imported in an earlier run: ${doneRefs.size} (they will be skipped)\n`);

  /* ---- agencies this system doesn't have yet ---- */
  type NewAgency = { agency: string; packages: { name: string; rate: OldRow | null }[]; bookings: number };
  const toCreate = new Map<string, NewAgency>();
  const resolveAgency = (detail: string | null, guestType: string) => {
    if (!detail || !/agent/i.test(guestType)) return null;
    if (agentByName.has(norm(detail))) return { key: norm(detail), pkg: null as string | null };
    const { agency, pkg } = splitAgencyAndPackage(detail);
    return { key: norm(agency), pkg, agencyName: agency, detail };
  };
  for (const b of bookings) {
    const r = resolveAgency(b.agencyDetail, b.guestType);
    if (!r || agentByName.has(r.key)) continue;
    const name = (r as { agencyName?: string }).agencyName ?? b.agencyDetail!;
    if (!toCreate.has(r.key)) toCreate.set(r.key, { agency: name, packages: [], bookings: 0 });
    const e = toCreate.get(r.key)!;
    e.bookings++;
    const pkgName = r.pkg ?? "Standard";
    if (!e.packages.some((p) => norm(p.name) === norm(pkgName))) {
      e.packages.push({ name: pkgName, rate: rateByName.get(norm(b.agencyDetail!)) ?? rateByName.get(r.key) ?? null });
    }
  }
  console.log(`agencies to add to this system: ${toCreate.size} (${[...toCreate.values()].reduce((s, a) => s + a.bookings, 0)} bookings)`);
  for (const a of [...toCreate.values()].slice(0, 6)) console.log(`  ${a.agency} — packages: ${a.packages.map((p) => `${p.name}${p.rate ? "" : " (default rates)"}`).join(", ")}`);
  if (toCreate.size > 6) console.log(`  …and ${toCreate.size - 6} more`);
  console.log();

  /* ---- price every stay and check it against the old system ---- */
  const ctxFor = (nights: number, plans: { cp: number | null; mapl: number | null; mapd: number | null; ap: number | null }): RoomCompositionRateContext => ({
    defaultRoomRate: D(0), defaultExtraBedRate: D(0), defaultBreakfastRate: D(0),
    defaultLunchRate: D(0), defaultDinnerRate: D(0),
    // Each plan is charged exactly what the old system charged for it — including nothing.
    defaultCpRate: plans.cp == null ? null : D(plans.cp),
    defaultMapLunchRate: plans.mapl == null ? null : D(plans.mapl),
    defaultMapDinnerRate: plans.mapd == null ? null : D(plans.mapd),
    defaultApRate: plans.ap == null ? null : D(plans.ap),
    serviceChargeRate, gstRate: salesTaxRate,
    childMealPricing: childPolicy.mealPricing,
    nights,
  });

  type PricedStay = { booking: Booking; visit: Visit; comps: (RoomCompositionInput & { roomId: string; planRates: ReturnType<typeof planRatesOf> })[]; totals: ReturnType<typeof computeQuotationCompositionTotals>; oldTotal: number; oldTotalRaw: number; skippedRooms: string[] };
  const priced: PricedStay[] = [];
  const problems: string[] = [];

  for (const b of bookings) {
    if (doneRefs.has(b.ref)) continue;
    for (const v of b.visits) {
      const comps: (RoomCompositionInput & { roomId: string; planRates: ReturnType<typeof planRatesOf> })[] = [];
      const skippedRooms: string[] = [];
      for (const room of v.rooms) {
        const dbRoom = roomByNo.get(room.roomNo);
        if (!dbRoom) { skippedRooms.push(room.roomNo); continue; }
        for (const run of runsOf(room)) comps.push(compositionFor(room, run, dbRoom.id));
      }
      if (comps.length === 0) { problems.push(`${b.ref} visit ${v.index}: no rooms could be matched`); continue; }
      // Each room is priced over ITS OWN nights, not the visit's. A room taken for 15 nights of
      // a 30-night stay must not be charged for 30 — that was a straight doubling.
      const totals = computeQuotationCompositionTotals(comps.map((input) => ({
        input, roomId: input.roomId,
        roomNumber: roomsDb.find((r) => r.id === input.roomId)?.roomNumber ?? null,
        ctx: ctxFor(
          Math.max(1, Math.round(((input.endDate as Date).getTime() - (input.startDate as Date).getTime()) / 86_400_000)),
          (input as unknown as { planRates: { cp: number | null; mapl: number | null; mapd: number | null; ap: number | null } }).planRates,
        ),
      })));
      // What the old system charged — counting each room-night ONCE. It sometimes holds the same
      // room twice on a night, and summing its rows raw would make its own total the thing that
      // looks wrong. `oldTotalRaw` keeps the unfiltered figure so the duplicates are still named.
      const oldTotal = v.rooms.reduce((s, r) => {
        const seen = new Set<string>();
        return s + r.rows.reduce((t, row) => { const d = ymd(row.reserved_date)!; if (seen.has(d)) return t; seen.add(d); return t + num(row.total_room_amount); }, 0);
      }, 0);
      const oldTotalRaw = v.rooms.reduce((s, r) => s + r.rows.reduce((t, row) => t + num(row.total_room_amount), 0), 0);
      priced.push({ booking: b, visit: v, comps, totals, oldTotal, oldTotalRaw, skippedRooms });
    }
  }

  // `--explain RES_…` prints one stay room by room: what was read, what was charged, and what
  // the old system charged. It is how every difference above was settled.
  const explain = (() => { const i = process.argv.indexOf("--explain"); return i >= 0 ? str(process.argv[i + 1]) : null; })();
  if (explain) {
    for (const p of priced.filter((x) => x.booking.ref === explain)) {
      console.log(`\n--- ${p.booking.ref} visit ${p.visit.index} · ${p.visit.checkIn} → ${p.visit.checkOut}`);
      for (const [i, c] of p.comps.entries()) {
        const row = p.totals.perRoom[i];
        const old = p.visit.rooms.find((r) => roomByNo.get(r.roomNo)?.id === c.roomId);
        const oldAmt = old ? old.rows.reduce((s, r) => s + num(r.total_room_amount), 0) : 0;
        console.log(`  room ${row.roomNumber ?? c.roomId} ${(c.startDate as Date).toISOString().slice(0, 10)}→${(c.endDate as Date).toISOString().slice(0, 10)} · ${row.nights}n`);
        console.log(`    read : occ ${c.occupantCount} (${c.adultCount}a ${c.cnb6To10Count}×6-10 ${c.cnbUnder6Count}×<6) · beds ${c.extraBedCount} · plans cp${c.mealPlanCpCount} mapl${c.mealPlanMaplCount} mapd${c.mealPlanMapdCount} ap${c.mealPlanApCount} · planRates ${JSON.stringify(c.planRates)}`);
        console.log(`    rates: room ${c.negotiatedRoomRate} bed ${c.negotiatedExtraBedRate} b/l/d ${c.negotiatedBreakfastRate}/${c.negotiatedLunchRate}/${c.negotiatedDinnerRate}`);
        console.log(`    this : room ${money(row.roomRate)}×${row.nights} · meals ${money(row.mealsSubtotal)} · beds ${money(row.extraBedSubtotal)} · net ${money(row.subtotal)} → ${money(row.total)}   old: ${oldAmt.toFixed(2)}`);
      }
      console.log(`  stay: this ${money(p.totals.total)} vs old ${p.oldTotal.toFixed(2)}`);
    }
    console.log();
  }

  const tolerance = 1;
  const mismatched = priced.filter((p) => Math.abs(Number(p.totals.total) - p.oldTotal) > tolerance);
  console.log(`priced ${priced.length} stay(s) · totals matching the old system: ${priced.length - mismatched.length} · differing: ${mismatched.length}`);
  /**
   * Every difference found on 25 Sep 2026 was one of three things, and each is named rather
   * than left as a number: the first two are the old data or the hotel's own policy, and only
   * the third is worth a second look before the guest is billed.
   */
  const why = (m: PricedStay): string => {
    const mine = Number(m.totals.total);
    if (mine < m.oldTotal && m.comps.some((c) => (c.cnbUnder6Count ?? 0) > 0))
      return "a child under 6 eats free under this hotel's policy";
    return "the old figure does not follow its own per-head rate — CHECK before the guest is billed";
  };
  for (const m of mismatched) {
    console.log(`  ${m.booking.ref} visit ${m.visit.index}: ${money(m.totals.total)} here vs ${m.oldTotal.toFixed(2)} there (${(Number(m.totals.total) - m.oldTotal).toFixed(2)})`);
    console.log(`      ${why(m)}`);
  }
  if (problems.length) { console.log(`\nproblems:`); for (const p of problems.slice(0, 10)) console.log(`  ${p}`); }
  const skipped = priced.filter((p) => p.skippedRooms.length);
  if (skipped.length) console.log(`\nstays with a room this system doesn't have: ${skipped.length}`);

  if (!COMMIT && !process.argv.includes("--fix-advances")) {
    console.log(`\nDry run — nothing written. Re-run with --commit.\n`);
    await prisma.$disconnect();
    return;
  }

  /* ------------------------------------------------------------------ writing */

  /**
   * `--fix-advances` — put right the money on bookings ALREADY imported, and write nothing else.
   *
   * The first run of this importer read `advance_payment` as an amount when it is a boolean over
   * there, so every advance landed as Nu 1.00. This reconciles each imported folio against what
   * the old system actually holds: the wrong rows go, the right one is written, the balance is
   * recomputed. It is idempotent — a folio that already agrees is left untouched.
   */
  if (process.argv.includes("--fix-advances")) {
    const byRef = new Map(bookings.map((b) => [b.ref, b]));
    const imported = await prisma.inquiry.findMany({
      where: { notes: { contains: IMPORT_TAG } },
      select: {
        id: true, notes: true,
        entries: {
          orderBy: { checkInDate: "asc" },
          select: {
            id: true, quotations: { select: { totalAmount: true }, take: 1 },
            folio: { select: { id: true, createdAt: true, payments: { select: { id: true, amount: true, notes: true } } } },
          },
        },
      },
    });
    let agreed = 0, changed = 0;
    for (const inq of imported) {
      const ref = /old reference: (\S+)/.exec(inq.notes ?? "")?.[1];
      const b = ref ? byRef.get(ref) : null;
      if (!b) continue;
      for (const [i, e] of inq.entries.entries()) {
        const folio = e.folio;
        if (!folio) continue;
        const want = b.advances[i] ?? null;
        const mine = folio.payments.filter((p) => (p.notes ?? "").includes("Advance taken in the old system"));
        const have = mine.reduce((s, p) => s + Number(p.amount), 0);
        if (mine.length === (want ? 1 : 0) && Math.abs(have - (want?.amount ?? 0)) < 0.005) { agreed++; continue; }
        changed++;
        console.log(`  ${ref} ${e.id}: ${have.toFixed(2)} → ${(want?.amount ?? 0).toFixed(2)}${want ? ` (${paymentMethod(want.mode)})` : ""}`);
        // The old system bills a return trip on ONE row, so its advance can be more than the
        // stay it lands on. Splitting it between the two visits would be inventing an
        // allocation nobody made, so it is recorded where it was billed and said out loud.
        const stayTotal = Number(e.quotations[0]?.totalAmount ?? 0);
        if (want && stayTotal > 0 && want.amount > stayTotal + 0.005) {
          console.log(`      NOTE: more than this stay costs (${stayTotal.toFixed(2)}) — the old system billed the whole trip on one row`);
        }
        if (!COMMIT) continue;
        await prisma.$transaction(async (tx) => {
          for (const p of mine) await tx.paymentRecord.delete({ where: { id: p.id } });
          if (want) {
            const method = paymentMethod(want.mode);
            await tx.paymentRecord.create({
              data: {
                id: await allocateReadableId(tx, "PAYMENT", folio.createdAt), folioId: folio.id, entryId: e.id,
                amount: D(want.amount), currency: "BTN", paymentMethod: method,
                paymentDirection: PaymentDirection.IN, receivedAt: folio.createdAt, recordedBy: ACTOR_ID,
                stage: Stage.S3, billingModel: "GUEST_PAY",
                notes: `Advance taken in the old system · reference ${b.ref}${method === "OTHER" ? " · it did not record how the money arrived" : ""}`,
              },
            });
          }
          await recomputeFolioOutstandingBalance(tx, folio.id);
        });
      }
    }
    console.log(`\nadvances already right: ${agreed} · ${COMMIT ? "corrected" : "would correct"}: ${changed}\n`);
    await prisma.$disconnect();
    return;
  }

  const custodian =
    (await prisma.staffUser.findFirst({ where: { actorLevel: "L1", isActive: true }, orderBy: { id: "asc" }, select: { id: true } })) ??
    (await prisma.staffUser.findFirst({ orderBy: { id: "asc" }, select: { id: true } }));
  if (!custodian) throw new Error("no staff user on file — every inquiry needs a custodian");

  /* ---- the agencies, before the bookings that point at them ---- */
  for (const [key, a] of toCreate) {
    const agentId = await allocateReadableId(prisma, "TRAVEL_AGENT", utc(today));
    const phones = [...new Set(a.packages.map((p) => clean(p.rate?.contact_number)).filter((x): x is string => !!x))];
    const agent = await prisma.travelAgent.create({
      data: {
        id: agentId, displayName: a.agency, contactNumbers: phones, modeOfContact: "PHONE",
        notes: `${IMPORT_TAG} — the agency as the old system names it`, createdBy: ACTOR_ID,
      },
    });
    const made: { id: string; name: string; isDefault: boolean }[] = [];
    for (const [i, p] of a.packages.entries()) {
      const r = p.rate;
      const rate = (col: string) => (r && r[col] != null ? D(num(r[col])) : null);
      const pkg = await prisma.ratePackage.create({
        data: {
          scope: "TRAVEL_AGENT", travelAgentId: agent.id, name: p.name, isDefault: i === 0,
          // No rate list on file = no rates agreed; a blank field on a package is deliberately
          // NOT the house price, so each booking's own negotiated figures carry it instead.
          roomBaseRate: rate("room_base_rate") ?? D(0),
          extraBedRate: rate("extra_bed_rate"), cnbPercent: r?.cnb_percent == null ? null : Number(r.cnb_percent),
          breakfastRate: rate("breakfast_rate"), lunchRate: rate("lunch_rate"), dinnerRate: rate("dinner_rate"),
          cpRate: rate("cp_rate"), mapLunchRate: rate("map_lunch_rate"), mapDinnerRate: rate("map_dinner_rate"), apRate: rate("ap_rate"),
          notes: r ? `${IMPORT_TAG} — the agency's rate list in the old system` : `${IMPORT_TAG} — no rates on file there`,
          createdBy: ACTOR_ID,
        },
        select: { id: true, name: true, isDefault: true },
      });
      made.push(pkg);
    }
    agentByName.set(key, { id: agent.id, displayName: a.agency, ratePackages: made });
    console.log(`  + ${a.agency} (${agent.id}) · ${made.length} package(s)`);
  }
  if (toCreate.size) console.log();

  /** Which agency and which of its packages a booking was quoted on. */
  const linkFor = (b: Booking) => {
    const r = resolveAgency(b.agencyDetail, b.guestType);
    const agent = r ? agentByName.get(r.key) : null;
    if (!agent) return { travelAgentId: null, ratePackageId: null };
    const want = r!.pkg ? agent.ratePackages.find((p) => norm(p.name) === norm(r!.pkg!)) : null;
    const pkg = want ?? agent.ratePackages.find((p) => p.isDefault) ?? agent.ratePackages[0] ?? null;
    return { travelAgentId: agent.id, ratePackageId: pkg?.id ?? null };
  };

  /* ---- one transaction per booking ---- */
  const byBooking = new Map<string, PricedStay[]>();
  for (const p of priced) {
    if (!byBooking.has(p.booking.ref)) byBooking.set(p.booking.ref, []);
    byBooking.get(p.booking.ref)!.push(p);
  }

  let written = 0, stays = 0, failed = 0;
  const occupiedNow: { roomId: string; entryId: string }[] = [];

  for (const [ref, group] of byBooking) {
    if (LIMIT && written >= LIMIT) break;
    const b = group[0].booking;
    try {
      const madeRooms = await prisma.$transaction(async (tx) => {
        const live: { roomId: string; entryId: string }[] = [];
        const reservedAt = utc(b.reservationDate);
        const billing = b.billing;
        const reg = b.visits.find((v) => v.registration)?.registration ?? null;

        /* the guest. Never deduplicated: 251 of these bookings carry the HOTEL's own address
         * and the agencies share their phones, so any match would merge strangers. */
        const fullName = clean(billing?.primary_customer_name) ?? clean(reg?.name) ?? clean(b.inquiry.contact_person) ?? "Guest";
        const guestEmail = clean(billing?.email);
        const guest = await tx.guestProfile.create({
          data: {
            ...splitName(fullName),
            email: guestEmail && guestEmail.toLowerCase() !== HOUSE_EMAIL ? guestEmail : null,
            phone: clean(billing?.phone_no) ?? clean(reg?.phone_no),
            nationality: clean(reg?.nationality) ?? clean(billing?.country),
            clientTier: "STANDARD", createdBy: ACTOR_ID,
          },
        });

        /* the enquiry — ONE for the whole booking, so a return trip's two stays sit under it
         * (the 2026-09-25 return-stay ruling). Its notes carry the old reference, which is also
         * how a re-run knows this booking is already here. */
        const link = linkFor(b);
        const sourceChannel = link.travelAgentId ? "AGENT" : "DIRECT";
        const inqId = await allocateReadableId(tx, "INQUIRY", reservedAt);
        await tx.inquiry.create({
          data: {
            id: inqId, referenceNumber: inqId, guestProfileId: guest.id,
            sourceChannel, cameInAs: deriveCameInAs({ sourceChannel }), defaultCustodianId: custodian.id,
            notes: [
              `${IMPORT_TAG} · old reference: ${b.ref}`,
              b.agencyDetail ? `booked as: ${b.agencyDetail}` : null,
              clean(b.inquiry.inquiry_remarks), clean(billing?.special_preferences),
            ].filter(Boolean).join(" · "),
            travelAgentId: link.travelAgentId, ratePackageId: link.ratePackageId,
            createdAt: reservedAt, createdBy: ACTOR_ID,
          },
        });

        for (const stay of group) {
          const v = stay.visit;
          const comps = stay.comps;
          const roomIds = [...new Set(comps.map((c) => c.roomId))];
          // One row per room decides the head count — a room cut into two runs (its agreed
          // figures changed mid-stay) must not have its guests counted twice.
          const leadPerRoom = roomIds.map((id) => comps.filter((c) => c.roomId === id).reduce((a, c) => ((c.occupantCount ?? 0) > (a.occupantCount ?? 0) ? c : a)));
          const adults = leadPerRoom.reduce((s, c) => s + (c.adultCount ?? 0), 0);
          const kids6to10 = leadPerRoom.reduce((s, c) => s + (c.cnb6To10Count ?? 0), 0);
          const kidsUnder6 = leadPerRoom.reduce((s, c) => s + (c.cnbUnder6Count ?? 0), 0);
          // The old system records children by BAND, never by age. One representative age per
          // band keeps this system's banding identical without inventing precision.
          const childAges = [...Array(kids6to10).fill(8), ...Array(kidsUnder6).fill(3)];

          const entryId = await allocateReadableId(tx, "ENTRY", reservedAt);
          const stage: Stage = v.inHouse ? "S7" : "S4";
          const beds = { KING: num(billing?.king_bed), TWIN: num(billing?.twin_bed) };
          const bedRequest = Object.fromEntries(Object.entries(beds).filter(([, n]) => n > 0));

          await tx.entry.create({
            data: {
              id: entryId, inquiryId: inqId, guestProfileId: guest.id, useType: "LEISURE",
              // The arrival the guest actually has. For someone already in the hotel this is in
              // the past — true, and what the desk should show; only the BILLING starts tonight.
              checkInDate: utc(v.checkIn), checkOutDate: utc(v.checkOut),
              guestCount: Math.max(1, adults + kids6to10 + kidsUnder6),
              adultCount: adults, childCount: kids6to10 + kidsUnder6, childAges,
              numberOfRooms: roomIds.length,
              bedTypeRequest: v.index === 1 && Object.keys(bedRequest).length ? bedRequest : undefined,
              segmentNumber: 1, currentStage: stage, status: EntryStatus.ACTIVE, otaSource: false,
              contactPersonName: clean(b.inquiry.contact_person),
              contactPersonPhone: clean(b.inquiry.contact_person_phone_no),
              contactPersonEmail: clean(b.inquiry.contact_person_email),
              expectedArrivalTime: arrivalTime(reg),
              createdAt: reservedAt, createdBy: ACTOR_ID,
            },
          });
          const segment = await tx.segment.create({
            data: { entryId, segmentNumber: 1, stage, startedAt: reservedAt, createdBy: ACTOR_ID },
          });
          await tx.stageDwellRecord.create({ data: { entryId, stage, enteredAt: reservedAt, lastActiveAt: reservedAt } });

          /* the sealed room selection, night by night — what the desk's Inquiry step writes */
          const perNight = nightsOf(v.checkIn, v.checkOut)
            .map((date) => ({ date, roomIds: comps.filter((c) => covers(c, date)).map((c) => ({ roomId: c.roomId, isDeficient: false })) }))
            .filter((n) => n.roomIds.length > 0);
          await tx.availabilityConfiguration.create({
            data: {
              entryId, segmentId: segment.id,
              searchCriteria: { checkIn: v.checkIn, checkOut: v.checkOut, imported: true, oldReference: b.ref },
              resultSet: { imported: true },
              optionSelected: { perNight, isDeficient: false },
              sealedAt: reservedAt, createdBy: ACTOR_ID,
            },
          });

          /* the priced quotation, accepted — the commercial basis every later stage reads */
          const quoId = await allocateReadableId(tx, "QUOTATION", reservedAt);
          const roomCompositions = comps.map(({ planRates: _p, ...c }) => c);
          const anchorRoom = roomsDb.find((r) => r.id === mostNights(comps))!;
          const commercialTerms = {
            roomTypeId: anchorRoom.roomTypeId, useType: "LEISURE", currency: "BTN",
            roomCount: roomIds.length,
            roomCompositions,
            compositionTotals: serialise(stay.totals),
            importedFrom: { system: "old PMS", reference: b.ref, visit: v.index, agencyAsEntered: b.agencyDetail },
            notes: `${IMPORT_TAG}. The figures are the ones agreed in the old system.`,
          };
          await tx.quotation.create({
            data: {
              id: quoId, entryId, segmentId: segment.id, referenceNumber: quoId,
              state: QuotationState.ACCEPTED, commercialTerms: commercialTerms as Prisma.InputJsonValue,
              totalAmount: stay.totals.total.toDecimalPlaces(2), currency: "BTN",
              acceptedAt: reservedAt, acceptedBy: ACTOR_ID, sealedAt: reservedAt,
              createdAt: reservedAt, createdBy: ACTOR_ID,
            },
          });

          /* frozen reservation + confirmed hold: the booking is committed, as it is over there */
          const resId = await allocateReadableId(tx, "RESERVATION", reservedAt);
          const reservation = await tx.reservation.create({
            data: {
              id: resId, entryId, segmentId: segment.id,
              // The headline rate, for the surfaces that show one figure. The real money is the
              // per-room composition below it.
              frozenRate: comps[0].negotiatedRoomRate != null ? D(comps[0].negotiatedRoomRate) : D(0),
              frozenRatePlanId: ratePlan.id, frozenBillingModel: "GUEST_PAY",
              frozenCheckInDate: utc(v.checkIn), frozenCheckOutDate: utc(v.checkOut),
              frozenGuestCount: Math.max(1, adults + kids6to10 + kidsUnder6),
              frozenCommercialTerms: commercialTerms as Prisma.InputJsonValue,
              confirmedAt: reservedAt, confirmedBy: ACTOR_ID, sealedAt: reservedAt, createdAt: reservedAt,
            },
          });
          await tx.entry.update({ where: { id: entryId }, data: { currentReservationId: reservation.id } });
          await tx.committedHold.create({
            data: {
              entryId, segmentId: segment.id, roomId: anchorRoom.id, roomTypeId: anchorRoom.roomTypeId,
              state: HoldState.CONFIRMED, placedAt: reservedAt, placedBy: ACTOR_ID,
              confirmedAt: reservedAt, confirmedBy: ACTOR_ID,
              commercialJustification: `${IMPORT_TAG} · old reference ${b.ref}`,
              // A confirmed hold never expires — the reservation is what holds the rooms, and
              // the claim reads the rooms off this breakdown night by night.
              ttlSeconds: 0, expiresAt: utc(v.checkOut), perNightBreakdown: perNight,
            },
          });

          /* dated room assignments, each carrying its own frozen figures — what the night audit
           * bills from. One row per (room, run): a room whose agreed rate changed mid-stay has
           * two, exactly as a mid-stay change would leave here. */
          for (const [i, c] of comps.entries()) {
            const row = stay.totals.perRoom[i];
            const raId = await allocateReadableId(tx, "ROOM_ASSIGNMENT", reservedAt);
            await tx.roomAssignment.create({
              data: {
                id: raId, entryId, roomId: c.roomId,
                startDate: c.startDate as Date, endDate: c.endDate as Date,
                assignedAt: reservedAt, assignedBy: ACTOR_ID,
                occupantCount: c.occupantCount, adultCount: c.adultCount,
                cnb6To10Count: c.cnb6To10Count, cnbUnder6Count: c.cnbUnder6Count, extraBedCount: c.extraBedCount,
                mealPlanCpCount: c.mealPlanCpCount ?? 0, mealPlanMaplCount: c.mealPlanMaplCount ?? 0,
                mealPlanMapdCount: c.mealPlanMapdCount ?? 0, mealPlanApCount: c.mealPlanApCount ?? 0,
                mealPlanOthersCount: c.mealPlanOthersCount ?? 0,
                negotiatedRoomRate: c.negotiatedRoomRate != null ? D(c.negotiatedRoomRate) : null,
                negotiatedExtraBedRate: c.negotiatedExtraBedRate != null ? D(c.negotiatedExtraBedRate) : null,
                negotiatedBreakfastRate: c.negotiatedBreakfastRate != null ? D(c.negotiatedBreakfastRate) : null,
                negotiatedLunchRate: c.negotiatedLunchRate != null ? D(c.negotiatedLunchRate) : null,
                negotiatedDinnerRate: c.negotiatedDinnerRate != null ? D(c.negotiatedDinnerRate) : null,
                serviceChargeApplies: c.serviceChargeApplies ?? true, gstApplies: c.gstApplies ?? true,
                isFoc: c.isFoc ?? false,
                frozenSubtotal: row.subtotal.toDecimalPlaces(2), frozenTotal: row.total.toDecimalPlaces(2),
                notes: `${IMPORT_TAG} · old reference ${b.ref}`,
              },
            });
            if (v.inHouse) live.push({ roomId: c.roomId, entryId });
          }

          /* the folio — money only. NOTHING is charged here: the night audit bills each night as
           * it passes, so posting the stay now would charge it all twice. */
          const folioId = await allocateReadableId(tx, "FOLIO", reservedAt);
          // A return trip bills each visit on its own row, so the advances are taken in the same
          // order as the visits. With one advance and two visits, it belongs to the first.
          const advance = b.advances[group.indexOf(stay)] ?? null;
          await tx.folio.create({
            data: {
              id: folioId, entryId, state: v.inHouse ? FolioState.LIVE : FolioState.PROVISIONAL,
              // GUEST_PAY for everyone, including agency bookings: it is the neutral choice, and
              // who settles is a decision this import has no business making silently.
              billingModel: "GUEST_PAY",
              convertedToLiveAt: v.inHouse ? reservedAt : null, convertedBy: v.inHouse ? ACTOR_ID : null,
              createdAt: reservedAt, createdBy: ACTOR_ID,
            },
          });
          if (advance) {
            const pmtId = await allocateReadableId(tx, "PAYMENT", reservedAt);
            const method = paymentMethod(advance.mode);
            await tx.paymentRecord.create({
              data: {
                id: pmtId, folioId, entryId, amount: D(advance.amount), currency: "BTN",
                paymentMethod: method,
                paymentDirection: PaymentDirection.IN, receivedAt: reservedAt, recordedBy: ACTOR_ID,
                stage: Stage.S3, billingModel: "GUEST_PAY",
                notes: `Advance taken in the old system · reference ${b.ref}${method === "OTHER" ? " · it did not record how the money arrived" : ""}`,
              },
            });
            await recomputeFolioOutstandingBalance(tx, folioId);
          }

          await tx.traceEvent.create({
            data: {
              eventType: "ENTRY.IMPORTED_FROM_OLD_SYSTEM", actorId: ACTOR_ID, entityType: "Entry",
              entityId: entryId, operation: "CREATE", entryId, inquiryId: inqId,
              stageContext: stage, segmentContext: segment.id,
              payload: {
                oldReference: b.ref, visit: v.index, rooms: roomIds.length,
                checkIn: v.checkIn, checkOut: v.checkOut,
                stayTotal: money(stay.totals.total), oldSystemTotal: stay.oldTotal.toFixed(2),
                advanceReceived: (advance?.amount ?? 0).toFixed(2),
                inHouse: v.inHouse, billedFrom: v.inHouse ? today : v.checkIn,
                roomsNotInThisSystem: stay.skippedRooms,
              },
            },
          });
          stays++;
        }
        return live;
      }, { timeout: 180_000, maxWait: 30_000 });

      occupiedNow.push(...madeRooms);
      written++;
      if (written % 25 === 0) console.log(`  …${written} bookings written`);
    } catch (e) {
      failed++;
      console.log(`  ! ${ref}: ${(e as Error).message}`);
    }
  }

  /* A room's claim flag describes NOW, so only a guest already in it changes anything — a
   * booking three months out blocks its rooms by its DATES, not by this flag. */
  for (const { roomId, entryId } of occupiedNow) {
    const room = await prisma.room.findUnique({ where: { id: roomId }, select: { currentClaimState: true, roomNumber: true } });
    if (!room || room.currentClaimState !== InventoryClaimState.FREE) continue;
    await prisma.room.update({ where: { id: roomId }, data: { currentClaimState: InventoryClaimState.OCCUPIED } });
    await prisma.roomClaimStateEvent.create({
      data: { roomId, fromState: InventoryClaimState.FREE, toState: InventoryClaimState.OCCUPIED, entryId, actorId: ACTOR_ID, reason: `${IMPORT_TAG} — the guest is in the room` },
    });
  }

  console.log(`\nwritten: ${written} booking(s) · ${stays} stay(s)${failed ? ` · failed: ${failed}` : ""}`);
  if (occupiedNow.length) console.log(`rooms marked occupied (guests already in the hotel): ${occupiedNow.length}`);
  console.log(`\nNothing was charged — the night audit bills each night as it passes.\n`);
  await prisma.$disconnect();
}

/* ------------------------------------------------------------------ helpers */

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.replace(/\s+/g, " ").trim().split(" ");
  return parts.length === 1 ? { firstName: parts[0], lastName: "" } : { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/** "14:30" from whatever the old registration holds — hotel-local, as this system stores it. */
function arrivalTime(reg: OldRow | null): string | null {
  const m = /(\d{1,2}):(\d{2})/.exec(str(reg?.arrival_time));
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

/**
 * The old system's free-text mode, in this system's vocabulary.
 *
 * It says "NA" on 19 of the 24 advances it holds, so an unrecognised mode becomes OTHER rather
 * than a guess: recording money as a bank transfer when nobody wrote down how it arrived would
 * put a fact in the ledger that no one ever stated. The note on the payment says as much.
 */
function paymentMethod(mode: unknown): string {
  const s = str(mode).toLowerCase();
  if (/cash/.test(s)) return "CASH";
  if (/banking app|mbob|mpay|mobile|scan|qr/.test(s)) return "MOBILE_PAYMENT";
  if (/card|visa|master/.test(s)) return "CARD";
  if (/bank|transfer|bob|bnb|rma|cheque|check/.test(s)) return "BANK_TRANSFER";
  return "OTHER";
}

/**
 * The advances a booking took, in the order its billing rows hold them.
 *
 * `advance_payment` is a BOOLEAN over there — "was one taken?" — and the money is in `amount`.
 * Reading the flag as the amount writes Nu 1.00 onto every one of them, which is exactly what
 * the first run of this importer did.
 */
function advancesOf(rows: OldRow[]): { amount: number; mode: string }[] {
  return rows
    .filter((r) => r.advance_payment === true && num(r.amount) > 0)
    .map((r) => ({ amount: num(r.amount), mode: str(r.advance_payment_mode) }));
}

const nightsOf = (from: string, to: string): string[] => { const out: string[] = []; for (let d = from; d < to; d = addDays(d, 1)) out.push(d); return out; };
const covers = (c: { startDate?: unknown; endDate?: unknown }, night: string): boolean => {
  const s = (c.startDate as Date | undefined)?.toISOString().slice(0, 10);
  const e = (c.endDate as Date | undefined)?.toISOString().slice(0, 10);
  return !!s && !!e && night >= s && night < e;
};
/** The room the booking is anchored on: the one held for the most nights. */
const mostNights = (comps: { roomId: string; startDate?: unknown; endDate?: unknown }[]): string => {
  const span = new Map<string, number>();
  for (const c of comps) {
    const n = Math.max(1, Math.round((((c.endDate as Date).getTime() - (c.startDate as Date).getTime())) / 86_400_000));
    span.set(c.roomId, (span.get(c.roomId) ?? 0) + n);
  }
  return [...span.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

/**
 * The priced totals as the quotation stores them — every Decimal to two places, every Date to a
 * plain day. Written as a walk rather than a field list so it carries whatever the pricing core
 * returns, and cannot fall behind it.
 */
function serialise(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return Number(value.toFixed(2));
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialise(v)]));
  return value;
}

main().catch(async (e) => { console.error(e); process.exit(1); });
