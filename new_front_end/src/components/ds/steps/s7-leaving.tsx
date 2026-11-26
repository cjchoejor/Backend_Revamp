"use client";

/**
 * Stay's Change booking — leaving early, removing a room, adding a room (2026-11-26).
 *
 * Every form here is worked ONE SECTION AT A TIME (operator: "it should open as one section is finished
 * and then the other should open … so any user knows what they have to do step by step"): a section's
 * green Done folds it to one line with Edit and opens the next, bringing it into view.
 *
 *  - `LeavingEarly` (mode LEAVING): the guest's choice — the whole booking or some rooms, today or a
 *    later day, whose bill the rooms' charges stay on, and the hotel's early-departure fee, every figure
 *    the server's. Who records it and who may waive the fee is the admin console's.
 *  - `LeavingEarly` (mode REMOVE): the hotel booked a room by mistake — the room comes off with no fee.
 *    Whoever the admin console lets removes it; anyone else asks them (`RoomRemovalAsks`).
 *  - `AddRoom`: on the check-in day, rooms join the booking for the whole stay — the rooms, the new
 *    guests, the price on the negotiation table, their documents now or later — then the booking walks
 *    the governed way (papers made again, held for the desk).
 *  - `RoomsEditPane`: Add a room · Remove a room, as sub-tabs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useMayApprove } from "@/hooks/use-approvals";
import { DateInput } from "@/components/ds/date-input";
import { Help } from "@/components/ds/help";
import { StayDates } from "@/components/ds/stay-dates";
import { BankFields, useBankEntry } from "@/components/ds/bank-fields";
import { RoomMoveDialog } from "@/components/ds/rooms/room-move-dialog";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
import { IdentityProofBlock, type PartySlot } from "@/components/desk/workspace/identity-proof";
import {
  addRooms,
  askToRemoveRoom,
  decideRoomRemoval,
  discardPendingGuests,
  getRoomRemovals,
  listRoomDepartures,
  previewAddRoom,
  previewLeaving,
  recordLeaving,
  releaseRoomDeparture,
  withdrawRoomRemoval,
  type AddRoomHolder,
  type AddRoomRow,
  type AddRoomsOutcome,
  type LeavingFigures,
  type LeavingOutcome,
  type RoomDepartureRow,
} from "@/lib/api/leaving-early";
import type { RoomMoveLegInput } from "@/lib/api/room-moves";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import { getChildPolicy } from "@/lib/api/child-policy";
import { getSettlementTargets, recordTargetPayment } from "@/lib/api/split-settlement";
import { fmtDay, money } from "@/lib/ds/format";
import { effectiveCheckOutIso } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, NotNow, StepCard, SubTabs, atLeast, toastRefusal, useRefreshEntry } from "./kit";
import { PartDone, PartHead } from "./s7-extend";

const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;
const roomsWord = (nos: Array<string | null>) => (nos.length === 1 ? `Room ${nos[0]}` : `Rooms ${nos.join(", ")}`);
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const reveal = (id: string) => setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);

export function useRoomDepartures(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["room-departures", entry.id],
    queryFn: () => listRoomDepartures(session!, entry.id),
    enabled: !!session && entry.currentStage === "S7",
    staleTime: 0,
  });
}

/* ------------------------------------------------------------------ paying a room's own share */

const GUEST_METHODS = [
  ["CASH", "Cash"],
  ["CARD", "Card (POS terminal)"],
  ["MOBILE_PAYMENT", "Mobile payment (QR)"],
  ["BANK_TRANSFER", "Bank transfer"],
] as const;
type GuestMethod = (typeof GUEST_METHODS)[number][0];

