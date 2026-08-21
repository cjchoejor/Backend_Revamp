// Make a throwaway booking and walk it S1 → S5 over the live API (2026-08-21).
// Usage: node scripts/make-s5-test-booking.mjs   (backend on :4000; logs in as admin/4444)
// Check-in = today+3, 2 nights, 2 adults, first free room; guest has no email so the
// proforma + voucher answers are recorded verbally. Prints the desk URL at the end.

const B = "http://127.0.0.1:4000/api";
let token = null;
const step = (s) => console.log(`\n▶ ${s}`);
async function call(method, path, body, { okStatus } = {}) {
  const res = await fetch(B + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok && !(okStatus && okStatus.includes(res.status))) {
    console.error(`✗ ${method} ${path} → ${res.status}\n${typeof data === "string" ? data : JSON.stringify(data, null, 1)}`);
    process.exit(1);
  }
  return data;
}
const ymd = (d) => d.toISOString().slice(0, 10);
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const checkIn = new Date(today); checkIn.setUTCDate(checkIn.getUTCDate() + 3);
const checkOut = new Date(checkIn); checkOut.setUTCDate(checkOut.getUTCDate() + 2);
const CI = ymd(checkIn), CO = ymd(checkOut);

step("auth as admin (L4)");
const auth = await call("POST", "/auth/authenticate", { username: "admin", pin: "4444", terminalId: "FIXTURE-S5" });
token = auth.jwtToken ?? auth.session?.jwtToken;
console.log("  token ok:", !!token);

step("S1 · guest profile (no email → verbal answer loops)");
const guest = await call("POST", "/guest-profiles", { firstName: "Tashi", lastName: "Testguest", phone: "+97517990001", nationality: "Bhutanese" });
console.log("  guest", guest.id);

step("S1 · inquiry");
const inq = await call("POST", "/inquiries", { guestProfileId: guest.id, sourceChannel: "WALK_IN", proposedCheckIn: CI, proposedCheckOut: CO, notes: "TEST fixture — walked to S5 for desk testing" });
console.log("  inquiry", inq.id);

step(`S1 · entry ${CI} → ${CO}, 2 adults, 1 room`);
let entry = await call("POST", "/entries", {
  inquiryId: inq.id, useType: "LEISURE", guestProfileId: guest.id,
  checkInDate: CI, checkOutDate: CO, guestCount: 2, adultCount: 2, childCount: 0, childAges: [], numberOfRooms: 1,
  contactPersonName: "Tashi Testguest", contactPersonPhone: "+97517990001",
});
const E = entry.id;
console.log("  entry", E, "stage", entry.currentStage);
const fresh = async () => (entry = await call("GET", `/entries/${E}`));

step("S1 · availability search");
const avail = await call("POST", `/entries/${E}/availability/query`, { checkInDate: CI, checkOutDate: CO, guestCount: 2, useType: "LEISURE" });
const cfgId = avail.configuration.id;
const rooms = avail.result?.availableRooms ?? [];
if (!rooms.length) { console.error("no available rooms", JSON.stringify(avail.result).slice(0, 400)); process.exit(1); }
const room = rooms[0];
console.log(`  ${rooms.length} rooms free; picking Room ${room.roomNumber} (${room.roomTypeName ?? room.roomTypeId})`);

step("S1 · seal the selection");
await call("PATCH", `/availability/configurations/${cfgId}/select`, { roomIds: [room.roomId] });
await fresh();
step("S1 → S2");
entry = await call("POST", `/entries/${E}/progress-stage`, { targetStage: "S2", version: entry.version });
await fresh(); console.log("  stage", entry.currentStage);

step("S2 · quotation (2 adults, CP ×2)");
const quote = await call("POST", `/entries/${E}/quotations`, {
  notes: "Test fixture quote",
  roomCompositions: [{ roomId: room.roomId, occupantCount: 2, adultCount: 2, mealPlanCpCount: 2 }],
});
console.log("  quote", quote.id, "total", quote.totalAmount);
await fresh();
step("S2 → S3");
entry = await call("POST", `/entries/${E}/progress-stage`, { targetStage: "S3", version: entry.version });
await fresh(); console.log("  stage", entry.currentStage);

