"use client";

/**
 * The room inspections, one per room the guest leaves — as tiles (2026-10-26, operator: "for two
 * rooms it covers this much space … a booking can have more than 20 rooms, the user can't always
 * scroll down").
 *
 *  - Every room is a small tile coloured by where it stands: to inspect · clear · damage · fault
 *    open · put off. Twenty rooms fit in a few lines.
 *  - One click opens that room's own form under the tiles (one at a time); a single room opens by
 *    itself.
 *  - "Nothing found" records every room still to inspect in one act (the backend's bulk route); a
 *    room with an open fault report is left out and named, since its fault is answered on its own.
 *
 * Shared by Check-out (inspect, or put off to after departure) and Closed (finish what was put
 * off). Every standing is the backend's (`GET /entries/:id/room-inspections`).
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useRoomInspections } from "@/hooks/use-room-inspections";
import { recordRoomInspection, recordRoomInspectionsBulk } from "@/lib/api/checkout";
import { expirePostCheckoutInspectionWindow, type RoomInspectionView } from "@/lib/api/post-stay";
import { fmtDateTime } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { Help } from "@/components/ds/help";
import { Choice, SeeRow, toastRefusal, useRefreshEntry, words } from "./kit";

type FaultAnswer = "RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE";

const FAULT_WORD: Record<string, string> = {
  NOT_APPLICABLE: "no fault on the room",
  RESOLVED: "fault put right",
  UNRESOLVED_AT_CHECKOUT: "fault still there",
};

function roomWords(numbers: string[]) {
  if (numbers.length === 1) return `Room ${numbers[0]}`;
  return `Rooms ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

/** The tile's look and its one word. */
function tileOf(r: RoomInspectionView): { tone: string; word: string } {
  switch (r.state) {
    case "NOT_RECORDED":
      return r.openFault ? { tone: "fault", word: "fault open" } : { tone: "todo", word: "to inspect" };
    case "PUT_OFF":
      return { tone: "off", word: "put off" };
    case "LAPSED":
      return { tone: "lapsed", word: "window closed" };
    default:
      if (r.damageFound) return { tone: "damage", word: "damage" };
      if (r.deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT") return { tone: "damage", word: "fault stays" };
      if (r.deficientFlagStatus === "RESOLVED") return { tone: "clear", word: "put right" };
      return { tone: "clear", word: "clear" };
  }
}

export function RoomInspectionGrid({
  entry,
  live,
  atClosed = false,
  fom = false,
}: {
  entry: EntryDetail;
  /** Whether inspections may be recorded on this step now. */
  live: boolean;
  /** The Closed step: finish what was put off; nothing is put off again. */
  atClosed?: boolean;
  fom?: boolean;
}) {
  const { session } = useSession();
  const { tz } = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  const q = useRoomInspections(entry);
  const [picked, setPicked] = useState<string | null>(null);
  const data = q.data;
  const rooms = data?.rooms ?? [];
  const owes = (r: RoomInspectionView) => (atClosed ? r.state === "PUT_OFF" || r.state === "NOT_RECORDED" : r.state === "NOT_RECORDED");
  const owing = rooms.filter(owes);
  const clearable = owing.filter((r) => !r.openFault);
  const faulted = owing.filter((r) => r.openFault);

  const bulk = useMutation({
    mutationFn: (mode: "CLEAR" | "PUT_OFF") =>
      recordRoomInspectionsBulk(session!, entry.id, { mode, roomIds: clearable.map((r) => r.roomId) }),
    onSuccess: (out) => {
      const n = out.recorded.length;
      const what = out.mode === "PUT_OFF" ? "put off to after departure" : "recorded as nothing found";
      if (n) toast.success(`${roomWords(out.recorded.map((r) => r.roomNumber))} ${what}`);
      const refused = out.skipped.filter((s) => s.reason === "REFUSED");
      if (refused.length) toast.error(refused.map((s) => `Room ${s.roomNumber}: ${s.message}`).join(" · "));
      refresh();
    },
    onError: (e) => toastRefusal(e, "The rooms could not be recorded"),
  });

  if (!data) return <span className="meta">{q.isError ? "The inspections could not be read" : "Reading the inspections…"}</span>;
  if (!rooms.length) return <span className="meta">No room to inspect</span>;

  const one = rooms.length === 1;
  const openId = one ? rooms[0].roomId : picked;
  const open = rooms.find((r) => r.roomId === openId) ?? null;
  const settled = atClosed ? data.allResolved : data.allRecorded;
  const doneCount = atClosed ? rooms.filter((r) => r.state === "DONE" || r.state === "LAPSED").length : data.inspectedCount;

  return (
    <div className="insp" style={{ display: "grid", gap: 8 }}>
      <div className="insp-head">
        <b className={settled ? "ok-ink" : "stop-ink"}>
          {one
            ? `Room ${rooms[0].roomNumber} · ${tileOf(rooms[0]).word}`
            : `${doneCount} of ${rooms.length} rooms ${atClosed ? "inspected" : "inspected or put off"}`}
        </b>
        <Help label="About the inspections">
          Each room the guest leaves at check-out is inspected{atClosed ? "" : ", or its inspection put off to after departure"}. Pick a room to
          note damage, answer its open fault or {atClosed ? "record what was found" : "put it off"}. Nothing found records every room still to
          inspect at once; a room with an open fault report is answered on its own. A room the guest left earlier in the stay was handed to
          housekeeping the day it was left, so it is not inspected here.
        </Help>
        {live && clearable.length > 0 && !one ? (
          <span className="insp-bulk">
            <Button kind="secondary" compact state={bulk.isPending ? "working" : "default"} workingLabel="Recording…" onClick={() => bulk.mutate("CLEAR")}>
              Nothing found · {clearable.length} {clearable.length === 1 ? "room" : "rooms"}
            </Button>
            {!atClosed ? (
              <Button kind="quiet" compact state={bulk.isPending ? "inert" : "default"} onClick={() => bulk.mutate("PUT_OFF")}>
                Put {clearable.length} off
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {live && faulted.length ? (
        <span className="sm warn-ink">
          {roomWords(faulted.map((r) => r.roomNumber))} {faulted.length === 1 ? "has an open fault" : "have an open fault"} — open{" "}
          {faulted.length === 1 ? "it" : "each"} to answer it.
        </span>
      ) : null}

      {!one ? (
        <div className="insp-grid" role="group" aria-label="The rooms to inspect">
          {rooms.map((r) => {
            const t = tileOf(r);
            const sel = r.roomId === openId;
            return (
              <button
                key={r.roomId}
                type="button"
                className={`insp-tile ${t.tone}${sel ? " sel" : ""}`}
                aria-pressed={sel}
                aria-label={`Room ${r.roomNumber} — ${t.word}`}
                onClick={() => setPicked(sel ? null : r.roomId)}
                data-no-pending
              >
                <b>{r.roomNumber}</b>
                <span>{t.word}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {open ? (
        <RoomInspectionPanel
          key={open.roomId}
          entry={entry}
          row={open}
          live={live}
          atClosed={atClosed}
          fom={fom}
          tz={tz}
          onRecorded={() => {
            if (!one) setPicked(null);
          }}
        />
      ) : null}
    </div>
  );
}

function RoomInspectionPanel({
  entry,
  row,
  live,
  atClosed,
  fom,
  tz,
  onRecorded,
}: {
  entry: EntryDetail;
  row: RoomInspectionView;
  live: boolean;
  atClosed: boolean;
  fom: boolean;
  tz: string;
  onRecorded: () => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const fault = row.openFault;
  const owes = atClosed ? row.state === "PUT_OFF" || row.state === "NOT_RECORDED" : row.state === "NOT_RECORDED";
  // At Check-out a recorded room may be recorded again; at Closed only a room that owes one.
  const canRecord = live && (owes || !atClosed);
  const [editing, setEditing] = useState(owes);
  const [deferred, setDeferred] = useState(false);
  const [flag, setFlag] = useState<FaultAnswer>(fault ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  useEffect(() => {
    setFlag(fault ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  }, [fault?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [assessment, setAssessment] = useState("");
  const [damage, setDamage] = useState(false);
  const [damageNotes, setDamageNotes] = useState("");
  const missing =
    fault && flag === "UNRESOLVED_AT_CHECKOUT" && !assessment.trim()
      ? "write what the inspector found"
      : damage && !damageNotes.trim()
        ? "say what is damaged"
        : null;
  const inspect = useMutation({
    mutationFn: () =>
      recordRoomInspection(session!, entry.id, {
        roomId: row.roomId,
        isDeferred: !atClosed && deferred,
        deficientFlagStatus: fault ? flag : "NOT_APPLICABLE",
        deficientConditionId: fault && flag !== "NOT_APPLICABLE" ? fault.id : undefined,
        inspectorAssessment: fault && flag === "UNRESOLVED_AT_CHECKOUT" ? assessment.trim() : undefined,
        damageFound: damage,
        damageNotes: damage ? damageNotes.trim() : undefined,
      }),
    onSuccess: () => {
      toast.success(
        !atClosed && deferred
          ? `Room ${row.roomNumber}'s inspection is put off to after departure`
          : damage && atClosed
            ? `Room ${row.roomNumber}'s inspection is on record — post the damage as a late charge below`
            : `Room ${row.roomNumber}'s inspection is on record`,
      );
      setEditing(false);
      refresh();
      onRecorded();
    },
    onError: (e) => toastRefusal(e, `Room ${row.roomNumber}'s inspection could not be recorded`),
  });
  const expire = useMutation({
    mutationFn: () => expirePostCheckoutInspectionWindow(session!, entry.id, row.roomId),
    onSuccess: () => {
      toast.success(`Room ${row.roomNumber}'s inspection window is closed`);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The inspection window could not be closed"),
  });

  const recordedLine =
    row.state === "DONE" ? (
      <>
        {FAULT_WORD[row.deficientFlagStatus ?? ""] ?? words(row.deficientFlagStatus ?? "")}
        {row.damageFound ? ` · damage noted${row.damageNotes ? `: ${row.damageNotes}` : ""}` : " · no damage"}
        {row.inspectedAt ? ` · ${fmtDateTime(row.inspectedAt, tz)}` : ""}
      </>
    ) : row.state === "PUT_OFF" ? (
      <>put off to after departure{row.windowEndsAt ? ` · the window closes ${fmtDateTime(row.windowEndsAt, tz)}` : ""}</>
    ) : row.state === "LAPSED" ? (
      <>put off · the window closed{row.lapsedAt ? ` ${fmtDateTime(row.lapsedAt, tz)}` : ""} with nothing recorded</>
    ) : null;

  return (
    <div className="insp-panel bind provisional" aria-label={`Room ${row.roomNumber}'s inspection`}>
      <div className="row-acts" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span className="sm">
          <b>Room {row.roomNumber}</b>
          {recordedLine ? <span className="meta"> · {recordedLine}</span> : null}
        </span>
        {canRecord && !owes ? (
          <Button kind="quiet" compact onClick={() => setEditing((v) => !v)}>
            {editing ? "Leave it" : "Record it again"}
          </Button>
        ) : null}
      </div>
      {canRecord && editing ? (
        <div style={{ display: "grid", gap: 8 }}>
          {fault ? (
            <div className="field">
              <label>
                Open fault — {words(fault.category)}: {fault.description}
              </label>
              <Choice
                options={[
                  ["RESOLVED", "Put right at inspection"],
                  ["UNRESOLVED_AT_CHECKOUT", atClosed ? "Still there" : "Still there at departure"],
                ]}
                value={flag === "NOT_APPLICABLE" ? "UNRESOLVED_AT_CHECKOUT" : flag}
                onChange={setFlag}
              />
            </div>
          ) : null}
          {fault && flag === "UNRESOLVED_AT_CHECKOUT" ? (
            <div className="field">
              <label>What the inspector found</label>
              <input className="input" value={assessment} onChange={(e) => setAssessment(e.target.value)} />
            </div>
          ) : null}
          <div className="insp-ticks">
            <label className="sm">
              <input type="checkbox" checked={damage} onChange={(e) => setDamage(e.target.checked)} />
              Damage found
            </label>
            {!atClosed ? (
              <label className="sm">
                <input type="checkbox" checked={deferred} onChange={(e) => setDeferred(e.target.checked)} />
                Put off to after departure
              </label>
            ) : null}
            {!fault ? (
              <span className="sm meta">
                no open fault report
                <Help label="About fault reports">
                  A fault report is a fault flagged on the room — from Stay&rsquo;s Other ways (Flag room deficient) or the Rooms page. Charges
                  on the bill aren&rsquo;t counted here.
                </Help>
              </span>
            ) : null}
          </div>
          {damage ? (
            <input className="input" value={damageNotes} placeholder={`what is damaged in Room ${row.roomNumber}`} onChange={(e) => setDamageNotes(e.target.value)} />
          ) : null}
          <div className="row-acts">
            <Button
              kind="secondary"
              compact
              state={inspect.isPending ? "working" : missing ? "inert" : "default"}
              title={missing ?? undefined}
              workingLabel="Recording…"
              onClick={() => inspect.mutate()}
            >
              Record Room {row.roomNumber}
            </Button>
          </div>
        </div>
      ) : null}
      {atClosed && row.state === "PUT_OFF" && row.windowCanBeClosed && live ? (
        <SeeRow
          label={`Close Room ${row.roomNumber}'s inspection window`}
          note="only when nobody inspected the room in time — it records that nothing was found; the FOM's"
          onClick={fom && !expire.isPending ? () => expire.mutate() : undefined}
          reason={fom ? undefined : "Closing the inspection window needs the FOM"}
        />
      ) : null}
    </div>
  );
}
