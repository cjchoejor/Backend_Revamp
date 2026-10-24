/**
 * Bring the hotel's FINISHED stays across from the old PMS (`beta_legphel`) — every visit whose
 * last night is already over and that is not in this system yet (2026-10-24, operator ruling).
 *
 * The go-live import (`import-upcoming-from-old-system.ts`) took only what was still to come or in
 * the hotel. The old system never records the payment taken at check-out, so the operator gave
 * the rule for everything before:
 *
 *   "If the booking status is CLOSED, the bill has been paid in full and the guest checked out.
 *    If it is still OPEN but the check-out date is over, the guest has left but the bill is
 *    still due."
 *
 * and, for the bookings with no bill and no check-in record at all: bring them as no-shows, on
 * record, nothing owed.
 *
 * WHAT A FINISHED STAY BECOMES HERE
 *   - an enquiry + booking at the Closed step (S9), with its rooms night by night;
 *   - a folio carrying the stay as the old system priced it: per room per night, the room (with
 *     its extra beds) and the meals as two lines, each with its own service charge and GST, the
 *     night adding up to the old system's figure to the cent (its own tax rate, too — 37 nights
 *     in Jan–Apr 2026 were taxed at 20%, 4 not at all);
 *   - the bill's own adjustments on the last night: F&B, laundry and fines billed there, the FOC
 *     (complimentary) amount as a credit, and any difference between the old BILL and its
 *     room-nights (bills were edited after the nights were priced) — so the folio totals the bill;
 *   - the money: the advance (shared across the booking's visits in date order), and for a
 *     CLOSED booking the rest as paid at check-out. A CLOSED booking is sealed (CLOSED, folio
 *     SETTLED); an OPEN one with something left is ACTIVE at S9 with its folio OUTSTANDING, which
 *     is what the Billing page lists; an OPEN one with nothing left (a complimentary room never
 *     closed) is sealed like a paid one.
 *   - a no-show: a booking at S9, sealed, with a no-show record and a NO_SHOW_CLOSED folio; no
 *     rooms (it never used one) and nothing charged.
 *
 * A booking whose later visit is already here (a return trip across go-live — Mr. Nilimanka Das,
 * 17 Oct + 23 Oct) gets its finished visit under the SAME enquiry, and the advance that the go-live
 * import put wholly on the later visit is shared out again: the earlier visit takes its part
 * first. That rewrites the imported advance row on the later visit — only when nobody has touched
 * that folio since (its one payment is the import's advance and it is not settled); otherwise it is
 * left and named.
 *
 * Visits are cut from the room-nights themselves (a gap of one or more nights starts a new visit):
 * the old system's arrival / departure columns often hold the same day twice.
 *
 * SAFETY
 *   - The old database is opened read-only; it backs the LIVE old system and is never written.
 *   - Dry run by default. `--commit` writes, one transaction per booking.
 *   - Re-running skips what is already here (matched on the old reference + the visit's nights).
 *   - Every row is dated in the past (updatedAt = the check-out), so the desk's list of what
 *     changed lately is not flooded.
 *
 * USAGE
 *   npx tsx scripts/import-data/import-past-stays-from-old-system.ts                 # dry run
 *   npx tsx scripts/import-data/import-past-stays-from-old-system.ts --only RES_…    # one booking
 *   npx tsx scripts/import-data/import-past-stays-from-old-system.ts --commit
 */
import { PrismaClient, Prisma, EntryStatus, FolioLineType, FolioState, PaymentDirection, Stage } from "@prisma/client";
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { allocateReadableId, formatFolioLineId } from "../../src/lib/readable-id.js";
import { deriveCameInAs } from "../../src/lib/inquiry-came-in-as.js";
import { recomputeFolioOutstandingBalance } from "../../src/lib/folio-outstanding-from-payment.js";
import { serviceChargeLineDescription, gstLineDescription } from "../../src/lib/folio-tax-lines.js";

const COMMIT = process.argv.includes("--commit");
const argOf = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] ?? null : null; };
const ONLY = argOf("--only");
const LIMIT = Number(argOf("--limit") ?? 0) || 0;
const ACTOR_ID = "actor-seed-system";
const IMPORT_TAG = "Imported from the old PMS";
const HOUSE_EMAIL = "legphel.hotel@gmail.com";

pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v);

const D = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
type OldRow = Record<string, unknown>;

