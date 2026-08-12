"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BedDouble, Check, Crown, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { s6RoomChangeReEnterS1 } from "@/lib/api/pre-arrival";
import { getPaymentStatus } from "@/lib/api/reservation-setup";
import { formatClaimState, formatPhysicalState } from "@/lib/room-inventory-status";
import { guestName } from "@/lib/desk/model";
import { money } from "@/lib/desk/workspace";
import { openConfirmationVoucherPdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { BackendRail, type RailGroup } from "./backend-inline";
import { AdvanceSettlementBlock } from "./advance-settlement";
import { IdentityProofBlock } from "./identity-proof";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";

const BK = STAGE_ACTIONS.S6;

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}
function isElevated(level?: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

export function CheckInStep({
  entry,
  issuedKeyRooms,
  toggleKeyRoom,
  registrationConfirmed,
  setRegistrationConfirmed,
  setSelected,
}: {
  entry: EntryDetail;
  /** Per-room key issuance (2026-08-11, operator request): roomId → key handed over. One
   *  radio per room in the Room block; check-in requires every room marked. */
  issuedKeyRooms: Record<string, boolean>;
  toggleKeyRoom: (roomId: string) => void;
  registrationConfirmed: boolean;
  setRegistrationConfirmed: (v: boolean) => void;
  setSelected: (n: number) => void;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const guest = entry.guestProfile;
  const folio = entry.folio;
  // A multi-room booking has one RoomAssignment per (room, date-range), so the list can hold
  // several rows per room. Dedupe by roomId to get the rooms the guest is actually checking into
  // — taking [0] showed a single room and silently hid the rest of an 8-room party.
  const allAssignments = entry.roomAssignments ?? [];
  const distinctAssignments = useMemo(
    () => Array.from(new Map(allAssignments.map((a) => [a.roomId, a])).values()),
    [allAssignments],
  );
  const assignment = distinctAssignments[0];
  const issuedKeyCount = distinctAssignments.filter((a) => issuedKeyRooms[a.roomId]).length;
  const vipNotifications = entry.vipArrivalNotifications ?? [];
  const isVip = !!guest?.vipTier?.trim();
  const identityVerified = !!guest?.identityVerifiedAt;

  const [roomChangeReason, setRoomChangeReason] = useState("");

  const elevated = isElevated(session?.actorLevel);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
  };

  const paymentStatusQuery = useQuery({
    queryKey: ["payment-status", entry.id],
    queryFn: () => getPaymentStatus(session!, entry.id),
    enabled: !!session && !!folio?.id,
  });
  const paymentReconciled =
    !!folio?.advancePaymentReconciliationComplete || paymentStatusQuery.data?.satisfied === true;

  const roomChangeM = useMutation({
    mutationFn: () => s6RoomChangeReEnterS1(session!, entry.id, roomChangeReason.trim()),
    onSuccess: () => {
      setRoomChangeReason("");
      toast.success("Room change requested — pick the new room at Inquiry");
      invalidate();
      setSelected(1);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Room change failed"),
  });

  const currency = folio?.lines?.[0]?.currency;

  // Persistent highlight: each group stays lit once its action has run (derived from real
  // verification / VIP / stage state). `firingKey` adds the transient "running now" pulse.
  const activeKeys = [
    identityVerified ? "verify" : null,
    vipNotifications.length > 0 ? "vip" : null,
    entry.currentStage !== "S6" ? "commit" : null,
  ].filter(Boolean) as string[];
  // Verification now fires inside IdentityProofBlock; the rail's persistent "verify"
  // highlight still derives from identityVerifiedAt above.
  const firingKey = null;
  const railGroups: RailGroup[] = [
    { key: "verify", label: "On recording verification", items: BK.verify },
    { key: "vip", label: "On VIP arrival", items: BK.vip },
    { key: "commit", label: "On check-in & go live", items: BK.commit },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
      <div className="speak">
        <div className="now">A moment that locks</div>
        <h2>Verify identity and open the live folio.</h2>
        <p>
          Checking in hands over the keys and turns the folio live. Once live, the financial record is permanent
          — the second point you can&rsquo;t quietly undo.
        </p>
      </div>

      {/* Confirmation voucher (reprint) */}
      {session && entry.reservation?.id && (
        <div className="block">
          <BlockH>
            <ShieldCheck style={{ width: 13, height: 13 }} />
            Confirmation voucher
          </BlockH>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 12, color: "var(--ink-2)" }}>Reprint the guest&rsquo;s reservation confirmation.</span>
            <PdfButton
              label="Voucher PDF"
              open={() => openConfirmationVoucherPdf(session, entry.reservation!.id)}
            />
          </div>
        </div>
      )}

      {/* Guest details & ID proof (2026-08-11, operator ruling) — the same table as Arrival
          (same per-entry rows, so anything filled at S5 shows here already), with the identity
          VERIFICATION panel at its top (moved from the old standalone "Guest identity" block,
          operator request). At S6 the table is a GATE: every guest needs a document number or
          an ID photo before "Check in & go live" — except VIP bookings, which are exempt. For
          returning guests the primary guest's document is auto-pulled from the records on
          file. The strip inside states the verdict. */}
      <IdentityProofBlock entry={entry} checkInGate />

      {isVip && (
        <div className="block">
          <BlockH>
            <Crown style={{ width: 13, height: 13 }} />
            VIP arrival
          </BlockH>
          {vipNotifications.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--warn)", margin: 0 }}>
              No VIP notification on record — it dispatches when arrival is opened with the guest present.
            </p>
          ) : (
            vipNotifications.map((n) => (
              <div key={n.id} className="fact b-bound" style={{ padding: "7px 11px", fontSize: 12.5, marginBottom: 7 }}>
                Tier {n.vipTier} · Room {n.roomNumber} · briefed {new Date(n.checkInInitiatedAt).toLocaleString()}
              </div>
            ))
          )}
        </div>
      )}

      {/* Room */}
      <div className="block">
        <BlockH>
          <BedDouble style={{ width: 13, height: 13 }} />
          Room
        </BlockH>
        {distinctAssignments.length > 0 ? (
          <>
            {distinctAssignments.length > 1 && (
              <div className="fact b-transit" style={{ padding: "6px 11px", fontSize: 12.5, marginBottom: 8, width: "100%", justifyContent: "space-between" }}>
                <span>
                  {distinctAssignments.length} rooms on this booking
                  {entry.numberOfRooms ? ` · ${entry.numberOfRooms} needed` : ""}
                </span>
                <span className="tag">check-in covers all</span>
              </div>
            )}
            <div style={{ display: "grid", gap: 6 }}>
              {distinctAssignments.map((a) => (
                <div
                  key={a.id}
                  className="fact b-bound"
                  style={{ padding: "9px 12px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
                    Room {a.room?.roomNumber ?? a.roomId.slice(0, 8)}
                    {a.room?.currentClaimState ? ` · ${formatClaimState(a.room.currentClaimState)}` : ""}
                    {a.room?.physicalState ? ` · ${formatPhysicalState(a.room.physicalState)}` : ""}
                  </span>
                  {/* Per-room key tracking (2026-08-11, operator request): mark each room's key
                      as it is handed over — the radio toggles on click, so a mis-click undoes. */}
                  <label
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                    title={`Mark when room ${a.room?.roomNumber ?? ""}'s key is handed to the guest`}
                  >
                    <input
                      type="radio"
                      checked={!!issuedKeyRooms[a.roomId]}
                      onClick={() => toggleKeyRoom(a.roomId)}
                      readOnly
                      style={{ cursor: "pointer" }}
                    />
                    Key issued
                  </label>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize: 12, color: "var(--stop)", margin: 0 }}>No room assigned — go back to Arrival.</p>
        )}
        {/* There is deliberately no "pick the new room" control here: the S6 endpoint
            (POST /entries/:id/s6-room-change/re-enter-s1) accepts only { reason }. It doesn't
            swap a room — it releases the room claim, erases the committed hold, unseals every
            availability config and sends the whole booking back to Inquiry, where the new room
            is chosen. The copy below spells that out so nobody clicks it expecting a swap. */}
        {elevated && distinctAssignments.length > 0 && (
          <div style={{ marginTop: 11, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 6 }}>
              Change room (L2+) — sends this booking back to Inquiry
            </div>
            <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginBottom: 8, display: "block", lineHeight: 1.55 }}>
              This doesn&rsquo;t swap one room. It releases{" "}
              <b>
                {distinctAssignments.length === 1
                  ? `room ${distinctAssignments[0].room?.roomNumber ?? distinctAssignments[0].roomId.slice(0, 8)}`
                  : `all ${distinctAssignments.length} rooms`}
              </b>
              , cancels the committed hold and unseals the room plan — then reopens the booking at{" "}
              <b>Inquiry</b> so you re-select {distinctAssignments.length === 1 ? "a room" : "the rooms"} from
              availability and walk forward again.
              {distinctAssignments.length > 1 && (
                <>
                  {" "}
                  <span style={{ color: "var(--warn)" }}>
                    There is no way to change just one of the {distinctAssignments.length} rooms — the backend
                    reopens the whole booking.
                  </span>
                </>
              )}
            </div>
            <div className="frow">
              <div className="field">
                <label>Reason (recorded on the audit trail)</label>
                <input
                  value={roomChangeReason}
                  onChange={(e) => setRoomChangeReason(e.target.value)}
                  placeholder="e.g. aircon fault in 302"
                />
              </div>
              <div className="field" style={{ alignSelf: "end" }}>
                <button className="btn btn-ghost" disabled={roomChangeM.isPending || roomChangeReason.trim().length < 3} onClick={() => roomChangeM.mutate()}>
                  {roomChangeM.isPending ? "Reopening…" : "Release & reopen at Inquiry"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Folio & payment */}
      <div className="block">
        <BlockH>Folio &amp; payment</BlockH>
        <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
          <span>Folio {folio?.state ?? "—"}</span>
          <span className={`tag ${paymentReconciled ? "" : "warn"}`}>
            {paymentReconciled ? "Advance reconciled" : "Advance not settled"}
          </span>
        </div>
        {folio?.outstandingBalance != null && (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "8px 0 0" }}>Outstanding {money(folio.outstandingBalance, currency)}</p>
        )}
      </div>

      {/* Advance settlement (2026-08-07): the guest is standing at the desk — the classic moment
          a "rest at check-in" plan pays out. Log the remainder here; the folio is still
          provisional until "Check in & go live", so it lands as an advance payment. */}
      <AdvanceSettlementBlock
        entry={entry}
        title="Collect the remaining advance"
        intro="If the guest planned to settle the advance at the desk, take it now — checking in with money still short needs an FOM credit extension instead."
      />

      {/* Registration & keys */}
      <div className="block">
        <BlockH>
          <KeyRound style={{ width: 13, height: 13 }} />
          Registration &amp; keys
        </BlockH>
        <div
          className="fact b-transit"
          style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between", marginBottom: 8 }}
        >
          <span>Room keys handed over</span>
          <span className={`tag${issuedKeyCount === distinctAssignments.length && distinctAssignments.length > 0 ? "" : " warn"}`}>
            {issuedKeyCount} of {distinctAssignments.length} room{distinctAssignments.length === 1 ? "" : "s"}
          </span>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 8px" }}>
          Mark each key in the <b>Room</b> section above as you hand it over — every room needs its
          key issued before check-in.
        </p>
        <label className="checkline" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={registrationConfirmed} onChange={(e) => setRegistrationConfirmed(e.target.checked)} />
          <span>Registration complete — mandatory guest fields captured or confirmed for {guestName(guest)}</span>
        </label>
      </div>

      <p style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
        Completing check-in converts the folio to <b>live</b>, marks the room occupied, issues the keys, and
        opens the housekeeping and F&amp;B handoffs — one governed transition.
      </p>
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />
    </div>
  );
}
