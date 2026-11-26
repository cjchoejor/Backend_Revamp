"use client";

/**
 * Stay — the rooms in use and their keys.
 *
 * Each room keeps its bed setup, its extra beds and its own "Change room" (same type is the
 * desk's, a different type the FOM's; the move takes effect from tonight and the nights slept stay
 * on the old room). A move between rooms is a key swap: the vacated room's key comes back first,
 * and the backend refuses the new key until it has — the rows say which key unlocks which.
 */
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { declareRoomKeyLost, issueAllRoomKeys, issueRoomKey, returnRoomKey } from "@/lib/api/entries";
import { currentRoomAssignments, roomStayRangesByRoom } from "@/lib/desk/party-rooms";
import { effectiveCheckOutIso } from "@/lib/desk/workspace";
import { fmtDay, fmtStamp, plural } from "@/lib/ds/format";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { DeficiencyPanel } from "@/components/deficiency/deficiency-panel";
import { RoomCompositionSummary, hasRoomComposition } from "@/components/desk/workspace/room-composition-summary";
import { InitialSelectionCell, RoomChangeControl } from "@/components/desk/workspace/room-change-control";
import type { EntryDetail } from "@/types/api";
import { Choice, Live, ReasonDialog, StepCard, Tool, toastRefusal, useRefreshEntry, useStepMode, NotNow } from "./kit";
import { InlineTool, WideDialog, claimWord, physicalWord } from "./s6-shared";

/* ------------------------------------------------------------------ rooms in use */

