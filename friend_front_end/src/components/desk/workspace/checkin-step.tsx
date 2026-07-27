"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BedDouble, Check, Crown, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { verifyGuestIdentity, type VerificationPath } from "@/lib/api/check-in";
import { s6RoomChangeReEnterS1 } from "@/lib/api/pre-arrival";
import { getPaymentStatus } from "@/lib/api/reservation-setup";
import { formatClaimState, formatPhysicalState } from "@/lib/room-inventory-status";
import { guestName } from "@/lib/desk/model";
import { money } from "@/lib/desk/workspace";
import { openConfirmationVoucherPdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { StepAction } from "./step-action";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";

const BK = STAGE_ACTIONS.S6;

const DOCUMENT_TYPES = ["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE", "VOTER_ID"];

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
  keyCount,
  setKeyCount,
  registrationConfirmed,
  setRegistrationConfirmed,
  setSelected,
}: {
  entry: EntryDetail;
  keyCount: string;
  setKeyCount: (v: string) => void;
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
  const vipNotifications = entry.vipArrivalNotifications ?? [];
  const isVip = !!guest?.vipTier?.trim();
  const identityVerified = !!guest?.identityVerifiedAt;

  const [verificationPath, setVerificationPath] = useState<VerificationPath>(isVip ? "VIP" : "RETURNING_VALID");
  const [documentType, setDocumentType] = useState("PASSPORT");
  const [documentNumber, setDocumentNumber] = useState("");
  const [roomChangeReason, setRoomChangeReason] = useState("");

  useEffect(() => {
    setVerificationPath(isVip ? "VIP" : "RETURNING_VALID");
  }, [isVip, guest?.id]);

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

  const verifyM = useMutation({
    mutationFn: () => {
      if (!session || !guest?.id) throw new Error("Guest profile required");
      const body: Parameters<typeof verifyGuestIdentity>[2] = { entryId: entry.id, verificationPath };
      if (verificationPath === "FIRST_TIME" || verificationPath === "RETURNING_EXPIRED") {
        body.documentType = documentType;
        if (verificationPath === "FIRST_TIME") body.documentNumber = documentNumber.trim();
      }
      return verifyGuestIdentity(session, guest.id, body);
    },
    onSuccess: () => {
      toast.success("Identity verified");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Verification failed"),
  });

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
  const firingKey = verifyM.isPending ? "verify" : null;
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

      {/* Identity verification */}
      <div className="block">
        <BlockH>
          <ShieldCheck style={{ width: 13, height: 13 }} />
          Guest identity
        </BlockH>
        {!identityVerified && (
          <>
            <div className="field">
              <label>Verification path</label>
              <select value={verificationPath} onChange={(e) => setVerificationPath(e.target.value as VerificationPath)} disabled={isVip}>
                <option value="FIRST_TIME">First-time guest</option>
                <option value="RETURNING_VALID">Returning — ID valid</option>
                <option value="RETURNING_EXPIRED">Returning — ID expired</option>
                <option value="VIP">VIP path</option>
              </select>
            </div>
            {(verificationPath === "FIRST_TIME" || verificationPath === "RETURNING_EXPIRED") && (
              <div className="frow">
                <div className="field">
                  <label>Document type</label>
                  <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                    {DOCUMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </div>
                {verificationPath === "FIRST_TIME" && (
                  <div className="field">
                    <label>Document number</label>
                    <input value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} placeholder="As shown" />
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <StepAction
          className="btn btn-primary"
          label="Record verification"
          doneLabel={`Verified${guest?.identityVerificationPath ? ` · ${guest.identityVerificationPath}` : ""}`}
          done={identityVerified}
          pending={verifyM.isPending}
          disabled={!guest?.id}
          onClick={() => verifyM.mutate()}
        />
      </div>

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
                <div key={a.id} className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5 }}>
                  <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
                  Room {a.room?.roomNumber ?? a.roomId.slice(0, 8)}
                  {a.room?.currentClaimState ? ` · ${formatClaimState(a.room.currentClaimState)}` : ""}
                  {a.room?.physicalState ? ` · ${formatPhysicalState(a.room.physicalState)}` : ""}
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
            {paymentReconciled ? "Advance reconciled" : "Reconcile at Arrival"}
          </span>
        </div>
        {folio?.outstandingBalance != null && (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "8px 0 0" }}>Outstanding {money(folio.outstandingBalance, currency)}</p>
        )}
      </div>

      {/* Registration & keys */}
      <div className="block">
        <BlockH>
          <KeyRound style={{ width: 13, height: 13 }} />
          Registration &amp; keys
        </BlockH>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Keys issued</label>
          <input type="number" min={1} max={10} value={keyCount} onChange={(e) => setKeyCount(e.target.value)} />
        </div>
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
