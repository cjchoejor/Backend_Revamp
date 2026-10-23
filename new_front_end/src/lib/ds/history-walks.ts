/**
 * A room change as ONE line in History, with the steps it took under it (2026-10-13, operator:
 * "in the entry's history it doesn't give proper info on what has happened, like changed room 201
 * to 302 with time and the things that happened along with it").
 *
 * A room change — from the booking or from the house chart, a setup change, an extension, a
 * seating repair — is one governed walk: back to Negotiation, a new quotation, Set up, the hold,
 * the reservation and its voucher, then back to the step it came from. Each of those steps is its
 * own line in the record, filed under the step the booking stood at when it happened, so the one
 * act the desk did read as a dozen lines spread over four chapters.
 *
 * This only arranges what the record says; nothing is computed or written. A walk starts at
 * `ROOM_MOVE.STARTED` or `ENTRY.BACKFLOW_ROOM_CHANGE_*` and runs over the lines that follow it
 * closely (the walk runs in one go, so its lines are seconds apart; a gap of more than a few
 * seconds ends it). Its head line is the walk's own summary, `ENTRY.ROOM_CHANGED`, written since
 * 2026-10-13; for an older walk the head is pieced together from the lines it is made of.
 */
import type { TraceEvent } from "@/lib/trace/humanize";

export type HistoryItem =
  | { kind: "event"; ev: TraceEvent }
  /** `steps` leaves out the head when the head is one of the walk's own lines (`ENTRY.ROOM_CHANGED`). */
  | { kind: "walk"; at: TraceEvent; head: TraceEvent; headIsAct: boolean; steps: TraceEvent[] };

export type HistoryNames = {
  /** Room id → its number. */
  roomNo: (id: string | null | undefined) => string | null;
  /** Reservation id → the voucher number printed on its voucher. */
  voucherNo: (id: string | null | undefined) => string | null;
};

const GAP_MS = 4_000;
const SPAN_MS = 120_000;

const isStart = (ev: TraceEvent) => ev.eventType === "ROOM_MOVE.STARTED" || ev.eventType.startsWith("ENTRY.BACKFLOW_ROOM_CHANGE_");

const ms = (ev: TraceEvent) => Date.parse(ev.timestamp);

type P = Record<string, unknown>;
const pay = (ev: TraceEvent) => (ev.payload ?? {}) as P;
const s = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Group the record (newest first, as served) into single lines and walks, newest first. */
export function groupWalks(events: TraceEvent[], names: HistoryNames): HistoryItem[] {
  const asc = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const items: HistoryItem[] = [];
  for (let i = 0; i < asc.length; i++) {
    const ev = asc[i]!;
    if (!isStart(ev)) {
      items.push({ kind: "event", ev });
      continue;
    }
    const steps = [ev];
    let j = i + 1;
    while (j < asc.length) {
      const next = asc[j]!;
      if (ms(next) - ms(steps[steps.length - 1]!) > GAP_MS || ms(next) - ms(ev) > SPAN_MS) break;
      steps.push(next);
      j++;
    }
    i = j - 1;
    const head = headOf(steps, names);
    const headIsAct = steps.includes(head);
    items.push({ kind: "walk", at: ev, head, headIsAct, steps: steps.filter((e) => e !== head) });
  }
  return items.reverse();
}

/** The walk's summary line — its own `ENTRY.ROOM_CHANGED` when there is one, else pieced together. */
function headOf(steps: TraceEvent[], names: HistoryNames): TraceEvent {
  const summaries = steps.filter((e) => e.eventType === "ENTRY.ROOM_CHANGED");
  if (summaries.length === 1) return summaries[0]!;

  const start = steps[0]!;
  const moves: Array<{ from: string; to: string }> = [];
  if (summaries.length > 1) {
    for (const e of summaries) {
      const p = pay(e) as { fromRoom?: { roomNumber?: string }; toRooms?: Array<{ roomNumber?: string }> };
      const from = p.fromRoom?.roomNumber;
      const to = (p.toRooms ?? []).map((r) => r.roomNumber).filter(Boolean).join(", ");
      if (from && to) moves.push({ from, to });
    }
  } else {
    for (const e of steps.filter((x) => x.eventType === "ROOM_MOVE.STARTED")) {
      const p = pay(e);
      const from = s(p.fromRoomNumber) ?? names.roomNo(s(p.fromRoomId));
      const to = s(p.toRoomNumber) ?? names.roomNo(s(p.toRoomId));
      if (from && to) moves.push({ from, to });
    }
  }
  const backflow = steps.find((e) => e.eventType.startsWith("ENTRY.BACKFLOW_ROOM_CHANGE_"));
  const quote = [...steps].reverse().find((e) => e.eventType === "QUOTATION.CREATED");
  const confirmed = [...steps].reverse().find((e) => e.eventType === "RESERVATION_CONFIRMED");
  const held = steps.filter((e) => e.eventType === "DOCUMENT.HELD");
  // Where it ended: the last move between steps the walk made.
  let reached: string | null = null;
  for (const e of steps) {
    const p = pay(e);
    const to = s(p.toStage) ?? s(p.to) ?? s(p.reachedStage);
    if (to && /^S[1-9]$/.test(to) && (/TRANSITION|ACTIVATION|LEG_/.test(e.eventType) || e.eventType.startsWith("ENTRY.BACKFLOW"))) reached = to;
  }
  const origin = s(pay(start).fromStage) ?? start.stageContext ?? null;
  const last = summaries[summaries.length - 1];
  const payload = {
    ...(last ? (pay(last) as object) : {}),
    kind: "ROOM",
    moves,
    moveId: s(pay(start).moveId),
    reason: s(pay(start).reason) ?? s(pay(backflow ?? start).reason),
    newSegmentNumber: typeof pay(backflow ?? start).segmentNumber === "number" ? pay(backflow ?? start).segmentNumber : undefined,
    quotationId: quote ? s(pay(quote).quotationId) : null,
    voucherNumber: confirmed ? names.voucherNo(s(pay(confirmed).reservationId)) : null,
    heldPapers: held.map((h) => {
      const p = pay(h);
      const id = s(p.documentId);
      return { kind: s(p.kind), number: p.kind === "CONFIRMATION_VOUCHER" ? names.voucherNo(id) ?? id : id };
    }),
    reachedStage: reached,
    returnedToOrigin: !!reached && reached === origin,
  };
  return { ...start, id: `walk:${start.id}`, eventType: "ENTRY.ROOM_CHANGED", payload };
}
