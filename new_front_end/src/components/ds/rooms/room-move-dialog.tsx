"use client";

/**
 * Switch rooms / move a booking, from the house chart (2026-10-12, operator: "switch two
 * reservations — different stages, rooms and dates — through all the procedures, produce the
 * documents, and after switching give the option to send or not; well audited").
 *
 * The dialog asks the server what the move would do (`POST /room-moves/preview` — nothing
 * written) and shows it per booking: from → to, the nights, the price before and after, the
 * steps the booking walks, the papers it produces, what is left to do, and anything that refuses
 * it. Then it runs the move (`POST /room-moves`) and shows where each booking ended, with the
 * held papers to send or not. Every figure and every refusal is the server's.
 *
 * Many rooms (2026-10-12, drag and drop): the desk sends the rooms it picked; the server adds a leg
 * for every booking sitting in a room one of them lands on ("makes room for …"). From the first
 * answer on, the dialog sends the server's own legs back, so each guest's price choice — the added
 * ones' too — rides on the leg it belongs to.
 */
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { DsDialog, toastRefusal } from "@/components/ds/steps/kit";
import { HeldPapersCard } from "@/components/ds/workspace/held-papers";
import { useSession } from "@/hooks/use-session";
import {
  executeRoomMove,
  listRoomMovesForEntry,
  previewRoomMove,
  resolveRoomMove,
  retryRoomMoveLeg,
  type RoomMove,
  type RoomMoveLeg,
  type RoomMoveLegInput,
  type RoomMovePreview,
  type RoomMovePreviewLeg,
} from "@/lib/api/room-moves";
import { money } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

const stepWord = (stage: string | null | undefined) => (stage ? STEP_NAMES[stepNoOfStage(stage as never) - 1] ?? stage : "—");

const MOVE_STATUS: Record<RoomMove["status"], { word: string; cls: string }> = {
  IN_PROGRESS: { word: "Running", cls: "warn" },
  COMPLETED: { word: "Done", cls: "ok" },
  PARTIAL: { word: "Part-done — the rooms are held until it is settled", cls: "stop" },
  REVERTED: { word: "Not done — walked back, nothing changed", cls: "stop" },
  FAILED: { word: "Not done — refused, nothing changed", cls: "stop" },
};

function legOutcome(l: RoomMoveLeg): { word: string; cls: string } {
  if (l.compensates) return l.status === "DONE" ? { word: `Walked back to Room ${l.toRoomNumber}`, cls: "warn" } : { word: `The walk back stopped — ${l.refusal?.message ?? l.blocked?.message ?? "see the booking"}`, cls: "stop" };
  switch (l.status) {
    case "DONE":
      return { word: `Done — in Room ${l.toRoomNumber}, back at ${stepWord(l.reachedStage)}`, cls: "ok" };
    case "STOPPED":
      return { word: `Stopped part-way — ${l.blocked?.message ?? "finish it on the booking"}`, cls: "stop" };
    case "REFUSED":
      return { word: `Refused — ${l.refusal?.message ?? "it did not start"}`, cls: "stop" };
    case "REVERTED":
      return { word: `Moved, then walked back to Room ${l.fromRoomNumber}`, cls: "warn" };
    case "CANCELLED":
      return { word: "Not run", cls: "warn" };
    default:
      return { word: "Waiting to run", cls: "warn" };
  }
}

function PriceLine({ p }: { p: RoomMovePreviewLeg["pricing"] }) {
  if (p.after == null) return <span className="sm muted">{p.note ?? "The new quotation states the price"}</span>;
  const same = p.delta === 0;
  return (
    <span className="rmv-price">
      <b>{money(p.before, p.currency ?? "BTN")}</b>
      <span className="muted"> → </span>
      <b className={same ? "ok-ink" : "warn-ink"}>{money(p.after, p.currency ?? "BTN")}</b>
      {!same && p.delta != null ? <span className={p.delta > 0 ? "warn-ink" : "ok-ink"}> ({p.delta > 0 ? "+" : "−"}{money(Math.abs(p.delta), p.currency ?? "BTN")})</span> : null}
      {p.note ? <span className="sm muted"> · {p.note}</span> : null}
    </span>
  );
}

/** The server's ask for the guest's words — the card has its own field for it, so it is not repeated. */
const NOTE_ASK = /type what the guest agreed to|type what they said/;
/** The server's question about the guest's other booking — the card asks it in its own words. */
const OVERLAP_ASK = /say whether both bookings are meant/;
const ASKED_ON_CARD = (r: string) => NOTE_ASK.test(r) || OVERLAP_ASK.test(r);

