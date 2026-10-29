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
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system/components/primitives";
import { useSession } from "@/hooks/use-session";
import { chooseBookingRoom, getArrivalRoomChoices, type ArrivalRoomChoice } from "@/lib/api/booking-rooms";
import { changeBookingRoom } from "@/lib/api/entries";
import type { EntryDetail } from "@/types/api";
import { DsDialog, toastRefusal } from "./kit";

const first = (s: string) => s.replace(/ \(ENT-[^)]+\)$/, "");

export function ArrivalRoomDialog({
  entry,
  roomId,
  name,
  onClose,
  onChanged,
}: {
  entry: EntryDetail;
  /** The room double-clicked; null when the dialog is shut. */
  roomId: string | null;
  /** "Standard Double · room 1 — Room 303" or "Room 303". */
  name: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const open = !!roomId;
  const q = useQuery({
    queryKey: ["arrival-room-choices", entry.id, roomId, entry.updatedAt],
    queryFn: () => getArrivalRoomChoices(session!, entry.id, roomId!),
    enabled: !!session && open,
    staleTime: 5_000,
  });
  const data = q.data ?? null;
  const [toRoom, setToRoom] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    setToRoom(null);
    setReason("");
  }, [roomId]);
  const chosen: ArrivalRoomChoice | null = data?.choices.find((c) => c.roomId === toRoom) ?? null;
  const handedOut = data?.mode === "ROOM_CHANGE";

  const give = useMutation({
    mutationFn: async () => {
      if (handedOut) {
        return changeBookingRoom(session!, entry.id, { fromRoomId: roomId!, toRoomId: toRoom!, reason: reason.trim(), makeWay: true });
      }
      return chooseBookingRoom(session!, entry.id, { fromRoomId: roomId!, toRoomId: toRoom! });
    },
    onSuccess: (res) => {
      const moved = chosen?.moves ?? [];
      toast.success(
        `Room ${chosen?.roomNumber} is this booking's now` +
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

  const why = !chosen ? "pick a room first" : !chosen.available ? "that room cannot be given" : handedOut && !reason.trim() ? "type why first" : null;

  return (
    <DsDialog
      open={open}
      onClose={onClose}
      busy={give.isPending}
      title={`Another ${data?.typeName ?? "room"} for ${name}`}
      caseLines={[entry.id]}
      help={
        <>
          <p>Every other room of this type for the room&rsquo;s nights, and what taking it does.</p>
          <p>
            A room another booking holds only as the system&rsquo;s choice can be taken: Arrival comes first, and that booking moves to
            another room of the same type — same rate, nothing sent to its guest. A room chosen by number, or already handed out, cannot.
          </p>
          {handedOut ? <p>The rooms are already handed out, so this is a room change: the booking is priced again (the same rate), its papers are made again and held for you, and it comes back here.</p> : null}
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
            onClick={() => !why && give.mutate()}
          >
            {chosen ? `Give it Room ${chosen.roomNumber}` : "Give it the room"}
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
                className={`rt-opt${on ? " on" : ""}${shut ? " shut" : ""}`}
                disabled={shut || give.isPending}
                onClick={() => setToRoom(c.roomId)}
              >
                <span className="rt-dot" aria-hidden />
                <span className="rt-name">
                  Room {c.roomNumber}
                  {takes ? (
                    <small> · {c.moves.map((m) => `${first(m.booking)}'s — they move to Room ${m.toRoomNumber}`).join(", ")}</small>
                  ) : shut ? (
                    <small> · {c.words}</small>
                  ) : null}
                  {c.fault ? <small className="warn-ink"> · a fault is reported on it</small> : null}
                </span>
                <span className={`rt-free ${shut ? "none" : takes ? "few" : "plenty"}`}>{shut ? "held" : takes ? "taken from them" : "free"}</span>
                <span />
              </button>
            );
          })}
        </div>
      )}
      {handedOut ? (
        <div className="field" style={{ marginTop: 10 }}>
          <label>Why</label>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="the guest asked for this room" />
        </div>
      ) : null}
    </DsDialog>
  );
}
