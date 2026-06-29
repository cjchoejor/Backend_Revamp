"use client";

import { useEffect, useState } from "react";
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
import { StepAction } from "./step-action";
import type { EntryDetail } from "@/types/api";

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
  const assignment = (entry.roomAssignments ?? [])[0];
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

  return (
    <>
      <div className="speak">
        <div className="now">A moment that locks</div>
        <h2>Verify identity and open the live folio.</h2>
        <p>
          Checking in hands over the keys and turns the folio live. Once live, the financial record is permanent
          — the second point you can&rsquo;t quietly undo.
        </p>
      </div>

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
        {assignment ? (
          <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5 }}>
            <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
            Room {assignment.room?.roomNumber ?? assignment.roomId.slice(0, 8)}
            {assignment.room?.currentClaimState ? ` · ${formatClaimState(assignment.room.currentClaimState)}` : ""}
            {assignment.room?.physicalState ? ` · ${formatPhysicalState(assignment.room.physicalState)}` : ""}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: "var(--stop)", margin: 0 }}>No room assigned — go back to Arrival.</p>
        )}
        {elevated && (
          <div style={{ marginTop: 11, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 6 }}>Change room (L2+) — re-opens Inquiry</div>
            <div className="frow">
              <div className="field">
                <label>Reason</label>
                <input value={roomChangeReason} onChange={(e) => setRoomChangeReason(e.target.value)} placeholder="Why change?" />
              </div>
              <div className="field" style={{ alignSelf: "end" }}>
                <button className="btn btn-ghost" disabled={roomChangeM.isPending || roomChangeReason.trim().length < 3} onClick={() => roomChangeM.mutate()}>
                  Change room → Inquiry
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
    </>
  );
}