export function RoomsInUseCard({ entry, id }: { entry: EntryDetail; id: string }) {
  const refresh = useRefreshEntry(entry.id);
  const hotelToday = useHotelDay()?.today ?? null;
  const stay = useMemo(() => roomStayRangesByRoom(entry), [entry]);

  // Rooms whose row is still current (an in-house move end-dates the old room at tonight, so it
  // drops off here while its slept nights stay billed). Until the hotel's day is known, every room.
  const rooms = useMemo(() => {
    const rows = currentRoomAssignments(entry.roomAssignments ?? [], hotelToday);
    const distinct = Array.from(new Map(rows.map((a) => [a.roomId, a])).values());
    return distinct.sort((a, b) => {
      const A = stay.get(a.roomId);
      const B = stay.get(b.roomId);
      return (A?.firstNight ?? "9999").localeCompare(B?.firstNight ?? "9999") || (B?.nightCount ?? 0) - (A?.nightCount ?? 0);
    });
  }, [entry.roomAssignments, hotelToday, stay]);

  const onChanged = () => refresh([["room-plan-history", entry.id], ["identity-proofs", entry.id], ["rooms-catalog"], ["night-audit"]]);
  if (rooms.length === 0) return null;
  const currency = entry.folio?.lines?.[0]?.currency;

  return (
    <div id={id}>
      <StepCard
        title={rooms.length > 1 ? `Rooms in use · ${rooms.length}` : "Room in use"}
        icon="bed"
        meta="Where the guest is tonight, and how each room is made up. A room is changed in the table above — a move to another room of the same type is the desk's; a different type is the FOM's and re-prices the stay from tonight. The nights already slept stay on the old room."
      >
        {rooms.map((a) => {
          const r = stay.get(a.roomId);
          const standing = [claimWord(a.room?.currentClaimState), physicalWord(a.room?.physicalState)].filter(Boolean).join(" · ");
          const number = a.room?.roomNumber ?? a.roomId.slice(0, 8);
          return (
            <div key={a.roomId} style={{ borderTop: "1px solid var(--line)", padding: "10px 0", display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span className="sm">
                  <b>Room {number}</b>
                  {r ? <span className="meta"> · {r.label} · {plural(r.nightCount, "night")}</span> : null}
                  {standing ? <span className="meta"> · {standing}</span> : null}
                </span>
                <InlineTool>
                  <InitialSelectionCell entryId={entry.id} roomId={a.roomId} />
                </InlineTool>
              </div>
            </div>
          );
        })}
        {hasRoomComposition(entry.roomAssignments) ? (
          <Tool inert={false}>
            <RoomCompositionSummary assignments={entry.roomAssignments ?? []} currency={currency} />
          </Tool>
        ) : null}
      </StepCard>
    </div>
  );
}

/* ------------------------------------------------------------------ keys */

type KeyRow = {
  roomId: string;
  roomNumber: string;
  stay: { nightCount: number; firstNight: string | null; label: string } | undefined;
  keyOut: boolean;
  keyReturned: boolean;
  /** Its key was lost and no new one has gone out yet (2026-10-30). */
  lost: boolean;
  lostNote: string | null;
  lostAt: string | null;
  vacated: boolean;
  /** The morning the guest left the room for good (vacated rooms only). */
  leftOn: string | null;
  movesInToday: boolean;
  movesInLater: boolean;
};

/** Every room of the plan with where its key stands — vacated rooms included while their key is
 * still out. The one reading the Keys tab, its count and This step's reminder all use. */
export function keyPlan(entry: EntryDetail, hotelToday: string | null): KeyRow[] {
  const stayByRoom = roomStayRangesByRoom(entry);
  const rows = entry.roomAssignments ?? [];
  // The stay's last morning: a room kept to it is left at check-out, not mid-stay (2026-11-10).
  const stayEnd = effectiveCheckOutIso(entry)?.slice(0, 10) ?? null;
  const byRoom = new Map<string, typeof rows>();
  for (const a of rows) byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), a]);
  const items = Array.from(byRoom.entries()).map(([roomId, rs]) => {
    const stay = stayByRoom.get(roomId);
    const keyOut = rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt && !r.keyLostAt);
    const lostRow = keyOut ? null : (rs.find((r) => r.keyLostAt) ?? null);
    const keyReturned = !keyOut && !lostRow && rs.some((r) => r.keyReturnedAt);
    // Vacated only once every range of the room has reached its move-out morning; never on a guess.
    // A room kept to the end of the stay is not vacated: on the check-out day its key comes back at
    // Check-out, not as a swap (2026-11-10, operator: the Keys card read both rooms "moved out" on
    // the guests' own check-out day).
    const runsToCheckout = rs.some((r) => !r.endDate || (stayEnd != null && String(r.endDate).slice(0, 10) >= stayEnd));
    const vacated = !!hotelToday && rs.length > 0 && !runsToCheckout && rs.every((r) => r.endDate && String(r.endDate).slice(0, 10) <= hotelToday);
    const leftOn = vacated ? rs.map((r) => String(r.endDate).slice(0, 10)).sort().pop() ?? null : null;
    return {
      roomId,
      roomNumber: rs[0].room?.roomNumber ?? roomId.slice(0, 8),
      stay,
      keyOut,
      keyReturned,
      lost: !!lostRow,
      lostNote: lostRow?.keyLostNote ?? null,
      lostAt: lostRow?.keyLostAt ?? null,
      vacated,
      leftOn,
      movesInToday: !!hotelToday && stay?.firstNight === hotelToday,
      movesInLater: !!hotelToday && !!stay?.firstNight && stay.firstNight > hotelToday,
    };
  });
  items.sort(
    (x, y) =>
      (x.stay?.firstNight ?? "9999").localeCompare(y.stay?.firstNight ?? "9999") || (y.stay?.nightCount ?? 0) - (x.stay?.nightCount ?? 0),
  );
  return items;
}

/**
 * The keys the desk owes a move today (2026-10-26, operator: room 304's key was never handed over
 * because the guest moved into it after check-in): a room the guest has left whose key is still
 * out, and a room the guest is in by now whose key never went out. Only on bookings whose keys
 * are kept room by room — one checked in before that kept a count alone, and reads nothing here.
 */
export function keysDue(entry: EntryDetail, hotelToday: string | null): { collect: string[]; handOver: string[] } {
  if (!hotelToday || entry.currentStage !== "S7") return { collect: [], handOver: [] };
  const stamped = (entry.roomAssignments ?? []).some((a) => a.keyIssuedAt);
  if (!stamped) return { collect: [], handOver: [] };
  const plan = keyPlan(entry, hotelToday);
  return {
    collect: plan.filter((k) => k.keyOut && k.vacated).map((k) => k.roomNumber),
    handOver: plan
      .filter((k) => !k.keyOut && !k.keyReturned && !k.vacated && !!k.stay?.firstNight && k.stay.firstNight <= hotelToday)
      .map((k) => k.roomNumber),
  };
}