/** "Both are meant" or "entered twice by mistake" — the answer the switch needs (2026-10-19). */
type OverlapAnswer = "BOTH" | "MISTAKE";

function PreviewLegCard({
  leg,
  priceMode,
  note,
  onPriceMode,
  onNote,
  madeBy,
  overlapAnswer,
  onOverlapAnswer,
}: {
  leg: RoomMovePreviewLeg;
  priceMode: "KEEP" | "NEW_TYPE";
  note: string;
  onPriceMode: (m: "KEEP" | "NEW_TYPE") => void;
  onNote: (n: string) => void;
  /** The guest whose move pushes this booking out of its room, when it was added for that. */
  madeBy: string | null;
  overlapAnswer: OverlapAnswer | null;
  onOverlapAnswer: (a: OverlapAnswer) => void;
}) {
  // The note a re-price needs, and the question about the guest's other booking, are asked by
  // their own fields, not repeated as refusals.
  const refusals = leg.refusals.filter((r) => !ASKED_ON_CARD(r));
  const asks = !!leg.guestOverlap && !leg.guestOverlapAcknowledged;
  const refused = refusals.length > 0;
  // Trading stays (2026-10-19): the dates move too, so the price is a choice on every such card.
  const dated = !!leg.newCheckInDate;
  return (
    <div className={`rmv-leg${refused ? " refused" : ""}`}>
      <div className="rmv-who">
        <b>{leg.guestName ?? leg.entryId}</b>
        <span className="mono sm">{leg.entryId}</span>
        <span className="chip-step">{leg.stageWord}</span>
      </div>
      <div className="rmv-rooms">
        <span className="rmv-room">Room {leg.fromRoom?.roomNumber ?? "?"}</span>
        <span className="rmv-arrow">→</span>
        <span className="rmv-room to">Room {leg.toRoom?.roomNumber ?? "?"}</span>
        {leg.sameType === false ? <span className="rmv-type">{leg.fromRoom?.roomTypeName} → {leg.toRoom?.roomTypeName}</span> : null}
      </div>
      {leg.displaced ? (
        <p className="rmv-displaced">
          {dated
            ? `Swapped in: ${madeBy ?? leg.displacedBy} takes this booking's room and dates, so this guest takes theirs.`
            : `Swapped in: ${madeBy ?? leg.displacedBy} moves into Room ${leg.fromRoom?.roomNumber ?? "?"}, so this guest takes the room they leave.`}
        </p>
      ) : null}
      {dated ? (
        <div className="rmv-dates">
          <span>{leg.nightsLabel ?? "—"}</span>
          <span className="rmv-arrow">→</span>
          <b>{leg.toNightsLabel ?? "—"}</b>
        </div>
      ) : leg.nightsLabel ? (
        <div className="sm">Nights: <b>{leg.nightsLabel}</b></div>
      ) : null}
      {leg.guestOverlap && !asks ? <p className="rmv-overlap done">{leg.guestOverlap}</p> : null}
      {asks ? (
        <div className={`rmv-overlap ask${overlapAnswer ? "" : " open"}`} role="radiogroup" aria-label="The guest's other booking">
          <b>{leg.guestOverlap}</b>
          <span>Are both bookings meant?</span>
          <label className={overlapAnswer === "BOTH" ? "on" : undefined}>
            <input type="radio" checked={overlapAnswer === "BOTH"} onChange={() => onOverlapAnswer("BOTH")} /> Both are meant — the guest keeps two bookings on these nights
          </label>
          <label className={overlapAnswer === "MISTAKE" ? "on" : undefined}>
            <input type="radio" checked={overlapAnswer === "MISTAKE"} onChange={() => onOverlapAnswer("MISTAKE")} /> Entered twice by mistake
          </label>
          {overlapAnswer === "MISTAKE" ? (
            <p className="rmv-overlap-then">
              {"Then don't switch — cancel the duplicate on its own page"}
              {leg.guestOverlapEntryId ? (
                <>
                  {": "}
                  <Link href={`/bookings/${leg.guestOverlapEntryId}`}>{leg.guestOverlapEntryId}</Link>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
      {refused ? null : <div className="sm">Price: <PriceLine p={leg.pricing} /></div>}
      {leg.sameType === false || dated ? (
        <div className="rmv-pricemode" role="radiogroup" aria-label="How this guest is priced">
          <label className={priceMode === "KEEP" ? "on" : undefined}>
            <input type="radio" checked={priceMode === "KEEP"} onChange={() => onPriceMode("KEEP")} /> Keep their price
          </label>
          <label className={priceMode === "NEW_TYPE" ? "on" : undefined}>
            <input type="radio" checked={priceMode === "NEW_TYPE"} onChange={() => onPriceMode("NEW_TYPE")} />{" "}
            {dated ? (leg.sameType === false ? "Price at the new dates and room type" : "Price at the new dates") : "Price at the new room type"}
          </label>
          {priceMode === "NEW_TYPE" ? (
            <label className="field">
              <span>What the guest agreed to</span>
              <input className="input" value={note} onChange={(e) => onNote(e.target.value)} placeholder="e.g. agreed on the phone to the new rate" />
            </label>
          ) : null}
        </div>
      ) : null}
      {refused ? (
        <ul className="rmv-refusals" role="alert">
          {refusals.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <>
          <ol className="rmv-path">
            {leg.path.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
          <div className="sm">
            <b>Papers:</b> {leg.papers.join(" · ")}
          </div>
          {leg.followUps.length ? (
            <ul className="rmv-follow">
              {leg.followUps.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Where a move ended, per booking — with Retry and Close the move while it is part-done, and the
 * held papers to send or not. Shown in the dialog after a move, and on each booking of a move that
 * is still running or part-done (the booking page), so closing the dialog loses nothing.
 */
export function RoomMoveResult({ move, tz, onChanged }: { move: RoomMove; tz?: string; onChanged?: (m: RoomMove) => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [resolveNote, setResolveNote] = useState("");
  const after = (m: RoomMove) => {
    for (const k of [["room-chart"], ["desk-bookings"], ["entries"]]) void qc.invalidateQueries({ queryKey: k });
    for (const l of m.legs) {
      for (const k of [["entry", l.entryId], ["held-documents", l.entryId], ["entry-trace", l.entryId], ["billing-summary", l.entryId], ["room-moves", l.entryId]]) {
        void qc.invalidateQueries({ queryKey: k });
      }
    }
    onChanged?.(m);
  };
  const retry = useMutation({
    mutationFn: (legId: string) => retryRoomMoveLeg(session!, move.id, legId),
    onSuccess: (m) => {
      after(m);
      toast[m.status === "COMPLETED" ? "success" : "warning"](`${m.id} · ${MOVE_STATUS[m.status].word}`);
    },
    onError: (e) => toastRefusal(e, "The retry did not run"),
  });
  const resolve = useMutation({
    mutationFn: () => resolveRoomMove(session!, move.id, resolveNote.trim()),
    onSuccess: (m) => {
      after(m);
      toast.success(`${m.id} closed`);
    },
    onError: (e) => toastRefusal(e, "The move could not be closed"),
  });
  return (
    <div className="rmv-result">
      <p className={`rmv-status ${MOVE_STATUS[move.status].cls}`} role="status">
        {MOVE_STATUS[move.status].word}
      </p>
      {move.legs.map((l) => {
        const o = legOutcome(l);
        return (
          <div key={l.id} className="rmv-leg">
            <div className="rmv-who">
              <b>{l.guestName ?? l.entryId}</b>
              <Link className="mono sm" href={`/bookings/${l.entryId}`}>
                {l.entryId}
              </Link>
              <span className="sm muted">
                Room {l.fromRoomNumber} → {l.toRoomNumber}
                {l.toNightsLabel ? ` · ${l.nightsLabel ?? ""} → ${l.toNightsLabel}` : l.nightsLabel ? ` · ${l.nightsLabel}` : ""}
              </span>
            </div>
            <p className={`rmv-outcome ${o.cls}`}>{o.word}</p>
            {l.pricing?.newTotal != null ? (
              <div className="sm">
                Price: <b>{money(l.pricing.priorTotal, l.pricing.currency ?? "BTN")}</b> → <b>{money(l.pricing.newTotal, l.pricing.currency ?? "BTN")}</b>
              </div>
            ) : null}
            {(l.status === "REFUSED" || l.status === "PLANNED") && !l.compensates && move.status === "PARTIAL" ? (
              <Button kind="primary" compact state={retry.isPending ? "inert" : "default"} onClick={() => retry.mutate(l.id)}>
                {retry.isPending ? "Retrying…" : "Retry this booking's move"}
              </Button>
            ) : null}
            {l.heldDocuments.some((h) => h.decision == null) ? (
              <HeldPapersCard entryId={l.entryId} onlyIds={l.heldDocuments.map((h) => h.id)} tz={tz} title="Send the new paper, or not" />
            ) : null}
          </div>
        );
      })}
      {move.status === "PARTIAL" ? (
        <div className="rmv-resolve">
          <label className="field">
            <span>Once each booking holds the room it should, close the move</span>
            <input className="input" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} placeholder="How it was settled" />
          </label>
          <Button kind="quiet" compact state={!resolveNote.trim() || resolve.isPending ? "inert" : "default"} onClick={() => resolveNote.trim() && resolve.mutate()}>
            Close the move
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function RoomMoveDialog({
  legs,
  onClose,
  tz,
}: {
  legs: RoomMoveLegInput[] | null;
  onClose: () => void;
  tz?: string;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [priceModes, setPriceModes] = useState<Record<string, "KEEP" | "NEW_TYPE">>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** The desk's answer about each guest's other booking over the new nights. */
  const [overlapAnswers, setOverlapAnswers] = useState<Record<string, OverlapAnswer>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<RoomMovePreview | null>(null);
  const [result, setResult] = useState<RoomMove | null>(null);
  /** The legs as the server last returned them — the desk's picks plus the swaps it added. */
  const [plan, setPlan] = useState<RoomMoveLegInput[] | null>(null);
  const legKey = (l: { entryId: string; fromRoomId: string }) => `${l.entryId}|${l.fromRoomId}`;

  const asked = useMemo(
    () =>
      (plan ?? legs ?? []).map((l) => {
        const mode = priceModes[legKey(l)] ?? "KEEP";
        return {
          ...l,
          priceMode: mode,
          guestAgreedNote: mode === "NEW_TYPE" ? notes[legKey(l)]?.trim() || null : null,
          guestOverlapConfirmed: overlapAnswers[legKey(l)] === "BOTH",
        };
      }),
    [plan, legs, priceModes, notes, overlapAnswers],
  );
  const modesKey = JSON.stringify([priceModes, overlapAnswers]);

  const previewMut = useMutation({
    mutationFn: () => previewRoomMove(session!, { legs: asked, reason: reason.trim() || null }),
    onSuccess: (p) => {
      setPreview(p);
      setPlan(
        p.legs.map((l) => ({
          entryId: l.entryId,
          fromRoomId: l.fromRoomId,
          toRoomId: l.toRoomId,
          displacedBy: l.displacedBy,
          newCheckInDate: l.newCheckInDate,
        })),
      );
    },
    onError: (e) => toastRefusal(e, "The move could not be checked"),
  });
  // Ask again when the legs or a price choice change (not on every keystroke of a note).
  useEffect(() => {
    if (!legs || !session || result) return;
    setPreview(null);
    previewMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, session, modesKey]);
  useEffect(() => {
    if (legs) return;
    setPriceModes({});
    setNotes({});
    setOverlapAnswers({});
    setReason("");
    setPreview(null);
    setResult(null);
    setPlan(null);
  }, [legs]);

  const refreshAll = (m: RoomMove) => {
    for (const k of [["room-chart"], ["desk-bookings"], ["entries"]]) void qc.invalidateQueries({ queryKey: k });
    for (const l of m.legs) {
      for (const k of [["entry", l.entryId], ["held-documents", l.entryId], ["entry-trace", l.entryId], ["billing-summary", l.entryId], ["room-moves", l.entryId]]) {
        void qc.invalidateQueries({ queryKey: k });
      }
    }
  };
  const run = useMutation({
    mutationFn: () => executeRoomMove(session!, { legs: asked, reason: reason.trim() }),
    onSuccess: (m) => {
      setResult(m);
      refreshAll(m);
      toast[m.status === "COMPLETED" ? "success" : "warning"](`${m.id} · ${MOVE_STATUS[m.status].word}`);
    },
    onError: (e) => toastRefusal(e, "The move could not be made"),
  });

  if (!legs) return null;
  const legCount = (preview?.legs ?? legs).length;
  const swap = preview ? preview.kind === "SWAP" : new Set(legs.map((l) => l.entryId)).size > 1;
  const busy = previewMut.isPending || run.isPending;
  const missingNote = asked.some((l) => l.priceMode === "NEW_TYPE" && !l.guestAgreedNote);
  const asking = (preview?.legs ?? []).filter((l) => !!l.guestOverlap && !l.guestOverlapAcknowledged);
  const unanswered = asking.some((l) => !overlapAnswers[l.key]);
  const mistaken = asking.some((l) => overlapAnswers[l.key] === "MISTAKE");
  const nameOfEntry = (entryId: string | null) => (entryId ? (preview?.legs.find((x) => x.entryId === entryId)?.guestName ?? entryId) : null);
  const blockedBy = !preview
    ? "Checking the move…"
    : !preview.authority.ok
      ? `${preview.authority.why} — you are signed in as ${preview.authority.actorLevel === "L1" ? "the front desk" : preview.authority.actorLevel}`
      : preview.refusals.length > 0 || preview.legs.some((l) => l.refusals.length > 0 && !l.refusals.every(ASKED_ON_CARD))
        ? "Something above refuses the move"
        : mistaken
          ? "Entered twice by mistake — cancel the duplicate instead of switching"
          : unanswered
            ? "Say whether both of the guest's bookings are meant"
            : missingNote
              ? "Type what the guest agreed to"
              : !reason.trim()
                ? "Say why the room is being moved"
                : null;

  const bookings = new Set((preview?.legs ?? legs).map((l) => l.entryId)).size;
  // Trading stays (2026-10-19): the rooms and the dates change hands.
  const dated = (preview?.legs ?? []).some((l) => !!l.newCheckInDate) || legs.some((l) => !!l.newCheckInDate);
  const title = result
    ? `${result.id} · ${swap ? "Switch" : "Move"}`
    : dated
      ? swap
        ? "Switch these two bookings' rooms and dates"
        : "Move the booking to other dates"
      : swap
      ? legCount === 2
        ? "Switch these two bookings' rooms"
        : `Switch rooms · ${legCount} rooms, ${bookings} bookings`
      : legCount > 1
        ? `Move ${legCount} rooms`
        : `Move to Room ${preview?.legs[0]?.toRoom?.roomNumber ?? ""}`;

  return (
    <DsDialog
      open
      // The check with the house writes nothing — leaving during it is fine; only the move itself holds the window.
      onClose={() => !run.isPending && onClose()}
      width={920}
      busy={run.isPending}
      title={title}
      footer={
        result ? (
          <Button kind="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button kind="quiet" onClick={onClose} state={run.isPending ? "inert" : "default"}>
              Leave it as it is
            </Button>
            <Button kind="primary" state={blockedBy || busy ? "inert" : "default"} onClick={() => !blockedBy && run.mutate()}>
              {run.isPending ? "Moving…" : dated && swap ? "Switch rooms and dates" : swap ? "Switch the rooms" : legCount > 1 ? "Move the rooms" : "Move the booking"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <RoomMoveResult move={result} tz={tz} onChanged={setResult} />
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
          <div className={`rmv-legs${legCount === 2 ? " two" : legCount > 2 ? " many" : ""}`}>
            {(preview?.legs ?? []).map((l) => (
              <PreviewLegCard
                key={l.key}
                leg={l}
                priceMode={priceModes[l.key] ?? "KEEP"}
                note={notes[l.key] ?? ""}
                onPriceMode={(m) => setPriceModes((p) => ({ ...p, [l.key]: m }))}
                onNote={(n) => setNotes((p) => ({ ...p, [l.key]: n }))}
                madeBy={nameOfEntry(l.displacedBy)}
                overlapAnswer={overlapAnswers[l.key] ?? null}
                onOverlapAnswer={(a) => setOverlapAnswers((p) => ({ ...p, [l.key]: a }))}
              />
            ))}
          </div>
          <label className="field">
            <span>Why the room is being moved</span>
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. a family needs the connecting rooms" />
          </label>
          {blockedBy && preview ? <p className="stop-ink sm" style={{ margin: 0, fontWeight: 700 }}>{blockedBy}</p> : null}
        </div>
      )}
    </DsDialog>
  );
}

/**
 * A room move this booking is part of that is still running or part-done — shown on the booking,
 * with what each side's walk did and the FOM's Retry / Close the move. Nothing when there is none.
 */
export function ActiveRoomMoves({ entryId, tz }: { entryId: string; tz?: string }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["room-moves", entryId],
    queryFn: () => listRoomMovesForEntry(session!, entryId),
    enabled: !!session,
    staleTime: 15_000,
  });
  const open = (q.data ?? []).filter((m) => m.status === "PARTIAL" || m.status === "IN_PROGRESS");
  if (open.length === 0) return null;
  return (
    <>
      {open.map((m) => (
        <section key={m.id} className="rmv-card" aria-label={`Room move ${m.id}`}>
          <div className="rmv-card-head">
            <b>
              {m.id} · {m.kind === "SWAP" ? "a room switch" : "a room move"} is not finished
            </b>
          </div>
          <RoomMoveResult move={m} tz={tz} />
        </section>
      ))}
    </>
  );
}