step("S3 · provisional folio (GUEST_PAY) — mints the proforma");
const folio = await call("POST", `/entries/${E}/folio/provisional`, { billingModel: "GUEST_PAY" });
console.log("  folio", folio.id, folio.state);
step("S3 · cancellation disclosure");
await call("POST", `/entries/${E}/disclosures/cancellation`, { noShowTreatmentStatement: "One night charged on no-show; free cancellation until 48h before arrival.", disclosedTerms: { freeUntilHoursBefore: 48, noShowPenaltyNights: 1 } });
await fresh();
const proforma = (entry.folio?.invoices ?? []).find((i) => i.invoiceType === "PROFORMA" && !i.supersededById) ?? (entry.folio?.invoices ?? [])[0];
if (!proforma) { console.error("no proforma on folio", JSON.stringify(entry.folio?.invoices)); process.exit(1); }
step(`S3 · dispatch proforma ${proforma.id} (no email on file → skipped send, still DISPATCHED)`);
await call("POST", `/invoices/${proforma.id}/dispatch`, {});

const comms = async () => { const r = await call("GET", `/entries/${E}/communications`); return Array.isArray(r) ? r : r.items ?? r.communications ?? []; };
step("S3 · record the guest's answer to the proforma (verbal)");
let pi = (await comms()).find((c) => c.commType === "PROFORMA_INVOICE" && c.canAcknowledge);
if (!pi) { console.error("no acknowledgeable proforma comm", JSON.stringify(await comms()).slice(0, 600)); process.exit(1); }
await call("POST", `/communications/${pi.id}/acknowledge`, { method: "VERBAL", verbatimNote: "Guest agreed to the proforma over the phone (test fixture)" });

step("S3 · advance payment");
const ps = await call("GET", `/entries/${E}/payment-status`);
console.log(`  required ${ps.requiredAmount} · received ${ps.totalReceived} · shortfall ${ps.shortfall} · satisfied ${ps.satisfied}`);
let holdPlaced = false;
if (Number(ps.shortfall) > 0) {
  const pay = await call("POST", `/folios/${folio.id}/payments`, { entryId: E, amount: Number(ps.shortfall), notes: "Test fixture advance" });
  console.log("  paid", ps.shortfall, "→ autoHold", JSON.stringify(pay.autoHold));
  holdPlaced = !!pay.autoHold?.placed || pay.autoHold?.reason === "ALREADY_HELD";
}
if (!holdPlaced) {
  step("S3 · committed hold (manual)");
  const hold = await call("POST", `/entries/${E}/holds/committed`, { roomId: room.roomId, commercialJustification: "Test fixture — hold placed for S5 walk" });
  console.log("  hold", hold.id, hold.status ?? hold.state ?? "");
}

step("S3 → S4 · confirm & freeze");
await fresh();
entry = await call("POST", `/entries/${E}/confirm`, { version: entry.version });
await fresh(); console.log("  stage", entry.currentStage, "reservation", entry.reservation?.id ?? "-");

step("S4 · record the guest's answer to the confirmation voucher (verbal)");
let vc = (await comms()).find((c) => c.commType === "CONFIRMATION_VOUCHER" && c.canAcknowledge);
if (!vc) { console.error("no acknowledgeable voucher comm", JSON.stringify(await comms()).slice(0, 600)); process.exit(1); }
await call("POST", `/communications/${vc.id}/acknowledge`, { method: "VERBAL", verbatimNote: "Guest confirmed the voucher over the phone (test fixture)" });

step("S4 → S5 · activate pre-arrival");
const act = await call("POST", `/entries/${E}/activate-pre-arrival`);
if (act?.skipped) console.log("  skipped:", JSON.stringify(act));
await fresh();
console.log(`\n✅ ${E} — stage ${entry.currentStage} · status ${entry.status} · Room ${room.roomNumber} · ${CI} → ${CO}`);
console.log(`   http://localhost:3001/desk/bookings/${E}`);