/** What the desk owes, in words — the reminder on This step and the tab's hover. */
export function keysDueWords(due: { collect: string[]; handOver: string[] }): string[] {
  const rooms = (r: string[]) => `${r.length > 1 ? "Rooms" : "Room"} ${r.join(", ")}`;
  return [
    due.collect.length ? `${rooms(due.collect)} — the guest has moved out; take the key back` : null,
    due.handOver.length ? `${rooms(due.handOver)} — the guest is in it now; hand over the key` : null,
  ].filter(Boolean) as string[];
}

/** On This step only while a key is owed, so a move day is not missed (2026-10-26). */
export function KeysDueNotice({ entry, onOpen }: { entry: EntryDetail; onOpen: () => void }) {
  const hotelToday = useHotelDay()?.today ?? null;
  const due = useMemo(() => keysDue(entry, hotelToday), [entry, hotelToday]);
  const lines = keysDueWords(due);
  if (!lines.length) return null;
  return (
    <StepCard
      title="Keys to swap today"
      icon="key"
      status={
        <span className="stop-ink" role="status">
          {lines.join(" · ")}
        </span>
      }
      acts={
        <Button kind="secondary" compact icon="key" onClick={onOpen}>
          Open Keys
        </Button>
      }
    />
  );
}

export function KeysCard({ entry, emptyNote = false }: { entry: EntryDetail; /** Say so, rather than draw nothing, when there are no room keys to show (the Keys tab). */ emptyNote?: boolean }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const refresh = useRefreshEntry(entry.id);
  const hotelToday = useHotelDay()?.today ?? null;
  const plan = useMemo<KeyRow[]>(() => keyPlan(entry, hotelToday), [entry, hotelToday]);

  // Mirror of the backend's gate: rooms with no night in common are one party's sequential rooms,
  // so a key still out on any of them holds this room's key back — both ways.
  const blockersFor = (roomId: string) => {
    const rows = entry.roomAssignments ?? [];
    const ci = entry.checkInDate ? String(entry.checkInDate).slice(0, 10) : null;
    const co = entry.checkOutDate ? String(entry.checkOutDate).slice(0, 10) : null;
    const rangesFor = (id: string) =>
      rows
        .filter((a) => a.roomId === id)
        .map((a) => ({ start: a.startDate ? String(a.startDate).slice(0, 10) : ci, end: a.endDate ? String(a.endDate).slice(0, 10) : co }));
    const overlap = (x: { start: string | null; end: string | null }, y: { start: string | null; end: string | null }) =>
      !x.start || !x.end || !y.start || !y.end ? true : x.start < y.end && y.start < x.end;
    const target = rangesFor(roomId);
    return plan.filter((k) => {
      if (k.roomId === roomId || !k.keyOut) return false;
      return !rangesFor(k.roomId).some((o) => target.some((t) => overlap(t, o)));
    });
  };

  const issue = useMutation({
    mutationFn: (roomId: string) => issueRoomKey(session!, entry.id, roomId),
    onSuccess: (r) => {
      toast.success(`Key handed over · Room ${r.roomNumber}`);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The key could not be issued"),
  });
  const giveBack = useMutation({
    mutationFn: (roomId: string) => returnRoomKey(session!, entry.id, roomId),
    onSuccess: (r) => {
      toast.success(`Key back from Room ${r.roomNumber}`);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The key return could not be recorded"),
  });
  // A key lost while the guest is staying (2026-10-30): what happened is asked in a pop-up and kept
  // with the room; a new key can then be issued for it.
  const { tz } = useHotelClock(60_000);
  const [askLost, setAskLost] = useState<{ roomId: string; roomNumber: string } | null>(null);
  const loseKey = useMutation({
    mutationFn: (v: { roomId: string; note: string }) => declareRoomKeyLost(session!, entry.id, v.roomId, v.note),
    onSuccess: (r) => {
      setAskLost(null);
      toast.success(`Room ${r.roomNumber}'s key is recorded as lost — issue a new one when the guest needs it`);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The lost key could not be recorded"),
  });
  // The set is the server's decision; the toast says what it left out.
  const issueAll = useMutation({
    mutationFn: () => issueAllRoomKeys(session!, entry.id),
    onSuccess: (out) => {
      const n = out.issued.length;
      const notes = out.skipped
        .filter((s) => s.reason !== "ALREADY_OUT" && s.reason !== "LEFT")
        .map((s) =>
          s.reason === "PRIOR_ROOM_KEY_OUTSTANDING"
            ? `Room ${s.roomNumber} waits for Room ${s.blockedBy.map((b) => b.roomNumber).join(", ")}'s key to come back`
            : s.reason === "LEFT"
              ? `the guest has left Room ${s.roomNumber}`
              : `Room ${s.roomNumber}'s key comes on the move day${s.movesInOn ? ` · ${fmtDay(s.movesInOn)}` : ""}`,
        );
      if (n === 0) toast.info(notes.length ? `No key issued — ${notes.join(" · ")}` : "Every key is already with the guest");
      else {
        const what = `${plural(n, "key")} handed over · Room ${out.issued.map((i) => i.roomNumber).join(", ")}`;
        if (notes.length) toast.warning(`${what}. ${notes.join(" · ")}`, { duration: 10000 });
        else toast.success(what);
      }
      refresh();
    },
    onError: (e) => toastRefusal(e, "The keys could not be issued"),
  });

  const show = plan.length > 1 || plan.some((k) => k.keyOut || k.keyReturned);
  if (!show)
    return emptyNote ? <StepCard title="Keys" icon="key" status="No room keys are kept room by room on this booking — they were counted at check-in." /> : null;
  // The rooms the guest is in (or moves into later), and apart, the rooms they have left for good —
  // moved out, left early or taken off (2026-11-26, operator on LE4: "Issue all keys" offered the keys
  // of two rooms removed that morning). A room left with its key still out stays above: it is owed.
  const inUse = plan.filter((k) => !k.vacated || k.keyOut);
  const left = plan.filter((k) => k.vacated && !k.keyOut);
  const now = inUse.filter((k) => !k.vacated && !k.movesInLater);
  const withGuest = now.filter((k) => k.keyOut).length;
  const bulk = now.filter((k) => !k.keyOut && !k.lost && blockersFor(k.roomId).length === 0);
  const busy = issue.isPending || giveBack.isPending || issueAll.isPending || loseKey.isPending;
  const keyChip = (k: KeyRow) =>
    k.keyOut ? (
      <Chip tone="default" icon="key">
        with the guest
      </Chip>
    ) : k.lost ? (
      <Chip tone="warning" icon="key">
        lost
      </Chip>
    ) : k.keyReturned ? (
      <Chip tone="success" icon="check">
        back
      </Chip>
    ) : (
      <Chip tone="quiet">not issued</Chip>
    );

  return (
    <StepCard
      title="Keys"
      icon="key"
      meta="A room move is a key swap — take the old room's key back first; the new room's key will not issue while the old one is still out. The last key comes back at Check-out."
      status={
        <span className={withGuest === now.length ? "ok-ink" : "warn-ink"}>
          {withGuest} of {now.length} {now.length === 1 ? "room in use has its key" : "rooms in use have their key"} with the guest
        </span>
      }
      right={
        bulk.length >= 2 && !past ? (
          <Live>
            <Button
              className="go"
              compact
              icon="key"
              state={issueAll.isPending ? "working" : busy ? "inert" : "default"}
              workingLabel="Handing over…"
              title={`Room ${bulk.map((k) => k.roomNumber).join(", ")}`}
              onClick={() => issueAll.mutate()}
            >
              {`Hand over the ${bulk.length} keys`}
            </Button>
          </Live>
        ) : undefined
      }
    >
      <table className="table keys-table">
        <thead>
          <tr>
            <th>Room</th>
            <th>Nights</th>
            <th>Key</th>
            <th aria-label="Act" />
          </tr>
        </thead>
        <tbody>
          {inUse.map((k) => {
            const blockers = k.keyOut ? [] : blockersFor(k.roomId);
            const unlock = blockers.length ? `after Room ${blockers.map((b) => b.roomNumber).join(", ")}'s key is back` : null;
            const note =
              k.keyOut && k.vacated ? (
                <span className="sm stop-ink">The guest has moved out — take the key back</span>
              ) : unlock ? (
                <span className="sm warn-ink">Goes out {unlock}</span>
              ) : !k.keyOut && !k.keyReturned && !k.lost && k.movesInToday ? (
                <span className="sm warn-ink">The guest moves in today — hand over the key</span>
              ) : !k.keyOut && !k.keyReturned && k.movesInLater && k.stay?.firstNight ? (
                <span className="meta">Moves in {fmtDay(k.stay.firstNight)} — key on the move day</span>
              ) : k.lost ? (
                <span className="sm warn-ink">
                  Lost{k.lostAt ? ` ${fmtStamp(k.lostAt, tz)}` : ""}
                  {k.lostNote ? <> — &ldquo;{k.lostNote}&rdquo;</> : null}
                </span>
              ) : null;
            return (
              <tr key={k.roomId} data-key-room={k.roomNumber}>
                <td>
                  <b>Room {k.roomNumber}</b>
                  {note ? <div>{note}</div> : null}
                </td>
                <td className="sm">{k.stay?.label ?? "—"}</td>
                <td>{keyChip(k)}</td>
                <td className="keys-act">
                  {past ? null : k.keyOut ? (
                    <span className="row-acts">
                      {k.vacated ? (
                        <Button className="go" compact state={busy ? "inert" : "default"} onClick={() => giveBack.mutate(k.roomId)}>
                          Take the key back
                        </Button>
                      ) : null}
                      <Button kind="quiet" compact state={busy ? "inert" : "default"} onClick={() => setAskLost({ roomId: k.roomId, roomNumber: k.roomNumber })}>
                        Lost
                      </Button>
                    </span>
                  ) : k.movesInLater ? null : (
                    <Button
                      kind={k.keyReturned ? "quiet" : "secondary"}
                      compact
                      icon="key"
                      state={busy || unlock ? "inert" : "default"}
                      title={unlock ? `This key goes out ${unlock}` : undefined}
                      onClick={() => issue.mutate(k.roomId)}
                    >
                      {k.lost ? "Issue a new key" : k.keyReturned ? "Issue again" : "Hand over the key"}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
          {left.length ? (
            <tr className="keys-sep">
              <td colSpan={4}>Rooms the guest has left</td>
            </tr>
          ) : null}
          {left.map((k) => (
            <tr key={k.roomId} className="keys-left" data-key-room={k.roomNumber}>
              <td>
                <b>Room {k.roomNumber}</b>
                {k.lost && k.lostNote ? (
                  <div className="sm muted">
                    Lost — &ldquo;{k.lostNote}&rdquo;
                  </div>
                ) : null}
              </td>
              <td className="sm">{k.leftOn ? `Left ${fmtDay(k.leftOn)}` : (k.stay?.label ?? "—")}</td>
              <td>{keyChip(k)}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      <ReasonDialog
        open={!!askLost}
        onClose={() => setAskLost(null)}
        title={askLost ? `Room ${askLost.roomNumber}'s key is lost` : "A lost key"}
        lead="What happened is kept with this room. The key no longer counts as with the guest — issue a new one when they need it. Nothing is charged for it."
        reasonLabel="What happened to it"
        placeholder="left in a taxi in Thimphu"
        confirmLabel="Record the lost key"
        busy={loseKey.isPending}
        onConfirm={(note) => askLost && loseKey.mutate({ roomId: askLost.roomId, note: note.trim() })}
      />
    </StepCard>
  );
}

/* ------------------------------------------------------------------ flag a room deficient */

export function FlagDeficientDialog({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const refresh = useRefreshEntry(entry.id);
  const rooms = useMemo(
    () =>
      Array.from(new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)])))
        .map(([roomId, roomNumber]) => ({ roomId, roomNumber }))
        .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true })),
    [entry.roomAssignments],
  );
  const [roomId, setRoomId] = useState<string | null>(null);
  const chosen = rooms.find((r) => r.roomId === (roomId ?? rooms[0]?.roomId)) ?? null;
  return (
    <WideDialog
      open={open}
      onClose={onClose}
      register="report"
      title={chosen ? `Faults · Room ${chosen.roomNumber}` : "Faults"}
      width={640}
      help="Report a fault, or review one already raised. The room leaves sale the moment it is reported; the FOM verifies or rejects it. The guest is offered a move, and the fault is settled or acknowledged before check-out." 
      footer={<NotNow onClick={onClose} label="Close" />}
    >
      {rooms.length > 1 ? (
        <Choice options={rooms.map((r) => [r.roomId, `Room ${r.roomNumber}`] as const)} value={chosen?.roomId ?? null} onChange={setRoomId} />
      ) : null}
      {chosen ? (
        <div style={{ marginTop: 10 }}>
          <DeficiencyPanel
            key={chosen.roomId}
            target={{ roomId: chosen.roomId }}
            targetLabel={`Room ${chosen.roomNumber}`}
            onChanged={() => refresh([["rooms"], ["rooms-catalog"]])}
          />
        </div>
      ) : (
        <span className="meta">No room on this booking to report.</span>
      )}
    </WideDialog>
  );
}
