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
import { issueAllRoomKeys, issueRoomKey, returnRoomKey } from "@/lib/api/entries";
import { roomStayRangesByRoom } from "@/lib/desk/party-rooms";
import { fmtDay, plural } from "@/lib/ds/format";
import { DeficiencyPanel } from "@/components/deficiency/deficiency-panel";
import { RoomCompositionSummary, hasRoomComposition } from "@/components/desk/workspace/room-composition-summary";
import { BedTypeEditor, ExtraBedEditor, InitialSelectionCell, RoomChangeControl } from "@/components/desk/workspace/room-change-control";
import type { EntryDetail } from "@/types/api";
import { Choice, Live, StepCard, Tool, toastRefusal, useRefreshEntry, useStepMode } from "./kit";
import { InlineTool, WideDialog, claimWord, physicalWord } from "./s6-shared";

/* ------------------------------------------------------------------ rooms in use */

export function RoomsInUseCard({ entry, id }: { entry: EntryDetail; id: string }) {
  const refresh = useRefreshEntry(entry.id);
  const hotelToday = useHotelDay()?.today ?? null;
  const stay = useMemo(() => roomStayRangesByRoom(entry), [entry]);

  // Rooms whose row is still current (an in-house move end-dates the old room at tonight, so it
  // drops off here while its slept nights stay billed). Until the hotel's day is known, every room.
  const rooms = useMemo(() => {
    const rows = (entry.roomAssignments ?? []).filter((a) => !a.endDate || !hotelToday || String(a.endDate).slice(0, 10) > hotelToday);
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
        meta="A move to another room of the same type is the desk's; a different type is the FOM's and re-prices the stay from tonight. The nights already slept stay on the old room."
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
                  <BedTypeEditor roomId={a.roomId} entryId={entry.id} />
                  <ExtraBedEditor entry={entry} roomId={a.roomId} onChanged={onChanged} />
                </InlineTool>
              </div>
              <Live>
                <Tool>
                  <RoomChangeControl entry={entry} fromRoomId={a.roomId} fromRoomNumber={number} onChanged={onChanged} compact />
                </Tool>
              </Live>
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
  vacated: boolean;
  movesInToday: boolean;
  movesInLater: boolean;
};

export function KeysCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const refresh = useRefreshEntry(entry.id);
  const hotelToday = useHotelDay()?.today ?? null;
  const stayByRoom = useMemo(() => roomStayRangesByRoom(entry), [entry]);

  // Every room of the plan, vacated ones included while their key is still out.
  const plan = useMemo<KeyRow[]>(() => {
    const rows = entry.roomAssignments ?? [];
    const byRoom = new Map<string, typeof rows>();
    for (const a of rows) byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), a]);
    const items = Array.from(byRoom.entries()).map(([roomId, rs]) => {
      const stay = stayByRoom.get(roomId);
      const keyOut = rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt);
      const keyReturned = !keyOut && rs.some((r) => r.keyReturnedAt);
      // Vacated only once every range of the room has reached its move-out morning; never on a guess.
      const vacated = !!hotelToday && rs.length > 0 && rs.every((r) => r.endDate && String(r.endDate).slice(0, 10) <= hotelToday);
      return {
        roomId,
        roomNumber: rs[0].room?.roomNumber ?? roomId.slice(0, 8),
        stay,
        keyOut,
        keyReturned,
        vacated,
        movesInToday: !!hotelToday && stay?.firstNight === hotelToday,
        movesInLater: !!hotelToday && !!stay?.firstNight && stay.firstNight > hotelToday,
      };
    });
    items.sort(
      (x, y) =>
        (x.stay?.firstNight ?? "9999").localeCompare(y.stay?.firstNight ?? "9999") || (y.stay?.nightCount ?? 0) - (x.stay?.nightCount ?? 0),
    );
    return items;
  }, [entry.roomAssignments, stayByRoom, hotelToday]);

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
  // The set is the server's decision; the toast says what it left out.
  const issueAll = useMutation({
    mutationFn: () => issueAllRoomKeys(session!, entry.id),
    onSuccess: (out) => {
      const n = out.issued.length;
      const notes = out.skipped
        .filter((s) => s.reason !== "ALREADY_OUT")
        .map((s) =>
          s.reason === "PRIOR_ROOM_KEY_OUTSTANDING"
            ? `Room ${s.roomNumber} waits for Room ${s.blockedBy.map((b) => b.roomNumber).join(", ")}'s key to come back`
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
  if (!show) return null;
  const bulk = plan.filter((k) => !k.keyOut && !k.movesInLater && blockersFor(k.roomId).length === 0);
  const busy = issue.isPending || giveBack.isPending || issueAll.isPending;

  return (
    <StepCard
      title="Keys"
      icon="key"
      meta="A room move is a key swap — take the old room's key back first; the new room's key will not issue while the old one is still out. The last key comes back at Check-out."
    >
      {plan.length > 1 ? (
        <div className="bind provisional" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 12px", marginBottom: 6 }}>
          <span className="sm">
            {plan.filter((k) => k.keyOut).length} of {plural(plan.length, "key")} with the guest
            {bulk.length ? <span className="meta"> · {bulk.length} ready to hand over</span> : null}
          </span>
          <Live>
            <Button
              kind="secondary"
              compact
              icon="key"
              state={issueAll.isPending ? "working" : bulk.length === 0 || busy ? "inert" : "default"}
              title={
                bulk.length === 0
                  ? "No key can go out now — each is with the guest, waiting on a swap, or waiting for its move day"
                  : `Hand over Room ${bulk.map((k) => k.roomNumber).join(", ")}'s key${bulk.length === 1 ? "" : "s"} in one go`
              }
              workingLabel="Issuing…"
              onClick={() => issueAll.mutate()}
            >
              Issue all keys
            </Button>
          </Live>
        </div>
      ) : null}
      {plan.map((k) => {
        const blockers = k.keyOut ? [] : blockersFor(k.roomId);
        const unlock = blockers.length ? `after Room ${blockers.map((b) => b.roomNumber).join(", ")}'s key is back` : null;
        const note =
          k.keyOut && k.vacated ? (
            <span className="sm warn-ink">The guest has moved out of this room — collect its key</span>
          ) : unlock ? (
            <span className="sm warn-ink">This key goes out {unlock}</span>
          ) : !k.keyOut && !k.keyReturned && k.movesInToday ? (
            <span className="sm warn-ink">The guest moves in today — hand over the key</span>
          ) : !k.keyOut && !k.keyReturned && k.movesInLater && k.stay?.firstNight ? (
            <span className="meta">Moves in {fmtDay(k.stay.firstNight)} — key on the move day</span>
          ) : null;
        return (
          <div
            key={k.roomId}
            style={{ borderTop: "1px solid var(--line)", padding: "8px 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}
          >
            <span style={{ display: "grid", gap: 2 }}>
              <span className="sm">
                <b>Room {k.roomNumber}</b>
                {k.stay ? <span className="meta"> · {k.stay.label}</span> : null}
              </span>
              {note}
            </span>
            <span className="row-acts" style={{ alignItems: "center" }}>
              {k.keyOut ? (
                <>
                  <Chip tone="default" icon="key">
                    with the guest
                  </Chip>
                  {k.vacated && !past ? (
                    <Button kind="secondary" compact state={busy ? "inert" : "default"} onClick={() => giveBack.mutate(k.roomId)}>
                      Take the key back
                    </Button>
                  ) : null}
                </>
              ) : k.keyReturned ? (
                <>
                  <Chip tone="success" icon="check">
                    key returned
                  </Chip>
                  {past ? null : (
                    <Button kind="quiet" compact state={busy || unlock ? "inert" : "default"} title={unlock ? `This key goes out ${unlock}` : undefined} onClick={() => issue.mutate(k.roomId)}>
                      Issue again
                    </Button>
                  )}
                </>
              ) : past ? (
                <Chip tone="quiet">not issued</Chip>
              ) : (
                <Button kind="secondary" compact icon="key" state={busy || unlock ? "inert" : "default"} title={unlock ? `This key goes out ${unlock}` : undefined} onClick={() => issue.mutate(k.roomId)}>
                  Issue the key
                </Button>
              )}
            </span>
          </div>
        );
      })}
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
      footer={
        <Button kind="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="sm" style={{ marginTop: 0 }}>
        Report a fault, or review one already raised. The room leaves sale the moment it is reported; the FOM verifies or rejects it. The guest is offered a move, and the fault is settled or acknowledged before check-out.
      </p>
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
