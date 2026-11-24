"use client";

/**
 * Arrival gives one of the booking's rooms a particular room of its type (2026-10-29, operator:
 * "when double clicking, it should show the available rooms for that room type … this is the part
 * where the user sees the other bookings and assigns the room"; "say another booking reserved the
 * room type Standard Double and the system picked 303 … due to the guest's request the user picked
 * room 303 — the system should prioritize this since it is Arrival … and smart switch the rooms").
 *
 * The rooms and what taking each would do are the server's (`GET …/arrival-room-choices`): free; held
 * as another booking's system choice — that booking moves to another room of the type; held for a
 * booking that cannot be moved (chosen by number, already handed out). Before the rooms are handed
 * out the act is the quiet choice (the room becomes fixed, nothing priced again); after, it is the
 * room change — a new pass, the papers made again and held — with the other booking moved first.
 *
 * A room held for another booking — chosen by number, already handed out, or with nowhere else to go —
 * can be SWAPPED (2026-11-24, operator: "a swap feature of rooms there … make sure nothing breaks and
 * everything is well audited and properly allocated with money taken properly"): this booking takes it
 * and that booking takes the room this one leaves. It is the house chart's governed room move
 * (`RoomMoveDialog`, `POST /room-moves`): each booking walks its own new pass and comes back to its
 * step, the agreed price kept (a change of type asks which), the papers made again and held, every
 * step traced on both bookings, the FOM's call.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system/components/primitives";
import { useSession } from "@/hooks/use-session";
import { chooseBookingRoom, getArrivalRoomChoices, type ArrivalRoomChoice } from "@/lib/api/booking-rooms";
import { changeBookingRoom } from "@/lib/api/entries";
import type { EntryDetail } from "@/types/api";
import { fmtDay } from "@/lib/ds/format";
import { DsDialog, toastRefusal } from "./kit";
import { RoomMoveDialog } from "@/components/ds/rooms/room-move-dialog";
import type { RoomMoveLegInput } from "@/lib/api/room-moves";

const first = (s: string) => s.replace(/ \(ENT-[^)]+\)$/, "");

export function ArrivalRoomDialog({
  entry,
  roomId,
  night = null,
  roomNights = [],
  name,
  onClose,
  onChanged,
}: {
  entry: EntryDetail;
  /** The room double-clicked; null when the dialog is shut. */
  roomId: string | null;
  /**
   * The night picked in the table's night list (2026-10-29, operator: "I changed the room … by
   * choosing night one from the drop down, but it also changed night two"): the new room is for that
   * night only, the guest keeping this room on its other nights. Null — every night.
   */
  night?: string | null;
  /** The nights the room is the booking's — the other nights keep it on a change of one night. */
  roomNights?: string[];
  /** "Standard Double · room 1 — Room 303" or "Room 303". */
  name: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const open = !!roomId;
  /** The swap, open in the room-move box (2026-11-24). */
  const [swapLegs, setSwapLegs] = useState<RoomMoveLegInput[] | null>(null);
  const q = useQuery({
    queryKey: ["arrival-room-choices", entry.id, roomId, night, entry.updatedAt],
    queryFn: () => getArrivalRoomChoices(session!, entry.id, roomId!, night ? [night] : null),
    // Not while a swap runs: the room may be the other booking's a moment later (2026-11-24).
    enabled: !!session && open && !swapLegs,
    staleTime: 5_000,
  });
  const data = q.data ?? null;
  const [toRoom, setToRoom] = useState<string | null>(null);
  useEffect(() => {
    setToRoom(null);
    setSwapLegs(null);
  }, [roomId]);
  const chosen: ArrivalRoomChoice | null = data?.choices.find((c) => c.roomId === toRoom) ?? null;
  const handedOut = data?.mode === "ROOM_CHANGE";
  const oneNight = !!night && roomNights.length > 1;

  const give = useMutation({
    mutationFn: async () => {
      if (oneNight) {
        // That night in the new room, every other night kept as it is.
        const perNight = roomNights.map((d) => ({ date: d, roomId: d === night ? toRoom! : roomId! }));
        return changeBookingRoom(session!, entry.id, { fromRoomId: roomId!, perNight, makeWay: true });
      }
      if (handedOut) {
        return changeBookingRoom(session!, entry.id, { fromRoomId: roomId!, toRoomId: toRoom!, makeWay: true });
      }
      return chooseBookingRoom(session!, entry.id, { fromRoomId: roomId!, toRoomId: toRoom! });
    },
    onSuccess: (res) => {
      const moved = chosen?.moves ?? [];
      toast.success(
        `Room ${chosen?.roomNumber} is this booking's ${oneNight ? `on ${fmtDay(night!)}` : "now"}` +
          (moved.length ? ` — ${moved.map((m) => `${first(m.booking)} moves to Room ${m.toRoomNumber}`).join(", ")}` : ""),
        { duration: 9000 },
      );
      const walk = (res as { walk?: { returnedToOrigin: boolean; blocked?: { message: string } | null } }).walk;
      const held = (res as { heldDocuments?: Array<{ kind: string }> }).heldDocuments ?? [];
      if (held.length) toast.info("The papers were made again for the change — send them to the guest, or not.", { duration: 9000 });
      if (walk && !walk.returnedToOrigin) toast.warning(`The booking stopped on the way back: ${walk.blocked?.message ?? "a later step refused"}`, { duration: 12000 });
      onChanged();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The room could not be given"),
  });

  // A held room is swapped, not given; a swap trades whole rooms, so it is not offered for one night.
  const swap = !!chosen && !chosen.available;
  const why = !chosen ? "pick a room first" : swap && oneNight ? "a swap trades the whole room — pick All nights in the table" : null;

  return (
    <>
    <DsDialog
      open={open}
      onClose={onClose}
      busy={give.isPending}
      title={`Another ${data?.typeName ?? "room"} for ${name}${oneNight ? ` on ${fmtDay(night!)}` : ""}`}
      caseLines={[entry.id]}
      help={
        <>
          <p>Every other room of this type for the room&rsquo;s nights, and what taking it does.</p>
          <p>
            A room another booking holds only as the system&rsquo;s choice can be taken: Arrival comes first, and that booking moves to
            another room of the same type — same rate, nothing sent to its guest. A room chosen by number, or already handed out, cannot.
          </p>
          {oneNight ? (
            <p>
              Only {fmtDay(night!)} is changed — the night picked in the table. The guest keeps this room on its other nights. Pick All
              nights in the table to change every night.
            </p>
          ) : null}
          {handedOut ? <p>This is a room change: the booking is priced again (the same rate), its papers are made again and held for you, and it comes back here.</p> : null}
          <p>
            A room held for another booking can be swapped: this booking takes it, and theirs takes the room this one leaves. Each is
            priced again at the rate it agreed, its papers made again and held, and both come back to their step. It is the FOM&rsquo;s
            call, and both bookings&rsquo; history says it.
          </p>
        </>
      }
      footer={
        <>
          <Button kind="quiet" state={give.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            className={why ? undefined : "go"}
            state={give.isPending ? "working" : why ? "inert" : "default"}
            reason={why ?? undefined}
            workingLabel="Giving the room…"
            onClick={() => {
              if (why || !chosen) return;
              if (swap) setSwapLegs([{ entryId: entry.id, fromRoomId: roomId!, toRoomId: chosen.roomId }]);
              else give.mutate();
            }}
          >
            {chosen ? (swap ? `Swap rooms with them` : `Give it Room ${chosen.roomNumber}`) : "Give it the room"}
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <p className="meta">Asking the house which rooms can be given…</p>
      ) : q.isError ? (
        <p className="stop-ink sm" role="alert">The house could not be asked — close this and try again.</p>
      ) : (data?.choices ?? []).length === 0 ? (
        <p className="sm">There is no other room of this type.</p>
      ) : (
        <div className="rt-options" role="radiogroup" aria-label="The rooms of this type">
          {data!.choices.map((c) => {
            const on = c.roomId === toRoom;
            const shut = !c.available;
            const takes = c.moves.length > 0;
            return (
              <button
                key={c.roomId}
                type="button"
                role="radio"
                aria-checked={on}
                className={`rt-opt${on ? " on" : ""}${shut ? " swap" : ""}`}
                disabled={give.isPending}
                onClick={() => setToRoom(c.roomId)}
              >
                <span className="rt-dot" aria-hidden />
                <span className="rt-name">
                  Room {c.roomNumber}
                  {takes ? (
                    <small> · {c.moves.map((m) => `${first(m.booking)}'s — they move to Room ${m.toRoomNumber}`).join(", ")}</small>
                  ) : shut ? (
                    <small> · {c.words} · pick it to swap rooms with them</small>
                  ) : null}
                  {c.fault ? <small className="warn-ink"> · a fault is reported on it</small> : null}
                </span>
                <span className={`rt-free ${shut ? "none" : takes ? "few" : "plenty"}`}>{shut ? "held · swap" : takes ? "taken from them" : "free"}</span>
                <span />
              </button>
            );
          })}
        </div>
      )}
      {swap && !oneNight ? (
        <p className="sm" style={{ marginTop: 10 }}>
          <b>A swap</b> — Room {chosen!.roomNumber} is held for another booking. This booking takes it, and that booking takes this room. The
          next box shows both bookings, what each is priced at, and asks why.
        </p>
      ) : null}
      {oneNight ? (
        <p className="sm" style={{ marginTop: 10 }}>
          <b>{fmtDay(night!)} only</b> — the other {roomNights.length - 1 === 1 ? "night stays" : `${roomNights.length - 1} nights stay`} in this room.
        </p>
      ) : null}
    </DsDialog>
      <RoomMoveDialog
        legs={swapLegs}
        onClose={() => {
          // Whether it ran or not, read the booking again; the room double-clicked may be the other booking's now.
          setSwapLegs(null);
          onChanged();
          onClose();
        }}
      />
    </>
  );
}
