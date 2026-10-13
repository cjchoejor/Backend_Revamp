"use client";

/**
 * Move a booking to other dates, from the house chart (2026-10-13, operator: "right now we can
 * switch the rooms for the same date — can it also switch to different dates").
 *
 * A bar dragged sideways opens this dialog. It asks the server what the move would do
 * (`POST /date-moves/preview` — nothing written): the dates before and after, each room on its new
 * nights, the price before and after, the steps the booking walks, the papers it produces, and
 * anything that refuses it. Then it runs the move (`POST /date-moves`) and says where the booking
 * ended, with the new paper to send or not. Every figure and every refusal is the server's.
 *
 * Rulings the same day: before check-in only; the guest keeps the price agreed unless the stay is
 * priced at the new dates with the guest's agreement typed in; the whole stay shifts; the FOM from
 * Set up on (at Negotiation the change of configuration's own rule).
 */
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { DsDialog, toastRefusal } from "@/components/ds/steps/kit";
import { HeldPapersCard } from "@/components/ds/workspace/held-papers";
import { useSession } from "@/hooks/use-session";
import { executeDateMove, previewDateMove, type DateMoveInput, type DateMovePreview, type DateMoveResult } from "@/lib/api/room-moves";
import { fmtDate, fmtRange, money } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

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

export function DateMoveDialog({ move, onClose, tz }: { move: (DateMoveInput & { label: string }) | null; onClose: () => void; tz?: string }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [priceMode, setPriceMode] = useState<"KEEP" | "NEW_DATES">("KEEP");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<DateMovePreview | null>(null);
  const [result, setResult] = useState<DateMoveResult | null>(null);

  const body = move
    ? {
        entryId: move.entryId,
        fromRoomId: move.fromRoomId,
        toRoomId: move.toRoomId ?? null,
        newCheckInDate: move.newCheckInDate,
        priceMode,
        guestAgreedNote: priceMode === "NEW_DATES" ? note.trim() || null : null,
      }
    : null;
  const previewMut = useMutation({
    mutationFn: () => previewDateMove(session!, { ...body!, reason: reason.trim() || null }),
    onSuccess: setPreview,
    onError: (e) => toastRefusal(e, "The move could not be checked"),
  });
  useEffect(() => {
    if (!move || !session || result) return;
    setPreview(null);
    previewMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [move, session, priceMode]);
  useEffect(() => {
    if (move) return;
    setPriceMode("KEEP");
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
        : walk && priceMode === "NEW_DATES" && !note.trim()
          ? "Type what the guest agreed to"
          : !reason.trim()
            ? "Say why the dates are moving"
            : null;
  const p = preview?.price;

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
          {preview ? (
            <p className={`rmv-auth ${preview.authority.ok ? "ok" : "stop"}`} role={preview.authority.ok ? undefined : "alert"}>
              {preview.authority.ok ? preview.authority.why : `${preview.authority.why} — you are signed in as ${preview.authority.actorLevel === "L1" ? "the front desk" : preview.authority.actorLevel}`}
            </p>
          ) : (
            <p className="sm muted">Checking the move with the house…</p>
          )}
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
                <div className="sm">
                  Rooms on the new nights:{" "}
                  {preview.rooms.map((r, i) => (
                    <span key={r.roomId}>
                      {i ? " · " : ""}
                      <b>Room {r.roomNumber}</b> {r.nightsLabel}
                    </span>
                  ))}
                </div>
              ) : null}
              {p ? (
                <div className="sm">
                  Price:{" "}
                  {p.after == null ? (
                    <span className="sm muted">{p.note ?? "The new quotation states the price"}</span>
                  ) : (
                    <span className="rmv-price">
                      <b>{money(p.before, p.currency ?? "BTN")}</b>
                      <span className="muted"> → </span>
                      <b className={p.delta === 0 ? "ok-ink" : "warn-ink"}>{money(p.after, p.currency ?? "BTN")}</b>
                      {p.delta ? <span className={p.delta > 0 ? "warn-ink" : "ok-ink"}> ({p.delta > 0 ? "+" : "−"}{money(Math.abs(p.delta), p.currency ?? "BTN")})</span> : null}
                      {p.note ? <span className="sm muted"> · {p.note}</span> : null}
                    </span>
                  )}
                </div>
              ) : null}
              {walk ? (
                <div className="rmv-pricemode" role="radiogroup" aria-label="How the stay is priced">
                  <label className={priceMode === "KEEP" ? "on" : undefined}>
                    <input type="radio" checked={priceMode === "KEEP"} onChange={() => setPriceMode("KEEP")} /> Keep the price agreed
                  </label>
                  <label className={priceMode === "NEW_DATES" ? "on" : undefined}>
                    <input type="radio" checked={priceMode === "NEW_DATES"} onChange={() => setPriceMode("NEW_DATES")} /> Price at the new dates
                  </label>
                  {priceMode === "NEW_DATES" ? (
                    <label className="field">
                      <span>What the guest agreed to</span>
                      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. agreed on the phone to the rate for those nights" />
                    </label>
                  ) : null}
                </div>
              ) : null}
              {preview.refusals.length === 0 ? (
                <>
                  <ol className="rmv-path">
                    {preview.path.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ol>
                  {preview.papers.length ? (
                    <div className="sm">
                      <b>Papers:</b> {preview.papers.join(" · ")}
                    </div>
                  ) : null}
                  {preview.notes.length ? (
                    <ul className="rmv-follow">
                      {preview.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          <label className="field">
            <span>Why the dates are moving</span>
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the guest's flight moved to Thursday" />
          </label>
          {blockedBy && preview && preview.authority.ok ? <p className="stop-ink sm" style={{ margin: 0, fontWeight: 700 }}>{blockedBy}</p> : null}
        </div>
      )}
    </DsDialog>
  );
}
