/**
 * Money audit — READ-ONLY diagnostic over every folio, payment, frozen figure and derived
 * money surface (2026-08-24). Run any time; writes nothing.
 *
 *   npx tsx scripts/audit-money.ts            # full report
 *   npx tsx scripts/audit-money.ts --verbose  # list every INFO finding too
 *
 * What it checks (one finding per violation, graded CRITICAL / WARN / INFO):
 *
 *   A. Ledger & balance integrity (every folio)
 *      A1 BALANCE_DRIFT        stored outstandingBalance ≠ max(0, Σlines − ΣIN + ΣOUT − ΣWO)
 *      A2 STATE_MONEY          SETTLED folio whose derived balance isn't 0; LIVE folio on a dead entry
 *      A3 OVERPAY_CLAMPED      gross balance < 0 (the max(0,·) clamp hides money owed back)
 *      A4 ORPHAN_COMPANION     SC/GST companion whose named base charge isn't on the ledger
 *      A5 COMPANION_MATH       companion amount ≠ its base × the rate its own description states
 *      A6 FAMILY_TAX           charge + its corrections + all their tax lines don't re-sum
 *      A7 DUPLICATE_NIGHT      two positive room-charge lines, same night, same description
 *      A8 NEGATIVE_ANOMALY     negative plain charge / negative non-correction companion
 *      A9 UNTAXED_ACTIVE_ROOM  audit-stamped room line with no companions on a LIVE/OUTSTANDING
 *                              folio of an ACTIVE entry (the 2026-08-18 backfill should cover these)
 *      A10 LEGACY_RENDER_TAX   room nights whose SC/GST exists only at document render time —
 *                              quantifies how far printed documents exceed the ledger's own billed
 *   B. Payments: non-positive amounts; refunds exceeding receipts
 *   C. Frozen layer: frozenTotal vs frozenSubtotal × (era tax multipliers); audit per-night posts
 *      vs frozenSubtotal ÷ nights; frozen rows with null dates
 *   D. Night coverage: completed stays (S8/S9/CLOSED) missing a room charge for a stay night
 *   E. Interim requests & invoices: dueNow = max(0, ask − received); INTERIM invoice amount =
 *      request.dueNow; PAID backed by linked payments; broken supersede chains
 *   F. Cross-links: credit-extension records and interim-linked payments pointing at real rows
 *   G. Billing-summary reconciliation for ACTIVE entries (billed = Σ lines; base+SC+GST = total;
 *      per-room buckets + unassigned = whole)
 *   H. Global tallies (printed at the end)
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { round2, sumMoney, toDecimal, ZERO } from "../src/lib/money.js";
import {
  CORRECTION_LINE_PREFIX,
  classifyFolioLine,
  companionBaseDescription,
  companionRateFromDescription,
  isCorrectionCompanionDescription,
} from "../src/lib/folio-tax-lines.js";
import { effectiveCheckOutDate } from "../src/lib/stay-dates.js";
import { buildEntryBillingSummary } from "../src/services/domain/entry-billing-summary-service.js";

const prisma = new PrismaClient();
const VERBOSE = process.argv.includes("--verbose");

type Severity = "CRITICAL" | "WARN" | "INFO";
type Finding = { severity: Severity; code: string; subject: string; detail: string };
const findings: Finding[] = [];
const add = (severity: Severity, code: string, subject: string, detail: string) =>
  findings.push({ severity, code, subject, detail });

const D = (v: Prisma.Decimal | number | string | null | undefined) => toDecimal(v ?? 0);
const money = (v: Prisma.Decimal) => v.toFixed(2);
const near = (a: Prisma.Decimal, b: Prisma.Decimal, tol = 0.01) => a.sub(b).abs().lte(tol);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const [scRow, gstRow] = await Promise.all([
    prisma.configurationEntry.findFirst({ where: { configKey: "billing.serviceChargeRate", effectiveTo: null }, orderBy: { effectiveFrom: "desc" } }),
    prisma.configurationEntry.findFirst({ where: { configKey: "billing.salesTaxRate", effectiveTo: null }, orderBy: { effectiveFrom: "desc" } }),
  ]);
  const scRate = Number(scRow?.configValue ?? 0.1);
  const gstRate = Number(gstRow?.configValue ?? 0.05);

  const entries = await prisma.entry.findMany({
    include: {
      folio: { include: { lines: true, payments: true } },
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true, frozenRate: true } },
      roomAssignments: { include: { room: { select: { roomNumber: true } } } },
    },
  });
  const writeOffs = await prisma.writeOffRecord.groupBy({ by: ["folioId"], _sum: { writtenOffAmount: true } });
  const woByFolio = new Map(writeOffs.map((w) => [w.folioId, D(w._sum.writtenOffAmount)]));

  // ── H tallies (accumulated as we walk) ──────────────────────────────────────────────────
  const tally = new Map<string, { count: number; billed: Prisma.Decimal; paidIn: Prisma.Decimal; paidOut: Prisma.Decimal; outstanding: Prisma.Decimal }>();
  let legacyTaxTotal = ZERO;
  let legacyFolios = 0;
  const rateHistogram = new Map<string, number>();

  for (const entry of entries) {
    const folio = entry.folio;
    if (!folio) continue;
    const lines = folio.lines ?? [];
    const payments = folio.payments ?? [];
    const isImported = lines.some((l) => l.description.includes("(imported)"));
    const tag = `${folio.id} (${entry.id} ${entry.status}/${entry.currentStage}, ${folio.state}${isImported ? ", imported" : ""})`;

    // A1 — stored balance vs the recompute rule (mirror of recomputeFolioOutstandingBalance).
    // Imported folios are their own class: the legacy importer brought the CHARGES across but
    // not the old system's payments, and pinned the balance to what legacy said (usually 0).
    // That is import shape, not corruption — but it means any future recompute on such a folio
    // (a correction, a payment event) would resurrect a phantom balance, so it is surfaced.
    const lineSum = sumMoney(lines.map((l) => l.amount));
    const inSum = sumMoney(payments.filter((p) => p.paymentDirection === "IN").map((p) => p.amount));
    const outSum = sumMoney(payments.filter((p) => p.paymentDirection === "OUT").map((p) => p.amount));
    const wo = woByFolio.get(folio.id) ?? ZERO;
    const gross = lineSum.sub(inSum).add(outSum).sub(wo);
    const derived = round2(gross.lt(0) ? ZERO : gross);
    const stored = D(folio.outstandingBalance);
    if (!near(stored, derived)) {
      if (isImported) {
        add("WARN", "A1_IMPORTED_UNBALANCED", tag, `stored ${money(stored)} vs recompute ${money(derived)} — legacy import carries charges without the old system's payments; a future recompute would flip this balance`);
      } else {
        add("CRITICAL", "A1_BALANCE_DRIFT", tag, `stored ${money(stored)} vs derived ${money(derived)} (lines ${money(lineSum)} − in ${money(inSum)} + out ${money(outSum)} − writeOffs ${money(wo)})`);
      }
    }
    // A2 — state vs money (system folios only; imported states mirror the legacy system's word).
    if (folio.state === "SETTLED" && !near(derived, ZERO) && !isImported) {
      add("CRITICAL", "A2_SETTLED_NONZERO", tag, `SETTLED but derived balance ${money(derived)}`);
    }
    if (folio.state === "LIVE" && (entry.status === "EXPIRED" || entry.status === "CANCELLED" || entry.status === "CLOSED")) {
      add("WARN", "A2_LIVE_ON_DEAD_ENTRY", tag, `folio LIVE while the entry is ${entry.status} — stranded ledger`);
    }
    // A3 — payments exceed charges (the max(0,·) clamp hides the credit). Normal for a
    // provisional folio holding an advance before any charge posts; worth eyes on a live or
    // sealed ledger, and a real leak on a dead entry (money came in, the stay never happened).
    if (gross.lt(-0.005)) {
      const isDead = entry.status === "EXPIRED" || entry.status === "CANCELLED";
      const sev: Severity = isDead ? "WARN" : "INFO";
      add(sev, "A3_PAYMENTS_EXCEED_CHARGES", tag, `payments exceed charges by ${money(gross.neg())}${folio.state === "PROVISIONAL" ? " (advance held, no charges yet — normal pre-stay)" : ""}${isDead ? " — the entry is dead; is a refund owed?" : ""}`);
    }

    // ── Companion structure ───────────────────────────────────────────────────────────────
    const charges = lines.filter((l) => classifyFolioLine(l) === "CHARGE");
    const companions = lines.filter((l) => classifyFolioLine(l) !== "CHARGE");
    for (const c of companions) {
      const r = companionRateFromDescription(c.description);
      if (r != null) rateHistogram.set(`${classifyFolioLine(c)} ${(r * 100).toFixed(2)}%`, (rateHistogram.get(`${classifyFolioLine(c)} ${(r * 100).toFixed(2)}%`) ?? 0) + 1);
    }

    // Family = charges grouped by (roomId, ymd, description) — the matching rule every reader uses.
    const familyKey = (roomId: string | null, day: string, desc: string) => `${roomId ?? "-"}|${day}|${desc}`;
    const chargeFamilies = new Map<string, { total: Prisma.Decimal; count: number }>();
    for (const ch of charges) {
      const k = familyKey(ch.roomId, ymd(ch.chargeDate), ch.description);
      const f = chargeFamilies.get(k) ?? { total: ZERO, count: 0 };
      f.total = f.total.add(D(ch.amount));
      f.count += 1;
      chargeFamilies.set(k, f);
    }
    // Companion sums per family — a family can legitimately hold several charge lines with the
    // SAME description on one day (two "water" posts), each with its own companions; only the
    // SUMS are well-defined, so the math check (A5) runs family-level, not per companion line.
    type FamTax = { sc: Prisma.Decimal; gst: Prisma.Decimal; scRate: number | null; gstRate: number | null; scCount: number; gstCount: number };
    const taxByFamily = new Map<string, FamTax>();
    for (const c of companions) {
      const isCorr = isCorrectionCompanionDescription(c.description);
      const base = companionBaseDescription(c.description);
      const kind = classifyFolioLine(c);
      if (isCorr) {
        // A correction companion names the ORIGINAL charge but is dated with the correction —
        // it must sit beside a correction row on the same room + date. Its MATH is covered by
        // the A6 family re-sum below.
        const hasCorrRow = charges.some(
          (ch) => (ch.roomId ?? null) === (c.roomId ?? null) && ymd(ch.chargeDate) === ymd(c.chargeDate) && ch.description.startsWith(CORRECTION_LINE_PREFIX),
        );
        if (!hasCorrRow) add("WARN", "A4_ORPHAN_COMPANION", tag, `correction companion "${c.description}" (${money(D(c.amount))}) has no correction row beside it`);
        continue;
      }
      if (base == null) {
        add("INFO", "A4_COMPANION_NO_BASE_NAMED", tag, `companion "${c.description}" names no base (legacy shape)`);
        continue;
      }
      const k = familyKey(c.roomId, ymd(c.chargeDate), base);
      if (!chargeFamilies.has(k)) {
        add("WARN", "A4_ORPHAN_COMPANION", tag, `${kind} companion for "${base}" on ${ymd(c.chargeDate)} — no such charge that day/room`);
        continue;
      }
      const t2 = taxByFamily.get(k) ?? { sc: ZERO, gst: ZERO, scRate: null, gstRate: null, scCount: 0, gstCount: 0 };
      const rate = companionRateFromDescription(c.description);
      if (kind === "SERVICE_CHARGE") {
        t2.sc = t2.sc.add(D(c.amount));
        t2.scRate = t2.scRate ?? rate;
        t2.scCount += 1;
      } else {
        t2.gst = t2.gst.add(D(c.amount));
        t2.gstRate = t2.gstRate ?? rate;
        t2.gstCount += 1;
      }
      taxByFamily.set(k, t2);
    }
    // A5 — family-level tax math at the rate the companions themselves state. Families whose
    // charge was CORRECTED are excluded here (A6 re-sums those including the correction lines).
    const correctedDescs = new Set(
      charges
        .filter((ch) => ch.description.startsWith(CORRECTION_LINE_PREFIX))
        .map((ch) => lines.find((l) => l.id === /^Correction for ([^:]+):/.exec(ch.description)?.[1]?.trim())?.description)
        .filter((x): x is string => !!x),
    );
    for (const [k, t2] of taxByFamily) {
      const [, , desc] = k.split("|");
      if (correctedDescs.has(desc)) continue;
      const fam = chargeFamilies.get(k)!;
      if (t2.scRate != null) {
        const expected = round2(fam.total.mul(t2.scRate));
        if (!near(t2.sc, expected, 0.01 * Math.max(1, t2.scCount))) {
          add("WARN", "A5_COMPANION_MATH", tag, `"${desc}": ΣSC ${money(t2.sc)} ≠ ${money(expected)} (base ${money(fam.total)} × ${(t2.scRate * 100).toFixed(2)}%)`);
        }
      }
      if (t2.gstRate != null) {
        const expected = round2(fam.total.add(t2.sc).mul(t2.gstRate));
        if (!near(t2.gst, expected, 0.011 * Math.max(1, t2.gstCount))) {
          add("WARN", "A5_COMPANION_MATH", tag, `"${desc}": ΣGST ${money(t2.gst)} ≠ ${money(expected)} (base+SC ${money(fam.total.add(t2.sc))} × ${(t2.gstRate * 100).toFixed(2)}%)`);
        }
      }
    }

    // A6 — corrected families re-sum: original + corrections + every tax line that names the original.
    const corrections = charges.filter((ch) => ch.description.startsWith(CORRECTION_LINE_PREFIX));
    const correctedIds = new Set(
      corrections.map((ch) => /^Correction for ([^:]+):/.exec(ch.description)?.[1]?.trim()).filter((x): x is string => !!x),
    );
    for (const origId of correctedIds) {
      const orig = lines.find((l) => l.id === origId);
      if (!orig) {
        add("WARN", "A6_CORRECTION_ORPHAN", tag, `correction references line ${origId} which is not on this folio`);
        continue;
      }
      const corrOfOrig = corrections.filter((ch) => ch.description.startsWith(`${CORRECTION_LINE_PREFIX}${origId}:`));
      const famNet = D(orig.amount).add(sumMoney(corrOfOrig.map((c) => c.amount)));
      const taxLines = companions.filter((c) => companionBaseDescription(c.description) === orig.description && (c.roomId ?? null) === (orig.roomId ?? null));
      const scSum = sumMoney(taxLines.filter((c) => classifyFolioLine(c) === "SERVICE_CHARGE").map((c) => c.amount));
      const gstSum = sumMoney(taxLines.filter((c) => classifyFolioLine(c) === "GST").map((c) => c.amount));
      // Rate: what the original's own companion states; families with no tax lines are exempt.
      const origSc = taxLines.find((c) => classifyFolioLine(c) === "SERVICE_CHARGE" && !isCorrectionCompanionDescription(c.description));
      const origGst = taxLines.find((c) => classifyFolioLine(c) === "GST" && !isCorrectionCompanionDescription(c.description));
      const famScRate = origSc ? companionRateFromDescription(origSc.description) : null;
      const famGstRate = origGst ? companionRateFromDescription(origGst.description) : null;
      const tol = 0.02 + 0.01 * corrOfOrig.length;
      if (famScRate != null && !near(scSum, round2(famNet.mul(famScRate)), tol)) {
        add("WARN", "A6_FAMILY_TAX", tag, `"${orig.description}" family: net ${money(famNet)} but ΣSC ${money(scSum)} ≠ ${money(round2(famNet.mul(famScRate)))}`);
      }
      if (famGstRate != null && !near(gstSum, round2(famNet.add(scSum).mul(famGstRate)), tol)) {
        add("WARN", "A6_FAMILY_TAX", tag, `"${orig.description}" family: net+SC ${money(famNet.add(scSum))} but ΣGST ${money(gstSum)} ≠ ${money(round2(famNet.add(scSum).mul(famGstRate)))}`);
      }
    }

    // A7 — duplicate room nights (same day, same description, positive, not corrections).
    for (const [k, f] of chargeFamilies) {
      const [, day, desc] = k.split("|");
      const isRoom = charges.some((ch) => ch.description === desc && (ch.lineType === "ROOM_CHARGE" || ch.lineType === "STAY"));
      if (f.count > 1 && isRoom && f.total.gt(0) && !desc.startsWith(CORRECTION_LINE_PREFIX)) {
        add("WARN", "A7_DUPLICATE_NIGHT", tag, `"${desc}" posted ${f.count}× on ${day} (Σ ${money(f.total)})`);
      }
    }

    // A8 — sign anomalies.
    for (const ch of charges) {
      if (D(ch.amount).lt(0) && ch.lineType !== "CREDIT_NOTE" && !ch.description.startsWith(CORRECTION_LINE_PREFIX)) {
        add("WARN", "A8_NEGATIVE_CHARGE", tag, `negative ${ch.lineType} "${ch.description}" ${money(D(ch.amount))}`);
      }
    }
    for (const c of companions) {
      if (D(c.amount).lt(0) && !isCorrectionCompanionDescription(c.description)) {
        add("WARN", "A8_NEGATIVE_COMPANION", tag, `negative non-correction companion "${c.description}" ${money(D(c.amount))}`);
      }
    }

    // A9/A10 — room lines whose tax exists only at render time (the ledger-view legacy rule).
    const auditRunsWithCompanions = new Set(companions.map((l) => l.nightAuditRecordId).filter((id): id is string => !!id));
    const legacyRoomLines = charges.filter(
      (l) => (l.lineType === "ROOM_CHARGE" || l.lineType === "STAY") && !(l.nightAuditRecordId && auditRunsWithCompanions.has(l.nightAuditRecordId)),
    );
    if (legacyRoomLines.length > 0) {
      const legacyNet = sumMoney(legacyRoomLines.map((l) => l.amount));
      const legSc = round2(legacyNet.mul(scRate));
      const legGst = round2(legacyNet.add(legSc).mul(gstRate));
      legacyTaxTotal = legacyTaxTotal.add(legSc).add(legGst);
      legacyFolios += 1;
      const activeGap = entry.status === "ACTIVE" && (folio.state === "LIVE" || folio.state === "OUTSTANDING");
      const stamped = legacyRoomLines.filter((l) => l.nightAuditRecordId).length;
      if (activeGap && stamped > 0) {
        add("WARN", "A9_UNTAXED_ACTIVE_ROOM", tag, `${stamped} audit-stamped room line(s) with no SC/GST companions on an active folio — backfill gap`);
      }
      add(
        activeGap ? "WARN" : "INFO",
        "A10_LEGACY_RENDER_TAX",
        tag,
        `${legacyRoomLines.length} room line(s), net ${money(legacyNet)} — documents add SC ${money(legSc)} + GST ${money(legGst)} at render that the ledger/balance never charged${payments.length ? ` (folio HAS payments: printed total − payments ≠ payable)` : ""}`,
      );
    }

    // B — payments.
    for (const p of payments) {
      if (D(p.amount).lte(0)) add("CRITICAL", "B1_NONPOSITIVE_PAYMENT", tag, `payment ${p.id} ${p.paymentDirection} ${money(D(p.amount))}`);
    }
    if (outSum.gt(inSum.add(0.005))) add("WARN", "B2_REFUND_EXCEEDS_RECEIPTS", tag, `OUT ${money(outSum)} > IN ${money(inSum)}`);

    // C — frozen layer.
    for (const a of entry.roomAssignments ?? []) {
      if (a.frozenSubtotal == null) continue;
      const sub = D(a.frozenSubtotal);
      const roomNo = a.room?.roomNumber ?? a.roomId.slice(0, 6);
      if (a.frozenTotal != null) {
        const total = D(a.frozenTotal);
        const scOn = a.isFoc ? false : a.serviceChargeApplies !== false;
        const gstOn = a.isFoc ? false : a.gstApplies !== false;
        const flagged = round2(sub.mul(scOn ? 1 + scRate : 1).mul(gstOn ? 1 + gstRate : 1));
        const eras = [
          { label: "flags@current rates", v: flagged },
          { label: "net only (pre-tax era)", v: round2(sub) },
          { label: "SC only (GST-off era)", v: round2(sub.mul(1 + scRate)) },
        ];
        const hit = eras.find((e) => near(total, e.v, 0.02));
        if (!hit) {
          add("WARN", "C1_FROZEN_TOTAL_MATH", `${entry.id} ${a.id}`, `room ${roomNo}: frozenTotal ${money(total)} matches no rule from frozenSubtotal ${money(sub)} (flags→${money(flagged)})`);
        } else if (hit.label !== "flags@current rates") {
          add("INFO", "C1_FROZEN_ERA", `${entry.id} ${a.id}`, `room ${roomNo}: frozenTotal ${money(total)} = ${hit.label}`);
        }
      }
      if (a.startDate == null || a.endDate == null) {
        add("INFO", "C4_NULL_DATED_FROZEN_ROW", `${entry.id} ${a.id}`, `room ${roomNo}: frozenSubtotal ${money(sub)} on a row with ${a.startDate == null ? "null startDate" : ""}${a.endDate == null ? " null endDate" : ""} — audit falls back to frozenRate for it`);
        continue;
      }
      // C2 — audited per-night posts vs frozenSubtotal ÷ nights.
      const nights = Math.max(1, Math.round((a.endDate.getTime() - a.startDate.getTime()) / 86_400_000));
      const perNight = round2(sub.div(nights));
      const auditPosts = charges.filter((l) => l.lineType === "ROOM_CHARGE" && l.nightAuditRecordId && l.roomId === a.roomId && l.chargeDate >= a.startDate! && l.chargeDate < a.endDate!);
      for (const p of auditPosts) {
        if (!near(D(p.amount), perNight, 0.02)) {
          add("WARN", "C2_AUDIT_VS_FROZEN", `${entry.id} ${a.id}`, `room ${roomNo} night ${ymd(p.chargeDate)}: posted ${money(D(p.amount))} vs frozen per-night ${money(perNight)} (${money(sub)}/${nights})`);
        }
      }
      if (sumMoney(auditPosts.map((p) => p.amount)).gt(sub.add(0.05))) {
        add("WARN", "C2_OVERPOSTED_ROOM", `${entry.id} ${a.id}`, `room ${roomNo}: Σ audited ${money(sumMoney(auditPosts.map((p) => p.amount)))} exceeds frozenSubtotal ${money(sub)}`);
      }
    }

    // D — night coverage for completed, system-produced stays.
    const completed = entry.currentStage === "S8" || entry.currentStage === "S9" || entry.status === "CLOSED";
    if (completed && entry.reservation && !isImported && lines.length > 0) {
      const start = entry.reservation.frozenCheckInDate;
      const end = effectiveCheckOutDate(entry) ?? entry.reservation.frozenCheckOutDate;
      const covered = new Set(charges.filter((l) => l.lineType === "ROOM_CHARGE" || l.lineType === "STAY").map((l) => ymd(l.chargeDate)));
      const missing: string[] = [];
      for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
        const day = ymd(new Date(t));
        if (!covered.has(day)) missing.push(day);
      }
      if (missing.length) add("WARN", "D1_NIGHT_UNBILLED", tag, `stay ${ymd(start)}→${ymd(end)}: no room charge for ${missing.join(", ")}`);
    }

    // H tallies.
    const t = tally.get(folio.state) ?? { count: 0, billed: ZERO, paidIn: ZERO, paidOut: ZERO, outstanding: ZERO };
    t.count += 1;
    t.billed = t.billed.add(lineSum);
    t.paidIn = t.paidIn.add(inSum);
    t.paidOut = t.paidOut.add(outSum);
    t.outstanding = t.outstanding.add(stored);
    tally.set(folio.state, t);
  }

  // ── E — interim requests & invoices ────────────────────────────────────────────────────
  const requests = await prisma.interimPaymentRequest.findMany();
  const invoiceIds = new Set((await prisma.invoice.findMany({ select: { id: true } })).map((i) => i.id));
  const interimInvoices = await prisma.invoice.findMany({ where: { invoiceType: "INTERIM" } });
  const invoiceById = new Map(interimInvoices.map((i) => [i.id, i]));
  for (const r of requests) {
    const rTag = `${r.id} (${r.kind} ${r.state}, ${r.entryId})`;
    const ask = r.askMode === "PERCENT" ? round2(D(r.projectedTotal).mul(D(r.askValue)).div(100)) : D(r.askValue);
    const expectedDue = round2(ask.sub(D(r.receivedAtRequest)).lt(0) ? ZERO : ask.sub(D(r.receivedAtRequest)));
    const due = D(r.dueNow);
    if (due.gt(expectedDue.add(0.02))) {
      add("WARN", "E2_DUE_EXCEEDS_ASK", rTag, `dueNow ${money(due)} > ask ${money(ask)} − received ${money(D(r.receivedAtRequest))}`);
    } else if (!near(due, expectedDue, 0.02)) {
      add("INFO", "E2_DUE_CAPPED", rTag, `dueNow ${money(due)} < ask−received ${money(expectedDue)} (capped at what the stay can still owe)`);
    }
    if (r.invoiceId) {
      const inv = invoiceById.get(r.invoiceId);
      if (!inv) add("WARN", "E1_INTERIM_INVOICE_MISSING", rTag, `invoiceId ${r.invoiceId} not found among INTERIM invoices`);
      else if (inv.totalAmount != null && !near(D(inv.totalAmount), due, 0.01)) {
        add("WARN", "E1_INTERIM_AMOUNT", rTag, `invoice ${inv.id} totalAmount ${money(D(inv.totalAmount))} ≠ request dueNow ${money(due)}`);
      }
    }
    if (r.state === "PAID") {
      const linked = await prisma.paymentRecord.aggregate({ where: { interimPaymentRequestId: r.id, paymentDirection: "IN" }, _sum: { amount: true } });
      if (D(linked._sum.amount).lt(due.sub(0.01))) {
        add("WARN", "E3_PAID_UNBACKED", rTag, `state PAID but linked payments ${money(D(linked._sum.amount))} < dueNow ${money(due)}`);
      }
    }
  }
  const allInvoices = await prisma.invoice.findMany({ select: { id: true, invoiceType: true, state: true, totalAmount: true, supersededById: true } });
  for (const inv of allInvoices) {
    if (inv.totalAmount != null && D(inv.totalAmount).lt(0)) add("WARN", "E4_NEGATIVE_INVOICE", inv.id, `${inv.invoiceType} totalAmount ${money(D(inv.totalAmount))}`);
    if (inv.supersededById && !invoiceIds.has(inv.supersededById)) add("WARN", "E4_BROKEN_SUPERSEDE", inv.id, `supersededById ${inv.supersededById} does not exist`);
  }

  // ── F — cross-links ─────────────────────────────────────────────────────────────────────
  const folioIds = new Set(entries.map((e) => e.folio?.id).filter((x): x is string => !!x));
  for (const ce of await prisma.creditExtensionCeilingRecord.findMany()) {
    if (!folioIds.has(ce.folioId)) add("WARN", "F1_CREDIT_EXT_ORPHAN", ce.id, `folioId ${ce.folioId} has no folio (ceiling ${money(D(ce.ceilingAmount))})`);
  }
  const reqIds = new Set(requests.map((r) => r.id));
  for (const p of await prisma.paymentRecord.findMany({ where: { interimPaymentRequestId: { not: null } }, select: { id: true, interimPaymentRequestId: true } })) {
    if (!reqIds.has(p.interimPaymentRequestId!)) add("WARN", "F2_PAYMENT_REQ_ORPHAN", p.id, `interimPaymentRequestId ${p.interimPaymentRequestId} has no request`);
  }

  // ── G — billing-summary reconciliation for ACTIVE entries with a folio ─────────────────
  for (const entry of entries.filter((e) => e.status === "ACTIVE" && e.folio)) {
    try {
      const s = await buildEntryBillingSummary(prisma, entry.id);
      const fb = s.folio;
      if (!fb) continue;
      const myLines = sumMoney((entry.folio!.lines ?? []).map((l) => l.amount));
      if (fb.billedSoFar != null && !near(D(fb.billedSoFar), myLines, 0.01)) {
        add("WARN", "G1_SUMMARY_BILLED", entry.id, `billing-summary billedSoFar ${fb.billedSoFar} ≠ Σ lines ${money(myLines)}`);
      }
      if (fb.chargeBreakdown && fb.billedSoFar != null && Math.abs(fb.chargeBreakdown.total - fb.billedSoFar) > 0.01) {
        add("WARN", "G2_SUMMARY_BREAKDOWN", entry.id, `base+SC+GST ${fb.chargeBreakdown.total} ≠ billedSoFar ${fb.billedSoFar}`);
      }
      if (fb.perRoomCharges && fb.billedSoFar != null) {
        const buckets = fb.perRoomCharges.reduce((s2, r) => s2 + r.charges, 0) + (fb.unassignedCharges?.charges ?? 0);
        if (Math.abs(buckets - fb.billedSoFar) > 0.01) add("WARN", "G3_SUMMARY_BUCKETS", entry.id, `per-room+unassigned ${buckets.toFixed(2)} ≠ billedSoFar ${fb.billedSoFar}`);
        for (const r of fb.perRoomCharges) {
          if (Math.abs(r.base + r.serviceCharge + r.gst - r.charges) > 0.01) {
            add("WARN", "G4_SUMMARY_ROOM_SPLIT", entry.id, `room ${r.roomNumber}: base+SC+GST ${(r.base + r.serviceCharge + r.gst).toFixed(2)} ≠ charges ${r.charges}`);
          }
        }
      }
    } catch (e) {
      add("WARN", "G0_SUMMARY_ERROR", entry.id, `buildEntryBillingSummary threw: ${(e as Error).message}`);
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────────
  const bySeverity: Record<Severity, Finding[]> = { CRITICAL: [], WARN: [], INFO: [] };
  for (const f of findings) bySeverity[f.severity].push(f);
  console.log(`\n════ MONEY AUDIT — ${new Date().toISOString().slice(0, 16)} ════`);
  console.log(`rates in force: SC ${(scRate * 100).toFixed(2)}% · GST ${(gstRate * 100).toFixed(2)}% (compound on net+SC)`);
  console.log(`companion lines by stated rate: ${[...rateHistogram.entries()].map(([k, v]) => `${k}×${v}`).join(" · ") || "(none)"}`);
  console.log(`\nFolio tallies by state (count · Σ lines · Σ paid in · Σ paid out · Σ stored outstanding):`);
  for (const [state, t] of [...tally.entries()].sort()) {
    console.log(`  ${state.padEnd(16)} ${String(t.count).padStart(4)} · ${money(t.billed).padStart(12)} · ${money(t.paidIn).padStart(12)} · ${money(t.paidOut).padStart(10)} · ${money(t.outstanding).padStart(12)}`);
  }
  console.log(`legacy render-time tax (documents > ledger): ${money(legacyTaxTotal)} across ${legacyFolios} folio(s)\n`);
  for (const sev of ["CRITICAL", "WARN", "INFO"] as const) {
    const list = bySeverity[sev];
    console.log(`── ${sev}: ${list.length} ──`);
    const byCode = new Map<string, Finding[]>();
    for (const f of list) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f]);
    for (const [code, fs] of byCode) {
      console.log(`  ${code} (${fs.length})`);
      const cap = sev === "INFO" && !VERBOSE ? 8 : 50;
      for (const f of fs.slice(0, cap)) console.log(`    · ${f.subject} — ${f.detail}`);
      if (fs.length > cap) console.log(`    … +${fs.length - cap} more (run with --verbose)`);
    }
  }
  console.log(`\nVERDICT: ${bySeverity.CRITICAL.length} critical · ${bySeverity.WARN.length} warnings · ${bySeverity.INFO.length} informational`);
}

main()
  .catch((e) => {
    console.error("AUDIT FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
