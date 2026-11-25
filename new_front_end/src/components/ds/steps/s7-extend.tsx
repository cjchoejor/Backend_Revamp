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
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  listStayExtensions,
  previewStayExtension,
  recordInterimPayment,
  recordInterimPromise,
  requestStayExtension,
  withdrawStayExtension,
  type StayExtensionPreview,
  type StayExtensionRow,
} from "@/lib/api/stay-money";
import { fmtDate, fmtDateTime, fmtDay, money, plural } from "@/lib/ds/format";
import { countdownTo } from "@/lib/desk/timers";
import type { EntryDetail, InvoiceSummary } from "@/types/api";
import { DateInput, DateTimeInput } from "@/components/ds/date-input";
import { Help } from "@/components/ds/help";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
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
  return () => {
    for (const key of ["stay-extensions", "interim-payments", "entry", "entry-communications", "billing-summary", "entry-timers", "entry-trace", "room-plan-history", "stay-extension-preview"]) {
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
  const [moveTo, setMoveTo] = useState("");
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
    setMoveTo("");
    setCheckedOut(null);
  }, [currentOut]);
  const extra = currentOut && newOut ? nightsBetween(currentOut, newOut) : 0;
  const ask = share === "HALF" ? { mode: "PERCENT" as const, value: 50 } : share === "WHOLE" ? { mode: "PERCENT" as const, value: 100 } : { mode: unit, value: Number(figure) };
  const askOk = ask.value > 0 && (ask.mode !== "PERCENT" || ask.value <= 100);

  // What is asked of the house is debounced, so typing a figure asks once.
  const params = useMemo(
    () => ({ newOut: checkedOut ?? "", moveTo, askMode: ask.mode, askValue: askOk ? ask.value : undefined, comps: ratesOpen ? tableComps : [] }),
    [checkedOut, moveTo, ask.mode, ask.value, askOk, ratesOpen, tableComps],
  );
  const [asked, setAsked] = useState(params);
  useEffect(() => {
    const t = setTimeout(() => setAsked(params), 400);
    return () => clearTimeout(t);
  }, [params]);

  const replaceRoomIdFor = (p: StayExtensionPreview | undefined) => p?.currentRooms.find((r) => !r.extendableInPlace)?.roomId;
  const [kept, setKept] = useState<StayExtensionPreview | null>(null);
  const preview = useQuery({
    queryKey: ["stay-extension-preview", entry.id, asked],
    enabled: !!session && !!asked.newOut && !!currentOut && nightsBetween(currentOut, asked.newOut) >= 1,
    placeholderData: (prev) => prev,
    queryFn: () =>
      previewStayExtension(session!, entry.id, {
        newCheckOutDate: asked.newOut,
        perNight: asked.moveTo && kept ? kept.extraNights.map((date) => ({ date, roomId: asked.moveTo })) : undefined,
        replaceRoomId: asked.moveTo ? replaceRoomIdFor(kept ?? undefined) : undefined,
        roomCompositions: asked.comps.length ? asked.comps : undefined,
        askMode: asked.askMode,
        askValue: asked.askValue,
      }),
  });
  const stale = checkedOut !== newOut;
  const p = !stale && preview.data && ymd(preview.data.newCheckOut) === newOut ? preview.data : null;
  const checking = !stale && preview.isFetching && !p;
  const check = () => {
    setMoveTo("");
    // Pressed again on the same date, the house is asked afresh.
    if (checkedOut === newOut) void preview.refetch();
    else setCheckedOut(newOut);
  };
  useEffect(() => {
    if (preview.data) setKept(preview.data);
  }, [preview.data, setKept]);

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
        perNight: moveTo && p ? p.extraNights.map((date) => ({ date, roomId: moveTo })) : undefined,
        replaceRoomId: moveTo ? replaceRoomIdFor(p ?? undefined) : undefined,
        roomCompositions: ratesOpen && tableComps.length ? tableComps : undefined,
        askMode: ask.mode,
        askValue: ask.value,
      }),
    onSuccess: (out) => {
      setConfirmOpen(false);
      toast.success(`The extra ${out.request.extraNights.length === 1 ? "night is" : "nights are"} held until ${fmtDateTime(out.request.holdExpiresAt)}. Next: send the bill for ${money(out.interim.dueNow ?? 0)}.`, { duration: 9000 });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The extension was refused"),
  });

  const replaced = p?.currentRooms.find((r) => !r.extendableInPlace) ?? null;
  const alternatives = useMemo(() => (p ? p.candidates.filter((c) => c.selectable && !p.currentRooms.some((r) => r.roomId === c.roomId)) : []), [p]);
  const sameType = alternatives.filter((c) => c.sameType);
  const otherType = alternatives.filter((c) => !c.sameType);
  const overlapOpen = !!p?.guestOverlap && !p.guestOverlap.acknowledged;
  const roomsOk = !!p && !p.blockedReason && !overlapOpen;
  const due = p?.figures.dueNow ?? null;
  const ready = roomsOk && askOk && (due ?? 0) > 0 && !preview.isFetching;
  const notReady = !p
    ? extra < 1
      ? "Pick a check-out after the current one"
      : "Asking the house…"
    : p.blockedReason
      ? "A room is not free — see above"
      : overlapOpen
        ? "Say whether both bookings are meant"
        : !askOk
          ? "Say what the guest pays now"
          : (due ?? 0) <= 0
            ? "Nothing would be due now — ask for more"
            : preview.isFetching
              ? "Working out the figures…"
              : null;
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
  const part1Ready = roomsOk && !preview.isFetching;
  const part1Why = extra < 1 ? "Pick a check-out after the current one" : stale ? "Check the rooms first" : !p ? (preview.isError ? "The house could not be asked" : "Asking the house…") : p.blockedReason ? (replaced ? "Pick the room the guest moves to" : "A room is not free") : overlapOpen ? "Say whether both bookings are meant" : preview.isFetching ? "Asking the house…" : null;
  const roomsLine = !p
    ? ""
    : p.moves.length
      ? p.moves.map((m) => `Room ${m.fromRoomNumber} → Room ${m.toRoomNumber} from ${fmtDay(p.currentCheckOut)}`).join(", ")
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
                    onChange={(e) => {
                      setNewOut(e.target.value);
                      setMoveTo("");
                    }}
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
              ) : preview.isError && !p ? (
                <p className="stop-ink sm" role="alert">{preview.error instanceof ApiError ? preview.error.message : "The house could not be asked — try again"}</p>
              ) : !p ? (
                <p className="meta">Checking the rooms…</p>
              ) : (
                <RoomsAnswer p={p} />
              )}

              {p && replaced ? (
                <div className="ext-move">
                  <div className="field">
                    <label>Move the guest from Room {replaced.roomNumber} to, from {fmtDay(p.currentCheckOut)}</label>
                    <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                      <option value="">Pick a free room…</option>
                      {sameType.length ? (
                        <optgroup label="Same type — keeps its rate">
                          {sameType.map((c) => (
                            <option key={c.roomId} value={c.roomId}>
                              Room {c.roomNumber} · {c.roomTypeName}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {otherType.length ? (
                        <optgroup label="Another type — at its own rate">
                          {otherType.map((c) => (
                            <option key={c.roomId} value={c.roomId}>
                              Room {c.roomNumber} · {c.roomTypeName}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </select>
                  </div>
                  {alternatives.length === 0 ? <p className="stop-ink sm">No room is free for those nights. Try another check-out.</p> : null}
                </div>
              ) : null}
              {p?.blockedReason && !replaced ? (
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
              <PartDone ready={part1Ready} why={part1Why} onDone={() => goTo(2)} />
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
                <Help label="About the rates">The same room keeps the rate the guest has; another room type starts at its own rate. Change them here when the guest agreed another figure.</Help>
              </div>
              {ratesOpen && extensionRoomIds.length > 0 ? (
                <Tool>
                  <RoomCompositionPlanner
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
            title="What the guest pays now"
            state={at === 3 ? "open" : "waiting"}
            waitsFor="The price"
            help={<Help label="About paying first">The stay is extended once this payment is in. The rest is paid at check-out.</Help>}
          />
          {at === 3 && p ? (
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
                  What the guest has already paid covers this share. Ask for a larger share — the stay is extended only once a payment for it comes in.
                </p>
              ) : null}
              <div className="ext-go">
                {notReady ? <span className="meta">{notReady}</span> : null}
                <Button className={ready ? "go" : undefined} state={ready ? "default" : "inert"} title={notReady ?? undefined} onClick={() => setConfirmOpen(true)}>
                  Hold the nights and make the bill
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </StepCard>

      {confirmOpen && p ? (
        <DsDialog
          open
          closeX
          onClose={() => setConfirmOpen(false)}
          busy={hold.isPending}
          title="Hold the nights and make the bill"
          caseLines={[`Check-out ${fmtDate(p.currentCheckOut)} → ${fmtDate(p.newCheckOut)} · ${nightsWord(p.extraNights.length)}`]}
          footer={
            <>
              <Button kind="quiet" state={hold.isPending ? "inert" : "default"} onClick={() => setConfirmOpen(false)}>
                Not now
              </Button>
              <Button className="go" state={hold.isPending ? "working" : "default"} workingLabel="Holding…" onClick={() => hold.mutate()}>
                Hold the nights and make the bill
              </Button>
            </>
          }
        >
          <ul className="ext-list">
            <li>
              The extra {p.extraNights.length === 1 ? "night is" : "nights are"} kept for this guest for {Math.round(p.holdTtlSeconds / 3600)} hours. Unpaid by then, {p.extraNights.length === 1 ? "it goes" : "they go"} back on sale.
            </li>
            <li>
              A bill for <b>{money(due ?? 0, p.currency)}</b> is made. Nothing is sent until you send it.
            </li>
            <li>The check-out moves only when the payment is in and you press Extend the stay.</li>
          </ul>
        </DsDialog>
      ) : null}
    </>
  );
}

/** A part's heading: its number (a tick once done), its title, and folded, its line with Edit. */
function PartHead({
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
function PartDone({ ready, why, onDone }: { ready: boolean; why: string | null; onDone: () => void }) {
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
              {taken.map((r) => `Room ${r.roomNumber}`).join(", ")} {taken.length === 1 ? "is" : "are"} taken
            </b>
            <span className="rest">
              {" "}
              on{" "}
              {taken
                .flatMap((r) => r.perNight.filter((n) => n.status !== "FREE").map((n) => `${fmtDay(n.date)}${n.claimedBy?.guestName ? ` by ${n.claimedBy.guestName}` : ""}`))
                .join(", ")}
              {free.length ? ` · ${free.map((r) => `Room ${r.roomNumber}`).join(", ")} ${free.length === 1 ? "is" : "are"} free` : ""}
            </span>
          </span>
        </div>
      )}
      {p.moves.length > 0 ? (
        <p className="ext-moves">
          From {fmtDay(p.currentCheckOut)}: {p.moves.map((m) => `Room ${m.fromRoomNumber} → Room ${m.toRoomNumber}${m.crossType ? " (another type, at its own rate)" : " (same type, same rate)"}`).join(", ")}
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
  const paid = req.state === "PAID";
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

  const steps = [
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
       
        status={paid ? "Paid — ready to extend" : sent ? "Bill sent — waiting for the payment" : "Bill made — not sent yet"}
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
            <div className="notice paid" role="status">
              <span className="paid-mark">✓</span>
              <span>
                <b>{money(ip?.receivedAgainstAsk ?? 0, currency)} received</b>
                <span className="rest"> — the extra nights are paid. Extend the stay to move the check-out.</span>
              </span>
            </div>
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
