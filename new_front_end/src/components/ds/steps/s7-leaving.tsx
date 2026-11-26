"use client";

/**
 * Leaving early, and a room added — Stay's Change booking (2026-11-26, operator: "leaving early as
 * all the rooms or just particular rooms, when leaving like today or some date before the actual
 * bookings check out date, and then option to bill it together with the other stays or pay their own
 * for the room bills, cancellation policy should be applied and also waive option for higher
 * authority, and adding and removing room to be under change booking itself").
 *
 *  - `LeavingEarly`: who leaves (the whole booking, or some rooms), on which day (today or a later one
 *    before the booked check-out), for some rooms whose bill it is (with the booking, or their own),
 *    and the hotel's early-departure fee — every figure the server's, recorded by the GM, who may
 *    waive the fee. "Remove a room" opens the same form on some rooms.
 *  - `RoomsLeavingCard`: the rooms recorded to leave on a later day — released by the desk on the day,
 *    the room's own share taken then when it pays its own.
 *  - `AddRoom`: a room added as a stay of its own on the enquiry, made ready at Arrival.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { DateInput } from "@/components/ds/date-input";
import { Help } from "@/components/ds/help";
import { BankFields, useBankEntry } from "@/components/ds/bank-fields";
import {
  addRoom,
  listRoomDepartures,
  previewAddRoom,
  previewLeaving,
  recordLeaving,
  releaseRoomDeparture,
  type AddRoomOutcome,
  type LeavingOutcome,
  type RoomDepartureRow,
} from "@/lib/api/leaving-early";
import { getSettlementTargets, recordTargetPayment } from "@/lib/api/split-settlement";
import { fmtDay, money } from "@/lib/ds/format";
import { effectiveCheckOutIso } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, NotNow, StepCard, atLeast, toastRefusal, useRefreshEntry } from "./kit";

const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;
const roomsWord = (nos: Array<string | null>) => (nos.length === 1 ? `Room ${nos[0]}` : `Rooms ${nos.join(", ")}`);
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

/* ------------------------------------------------------------------ leaving early */