/** The room's own share of the bill, taken as it leaves — the server's figure, against the room. */
function PayRoomDialog({ entry, room, onClose }: { entry: EntryDetail; room: { roomId: string; roomNumber: string } | null; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const folioId = entry.folio?.id ?? null;
  const targets = useQuery({
    queryKey: ["settlement-targets", folioId, room?.roomId],
    queryFn: () => getSettlementTargets(session!, folioId!),
    enabled: !!session && !!folioId && !!room,
    staleTime: 0,
  });
  const row = targets.data?.targets.find((t) => t.roomId === room?.roomId) ?? null;
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<GuestMethod | null>(null);
  const [ref, setRef] = useState("");
  const bank = useBankEntry();
  useEffect(() => {
    if (row && amount === "") setAmount(String(row.collectable));
  }, [row, amount]);
  useEffect(() => {
    if (!room) {
      setAmount("");
      setMethod(null);
      setRef("");
    }
  }, [room]);
  const n = Number(amount);
  const why = !row
    ? "reading what the room owes"
    : !(n > 0)
      ? "type the amount"
      : n > row.collectable
        ? `at most ${money(row.collectable)}`
        : !method
          ? "pick how it was paid"
          : method === "CASH" && !ref.trim()
            ? "type the cash receipt"
            : bank.missing(method);
  const pay = useMutation({
    mutationFn: () =>
      recordTargetPayment(session!, folioId!, {
        entryId: entry.id,
        roomId: room!.roomId,
        amount: n,
        paymentMethod: method!,
        ...(method === "CASH" ? { paymentVerificationRef: ref.trim() } : {}),
        ...bank.body(method),
        notes: `Room ${room!.roomNumber} paid its own share as it left early`,
      }),
    onSuccess: () => {
      toast.success(`Room ${room!.roomNumber}'s ${money(n)} recorded`);
      refresh([["settlement-targets"], ["billing-summary", entry.id]]);
      onClose();
    },
    onError: (e) => toastRefusal(e, "Could not record the payment"),
  });
  return (
    <DsDialog
      open={!!room}
      onClose={onClose}
      title={room ? `Room ${room.roomNumber} pays its own share` : "Pay the room's share"}
      caseLines={[entry.id]}
      busy={pay.isPending}
      footer={
        <>
          <NotNow onClick={onClose} busy={pay.isPending} label="Later" />
          <Button className={why ? undefined : "go"} state={pay.isPending ? "working" : why ? "inert" : "default"} reason={why ?? undefined} workingLabel="Recording…" onClick={() => pay.mutate()}>
            Record the payment
          </Button>
        </>
      }
    >
      {row ? (
        <p className="sm" style={{ marginTop: 0 }}>
          Room {room?.roomNumber}&rsquo;s charges come to <b className="money">{money(row.charges)}</b>, {money(row.paid)} paid · <b className="money">{money(row.collectable)}</b> to take now.
        </p>
      ) : (
        <p className="sm">Reading what the room owes…</p>
      )}
      <div className="form2">
        <div className="field">
          <label>Amount · Nu</label>
          <input className="input money" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        {method === "CASH" ? (
          <div className="field">
            <label>Cash receipt</label>
            <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="the receipt's number" />
          </div>
        ) : null}
      </div>
      <div className="field">
        <label>How it was paid</label>
        <Choice options={GUEST_METHODS} value={method} onChange={setMethod} />
      </div>
      <BankFields entry={bank} method={method} />
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ the booking's rooms, as a table */

/** The booking's rooms in use, one row each with its booked nights — ticked rows leave (or come off). */
function RoomsInUseTable({
  entry,
  f,
  picked,
  onToggle,
  readOnly,
}: {
  entry: EntryDetail;
  f: LeavingFigures | null;
  picked: string[];
  onToggle: (roomId: string) => void;
  readOnly?: boolean;
}) {
  const inUse = f?.roomsInUse ?? [];
  const startOf = (roomId: string) => {
    const rows = (entry.roomAssignments ?? []).filter((a) => a.roomId === roomId);
    const starts = rows.map((a) => (a.startDate ?? entry.checkInDate ?? "").slice(0, 10)).filter(Boolean).sort();
    return starts[0] ?? entry.checkInDate?.slice(0, 10) ?? null;
  };
  if (!f) return <p className="sm">Reading the rooms…</p>;
  return (
    <table className="table leaving-pick" data-no-pending>
      <thead>
        <tr>
          <th className="lp-tick" aria-label="Picked" />
          <th>Room</th>
          <th>Type</th>
          <th>Booked</th>
          <th className="num">Nights left</th>
        </tr>
      </thead>
      <tbody>
        {inUse.map((r) => {
          const on = picked.includes(r.roomId);
          const shut = r.apartment || readOnly;
          return (
            <tr
              key={r.roomId}
              className={`${on ? "on" : ""}${shut ? " shut" : ""}`}
              onClick={shut ? undefined : () => onToggle(r.roomId)}
              title={r.apartment ? "An apartment leaves as the whole booking" : undefined}
              data-room={r.roomNumber}
            >
              <td className="lp-tick">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={shut}
                  aria-label={`Room ${r.roomNumber}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => onToggle(r.roomId)}
                />
              </td>
              <td>
                <b>Room {r.roomNumber}</b>
              </td>
              <td>{r.roomTypeName ?? "—"}</td>
              <td>
                <StayDates checkIn={startOf(r.roomId)} checkOut={r.endDate} compact />
              </td>
              <td className="num">{r.nightsLeft}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ leaving early · removing a room */

export function LeavingEarly({
  entry,
  mode = "LEAVING",
  onNightAudit,
  goToStep,
}: {
  entry: EntryDetail;
  /** REMOVE — the hotel booked a room by mistake: no fee, asked of the approvers by anyone else. */
  mode?: "LEAVING" | "REMOVE";
  onNightAudit?: () => void;
  goToStep?: (n: number) => void;
}) {
  const removing = mode === "REMOVE";
  const { session } = useSession();
  const hotelToday = useHotelDay()?.today ?? null;
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const checkOut = effectiveCheckOutIso(entry)?.slice(0, 10) ?? null;
  const record = useMayApprove(removing ? "ROOM_REMOVE" : "LEAVING_EARLY", atLeast(session?.actorLevel, removing ? "L2" : "L3"));
  const waiveRule = useMayApprove("WAIVE_EARLY_FEE", atLeast(session?.actorLevel, "L3"));
  const [who, setWho] = useState<"BOOKING" | "ROOMS" | null>(removing ? "ROOMS" : null);
  const [picked, setPicked] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [billing, setBilling] = useState<"TOGETHER" | "OWN" | null>(removing ? "TOGETHER" : null);
  const [waive, setWaive] = useState(false);
  const [waiveWhy, setWaiveWhy] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [paying, setPaying] = useState<Array<{ roomId: string; roomNumber: string }>>([]);
  const [at, setAt] = useState(1);
  const idOf = (n: number) => `${removing ? "rm" : "lv"}-part-${n}-${entry.id}`;
  const goTo = (n: number) => {
    setAt(n);
    reveal(idOf(n));
  };
  // Today, once — emptied to retype, the box must stay empty (a default put back would eat the typing).
  const dated = useRef(false);
  useEffect(() => {
    if (dated.current || !hotelToday) return;
    dated.current = true;
    setDate(hotelToday);
  }, [hotelToday]);

  const asRooms = who === "ROOMS" && picked.length > 0;
  const preview = useQuery({
    queryKey: ["leaving-preview", entry.id, date, asRooms ? [...picked].sort().join(",") : "all"],
    queryFn: () => previewLeaving(session!, entry.id, { departureDate: date || hotelToday || undefined, ...(asRooms ? { roomIds: picked } : {}) }),
    enabled: !!session && !!(date || hotelToday) && entry.currentStage === "S7",
    staleTime: 0,
    placeholderData: (prev) => prev,
  });
  const f = preview.data ?? null;
  const inUse = f?.roomsInUse ?? [];
  const several = inUse.length > 1;
  const allPicked = who === "ROOMS" && inUse.length > 0 && inUse.every((r) => picked.includes(r.roomId));
  const shortRooms = (f?.rooms ?? []).filter((r) => r.shortened);
  const later = !!f?.later;
  const scope = f?.scope ?? "BOOKING";
  const stale = preview.isFetching;
  const hard = (f?.blockers ?? []).filter((b) => b.code !== "NIGHT_AUDITS_INCOMPLETE");
  const dateBlocker = hard.find((b) => b.code === "DEPARTURE_DATE") ?? null;
  const nightsMissing = f?.missingNightYmds ?? [];
  const pickedNos = inUse.filter((r) => picked.includes(r.roomId)).map((r) => r.roomNumber);
  const someRooms = who === "ROOMS" && !allPicked;

  // The parts this form has, in order.
  const parts: Array<"who" | "when" | "bill" | "what"> = removing ? ["who", "when", "what"] : someRooms ? ["who", "when", "bill", "what"] : ["who", "when", "what"];
  const nOf = (k: (typeof parts)[number]) => parts.indexOf(k) + 1;
  const toggle = (roomId: string) => setPicked((p) => (p.includes(roomId) ? p.filter((x) => x !== roomId) : [...p, roomId]));

  // Section 1 holds together: an earlier section undone sends the later ones back to waiting.
  const part1Ready = removing ? picked.length > 0 && !allPicked : who === "BOOKING" || (who === "ROOMS" && picked.length > 0);
  useEffect(() => {
    if (!part1Ready && at > 1) setAt(1);
  }, [part1Ready, at]);
  const part1Why = removing
    ? !picked.length
      ? "Tick the room booked by mistake"
      : allPicked
        ? "Keep at least one room — every room would come off"
        : null
    : !who
      ? "Say who leaves"
      : who === "ROOMS" && !picked.length
        ? "Tick the rooms that leave"
        : null;
  const part2Ready = !!date && !!f && !stale && !dateBlocker;
  const part2Why = !date ? "Pick the day" : stale || !f ? "Reading the figures…" : dateBlocker ? dateBlocker.message : null;

  const why = !f || stale
    ? "reading the figures"
    : hard.length
      ? hard[0].message
      : nightsMissing.length
        ? "post the nights already slept first"
        : waive && !waiveWhy.trim()
          ? "say why the fee is waived"
          : !reason.trim()
            ? removing
              ? "say what went wrong"
              : "say why they leave early"
            : null;

  const done = (o: LeavingOutcome) => {
    setConfirming(false);
    void qc.invalidateQueries({ queryKey: ["room-departures", entry.id] });
    refresh([["room-departures", entry.id], ["settlement-targets"], ["leaving-preview", entry.id], ["room-removals", entry.id]]);
    if (o.scope === "ROOMS") {
      const nos = o.records.map((r) => r.roomNumber);
      toast.success(
        removing
          ? `${roomsWord(nos)} ${o.later ? `come${nos.length === 1 ? "s" : ""} off the stay on ${fmtDay(o.departureDate)}` : "came off the stay — housekeeping gets the room"}`
          : o.later
            ? `${roomsWord(nos)} will leave on ${fmtDay(o.departureDate)} — the nights after are not charged`
            : `${roomsWord(nos)} left — the rooms go to housekeeping`,
      );
      const fees = o.records.filter((r) => r.feeAmount > 0 && !r.feeError);
      if (fees.length) toast.message(`Early departure fee posted on ${roomsWord(fees.map((r) => r.roomNumber))}`);
      for (const r of o.records) if (r.feeError) toast.error(`Room ${r.roomNumber}: the fee was not posted — ${r.feeError}`);
      if (!o.later && o.billing === "OWN") setPaying(o.records.map((r) => ({ roomId: r.roomId, roomNumber: r.roomNumber })));
    } else {
      toast.success(o.later ? `The stay now ends on ${fmtDay(o.record.departureDate)} — check-out that day as usual` : "Early departure recorded");
      if (o.feeError) toast.error(`The fee was not posted — ${o.feeError}`);
      if (o.movedToCheckout) goToStep?.(8);
      else if (o.checkoutBlocked) toast.warning(`Not moved to Check-out: ${o.checkoutBlocked.message}`);
    }
    setReason("");
    setWaive(false);
    setWaiveWhy("");
    setPicked([]);
    setBilling(removing ? "TOGETHER" : null);
    setAt(1);
  };
  const recordM = useMutation({
    mutationFn: () =>
      recordLeaving(session!, entry.id, {
        departureDate: date,
        ...(scope === "ROOMS" ? { roomIds: picked, billing: billing ?? "TOGETHER" } : {}),
        reason: reason.trim(),
        ...(removing ? { kind: "REMOVED" as const } : {}),
        ...(waive && !removing ? { waiveFee: true, waiveReason: waiveWhy.trim() } : {}),
      }),
    onSuccess: done,
    onError: (e) => toastRefusal(e, removing ? "Could not remove the room" : "Could not record it"),
  });
  const askM = useMutation({
    mutationFn: () => askToRemoveRoom(session!, entry.id, { roomIds: picked, departureDate: date, reason: reason.trim() }),
    onSuccess: (o) => {
      setConfirming(false);
      toast.success(`Asked ${o.approvers} to remove ${roomsWord(o.request.roomNumbers)} — the bell rings for them`);
      void qc.invalidateQueries({ queryKey: ["room-removals", entry.id] });
      setReason("");
      setPicked([]);
      setAt(1);
    },
    onError: (e) => toastRefusal(e, "Could not ask"),
  });

  if (entry.earlyDeparture) {
    return <StepCard title={removing ? "Remove a room" : "Leaving early"} status={<span className="warn-ink">An early departure is already recorded for the whole booking ({entry.earlyDeparture.id}).</span>} />;
  }

  const maxDate = checkOut ? addDays(checkOut, -1) : undefined;
  const pickedWord = roomsWord(pickedNos);
  const actLabel = removing
    ? record.may
      ? `Remove ${pickedWord}`
      : `Ask ${record.words.replace(/^the /, "the ")} to remove it`
    : someRooms
      ? later
        ? `Record — ${pickedWord} leave${pickedNos.length === 1 ? "s" : ""} on ${fmtDay(date)}`
        : `${pickedWord} leave${pickedNos.length === 1 ? "s" : ""} now`
      : later
        ? `Shorten the stay to ${fmtDay(date)}`
        : "Record it and go to Check-out";
  const actWhy = why ?? (!removing && !record.may ? `Recording it is for ${record.words}` : null);
  const stateOf = (k: (typeof parts)[number]): "open" | "done" | "waiting" => {
    const n = nOf(k);
    return at === n ? "open" : at > n ? "done" : "waiting";
  };
  const whoSummary = removing ? pickedWord : who === "BOOKING" || allPicked ? "The whole booking" : pickedWord;
  const whenSummary = f ? `${date === hotelToday ? "Today" : fmtDay(date)} · ${nightsWord(f.unstayedNights)} not slept` : fmtDay(date);
  const billSummary = billing === "OWN" ? "They pay their own share" : "With the rest of the booking";

  return (
    <div className="leaving" data-leaving={mode}>
      {removing ? <RoomRemovalAsks entry={entry} /> : null}
      <StepCard
        title={removing ? "Remove a room" : "Leaving early"}
        status={
          removing
            ? "A room the hotel booked by mistake comes off the stay — no early-departure fee."
            : "The guest leaves before the booked check-out — the hotel's early-departure fee applies."
        }
      >
        {/* 1 · who leaves / which room */}
        <div className={`ext-part ${stateOf("who") === "open" ? "open" : "folded"}`} id={idOf(1)}>
          <PartHead n={1} title={removing ? "Which room" : "Who leaves"} state={stateOf("who")} summary={whoSummary} onEdit={() => goTo(1)} />
          {stateOf("who") === "open" ? (
            <>
              {!removing ? (
                <Choice
                  options={several ? ([["BOOKING", "The whole booking"], ["ROOMS", "Some rooms"]] as const) : ([["BOOKING", "The whole booking"]] as const)}
                  value={who}
                  onChange={(v) => {
                    setWho(v);
                    if (v === "BOOKING") setPicked([]);
                  }}
                />
              ) : null}
              {!removing && !several && inUse.length === 1 ? <p className="sm">One room is in use, so it leaves with the booking.</p> : null}
              {who === "ROOMS" ? (
                <>
                  <p className="sm" style={{ margin: 0 }}>
                    {removing ? "Tick the room booked by mistake." : "Tick the rooms that leave."}
                  </p>
                  <RoomsInUseTable entry={entry} f={f} picked={picked} onToggle={toggle} />
                  {allPicked ? (
                    <p className="sm warn-ink" role="alert">
                      {removing ? "Every room is ticked — keep at least one room on the stay." : "Every room is ticked — that is the whole booking leaving early."}
                    </p>
                  ) : null}
                </>
              ) : null}
              <PartDone ready={part1Ready} why={part1Why} onDone={() => goTo(2)} />
            </>
          ) : null}
        </div>

        {/* 2 · when */}
        <div className={`ext-part ${stateOf("when") === "open" ? "open" : stateOf("when") === "done" ? "folded" : "waiting"}`} id={idOf(2)}>
          <PartHead
            n={2}
            title={removing ? "From when" : "When they leave"}
            state={stateOf("when")}
            summary={whenSummary}
            waitsFor={removing ? "Which room" : "Who leaves"}
            onEdit={() => goTo(2)}
          />
          {stateOf("when") === "open" ? (
            <>
              <div className="form2">
                <div className="field">
                  <label>
                    {removing ? "Off the stay from" : "Leaving on"}
                    <Help label="Which day">
                      {removing
                        ? "Usually today. The nights from that day on are not charged for the room."
                        : `The morning they go. Today, or a later day before the booked check-out (${checkOut ? fmtDay(checkOut) : "—"}). The nights from that day on are not charged.`}
                    </Help>
                  </label>
                  <DateInput className="input" value={date} min={hotelToday ?? undefined} max={maxDate} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="field">
                  <label>Nights not slept</label>
                  <div className="leaving-fig">
                    {f ? (
                      <>
                        <b>{nightsWord(f.unstayedNights)}</b> {date === hotelToday ? (removing ? "· from tonight" : "· they leave today") : later ? `· until the morning of ${fmtDay(date)}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
              </div>
              <PartDone ready={part2Ready} why={part2Why} onDone={() => goTo(3)} />
            </>
          ) : null}
        </div>

        {/* 3 · their bill (some rooms leaving) */}
        {parts.includes("bill") ? (
          <div className={`ext-part ${stateOf("bill") === "open" ? "open" : stateOf("bill") === "done" ? "folded" : "waiting"}`} id={idOf(3)}>
            <PartHead n={3} title="Their bill" state={stateOf("bill")} summary={billSummary} waitsFor="When they leave" onEdit={() => goTo(3)} />
            {stateOf("bill") === "open" ? (
              <>
                <Choice
                  options={[
                    ["TOGETHER", "With the rest of the booking"],
                    ["OWN", "They pay their own"],
                  ] as const}
                  value={billing}
                  onChange={setBilling}
                />
                <p className="sm" style={{ margin: 0 }}>
                  {billing === "OWN"
                    ? later
                      ? "The rooms' own share is taken on the day they leave, when the desk releases them."
                      : "The rooms' own share is taken as they leave — the payment opens once it is recorded."
                    : billing === "TOGETHER"
                      ? "Their charges stay on the booking's bill and are paid at check-out with the rest."
                      : "Whose bill the rooms' charges stay on."}
                </p>
                <PartDone ready={!!billing} why={billing ? null : "Say whose bill it is"} onDone={() => goTo(4)} />
              </>
            ) : null}
          </div>
        ) : null}

        {/* last · what it comes to, and the act */}
        <div className={`ext-part ${stateOf("what") === "open" ? "open" : "waiting"}`} id={idOf(nOf("what"))}>
          <PartHead
            n={nOf("what")}
            title={removing ? "What went wrong" : "What it comes to"}
            state={stateOf("what") === "done" ? "open" : stateOf("what")}
            waitsFor={parts.includes("bill") ? "Their bill" : removing ? "From when" : "When they leave"}
          />
          {stateOf("what") === "open" ? (
            f ? (
              <>
                <table className="table leaving-table">
                  <thead>
                    <tr>
                      <th>Room</th>
                      <th>Nights not charged</th>
                      <th className="num">Not charged</th>
                      {removing ? null : <th className="num">Fee (net)</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {shortRooms.map((r) => (
                      <tr key={r.assignmentId}>
                        <td>Room {r.roomNumber}</td>
                        <td>
                          {nightsWord(r.unstayedNights)} · from {fmtDay(f.departureDate)}
                        </td>
                        <td className="num money">{money(r.forgoneTotal)}</td>
                        {removing ? null : <td className="num money">{waive ? "waived" : money(scope === "ROOMS" ? r.feeAmount : null)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="leaving-sum">
                  <span>
                    Not charged <b className="money">{money(f.forgoneRoomTotal)}</b>
                  </span>
                  {removing ? (
                    <span>
                      Early departure fee <b>none — the hotel&rsquo;s mistake</b>
                    </span>
                  ) : (
                    <span>
                      Early departure fee <b className="money">{waive ? "waived" : `${money(f.fee.amount)} + service charge and GST = ${money(f.fee.gross)}`}</b>
                    </span>
                  )}
                </div>
                {removing ? (
                  <p className="sm" style={{ margin: 0 }}>
                    The nights already slept stay charged on the room; tonight is taken off if it was posted. The room goes to housekeeping.
                  </p>
                ) : (
                  <p className="sm" style={{ margin: 0 }}>
                    The hotel&rsquo;s early-departure policy: {f.fee.explanation}
                    {someRooms ? " Each room's fee is posted on the room, on whoever pays the room." : ""}
                  </p>
                )}
                {nightsMissing.length ? (
                  <div className="notice stop" role="alert">
                    <span>
                      The night{nightsMissing.length === 1 ? "" : "s"} of {nightsMissing.map((d) => fmtDay(d)).join(", ")} {nightsMissing.length === 1 ? "is" : "are"} not posted yet — post{" "}
                      {nightsMissing.length === 1 ? "it" : "them"} first.
                    </span>
                    {onNightAudit ? (
                      <Button kind="secondary" onClick={onNightAudit}>
                        Night audit
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {hard
                  .filter((b) => b.code !== "DEPARTURE_DATE")
                  .map((b) => (
                    <div key={b.code + b.message} className="notice stop" role="alert">
                      <span>{b.message}</span>
                    </div>
                  ))}
                {!removing ? (
                  waiveRule.may ? (
                    <label className="leaving-waive">
                      <input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> Waive the fee
                    </label>
                  ) : (
                    <p className="sm" style={{ margin: 0 }}>
                      Waiving the fee is for {waiveRule.words}.
                    </p>
                  )
                ) : null}
                {waive && !removing ? (
                  <div className="field">
                    <label>Why the fee is waived</label>
                    <input className="input" value={waiveWhy} onChange={(e) => setWaiveWhy(e.target.value)} placeholder="e.g. a family emergency" />
                  </div>
                ) : null}
                <div className="field">
                  <label>{removing ? "What went wrong" : "Why they leave early"}</label>
                  <input
                    className="input"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={removing ? "e.g. one room too many was booked for the party" : "e.g. their flight was moved"}
                  />
                </div>
                {removing && !record.may ? (
                  <p className="sm" style={{ margin: 0 }}>
                    Removing a room is for {record.words}. Asking them rings their bell; the room comes off once one of them approves.
                  </p>
                ) : null}
                <div className="ext-go">
                  {actWhy ? <span className="meta">{actWhy}</span> : null}
                  <Button className={actWhy ? undefined : "go"} state={actWhy ? "inert" : "default"} reason={actWhy ?? undefined} onClick={() => setConfirming(true)}>
                    {actLabel}
                  </Button>
                </div>
              </>
            ) : (
              <p className="sm">Reading the figures…</p>
            )
          ) : null}
        </div>
      </StepCard>

      <DsDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={removing ? (record.may ? `Remove ${pickedWord}` : `Ask to remove ${pickedWord}`) : someRooms ? "Some rooms leave early" : "The booking leaves early"}
        caseLines={[entry.id]}
        busy={recordM.isPending || askM.isPending}
        footer={
          <>
            <NotNow onClick={() => setConfirming(false)} busy={recordM.isPending || askM.isPending} />
            <Button
              className="go"
              state={recordM.isPending || askM.isPending ? "working" : "default"}
              workingLabel={removing && !record.may ? "Asking…" : "Recording…"}
              onClick={() => (removing && !record.may ? askM.mutate() : recordM.mutate())}
            >
              {actLabel}
            </Button>
          </>
        }
      >
        {f ? (
          <ul className="sm leaving-what">
            {removing ? (
              <>
                <li>
                  {pickedWord} comes off the stay {later ? `on the morning of ${fmtDay(f.departureDate)}` : "now"}: {nightsWord(f.unstayedNights)} not charged ({money(f.forgoneRoomTotal)}).
                </li>
                <li>No early-departure fee — the hotel booked it by mistake.</li>
                <li>The nights already slept stay on the booking&rsquo;s bill; the room goes to housekeeping.</li>
                {!record.may ? <li>Nothing changes until {record.words} approve it.</li> : null}
              </>
            ) : (
              <>
                <li>
                  {someRooms ? pickedWord : "The stay"} {later ? `ends on the morning of ${fmtDay(f.departureDate)}` : "ends this morning"}; {nightsWord(f.unstayedNights)} not slept,{" "}
                  {money(f.forgoneRoomTotal)} not charged.
                </li>
                <li>{waive ? "The early-departure fee is waived." : `The early-departure fee of ${money(f.fee.amount)} (${money(f.fee.gross)} with service charge and GST) goes on the bill.`}</li>
                {someRooms ? (
                  <>
                    <li>{later ? "The rooms stay in use until that morning; the desk releases them that day." : "The rooms are released now and go to housekeeping."}</li>
                    <li>{billing === "OWN" ? "They pay their own share as they leave." : "Their charges stay on the booking's bill, paid at check-out."}</li>
                    <li>The rest of the booking stays.</li>
                  </>
                ) : later ? (
                  <li>The booking stays at Stay and checks out on {fmtDay(f.departureDate)} as usual.</li>
                ) : (
                  <li>The booking moves to Check-out.</li>
                )}
              </>
            )}
          </ul>
        ) : null}
      </DsDialog>

      <PayRoomDialog entry={entry} room={paying[0] ?? null} onClose={() => setPaying((p) => p.slice(1))} />
    </div>
  );
}

/* ------------------------------------------------------------------ the desk's ask to remove a room */

/** A removal waiting for an answer — the approvers answer here, the desk can take it back. */
export function RoomRemovalAsks({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const q = useQuery({
    queryKey: ["room-removals", entry.id],
    queryFn: () => getRoomRemovals(session!, entry.id),
    enabled: !!session && entry.currentStage === "S7",
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.waiting ? 8000 : false),
    refetchIntervalInBackground: true,
  });
  const [turning, setTurning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [note, setNote] = useState("");
  const w = q.data?.waiting ?? null;
  const latest = q.data?.items[0] ?? null;
  const seen = useRef<string | null>(null);
  // The desk's screen follows the answer by itself.
  useEffect(() => {
    if (!latest) return;
    const key = `${latest.id}:${latest.status}`;
    if (seen.current && seen.current !== key && seen.current.startsWith(latest.id)) {
      if (latest.status === "APPROVED") {
        toast.success(`${roomsWord(latest.roomNumbers)} removed by ${latest.decidedByName ?? "the approver"}`);
        refresh([["room-departures", entry.id], ["leaving-preview", entry.id]]);
      } else if (latest.status === "REJECTED") toast.warning(`Turned down: ${latest.decisionNote ?? ""}`);
    }
    seen.current = key;
  }, [latest, entry.id, refresh]);
  const decide = useMutation({
    mutationFn: (d: "APPROVE" | "REJECT") => decideRoomRemoval(session!, entry.id, w!.id, { decision: d, note: note.trim() || null }),
    onSuccess: (o) => {
      setTurning(false);
      setApproving(false);
      setNote("");
      void qc.invalidateQueries({ queryKey: ["room-removals", entry.id] });
      refresh([["room-departures", entry.id], ["leaving-preview", entry.id], ["settlement-targets"]]);
      toast.success(o.decision === "APPROVE" ? `${roomsWord(w?.roomNumbers ?? [])} came off the stay` : "Turned down — the desk is told");
    },
    onError: (e) => toastRefusal(e, "Could not answer"),
  });
  const withdraw = useMutation({
    mutationFn: () => withdrawRoomRemoval(session!, entry.id, w!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["room-removals", entry.id] });
      toast.success("Taken back");
    },
    onError: (e) => toastRefusal(e, "Could not take it back"),
  });
  if (!w) {
    if (latest?.status === "REJECTED" && Date.now() - new Date(latest.decidedAt ?? 0).getTime() < 12 * 3600_000) {
      return (
        <div className="notice stop" role="status" data-removal-ask="REJECTED">
          <span>
            <b>Removing {roomsWord(latest.roomNumbers)} was turned down</b> by {latest.decidedByName ?? "the approver"}: &ldquo;{latest.decisionNote}&rdquo;
          </span>
        </div>
      );
    }
    return null;
  }
  const mine = q.data?.mayDecide;
  return (
    <>
      <div className="fom-wait fw-row" role="status" data-removal-ask="REQUESTED">
        <span className="fom-wait-mark" aria-hidden>
          !
        </span>
        <span className="fom-wait-text">
          <b>{mine ? `The desk asks to remove ${roomsWord(w.roomNumbers)}` : `Waiting for ${q.data?.approvers} to remove ${roomsWord(w.roomNumbers)}`}</b>
          <span className="sm">
            From {fmtDay(w.departureDate)} · &ldquo;{w.reason}&rdquo; · asked by {w.requestedByName ?? "the desk"}
          </span>
        </span>
        {mine ? (
          <span className="fom-wait-acts">
            <Button className="go" onClick={() => setApproving(true)}>
              Remove it
            </Button>
            <Button kind="secondary" onClick={() => setTurning(true)}>
              Turn it down
            </Button>
          </span>
        ) : (
          <Button kind="secondary" state={withdraw.isPending ? "working" : "default"} onClick={() => withdraw.mutate()}>
            Take the request back
          </Button>
        )}
      </div>
      <DsDialog
        open={approving}
        onClose={() => setApproving(false)}
        title={`Remove ${roomsWord(w.roomNumbers)}`}
        caseLines={[entry.id]}
        busy={decide.isPending}
        footer={
          <>
            <NotNow onClick={() => setApproving(false)} busy={decide.isPending} />
            <Button className="go" state={decide.isPending ? "working" : "default"} workingLabel="Removing…" onClick={() => decide.mutate("APPROVE")}>
              Remove {roomsWord(w.roomNumbers)}
            </Button>
          </>
        }
      >
        <ul className="sm leaving-what">
          <li>
            {roomsWord(w.roomNumbers)} comes off the stay from {fmtDay(w.departureDate)}; the nights from then on are not charged.
          </li>
          <li>No early-departure fee — the hotel booked it by mistake.</li>
          <li>The room goes to housekeeping. The desk&rsquo;s words: &ldquo;{w.reason}&rdquo;.</li>
        </ul>
      </DsDialog>
      <DsDialog
        open={turning}
        onClose={() => setTurning(false)}
        title="Turn it down"
        caseLines={[entry.id]}
        busy={decide.isPending}
        footer={
          <>
            <NotNow onClick={() => setTurning(false)} busy={decide.isPending} />
            <Button state={decide.isPending ? "working" : note.trim() ? "default" : "inert"} reason={note.trim() ? undefined : "say why"} onClick={() => decide.mutate("REJECT")}>
              Turn it down
            </Button>
          </>
        }
      >
        <div className="field">
          <label>Why — the desk reads it</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </DsDialog>
    </>
  );
}

/* ------------------------------------------------------------------ rooms recorded to leave */

export function RoomsLeavingCard({ entry, all = false }: { entry: EntryDetail; all?: boolean }) {
  const { session } = useSession();
  const q = useRoomDepartures(entry);
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const [releasing, setReleasing] = useState<RoomDepartureRow | null>(null);
  const [keyBack, setKeyBack] = useState(false);
  const [paying, setPaying] = useState<{ roomId: string; roomNumber: string } | null>(null);
  const rows = (q.data?.items ?? []).filter((r) => all || r.state === "SCHEDULED");
  const release = useMutation({
    mutationFn: () => releaseRoomDeparture(session!, entry.id, releasing!.id, { keyReturned: keyBack }),
    onSuccess: (o) => {
      const r = releasing!;
      setReleasing(null);
      qc.setQueryData(["room-departures", entry.id], { items: o.departures });
      refresh([["room-departures", entry.id], ["settlement-targets"]]);
      toast.success(`Room ${r.roomNumber} left — it goes to housekeeping`);
      if (o.keyError) toast.warning(`The key was not recorded back: ${o.keyError}`);
      if (r.billing === "OWN") setPaying({ roomId: r.roomId, roomNumber: r.roomNumber });
    },
    onError: (e) => toastRefusal(e, "Could not release the room"),
  });
  if (!rows.length) return null;
  return (
    <>
      <StepCard title={all ? "Rooms off the stay" : "Rooms leaving early"} className="leaving-card">
        {rows.map((r) => (
          <div key={r.id} className={`leaving-row${r.dueToday ? " due" : ""}`} data-room-leaving={r.state}>
            <span className="fom-wait-text">
              <b>
                Room {r.roomNumber}{" "}
                {r.kind === "REMOVED"
                  ? r.state === "LEFT"
                    ? `removed from ${fmtDay(r.departureDate)} — booked by mistake`
                    : `comes off on ${fmtDay(r.departureDate)} — booked by mistake`
                  : r.state === "LEFT"
                    ? `left on ${fmtDay(r.departureDate)}`
                    : r.dueToday
                      ? "leaves today — release it"
                      : `leaves on ${fmtDay(r.departureDate)}`}
              </b>
              <span className="sm">
                {nightsWord(r.unstayedNights)} not charged ·{" "}
                {r.kind === "REMOVED" ? "no fee" : r.feeWaived ? "fee waived" : r.feeAmount > 0 ? `fee ${money(r.feeAmount)} + taxes on the room` : "no fee"} ·{" "}
                {r.billing === "OWN" ? "pays its own share" : "its charges stay on the booking's bill"} · &ldquo;{r.reason}&rdquo;
              </span>
            </span>
            {r.state === "SCHEDULED" ? (
              <Button
                className={r.dueToday ? "go" : undefined}
                kind={r.dueToday ? undefined : "secondary"}
                state={r.dueToday ? "default" : "inert"}
                reason={r.dueToday ? undefined : `on ${fmtDay(r.departureDate)}`}
                onClick={() => {
                  setKeyBack(false);
                  setReleasing(r);
                }}
              >
                Release Room {r.roomNumber}
              </Button>
            ) : null}
          </div>
        ))}
      </StepCard>
      <DsDialog
        open={!!releasing}
        onClose={() => setReleasing(null)}
        title={releasing ? `Room ${releasing.roomNumber} leaves` : "The room leaves"}
        caseLines={[entry.id]}
        busy={release.isPending}
        footer={
          <>
            <NotNow onClick={() => setReleasing(null)} busy={release.isPending} />
            <Button className="go" state={release.isPending ? "working" : "default"} workingLabel="Releasing…" onClick={() => release.mutate()}>
              Release the room
            </Button>
          </>
        }
      >
        <p className="sm" style={{ marginTop: 0 }}>
          The room goes to housekeeping to be cleaned. {releasing?.billing === "OWN" ? "Its own share is taken next." : "Its charges stay on the booking's bill."}
        </p>
        <label className="leaving-waive">
          <input type="checkbox" checked={keyBack} onChange={(e) => setKeyBack(e.target.checked)} /> The key came back
        </label>
      </DsDialog>
      <PayRoomDialog entry={entry} room={paying} onClose={() => setPaying(null)} />
    </>
  );
}

/* ------------------------------------------------------------------ rooms added on the check-in day */

// The table's rows are kept with the draft (2026-11-26): a reload at Their documents must still add what
// was seated and priced. `compsKey` says which rooms and guests they were seated for.
type AddDraft = {
  at: number;
  picked: string[];
  adults: string;
  kids: string[];
  docs: "NOW" | "LATER" | null;
  reason: string;
  comps: RoomCompositionInput[];
  compsKey: string;
};
const EMPTY_ADD: AddDraft = { at: 1, picked: [], adults: "", kids: [], docs: null, reason: "", comps: [], compsKey: "" };
const planKeyOf = (x: Pick<AddDraft, "picked" | "adults" | "kids">) => `${x.picked.join(",")}|${x.adults}|${x.kids.join(",")}`;
const draftKey = (entryId: string) => `desk:add-room:${entryId}`;
function readDraft(entryId: string): AddDraft {
  try {
    const raw = window.localStorage.getItem(draftKey(entryId));
    if (!raw) return EMPTY_ADD;
    const d = JSON.parse(raw) as Partial<AddDraft>;
    return {
      ...EMPTY_ADD,
      ...d,
      picked: Array.isArray(d.picked) ? d.picked : [],
      kids: Array.isArray(d.kids) ? d.kids : [],
      comps: Array.isArray(d.comps) ? d.comps : [],
      compsKey: typeof d.compsKey === "string" ? d.compsKey : "",
    };
  } catch {
    return EMPTY_ADD;
  }
}

const STATUS_WORD: Record<string, string> = { FREE: "Free", RESERVED: "Reserved", HELD: "Held", BLOCKED: "Out of service", MAINTENANCE: "Maintenance" };

/** Move a booking that holds the room and has not arrived to another room (2026-11-26). */
function MoveHolderDialog({ room, holder, onClose, onMove }: { room: AddRoomRow | null; holder: AddRoomHolder | null; onClose: () => void; onMove: (legs: RoomMoveLegInput[]) => void }) {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => setTo(null), [holder]);
  if (!room || !holder) return null;
  return (
    <DsDialog
      open
      onClose={onClose}
      title={`Move ${holder.guestName ?? "their booking"} out of Room ${room.roomNumber}`}
      caseLines={[holder.entryId]}
      footer={
        <>
          <NotNow onClick={onClose} />
          <Button className={to ? "go" : undefined} state={to ? "default" : "inert"} reason={to ? undefined : "pick a room for them"} onClick={() => onMove([{ entryId: holder.entryId, fromRoomId: room.roomId, toRoomId: to! }])}>
            {to ? `Move them to Room ${holder.rooms.find((r) => r.roomId === to)?.roomNumber}` : "Move them"}
          </Button>
        </>
      }
    >
      <p className="sm" style={{ marginTop: 0 }}>
        {holder.guestName ?? "Their booking"} ({holder.bookingRef ?? holder.entryId}) holds Room {room.roomNumber} for{" "}
        {holder.nightsInRoom.map((d) => fmtDay(d)).join(", ")} and has not arrived. They keep their price for the same type; their papers are made again and held.
      </p>
      {holder.rooms.length ? (
        <div className="field">
          <label>A free room for them</label>
          <Choice options={holder.rooms.map((r) => [r.roomId, `Room ${r.roomNumber}${r.roomTypeName ? ` · ${r.roomTypeName}` : ""}${r.sameType ? "" : " · another type"}`] as const)} value={to} onChange={setTo} />
        </div>
      ) : (
        <p className="sm warn-ink">No room is free for their nights.</p>
      )}
    </DsDialog>
  );
}

export function AddRoom({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const qc = useQueryClient();
  const rule = useMayApprove("ROOM_ADD", atLeast(session?.actorLevel, "L3"));
  const rateMay = atLeast(session?.actorLevel, "L3");
  const [d, setD] = useState<AddDraft>(EMPTY_ADD);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setD(readDraft(entry.id));
  }, [entry.id]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      if (d === EMPTY_ADD) window.localStorage.removeItem(draftKey(entry.id));
      else window.localStorage.setItem(draftKey(entry.id), JSON.stringify(d));
    } catch {
      /* a per-viewer convenience — the form still works */
    }
  }, [d, entry.id]);
  const set = (patch: Partial<AddDraft>) => setD((x) => ({ ...x, ...patch }));
  // The rows count only for the rooms and guests they were seated for.
  const comps = useMemo(() => (d.compsKey === planKeyOf(d) ? d.comps : []), [d]);
  const setComps = useCallback(
    (c: RoomCompositionInput[]) =>
      setD((x) => {
        const key = planKeyOf(x);
        if (x.compsKey === key && JSON.stringify(x.comps) === JSON.stringify(c)) return x;
        return { ...x, comps: c, compsKey: key };
      }),
    [],
  );
  const [faults, setFaults] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<AddRoomsOutcome | null>(null);
  const [moveFor, setMoveFor] = useState<{ room: AddRoomRow; holder: AddRoomHolder } | null>(null);
  const [legs, setLegs] = useState<RoomMoveLegInput[] | null>(null);
  const idOf = (n: number) => `ar-part-${n}-${entry.id}`;
  const goTo = (n: number) => {
    set({ at: n });
    reveal(idOf(n));
  };

  const q = useQuery({
    queryKey: ["add-room-preview", entry.id],
    queryFn: () => previewAddRoom(session!, entry.id),
    enabled: !!session && entry.currentStage === "S7",
    staleTime: 0,
  });
  const policy = useQuery({ queryKey: ["child-policy"], queryFn: () => getChildPolicy(session!), enabled: !!session, staleTime: 5 * 60_000 });
  const p = q.data ?? null;
  // Memoised (2026-11-26): a fresh array each draw made the price table re-report its rows, which drew
  // this again — "Maximum update depth exceeded".
  const picked = useMemo(() => d.picked.filter((id) => p?.rooms.some((r) => r.roomId === id && r.selectable) ?? true), [d.picked, p]);
  const pickedRows = (p?.rooms ?? []).filter((r) => picked.includes(r.roomId)).sort((a, b) => picked.indexOf(a.roomId) - picked.indexOf(b.roomId));
  const adults = Number(d.adults || 0);
  const ages = useMemo(() => d.kids.map((k) => Number(k)), [d.kids]);
  const agesOk = d.kids.every((k) => k.trim() !== "" && Number(k) >= 0 && Number(k) <= 17);
  const guests = adults + d.kids.length;

  // The new guests, keyed as the party will key them once the rooms join the booking.
  const n0 = entry.adultCount ?? 0;
  const k0 = (entry.childAges ?? []).length;
  const pendingSlots: PartySlot[] = useMemo(
    () => [
      ...Array.from({ length: adults }, (_, i) => ({ key: `A${n0 + i}`, label: `Adult ${n0 + i + 1}`, placeholder: "Name as on the document" })),
      ...ages.map((age, j) => ({ key: `K${k0 + j}`, label: `Child ${k0 + j + 1} · ${age}y`, sub: `${age}y`, placeholder: "Name as on the document" })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adults, d.kids.join(","), n0, k0],
  );
  // Which new room each new guest sleeps in — the table's own counts, band by band, in room order.
  const pendingRoomOf = useMemo(() => {
    const young = policy.data?.ageBands.youngChildMaxAge ?? 5;
    const child = policy.data?.ageBands.childMaxAge ?? 10;
    const pool = {
      A: [...Array.from({ length: adults }, (_, i) => `A${n0 + i}`), ...ages.map((a, j) => (a > child ? `K${k0 + j}` : null)).filter((x): x is string => !!x)],
      C: ages.map((a, j) => (a > young && a <= child ? `K${k0 + j}` : null)).filter((x): x is string => !!x),
      U: ages.map((a, j) => (a <= young ? `K${k0 + j}` : null)).filter((x): x is string => !!x),
    };
    const m = new Map<string, string>();
    for (const roomId of picked) {
      const c = comps.find((x) => x.roomId === roomId);
      if (!c) continue;
      for (const k of pool.A.splice(0, c.adultCount ?? 0)) m.set(k, roomId);
      for (const k of pool.C.splice(0, c.cnb6To10Count ?? 0)) m.set(k, roomId);
      for (const k of pool.U.splice(0, c.cnbUnder6Count ?? 0)) m.set(k, roomId);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comps, picked.join(","), adults, d.kids.join(","), policy.data]);

  const roomDates = useMemo(() => {
    const out: Record<string, { label: string; nights: number }> = {};
    if (p?.checkIn && p.checkOut) for (const id of picked) out[id] = { label: `${fmtDay(p.checkIn)} – ${fmtDay(p.checkOut)}`, nights: p.nights.length };
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.checkIn, p?.checkOut, picked.join(",")]);

  const stateOf = (n: number): "open" | "done" | "waiting" => (d.at === n ? "open" : d.at > n ? "done" : "waiting");
  const part1Ready = picked.length > 0;
  const part2Why = !d.adults && !d.kids.length ? "Say who sleeps in the new rooms" : !agesOk ? "Type each child's age (0 to 17)" : guests < picked.length ? `Each room needs a guest — ${picked.length} rooms, ${guests} guests` : null;
  const part3Why = !comps.length ? "Seat the new guests in the table" : faults.length ? faults[0] : null;
  useEffect(() => {
    if (d.at > 1 && !part1Ready) set({ at: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part1Ready]);

  const addM = useMutation({
    mutationFn: () =>
      addRooms(session!, entry.id, {
        roomIds: picked,
        adults,
        childAges: ages,
        roomCompositions: picked.map((id) => comps.find((c) => c.roomId === id)!).filter(Boolean),
        reason: d.reason.trim() || null,
      }),
    onSuccess: (o) => {
      setConfirming(false);
      setDone(o);
      setD(EMPTY_ADD);
      try {
        window.localStorage.removeItem(`desk:rcomp:add-room:${entry.id}`);
      } catch {
        /* nothing kept */
      }
      refresh([["add-room-preview", entry.id], ["identity-proofs", entry.id], ["billing-summary", entry.id], ["held-documents", entry.id]]);
      toast.success(`${roomsWord(o.roomNumbers)} added to the booking`);
      if (o.outcome.walk.blocked) toast.warning(`It stopped at ${o.outcome.walk.blocked.atStep.toLowerCase().replace(/_/g, " ")}: ${o.outcome.walk.blocked.message}`);
    },
    onError: (e) => toastRefusal(e, "Could not add the room"),
  });
  const startAgain = useMutation({
    mutationFn: async () => {
      if (pendingSlots.length) await discardPendingGuests(session!, entry.id, pendingSlots.map((s) => s.key)).catch(() => null);
    },
    onSettled: () => {
      setD(EMPTY_ADD);
      try {
        window.localStorage.removeItem(`desk:rcomp:add-room:${entry.id}`);
      } catch {
        /* nothing kept */
      }
      void qc.invalidateQueries({ queryKey: ["identity-proofs", entry.id] });
    },
  });

  if (done) {
    const pr = done.outcome.pricing;
    return (
      <div className="leaving" data-add-room>
        <div className={`notice ${done.outcome.walk.blocked ? "next" : "paid"}`} role="status" data-add-room-done>
          <span>
            <b>{roomsWord(done.roomNumbers)} added to the booking</b> · {done.party.adultCount} adult{done.party.adultCount === 1 ? "" : "s"}
            {done.party.childCount ? `, ${done.party.childCount} child${done.party.childCount === 1 ? "" : "ren"}` : ""} now
            {pr.newTotal != null ? ` · the stay ${money(pr.priorTotal)} → ${money(pr.newTotal)}` : ""}
            <br />
            <span className="sm">
              The quotation was made again (the old one replaced); the voucher and the proforma were made again and wait for you under Papers. Tonight is charged for the new{" "}
              {done.roomNumbers.length === 1 ? "room" : "rooms"}; hand over the keys from Guests and rooms › Keys.
            </span>
          </span>
          <Button kind="secondary" onClick={() => setDone(null)}>
            Add another room
          </Button>
        </div>
      </div>
    );
  }

  if (q.isLoading || !p) return <p className="sm">Asking the house…</p>;
  if (p.refusal) {
    return (
      <StepCard title="Add a room">
        <div className="notice next" role="status">
          <span>{p.refusal}</span>
        </div>
      </StepCard>
    );
  }
  const seatedAll = picked.length > 0 && picked.every((id) => comps.some((c) => c.roomId === id));
  const actWhy = !rule.may ? `Adding a room is for ${rule.words}` : !seatedAll ? "Seat the new guests in the price table first (3 · The price)" : null;

  return (
    <div className="leaving" data-add-room>
      <StepCard title="Add a room" status={`From tonight to the check-out — the same nights as the other rooms`} right={d !== EMPTY_ADD ? <Button kind="quiet" compact onClick={() => startAgain.mutate()}>Start again</Button> : undefined}>
        {/* 1 · the rooms */}
        <div className={`ext-part ${stateOf(1) === "open" ? "open" : "folded"}`} id={idOf(1)}>
          <PartHead n={1} title="The rooms" state={stateOf(1)} summary={roomsWord(pickedRows.map((r) => r.roomNumber))} onEdit={() => goTo(1)} />
          {stateOf(1) === "open" ? (
            <>
              <div className="ar-wrap">
                <table className="table ar-table" data-no-pending>
                  <thead>
                    <tr>
                      <th className="lp-tick" aria-label="Picked" />
                      <th>Room</th>
                      <th>Type · bed</th>
                      {p.nights.map((n) => (
                        <th key={n} className="ar-night">
                          {fmtDay(n)}
                        </th>
                      ))}
                      <th className="num">A night</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {p.rooms.map((r) => {
                      const on = picked.includes(r.roomId);
                      const movable = r.holders.find((h) => h.swappable && h.rooms.length > 0) ?? null;
                      return (
                        <tr
                          key={r.roomId}
                          className={`${on ? "on" : ""}${r.selectable ? "" : " shut"}`}
                          onClick={r.selectable ? () => set({ picked: on ? picked.filter((x) => x !== r.roomId) : [...picked, r.roomId] }) : undefined}
                          title={r.why ?? undefined}
                          data-room={r.roomNumber}
                        >
                          <td className="lp-tick">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={!r.selectable}
                              aria-label={`Room ${r.roomNumber}`}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => set({ picked: on ? picked.filter((x) => x !== r.roomId) : [...picked, r.roomId] })}
                            />
                          </td>
                          <td>
                            <b>Room {r.roomNumber}</b>
                          </td>
                          <td className="sm">
                            {r.roomTypeName ?? "—"}
                            {r.bedType ? ` · ${r.bedType.toLowerCase()}` : ""}
                          </td>
                          {r.perNight.map((n) => (
                            <td key={n.date} className={`ar-cell ${n.status === "FREE" ? (r.needsCleaning ? "dirty" : "free") : n.status === "RESERVED" || n.status === "HELD" ? "taken" : "out"}`}>
                              {n.status === "FREE" ? (r.needsCleaning ? "To clean" : "Free") : n.guest ?? STATUS_WORD[n.status]}
                            </td>
                          ))}
                          <td className="num money">{r.roomRate != null ? money(r.roomRate) : "—"}</td>
                          <td>
                            {movable ? (
                              <Button
                                kind="secondary"
                                compact
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMoveFor({ room: r, holder: movable });
                                }}
                              >
                                Move their booking
                              </Button>
                            ) : r.holders.length && !r.selectable ? (
                              <span className="sm muted">{r.holders[0].why ?? "held"}</span>
                            ) : r.why && !r.selectable ? (
                              <span className="sm muted">{r.why.split(" — ")[0]}</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <PartDone ready={part1Ready} why={part1Ready ? null : "Tick a free room"} onDone={() => goTo(2)} />
            </>
          ) : null}
        </div>

        {/* 2 · the new guests */}
        <div className={`ext-part ${stateOf(2) === "open" ? "open" : stateOf(2) === "done" ? "folded" : "waiting"}`} id={idOf(2)}>
          <PartHead
            n={2}
            title="The new guests"
            state={stateOf(2)}
            summary={`${adults} adult${adults === 1 ? "" : "s"}${d.kids.length ? `, ${d.kids.length} child${d.kids.length === 1 ? "" : "ren"} (${d.kids.join(", ")})` : ""}`}
            waitsFor="The rooms"
            onEdit={() => goTo(2)}
          />
          {stateOf(2) === "open" ? (
            <>
              <div className="form3">
                <div className="field">
                  <label>Adults</label>
                  <select className="input" value={d.adults} onChange={(e) => set({ adults: e.target.value })}>
                    <option value="">—</option>
                    {Array.from({ length: 13 }, (_, i) => i).map((n) => (
                      <option key={n} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Children</label>
                  <select className="input" value={d.kids.length} onChange={(e) => set({ kids: Array.from({ length: Number(e.target.value) }, (_, i) => d.kids[i] ?? "") })}>
                    {Array.from({ length: 9 }, (_, i) => i).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {d.kids.length ? (
                <div className="form3">
                  {d.kids.map((k, i) => (
                    <div key={i} className="field">
                      <label>Child {i + 1}&rsquo;s age</label>
                      <input className="input" inputMode="numeric" value={k} onChange={(e) => set({ kids: d.kids.map((x, j) => (j === i ? e.target.value.replace(/\D/g, "").slice(0, 2) : x)) })} />
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="sm" style={{ margin: 0 }}>
                The booking has {entry.adultCount ?? 0} adult{entry.adultCount === 1 ? "" : "s"}
                {(entry.childAges ?? []).length ? ` and ${(entry.childAges ?? []).length} child${(entry.childAges ?? []).length === 1 ? "" : "ren"}` : ""} now; these join them.
              </p>
              <PartDone ready={!part2Why} why={part2Why} onDone={() => goTo(3)} />
            </>
          ) : null}
        </div>

        {/* 3 · the price */}
        <div className={`ext-part ${stateOf(3) === "open" ? "open" : stateOf(3) === "done" ? "folded" : "waiting"}`} id={idOf(3)}>
          <PartHead n={3} title="The price" state={stateOf(3)} summary="Seated and priced" waitsFor="The new guests" onEdit={() => goTo(3)} />
          {stateOf(3) === "open" ? (
            <>
              {!rateMay ? <p className="sm" style={{ margin: 0 }}>In house the rates are the GM&rsquo;s — the rooms are priced at their own rates. Meals and extra beds are yours to set.</p> : null}
              <RoomCompositionPlanner
                key={`${picked.join(",")}|${adults}|${d.kids.join(",")}`}
                tableOnly
                autoSeat={!comps.length}
                initialCompositions={comps.length ? comps : undefined}
                sealedRoomIds={picked}
                entryCheckIn={p.checkIn}
                entryCheckOut={p.checkOut}
                entryAdults={adults}
                entryChildAges={ages}
                roomDates={roomDates}
                entryId={entry.id}
                lockCommercial={!rateMay}
                persistKey={`add-room:${entry.id}`}
                onChange={setComps}
                onFaultsChange={setFaults}
              />
              <PartDone ready={!part3Why} why={part3Why} onDone={() => goTo(4)} />
            </>
          ) : null}
        </div>

        {/* 4 · their documents */}
        <div className={`ext-part ${stateOf(4) === "open" ? "open" : stateOf(4) === "done" ? "folded" : "waiting"}`} id={idOf(4)}>
          <PartHead
            n={4}
            title="Their documents"
            state={stateOf(4)}
            summary={d.docs === "NOW" ? "Recorded now" : "Later, from the Guests tab"}
            waitsFor="The price"
            onEdit={() => goTo(4)}
          />
          {stateOf(4) === "open" ? (
            <>
              <Choice
                options={[
                  ["NOW", "Record them now"],
                  ["LATER", "Later, from the Guests tab"],
                ] as const}
                value={d.docs}
                onChange={(v) => set({ docs: v })}
              />
              {d.docs === "NOW" ? (
                <IdentityProofBlock entry={entry} pendingSlots={pendingSlots} pendingRoomOf={pendingRoomOf} title="The new guests' documents" />
              ) : d.docs === "LATER" ? (
                <p className="sm" style={{ margin: 0 }}>
                  Once the rooms are added, the new guests&rsquo; rows are in the booking file&rsquo;s Guests tab › Edit — the same table, photo and phone code as at Check-in.
                </p>
              ) : null}
              <PartDone ready={!!d.docs} why={d.docs ? null : "Say when the documents are recorded"} onDone={() => goTo(5)} />
            </>
          ) : null}
        </div>

        {/* 5 · add them */}
        <div className={`ext-part ${stateOf(5) === "open" ? "open" : "waiting"}`} id={idOf(5)}>
          <PartHead n={5} title="Add the rooms" state={stateOf(5) === "done" ? "open" : stateOf(5)} waitsFor="Their documents" />
          {stateOf(5) === "open" ? (
            <>
              <div className="field">
                <label>
                  Note <span className="muted">· optional</span>
                </label>
                <input className="input" value={d.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="e.g. two more of the party arrived" />
              </div>
              <div className="ext-go">
                {actWhy ? <span className="meta">{actWhy}</span> : null}
                <Button className={actWhy ? undefined : "go"} state={actWhy ? "inert" : "default"} reason={actWhy ?? undefined} onClick={() => setConfirming(true)}>
                  {`Add ${roomsWord(pickedRows.map((r) => r.roomNumber))}`}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </StepCard>

      <DsDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Add ${roomsWord(pickedRows.map((r) => r.roomNumber))}`}
        caseLines={[entry.id]}
        busy={addM.isPending}
        footer={
          <>
            <NotNow onClick={() => setConfirming(false)} busy={addM.isPending} />
            <Button className="go" state={addM.isPending ? "working" : "default"} workingLabel="Adding…" onClick={() => addM.mutate()}>
              {`Add ${roomsWord(pickedRows.map((r) => r.roomNumber))}`}
            </Button>
          </>
        }
      >
        <ul className="sm leaving-what">
          <li>
            {roomsWord(pickedRows.map((r) => r.roomNumber))} join the booking from tonight to the check-out ({p.checkOut ? fmtDay(p.checkOut) : "—"}), {nightsWord(p.nights.length)}, with {adults} adult
            {adults === 1 ? "" : "s"}
            {ages.length ? ` and ${ages.length} child${ages.length === 1 ? "" : "ren"}` : ""}.
          </li>
          <li>The quotation is made again and the old one replaced; the proforma and the voucher are made again and wait for you under Papers — nothing is sent.</li>
          <li>Tonight is charged for the new rooms at once; housekeeping and the kitchen are told.</li>
          <li>{d.docs === "NOW" ? "The documents recorded go with the new guests." : "The new guests' documents are recorded later from the Guests tab."}</li>
        </ul>
      </DsDialog>

      <MoveHolderDialog
        room={moveFor?.room ?? null}
        holder={moveFor?.holder ?? null}
        onClose={() => setMoveFor(null)}
        onMove={(l) => {
          setMoveFor(null);
          setLegs(l);
        }}
      />
      <RoomMoveDialog
        legs={legs}
        onClose={() => {
          setLegs(null);
          void qc.invalidateQueries({ queryKey: ["add-room-preview", entry.id] });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ add or remove a room */

/** Change booking › Add or remove a room — two sub-tabs (2026-11-26). */
export function RoomsEditPane({ entry, onNightAudit, goToStep }: { entry: EntryDetail; onNightAudit?: () => void; goToStep?: (n: number) => void }) {
  return (
    <SubTabs
      label="Add or remove a room"
      param="rooms"
      tabs={[
        { key: "add", label: "Add a room", content: <AddRoom entry={entry} /> },
        { key: "remove", label: "Remove a room", content: <LeavingEarly entry={entry} mode="REMOVE" onNightAudit={onNightAudit} goToStep={goToStep} /> },
      ]}
    />
  );
}
