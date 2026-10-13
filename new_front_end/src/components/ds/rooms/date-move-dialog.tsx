"use client";

/**
 * Move a booking to other dates, from the house chart (2026-10-13, operator: "right now we can
 * switch the rooms for the same date — can it also switch to different dates").
 *
 * A bar dragged sideways opens this dialog. It asks the server what the move would do
 * (`POST /date-moves/preview` — nothing written): the dates before and after, each room on its new
 * nights, what each price choice costs per room, and anything that refuses it. Then it runs the move
 * (`POST /date-moves`) and says where the booking ended, with the new paper to send or not. Every
 * figure and every refusal is the server's.
 *
 * Rulings the same day: before check-in only; the whole stay shifts, and the booking's rooms move as
 * a block (the grabbed room lands on the row dropped on, the others keep their spacing); the price
 * choice is per room — kept, or priced at the new dates with the guest's agreement typed in; the
 * FOM from Set up on (at Negotiation the change of configuration's own rule). What happens and why
 * sits behind the "?" — only what needs reading stays on screen.
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
import { executeDateMove, previewDateMove, type DateMoveInput, type DateMovePreview, type DateMoveResult } from "@/lib/api/room-moves";
import { fmtDate, fmtRange, money } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

type PriceMode = "KEEP" | "NEW_DATES";

const stepWord = (stage: string | null | undefined) => (stage ? STEP_NAMES[stepNoOfStage(stage as never) - 1] ?? stage : "—");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function shiftWords(days: number): string {
  if (days === 0) return "the same day";
  return `${plural(Math.abs(days), "day")} ${days > 0 ? "later" : "earlier"}`;
}

function ResultView({ result, tz }: { result: DateMoveResult; tz?: string }) {
  if (result.route === "NEGOTIATION") {
    const o = result.outcome;
    return (
      <div className="rmv-result">
        <p className={`rmv-status ${o.applied ? "ok" : "warn"}`} role="status">
          {o.applied
            ? `Done — the stay is now ${fmtRange(o.newDates.checkInDate, o.newDates.checkOutDate)}. Price it again at the table.`
            : "Sent to the FOM — the change waits for their approval; nothing has moved yet."}
        </p>
        {o.applied && o.quotationsInvalidated.length ? (
          <p className="sm">The quotation on file ({o.quotationsInvalidated.map((q) => q.referenceNumber).join(", ")}) is retired — save the table at Negotiation to price the new dates.</p>
        ) : null}
        <Link className="btn btn-secondary compact" href={`/bookings/${result.entryId}?step=2`}>
          Open the booking at Negotiation
        </Link>
      </div>
    );
  }
  const o = result.outcome;
  const blocked = o.walk.blocked;
  return (
    <div className="rmv-result">
      <p className={`rmv-status ${blocked ? "stop" : "ok"}`} role="status">
        {blocked
          ? `Stopped part-way at ${blocked.atStep.toLowerCase().replace(/_/g, " ")} — ${blocked.message}. Finish it on the booking.`
          : `Done — the stay is now ${fmtRange(o.dateShift?.newCheckInDate ?? null, o.dateShift?.newCheckOutDate ?? null)}, at ${stepWord(o.walk.reachedStage)}${
              o.dateShift?.arrivalOpensOn ? `; Arrival opens on ${fmtDate(o.dateShift.arrivalOpensOn)}` : ""
            }.`}
      </p>
      {o.pricing.newTotal != null ? (
        <div className="sm">
          Price: <b>{money(o.pricing.priorTotal, o.pricing.currency ?? "BTN")}</b> → <b>{money(o.pricing.newTotal, o.pricing.currency ?? "BTN")}</b>
        </div>
      ) : null}
      {o.heldDocuments.length ? <HeldPapersCard entryId={result.entryId} onlyIds={o.heldDocuments.map((h) => h.id)} tz={tz} title="Send the new paper, or not" /> : null}
      <Link className="mono sm" href={`/bookings/${result.entryId}`}>
        Open {result.entryId}
      </Link>
    </div>
  );
}

/** One room's line: where it goes, its new nights, and its price choice with what each costs. */
function RoomLine({
  room,
  currency,
  walk,
  mode,
  onMode,
}: {
  room: DateMovePreview["rooms"][number];
  currency: string;
  walk: boolean;
  mode: PriceMode;
  onMode: (m: PriceMode) => void;
}) {
  const same = room.keepTotal != null && room.newDatesTotal != null && room.keepTotal === room.newDatesTotal;
  return (
    <div className="dmv-room">
      <div className="where">
        <b>
          Room {room.roomNumber}
          {room.toRoomNumber ? ` → ${room.toRoomNumber}` : ""}
        </b>
        <span className="nights">{room.nightsLabel}</span>
        {room.toRoomNumber && !room.sameType ? <span className="other">another room type</span> : null}
        {walk && same ? <span className="nights">· the same either way</span> : null}
      </div>
      {walk ? (
        <div className="dmv-choice" role="radiogroup" aria-label={`Price for Room ${room.roomNumber}`}>
          <button type="button" role="radio" aria-checked={mode === "KEEP"} className={mode === "KEEP" ? "on" : undefined} onClick={() => onMode("KEEP")}>
            Keep the price
            <b>{room.keepTotal != null ? money(room.keepTotal, currency) : "—"}</b>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "NEW_DATES"}
            className={mode === "NEW_DATES" ? "on" : undefined}
            onClick={() => onMode("NEW_DATES")}
          >
            At the new dates
            <b>{room.newDatesTotal != null ? money(room.newDatesTotal, currency) : "—"}</b>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function DateMoveDialog({ move, onClose, tz }: { move: (DateMoveInput & { label: string }) | null; onClose: () => void; tz?: string }) {
  const { session } = useSession();
  const qc = useQueryClient();
  /** The price choice per room, by the room as it is now; a room not named keeps its price. */
  const [modes, setModes] = useState<Record<string, PriceMode>>({});
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<DateMovePreview | null>(null);
  const [result, setResult] = useState<DateMoveResult | null>(null);

  const anyNewDates = Object.values(modes).includes("NEW_DATES");
  const body = move
    ? {
        entryId: move.entryId,
        fromRoomId: move.fromRoomId,
        toRoomId: move.toRoomId ?? null,
        roomMap: move.roomMap ?? null,
        newCheckInDate: move.newCheckInDate,
        priceMode: "KEEP" as const,
        priceModes: modes,
        guestAgreedNote: anyNewDates ? note.trim() || null : null,
      }
    : null;
  const previewMut = useMutation({
    mutationFn: () => previewDateMove(session!, { ...body!, reason: reason.trim() || null }),
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
    setNote("");
    setReason("");
    setPreview(null);
    setResult(null);
  }, [move]);

  const run = useMutation({
    mutationFn: () => executeDateMove(session!, { ...body!, reason: reason.trim() }),
    onSuccess: (r) => {
      setResult(r);
      for (const k of [["room-chart"], ["desk-bookings"], ["entries"]]) void qc.invalidateQueries({ queryKey: k });
      for (const k of [["entry", r.entryId], ["held-documents", r.entryId], ["entry-trace", r.entryId], ["billing-summary", r.entryId]]) {
        void qc.invalidateQueries({ queryKey: k });
      }
      if (r.route === "NEGOTIATION") toast[r.outcome.applied ? "success" : "info"](r.outcome.applied ? "The dates moved" : "Sent to the FOM for approval");
      else toast[r.outcome.walk.blocked ? "warning" : "success"](r.outcome.walk.blocked ? "The move stopped part-way" : "The booking moved to the new dates");
    },
    onError: (e) => toastRefusal(e, "The booking could not be moved"),
  });

  if (!move) return null;
  const busy = previewMut.isPending || run.isPending;
  const walk = preview?.route === "WALK";
  const blockedBy = !preview
    ? "Checking the move…"
    : !preview.authority.ok
      ? `${preview.authority.why} — you are signed in as ${preview.authority.actorLevel === "L1" ? "the front desk" : preview.authority.actorLevel}`
      : preview.refusals.length > 0
        ? "Something above refuses the move"
        : walk && anyNewDates && !note.trim()
          ? "Type what the guest agreed to"
          : !reason.trim()
            ? "Say why the dates are moving"
            : null;
  const p = preview?.price;
  const currency = p?.currency ?? "BTN";
  const setMode = (roomId: string, m: PriceMode) => setModes((cur) => ({ ...cur, [roomId]: m }));

  return (
    <DsDialog
      open
      onClose={() => !busy && onClose()}
      width={760}
      busy={busy}
      title={result ? "Moved to other dates" : `Move ${move.label} to other dates`}
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
              {run.isPending ? "Moving…" : preview?.authority.waitsForApproval ? "Send for the FOM's approval" : "Move the dates"}
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
                  <Help label="What happens when the dates move">
                    <div className="dmv-help">
                      {preview.authority.ok ? <p>{preview.authority.why}.</p> : null}
                      <ol>
                        {preview.path.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ol>
                      {preview.papers.length ? <p>Papers: {preview.papers.join(" · ")}</p> : null}
                      {walk ? (
                        <p>
                          Each room can keep the price agreed, or be priced at the rates for the new nights — that needs the guest&apos;s agreement, typed in. The
                          figures per room include tax, before any booking discount.
                        </p>
                      ) : p?.note ? (
                        <p>{p.note}</p>
                      ) : null}
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
              {preview.rooms.length ? (
                <div className="dmv-rooms">
                  {preview.rooms.map((r) => (
                    <RoomLine key={r.roomId} room={r} currency={currency} walk={walk} mode={modes[r.roomId] ?? "KEEP"} onMode={(m) => setMode(r.roomId, m)} />
                  ))}
                </div>
              ) : null}
              {walk && anyNewDates ? (
                <label className="field">
                  <span>What the guest agreed to</span>
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. agreed on the phone to the rate for those nights" />
                </label>
              ) : null}
              {p && p.after != null ? (
                <div className="dmv-total">
                  Price <b>{money(p.before, currency)}</b>
                  <span className="muted">→</span>
                  <b className={p.delta === 0 ? "ok-ink" : "warn-ink"}>{money(p.after, currency)}</b>
                  {p.delta ? (
                    <span className={p.delta > 0 ? "warn-ink" : "ok-ink"}>
                      ({p.delta > 0 ? "+" : "−"}
                      {money(Math.abs(p.delta), currency)})
                    </span>
                  ) : null}
                </div>
              ) : walk && p?.note ? (
                <div className="sm warn-ink">{p.note}</div>
              ) : null}
              {preview.refusals.length === 0 && preview.notes.length ? (
                <ul className="rmv-follow">
                  {preview.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <label className="field">
            <span>Why the dates are moving</span>
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the guest's flight moved to Thursday" />
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
