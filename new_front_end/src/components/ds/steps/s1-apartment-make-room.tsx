"use client";

/**
 * Make room in an apartment (2026-11-25, operator: "here when rooms are taken, when I click it, can I
 * have the option to move the booking in the room already staying inside this so I can accommodate the
 * new guest here").
 *
 * The pop-up names each booking holding one of the apartment's rooms over this stay, and for each the
 * rooms free for their nights (the server's: `GET /entries/:id/apartments/:unitId/holders`), same type
 * first. "Move their booking" hands the picks to the room move (`RoomMoveDialog`, `POST /room-moves`):
 * their booking walks its own new pass back to its step, keeps its price for the same type, and its
 * papers are made again and held. Nothing changes for this booking until the apartment is ticked.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { RoomMoveDialog } from "@/components/ds/rooms/room-move-dialog";
import { useSession } from "@/hooks/use-session";
import { getApartmentHolders, type ApartmentHolder } from "@/lib/api/apartments";
import type { RoomMoveLegInput } from "@/lib/api/room-moves";
import { fmtDay } from "@/lib/ds/format";
import { STEP_NAMES } from "@/lib/ds/steps";
import { DsDialog } from "./kit";

const stepWord = (stage: string) => STEP_NAMES[Number(stage.replace(/\D/g, "")) - 1] ?? stage;
const keyOf = (roomId: string, h: ApartmentHolder) => `${roomId}|${h.entryId}`;

export function MakeRoomDialog({ entryId, unitId, label, onClose }: { entryId: string; unitId: string; label: string; onClose: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["apartment-holders", entryId, unitId],
    queryFn: () => getApartmentHolders(session!, entryId, unitId),
    enabled: !!session,
    staleTime: 0,
  });
  const d = q.data;
  /** The room picked for each booking in each room — nothing until the desk picks. */
  const [to, setTo] = useState<Record<string, string>>({});
  const [legs, setLegs] = useState<RoomMoveLegInput[] | null>(null);

  const held = useMemo(() => (d?.rooms ?? []).flatMap((r) => r.heldBy.map((h) => ({ room: r, h }))), [d]);
  const shut = held.filter(({ h }) => !h.swappable);
  const blocked = (d?.rooms ?? []).filter((r) => r.outOfService);
  const unpicked = held.filter(({ room, h }) => h.swappable && !to[keyOf(room.roomId, h)]);
  const why = !d
    ? "Reading who is in it…"
    : held.length === 0
      ? "Nobody holds it for these nights any more"
      : blocked.length
        ? `Room ${blocked[0]!.roomNumber} is out of service — ${blocked[0]!.outOfService}`
        : shut.length
          ? `Room ${shut[0]!.room.roomNumber}: ${shut[0]!.h.why}`
          : unpicked.length
            ? `Pick a room for ${unpicked[0]!.h.guestName ?? unpicked[0]!.h.entryId}`
            : null;

  const move = () =>
    setLegs(held.map(({ room, h }) => ({ entryId: h.entryId, fromRoomId: room.roomId, toRoomId: to[keyOf(room.roomId, h)]! })));

  return (
    <>
      <DsDialog
        open={!legs}
        onClose={onClose}
        closeX
        title={`Make room in apartment ${label}`}
        help={
          <>
            <p>
              The booking holding the apartment moves to another room for its own nights, through the room move: it goes back a step and comes
              back to where it was, keeps its price for a room of the same type, and its papers are made again and held for the desk to send or
              not. Another type asks whether it keeps its price.
            </p>
            <p>Nothing changes for this booking until the apartment is ticked and saved.</p>
          </>
        }
        footer={
          <>
            {why ? <span className={shut.length || blocked.length ? "stop-ink" : "meta"}>{why}</span> : null}
            <Button kind="secondary" onClick={onClose}>
              Close
            </Button>
            <Button kind="primary" className={why ? undefined : "go"} state={why ? "inert" : "default"} reason={why ?? undefined} onClick={move}>
              {held.length > 1 ? "Move their bookings" : "Move their booking"}
            </Button>
          </>
        }
        width={640}
      >
        {q.isError ? <p className="stop-ink">Who holds it could not be read</p> : null}
        {d ? (
          <div className="make-room">
            <p className="meta">
              For {fmtDay(d.stay.checkInDate)} → {fmtDay(d.stay.checkOutDate)} · {d.unit.packageName}
            </p>
            {d.rooms.map((r) => (
              <div key={r.roomId} className="make-room-room">
                <div className="make-room-head">
                  <b>Room {r.roomNumber}</b>
                  {r.outOfService ? <span className="stop-ink">out of service — {r.outOfService}</span> : r.heldBy.length ? null : <span className="ok-ink">free</span>}
                </div>
                {r.heldBy.map((h) => {
                  const k = keyOf(r.roomId, h);
                  // A free room picked for another booking here is not offered again.
                  const taken = new Set(Object.entries(to).filter(([kk]) => kk !== k).map(([, v]) => v));
                  const open = h.rooms.filter((x) => !taken.has(x.roomId));
                  const same = open.filter((x) => x.sameType);
                  const other = open.filter((x) => !x.sameType);
                  return (
                    <div key={h.entryId} className="make-room-who">
                      <div>
                        <b>{h.guestName ?? h.entryId}</b>
                        {h.partyName ? <span> · {h.partyName}</span> : null}
                        <span className="meta">
                          {" "}
                          · {h.entryId} · at {stepWord(h.stage)}
                          {h.nightsInRoom.length
                            ? ` · in this room ${fmtDay(h.nightsInRoom[0]!)} → ${fmtDay(h.checkOut ?? h.nightsInRoom[h.nightsInRoom.length - 1]!)}`
                            : h.checkIn && h.checkOut
                              ? ` · ${fmtDay(h.checkIn)} → ${fmtDay(h.checkOut)}`
                              : ""}
                        </span>
                      </div>
                      {h.swappable ? (
                        <div className="field make-room-to">
                          <label>Move them to</label>
                          <select className="input" value={to[k] ?? ""} onChange={(e) => setTo((cur) => ({ ...cur, [k]: e.target.value }))}>
                            <option value="">Pick a free room…</option>
                            {same.length ? (
                              <optgroup label="Same type — keeps their price">
                                {same.map((x) => (
                                  <option key={x.roomId} value={x.roomId}>
                                    Room {x.roomNumber} · {x.roomTypeName}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                            {other.length ? (
                              <optgroup label="Another type — the FOM's, the price is asked">
                                {other.map((x) => (
                                  <option key={x.roomId} value={x.roomId}>
                                    Room {x.roomNumber} · {x.roomTypeName}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                          </select>
                        </div>
                      ) : (
                        <p className="stop-ink make-room-why" role="alert">
                          {h.why}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            <Help label="What the room move does">
              Each booking moved walks its own new pass and comes back to its step, its papers made again and held. A move to another type, or
              moving two bookings at once, is the FOM&rsquo;s.
            </Help>
          </div>
        ) : null}
      </DsDialog>
      <RoomMoveDialog
        legs={legs}
        onClose={() => {
          setLegs(null);
          // Whether it ran or not, read the apartments again: this one may be free now.
          void qc.invalidateQueries({ queryKey: ["entry-apartments", entryId] });
          void qc.invalidateQueries({ queryKey: ["apartment-holders", entryId] });
          onClose();
        }}
      />
    </>
  );
}
