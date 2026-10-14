"use client";

/**
 * Move one night (or a run of nights) of a room (2026-10-14, operator: "I want to move room 206 for
 * the 22nd to another date ... if it moved to a different room on the 22nd that would be no
 * problem, but if it is a different date the system should make all of it a different entry under
 * the same enquiry, or a new enquiry").
 *
 * An Alt-drag of a night on the house chart opens this dialog. It asks the server what the move would
 * do (`POST /date-moves/nights/preview` — nothing written):
 *   - the same dates in another room: a room change for those nights, its price before and after;
 *   - other dates: the stay cut apart — what this booking keeps, every new booking (the night moved,
 *     and any stay left at its own dates), the price choice for the moved night, and where the new
 *     bookings go (the same enquiry, or one new enquiry).
 * Every figure and every refusal is the server's; the steps sit behind the "?".
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
  executeNightMove,
  previewNightMove,
  type NightMoveInput,
  type NightMovePreview,
  type NightMoveResult,
  type SplitTarget,
} from "@/lib/api/room-moves";
import { fmtRange, money } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

export type NightMove = NightMoveInput & { label: string; roomNumber: string; toRoomNumber: string };

const stepWord = (stage: string | null | undefined) => (stage ? STEP_NAMES[stepNoOfStage(stage as never) - 1] ?? stage : "—");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const blockedWords = (b: { atStep: string; message: string }) => `${b.atStep.toLowerCase().replace(/_/g, " ")} — ${b.message}`;

function ResultView({ result, tz }: { result: NightMoveResult; tz?: string }) {
  const s = result.source;
  const sourceBlocked = s.walk?.walk.blocked ?? null;
  return (
    <div className="rmv-result">
      <div className="spl-part">
        <p className={`rmv-status ${sourceBlocked ? "stop" : s.amendment && !s.amendment.applied ? "warn" : "ok"}`} role="status">
          {s.route === "NEGOTIATION"
            ? s.amendment && !s.amendment.applied
              ? "The change waits for the FOM's approval — nothing has moved yet."
              : "This booking changed inside its pass — price it again at the table."
            : sourceBlocked
              ? `This booking stopped part-way at ${blockedWords(sourceBlocked)}. Finish it on the booking.`
              : `This booking is back at ${stepWord(s.walk?.walk.reachedStage)}.`}
        </p>
        {s.walk?.heldDocuments.length ? <HeldPapersCard entryId={s.entryId} onlyIds={s.walk.heldDocuments.map((h) => h.id)} tz={tz} title="This booking's new paper — send it, or not" /> : null}
        <Link className="mono sm" href={`/bookings/${s.entryId}`}>
          Open {s.entryId}
        </Link>
      </div>
      {result.created.map((c) => (
        <div className="spl-part" key={c.entryId}>
          <p className={`rmv-status ${c.blocked ? "warn" : "ok"}`} role="status">
            <b>Room {c.roomNumber} · {fmtRange(c.checkInDate, c.checkOutDate)}</b>
            {" — "}
            {c.newInquiry
              ? `its booking ${c.entryId} on the new enquiry ${c.inquiryId} starts at Inquiry, filled in.`
              : c.blocked
                ? `${c.entryId} stopped at ${stepWord(c.reachedStage)}: ${blockedWords(c.blocked)}. Finish it on the booking.`
                : `${c.entryId} is at ${stepWord(c.reachedStage)}.`}
            <span className="muted"> {c.kind === "MOVED" ? "· the night moved" : "· left at its own dates"}</span>
          </p>
          {c.notes.length ? (
            <ul className="rmv-follow">
              {c.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {c.heldDocuments.length ? <HeldPapersCard entryId={c.entryId} onlyIds={c.heldDocuments.map((h) => h.id)} tz={tz} title="Its paper — send it, or not" /> : null}
          <Link className="btn btn-secondary compact" href={`/bookings/${c.entryId}${c.newInquiry ? "?step=1" : ""}`}>
            Open {c.entryId}
          </Link>
        </div>
      ))}
    </div>
  );
}

export function NightMoveDialog({ move, onClose, tz }: { move: NightMove | null; onClose: () => void; tz?: string }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [other, setOther] = useState(false);
  const [target, setTarget] = useState<SplitTarget | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<NightMovePreview | null>(null);
  const [result, setResult] = useState<NightMoveResult | null>(null);

  const split = preview?.mode === "SPLIT";

  const body = move
    ? {
        entryId: move.entryId,
        fromRoomId: move.fromRoomId,
        nights: move.nights,
        toRoomId: move.toRoomId ?? null,
        newFirstNight: move.newFirstNight,
        priceMode: other ? (move.newFirstNight === move.nights[0] ? ("NEW_TYPE" as const) : ("NEW_DATES" as const)) : ("KEEP" as const),
        guestAgreedNote: other ? note.trim() || null : null,
      }
    : null;
  const previewMut = useMutation({
    mutationFn: () => previewNightMove(session!, { ...body!, reason: reason.trim() || null }),
    onSuccess: setPreview,
    onError: (e) => toastRefusal(e, "The move could not be checked"),
  });
  useEffect(() => {
    if (!move || !session || result) return;
    previewMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [move, session, other]);
  useEffect(() => {
    if (move) return;
    setOther(false);
    setTarget(null);
    setNote("");
    setReason("");
    setPreview(null);
    setResult(null);
  }, [move]);

  const run = useMutation({
    mutationFn: () => executeNightMove(session!, { ...body!, ...(split ? { target: target! } : {}), reason: reason.trim() }),
    onSuccess: (r) => {
      setResult(r);
      for (const k of [["room-chart"], ["desk-bookings"], ["entries"]]) void qc.invalidateQueries({ queryKey: k });
      for (const id of [r.source.entryId, ...r.created.map((c) => c.entryId)]) {
        for (const k of [["entry", id], ["held-documents", id], ["entry-trace", id], ["billing-summary", id]]) void qc.invalidateQueries({ queryKey: k });
      }
      const stopped = r.source.walk?.walk.blocked || r.created.some((c) => c.blocked);
      toast[stopped ? "warning" : "success"](
        r.mode === "ROOM_CHANGE"
          ? stopped
            ? "The room change stopped part-way"
            : `Room ${move!.toRoomNumber} for ${move!.nights.length === 1 ? "that night" : "those nights"}`
          : r.newInquiryId
            ? `A new enquiry, ${r.newInquiryId}, holds ${plural(r.created.length, "new booking")}`
            : stopped
              ? "The move stopped part-way"
              : `${plural(r.created.length, "new booking")} made`,
      );
    },
    onError: (e) => toastRefusal(e, "The night could not be moved"),
  });

  if (!move) return null;
  const busy = previewMut.isPending || run.isPending;
  const targetRefusals = preview?.targets && target ? preview.targets[target].refusals : [];
  const blockedBy = !preview
    ? "Checking the move…"
    : !preview.authority.ok
      ? preview.authority.why
      : preview.refusals.length > 0
        ? "Something above refuses the move"
        : split && !target
          ? "Choose where the new bookings go"
          : targetRefusals.length > 0
            ? targetRefusals[0]
            : other && !note.trim()
              ? "Type what the guest agreed to"
              : !reason.trim()
                ? "Say why the night is moving"
                : null;
  const currency = preview?.price.currency ?? "BTN";
  const choice = preview?.price.choice ?? null;
  const nightsWord = move.nights.length === 1 ? "night" : "nights";
  const many = (preview?.pieces.length ?? 0) > 1;

  return (
    <DsDialog
      open
      onClose={() => !busy && onClose()}
      width={780}
      busy={busy}
      title={
        result
          ? "The night moved"
          : split || move.newFirstNight !== move.nights[0]
            ? `Move Room ${move.roomNumber}'s ${nightsWord} to other dates`
            : `Room ${move.roomNumber} → ${move.toRoomNumber} for ${move.nights.length === 1 ? "one night" : plural(move.nights.length, "night")}`
      }
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
              {run.isPending
                ? "Moving…"
                : !split
                  ? "Move the night"
                  : target === "NEW_ENQUIRY"
                    ? "Open a new enquiry"
                    : many
                      ? "Make the new bookings"
                      : "Make the new booking"}
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
                  <Help label="What happens when the night moves">
                    <div className="dmv-help">
                      {preview.authority.ok ? <p>{preview.authority.why}.</p> : null}
                      {preview.targets ? (
                        <>
                          <p>
                            <b>New bookings on this enquiry</b>
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
                            A night moved to other dates leaves a gap in the stay, so the stay is cut apart: this booking keeps the earliest stay left at its own dates, and every
                            other stay becomes a booking of its own. On a booking with other rooms, the room leaves it with its guests.
                          </p>
                        </>
                      ) : (
                        <ol>
                          {preview.path.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ol>
                      )}
                      <p>The night can keep the price agreed, or be priced again — that needs the guest&apos;s agreement, typed in.</p>
                    </div>
                  </Help>
                </span>
              </div>
              <div className="rmv-rooms">
                <span className="rmv-room">
                  Room {preview.from.roomNumber} · {preview.from.nightsLabel}
                </span>
                <span className="rmv-arrow">→</span>
                <span className="rmv-room to">
                  Room {preview.to.roomNumber} · {preview.to.nightsLabel}
                </span>
                <span className="rmv-type">
                  {plural(preview.to.nights, "night")}
                  {preview.shiftDays !== 0 ? ` · ${plural(Math.abs(preview.shiftDays), "day")} ${preview.shiftDays > 0 ? "later" : "earlier"}` : " · the same dates"}
                  {!preview.to.sameType ? " · another room type" : ""}
                </span>
              </div>
              {split ? (
                <div className="nmv-pieces">
                  <div className="nmv-keeps">
                    <span className="nmv-k">Stays on {preview.entryId}</span>
                    <b>{preview.original.words}</b>
                    {preview.original.guests ? <span className="muted"> · {preview.original.guests}</span> : null}
                  </div>
                  <div className="nmv-k">{preview.pieces.length === 1 ? "A booking of its own" : `${preview.pieces.length} bookings of their own`}</div>
                  {preview.pieces.map((p) => (
                    <div className={`nmv-piece${p.kind === "MOVED" ? " moved" : ""}`} key={`${p.kind}${p.checkInDate}`}>
                      <b>
                        Room {p.roomNumber} · {fmtRange(p.checkInDate, p.checkOutDate)}
                      </b>
                      <span className="muted">
                        {plural(p.nights, "night")} · {p.guests} · {p.kind === "MOVED" ? "the night moved" : "left at its own dates"}
                      </span>
                      {p.total != null ? <span className="nmv-total">{money(p.total, currency)}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {choice ? (
                <div className="dmv-choice" role="radiogroup" aria-label="The price">
                  <button type="button" role="radio" aria-checked={!other} className={!other ? "on" : undefined} onClick={() => setOther(false)}>
                    Keep the price
                    <b>{choice.keep != null ? money(choice.keep, currency) : "—"}</b>
                  </button>
                  <button type="button" role="radio" aria-checked={other} className={other ? "on" : undefined} onClick={() => setOther(true)}>
                    {choice.kind === "DATES" ? "At the new dates" : "At the new room type"}
                    <b>{choice.other != null ? money(choice.other, currency) : "—"}</b>
                  </button>
                </div>
              ) : null}
              {other ? (
                <label className="field">
                  <span>What the guest agreed to</span>
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. agreed on the phone to the rate for that night" />
                </label>
              ) : null}
              {split && preview.targets ? (
                <div className="spl-where" role="radiogroup" aria-label="Where the new bookings go">
                  <span className="spl-q">Make {many ? "them" : "it"}</span>
                  <button type="button" role="radio" aria-checked={target === "SAME_ENQUIRY"} className={target === "SAME_ENQUIRY" ? "on" : undefined} onClick={() => setTarget("SAME_ENQUIRY")}>
                    {many ? "New bookings on this enquiry" : "A new booking on this enquiry"}
                    <small>
                      {preview.inquiryId} · {stepNoOfStage(preview.stage as never) <= 2 ? "waits at Negotiation, priced" : `taken to ${preview.stageWord}`}
                    </small>
                  </button>
                  <button type="button" role="radio" aria-checked={target === "NEW_ENQUIRY"} className={target === "NEW_ENQUIRY" ? "on" : undefined} onClick={() => setTarget("NEW_ENQUIRY")}>
                    A new enquiry
                    <small>{many ? "one new enquiry holds them all" : "its own number"} · starts at Inquiry, filled in</small>
                  </button>
                </div>
              ) : null}
              {target && targetRefusals.length ? (
                <ul className="rmv-refusals rmv-moveref" role="alert">
                  {targetRefusals.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
              {preview.original.priceAfter != null ? (
                <div className="dmv-total">
                  This booking <b>{money(preview.original.priceBefore, currency)}</b>
                  <span className="muted">→</span>
                  <b>{money(preview.original.priceAfter, currency)}</b>
                </div>
              ) : preview.original.note ? (
                <div className="sm muted">{preview.original.note}</div>
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
            <span>Why the {nightsWord} {move.nights.length === 1 ? "is" : "are"} moving</span>
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the guest is away that night and comes back after" />
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
