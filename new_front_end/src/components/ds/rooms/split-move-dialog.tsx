"use client";

/**
 * Move some of a booking's rooms to other dates, as a booking of their own (2026-10-14, operator:
 * "move one singular room to another date range without selecting the other rooms with it ... ask
 * the user if they want the change as a different entry under the same inquiry or a new inquiry").
 *
 * A drag that takes some, not all, of a booking's rooms to other dates opens this dialog. It asks
 * the server what the split would do (`POST /date-moves/split/preview` — nothing written): the rooms
 * that leave with their guests and new nights, what each price choice costs, the rooms that stay,
 * the nights the two bookings would share, and anything that refuses it. The desk then chooses where
 * the rooms go — a new booking on the same enquiry (walked to this booking's step) or a new enquiry
 * (started at Inquiry, filled in) — and runs it (`POST /date-moves/split`). Every figure and every
 * refusal is the server's; what happens step by step sits behind the "?".
 */
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { DsDialog, toastRefusal } from "@/components/ds/steps/kit";
import { HeldPapersCard } from "@/components/ds/workspace/held-papers";
import { useSession } from "@/hooks/use-session";
import {
  executeRoomSplit,
  previewRoomSplit,
  type RoomSplitInput,
  type RoomSplitPreview,
  type RoomSplitResult,
  type SplitTarget,
} from "@/lib/api/room-moves";
import { fmtRange, money } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

type PriceMode = "KEEP" | "NEW_DATES";
export type SplitMove = RoomSplitInput & { label: string; roomWords: string };

const stepWord = (stage: string | null | undefined) => (stage ? STEP_NAMES[stepNoOfStage(stage as never) - 1] ?? stage : "—");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const stepNo = (stage: string) => stepNoOfStage(stage as never);

function shiftWords(days: number): string {
  if (days === 0) return "the same day";
  return `${plural(Math.abs(days), "day")} ${days > 0 ? "later" : "earlier"}`;
}

