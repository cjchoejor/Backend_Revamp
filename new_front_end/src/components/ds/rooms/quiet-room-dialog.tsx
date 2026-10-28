"use client";

/**
 * A room the system chose, dragged onto another room of its type on the same nights (2026-10-28,
 * docs/room-types-until-arrival.md). Before Arrival that is no room move: the desk is choosing which
 * room of the type the guest gets. The room is given and FIXED — the system will not move it again —
 * and the booking's setup, price and papers stay as they are. Nothing reaches the guest.
 *
 * A move to another type, other dates, or onto another booking's room is still the room move.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { chooseBookingRoom, getBookingRooms } from "@/lib/api/booking-rooms";
import { DsDialog, toastRefusal } from "@/components/ds/steps/kit";

export type QuietPick = {
  entryId: string;
  fromRoomId: string;
  toRoomId: string;
  toRoomNumber: string;
  guest: string;
};

export function QuietRoomDialog({ pick, onClose, onDone }: { pick: QuietPick | null; onClose: () => void; onDone: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const rooms = useQuery({
    queryKey: ["booking-rooms", pick?.entryId, "chart"],
    queryFn: () => getBookingRooms(session!, pick!.entryId),
    enabled: !!session && !!pick,
  });
  const name = rooms.data?.rooms.find((r) => r.roomId === pick?.fromRoomId)?.label ?? "This room";
  const m = useMutation({
    mutationFn: () => chooseBookingRoom(session!, pick!.entryId, { fromRoomId: pick!.fromRoomId, toRoomId: pick!.toRoomId }),
    onSuccess: (res) => {
      toast.success(`${pick!.guest}: ${name} → Room ${pick!.toRoomNumber}, kept for the guest. Nothing else changed.`);
      if (res?.othersMoved)
        toast.info(`${res.othersMoved === 1 ? "Another booking's room" : `${res.othersMoved} other bookings' rooms`} moved to make way — nothing of theirs changed.`);
      void qc.invalidateQueries({ queryKey: ["booking-rooms", pick!.entryId] });
      onDone();
    },
    onError: (e) => toastRefusal(e, "That room could not be given"),
  });
  return (
    <DsDialog
      open={!!pick}
      onClose={() => !m.isPending && onClose()}
      title={`Give ${name} Room ${pick?.toRoomNumber ?? ""}?`}
      caseLines={pick ? [<b key="g">{pick.guest}</b>, pick.entryId] : undefined}
      busy={m.isPending}
      footer={
        <>
          <Button kind="quiet" state={m.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button className="go" state={m.isPending ? "working" : "default"} workingLabel="Giving it the room…" onClick={() => m.mutate()}>
            Give it Room {pick?.toRoomNumber}
          </Button>
        </>
      }
    >
      <p className="sm">
        The system chose this room and may move it to another of its type until the rooms are assigned at Arrival. Giving
        it Room {pick?.toRoomNumber} <b>fixes it there</b>. The booking&apos;s setup, price and papers stay as they are, and
        nothing is sent to the guest.
      </p>
    </DsDialog>
  );
}