export function LeavingEarly({
  entry,
  startWith = null,
  onNightAudit,
  goToStep,
}: {
  entry: EntryDetail;
  /** "ROOMS" when opened from Remove a room. */
  startWith?: "ROOMS" | null;
  onNightAudit?: () => void;
  goToStep?: (n: number) => void;
}) {
  const { session } = useSession();
  const gm = atLeast(session?.actorLevel, "L3");
  const hotelToday = useHotelDay()?.today ?? null;
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const checkOut = effectiveCheckOutIso(entry)?.slice(0, 10) ?? null;
  const [who, setWho] = useState<"BOOKING" | "ROOMS" | null>(startWith);
  const [picked, setPicked] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [billing, setBilling] = useState<"TOGETHER" | "OWN" | null>(null);
  const [waive, setWaive] = useState(false);
  const [waiveWhy, setWaiveWhy] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [paying, setPaying] = useState<Array<{ roomId: string; roomNumber: string }>>([]);
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
    queryFn: () => previewLeaving(session!, entry.id, { departureDate: date, ...(asRooms ? { roomIds: picked } : {}) }),
    enabled: !!session && !!date && entry.currentStage === "S7",
    staleTime: 0,
    placeholderData: (prev) => prev,
  });
  const f = preview.data ?? null;
  const inUse = f?.roomsInUse ?? [];
  const several = inUse.length > 1;
  // Some rooms named that turn out to be every room is the whole booking — the server says so.
  const allPicked = who === "ROOMS" && inUse.length > 0 && inUse.every((r) => picked.includes(r.roomId));
  const shortRooms = (f?.rooms ?? []).filter((r) => r.shortened);
  const later = !!f?.later;
  const scope = f?.scope ?? "BOOKING";
  const stale = preview.isFetching;
  const hard = (f?.blockers ?? []).filter((b) => b.code !== "NIGHT_AUDITS_INCOMPLETE");
  const nightsMissing = f?.missingNightYmds ?? [];

  const why = !who
    ? "say who leaves"
    : who === "ROOMS" && !picked.length
      ? "pick the rooms that leave"
      : who === "ROOMS" && !allPicked && !billing
        ? "say whose bill it is"
        : !f || stale
          ? "reading the figures"
          : hard.length
            ? hard[0].message
            : nightsMissing.length
              ? "post the nights already slept first"
              : waive && !waiveWhy.trim()
                ? "say why the fee is waived"
                : !reason.trim()
                  ? "say why they leave early"
                  : !gm
                    ? "the GM's call — recording an early departure gives up nights"
                    : null;
  const blocked = !!why;

  const record = useMutation({
    mutationFn: () =>
      recordLeaving(session!, entry.id, {
        departureDate: date,
        ...(scope === "ROOMS" ? { roomIds: picked, billing: billing ?? "TOGETHER" } : {}),
        reason: reason.trim(),
        ...(waive ? { waiveFee: true, waiveReason: waiveWhy.trim() } : {}),
      }),
    onSuccess: (o: LeavingOutcome) => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["room-departures", entry.id] });
      refresh([["room-departures", entry.id], ["settlement-targets"], ["leaving-preview", entry.id]]);
      if (o.scope === "ROOMS") {
        const nos = o.records.map((r) => r.roomNumber);
        toast.success(o.later ? `${roomsWord(nos)} will leave on ${fmtDay(o.departureDate)} — the nights after are not charged` : `${roomsWord(nos)} left — the rooms go to housekeeping`);
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
      setBilling(null);
    },
    onError: (e) => toastRefusal(e, "Could not record it"),
  });

  if (entry.earlyDeparture) {
    return (
      <StepCard title="Leaving early" status={<span className="warn-ink">An early departure is already recorded for the whole booking ({entry.earlyDeparture.id}).</span>} />
    );
  }

  const maxDate = checkOut ? addDays(checkOut, -1) : undefined;
  const actLabel =
    scope === "ROOMS" && !allPicked
      ? later
        ? `Record — ${roomsWord(shortRooms.map((r) => r.roomNumber))} leave${shortRooms.length === 1 ? "s" : ""} on ${fmtDay(date)}`
        : `${roomsWord(shortRooms.map((r) => r.roomNumber))} leave${shortRooms.length === 1 ? "s" : ""} now`
      : later
        ? `Shorten the stay to ${fmtDay(date)}`
        : "Record it and go to Check-out";

  return (
    <div className="leaving" data-leaving>
      <StepCard title="1 · Who leaves">
        <Choice
          options={several ? ([["BOOKING", "The whole booking"], ["ROOMS", "Some rooms"]] as const) : ([["BOOKING", "The whole booking"]] as const)}
          value={who}
          onChange={(v) => {
            setWho(v);
            if (v === "BOOKING") setPicked([]);
          }}
        />
        {!several && inUse.length === 1 ? <p className="sm">One room is in use, so it leaves with the booking.</p> : null}
        {who === "ROOMS" ? (
          <div className="leaving-rooms" role="group" aria-label="The rooms that leave">
            {inUse.map((r) => {
              const on = picked.includes(r.roomId);
              return (
                <button
                  key={r.roomId}
                  type="button"
                  className={`leaving-room${on ? " on" : ""}`}
                  aria-pressed={on}
                  disabled={r.apartment}
                  title={r.apartment ? "An apartment leaves early as the whole booking" : undefined}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== r.roomId) : [...p, r.roomId]))}
                >
                  <span className="lr-tick" aria-hidden>
                    {on ? "✓" : ""}
                  </span>
                  <b>Room {r.roomNumber}</b>
                  <span className="sm">
                    {r.roomTypeName ?? ""} · booked to {fmtDay(r.endDate)}
                  </span>
                </button>
              );
            })}
            {allPicked ? <p className="sm warn-ink">Every room is picked — that is the whole booking leaving early.</p> : null}
          </div>
        ) : null}
      </StepCard>

      <StepCard title="2 · When they leave">
        <div className="form2">
          <div className="field">
            <label>
              Leaving on
              <Help label="Which day">The morning they go. Today, or a later day before the booked check-out ({checkOut ? fmtDay(checkOut) : "—"}). The nights from that day on are not charged.</Help>
            </label>
            <DateInput className="input" value={date} min={hotelToday ?? undefined} max={maxDate} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Nights not slept</label>
            <div className="leaving-fig">
              {f ? (
                <>
                  <b>{nightsWord(f.unstayedNights)}</b> {date === hotelToday ? "· they leave today" : later ? `· they stay until the morning of ${fmtDay(date)}` : ""}
                </>
              ) : (
                "—"
              )}
            </div>
          </div>
        </div>
      </StepCard>

      {who === "ROOMS" && !allPicked ? (
        <StepCard title="3 · Their bill">
          <Choice
            options={[
              ["TOGETHER", "With the rest of the booking"],
              ["OWN", "They pay their own"],
            ] as const}
            value={billing}
            onChange={setBilling}
          />
          <p className="sm">
            {billing === "OWN"
              ? later
                ? "The rooms' own share is taken on the day they leave, when the desk releases them."
                : "The rooms' own share is taken as they leave — the payment opens once it is recorded."
              : billing === "TOGETHER"
                ? "Their charges stay on the booking's bill and are paid at check-out with the rest."
                : "Whose bill the rooms' charges stay on."}
          </p>
        </StepCard>
      ) : null}

      {who && (who === "BOOKING" || picked.length) ? (
        <StepCard title={`${who === "ROOMS" && !allPicked ? "4" : "3"} · What it comes to`} status={stale ? "Reading the figures…" : undefined}>
          {f ? (
            <>
              <table className="table leaving-table">
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Nights given up</th>
                    <th className="num">Not charged</th>
                    <th className="num">Fee (net)</th>
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
                      <td className="num money">{waive ? "waived" : money(scope === "ROOMS" ? r.feeAmount : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="leaving-sum">
                <span>
                  Not charged <b className="money">{money(f.forgoneRoomTotal)}</b>
                </span>
                <span>
                  Early departure fee{" "}
                  <b className="money">{waive ? "waived" : `${money(f.fee.amount)} + service charge and GST = ${money(f.fee.gross)}`}</b>
                </span>
              </div>
              <p className="sm">
                The hotel&rsquo;s early-departure policy: {f.fee.explanation}
                {scope === "ROOMS" && !allPicked ? " Each room's fee is posted on the room, on whoever pays the room." : ""}
              </p>
              {nightsMissing.length ? (
                <div className="notice stop" role="alert">
                  <span>
                    The night{nightsMissing.length === 1 ? "" : "s"} of {nightsMissing.map((d) => fmtDay(d)).join(", ")} {nightsMissing.length === 1 ? "is" : "are"} not posted yet — post {nightsMissing.length === 1 ? "it" : "them"} first.
                  </span>
                  {onNightAudit ? (
                    <Button kind="secondary" onClick={onNightAudit}>
                      Night audit
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {hard.map((b) => (
                <div key={b.code + b.message} className="notice stop" role="alert">
                  <span>{b.message}</span>
                </div>
              ))}
              {gm ? (
                <label className="leaving-waive">
                  <input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> Waive the fee
                </label>
              ) : (
                <p className="sm">Waiving the fee is the GM&rsquo;s.</p>
              )}
              {waive ? (
                <div className="field">
                  <label>Why the fee is waived</label>
                  <input className="input" value={waiveWhy} onChange={(e) => setWaiveWhy(e.target.value)} placeholder="e.g. a family emergency" />
                </div>
              ) : null}
              <div className="field">
                <label>Why they leave early</label>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. their flight was moved" />
              </div>
              <div className="row-acts" style={{ justifyContent: "flex-end" }}>
                <Button className={blocked ? undefined : "go"} state={blocked ? "inert" : "default"} reason={blocked ? (why ?? undefined) : undefined} onClick={() => setConfirming(true)}>
                  {actLabel}
                </Button>
              </div>
            </>
          ) : (
            <p className="sm">Reading the figures…</p>
          )}
        </StepCard>
      ) : null}

      <DsDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={scope === "ROOMS" && !allPicked ? "Some rooms leave early" : "The booking leaves early"}
        caseLines={[entry.id]}
        busy={record.isPending}
        footer={
          <>
            <NotNow onClick={() => setConfirming(false)} busy={record.isPending} />
            <Button className="go" state={record.isPending ? "working" : "default"} workingLabel="Recording…" onClick={() => record.mutate()}>
              {actLabel}
            </Button>
          </>
        }
      >
        {f ? (
          <ul className="sm leaving-what">
            <li>
              {scope === "ROOMS" && !allPicked ? roomsWord(shortRooms.map((r) => r.roomNumber)) : "The stay"} {later ? `ends on the morning of ${fmtDay(f.departureDate)}` : "ends this morning"}; {nightsWord(f.unstayedNights)}{" "}
              not slept, {money(f.forgoneRoomTotal)} not charged.
            </li>
            <li>{waive ? "The early-departure fee is waived." : `The early-departure fee of ${money(f.fee.amount)} (${money(f.fee.gross)} with service charge and GST) goes on the bill.`}</li>
            {scope === "ROOMS" && !allPicked ? (
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
          </ul>
        ) : null}
      </DsDialog>

      <PayRoomDialog entry={entry} room={paying[0] ?? null} onClose={() => setPaying((p) => p.slice(1))} />
    </div>
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
      <StepCard title={all ? "Rooms that left early" : "Rooms leaving early"} className="leaving-card">
        {rows.map((r) => (
          <div key={r.id} className={`leaving-row${r.dueToday ? " due" : ""}`} data-room-leaving={r.state}>
            <span className="fom-wait-text">
              <b>
                Room {r.roomNumber}{" "}
                {r.state === "LEFT" ? `left on ${fmtDay(r.departureDate)}` : r.dueToday ? "leaves today — release it" : `leaves on ${fmtDay(r.departureDate)}`}
              </b>
              <span className="sm">
                {nightsWord(r.unstayedNights)} not slept · {r.feeWaived ? "fee waived" : r.feeAmount > 0 ? `fee ${money(r.feeAmount)} + taxes on the room` : "no fee"} ·{" "}
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

/* ------------------------------------------------------------------ a room added */

const PLANS = [
  ["EP", "Room only"],
  ["CP", "Breakfast (CP)"],
  ["MAPL", "Breakfast and lunch"],
  ["MAPD", "Breakfast and dinner"],
  ["AP", "All meals (AP)"],
] as const;
type Plan = (typeof PLANS)[number][0];

export function AddRoom({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const gm = atLeast(session?.actorLevel, "L3");
  const hotelToday = useHotelDay()?.today ?? null;
  const refresh = useRefreshEntry(entry.id);
  const checkOut = effectiveCheckOutIso(entry)?.slice(0, 10) ?? null;
  const [start, setStart] = useState("");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [adults, setAdults] = useState("2");
  const [kids, setKids] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<AddRoomOutcome | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !hotelToday) return;
    started.current = true;
    setStart(hotelToday);
  }, [hotelToday]);
  const q = useQuery({
    queryKey: ["add-room-preview", entry.id, start],
    queryFn: () => previewAddRoom(session!, entry.id, { startDate: start }),
    enabled: !!session && !!start && entry.currentStage === "S7",
    staleTime: 0,
    placeholderData: (prev) => prev,
  });
  const p = q.data ?? null;
  const room = p?.rooms.find((r) => r.roomId === roomId) ?? null;
  const type = p?.types.find((t) => t.roomTypeId === room?.roomTypeId) ?? null;
  const byType = useMemo(() => {
    const m = new Map<string, NonNullable<typeof p>["rooms"]>();
    for (const r of p?.rooms ?? []) m.set(r.roomTypeId ?? "", [...(m.get(r.roomTypeId ?? "") ?? []), r]);
    return m;
  }, [p]);
  const nAdults = Number(adults);
  const ages = kids.map((k) => Number(k));
  const why = !p
    ? "reading the free rooms"
    : p.refusal
      ? p.refusal
      : !room
        ? "pick the room"
        : !(nAdults >= 1)
          ? "at least one adult"
          : ages.some((a) => !(a >= 0 && a <= 17) || kids.some((k) => k.trim() === ""))
            ? "type each child's age"
            : !plan
              ? "pick the meal plan"
              : !reason.trim()
                ? "say why the room is added"
                : !gm
                  ? "the GM's or an admin's"
                  : null;
  const add = useMutation({
    mutationFn: () => addRoom(session!, entry.id, { roomId: roomId!, startDate: start, adults: nAdults, childAges: ages, mealPlan: plan!, reason: reason.trim() }),
    onSuccess: (o) => {
      setConfirming(false);
      setDone(o);
      refresh([["add-room-preview", entry.id]]);
      toast.success(`Room ${o.roomNumber} added as ${o.newEntryId}`);
      if (o.blocked) toast.warning(`It stopped at ${o.blocked.atStep.toLowerCase().replace(/_/g, " ")}: ${o.blocked.message}`);
      setRoomId(null);
      setReason("");
    },
    onError: (e) => toastRefusal(e, "Could not add the room"),
  });
  const rate = (r: number | null | undefined) => (r == null ? null : money(r));
  const planRate = (k: Plan) =>
    !type ? null : k === "CP" ? rate(type.cpRate ?? type.breakfastRate) : k === "MAPL" ? rate(type.mapLunchRate) : k === "MAPD" ? rate(type.mapDinnerRate) : k === "AP" ? rate(type.apRate) : null;
  return (
    <div className="leaving" data-add-room>
      {done ? (
        <div className={`notice ${done.blocked ? "next" : "paid"}`} role="status" data-add-room-done>
          <span>
            <b>
              Room {done.roomNumber} added as {done.newEntryId}
            </b>{" "}
            · {fmtDay(done.checkInDate)} → {fmtDay(done.checkOutDate)}
            {done.quotationTotal != null ? ` · priced ${money(done.quotationTotal)}` : ""}
            <br />
            <span className="sm">
              {done.reachedStage === "S5"
                ? `At Arrival${done.roomHandedOut ? ", the room handed out" : ""} — open it to check the guests in (their ID, the key).`
                : done.blocked
                  ? `It stopped before Arrival: ${done.blocked.message}`
                  : `It is at ${done.reachedStage}.`}
            </span>
          </span>
          <Link className="btn btn-primary go" href={`/bookings/${done.newEntryId}`}>
            Open {done.newEntryId}
          </Link>
        </div>
      ) : null}
      <StepCard title="1 · From which night" status={p?.endDate ? `to the booking's check-out, ${fmtDay(p.endDate)} · ${nightsWord(p.nights)}` : undefined}>
        <div className="form2">
          <div className="field">
            <label>
              First night
              <Help label="From which night">The room is added from this night to the booking&rsquo;s check-out ({checkOut ? fmtDay(checkOut) : "—"}).</Help>
            </label>
            <DateInput className="input" value={start} min={hotelToday ?? undefined} max={checkOut ? addDays(checkOut, -1) : undefined} onChange={(e) => setStart(e.target.value)} />
          </div>
        </div>
        {p?.refusal ? (
          <div className="notice stop" role="alert">
            <span>{p.refusal}</span>
          </div>
        ) : null}
      </StepCard>

      <StepCard title="2 · The room" status={p && !p.refusal ? `${p.rooms.length} free for every night` : undefined}>
        {p && !p.refusal && p.types.length === 0 ? <p className="sm warn-ink">No room is free for every night to the check-out.</p> : null}
        {p?.types.map((t) => (
          <div key={t.roomTypeId} className="add-room-type">
            <div className="add-room-type-head">
              <b>{t.name}</b>
              <span className="sm">
                {t.freeCount} free · {t.roomRate != null ? `${money(t.roomRate)} a night` : "rate not set"}
                {t.packageName ? ` · ${t.packageName}` : ""}
              </span>
            </div>
            <div className="leaving-rooms">
              {(byType.get(t.roomTypeId) ?? []).map((r) => (
                <button key={r.roomId} type="button" className={`leaving-room${roomId === r.roomId ? " on" : ""}`} aria-pressed={roomId === r.roomId} onClick={() => setRoomId(r.roomId)}>
                  <span className="lr-tick" aria-hidden>
                    {roomId === r.roomId ? "✓" : ""}
                  </span>
                  <b>Room {r.roomNumber}</b>
                  <span className="sm">{r.needsCleaning ? "to be cleaned first" : r.bedType ? r.bedType.toLowerCase() : ""}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </StepCard>

      <StepCard title="3 · Who sleeps in it">
        <div className="form2">
          <div className="field">
            <label>Adults</label>
            <input className="input" inputMode="numeric" value={adults} onChange={(e) => setAdults(e.target.value.replace(/\D/g, "").slice(0, 2))} />
          </div>
          <div className="field">
            <label>Children</label>
            <select className="input" value={kids.length} onChange={(e) => setKids((k) => Array.from({ length: Number(e.target.value) }, (_, i) => k[i] ?? ""))}>
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        {kids.length ? (
          <div className="form3">
            {kids.map((k, i) => (
              <div key={i} className="field">
                <label>Child {i + 1}&rsquo;s age</label>
                <input className="input" inputMode="numeric" value={k} onChange={(e) => setKids((all) => all.map((x, j) => (j === i ? e.target.value.replace(/\D/g, "").slice(0, 2) : x)))} />
              </div>
            ))}
          </div>
        ) : null}
        <div className="field">
          <label>Meal plan</label>
          <Choice options={PLANS.map(([k, l]) => [k, planRate(k) ? `${l} · ${planRate(k)}` : l] as const)} value={plan} onChange={setPlan} />
        </div>
      </StepCard>

      <StepCard title="4 · Add it">
        <p className="sm">
          The room becomes a stay of its own on this enquiry, priced on the same package, billed with the trip on Billing and settled on its own. It is made ready at Arrival with the room
          handed out; the guests are then checked in as any arrival — their ID and the key.
        </p>
        <div className="field">
          <label>Why the room is added</label>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. two more guests joined the group" />
        </div>
        <div className="row-acts" style={{ justifyContent: "flex-end" }}>
          <Button className={why ? undefined : "go"} state={why ? "inert" : "default"} reason={why ?? undefined} onClick={() => setConfirming(true)}>
            {room ? `Add Room ${room.roomNumber}` : "Add the room"}
          </Button>
        </div>
      </StepCard>

      <DsDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={room ? `Add Room ${room.roomNumber}` : "Add the room"}
        caseLines={[entry.id]}
        busy={add.isPending}
        footer={
          <>
            <NotNow onClick={() => setConfirming(false)} busy={add.isPending} />
            <Button className="go" state={add.isPending ? "working" : "default"} workingLabel="Adding…" onClick={() => add.mutate()}>
              {room ? `Add Room ${room.roomNumber}` : "Add the room"}
            </Button>
          </>
        }
      >
        <ul className="sm leaving-what">
          <li>
            Room {room?.roomNumber} ({type?.name}) from {fmtDay(start)} to {p?.endDate ? fmtDay(p.endDate) : "—"}, {nightsWord(p?.nights ?? 0)}, {nAdults} adult{nAdults === 1 ? "" : "s"}
            {ages.length ? ` and ${ages.length} child${ages.length === 1 ? "" : "ren"}` : ""}, {PLANS.find(([k]) => k === plan)?.[1].toLowerCase()}.
          </li>
          <li>A stay of its own on this enquiry: its own quotation, voucher (held for you), bill — billed with the trip.</li>
          <li>It waits at Arrival for the guests to be checked in.</li>
        </ul>
      </DsDialog>
    </div>
  );
}