function ResultView({ result, tz }: { result: RoomSplitResult; tz?: string }) {
  const s = result.source;
  const c = result.created;
  const sourceBlocked = s.walk?.walk.blocked ?? null;
  return (
    <div className="rmv-result">
      <div className="spl-part">
        <p className={`rmv-status ${sourceBlocked ? "stop" : "ok"}`} role="status">
          {s.route === "NEGOTIATION"
            ? "This booking keeps its other rooms — price it again at the table."
            : sourceBlocked
              ? `This booking stopped part-way at ${sourceBlocked.atStep.toLowerCase().replace(/_/g, " ")} — ${sourceBlocked.message}. Finish it on the booking.`
              : `This booking keeps its other rooms, back at ${stepWord(s.walk?.walk.reachedStage)}.`}
        </p>
        {s.walk?.heldDocuments.length ? <HeldPapersCard entryId={s.entryId} onlyIds={s.walk.heldDocuments.map((h) => h.id)} tz={tz} title="This booking's new paper — send it, or not" /> : null}
        <Link className="mono sm" href={`/bookings/${s.entryId}`}>
          Open {s.entryId}
        </Link>
      </div>
      {c ? (
        <div className="spl-part">
          <p className={`rmv-status ${c.blocked ? "warn" : "ok"}`} role="status">
            {c.newInquiry
              ? `A new enquiry, ${c.inquiryId}: its booking ${c.entryId} starts at Inquiry, filled in — ${fmtRange(c.checkInDate, c.checkOutDate)}.`
              : c.blocked
                ? `The new booking ${c.entryId} stopped at ${stepWord(c.reachedStage)} — ${c.blocked.message}. Finish it on the booking.`
                : `The new booking ${c.entryId} is at ${stepWord(c.reachedStage)} — ${fmtRange(c.checkInDate, c.checkOutDate)}.`}
          </p>
          {c.notes.length ? (
            <ul className="rmv-follow">
              {c.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {c.heldDocuments.length ? <HeldPapersCard entryId={c.entryId} onlyIds={c.heldDocuments.map((h) => h.id)} tz={tz} title="The new booking's paper — send it, or not" /> : null}
          <Link className="btn btn-secondary compact" href={`/bookings/${c.entryId}${c.newInquiry ? "?step=1" : ""}`}>
            Open the new booking
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** One room that leaves: where it goes, its guests and new nights, and its price choice. */
function RoomLine({
  room,
  currency,
  mode,
  onMode,
}: {
  room: RoomSplitPreview["moving"][number];
  currency: string;
  mode: PriceMode;
  onMode: (m: PriceMode) => void;
}) {
  const same = room.keepTotal != null && room.newDatesTotal != null && room.keepTotal === room.newDatesTotal;
  return (
    <div className="dmv-room">
      <div className="where">
        <b>
          Room {room.roomNumber}
          {room.toRoomNumber !== room.roomNumber ? ` → ${room.toRoomNumber}` : ""}
        </b>
        <span className="nights">{room.nightsLabel}</span>
        <span className="nights">· {room.guests}</span>
        {!room.sameType ? <span className="other">another room type</span> : null}
        {same ? <span className="nights">· the same either way</span> : null}
      </div>
      <div className="dmv-choice" role="radiogroup" aria-label={`Price for Room ${room.roomNumber}`}>
        <button type="button" role="radio" aria-checked={mode === "KEEP"} className={mode === "KEEP" ? "on" : undefined} onClick={() => onMode("KEEP")}>
          Keep the price
          <b>{room.keepTotal != null ? money(room.keepTotal, currency) : "—"}</b>
        </button>
        <button type="button" role="radio" aria-checked={mode === "NEW_DATES"} className={mode === "NEW_DATES" ? "on" : undefined} onClick={() => onMode("NEW_DATES")}>
          At the new dates
          <b>{room.newDatesTotal != null ? money(room.newDatesTotal, currency) : "—"}</b>
        </button>
      </div>
    </div>
  );
}

export function SplitMoveDialog({ move, onClose, tz }: { move: SplitMove | null; onClose: () => void; tz?: string }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [modes, setModes] = useState<Record<string, PriceMode>>({});
  const [target, setTarget] = useState<SplitTarget | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<RoomSplitPreview | null>(null);
  const [result, setResult] = useState<RoomSplitResult | null>(null);

  const anyNewDates = Object.values(modes).includes("NEW_DATES");
  const body = move
    ? {
        entryId: move.entryId,
        fromRoomId: move.fromRoomId,
        roomMap: move.roomMap,
        newCheckInDate: move.newCheckInDate,
        priceMode: "KEEP" as const,
        priceModes: modes,
        guestAgreedNote: anyNewDates ? note.trim() || null : null,
      }
    : null;
  const previewMut = useMutation({
    mutationFn: () => previewRoomSplit(session!, { ...body!, reason: reason.trim() || null }),
    onSuccess: setPreview,
    onError: (e) => toastRefusal(e, "The move could not be checked"),
  });
  const modesKey = JSON.stringify(modes);
  useEffect(() => {
    if (!move || !session || result) return;
    previewMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [move, session, modesKey]);
  useEffect(() => {
    if (move) return;
    setModes({});
    setTarget(null);
    setNote("");
    setReason("");
    setPreview(null);
    setResult(null);
  }, [move]);

  const run = useMutation({
    mutationFn: () => executeRoomSplit(session!, { ...body!, target: target!, reason: reason.trim() }),
    onSuccess: (r) => {
      setResult(r);
      for (const k of [["room-chart"], ["desk-bookings"], ["entries"]]) void qc.invalidateQueries({ queryKey: k });
      for (const id of [r.source.entryId, r.created?.entryId].filter(Boolean) as string[]) {
        for (const k of [["entry", id], ["held-documents", id], ["entry-trace", id], ["billing-summary", id]]) void qc.invalidateQueries({ queryKey: k });
      }
      const stopped = r.source.walk?.walk.blocked || r.created?.blocked;
      toast[stopped ? "warning" : "success"](
        r.created?.newInquiry ? "A new enquiry is open for the room" : stopped ? "The move stopped part-way" : "The room has its own booking now",
      );
    },
    onError: (e) => toastRefusal(e, "The rooms could not be moved"),
  });

  if (!move) return null;
  const busy = previewMut.isPending || run.isPending;
  const targetRefusals = preview && target ? preview.targets[target].refusals : [];
  const blockedBy = !preview
    ? "Checking the move…"
    : !preview.authority.ok
      ? preview.authority.why
      : preview.refusals.length > 0
        ? "Something above refuses the move"
        : !target
          ? "Choose where the room goes"
          : targetRefusals.length > 0
            ? targetRefusals[0]
            : anyNewDates && !note.trim()
              ? "Type what the guest agreed to"
              : !reason.trim()
                ? "Say why the room is moving"
                : null;
  const p = preview?.price;
  const currency = p?.currency ?? "BTN";
  const setMode = (roomId: string, m: PriceMode) => setModes((cur) => ({ ...cur, [roomId]: m }));
  const roomsWord = preview && preview.moving.length > 1 ? "the rooms" : "the room";

  return (
    <DsDialog
      open
      onClose={() => !busy && onClose()}
      width={780}
      busy={busy}
      title={result ? `${move.roomWords} moved to other dates` : `Move ${move.roomWords} to other dates`}
      footer={
        result ? (
          <Button kind="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button kind="quiet" onClick={onClose} state={busy ? "inert" : "default"}>
              Leave it as it is
            </Button>
            <Button kind="primary" state={blockedBy || busy ? "inert" : "default"} onClick={() => !blockedBy && run.mutate()}>
              {run.isPending ? "Moving…" : target === "NEW_ENQUIRY" ? "Open a new enquiry" : "Make the new booking"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ResultView result={result} tz={tz} />
      ) : (
        <div className="rmv">
          {!preview ? <p className="sm muted">Checking the move with the house…</p> : null}
          {preview && !preview.authority.ok ? (
            <p className="rmv-auth stop" role="alert">
              {preview.authority.why} — you are signed in as {preview.authority.actorLevel === "L1" ? "the front desk" : preview.authority.actorLevel}
            </p>
          ) : null}
          {preview && preview.refusals.length > 0 ? (
            <ul className="rmv-refusals rmv-moveref" role="alert">
              {preview.refusals.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          {preview ? (
            <div className="rmv-leg">
              <div className="rmv-who">
                <b>{preview.guestName ?? preview.entryId}</b>
                <span className="mono sm">{preview.entryId}</span>
                <span className="chip-step">{preview.stageWord}</span>
                <span className="dmv-what">
                  What happens
                  <Help label="What happens when the room moves">
                    <div className="dmv-help">
                      {preview.authority.ok ? <p>{preview.authority.why}.</p> : null}
                      <p>
                        <b>A new booking on this enquiry</b>
                      </p>
                      <ol>
                        {preview.targets.SAME_ENQUIRY.path.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ol>
                      <p>
                        <b>A new enquiry</b>
                      </p>
                      <ol>
                        {preview.targets.NEW_ENQUIRY.path.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ol>
                      {preview.targets.SAME_ENQUIRY.papers.length ? <p>Papers: {preview.targets.SAME_ENQUIRY.papers.join(" · ")}</p> : null}
                      <p>
                        Each room can keep the price agreed, or be priced at the rates for the new nights — that needs the guest&apos;s agreement, typed in. The figures per
                        room include tax, before any booking discount.
                      </p>
                    </div>
                  </Help>
                </span>
              </div>
              <div className="rmv-rooms">
                <span className="rmv-room">{fmtRange(preview.from.checkInDate, preview.from.checkOutDate)}</span>
                <span className="rmv-arrow">→</span>
                <span className="rmv-room to">{fmtRange(preview.to.checkInDate, preview.to.checkOutDate)}</span>
                <span className="rmv-type">
                  {plural(preview.to.nights, "night")} · {shiftWords(preview.shiftDays)}
                </span>
              </div>
              <div className="dmv-rooms">
                {preview.moving.map((r) => (
                  <RoomLine key={r.roomId} room={r} currency={currency} mode={modes[r.roomId] ?? "KEEP"} onMode={(m) => setMode(r.roomId, m)} />
                ))}
              </div>
              {preview.staying.length ? (
                <p className="sm spl-stays">
                  Stays on {preview.entryId}: {preview.staying.map((s) => `Room ${s.roomNumber} · ${s.guests}`).join("  ·  ")}
                </p>
              ) : null}
              {preview.overlap ? (
                <p className="sm warn-ink" role="status" style={{ margin: 0, fontWeight: 700 }}>
                  {preview.overlap.words}
                </p>
              ) : null}
              {anyNewDates ? (
                <label className="field">
                  <span>What the guest agreed to</span>
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. agreed on the phone to the rate for those nights" />
                </label>
              ) : null}
              <div className="spl-where" role="radiogroup" aria-label={`Where ${roomsWord} go`}>
                <span className="spl-q">Make it</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={target === "SAME_ENQUIRY"}
                  className={target === "SAME_ENQUIRY" ? "on" : undefined}
                  onClick={() => setTarget("SAME_ENQUIRY")}
                >
                  A new booking on this enquiry
                  <small>
                    {preview.inquiryId} · {stepNo(preview.stage) <= 2 ? "waits at Negotiation, priced" : `taken to ${preview.stageWord}`}
                  </small>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={target === "NEW_ENQUIRY"}
                  className={target === "NEW_ENQUIRY" ? "on" : undefined}
                  onClick={() => setTarget("NEW_ENQUIRY")}
                >
                  A new enquiry
                  <small>its own number · starts at Inquiry, filled in</small>
                </button>
              </div>
              {target && targetRefusals.length ? (
                <ul className="rmv-refusals rmv-moveref" role="alert">
                  {targetRefusals.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
              {p && (p.originalAfter != null || p.newBooking != null) ? (
                <div className="dmv-total">
                  {p.originalAfter != null ? (
                    <>
                      This booking <b>{money(p.originalBefore, currency)}</b>
                      <span className="muted">→</span>
                      <b>{money(p.originalAfter, currency)}</b>
                    </>
                  ) : null}
                  {p.newBooking != null ? (
                    <>
                      <span className="muted">·</span> the new booking <b>{money(p.newBooking, currency)}</b>
                    </>
                  ) : null}
                </div>
              ) : null}
              {p?.newBookingNote ? <div className="sm warn-ink">{p.newBookingNote}</div> : null}
              {preview.refusals.length === 0 && preview.notes.filter((n) => !preview.overlap || !n.startsWith(preview.overlap.words)).length ? (
                <ul className="rmv-follow">
                  {preview.notes
                    .filter((n) => !preview.overlap || !n.startsWith(preview.overlap.words))
                    .map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <label className="field">
            <span>Why {roomsWord} {preview && preview.moving.length > 1 ? "are" : "is"} moving</span>
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. this guest arrives two days later" />
          </label>
          {blockedBy && preview && preview.authority.ok ? (
            <p className="stop-ink sm" style={{ margin: 0, fontWeight: 700 }}>
              {blockedBy}
            </p>
          ) : null}
        </div>
      )}
    </DsDialog>
  );
}
