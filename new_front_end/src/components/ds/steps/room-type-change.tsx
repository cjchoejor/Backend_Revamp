"use client";

/**
 * Change one of the booking's rooms to another room type (2026-10-29, operator: "the user can just
 * double click on the room and it can show option to change another room type, where the system can
 * offer free room types for that date").
 *
 * The house's answer is the server's (`GET …/room-type-options`): each type with how many of its
 * rooms are free on every night of the change, the room the system would give, and the rate per
 * night this booking would pay. Nothing is added up here. The change is the governed room change —
 * a new pass, priced again, the rooms held again, the papers made again and held for the desk — and
 * the booking comes back to this step. Before Arrival the system keeps a room of the new type for
 * the guest (no room number); from Arrival on the desk sees the room and may choose another.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system/components/primitives";
import { useSession } from "@/hooks/use-session";
import { getRoomTypeOptions, type RoomTypeOption } from "@/lib/api/booking-rooms";
import { changeBookingRoom } from "@/lib/api/entries";
import { fmtDay, fmtRange, money, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, atLeast, toastRefusal } from "./kit";

const nextDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

export function RoomTypeDialog({
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
  /** The night picked in the table's night list — that night only, the others kept (2026-10-29). */
  night?: string | null;
  /** The nights the room is the booking's. */
  roomNights?: string[];
  /** "Standard Double · room 1" before Arrival, "Room 203" after. */
  name: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const open = !!roomId;
  const q = useQuery({
    queryKey: ["room-type-options", entry.id, roomId, entry.updatedAt],
    queryFn: () => getRoomTypeOptions(session!, entry.id, roomId!),
    enabled: !!session && open,
    staleTime: 10_000,
  });
  const data = q.data ?? null;
  const [typeId, setTypeId] = useState<string | null>(null);
  const [toRoom, setToRoom] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // A fresh start each time a room is opened.
  useEffect(() => {
    setTypeId(null);
    setToRoom(null);
    setReason("");
  }, [roomId]);

  const chosen: RoomTypeOption | null = data?.options.find((o) => o.roomTypeId === typeId) ?? null;
  const target = chosen ? (data?.beforeArrival ? chosen.roomId : (toRoom ?? chosen.roomId)) : null;
  const fom = atLeast(session?.actorLevel, "L2");
  const needsFom = !!chosen && chosen.requiredLevel === "L2" && !fom;
  const inHouse = entry.currentStage === "S7";
  const nights = data?.nights ?? [];
  const span = nights.length ? `${fmtRange(nights[0], nextDay(nights[nights.length - 1]))} · ${plural(nights.length, "night")}` : "";
  const cur = data?.currency ?? "BTN";

  const oneNight = !!night && roomNights.length > 1;
  const change = useMutation({
    mutationFn: () =>
      changeBookingRoom(session!, entry.id, {
        fromRoomId: roomId!,
        ...(oneNight
          ? { perNight: roomNights.map((d) => ({ date: d, roomId: d === night ? target! : roomId! })) }
          : { toRoomId: target! }),
        reason: reason.trim(),
        systemChosen: data?.beforeArrival === true,
      }),
    onSuccess: (res) => {
      const d = res?.pricing?.delta;
      toast.success(
        `${name} is now ${data?.beforeArrival ? `a ${chosen?.name}` : `Room ${data?.options.flatMap((o) => o.rooms).find((r) => r.roomId === target)?.roomNumber ?? ""} · ${chosen?.name}`}` +
          (d != null && d !== 0 ? ` — the total moved by ${d > 0 ? "+" : ""}${money(d, res.pricing?.currency ?? cur)}` : ""),
      );
      if (res?.heldDocuments?.some((h) => h.kind === "CONFIRMATION_VOUCHER")) toast.info("A new confirmation voucher is made — send it to the guest, or not, on the voucher.", { duration: 9000 });
      if (res?.heldDocuments?.some((h) => h.kind === "PROFORMA")) toast.info("A new proforma is made — send it to the guest, or not.", { duration: 9000 });
      if (res?.walk && !res.walk.returnedToOrigin) toast.warning(`The booking stopped on the way back: ${res.walk.blocked?.message ?? "a later step refused"}`, { duration: 12000 });
      onChanged();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The room type could not be changed"),
  });

  const why = !chosen
    ? "pick the room type first"
    : chosen.free === 0
      ? `no ${chosen.name} is free for these nights`
      : needsFom
        ? "another room type is the FOM's call"
        : !reason.trim()
          ? "type why first"
          : null;

  return (
    <DsDialog
      open={open}
      onClose={onClose}
      busy={change.isPending}
      title={`Change the room type of ${name}${oneNight ? ` on ${fmtDay(night!)}` : ""}`}
      caseLines={[entry.id, ...(oneNight ? [`${fmtDay(night!)} only — the other nights keep this room`] : span ? [inHouse ? `from tonight · ${span}` : span] : [])]}
      help={
        <>
          <p>The booking is priced again on the new type, its rooms held again and its papers made again — and it comes back to this step. Nothing goes to the guest unless you send it.</p>
          {data?.beforeArrival ? <p>Until Arrival the system keeps a room of the new type for the guest; the room number is chosen at Arrival.</p> : null}
          {inHouse ? <p>In house the guest moves from tonight; the nights already slept stay as they were billed.</p> : null}
        </>
      }
      footer={
        <>
          <Button kind="quiet" state={change.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            className={why ? undefined : "go"}
            state={change.isPending ? "working" : why ? "inert" : "default"}
            reason={why ?? undefined}
            workingLabel="Changing the room…"
            onClick={() => !why && change.mutate()}
          >
            {chosen ? `Change to ${chosen.name}` : "Change the room type"}
          </Button>
        </>
      }
    >
      <p className="sm rt-now">
        Now <b>{data?.fromRoom.typeName ?? "this type"}</b>
        {data?.currentRatePerNight != null ? <> · {money(data.currentRatePerNight, cur)} a night</> : null}
      </p>
      {q.isLoading ? (
        <p className="meta">Asking the house which types are free…</p>
      ) : q.isError ? (
        <p className="stop-ink sm" role="alert">The house could not be asked — close this and try again.</p>
      ) : (
        <div className="rt-options" role="radiogroup" aria-label="The room types free for these nights">
          {(data?.options ?? []).map((o) => {
            const shut = o.free === 0;
            const on = o.roomTypeId === typeId;
            return (
              <button
                key={o.roomTypeId}
                type="button"
                role="radio"
                aria-checked={on}
                className={`rt-opt${on ? " on" : ""}${shut ? " shut" : ""}`}
                disabled={shut || change.isPending}
                title={shut ? `No ${o.name} is free on every one of these nights` : undefined}
                onClick={() => {
                  setTypeId(o.roomTypeId);
                  setToRoom(null);
                }}
              >
                <span className="rt-dot" aria-hidden />
                <span className="rt-name">
                  {o.name}
                  {o.sameType ? <small> · another room of this type</small> : null}
                </span>
                <span className={`rt-free ${shut ? "none" : o.free === 1 ? "few" : "plenty"}`}>{shut ? "none free" : o.free === 1 ? "only 1 free" : `${o.free} free`}</span>
                <span className="rt-rate">{o.ratePerNight != null ? `${money(o.ratePerNight, cur)} a night` : "rate on pricing"}</span>
              </button>
            );
          })}
        </div>
      )}
      {chosen && !data?.beforeArrival && chosen.rooms.length > 1 ? (
        <div className="field" style={{ marginTop: 10 }}>
          <label>The room</label>
          <div className="rt-rooms">
            {chosen.rooms.map((r) => {
              const on = (toRoom ?? chosen.roomId) === r.roomId;
              return (
                <button key={r.roomId} type="button" className={`rt-room${on ? " on" : ""}`} aria-pressed={on} onClick={() => setToRoom(r.roomId)}>
                  {r.roomNumber}
                  {r.roomId === chosen.roomId ? <small> · the system&rsquo;s pick</small> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {chosen && data?.beforeArrival ? (
        <p className="sm" style={{ marginTop: 10 }}>
          The system keeps a {chosen.name} for the guest — the room number is chosen at Arrival.
        </p>
      ) : null}
      {needsFom ? (
        <p className="warn-ink sm" style={{ marginTop: 8, fontWeight: 600 }}>
          Another room type changes the price — the FOM&rsquo;s call.
        </p>
      ) : null}
      <div className="field" style={{ marginTop: 10 }}>
        <label>Why</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="the guest asked for a bigger room" />
      </div>
    </DsDialog>
  );
}
