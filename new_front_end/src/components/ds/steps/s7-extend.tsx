"use client";

/**
 * Extend the stay — rebuilt in the desk's own look (2026-11-25, operator: "the extend the stay option
 * in stage 7 is very confusing, plus it is stuck on old ui ux style, make it better and user friendly").
 *
 * The rules are the backend's and unchanged (docs/stay-extension-and-interim-payments.md): the house is
 * asked for the extra nights, the nights are held while a bill for part of the stay goes to the guest,
 * the money comes in, and only then is the stay extended — the FOM's act. What changed is how the desk
 * walks it:
 *
 *   - **Before anything is held**, one page in three parts: the new check-out (the house is asked by
 *     itself as the date changes — no "Check" button), the price of the extra nights in one blue band,
 *     and what the guest pays now as three plain choices (half the stay · the whole stay · another
 *     figure) with the server's figures beneath. One green button holds the nights and makes the bill.
 *     No reason is asked (the operator's rule for changes to a booking, 2026-11-04).
 *   - **Once held**, a line of steps — bill made · sent · their answer (when asked) · paid · extended —
 *     and under it only the thing to do now, its button green: Send the bill, Record their answer,
 *     Record the payment, Extend the stay. The nights' hold time is a chip that turns red near its end.
 *
 * Every figure is read from the API; nothing here adds money.
 */
import { BankFields, useBankEntry } from "@/components/ds/bank-fields";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { ApiError } from "@/lib/api/client";
import { acknowledgeMultiBooking } from "@/lib/api/confirmation";
import { replySettled } from "@/lib/api/entries";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import { ADVANCE_PAYMENT_MODES, type AdvancePaymentMode } from "@/lib/api/reservation-setup";
import {
  commitStayExtension,
  extendStayNow,
  listStayExtensions,
  previewStayExtension,
  recordInterimPayment,
  recordInterimPromise,
  requestStayExtension,
  withdrawStayExtension,
  type StayExtensionPreview,
  type StayExtensionRow,
  type StayExtensionTakenRoom,
} from "@/lib/api/stay-money";
import { fmtDate, fmtDateTime, fmtDay, money, plural } from "@/lib/ds/format";
import { countdownTo } from "@/lib/desk/timers";
import type { EntryDetail, InvoiceSummary } from "@/types/api";
import { DateInput, DateTimeInput } from "@/components/ds/date-input";
import { Help } from "@/components/ds/help";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
import { RoomMoveDialog } from "@/components/ds/rooms/room-move-dialog";
import type { RoomMoveLegInput } from "@/lib/api/room-moves";
import { STEP_NAMES } from "@/lib/ds/steps";
import { guestNameOf } from "@/lib/ds/status";
import {
  AnswerLine,
  Choice,
  DsDialog,
  InvoiceSendDialog,
  NotSentChip,
  PaperDrawer,
  StepCard,
  Tool,
  atLeast,
  latestDispatched,
  useCommunications,
  useReplyAsked,
  type PaperRef,
} from "./kit";

const ymd = (iso: string | null | undefined) => (iso ?? "").slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Calendar nights between two dates — date arithmetic, not money. */
const nightsBetween = (from: string, to: string) => {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 86_400_000);
};

/**
 * When the guest pays for the extra nights (2026-11-25, operator: "need option to not pay and pay during
 * the last check out as well, but if paying, we need the proper payment fields"): now at the desk, on a
 * bill sent to them, or at check-out with the rest of the bill.
 */
type PayAt = "NOW" | "BILL" | "CHECKOUT";
const PAY_AT: ReadonlyArray<readonly [PayAt, string]> = [
  ["NOW", "Now, at the desk"],
  ["BILL", "Send them a bill"],
  ["CHECKOUT", "At check-out"],
];
/** The heading of what opens under the chosen way (2026-11-25, operator: the shares read as more of the same list). */
const PAY_AT_SUB: Record<PayAt, string> = {
  NOW: "How much they pay now",
  BILL: "How much the bill asks for",
  CHECKOUT: "Nothing is taken now",
};
type Share = "HALF" | "WHOLE" | "OTHER";
const SHARES: ReadonlyArray<readonly [Share, string]> = [
  ["HALF", "Half the stay"],
  ["WHOLE", "The whole stay"],
  ["OTHER", "Another figure"],
];
const UNITS: ReadonlyArray<readonly ["PERCENT" | "AMOUNT", string]> = [
  ["PERCENT", "% of the stay"],
  ["AMOUNT", "Nu"],
];

function useInvalidate(entryId: string, onChanged?: () => void) {
  const qc = useQueryClient();
  return (opts?: { keepPreview?: boolean }) => {
    for (const key of ["stay-extensions", "interim-payments", "entry", "entry-communications", "billing-summary", "entry-timers", "entry-trace", "room-plan-history", "stay-extension-preview"]) {
      if (opts?.keepPreview && key === "stay-extension-preview") continue;
      void qc.invalidateQueries({ queryKey: [key, entryId] });
    }
    onChanged?.();
  };
}