const ymd = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 10));
const utc = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number): string => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();
const clean = (v: unknown): string | null => { const s = str(v); return !s || s.toLowerCase() === "na" || s === "-" ? null : s; };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function connectionString(dbName?: string): string {
  const fromEnv = process.env.DATABASE_URL;
  let url = fromEnv;
  if (!url) {
    const env = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.trim().startsWith("DATABASE_URL="));
    if (!line) throw new Error("DATABASE_URL not found");
    url = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  }
  return dbName ? url.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`) : url;
}

/* ------------------------------------------------------- agency name parsing (as go-live) */

const VARIANT = /season|premium|room|apartment|standard|deluxe|executive|suite|map|\bep\b|\bcp\b|\bap\b|rate|group|backpacker|\d/i;
function splitAgencyAndPackage(detail: string): { agency: string; pkg: string | null } {
  const raw = detail.trim();
  const trailing = /^(.*\))\s*[_\-\s]*([A-Za-z][A-Za-z\s]*)$/.exec(raw);
  if (trailing && VARIANT.test(trailing[2])) {
    const inner = /^(.*?)\s*\(([^)]*)\)$/.exec(trailing[1].trim());
    if (inner && VARIANT.test(inner[2])) return { agency: inner[1].trim(), pkg: `${inner[2].trim()} ${trailing[2].trim()}`.trim() };
    return { agency: trailing[1].trim(), pkg: trailing[2].trim() };
  }
  const closed = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw);
  if (closed && VARIANT.test(closed[2])) return { agency: closed[1].trim(), pkg: closed[2].trim() };
  const open = /^(.*?)\s*\(([^)]+)$/.exec(raw);
  if (open && VARIANT.test(open[2])) return { agency: open[1].trim(), pkg: open[2].trim() };
  return { agency: raw, pkg: null };
}

/* ------------------------------------------------------------------- the plan */

type Night = { night: string; roomNo: string; row: OldRow };
type Visit = { checkIn: string; checkOut: string; nights: Night[] };
type Outcome = "PAID" | "DUE" | "NO_SHOW";
type Line = { lineType: FolioLineType; description: string; amount: number; chargeDate: string; roomNo: string | null };

/** One night of one room as the old system priced it: room + beds, then meals, each taxed. */
function linesForNight(n: Night): { lines: Line[]; gross: number; oddCents: number } {
  const r = n.row;
  const G = r2(num(r.total_room_amount));
  const N = r2(num(r.total_without_tax));
  const roomDesc = `Room charge · Room ${n.roomNo}`;
  const mealDesc = `Meal plan · Room ${n.roomNo}`;
  const out: Line[] = [];
  const line = (lineType: FolioLineType, description: string, amount: number) =>
    out.push({ lineType, description, amount: r2(amount), chargeDate: n.night, roomNo: n.roomNo });

  if (N <= 0) {
    // A complimentary night: shown, at nothing. Its tax is named as nothing too, or the bills
    // would compute tax on the room line at render.
    line(FolioLineType.ROOM_CHARGE, roomDesc, G > 0 ? G : 0);
    line(FolioLineType.SERVICE, serviceChargeLineDescription(0, roomDesc), 0);
    return { lines: out, gross: G > 0 ? G : 0, oddCents: 0 };
  }
  // The agreed room price and its extra beds; everything else in the night's net is the meals.
  let A = r2(num(r.negotiated_price) + num(r.no_of_extra_beds) * num(r.negotiated_extra_bed_rate));
  if (A < 0 || A > N + 0.005) A = N;
  const M = r2(N - A);

  const ratio = G / N;
  const taxed = G - N > 0.005;
  const scRate = !taxed ? 0 : ratio >= 1.0995 ? 0.1 : ratio - 1;
  const gstRate = !taxed || ratio < 1.0995 ? 0 : Math.round((ratio / 1.1 - 1) * 10_000) / 10_000;

  // A rate the house prints to two places ("5.00%") is written so; the old system's 20% nights
  // (Jan–Apr 2026) are GST at 1/11 on top of the 10% service charge, written to four places so
  // the stated rate reproduces the amount.
  const gstDesc = (desc: string) => {
    const pct = gstRate * 100;
    return Math.abs(pct - Number(pct.toFixed(2))) < 1e-9 ? gstLineDescription(gstRate, desc) : `GST (${pct.toFixed(4)}%) on: ${desc}`;
  };
  let sum = 0;
  let lastBase = -1;
  for (const [base, desc, type] of [[A, roomDesc, FolioLineType.ROOM_CHARGE], [M, mealDesc, FolioLineType.F_AND_B]] as const) {
    if (base <= 0 && type === FolioLineType.F_AND_B) continue;
    line(type, desc, base);
    lastBase = out.length - 1;
    sum += base;
    if (!taxed) {
      // An untaxed night still names its tax as nothing, so the bills don't add tax at render.
      if (type === FolioLineType.ROOM_CHARGE) line(FolioLineType.SERVICE, serviceChargeLineDescription(0, desc), 0);
      continue;
    }
    const sc = r2(base * scRate);
    line(FolioLineType.SERVICE, serviceChargeLineDescription(scRate, desc), sc);
    sum += sc;
    if (gstRate > 0) {
      const gst = r2((base + sc) * gstRate);
      line(FolioLineType.OTHER, gstDesc(desc), gst);
      sum += gst;
    }
  }
  // Rounding: the old system taxed the whole night at once, so the lines can sit a paisa or two
  // off its figure. The difference goes on the night's last charge — never on a tax line, whose
  // amount must stay its stated rate of its own base.
  const diff = r2(G - sum);
  if (Math.abs(diff) > 0.001 && lastBase >= 0) out[lastBase].amount = r2(out[lastBase].amount + diff);
  return { lines: out, gross: G, oddCents: Math.abs(diff) > 0.05 ? diff : 0 };
}

/** The booking's nights, one row per (room, night), cut into visits wherever a night is missing. */
function visitsOf(rows: OldRow[]): { visits: Visit[]; duplicates: number } {
  const byKey = new Map<string, Night>();
  let duplicates = 0;
  for (const row of rows) {
    const night = ymd(row.reserved_date)!;
    const roomNo = str(row.room_no);
    const k = `${night}|${roomNo}`;
    const prev = byKey.get(k);
    if (prev) {
      duplicates++;
      // The old data holds a room twice on a night now and then; the dearer row is the one billed.
      if (num(row.total_room_amount) > num(prev.row.total_room_amount)) byKey.set(k, { night, roomNo, row });
      continue;
    }
    byKey.set(k, { night, roomNo, row });
  }
  const nights = [...byKey.values()].sort((a, b) => a.night.localeCompare(b.night) || a.roomNo.localeCompare(b.roomNo, undefined, { numeric: true }));
  const visits: Visit[] = [];
  for (const n of nights) {
    const cur = visits[visits.length - 1];
    if (cur && (n.night === addDays(cur.checkOut, -1) || n.night === cur.checkOut)) {
      cur.nights.push(n);
      if (n.night === cur.checkOut) cur.checkOut = addDays(n.night, 1);
    } else {
      visits.push({ checkIn: n.night, checkOut: addDays(n.night, 1), nights: [n] });
    }
  }
  return { visits, duplicates };
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.replace(/\s+/g, " ").trim().split(" ");
  return parts.length === 1 ? { firstName: parts[0], lastName: "" } : { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}
function paymentMethod(mode: unknown): string {
  const s = str(mode).toLowerCase();
  if (/cash/.test(s)) return "CASH";
  if (/banking app|mbob|mpay|mobile|scan|qr/.test(s)) return "MOBILE_PAYMENT";
  if (/card|visa|master/.test(s)) return "CARD";
  if (/bank|transfer|bob|bnb|rma|cheque|check/.test(s)) return "BANK_TRANSFER";
  return "OTHER";
}
function arrivalTime(reg: OldRow | null): string | null {
  const m = /(\d{1,2}):(\d{2})/.exec(str(reg?.arrival_time));
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}
const overlaps = (a1: string, a2: string, b1: string, b2: string) => a1 < b2 && b1 < a2;

/* ----------------------------------------------------------------- the script */

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: connectionString() } } });
  const old = new pg.Client({ connectionString: connectionString("beta_legphel"), options: "-c default_transaction_read_only=on" });
  await old.connect();
  const q = async (sql: string, params: unknown[] = []): Promise<OldRow[]> => (await old.query(sql, params)).rows;

  const today = String((await q(`select ((now() at time zone 'Asia/Thimphu')::date)::text d`))[0].d);
  const target = connectionString().replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@").replace(/^.*@/, "");
  console.log(`\n=== Finished stays from the old PMS (${COMMIT ? "COMMIT" : "DRY RUN"}) → ${target} ===`);
  console.log(`today at the hotel: ${today} — visits whose last night is before today come across\n`);

  const inquiries = await q(
    `select ci.* from customer_inquiry_table ci
      where ci.inquiry_status ${ONLY ? "and ci.reservation_ref_no = $1" : ""}
        and exists (select 1 from room_reservation rr where rr.reservation_ref_no = ci.reservation_ref_no
                     and rr.reservation_status <> 'blocked' and rr.reserved_date < $${ONLY ? 2 : 1}::date)
      order by ci.reservation_date, ci.reservation_ref_no`,
    ONLY ? [ONLY, today] : [today],
  );
  const refs = inquiries.map((r) => str(r.reservation_ref_no));
  const [roomRows, billings, bills, registrations, packageRates] = await Promise.all([
    q(`select * from room_reservation where reservation_ref_no = any($1) and reservation_status <> 'blocked'`, [refs]),
    q(`select * from reservation_billing where reservation_ref_no = any($1) order by res_bill_no`, [refs]),
    q(`select * from all_room_billing where reservation_ref_no = any($1)`, [refs]),
    q(`select * from registration_form where reservation_ref_no = any($1)`, [refs]),
    q(`select * from package_rate`),
  ]);
  await old.end();
  const group = <T extends OldRow>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const k = str(x.reservation_ref_no); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; };
  const rowsByRef = group(roomRows);
  const billingsByRef = group(billings);
  const billByRef = new Map(bills.map((b) => [str(b.reservation_ref_no), b]));
  const regsByRef = group(registrations);
  const rateByName = new Map(packageRates.map((p) => [norm(str(p.travel_agent_name)), p]));

  /* ---- what this system already has ---- */
  const [roomsDb, agentsDb, ratePlan, imported] = await Promise.all([
    prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true } }),
    prisma.travelAgent.findMany({ select: { id: true, displayName: true, ratePackages: { where: { effectiveTo: null }, select: { id: true, name: true, isDefault: true } } } }),
    prisma.ratePlanRegistry.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } }),
    prisma.inquiry.findMany({
      where: { notes: { contains: "old reference: " } },
      select: {
        id: true, notes: true, guestProfileId: true,
        entries: {
          select: {
            id: true, checkInDate: true, checkOutDate: true, currentStage: true, status: true,
            folio: { select: { id: true, state: true, payments: { select: { id: true, amount: true, notes: true, paymentDirection: true, paymentMethod: true, receivedAt: true, createdAt: true } } } },
          },
        },
      },
    }),
  ]);
  if (!ratePlan) throw new Error("no active rate plan — Reservation.frozenRatePlanId needs one");
  const roomByNo = new Map(roomsDb.map((r) => [r.roomNumber, r]));
  const agentByName = new Map(agentsDb.map((a) => [norm(a.displayName), a]));
  const presentByRef = new Map<string, (typeof imported)[number]>();
  for (const i of imported) { const m = /old reference: (\S+)/.exec(i.notes ?? ""); if (m) presentByRef.set(m[1], i); }

  /* ---- plan every booking ---- */
  type PlannedVisit = Visit & { kind: "IMPORT" | "PRESENT" | "UPCOMING"; presentEntryId?: string; lines: Line[]; charges: number; advanceShare: number };
  type Plan = {
    ref: string; inquiry: OldRow; bill: OldRow | null; billing: OldRow | null; outcome: Outcome; status: string;
    visits: PlannedVisit[]; advanceTotal: number; advanceMode: string; billTotal: number; diff: number; diffIsRounding: boolean;
    duplicates: number; missingRooms: string[]; oddNights: string[]; partlyPresent: boolean;
    presentAdjust: { entryId: string; folioId: string; from: number; to: number; ok: boolean; why?: string }[];
    existingInquiryId: string | null; existingGuestId: string | null;
  };
  const plans: Plan[] = [];
  for (const inq of inquiries) {
    const ref = str(inq.reservation_ref_no);
    const { visits, duplicates } = visitsOf(rowsByRef.get(ref) ?? []);
    const present = presentByRef.get(ref);
    const presentEntries = present?.entries ?? [];
    const bill = billByRef.get(ref) ?? null;
    const billingRows = billingsByRef.get(ref) ?? [];
    const advances = billingRows.filter((r) => r.advance_payment === true && num(r.amount) > 0).map((r) => ({ amount: num(r.amount), mode: str(r.advance_payment_mode) }));
    const checkedIn = (regsByRef.get(ref) ?? []).length > 0;
    const status = bill ? (str(bill.booking_status) || "open") : "(no bill)";
    const outcome: Outcome = bill ? (status === "close" ? "PAID" : "DUE") : checkedIn ? "DUE" : "NO_SHOW";

    let partlyPresent = false;
    const planned: PlannedVisit[] = visits.map((v) => {
      const hit = presentEntries.find((e) => e.checkInDate && e.checkOutDate && overlaps(v.checkIn, v.checkOut, ymd(e.checkInDate.toISOString())!, ymd(e.checkOutDate.toISOString())!));
      if (hit) {
        const s = ymd(hit.checkInDate!.toISOString())!, e = ymd(hit.checkOutDate!.toISOString())!;
        if (v.checkIn < s || v.checkOut > e) partlyPresent = true;
        return { ...v, kind: "PRESENT" as const, presentEntryId: hit.id, lines: [], charges: 0, advanceShare: 0 };
      }
      return { ...v, kind: v.checkOut <= today ? ("IMPORT" as const) : ("UPCOMING" as const), lines: [], charges: 0, advanceShare: 0 };
    });
    const toImport = planned.filter((v) => v.kind === "IMPORT");
    if (toImport.length === 0) continue;

    const missingRooms = new Set<string>();
    const oddNights: string[] = [];
    let roomsGrossAll = 0;
    for (const v of planned) {
      for (const n of v.nights) {
        if (!roomByNo.has(n.roomNo)) { missingRooms.add(n.roomNo); continue; }
        const { lines, gross, oddCents } = linesForNight(n);
        roomsGrossAll += gross;
        v.charges = r2(v.charges + gross);
        if (v.kind === "IMPORT") v.lines.push(...lines);
        if (oddCents) oddNights.push(`${n.night} room ${n.roomNo} (${oddCents.toFixed(2)})`);
      }
    }

    /* the bill's own items, on the last visit coming across */
    const last = toImport[toImport.length - 1];
    const lastNight = addDays(last.checkOut, -1);
    let billTotal = r2(roomsGrossAll);
    let diff = 0, diffIsRounding = false;
    if (outcome !== "NO_SHOW" && bill) {
      const fnb = num(bill.fnb_summary_amount), laundry = num(bill.laundry_summary_amount), fine = num(bill.fine_amount), foc = num(bill.foc_amount);
      billTotal = r2(num(bill.total_negotiated_price) + fnb + laundry + fine - foc);
      const add = (lineType: FolioLineType, description: string, amount: number) => {
        last.lines.push({ lineType, description, amount: r2(amount), chargeDate: lastNight, roomNo: null });
        last.charges = r2(last.charges + amount);
      };
      if (fnb > 0) add(FolioLineType.F_AND_B, "F&B on the old system's bill", fnb);
      if (laundry > 0) add(FolioLineType.SERVICE, "Laundry on the old system's bill", laundry);
      if (fine > 0) add(FolioLineType.OTHER, "Fine on the old system's bill", fine);
      if (foc > 0) add(FolioLineType.CREDIT_NOTE, "Complimentary (FOC) on the old system's bill", -foc);
      diff = r2(num(bill.total_negotiated_price) - roomsGrossAll);
      // Paise from the old system rounding its bill as a whole are rounding, not a charge.
      const nightsAll = planned.reduce((s, v) => s + v.nights.length, 0);
      diffIsRounding = Math.abs(diff) <= Math.max(0.05, 0.01 * nightsAll);
      if (!diffIsRounding && Math.abs(diff) >= 0.005) {
        add(diff > 0 ? FolioLineType.OTHER : FolioLineType.CREDIT_NOTE, "Difference between the old system's bill and its room-nights", diff);
      }
    }
    if (outcome === "NO_SHOW") for (const v of toImport) { v.lines = []; v.charges = 0; }

    /* the advance, shared across every visit in date order — the earlier visit takes its part first */
    const advanceTotal = r2(advances.reduce((s, a) => s + a.amount, 0));
    let left = advanceTotal;
    // A visit still to come that is not in this system takes no share — its money would vanish.
    const ordered = planned.filter((v) => v.kind !== "UPCOMING").sort((a, b) => a.checkIn.localeCompare(b.checkIn));
    for (const [i, v] of ordered.entries()) {
      const take = i === ordered.length - 1 ? left : Math.min(left, Math.max(0, v.charges));
      v.advanceShare = r2(take);
      left = r2(left - take);
    }

    /* the go-live import put the whole advance on the visit it brought across — share it again */
    const presentAdjust: Plan["presentAdjust"] = [];
    const presentVisits = planned.filter((v) => v.kind === "PRESENT");
    for (const v of presentVisits) {
      const e = presentEntries.find((x) => x.id === v.presentEntryId)!;
      const folio = e.folio;
      const importAdv = (folio?.payments ?? []).filter((p) => (p.notes ?? "").includes("Advance taken in the old system"));
      const held = r2(importAdv.reduce((s, p) => s + Number(p.amount), 0));
      if (Math.abs(held - v.advanceShare) < 0.005) continue;
      const others = (folio?.payments ?? []).filter((p) => !importAdv.includes(p));
      const ok = !!folio && others.length === 0 && importAdv.length <= 1 && folio.state !== FolioState.SETTLED && folio.state !== FolioState.WRITTEN_OFF;
      presentAdjust.push({ entryId: e.id, folioId: folio?.id ?? "", from: held, to: v.advanceShare, ok, why: ok ? undefined : !folio ? "no folio" : others.length ? "the desk has taken money on it since" : "its bill is already settled" });
    }
    // Where the later visit's advance cannot be moved, the earlier visit gets only what is left.
    const stuck = presentAdjust.filter((a) => !a.ok);
    if (stuck.length) {
      const heldStuck = stuck.reduce((s, a) => s + a.from, 0);
      const wantStuck = stuck.reduce((s, a) => s + a.to, 0);
      let surplus = r2(heldStuck - wantStuck); // money the stuck visits keep beyond their share
      for (const v of toImport.slice().reverse()) {
        if (surplus <= 0) break;
        const cut = Math.min(surplus, v.advanceShare);
        v.advanceShare = r2(v.advanceShare - cut);
        surplus = r2(surplus - cut);
      }
    }

    plans.push({
      ref, inquiry: inq, bill, billing: billingRows[0] ?? null, outcome, status,
      visits: planned, advanceTotal, advanceMode: advances[0]?.mode ?? "", billTotal, diff, diffIsRounding,
      duplicates, missingRooms: [...missingRooms], oddNights, partlyPresent, presentAdjust,
      existingInquiryId: present?.id ?? null, existingGuestId: present?.guestProfileId ?? null,
    });
  }

  /* ---- what each visit will owe ---- */
  type Fate = { plan: Plan; visit: PlannedVisit; settlement: number; due: number; credit: number; sealed: boolean };
  const fates: Fate[] = [];
  for (const p of plans) {
    for (const v of p.visits.filter((x) => x.kind === "IMPORT")) {
      const net = r2(v.charges - v.advanceShare);
      const paidInFull = p.outcome === "PAID";
      const settlement = paidInFull && net > 0 ? net : 0;
      const due = p.outcome === "DUE" && net > 0.005 ? net : 0;
      fates.push({ plan: p, visit: v, settlement, due, credit: p.outcome !== "NO_SHOW" && net < -0.005 ? -net : 0, sealed: due === 0 });
    }
  }

  const sum = (xs: number[]) => r2(xs.reduce((s, x) => s + x, 0));
  const by = (o: Outcome) => fates.filter((f) => f.plan.outcome === o);
  console.log(`bookings with a finished visit not yet here: ${plans.length} · visits to bring across: ${fates.length}`);
  console.log(`  closed (paid in full):  ${by("PAID").length} visits · charges ${sum(by("PAID").map((f) => f.visit.charges)).toFixed(2)} · paid at check-out ${sum(by("PAID").map((f) => f.settlement)).toFixed(2)}`);
  const owing = by("DUE").filter((f) => f.due > 0);
  console.log(`  open, still owing:      ${owing.length} visits · owed Nu ${sum(owing.map((f) => f.due)).toFixed(2)}`);
  console.log(`  open, nothing left:     ${by("DUE").length - owing.length} visits (complimentary or paid ahead) — sealed`);
  console.log(`  no-shows:               ${by("NO_SHOW").length} visits · advances kept ${sum(by("NO_SHOW").map((f) => f.visit.advanceShare)).toFixed(2)}`);
  const credits = fates.filter((f) => f.credit > 0);
  if (credits.length) {
    console.log(`  paid MORE than the stay: ${credits.length} visits · ${sum(credits.map((f) => f.credit)).toFixed(2)} in all`);
    for (const f of credits.slice(0, 10)) console.log(`      ${f.plan.ref} ${f.visit.checkIn}→${f.visit.checkOut}: ${f.credit.toFixed(2)} over`);
  }
  const straddle = plans.filter((p) => p.visits.some((v) => v.kind !== "IMPORT"));
  console.log(`  return trips with a visit already here: ${straddle.length}`);
  for (const p of straddle) {
    const adj = p.presentAdjust.map((a) => `${a.entryId} advance ${a.from.toFixed(2)} → ${a.to.toFixed(2)}${a.ok ? "" : ` (LEFT AS IS: ${a.why})`}`).join("; ");
    console.log(`      ${p.ref} [${p.status}] ${p.visits.map((v) => `${v.kind === "IMPORT" ? "+" : v.kind === "PRESENT" ? "=" : ">"}${v.checkIn}→${v.checkOut}`).join(" ")}${adj ? ` · ${adj}` : ""}${p.partlyPresent ? " · NOTE: a visit here covers only part of its nights" : ""}`);
  }
  const diffs = plans.filter((p) => !p.diffIsRounding && Math.abs(p.diff) >= 0.005);
  console.log(`  bills that differ from their room-nights (difference line added): ${diffs.length} · net ${sum(diffs.map((p) => p.diff)).toFixed(2)}`);
  const missing = plans.filter((p) => p.missingRooms.length);
  if (missing.length) console.log(`  rooms not in this system (their nights are covered by the difference line): ${[...new Set(missing.flatMap((p) => p.missingRooms))].join(", ")} on ${missing.length} bookings`);
  const odd = plans.filter((p) => p.oddNights.length);
  if (odd.length) console.log(`  nights whose tax would not land within 5 paise: ${odd.reduce((s, p) => s + p.oddNights.length, 0)}`);
  console.log(`  duplicate room-nights in the old data (charged once): ${plans.reduce((s, p) => s + p.duplicates, 0)}`);
  console.log(`  folio lines to write: ${fates.reduce((s, f) => s + f.visit.lines.length, 0)}\n`);

  if (ONLY) {
    for (const f of fates) {
      console.log(`--- ${f.plan.ref} [${f.plan.outcome}] ${f.visit.checkIn} → ${f.visit.checkOut}: charges ${f.visit.charges.toFixed(2)} · advance ${f.visit.advanceShare.toFixed(2)} · settled ${f.settlement.toFixed(2)} · due ${f.due.toFixed(2)}`);
      for (const l of f.visit.lines) console.log(`    ${l.chargeDate} ${l.lineType.padEnd(12)} ${l.amount.toFixed(2).padStart(10)}  ${l.description}`);
    }
  }

  /* ---- agencies this system does not have yet ---- */
  const resolveAgency = (detail: string | null, guestType: string) => {
    if (!detail || !/agent/i.test(guestType)) return null;
    if (agentByName.has(norm(detail))) return { key: norm(detail), pkg: null as string | null, agencyName: detail };
    const { agency, pkg } = splitAgencyAndPackage(detail);
    return { key: norm(agency), pkg, agencyName: agency };
  };
  type NewAgency = { agency: string; packages: { name: string; rate: OldRow | null }[] };
  const toCreate = new Map<string, NewAgency>();
  for (const p of plans) {
    if (p.existingInquiryId) continue;
    const detail = clean(p.inquiry.guest_type_detail);
    const r = resolveAgency(detail, str(p.inquiry.guest_type));
    if (!r || agentByName.has(r.key)) continue;
    if (!toCreate.has(r.key)) toCreate.set(r.key, { agency: r.agencyName, packages: [] });
    const e = toCreate.get(r.key)!;
    const pkgName = r.pkg ?? "Standard";
    if (!e.packages.some((x) => norm(x.name) === norm(pkgName))) e.packages.push({ name: pkgName, rate: rateByName.get(norm(detail!)) ?? rateByName.get(r.key) ?? null });
  }
  console.log(`agencies to add: ${toCreate.size}`);

  if (!COMMIT) {
    console.log(`\nDry run — nothing written. Re-run with --commit.\n`);
    await prisma.$disconnect();
    return;
  }

  const custodian =
    (await prisma.staffUser.findFirst({ where: { actorLevel: "L1", isActive: true }, orderBy: { id: "asc" }, select: { id: true } })) ??
    (await prisma.staffUser.findFirst({ orderBy: { id: "asc" }, select: { id: true } }));
  if (!custodian) throw new Error("no staff user on file");

  for (const [key, a] of toCreate) {
    const agent = await prisma.travelAgent.create({
      data: {
        id: await allocateReadableId(prisma, "TRAVEL_AGENT", utc(today)), displayName: a.agency,
        contactNumbers: [...new Set(a.packages.map((x) => clean(x.rate?.contact_number)).filter((x): x is string => !!x))],
        modeOfContact: "PHONE", notes: `${IMPORT_TAG} — the agency as the old system names it`, createdBy: ACTOR_ID,
      },
    });
    const made: { id: string; name: string; isDefault: boolean }[] = [];
    for (const [i, pk] of a.packages.entries()) {
      const r = pk.rate;
      const rate = (col: string) => (r && r[col] != null ? D(num(r[col])) : null);
      made.push(await prisma.ratePackage.create({
        data: {
          scope: "TRAVEL_AGENT", travelAgentId: agent.id, name: pk.name, isDefault: i === 0,
          roomBaseRate: rate("room_base_rate") ?? D(0), extraBedRate: rate("extra_bed_rate"),
          cnbPercent: r?.cnb_percent == null ? null : Number(r.cnb_percent),
          breakfastRate: rate("breakfast_rate"), lunchRate: rate("lunch_rate"), dinnerRate: rate("dinner_rate"),
          cpRate: rate("cp_rate"), mapLunchRate: rate("map_lunch_rate"), mapDinnerRate: rate("map_dinner_rate"), apRate: rate("ap_rate"),
          notes: r ? `${IMPORT_TAG} — the agency's rate list in the old system` : `${IMPORT_TAG} — no rates on file there`,
          createdBy: ACTOR_ID,
        },
        select: { id: true, name: true, isDefault: true },
      }));
    }
    agentByName.set(key, { id: agent.id, displayName: a.agency, ratePackages: made });
  }

  let written = 0, stays = 0, failed = 0, lineCount = 0, adjusted = 0;
  for (const p of plans) {
    if (LIMIT && written >= LIMIT) break;
    try {
      await prisma.$transaction(async (tx) => {
        const reservedAt = utc(ymd(p.inquiry.reservation_date) ?? p.visits[0].checkIn);
        const reg = (regsByRef.get(p.ref) ?? [])[0] ?? null;
        let inqId = p.existingInquiryId;
        let guestId = p.existingGuestId;
        if (!inqId) {
          const fullName = clean(p.billing?.primary_customer_name) ?? clean(p.bill?.name) ?? clean(reg?.name) ?? clean(p.inquiry.contact_person) ?? "Guest";
          const email = clean(p.billing?.email) ?? clean(p.bill?.email);
          const guest = await tx.guestProfile.create({
            data: {
              ...splitName(fullName),
              email: email && email.toLowerCase() !== HOUSE_EMAIL ? email : null,
              phone: clean(p.billing?.phone_no) ?? clean(p.bill?.phone_no) ?? clean(reg?.phone_no),
              nationality: clean(reg?.nationality) ?? clean(p.bill?.nationality) ?? clean(p.billing?.country),
              clientTier: "STANDARD", createdBy: ACTOR_ID, createdAt: reservedAt,
            },
          });
          guestId = guest.id;
          const detail = clean(p.inquiry.guest_type_detail);
          const r = resolveAgency(detail, str(p.inquiry.guest_type));
          const agent = r ? agentByName.get(r.key) : null;
          const pkg = agent ? (r!.pkg ? agent.ratePackages.find((x) => norm(x.name) === norm(r!.pkg!)) : null) ?? agent.ratePackages.find((x) => x.isDefault) ?? agent.ratePackages[0] ?? null : null;
          const sourceChannel = agent ? "AGENT" : "DIRECT";
          inqId = await allocateReadableId(tx, "INQUIRY", reservedAt);
          await tx.inquiry.create({
            data: {
              id: inqId, referenceNumber: inqId, guestProfileId: guest.id,
              sourceChannel, cameInAs: deriveCameInAs({ sourceChannel }), defaultCustodianId: custodian.id,
              notes: [`${IMPORT_TAG} · old reference: ${p.ref} · a stay that ended before go-live`, detail ? `booked as: ${detail}` : null, clean(p.inquiry.inquiry_remarks), clean(p.billing?.special_preferences)].filter(Boolean).join(" · "),
              travelAgentId: agent?.id ?? null, ratePackageId: pkg?.id ?? null,
              createdAt: reservedAt, updatedAt: reservedAt, createdBy: ACTOR_ID,
            } as Prisma.InquiryUncheckedCreateInput,
          });
        }

        for (const v of p.visits.filter((x) => x.kind === "IMPORT")) {
          const fate = fates.find((f) => f.visit === v)!;
          const checkOutAt = utc(v.checkOut);
          const roomNights = v.nights.filter((n) => roomByNo.has(n.roomNo));
          // The party is the busiest night: the rooms held that night, added up.
          const nightsList = [...new Set(roomNights.map((n) => n.night))];
          const busiest = nightsList.map((night) => {
            const here = roomNights.filter((n) => n.night === night);
            const a = here.reduce((s, n) => s + num(n.row.no_of_adults), 0);
            const k610 = here.reduce((s, n) => s + num(n.row.cnb_count_six_to_ten), 0);
            const k6 = here.reduce((s, n) => s + num(n.row.cnb_count_below_six), 0);
            return { rooms: here.length, a, k610, k6 };
          }).reduce((best, n) => (n.a + n.k610 + n.k6 > best.a + best.k610 + best.k6 ? n : best), { rooms: 0, a: 0, k610: 0, k6: 0 });
          const adults = Math.max(busiest.a, p.outcome === "NO_SHOW" ? num(p.inquiry.no_of_adults) : 0);
          const guests = Math.max(1, adults + busiest.k610 + busiest.k6);
          const sealed = p.outcome === "NO_SHOW" || fate.sealed;

          const entryId = await allocateReadableId(tx, "ENTRY", reservedAt);
          await tx.entry.create({
            data: {
              id: entryId, inquiryId: inqId!, guestProfileId: guestId, useType: "LEISURE",
              checkInDate: utc(v.checkIn), checkOutDate: checkOutAt,
              guestCount: guests, adultCount: adults, childCount: busiest.k610 + busiest.k6,
              childAges: [...Array(busiest.k610).fill(8), ...Array(busiest.k6).fill(3)],
              numberOfRooms: Math.max(1, busiest.rooms),
              segmentNumber: 1, currentStage: Stage.S9, status: sealed ? EntryStatus.CLOSED : EntryStatus.ACTIVE, otaSource: false,
              contactPersonName: clean(p.inquiry.contact_person), contactPersonPhone: clean(p.inquiry.contact_person_phone_no),
              contactPersonEmail: clean(p.inquiry.contact_person_email), expectedArrivalTime: arrivalTime(reg),
              closedAt: sealed ? checkOutAt : null, closedBy: sealed ? ACTOR_ID : null,
              createdAt: reservedAt, updatedAt: checkOutAt, createdBy: ACTOR_ID,
            } as Prisma.EntryUncheckedCreateInput,
          });
          const segment = await tx.segment.create({
            data: { entryId, segmentNumber: 1, stage: Stage.S9, startedAt: reservedAt, sealedAt: sealed ? checkOutAt : null, sealedBy: sealed ? ACTOR_ID : null, createdBy: ACTOR_ID, notes: `${IMPORT_TAG} · a finished stay` },
          });
          const firstRow = roomNights[0]?.row ?? null;
          const reservation = await tx.reservation.create({
            data: {
              id: await allocateReadableId(tx, "RESERVATION", reservedAt), entryId, segmentId: segment.id,
              frozenRate: D(num(firstRow?.negotiated_price)), frozenRatePlanId: ratePlan.id, frozenBillingModel: "GUEST_PAY",
              frozenCheckInDate: utc(v.checkIn), frozenCheckOutDate: checkOutAt, frozenGuestCount: guests,
              frozenCommercialTerms: { importedFrom: { system: "old PMS", reference: p.ref, bookingStatus: p.status, pastStay: true } } as Prisma.InputJsonValue,
              confirmedAt: reservedAt, confirmedBy: ACTOR_ID, sealedAt: reservedAt, createdAt: reservedAt,
            },
          });
          await tx.entry.update({ where: { id: entryId }, data: { currentReservationId: reservation.id, updatedAt: checkOutAt } });

          /* the rooms, one row per run of nights at the same agreed figures (none for a no-show) */
          if (p.outcome !== "NO_SHOW") {
            const byRoom = new Map<string, Night[]>();
            for (const n of roomNights) { if (!byRoom.has(n.roomNo)) byRoom.set(n.roomNo, []); byRoom.get(n.roomNo)!.push(n); }
            for (const [roomNo, ns] of byRoom) {
              const room = roomByNo.get(roomNo)!;
              const sig = (r: OldRow) => [r.negotiated_price, r.no_of_extra_beds, r.negotiated_extra_bed_rate, r.no_of_occupant, r.no_of_adults].map(String).join("|");
              const runs: Night[][] = [];
              for (const n of ns) {
                const run = runs[runs.length - 1];
                const prev = run?.[run.length - 1];
                if (run && prev && addDays(prev.night, 1) === n.night && sig(prev.row) === sig(n.row)) run.push(n);
                else runs.push([n]);
              }
              for (const run of runs) {
                const lead = run[0].row;
                await tx.roomAssignment.create({
                  data: {
                    id: await allocateReadableId(tx, "ROOM_ASSIGNMENT", reservedAt), entryId, roomId: room.id,
                    startDate: utc(run[0].night), endDate: utc(addDays(run[run.length - 1].night, 1)),
                    assignedAt: reservedAt, assignedBy: ACTOR_ID,
                    occupantCount: num(lead.no_of_occupant), adultCount: num(lead.no_of_adults),
                    cnb6To10Count: num(lead.cnb_count_six_to_ten), cnbUnder6Count: num(lead.cnb_count_below_six),
                    extraBedCount: num(lead.no_of_extra_beds),
                    mealPlanCpCount: num(lead.cp_count), mealPlanMaplCount: num(lead.map_lunch_count),
                    mealPlanMapdCount: num(lead.map_dinner_count), mealPlanApCount: num(lead.ap_count),
                    negotiatedRoomRate: D(num(lead.negotiated_price)), negotiatedExtraBedRate: D(num(lead.negotiated_extra_bed_rate)),
                    // No frozen figures: nothing bills from a finished stay's rooms, and the old
                    // system's per-night rounding and its 20% nights fit none of this system's
                    // rules for them. The folio lines carry every room-night's money.
                    notes: `${IMPORT_TAG} · old reference ${p.ref} · a finished stay`,
                  },
                });
              }
            }
          }

          /* the folio, its lines and its money */
          const folioId = await allocateReadableId(tx, "FOLIO", reservedAt);
          const folioState = p.outcome === "NO_SHOW" ? FolioState.NO_SHOW_CLOSED : fate.due > 0 ? FolioState.OUTSTANDING : FolioState.SETTLED;
          await tx.folio.create({
            data: {
              id: folioId, entryId, state: folioState, billingModel: "GUEST_PAY",
              convertedToLiveAt: p.outcome === "NO_SHOW" ? null : utc(v.checkIn), convertedBy: p.outcome === "NO_SHOW" ? null : ACTOR_ID,
              closedAt: folioState === FolioState.OUTSTANDING ? null : checkOutAt, closedBy: folioState === FolioState.OUTSTANDING ? null : ACTOR_ID,
              advancePaymentReconciliationComplete: true, lineSequence: v.lines.length,
              ...(p.outcome === "NO_SHOW" ? { noShowPenaltyAmount: D(0), noShowAdvancePaymentAmount: D(v.advanceShare), noShowNetPosition: D(0), noShowFomDetermination: ACTOR_ID } : {}),
              createdAt: reservedAt, createdBy: ACTOR_ID,
            },
          });
          if (v.lines.length) {
            await tx.folioLine.createMany({
              data: v.lines.map((l, i) => ({
                id: formatFolioLineId(folioId, i + 1), folioId, lineType: l.lineType, description: l.description,
                amount: D(l.amount), currency: "BTN", chargeDate: utc(l.chargeDate), stage: Stage.S7, postedBy: ACTOR_ID,
                postedAt: new Date(utc(addDays(l.chargeDate, 1)).getTime() + 2 * 3_600_000), createdAt: reservedAt,
                billingModel: "GUEST_PAY", roomId: l.roomNo ? roomByNo.get(l.roomNo)!.id : null,
              })),
            });
            lineCount += v.lines.length;
          }
          if (v.advanceShare > 0.005) {
            const method = paymentMethod(p.advanceMode);
            await tx.paymentRecord.create({
              data: {
                id: await allocateReadableId(tx, "PAYMENT", reservedAt), folioId, entryId, amount: D(v.advanceShare), currency: "BTN",
                paymentMethod: method, paymentDirection: PaymentDirection.IN, receivedAt: reservedAt, recordedBy: ACTOR_ID,
                stage: Stage.S3, billingModel: "GUEST_PAY", createdAt: reservedAt,
                notes: `Advance taken in the old system · reference ${p.ref}${method === "OTHER" ? " · it did not record how the money arrived" : ""}`,
              },
            });
          }
          if (fate.settlement > 0.005) {
            await tx.paymentRecord.create({
              data: {
                id: await allocateReadableId(tx, "PAYMENT", checkOutAt), folioId, entryId, amount: D(fate.settlement), currency: "BTN",
                paymentMethod: "OTHER", paymentDirection: PaymentDirection.IN, receivedAt: checkOutAt, recordedBy: ACTOR_ID,
                stage: Stage.S8, billingModel: "GUEST_PAY", createdAt: checkOutAt,
                notes: `Paid at check-out — the booking is closed in the old system (reference ${p.ref}), which means paid in full; it did not record how`,
              },
            });
          }
          await recomputeFolioOutstandingBalance(tx, folioId);

          if (p.outcome === "NO_SHOW") {
            await tx.noShowDeterminationRecord.create({
              data: {
                id: await allocateReadableId(tx, "NO_SHOW", checkOutAt), entryId, determinationPath: "IMPORTED", fomActorId: ACTOR_ID,
                contactAttemptLog: [] as Prisma.InputJsonValue,
                decisionReason: `No bill and no check-in in the old system (reference ${p.ref}) — brought across as a no-show, nothing owed`,
                determinedAt: checkOutAt, createdAt: checkOutAt, createdBy: ACTOR_ID,
              },
            });
          }
          await tx.traceEvent.create({
            data: {
              eventType: "ENTRY.IMPORTED_FROM_OLD_SYSTEM", actorId: ACTOR_ID, entityType: "Entry", entityId: entryId,
              operation: "CREATE", entryId, inquiryId: inqId!, stageContext: Stage.S9, segmentContext: segment.id,
              timestamp: checkOutAt, createdAt: checkOutAt,
              payload: {
                oldReference: p.ref, pastStay: true, oldBookingStatus: p.status, outcome: p.outcome,
                checkIn: v.checkIn, checkOut: v.checkOut, charges: v.charges.toFixed(2), advance: v.advanceShare.toFixed(2),
                paidAtCheckOut: fate.settlement.toFixed(2), due: fate.due.toFixed(2), billTotal: p.billTotal.toFixed(2),
                billDifference: p.diffIsRounding ? "0.00" : p.diff.toFixed(2), roomsNotInThisSystem: p.missingRooms,
              },
            } as Prisma.TraceEventUncheckedCreateInput,
          });
          stays++;
        }

        /* the later visit already here gives back the part of the advance the earlier one used */
        for (const a of p.presentAdjust.filter((x) => x.ok)) {
          const folio = await tx.folio.findUniqueOrThrow({ where: { id: a.folioId }, include: { payments: true } });
          const mine = folio.payments.filter((x) => (x.notes ?? "").includes("Advance taken in the old system"));
          const others = folio.payments.filter((x) => !mine.includes(x));
          if (others.length || folio.state === FolioState.SETTLED || r2(mine.reduce((s, x) => s + Number(x.amount), 0)) !== a.from) {
            throw new Error(`${a.entryId}: its folio changed since the plan was made — run again`);
          }
          const was = mine[0];
          for (const x of mine) await tx.paymentRecord.delete({ where: { id: x.id } });
          if (a.to > 0.005) {
            await tx.paymentRecord.create({
              data: {
                id: await allocateReadableId(tx, "PAYMENT", was?.receivedAt ?? folio.createdAt), folioId: folio.id, entryId: a.entryId,
                amount: D(a.to), currency: "BTN", paymentMethod: was?.paymentMethod ?? "OTHER", paymentDirection: PaymentDirection.IN,
                receivedAt: was?.receivedAt ?? folio.createdAt, recordedBy: ACTOR_ID, stage: Stage.S3, billingModel: "GUEST_PAY",
                notes: `${was?.notes ?? `Advance taken in the old system · reference ${p.ref}`} · shared with the earlier visit (${(a.from - a.to).toFixed(2)} of ${a.from.toFixed(2)} went to it)`,
              },
            });
          }
          await recomputeFolioOutstandingBalance(tx, folio.id);
          await tx.traceEvent.create({
            data: {
              eventType: "PAYMENT.ADVANCE_SHARED_WITH_EARLIER_VISIT", actorId: ACTOR_ID, entityType: "Folio", entityId: folio.id,
              operation: "UPDATE", entryId: a.entryId, inquiryId: inqId!, stageContext: Stage.S7,
              payload: { oldReference: p.ref, from: a.from.toFixed(2), to: a.to.toFixed(2), reason: "the old system took one advance for the whole trip; the earlier visit, now brought across, takes its part first" },
            } as Prisma.TraceEventUncheckedCreateInput,
          });
          adjusted++;
        }
      }, { timeout: 180_000, maxWait: 30_000 });
      written++;
      if (written % 100 === 0) console.log(`  …${written} bookings written`);
    } catch (e) {
      failed++;
      console.log(`  ! ${p.ref}: ${(e as Error).message.split("\n").slice(-3).join(" ")}`);
    }
  }

  console.log(`\nwritten: ${written} booking(s) · ${stays} stay(s) · ${lineCount} folio line(s)${adjusted ? ` · ${adjusted} later visit(s) had the advance shared` : ""}${failed ? ` · FAILED: ${failed}` : ""}\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
