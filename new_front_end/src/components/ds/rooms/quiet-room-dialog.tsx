"use client";

/**
 * Rooms the system chose, dragged onto other rooms of their type on the same nights (2026-10-28,
 * docs/room-types-until-arrival.md). Before Arrival that is no room move: the desk is choosing which
 * rooms of the type the guest gets. One room or several at once; a room another booking holds only
 * as the system's choice may be taken — that booking is moved to another room of the type. Each room
 * given is FIXED — the system will not move it again — and the booking's setup, price and papers stay
 * as they are. Nothing reaches the guest.
 *
 * A move to another type, other dates, or onto a room another booking holds for certain is still the
 * room move.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { chooseBookingRooms, getBookingRooms } from "@/lib/api/booking-rooms";
import { DsDialog, toastRefusal } from "@/components/ds/steps/kit";

export type QuietPick = {
  entryId: string;
  guest: string;
  picks: Array<{ fromRoomId: string; fromRoomNumber: string; toRoomId: string; toRoomNumber: string }>;
  /** Other bookings holding a chosen room only as the system's choice — moved out of the way. */
  inWay: Array<{ guest: string; roomNumber: string }>;
};

export function QuietRoomDialog({ pick, onClose, onDone }: { pick: QuietPick | null; onClose: () => void; onDone: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const rooms = useQuery({
    queryKey: ["booking-rooms", pick?.entryId, "chart"],
    queryFn: () => getBookingRooms(session!, pick!.entryId),
    enabled: !!session && !!pick,
  });
  // The booking's own name for the room ("Deluxe Double · room 1"), the chart's row until it is read.
  const nameOf = (roomId: string) =>
    rooms.data?.rooms.find((r) => r.roomId === roomId)?.label ?? `Room ${pick?.picks.find((p) => p.fromRoomId === roomId)?.fromRoomNumber ?? "?"}`;
  const many = (pick?.picks.length ?? 0) > 1;
  const m = useMutation({
    mutationFn: () => chooseBookingRooms(session!, pick!.entryId, pick!.picks.map(({ fromRoomId, toRoomId }) => ({ fromRoomId, toRoomId }))),
    onSuccess: (res) => {
      toast.success(
        `${pick!.guest}: ${pick!.picks.map((p) => `${nameOf(p.fromRoomId)} → Room ${p.toRoomNumber}`).join(" · ")}, kept for the guest. Nothing else changed.`,
        { duration: 9000 },
      );
      if (res?.othersMoved)
        toast.info(`${res.othersMoved === 1 ? "Another booking's room" : `${res.othersMoved} other bookings' rooms`} moved to make way — nothing of theirs changed.`);
      void qc.invalidateQueries({ queryKey: ["booking-rooms", pick!.entryId] });
      onDone();
    },
    onError: (e) => toastRefusal(e, many ? "Those rooms could not be given" : "That room could not be given"),
  });
  const toWords = pick?.picks.map((p) => `Room ${p.toRoomNumber}`).join(" and ") ?? "";
  return (
    <DsDialog
      open={!!pick}
      onClose={() => !m.isPending && onClose()}
      title={many ? `Give these rooms ${toWords}?` : `Give ${nameOf(pick?.picks[0]?.fromRoomId ?? "")} Room ${pick?.picks[0]?.toRoomNumber ?? ""}?`}
      caseLines={pick ? [<b key="g">{pick.guest}</b>, pick.entryId] : undefined}
      busy={m.isPending}
      footer={
        <>
          <Button kind="quiet" state={m.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button className="go" state={m.isPending ? "working" : "default"} workingLabel="Giving the rooms…" onClick={() => m.mutate()}>
            {many ? `Give ${pick?.picks.length} rooms` : `Give it Room ${pick?.picks[0]?.toRoomNumber ?? ""}`}
          </Button>
        </>
      }
    >
      {many ? (
        <ul className="sm" style={{ margin: "0 0 var(--s2)", paddingLeft: 18 }}>
          {pick!.picks.map((p) => (
            <li key={p.fromRoomId}>
              {nameOf(p.fromRoomId)} → <b>Room {p.toRoomNumber}</b>
            </li>
          ))}
        </ul>
      ) : null}
      {pick?.inWay.length ? (
        <p className="sm warn-ink" style={{ fontWeight: 600 }}>
          {pick.inWay.map((w) => `Room ${w.roomNumber} is held as the system's choice for ${w.guest}`).join(" · ")} — the system moves
          {pick.inWay.length === 1 ? " that booking" : " those bookings"} to another room of the same type. Nothing else changes for them.
        </p>
      ) : null}
      <p className="sm">
        The system chose {many ? "these rooms" : "this room"} and may move {many ? "them" : "it"} to another of the type until the
        rooms are assigned at Arrival. Giving {many ? "them these rooms" : `it Room ${pick?.picks[0]?.toRoomNumber ?? ""}`}{" "}
        <b>fixes {many ? "them" : "it"} there</b>. The booking&apos;s setup, price and papers stay as they are, and nothing is sent
        to the guest.
      </p>
    </DsDialog>
  );
}