export function ExtendStay({ entry, onChanged }: { entry: EntryDetail; onChanged?: () => void }) {
  const { session } = useSession();
  const fom = atLeast(session?.actorLevel, "L2");
  const q = useQuery({
    queryKey: ["stay-extensions", entry.id],
    queryFn: () => listStayExtensions(session!, entry.id),
    enabled: !!session,
  });
  const requests = q.data?.requests ?? [];
  const open = requests.find((r) => r.state === "REQUESTED" || r.state === "BILLED" || r.state === "PAID") ?? null;
  const earlier = requests.filter((r) => r !== open);
  // The check-out as it stands: an extension just made is on the list before the booking is read again.
  const committedOut = requests.filter((r) => r.state === "COMMITTED").map((r) => ymd(r.newCheckOutDate)).sort().pop() ?? "";
  const bookedOut = ymd(entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate);
  const checkOut = committedOut > bookedOut ? committedOut : bookedOut;

  return (
    <div className="ext">
      {q.isLoading ? (
        <StepCard title="Extend the stay">
          <p className="meta">Reading the booking…</p>
        </StepCard>
      ) : open ? (
        <OpenExtension entry={entry} req={open} fom={fom} onChanged={onChanged} />
      ) : !fom ? (
        <StepCard title="Extend the stay" status="The FOM's call">
          <p>Extending a stay is the front office manager&rsquo;s act. Ask the FOM to extend it from here.</p>
        </StepCard>
      ) : entry.currentStage !== "S7" ? (
        <StepCard title="Extend the stay">
          <p>A stay is extended while the guest is in house, on the Stay step.</p>
        </StepCard>
      ) : (
        <NewExtension entry={entry} checkOut={checkOut} onChanged={onChanged} />
      )}
      {earlier.length > 0 ? <EarlierExtensions rows={earlier} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ before anything is held */

function NewExtension({ entry, checkOut, onChanged }: { entry: EntryDetail; checkOut: string; onChanged?: () => void }) {
  const { session } = useSession();
  const invalidate = useInvalidate(entry.id, onChanged);
  const currentOut = checkOut;
  const [newOut, setNewOut] = useState(currentOut ? addDays(currentOut, 1) : "");
  // What happens to each room another booking holds on the extra nights (2026-11-25, operator: "we need
  // the swap feature here as well"): our guest moves out of it, or their booking is given another room so
  // our guest keeps it.
  const [choice, setChoice] = useState<Record<string, TakenChoice>>({});
  // The moves kept for our guest (2026-11-25, operator: "we need a button to move our guest field"; then
  // "it is not working as intended" — a group's several rooms can be taken): each taken room our guest
  // leaves, and the free room picked for it. Picking a room is a draft; Move our guest keeps it, and only
  // then is the house asked with it.
  const [ourMoves, setOurMoves] = useState<Record<string, string>>({});
  // The rate for each move to another type, asked on Done (2026-11-25, operator: "the option to choose
  // to charge with the same rate as before or new rate of the new room type for each room when clicking
  // done"): KEEP the rate the guest has, or OWN — the new room's own rate. Until chosen, its own rate.
  const [rateChoice, setRateChoice] = useState<Record<string, "KEEP" | "OWN">>({});
  const [askRates, setAskRates] = useState(false);
  const moves = useMemo(
    () =>
      Object.entries(ourMoves)
        .map(([fromRoomId, toRoomId]) => ({ fromRoomId, toRoomId, ...(rateChoice[fromRoomId] === "KEEP" ? { keepRate: true } : {}) }))
        .sort((a, b) => a.fromRoomId.localeCompare(b.fromRoomId)),
    [ourMoves, rateChoice],
  );
  const movesKey = JSON.stringify(moves);
  /** A move changed or taken back: its rate is asked again. */
  const forgetRate = (fromRoomId: string) =>
    setRateChoice((cur) => {
      if (!(fromRoomId in cur)) return cur;
      const next = { ...cur };
      delete next[fromRoomId];
      return next;
    });
  const [swapLegs, setSwapLegs] = useState<RoomMoveLegInput[] | null>(null);
  // After a swap the house is asked again; the taken rooms wait meanwhile.
  const [rechecking, setRechecking] = useState(false);
  const swapClosedAt = useRef(0);
  const qc = useQueryClient();
  const [payAt, setPayAt] = useState<PayAt | null>(null);
  const [payMode, setPayMode] = useState<AdvancePaymentMode | "">("");
  const payBank = useBankEntry();
  const [share, setShare] = useState<Share>("HALF");
  const [unit, setUnit] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [figure, setFigure] = useState("");
  const [ratesOpen, setRatesOpen] = useState(false);
  const [tableComps, setTableComps] = useState<RoomCompositionInput[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The check-out the house was last asked about — set by Check the rooms, never by typing a date
  // (2026-11-25, operator: "need a proper search button instead of automatically searching when extra
  // nights are changed"). A date changed after the check hides the answer until it is checked again.
  const [checkedOut, setCheckedOut] = useState<string | null>(null);

  // After an extension the check-out moves on; the new date starts again a night after it.
  useEffect(() => {
    if (currentOut) setNewOut(addDays(currentOut, 1));
    setOurMoves({});
    setRateChoice({});
    setChoice({});
    setCheckedOut(null);
  }, [currentOut]);
  const extra = currentOut && newOut ? nightsBetween(currentOut, newOut) : 0;
  const ask = share === "HALF" ? { mode: "PERCENT" as const, value: 50 } : share === "WHOLE" ? { mode: "PERCENT" as const, value: 100 } : { mode: unit, value: Number(figure) };
  const askOk = ask.value > 0 && (ask.mode !== "PERCENT" || ask.value <= 100);

  // What is asked of the house is debounced, so typing a figure asks once.
  const params = useMemo(
    () => ({
      newOut: checkedOut ?? "",
      moves,
      askMode: ask.mode,
      askValue: askOk && payAt !== "CHECKOUT" ? ask.value : undefined,
      comps: ratesOpen ? tableComps : [],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the moves are read by their contents
    [checkedOut, movesKey, ask.mode, ask.value, askOk, payAt, ratesOpen, tableComps],
  );
  // The rates table describes the rooms it was opened with. When a move or a rate choice changes the
  // rooms, its rows would name rooms no longer in the extension and the house would refuse them
  // (2026-11-25, operator: a moment of the old answer, then "Room 201 is not one of them" and no way
  // back) — so they are dropped, and the table opens again on the new rooms (keyed below).
  useEffect(() => {
    setTableComps([]);
  }, [movesKey, checkedOut]);
  const [asked, setAsked] = useState(params);
  useEffect(() => {
    const t = setTimeout(() => setAsked(params), 400);
    return () => clearTimeout(t);
  }, [params]);

  const [kept, setKept] = useState<StayExtensionPreview | null>(null);
  const preview = useQuery<StayExtensionPreview, Error>({
    queryKey: ["stay-extension-preview", entry.id, asked],
    enabled: !!session && !!asked.newOut && !!currentOut && nightsBetween(currentOut, asked.newOut) >= 1,
    placeholderData: (prev) => prev,
    // Always asked afresh: a room may have been swapped or booked since this answer was read.
    staleTime: 0,
    queryFn: () =>
      previewStayExtension(session!, entry.id, {
        newCheckOutDate: asked.newOut,
        moves: asked.moves.length ? asked.moves : undefined,
        roomCompositions: asked.comps.length ? asked.comps : undefined,
        askMode: asked.askMode,
        askValue: asked.askValue,
      }),
  });
  const stale = checkedOut !== newOut;
  const fresh = !stale && preview.data && ymd(preview.data.newCheckOut) === newOut ? preview.data : null;
  const refused = preview.isError ? (preview.error instanceof ApiError ? preview.error.message : "The house could not be asked — try again") : null;
  // Refused, the last answer for these dates stays, so the moves can still be changed or taken back.
  const p = fresh ?? (!stale && refused && kept && ymd(kept.newCheckOut) === newOut ? kept : null);
  const checking = !stale && preview.isFetching && !p;
  const check = () => {
    setOurMoves({});
    setRateChoice({});
    setChoice({});
    // Pressed again on the same date, the house is asked afresh.
    if (checkedOut === newOut) void preview.refetch();
    else setCheckedOut(newOut);
  };
  useEffect(() => {
    if (preview.data) setKept(preview.data);
  }, [preview.data, setKept]);
  useEffect(() => {
    if (!rechecking) return;
    if (asked === params && !preview.isFetching && preview.dataUpdatedAt > swapClosedAt.current) setRechecking(false);
    const t = setTimeout(() => setRechecking(false), 30_000);
    return () => clearTimeout(t);
  }, [rechecking, asked, params, preview.isFetching, preview.dataUpdatedAt]);

  const overlapAck = useMutation({
    mutationFn: () => acknowledgeMultiBooking(session!, entry.id, `Stay extended to ${newOut} — both bookings are meant (${p?.guestOverlap?.entryId ?? "another booking"})`),
    onSuccess: () => {
      toast.success("Recorded — both bookings stand");
      void preview.refetch();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't record it"),
  });

  const hold = useMutation({
    mutationFn: () =>
      requestStayExtension(session!, entry.id, {
        newCheckOutDate: newOut,
        moves: moves.length ? moves : undefined,
        roomCompositions: ratesOpen && tableComps.length ? tableComps : undefined,
        askMode: ask.mode,
        askValue: ask.value,
      }),
    onSuccess: (out) => {
      setConfirmOpen(false);
      toast.success(`The extra ${out.request.extraNights.length === 1 ? "night is" : "nights are"} held until ${fmtDateTime(out.request.holdExpiresAt)}. Next: send the bill for ${money(out.interim?.dueNow ?? 0)}.`, { duration: 9000 });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The extension was refused"),
  });

  const now = useMutation({
    mutationFn: () =>
      extendStayNow(session!, entry.id, {
        newCheckOutDate: newOut,
        moves: moves.length ? moves : undefined,
        roomCompositions: ratesOpen && tableComps.length ? tableComps : undefined,
        payAt: payAt === "NOW" ? "NOW" : "CHECKOUT",
        ...(payAt === "NOW" ? { askMode: ask.mode, askValue: ask.value, paymentMethod: payMode || undefined, ...payBank.body(payMode) } : {}),
      }),
    onSuccess: (out) => {
      setConfirmOpen(false);
      if (out.stoppedAt) {
        toast.warning(
          out.stoppedAt === "PAYMENT"
            ? `The nights are held and the bill is made, but the payment was not recorded: ${out.message}`
            : `${out.paid ? `${money(out.paid, p?.currency)} is recorded, but ` : ""}the stay was not extended: ${out.message}`,
          { duration: 14000 },
        );
      } else if (out.outcome?.walk.blocked) {
        toast.warning(`The extension is recorded, but the booking stopped at ${out.outcome.walk.reachedStage}: ${out.outcome.walk.blocked.message}`, { duration: 14000 });
      } else {
        const ends = fmtDate(out.outcome?.extension?.newCheckOutDate ?? newOut);
        toast.success(
          out.paid
            ? `${money(out.paid, p?.currency)} received. The stay now ends on ${ends}.`
            : `The stay now ends on ${ends}. The extra nights are paid at check-out.`,
          { duration: 10000 },
        );
      }
      // The check-out may have moved: the form starts afresh rather than ask the house again about a
      // date that is now the check-out itself.
      setCheckedOut(null);
      setAsked((a) => ({ ...a, newOut: "" }));
      invalidate({ keepPreview: true });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The stay could not be extended"),
  });

  const takenRooms = p?.takenRooms ?? [];
  const overlapOpen = !!p?.guestOverlap && !p.guestOverlap.acknowledged;
  const roomsOk = !!p && !p.blockedReason && !overlapOpen;
  const due = p?.figures.dueNow ?? null;
  const payMissing = payAt === "NOW" ? (!payMode ? "Choose how it was paid" : payBank.missing(payMode)) : null;
  const notReady = !p
    ? extra < 1
      ? "Pick a check-out after the current one"
      : "Asking the house…"
    : p.blockedReason
      ? "A room is not free — see above"
      : overlapOpen
        ? "Say whether both bookings are meant"
        : !payAt
          ? "Say when the guest pays"
          : payAt !== "CHECKOUT" && !askOk
            ? "Say what the guest pays now"
            : payAt !== "CHECKOUT" && (due ?? 0) <= 0
              ? "Nothing would be due now — ask for more"
              : payMissing
                ? payMissing
                : preview.isFetching
                  ? "Working out the figures…"
                  : refused
                    ? "The house refused — see above"
                    : null;
  const ready = !notReady;
  const goLabel = payAt === "NOW" ? `Take ${due != null ? money(due, p?.currency) : "the payment"} and extend the stay` : payAt === "CHECKOUT" ? "Extend the stay" : "Hold the nights and make the bill";
  const extensionRoomIds = useMemo(() => Array.from(new Set((p?.plan ?? []).map((x) => x.roomId))), [p]);
  const nightsWord = (n: number) => plural(n, "more night");

  // One part at a time (2026-11-25, operator: "this one should be shown one by one"): the next part
  // opens on Done, a finished part folds to its line with Edit, and the parts after it wait.
  const [at, setAt] = useState<1 | 2 | 3>(1);
  const goTo = (n: 1 | 2 | 3) => {
    setAt(n);
    // The desk asked to go on, so the page brings the part into view once it has opened.
    setTimeout(() => document.getElementById(`ext-part-${n}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
  };
  useEffect(() => {
    if (!roomsOk && at > 1) setAt(1);
  }, [roomsOk, at]);
  const part1Ready = roomsOk && !preview.isFetching && !refused;
  const crossMoves = (p?.moves ?? []).filter((m) => m.crossType);
  const gm = atLeast(session?.actorLevel, "L3");
  const rateWord = (m: StayExtensionPreview["moves"][number]) =>
    m.keepRate ? `keeps ${money(m.fromRate ?? 0, p?.currency)} a night` : `${m.toRate != null ? money(m.toRate, p?.currency) : "its own rate"} a night, its own rate`;
  const stillTaken = takenRooms.filter((r) => !ourMoves[r.roomId]).length;
  const part1Why = extra < 1 ? "Pick a check-out after the current one" : stale ? "Check the rooms first" : !p ? (preview.isError ? "The house could not be asked" : "Asking the house…") : p.blockedReason ? (takenRooms.length ? (stillTaken > 0 ? `Say what happens to ${stillTaken === 1 ? "the taken room" : `the ${stillTaken} taken rooms`} — move our guest, or move their booking` : p.blockedReason) : "A room is not free") : overlapOpen ? "Say whether both bookings are meant" : preview.isFetching ? "Asking the house…" : null;
  const roomsLine = !p
    ? ""
    : p.moves.length
      ? p.moves.map((m) => `Room ${m.fromRoomNumber} → Room ${m.toRoomNumber} from ${fmtDay(p.currentCheckOut)}${m.crossType ? ` (${rateWord(m)})` : ""}`).join(", ")
      : p.currentRooms.length === 1
        ? "the guest stays in the room"
        : "the guests stay in their rooms";

  return (
    <>
      <StepCard title="Extend the stay" status={p ? `${nightsWord(p.extraNights.length)} · ${money(p.pricing.delta ?? 0, p.currency)} more` : undefined}>
        {/* 1 · the new check-out */}
        <div className={`ext-part${at === 1 ? " open" : " folded"}`} id="ext-part-1">
          <PartHead
            n={1}
            title="The new check-out"
            state={at === 1 ? "open" : "done"}
            summary={p ? `Check-out ${fmtDate(currentOut)} → ${fmtDate(newOut)} · ${nightsWord(p.extraNights.length)} · ${roomsLine}` : null}
            onEdit={() => goTo(1)}
          />
          {at === 1 ? (
            <>
              <div className="ext-dates">
                <div className="field">
                  <label>Check-out now</label>
                  <span className="ext-now">{fmtDate(currentOut)}</span>
                </div>
                <span className="ext-arrow" aria-hidden>
                  →
                </span>
                <div className="field">
                  <label>New check-out</label>
                  <DateInput
                    className="input"
                    value={newOut}
                    min={currentOut ? addDays(currentOut, 1) : undefined}
                    onChange={(e) => setNewOut(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>Extra nights</label>
                  <span className="ext-stepper">
                    <Button kind="secondary" compact state={extra <= 1 ? "inert" : "default"} aria-label="One night fewer" onClick={() => setNewOut(addDays(newOut, -1))}>
                      −
                    </Button>
                    <b>{extra > 0 ? extra : "—"}</b>
                    <Button kind="secondary" compact aria-label="One more night" onClick={() => setNewOut(addDays(newOut || currentOut, 1))}>
                      +
                    </Button>
                  </span>
                </div>
                <div className="field ext-check">
                  <Button
                    className={stale && extra >= 1 ? "go" : undefined}
                    kind={stale ? "primary" : "secondary"}
                    state={checking ? "working" : extra >= 1 ? "default" : "inert"}
                    workingLabel="Checking…"
                    title={extra >= 1 ? undefined : "Pick a check-out after the current one"}
                    onClick={check}
                  >
                    {checkedOut && !stale ? "Check again" : "Check the rooms"}
                  </Button>
                </div>
              </div>

              {/* What the house said — only for the dates it was asked about */}
              {extra < 1 ? null : stale ? (
                <p className="meta ext-hint">
                  {checkedOut ? "The dates changed — " : ""}Press <b>Check the rooms</b> to see whether the {plural(extra, "night")} from {fmtDay(currentOut)} {extra === 1 ? "is" : "are"} free.
                </p>
              ) : refused && !p ? (
                <p className="stop-ink sm" role="alert">{refused}</p>
              ) : !p ? (
                <p className="meta">Checking the rooms…</p>
              ) : (
                <>
                  {refused ? (
                    <div className="notice ended" role="alert">
                      <span className="ended-mark">!</span>
                      <span>{refused}</span>
                    </div>
                  ) : null}
                  <RoomsAnswer p={p} />
                </>
              )}

              {p && takenRooms.length > 0 && rechecking ? (
                <p className="meta ext-hint" role="status">
                  Checking the rooms again…
                </p>
              ) : null}
              {p && takenRooms.length > 0 ? (
                <TakenRooms
                  busy={rechecking}
                  ourGuest={guestNameOf(entry.guestProfile ?? entry.inquiry?.guestProfile ?? null)}
                  p={p}
                  rooms={takenRooms}
                  choice={choice}
                  onChoice={(roomId, v) => {
                    setChoice((cur) => ({ ...cur, [roomId]: v }));
                    if (v === "THEIRS") forgetRate(roomId);
                    // Moving their booking instead lets go of a move kept for our guest out of this room.
                    if (v === "THEIRS" && ourMoves[roomId]) {
                      setOurMoves((cur) => {
                        const next = { ...cur };
                        delete next[roomId];
                        return next;
                      });
                    }
                  }}
                  ourMoves={ourMoves}
                  onKeepOurs={(fromRoomId, toRoomId) => {
                    forgetRate(fromRoomId);
                    setOurMoves((cur) => {
                      const next = { ...cur };
                      if (toRoomId) next[fromRoomId] = toRoomId;
                      else delete next[fromRoomId];
                      return next;
                    });
                  }}
                  onSwap={setSwapLegs}
                />
              ) : null}
              {p?.blockedReason && takenRooms.length === 0 ? (
                <div className="notice ended" role="alert">
                  <span className="ended-mark">!</span>
                  <span>{p.blockedReason}</span>
                </div>
              ) : null}
              {overlapOpen && p?.guestOverlap ? (
                <div className="answer-due">
                  <span className="due-head">The guest has another booking over these nights</span>
                  <span className="sm">
                    {p.guestOverlap.entryId} · {fmtDate(p.guestOverlap.checkIn)} to {fmtDate(p.guestOverlap.checkOut)}. Say they are both meant to go on; if it was booked twice, cancel the other one instead.
                  </span>
                  <div className="actbar">
                    <Button className="go" state={overlapAck.isPending ? "working" : "default"} workingLabel="Recording…" onClick={() => overlapAck.mutate()}>
                      Both are meant
                    </Button>
                  </div>
                </div>
              ) : null}
              <PartDone ready={part1Ready} why={part1Why} onDone={() => (crossMoves.length > 0 ? setAskRates(true) : goTo(2))} />
            </>
          ) : null}
        </div>

        {/* 2 · the price */}
        <div className={`ext-part${at === 2 ? " open" : at > 2 ? " folded" : " waiting"}`} id="ext-part-2">
          <PartHead
            n={2}
            title="The price"
            state={at === 2 ? "open" : at > 2 ? "done" : "waiting"}
            waitsFor="The new check-out"
            summary={p ? `${money(p.pricing.delta ?? 0, p.currency)} more · the stay comes to ${money(p.pricing.projectedStayTotal, p.currency)}${ratesOpen ? " · rates changed" : ""}` : null}
            onEdit={() => goTo(2)}
          />
          {at === 2 && p ? (
            <>
              <div className="bigfig">
                <span className="meta">{nightsWord(p.extraNights.length)}</span>
                <b>{money(p.pricing.delta ?? 0, p.currency)}</b>
                <span className="bf-parts">
                  The stay comes to {money(p.pricing.projectedStayTotal, p.currency)}
                  {p.pricing.priorStayTotal != null ? ` · it was ${money(p.pricing.priorStayTotal, p.currency)}` : ""}
                  {p.pricing.discount ? ` · the booking's ${p.pricing.discount.effectivePercent}% discount carries on` : ""}
                </span>
              </div>
              <div className="ext-row">
                <Button kind="quiet" compact onClick={() => setRatesOpen((v) => !v)}>
                  {ratesOpen ? "Keep the usual rates" : "Change the rates for the extra nights"}
                </Button>
                <Help label="About the rates">The same room keeps the rate the guest has. A room of another type keeps the guest&rsquo;s rate or takes its own, as chosen on Done. Change them here when the guest agreed another figure.</Help>
              </div>
              {ratesOpen && extensionRoomIds.length > 0 ? (
                <Tool>
                  <RoomCompositionPlanner
                    key={`${extensionRoomIds.join(",")}|${movesKey}`}
                    tableOnly
                    sealedRoomIds={extensionRoomIds}
                    entryCheckIn={entry.checkInDate ?? null}
                    entryCheckOut={p.newCheckOut}
                    entryAdults={entry.adultCount ?? entry.guestCount ?? null}
                    entryChildAges={entry.childAges ?? null}
                    entryId={entry.id}
                    lockCommercial={false}
                    initialCompositions={p.compositions.filter((c) => extensionRoomIds.includes(c.roomId))}
                    onChange={setTableComps}
                  />
                </Tool>
              ) : null}
              <PartDone ready={!preview.isFetching} why={preview.isFetching ? "Working out the price…" : null} onDone={() => goTo(3)} />
            </>
          ) : null}
        </div>

        {/* 3 · what the guest pays now */}
        <div className={`ext-part${at === 3 ? " open" : " waiting"}`} id="ext-part-3">
          <PartHead
            n={3}
            title="When the guest pays"
            state={at === 3 ? "open" : "waiting"}
            waitsFor="The price"
            help={
              <Help label="About paying for the extra nights">
                <p>Now, at the desk: the payment is recorded with how it was paid, and the stay is extended at once. The bill is kept as handed over; nothing is emailed.</p>
                <p>Send them a bill: the nights are held while the bill goes to the guest; the stay is extended once it is paid.</p>
                <p>At check-out: nothing is taken now. The extra nights go on the bill and are paid with the rest at check-out.</p>
              </Help>
            }
          />
          {at === 3 && p ? (
            <>
              <Choice options={PAY_AT} value={payAt} onChange={setPayAt} />
              {payAt ? (
              <div className="ext-sub" role="group" aria-label={PAY_AT_SUB[payAt]}>
              <div className="ext-sub-h">
                <span className="ext-sub-of">{PAY_AT.find(([v]) => v === payAt)?.[1]}</span>
                <span>{PAY_AT_SUB[payAt]}</span>
              </div>
              {payAt === "CHECKOUT" ? (
                <div className="ext-ledger" aria-live="polite">
                  <div>
                    <span>The stay with the extra nights</span>
                    <span className="money">{money(p.figures.projectedTotal, p.currency)}</span>
                  </div>
                  {p.figures.receivedSoFar > 0 ? (
                    <div>
                      <span>Already paid</span>
                      <span className="money">{money(p.figures.receivedSoFar, p.currency)}</span>
                    </div>
                  ) : null}
                  <div className="ext-due">
                    <span>To pay now</span>
                    <span className="money">Nothing</span>
                  </div>
                  <div className="ext-rest">
                    <span>The extra nights are paid at check-out, with the rest of the bill</span>
                  </div>
                </div>
              ) : null}
              {payAt === "NOW" || payAt === "BILL" ? (
              <>
              <Choice options={SHARES} value={share} onChange={setShare} />
              {share === "OTHER" ? (
                <div className="ext-row">
                  <input className="input ext-figure" inputMode="decimal" value={figure} placeholder={unit === "PERCENT" ? "e.g. 30" : "e.g. 10000"} onChange={(e) => setFigure(e.target.value)} autoFocus />
                  <Choice options={UNITS} value={unit} onChange={setUnit} />
                  {unit === "PERCENT" && Number(figure) > 100 ? <span className="stop-ink sm">At most 100%</span> : null}
                </div>
              ) : null}
              <div className="ext-ledger" aria-live="polite">
                <div>
                  <span>The stay with the extra nights</span>
                  <span className="money">{money(p.figures.projectedTotal, p.currency)}</span>
                </div>
                {p.figures.askAmount != null ? (
                  <div>
                    <span>Asked of it · {p.figures.askLabel ?? ""}</span>
                    <span className="money">{money(p.figures.askAmount, p.currency)}</span>
                  </div>
                ) : null}
                {p.figures.receivedSoFar > 0 ? (
                  <div>
                    <span>Already paid</span>
                    <span className="money">− {money(p.figures.receivedSoFar, p.currency)}</span>
                  </div>
                ) : null}
                <div className="ext-due">
                  <span>To pay now</span>
                  <span className="money">{due != null ? money(due, p.currency) : "—"}</span>
                </div>
                {p.figures.balanceAtCheckout != null ? (
                  <div className="ext-rest">
                    <span>Left for check-out</span>
                    <span className="money">{money(p.figures.balanceAtCheckout, p.currency)}</span>
                  </div>
                ) : null}
              </div>
              {askOk && due != null && due <= 0 ? (
                <p className="stop-ink sm" role="alert">
                  What the guest has already paid covers this share. Ask for a larger share, or let them pay at check-out.
                </p>
              ) : null}
              {payAt === "NOW" ? (
                <div className="ext-pay">
                  <div className="form3">
                    <div className="field">
                      <label>
                        How it was paid {!payMode ? <span className="stop-ink" aria-hidden style={{ fontWeight: 700, marginLeft: 2 }}>*</span> : null}
                      </label>
                      <select className="input" value={payMode} onChange={(e) => setPayMode(e.target.value as AdvancePaymentMode | "")}>
                        <option value="">choose…</option>
                        {ADVANCE_PAYMENT_MODES.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label>Amount received</label>
                      <span className="ext-now">{due != null ? money(due, p.currency) : "—"}</span>
                    </div>
                  </div>
                  <BankFields entry={payBank} method={payMode} />
                </div>
              ) : null}
              </>
              ) : null}
              </div>
              ) : null}
              <div className="ext-go">
                {notReady ? <span className="meta">{notReady}</span> : null}
                <Button className={ready ? "go" : undefined} state={ready ? "default" : "inert"} title={notReady ?? undefined} onClick={() => setConfirmOpen(true)}>
                  {goLabel}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </StepCard>

      <RoomMoveDialog
        legs={swapLegs}
        onClose={() => {
          // Whether it ran or not, ask the house again: the room may be free for our guest now.
          setSwapLegs(null);
          setChoice({});
          setOurMoves({});
          setRateChoice({});
          swapClosedAt.current = Date.now();
          setRechecking(true);
          // Every answer read before the swap is old now, the one about to be asked included.
          void qc.invalidateQueries({ queryKey: ["stay-extension-preview", entry.id] });
        }}
      />
      {askRates && p && crossMoves.length > 0 ? (
        <RateChoiceDialog
          moves={crossMoves}
          currency={p.currency}
          initial={rateChoice}
          gm={gm}
          typeNameOf={(roomId) => p.candidates.find((c) => c.roomId === roomId)?.roomTypeName ?? p.currentRooms.find((c) => c.roomId === roomId)?.roomTypeName ?? null}
          onClose={() => setAskRates(false)}
          onDone={(picked) => {
            setRateChoice(picked);
            setAskRates(false);
            goTo(2);
          }}
        />
      ) : null}
      {confirmOpen && p ? (
        <DsDialog
          open
          closeX
          onClose={() => setConfirmOpen(false)}
          busy={hold.isPending || now.isPending}
          title={goLabel}
          caseLines={[`Check-out ${fmtDate(p.currentCheckOut)} → ${fmtDate(p.newCheckOut)} · ${nightsWord(p.extraNights.length)}`]}
          footer={
            <>
              <Button kind="quiet" state={hold.isPending || now.isPending ? "inert" : "default"} onClick={() => setConfirmOpen(false)}>
                Not now
              </Button>
              {payAt === "BILL" ? (
                <Button className="go" state={hold.isPending ? "working" : "default"} workingLabel="Holding…" onClick={() => hold.mutate()}>
                  Hold the nights and make the bill
                </Button>
              ) : (
                <Button className="go" state={now.isPending ? "working" : "default"} workingLabel="Extending…" onClick={() => now.mutate()}>
                  {goLabel}
                </Button>
              )}
            </>
          }
        >
          {payAt === "NOW" ? (
            <ul className="ext-list">
              <li>
                <b>{money(due ?? 0, p.currency)}</b> is recorded as paid{payMode ? ` by ${ADVANCE_PAYMENT_MODES.find(([v]) => v === payMode)?.[1].toLowerCase() ?? payMode}` : ""}
                {payBank.needs(payMode) && payBank.bank ? ` · ${payBank.bank}` : ""}
                {payBank.needs(payMode) && payBank.journal ? ` · journal ${payBank.journal}` : ""}.
              </li>
              <li>The bill for it is kept as handed over at the desk. Nothing is emailed.</li>
              <li>The stay then ends on {fmtDate(p.newCheckOut)}, and the night audit charges the extra {p.extraNights.length === 1 ? "night" : "nights"}.</li>
            </ul>
          ) : payAt === "CHECKOUT" ? (
            <ul className="ext-list">
              <li>Nothing is taken now and no bill is made.</li>
              <li>The stay ends on {fmtDate(p.newCheckOut)}. The night audit charges the extra {p.extraNights.length === 1 ? "night" : "nights"}, and they are paid at check-out with the rest of the bill.</li>
            </ul>
          ) : (
          <ul className="ext-list">
            <li>
              The extra {p.extraNights.length === 1 ? "night is" : "nights are"} kept for this guest for {Math.round(p.holdTtlSeconds / 3600)} hours. Unpaid by then, {p.extraNights.length === 1 ? "it goes" : "they go"} back on sale.
            </li>
            <li>
              A bill for <b>{money(due ?? 0, p.currency)}</b> is made. Nothing is sent until you send it.
            </li>
            <li>The check-out moves only when the payment is in and you press Extend the stay.</li>
          </ul>
          )}
        </DsDialog>
      ) : null}
    </>
  );
}

/** A part's heading: its number (a tick once done), its title, and folded, its line with Edit. */
export function PartHead({
  n,
  title,
  state,
  summary,
  waitsFor,
  onEdit,
  help,
}: {
  n: number;
  title: string;
  state: "open" | "done" | "waiting";
  summary?: ReactNode;
  waitsFor?: string;
  onEdit?: () => void;
  help?: ReactNode;
}) {
  return (
    <div className={`ext-h ${state}`}>
      <span className="ext-n">{state === "done" ? <Icon name="check" /> : n}</span>
      <span className="ext-t">{title}</span>
      {help}
      {state === "done" && summary ? <span className="ext-sum">{summary}</span> : null}
      {state === "waiting" ? <span className="ext-wait">after {n - 1} · {waitsFor}</span> : null}
      {state === "done" && onEdit ? (
        <Button kind="quiet" compact className="ext-edit" onClick={onEdit}>
          Edit
        </Button>
      ) : null}
    </div>
  );
}

/** Done, at the part's bottom right: green once the part is complete, with what it waits for beside it. */
export function PartDone({ ready, why, onDone }: { ready: boolean; why: string | null; onDone: () => void }) {
  return (
    <div className="ext-go">
      {!ready && why ? <span className="meta">{why}</span> : ready ? <span className="ok-ink sm">All in — press Done to go on</span> : null}
      <Button className={ready ? "go" : undefined} state={ready ? "default" : "inert"} title={ready ? undefined : (why ?? undefined)} onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

/** What the house said about each room on the extra nights. */
function RoomsAnswer({ p }: { p: StayExtensionPreview }) {
  const [each, setEach] = useState(false);
  const free = p.currentRooms.filter((r) => r.extendableInPlace);
  const taken = p.currentRooms.filter((r) => !r.extendableInPlace);
  const nights = p.extraNights.map((d) => fmtDay(d)).join(", ");
  return (
    <div className="ext-rooms">
      {taken.length === 0 ? (
        <div className="notice paid" role="status">
          <span className="paid-mark">✓</span>
          <span>
            <b>{p.currentRooms.length === 1 ? `Room ${p.currentRooms[0]!.roomNumber} is free` : p.currentRooms.length === 2 ? "Both rooms are free" : `All ${p.currentRooms.length} rooms are free`}</b>
            <span className="rest"> on {nights} — the guests stay where they are.</span>
          </span>
        </div>
      ) : (
        <div className="notice ended" role="alert">
          <span className="ended-mark">!</span>
          <span>
            <b>
              {taken.length === 1 ? `Room ${taken[0]!.roomNumber} is taken` : `${taken.length} rooms are taken`}
            </b>
            <span className="rest">
              {" "}
              {taken.length === 1
                ? `on ${taken[0]!.perNight
                    .filter((n) => n.status !== "FREE")
                    .map((n) => `${fmtDay(n.date)}${n.claimedBy?.guestName ? ` by ${n.claimedBy.guestName}` : ""}`)
                    .join(", ")}`
                : `— Rooms ${taken.map((r) => r.roomNumber).join(", ")}, on ${Array.from(new Set(taken.flatMap((r) => r.perNight.filter((n) => n.status !== "FREE").map((n) => fmtDay(n.date))))).join(", ")}. Below, who holds each.`}
              {free.length ? ` · ${free.map((r) => `Room ${r.roomNumber}`).join(", ")} ${free.length === 1 ? "is" : "are"} free` : ""}
            </span>
          </span>
        </div>
      )}
      {p.moves.length > 0 ? (
        <p className="ext-moves">
          From {fmtDay(p.currentCheckOut)}: {p.moves.map((m) => `Room ${m.fromRoomNumber} → Room ${m.toRoomNumber}${m.crossType ? ` (another type, ${m.keepRate ? `keeps ${money(m.fromRate ?? 0, p.currency)} a night` : "at its own rate — or keep the guest's rate, asked on Done"})` : " (same type, same rate)"}`).join(", ")}
        </p>
      ) : null}
      {p.currentRooms.length > 1 ? (
        <>
          <Button kind="quiet" compact onClick={() => setEach((v) => !v)}>
            {each ? "Hide the rooms" : "See each room"}
          </Button>
          {each ? (
            <table className="table ext-roomtable">
              <tbody>
                {p.currentRooms.map((r) => (
                  <tr key={r.roomId}>
                    <td>
                      <b>Room {r.roomNumber}</b> <span className="meta">{r.roomTypeName}</span>
                    </td>
                    <td>
                      {r.perNight.map((n) => (
                        <Chip key={n.date} tone={n.status === "FREE" ? "success" : "danger"} title={n.claimedBy?.guestName ?? undefined}>
                          {fmtDay(n.date)} · {n.status === "FREE" ? "free" : "taken"}
                        </Chip>
                      ))}
                    </td>
                    <td className="meta">{r.extendableInPlace ? "stays" : "moves out"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

type TakenChoice = "OURS" | "THEIRS";
const TAKEN_CHOICES: ReadonlyArray<readonly [TakenChoice, string]> = [
  ["OURS", "Move our guest"],
  ["THEIRS", "Move their booking instead"],
];
type FreeRoom = StayExtensionPreview["candidates"][number];

/**
 * The guest's rooms another booking holds on the extra nights, each with its two ways (2026-11-25, the
 * swap): our guest moves to a free room from the old check-out (one room per extension), or their booking
 * moves to another room — the governed room move, run now, papers made again and held for the desk — so
 * our guest keeps the room.
 */
function TakenRooms({
  busy,
  ourGuest,
  p,
  rooms,
  choice,
  onChoice,
  ourMoves,
  onKeepOurs,
  onSwap,
}: {
  busy?: boolean;
  ourGuest: string;
  p: StayExtensionPreview;
  rooms: StayExtensionTakenRoom[];
  choice: Record<string, TakenChoice>;
  onChoice: (roomId: string, v: TakenChoice) => void;
  /** The moves kept for our guest: the taken room → the free room it moves to. */
  ourMoves: Record<string, string>;
  /** Keep our guest's move out of a room (or, with null, let it go). */
  onKeepOurs: (fromRoomId: string, toRoomId: string | null) => void;
  onSwap: (legs: RoomMoveLegInput[]) => void;
}) {
  const [swapTo, setSwapTo] = useState<Record<string, string>>({});
  /** The room picked for our guest on each card, before Move our guest keeps it. */
  const [oursTo, setOursTo] = useState<Record<string, string>>({});
  // Free for our guest on the extra nights: none of the guest's own rooms. "Same type" is judged against
  // the room the guest leaves, the rule the server prices the move by (another type at its own rate).
  const free: FreeRoom[] = p.candidates.filter((c) => c.selectable && !p.currentRooms.some((x) => x.roomId === c.roomId));
  const nightsWords = (nights: string[]) =>
    nights.length === 0 ? "" : nights.length === 1 ? fmtDay(nights[0]!) : `${fmtDay(nights[0]!)} – ${fmtDay(nights[nights.length - 1]!)}`;
  const stepWord = (stage: string) => STEP_NAMES[Number(stage.replace(/\D/g, "")) - 1] ?? stage;
  // Whether a holder's guest is in the hotel yet: until Check-in their booking only holds the room.
  const notArrived = (stage: string) => stage === "S3" || stage === "S4" || stage === "S5";
  // A booking holding two or more of these rooms can be moved out of all of them at once (2026-11-28,
  // the hotel's ENT-20261122-0003: one booking at Arrival held four of our guest's rooms for a night).
  type Holder = StayExtensionTakenRoom["heldBy"][number];
  const groups = useMemo(() => {
    const by = new Map<string, { holder: Holder; rooms: Array<{ room: StayExtensionTakenRoom; holder: Holder }> }>();
    for (const r of rooms) {
      for (const h of r.heldBy) {
        const g = by.get(h.entryId) ?? { holder: h, rooms: [] };
        g.rooms.push({ room: r, holder: h });
        by.set(h.entryId, g);
      }
    }
    return [...by.values()].filter((g) => g.rooms.length > 1 && g.rooms.every((x) => x.holder.swappable));
  }, [rooms]);
  const [groupTo, setGroupTo] = useState<Record<string, string>>({});
  return (
    <div className={`ext-taken${busy ? " busy" : ""}`} aria-busy={busy || undefined}>
      {rooms.length > 1 ? (
        <p className="meta ext-taken-lead">
          For each room: move our guest to a free room, or move their booking instead so our guest stays.
        </p>
      ) : null}
      {groups.map((g) => {
        const h = g.holder;
        const keyOf = (roomId: string) => `${h.entryId}|${roomId}`;
        const picked = g.rooms.map((x) => groupTo[keyOf(x.room.roomId)] ?? "");
        const allPicked = picked.every(Boolean);
        const nos = g.rooms.map((x) => x.room.roomNumber);
        const list = nos.length > 1 ? `${nos.slice(0, -1).join(", ")} and ${nos[nos.length - 1]}` : nos[0];
        return (
          <div key={h.entryId} className="ext-taken-room ext-taken-group">
            <div className="etr-head">
              <b>{h.guestName ?? h.entryId}</b>
              <span className="meta">{[h.partyName, h.entryId, `at ${stepWord(h.stage)}`].filter(Boolean).join(" · ")}</span>
              {notArrived(h.stage) ? <span className="etr-notin">not arrived yet</span> : null}
            </div>
            <p className="sm etr-group-lead">
              Their booking holds Rooms {list}. {notArrived(h.stage) ? "Nobody is in those rooms yet, so their" : "Their guests are in the hotel, but their"} booking can be moved out of all {g.rooms.length} at once, and our guest keeps every room.
            </p>
            <table className="etr-group-table">
              <tbody>
                {g.rooms.map((x, i) => {
                  const k = keyOf(x.room.roomId);
                  const others = new Set(picked.filter((v, j) => v && j !== i));
                  const open = x.holder.rooms.filter((c) => !others.has(c.roomId));
                  return (
                    <tr key={k}>
                      <td>
                        Room <b>{x.room.roomNumber}</b>
                        {x.holder.nightsInRoom.length ? <span className="meta"> · {nightsWords(x.holder.nightsInRoom)}</span> : null}
                      </td>
                      <td className="etr-group-arrow">→</td>
                      <td>
                        <select
                          className="input"
                          aria-label={`Move their booking out of Room ${x.room.roomNumber} to`}
                          value={groupTo[k] ?? ""}
                          onChange={(e) => setGroupTo((cur) => ({ ...cur, [k]: e.target.value }))}
                        >
                          <option value="">{open.length ? "Pick a room for them…" : "No other room is free"}</option>
                          {open.map((c) => (
                            <option key={c.roomId} value={c.roomId}>
                              Room {c.roomNumber} · {c.roomTypeName} · {c.sameType ? "same type, they keep their price" : "another type"}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="etr-swap">
              <Button
                className={allPicked && !busy ? "go" : undefined}
                state={allPicked && !busy ? "default" : "inert"}
                title={allPicked ? undefined : "Pick a room for each of their rooms first"}
                onClick={() => onSwap(g.rooms.map((x) => ({ entryId: h.entryId, fromRoomId: x.room.roomId, toRoomId: groupTo[keyOf(x.room.roomId)]! })))}
              >
                Move their booking out of {g.rooms.length} rooms
              </Button>
              {!allPicked ? (
                <span className="meta sm">
                  {picked.filter(Boolean).length} of {g.rooms.length} picked
                </span>
              ) : null}
              <Help label="About moving their booking">
                One room move for all of them: their booking keeps its step, its price is kept for the same type (another type asks), and its papers are made again and held for you to send. It stays moved even if this stay is not extended.
              </Help>
            </div>
          </div>
        );
      })}
      {rooms.map((r) => {
        const v = choice[r.roomId];
        return (
          <div key={r.roomId} className={`ext-taken-room${v ? " chosen" : ""}${ourMoves[r.roomId] ? " decided" : ""}`}>
            <div className="etr-head">
              <b>Room {r.roomNumber}</b>
              <span className="meta">{r.roomTypeName}</span>
              <span className="etr-taken">taken on {nightsWords(r.nights)}</span>
            </div>
            {r.heldBy.map((h) => (
              <div key={h.entryId} className="etr-who">
                by <b>{h.guestName ?? h.entryId}</b>
                {h.partyName ? <span> · {h.partyName}</span> : null}
                <span className="meta">
                  {" "}
                  · {h.entryId} · at {stepWord(h.stage)}
                  {h.checkIn && h.checkOut ? ` · ${fmtDay(h.checkIn)} → ${fmtDay(h.checkOut)}` : ""}
                </span>
                {notArrived(h.stage) ? <span className="etr-notin">not arrived yet</span> : null}
              </div>
            ))}
            <Choice options={TAKEN_CHOICES} value={v ?? null} onChange={(w) => onChoice(r.roomId, w)} />
            {v === "OURS"
              ? (() => {
                  const kept = !!ourMoves[r.roomId];
                  // A room already kept for another of our guest's rooms is not offered again.
                  const open = free.filter((c) => !Object.entries(ourMoves).some(([fromId, toId]) => toId === c.roomId && fromId !== r.roomId));
                  const typeId = p.currentRooms.find((x) => x.roomId === r.roomId)?.roomTypeId ?? null;
                  const same = open.filter((c) => c.roomTypeId === typeId);
                  const other = open.filter((c) => c.roomTypeId !== typeId);
                  const draft = kept ? ourMoves[r.roomId]! : (oursTo[r.roomId] ?? "");
                  const to = free.find((c) => c.roomId === draft) ?? null;
                  return (
                    <>
                      <Mover
                        tone="ours"
                        name={ourGuest}
                        who="our guest, in house"
                        what={`moves out of Room ${r.roomNumber} on ${fmtDay(p.currentCheckOut)}, and sleeps ${nightsWords(p.extraNights)} in`}
                        to={to}
                        stays={r.heldBy.map((h) => `${h.guestName ?? h.entryId} keeps Room ${r.roomNumber} from ${fmtDay(h.nightsInRoom[0] ?? r.nights[0] ?? "")}, as booked`)}
                      />
                      {kept ? (
                        <div className="etr-kept" role="status">
                          <span>
                            <Icon name="check" /> <b>Kept.</b> Our guest moves to Room {to?.roomNumber ?? "—"} on {fmtDay(p.currentCheckOut)}, once the stay is extended. Nothing moves before then.
                          </span>
                          <Button kind="secondary" compact onClick={() => onKeepOurs(r.roomId, null)}>
                            Change
                          </Button>
                        </div>
                      ) : (
                        <div className="etr-swap">
                          <div className="field etr-field">
                            <label>
                              Our guest moves from Room {r.roomNumber} to, from {fmtDay(p.currentCheckOut)}
                            </label>
                            <select className="input" value={draft} onChange={(e) => setOursTo((cur) => ({ ...cur, [r.roomId]: e.target.value }))}>
                              <option value="">{open.length ? "Pick a free room…" : "No room is free on every night"}</option>
                              {same.map((c) => (
                                <option key={c.roomId} value={c.roomId}>
                                  Room {c.roomNumber} · {c.roomTypeName} · same type, keeps its rate
                                </option>
                              ))}
                              {other.map((c) => (
                                <option key={c.roomId} value={c.roomId}>
                                  Room {c.roomNumber} · {c.roomTypeName} · another type
                                </option>
                              ))}
                            </select>
                            {open.length ? (
                              <p className="sm meta">
                                {open.length === 1 ? `Only Room ${open[0].roomNumber} is` : `${open.length} rooms are`} free on every night from{" "}
                                {fmtDay(p.extraNights[0] ?? p.currentCheckOut)} to {fmtDay(p.extraNights[p.extraNights.length - 1] ?? p.currentCheckOut)}
                                {other.length ? " · for another type you choose its rate on Done" : ""}.
                                {open.length < rooms.filter((x) => !ourMoves[x.roomId]).length ? " For the other rooms, move their booking instead." : ""}
                              </p>
                            ) : null}
                          </div>
                          <Button
                            className={draft && !busy ? "go" : undefined}
                            state={draft && !busy ? "default" : "inert"}
                            title={draft ? undefined : "Pick a room for our guest first"}
                            onClick={() => onKeepOurs(r.roomId, draft)}
                          >
                            {to ? `Move our guest to Room ${to.roomNumber}` : "Move our guest to…"}
                          </Button>
                          <Help label="About moving our guest">
                            Nothing moves now: the move is part of the extension. Once the stay is extended, our guest moves to this room on {fmtDay(p.currentCheckOut)}, the morning the stay would have ended. The same type keeps its rate; for another type you choose on Done whether it keeps the guest&rsquo;s rate or takes its own.
                          </Help>
                        </div>
                      )}
                      {open.length === 0 && !kept ? (
                        <p className="stop-ink sm">
                          {free.length === 0 ? "No room is free for those nights." : "Every free room is already kept for another of our guest's rooms."} Move their booking instead, or try another check-out.
                        </p>
                      ) : null}
                    </>
                  );
                })()
              : null}
            {v === "THEIRS"
              ? r.heldBy.map((h) => {
                  const key = `${r.roomId}|${h.entryId}`;
                  const to = swapTo[key] ?? "";
                  const same = h.rooms.filter((x) => x.sameType);
                  const other = h.rooms.filter((x) => !x.sameType);
                  return !h.swappable ? (
                    <p key={key} className="stop-ink sm" role="alert">
                      {h.guestName ?? h.entryId}: {h.why}
                    </p>
                  ) : (
                    <div key={key} className="etr-theirs">
                      <Mover
                        tone="theirs"
                        name={h.guestName ?? h.entryId}
                        who={`another guest · ${[h.partyName, h.entryId, `at ${stepWord(h.stage)}`].filter(Boolean).join(" · ")}`}
                        what={`moves out of Room ${r.roomNumber}${h.nightsInRoom.length ? ` for ${nightsWords(h.nightsInRoom)}` : ""} into`}
                        to={h.rooms.find((x) => x.roomId === to) ?? null}
                        stays={[`${ourGuest} (our guest) keeps Room ${r.roomNumber} for ${nightsWords(p.extraNights)}`]}
                      />
                    <div className="etr-swap">
                      <div className="field etr-field">
                        <label>
                          {h.guestName ?? h.entryId}&rsquo;s booking moves out of Room {r.roomNumber}
                          {h.nightsInRoom.length ? ` for ${nightsWords(h.nightsInRoom)}` : ""} to
                        </label>
                        <select className="input" value={to} onChange={(e) => setSwapTo((cur) => ({ ...cur, [key]: e.target.value }))}>
                          <option value="">Pick a room for them…</option>
                          {same.map((x) => (
                            <option key={x.roomId} value={x.roomId}>
                              Room {x.roomNumber} · {x.roomTypeName} · same type, they keep their price
                            </option>
                          ))}
                          {other.map((x) => (
                            <option key={x.roomId} value={x.roomId}>
                              Room {x.roomNumber} · {x.roomTypeName} · another type
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        className={to && !busy ? "go" : undefined}
                        state={to && !busy ? "default" : "inert"}
                        title={to ? undefined : "Pick a room for them first"}
                        onClick={() => onSwap([{ entryId: h.entryId, fromRoomId: r.roomId, toRoomId: to }])}
                      >
                        Move their booking
                      </Button>
                      <Help label="About moving their booking">
                        Their booking is moved now, through the usual room move: it keeps its step, its price is kept for the same type (another type asks), and its papers are made again and held for you to send. It stays moved even if this stay is not extended.
                      </Help>
                    </div>
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}

/** Who moves, in large type with a coloured edge: our guest (blue) or another guest's booking (amber). */
function Mover({
  tone,
  name,
  who,
  what,
  to,
  stays,
}: {
  tone: "ours" | "theirs";
  name: string;
  who: string;
  what: string;
  to: { roomNumber: string; roomTypeName: string | null } | null;
  stays: string[];
}) {
  return (
    <div className={`etr-mover ${tone}`} role="status">
      <span className="etr-mover-tag">{tone === "ours" ? "Our guest moves" : "Their booking moves"}</span>
      <span className="etr-mover-name">{name}</span>
      <span className="etr-mover-who">{who}</span>
      <span className="etr-mover-what">
        {what}{" "}
        {to ? (
          <b>
            Room {to.roomNumber}
            {to.roomTypeName ? ` · ${to.roomTypeName}` : ""}
          </b>
        ) : (
          <span className="etr-mover-pick">the room you pick below</span>
        )}
      </span>
      {stays.map((x) => (
        <span key={x} className="etr-mover-stays">
          <Icon name="check" /> {x}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ once the nights are held */

type StepState = "done" | "now" | "later";

function ExtSteps({ steps }: { steps: Array<{ key: string; label: string; state: StepState; note?: ReactNode }> }) {
  return (
    <ol className="money-steps ext-steps">
      {steps.map((s, i) => (
        <li key={s.key} className={`money-step ${s.state === "now" ? "now" : s.state === "done" ? "done" : ""}`} aria-current={s.state === "now" ? "step" : undefined}>
          <span className="ms-n">{s.state === "done" ? <Icon name="check" /> : i + 1}</span>
          <span className="ext-step-label">{s.label}</span>
          {s.note ? <span className="meta ext-step-note">{s.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function OpenExtension({ entry, req, fom, onChanged }: { entry: EntryDetail; req: StayExtensionRow; fom: boolean; onChanged?: () => void }) {
  const { session } = useSession();
  const { tz } = useHotelClock(30_000);
  const invalidate = useInvalidate(entry.id, onChanged);
  const ip = req.interimPayment;
  const currency = req.pricingPreview?.figures?.currency ?? "BTN";
  const nights = new Set(req.extraNights.map((n) => n.date)).size;
  const moves = req.pricingPreview?.moves ?? [];
  const pricing = req.pricingPreview?.pricing ?? null;

  const invoice = ip?.invoice ?? null;
  const sent = !!invoice?.dispatchedAt && invoice.state !== "SUPERSEDED";
  // Nothing asked now (2026-11-25): no bill, the extra nights paid at check-out.
  const atCheckout = !ip && req.pricingPreview?.payAt === "CHECKOUT";
  const paid = req.state === "PAID" || atCheckout;
  const replyAsked = useReplyAsked(entry.id, "INTERIM_INVOICE");
  const comms = useCommunications(entry.id);
  const comm = latestDispatched(comms.data?.items, "INTERIM_INVOICE", req.requestedAt);
  const answered = !!comm && replySettled(comm);
  const answerNeeded = replyAsked && sent && !answered && !paid;
  const payable = sent && !answerNeeded && !paid;

  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);

  const cd = !paid ? countdownTo(req.holdExpiresAt) : null;
  // The nights hold for a day; the chip turns amber in its last three hours and red in its last hour.
  const leftMs = new Date(req.holdExpiresAt).getTime() - Date.now();
  const holdTone = leftMs < 3_600_000 ? "danger" : leftMs < 3 * 3_600_000 ? "warning" : "quiet";

  const commit = useMutation({
    mutationFn: () => commitStayExtension(session!, entry.id, req.id),
    onSuccess: (out) => {
      setExtendOpen(false);
      const o = out.outcome;
      if (o.walk.blocked) toast.warning(`The extension is recorded, but the booking stopped at ${o.walk.reachedStage}: ${o.walk.blocked.message}`, { duration: 14000 });
      else toast.success(`The stay now ends on ${fmtDate(o.extension?.newCheckOutDate ?? req.newCheckOutDate)}. The papers were made again and kept for you to send.`, { duration: 10000 });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The stay could not be extended"),
  });
  const cancel = useMutation({
    mutationFn: () => withdrawStayExtension(session!, entry.id, req.id),
    onSuccess: () => {
      setCancelOpen(false);
      toast.info("The extension is cancelled — the extra nights are back on sale");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't cancel the extension"),
  });

  const steps = atCheckout
    ? [
        { key: "held", label: "Nights held", state: "done" as StepState },
        { key: "extend", label: "Stay extended", state: "now" as StepState },
      ]
    : [
    { key: "bill", label: "Bill made", state: "done" as StepState },
    { key: "sent", label: "Sent to the guest", state: (sent ? "done" : "now") as StepState },
    ...(replyAsked ? [{ key: "answer", label: "Their answer", state: (answered || paid ? "done" : sent ? "now" : "later") as StepState }] : []),
    { key: "paid", label: "Paid", state: (paid ? "done" : payable ? "now" : "later") as StepState },
    { key: "extend", label: "Stay extended", state: (paid ? "now" : "later") as StepState },
  ];

  const target: InvoiceSummary | null = invoice
    ? (entry.folio?.invoices?.find((i) => i.id === invoice.id) ?? {
        id: invoice.id,
        entryId: entry.id,
        folioId: entry.folio?.id ?? "",
        invoiceType: "INTERIM",
        state: invoice.state,
        dispatchedAt: invoice.dispatchedAt,
        dispatchedTo: invoice.dispatchedTo ?? null,
        createdAt: req.requestedAt,
      })
    : null;

  return (
    <>
      <StepCard
        title={`Extending to ${fmtDate(req.newCheckOutDate)}`}
       
        status={atCheckout ? "Paid at check-out — ready to extend" : paid ? "Paid — ready to extend" : sent ? "Bill sent — waiting for the payment" : "Bill made — not sent yet"}
        right={
          cd ? (
            <Chip tone={holdTone} title="The extra nights are kept for this guest until then; unpaid, they go back on sale">
              Nights held · {cd.text === "due now" ? "ending now" : cd.text.replace(/^in /, "")} left
            </Chip>
          ) : null
        }
      >
        <div className="ext-facts">
          <span>
            Check-out <b>{fmtDate(req.priorCheckOutDate)}</b> → <b>{fmtDate(req.newCheckOutDate)}</b> · {plural(nights, "more night")}
          </span>
          <span>
            {moves.length
              ? `From ${fmtDay(req.priorCheckOutDate)}: ${moves.map((m) => `Room ${m.fromRoomNumber} → Room ${m.toRoomNumber}`).join(", ")}`
              : "The guests stay in their rooms"}
          </span>
          {pricing ? (
            <span>
              The stay {pricing.priorStayTotal != null ? `${money(pricing.priorStayTotal, currency)} → ` : ""}
              <b>{money(pricing.projectedStayTotal, currency)}</b>
            </span>
          ) : null}
          {!paid ? <span className="meta">Held until {fmtDateTime(req.holdExpiresAt, tz)}</span> : null}
        </div>

        <ExtSteps steps={steps} />

        {/* The thing to do now */}
        {!sent && ip ? (
          <div className="ext-now-box">
            <div className="ext-billrow">
              <span>
                <b>Mid-stay bill</b> <span className="mono">{invoice?.id}</span> · <b>{money(ip.dueNow ?? 0, currency)}</b> to pay now
              </span>
              <NotSentChip />
            </div>
            <div className="actbar">
              <Button className="go" onClick={() => setSendOpen(true)} state={target ? "default" : "inert"}>
                Send the bill
              </Button>
              {invoice ? (
                <Button kind="secondary" onClick={() => setPaper({ kind: "invoice", id: invoice.id, label: "Mid-stay bill for the extra nights" })}>
                  Preview
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {answerNeeded ? (
          <div className="ext-now-box">
            <AnswerLine entryId={entry.id} type="INTERIM_INVOICE" sinceIso={req.requestedAt} what="the bill" tz={tz} prominent />
          </div>
        ) : null}

        {payable && ip ? <PaymentBox entry={entry} req={req} tz={tz} onDone={invalidate} onLater={() => setLaterOpen(true)} /> : null}

        {paid ? (
          <div className="ext-now-box">
            {atCheckout ? (
              <div className="notice" role="status">
                <span>
                  <b>Nothing is taken now</b>
                  <span className="rest"> — the extra nights are paid at check-out. Extend the stay to move the check-out.</span>
                </span>
              </div>
            ) : (
              <div className="notice paid" role="status">
                <span className="paid-mark">✓</span>
                <span>
                  <b>{money(ip?.receivedAgainstAsk ?? 0, currency)} received</b>
                  <span className="rest"> — the extra nights are paid. Extend the stay to move the check-out.</span>
                </span>
              </div>
            )}
            <div className="actbar ext-go">
              {!fom ? <span className="meta">The FOM extends the stay</span> : null}
              <Button className={fom ? "go" : undefined} state={fom ? "default" : "inert"} onClick={() => setExtendOpen(true)}>
                Extend the stay
              </Button>
            </div>
          </div>
        ) : null}

        {sent && !paid ? (
          <p className="meta ext-sentline">
            Sent{invoice?.dispatchedTo ? ` to ${invoice.dispatchedTo}` : ""} {fmtDateTime(invoice?.dispatchedAt, tz)} ·{" "}
            <Button kind="quiet" compact onClick={() => invoice && setPaper({ kind: "invoice", id: invoice.id, label: "Mid-stay bill for the extra nights" })}>
              See the bill
            </Button>
          </p>
        ) : null}

        {fom ? (
          <div className="ext-cancel">
            <Button kind="quiet" compact onClick={() => setCancelOpen(true)}>
              Cancel the extension
            </Button>
          </div>
        ) : null}
      </StepCard>

      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      {sendOpen && target ? (
        <InvoiceSendDialog
          entry={entry}
          target={target}
          onClose={() => setSendOpen(false)}
          onSent={() => {
            setSendOpen(false);
            invalidate();
          }}
        />
      ) : null}
      {laterOpen && ip ? <PayLaterDialog requestId={ip.id} tz={tz} onClose={() => setLaterOpen(false)} onDone={invalidate} /> : null}

      <DsDialog
        open={extendOpen}
        closeX
        onClose={() => setExtendOpen(false)}
        busy={commit.isPending}
        title="Extend the stay"
        caseLines={[`Check-out ${fmtDate(req.priorCheckOutDate)} → ${fmtDate(req.newCheckOutDate)}`]}
        footer={
          <>
            <Button kind="quiet" state={commit.isPending ? "inert" : "default"} onClick={() => setExtendOpen(false)}>
              Not now
            </Button>
            <Button className="go" state={commit.isPending ? "working" : "default"} workingLabel="Extending…" onClick={() => commit.mutate()}>
              Extend the stay
            </Button>
          </>
        }
      >
        <ul className="ext-list">
          <li>The booking now ends on {fmtDate(req.newCheckOutDate)}, and the night audit charges the extra {nights === 1 ? "night" : "nights"}.</li>
          <li>{moves.length ? `On ${fmtDay(req.priorCheckOutDate)} the guest moves: ${moves.map((m) => `Room ${m.fromRoomNumber} → Room ${m.toRoomNumber}`).join(", ")} — hand over the new key that day.` : "Nobody moves rooms."}</li>
          <li>The quotation and the confirmation voucher are made again for the new dates and kept for you to send. Nothing goes to the guest now.</li>
        </ul>
      </DsDialog>

      <DsDialog
        open={cancelOpen}
        closeX
        onClose={() => setCancelOpen(false)}
        busy={cancel.isPending}
        title="Cancel the extension?"
        footer={
          <>
            <Button kind="quiet" state={cancel.isPending ? "inert" : "default"} onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
            <Button kind="danger" state={cancel.isPending ? "working" : "default"} workingLabel="Cancelling…" onClick={() => cancel.mutate()}>
              Cancel the extension
            </Button>
          </>
        }
      >
        <p>
          The extra nights go back on sale and the bill for them is withdrawn. The check-out stays {fmtDate(req.priorCheckOutDate)}.
          {paid || (ip?.receivedAgainstAsk ?? 0) > 0 ? " Money already taken stays on the guest's bill, for check-out." : ""}
        </p>
      </DsDialog>
    </>
  );
}

function PaymentBox({ entry, req, tz, onDone, onLater }: { entry: EntryDetail; req: StayExtensionRow; tz: string; onDone: () => void; onLater: () => void }) {
  const { session } = useSession();
  const ip = req.interimPayment!;
  const currency = req.pricingPreview?.figures?.currency ?? "BTN";
  const partly = ip.receivedAgainstAsk > 0;
  const [amount, setAmount] = useState(partly ? "" : String(ip.dueNow ?? ""));
  const [mode, setMode] = useState<AdvancePaymentMode | "">("");
  const bank = useBankEntry();
  const overdue = !!ip.dueBy && new Date(ip.dueBy).getTime() < Date.now();
  const pay = useMutation({
    mutationFn: () => recordInterimPayment(session!, ip.id, { amount: Number(amount), paymentMethod: mode || undefined, ...bank.body(mode) }),
    onSuccess: (out) => {
      toast.success(out.paidInFull ? `Paid — ${money(out.receivedAgainstAsk, currency)} received. Now extend the stay.` : `${money(Number(amount), currency)} received · ${money(out.remaining, currency)} still to come`);
      setAmount("");
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The payment could not be recorded"),
  });
  const ready = Number(amount) > 0 && !!mode && !bank.missing(mode);
  void entry;
  return (
    <div className="ext-now-box answer-due balance-due">
      <span className="due-head">Take the payment for the extra nights</span>
      <span className="balance-figure">
        <strong>{money(ip.dueNow ?? 0, currency)}</strong> to pay now
        {partly ? <span className="sm"> · {money(ip.receivedAgainstAsk, currency)} of it received</span> : null}
      </span>
      {ip.dueBy ? (
        <span className={overdue ? "stop-ink sm" : "sm"}>
          {ip.promiseKind === "BY_DATE" ? "The guest said they will pay by" : "Due by"} {fmtDateTime(ip.dueBy, tz)}
          {overdue ? " — it is overdue" : " · a reminder is set"}
          {ip.promiseNote ? ` · “${ip.promiseNote}”` : ""}
        </span>
      ) : null}
      <div className="form3 balance-pay">
        <div className="field">
          <label>Amount received</label>
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label>How it was paid</label>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as AdvancePaymentMode | "")}>
            <option value="">choose…</option>
            {ADVANCE_PAYMENT_MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="wide">
          <BankFields entry={bank} method={mode} />
        </div>
      </div>
      <div className="actbar">
        <Button
          className={ready ? "go" : undefined}
          state={pay.isPending ? "working" : ready ? "default" : "inert"}
          workingLabel="Recording…"
          title={ready ? undefined : !mode ? "choose how it was paid" : (bank.missing(mode) ?? "type the amount")}
          onClick={() => pay.mutate()}
        >
          Record the payment
        </Button>
        <Button kind="secondary" onClick={onLater}>
          They&rsquo;ll pay later
        </Button>
      </div>
    </div>
  );
}

function PayLaterDialog({ requestId, tz, onClose, onDone }: { requestId: string; tz: string; onClose: () => void; onDone: () => void }) {
  const { session } = useSession();
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => recordInterimPromise(session!, requestId, { kind: "BY_DATE", promisedBy: when ? new Date(when).toISOString() : undefined, note: note.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(`Noted — a reminder is set for ${fmtDateTime(r.promisedBy, tz)}`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't note it"),
  });
  return (
    <DsDialog
      open
      closeX
      onClose={onClose}
      busy={save.isPending}
      title="When will they pay?"
      footer={
        <>
          <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button className={when ? "go" : undefined} state={save.isPending ? "working" : when ? "default" : "inert"} workingLabel="Saving…" onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <p className="sm">The reminder moves to this time and the bill prints it. It must be before the nights&rsquo; hold ends.</p>
      <div className="field">
        <label>They will pay by</label>
        <DateTimeInput value={when} onChange={(e) => setWhen(e.target.value)} />
      </div>
      <div className="field">
        <label>What they said · optional</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. a transfer after lunch" />
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ earlier ones */

const ENDED_WORDS: Record<string, { label: string; tone: "success" | "quiet" | "danger" }> = {
  COMMITTED: { label: "Extended", tone: "success" },
  WITHDRAWN: { label: "Cancelled", tone: "quiet" },
  LAPSED: { label: "Not paid in time", tone: "danger" },
};

function EarlierExtensions({ rows }: { rows: StayExtensionRow[] }) {
  return (
    <StepCard title="Earlier extensions" quiet>
      <table className="table">
        <tbody>
          {rows.map((r) => {
            const w = ENDED_WORDS[r.state] ?? { label: r.state, tone: "quiet" as const };
            return (
              <tr key={r.id}>
                <td>
                  <Chip tone={w.tone}>{w.label}</Chip>
                </td>
                <td>
                  Check-out {fmtDate(r.priorCheckOutDate)} → {fmtDate(r.newCheckOutDate)}
                </td>
                <td className="meta">{fmtDate((r.committedAt ?? r.closedAt ?? r.requestedAt).slice(0, 10))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </StepCard>
  );
}

/**
 * The rate of each room our guest moves into that is another type (2026-11-25, operator): keep the
 * rate the guest has, or the new room's own rate — every figure the server's, nothing chosen until the
 * desk chooses. Keeping a rate under the new type's minimum is the GM's or an admin's.
 */
function RateChoiceDialog({
  moves,
  currency,
  initial,
  gm,
  typeNameOf,
  onClose,
  onDone,
}: {
  moves: StayExtensionPreview["moves"];
  currency: string | undefined;
  initial: Record<string, "KEEP" | "OWN">;
  gm: boolean;
  typeNameOf: (roomId: string) => string | null;
  onClose: () => void;
  onDone: (picked: Record<string, "KEEP" | "OWN">) => void;
}) {
  const [picked, setPicked] = useState<Record<string, "KEEP" | "OWN">>(() => {
    const out: Record<string, "KEEP" | "OWN"> = {};
    for (const m of moves) if (initial[m.fromRoomId]) out[m.fromRoomId] = initial[m.fromRoomId]!;
    return out;
  });
  const shutKeep = (m: StayExtensionPreview["moves"][number]) => m.fromRate == null || (m.keepFloor != null && !gm);
  const missing = moves.find((m) => !picked[m.fromRoomId] || (picked[m.fromRoomId] === "KEEP" && shutKeep(m)));
  return (
    <DsDialog
      open
      closeX
      onClose={onClose}
      title={moves.length === 1 ? "The rate for the room that changes type" : "The rate for each room that changes type"}
      footer={
        <>
          <span className="meta">{missing ? `Choose a rate for Room ${missing.toRoomNumber}` : "All chosen"}</span>
          <Button
            className={missing ? undefined : "go"}
            state={missing ? "inert" : "default"}
            title={missing ? `Choose a rate for Room ${missing.toRoomNumber}` : undefined}
            onClick={() => onDone(picked)}
          >
            Go on
          </Button>
        </>
      }
    >
      <p className="meta">Our guest moves into another room type. Keep the rate they have now, or charge the new room&rsquo;s own rate. A night, before service charge and GST.</p>
      <div className="rate-choices">
        {moves.map((m) => {
          const toType = typeNameOf(m.toRoomId);
          const fromType = typeNameOf(m.fromRoomId);
          const keepShut = shutKeep(m);
          return (
            <div key={m.fromRoomId} className="rate-choice">
              <div className="rc-head">
                <b>Room {m.fromRoomNumber}</b>
                {fromType ? <span className="meta"> {fromType}</span> : null}
                <span aria-hidden> → </span>
                <b>Room {m.toRoomNumber}</b>
                {toType ? <span className="meta"> {toType}</span> : null}
              </div>
              <div className="rc-options" role="radiogroup" aria-label={`Rate for Room ${m.toRoomNumber}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={picked[m.fromRoomId] === "KEEP"}
                  className={`rc-option${picked[m.fromRoomId] === "KEEP" ? " on" : ""}`}
                  disabled={keepShut}
                  onClick={() => setPicked((cur) => ({ ...cur, [m.fromRoomId]: "KEEP" }))}
                >
                  <span className="rc-dot" aria-hidden />
                  <span className="rc-words">
                    <b>Keep {m.fromRate != null ? money(m.fromRate, currency) : "their rate"}</b>
                    <span>the rate the guest has now</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={picked[m.fromRoomId] === "OWN"}
                  className={`rc-option${picked[m.fromRoomId] === "OWN" ? " on" : ""}`}
                  onClick={() => setPicked((cur) => ({ ...cur, [m.fromRoomId]: "OWN" }))}
                >
                  <span className="rc-dot" aria-hidden />
                  <span className="rc-words">
                    <b>{m.toRate != null ? money(m.toRate, currency) : "Its own rate"}</b>
                    <span>{toType ? `the ${toType}'s own rate` : "the room's own rate"}</span>
                  </span>
                </button>
              </div>
              {m.keepFloor != null ? (
                <p className={keepShut ? "stop-ink sm" : "warn-ink sm"} role={keepShut ? "alert" : undefined}>
                  Keeping {money(m.fromRate ?? 0, currency)} is below the {toType ?? "room type"}&rsquo;s minimum of {money(m.keepFloor, currency)}
                  {keepShut ? " — only the GM or an admin may keep it." : " — kept on your authority."}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </DsDialog>
  );
}
