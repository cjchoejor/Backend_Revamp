"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BedDouble,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Crown,
  Handshake,
  KeyRound,
  ShieldCheck,
  UserCheck,
  Wallet,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { ApiErrorAlert } from "@/components/stages/shared/api-error-alert";
import { ProgressStageButton } from "@/components/stages/shared/progress-stage-button";
import { STAGES, stagePath } from "@/config/stages";
import { verifyGuestIdentity, type VerificationPath } from "@/lib/api/check-in";
import { assignRoom } from "@/lib/api/pre-arrival";
import { getPaymentStatus } from "@/lib/api/reservation-setup";
import { listRooms } from "@/lib/api/rooms";
import { formatClaimState, formatPhysicalState, formatRoomPickerLabel } from "@/lib/room-inventory-status";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { formatListId } from "@/lib/readable-id";
import type {
  EntryDetail,
  HandoffSummary,
  RoomAssignmentSummary,
  VipArrivalNotificationSummary,
} from "@/types/api";

type S6WorkspaceProps = {
  entry: EntryDetail;
};

const ROOM_READY_STATES = new Set(["AVAILABLE_CLEAN", "AVAILABLE_INSPECTED"]);
const DOCUMENT_TYPES = ["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE", "VOTER_ID"];

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

function isRoomReady(assignment: RoomAssignmentSummary | undefined) {
  if (!assignment) return false;
  const physicalState = assignment.room?.physicalState;
  if (physicalState && ROOM_READY_STATES.has(physicalState)) return true;
  if (assignment.deficientAtAssignment) {
    return Boolean(assignment.acknowledgementActorId && assignment.acknowledgementAt);
  }
  return !physicalState;
}

function guestName(entry: EntryDetail) {
  const g = entry.guestProfile;
  if (!g) return "Guest";
  if (g.displayName?.trim()) return g.displayName;
  return `${g.firstName ?? ""} ${g.lastName ?? ""}`.trim() || "Guest";
}

export function S6Workspace({ entry }: S6WorkspaceProps) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const meta = STAGES[5];

  const reservation = entry.reservation;
  const folio = entry.folio;
  const guest = entry.guestProfile;
  const handoffs = (entry.handoffs ?? []) as HandoffSummary[];
  const h1 = handoffs.find((h) => h.handoffType === "H1");
  const h2 = handoffs.find((h) => h.handoffType === "H2" && h.stageContext === "S6");
  const h3 = handoffs.find((h) => h.handoffType === "H3" && h.stageContext === "S6");
  const assignments = (entry.roomAssignments ?? []) as RoomAssignmentSummary[];
  const latestAssignment = assignments[0];
  const vipNotifications = (entry.vipArrivalNotifications ?? []) as VipArrivalNotificationSummary[];

  const isVip = Boolean(guest?.vipTier?.trim());
  const defaultPath: VerificationPath = isVip ? "VIP" : "RETURNING_VALID";

  const [verificationPath, setVerificationPath] = useState<VerificationPath>(defaultPath);
  const [documentType, setDocumentType] = useState("PASSPORT");
  const [documentNumber, setDocumentNumber] = useState("");
  const [keyCount, setKeyCount] = useState("1");
  const [registrationConfirmed, setRegistrationConfirmed] = useState(false);
  const [roomChangeId, setRoomChangeId] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    setVerificationPath(isVip ? "VIP" : "RETURNING_VALID");
  }, [isVip, guest?.id]);

  const paymentStatusQuery = useQuery({
    queryKey: ["payment-status", entry.id],
    queryFn: () => getPaymentStatus(session!, entry.id),
    enabled: !!session && !!folio?.id,
  });
  const paymentStatus = paymentStatusQuery.data;
  const paymentReconciled =
    !!folio?.advancePaymentReconciliationComplete || paymentStatus?.satisfied === true;

  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session && entry.currentStage === "S6" && isElevated(session.actorLevel),
  });

  const identityVerified = Boolean(guest?.identityVerifiedAt);
  const roomReady = isRoomReady(latestAssignment);
  const parsedKeyCount = Number.parseInt(keyCount, 10);
  const keysValid = Number.isFinite(parsedKeyCount) && parsedKeyCount > 0;

  const h1Ok =
    entry.walkInCompressed === true ||
    !h1 ||
    h1.state === "FULFILLED" ||
    h1.state === "CLOSED";

  const s6ExitChecks = useMemo(
    () => [
      {
        label: "Guest identity verified",
        ok: identityVerified,
        detail: guest?.identityVerificationPath
          ? `Path: ${guest.identityVerificationPath}`
          : undefined,
      },
      {
        label: "Room assigned and ready",
        ok: !!latestAssignment && roomReady,
        detail: latestAssignment?.room?.roomNumber
          ? [
              `Room ${latestAssignment.room.roomNumber}`,
              latestAssignment.room.currentClaimState
                ? formatClaimState(latestAssignment.room.currentClaimState)
                : null,
              latestAssignment.room.physicalState
                ? formatPhysicalState(latestAssignment.room.physicalState)
                : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined,
      },
      {
        label: "Advance payment reconciled",
        ok: paymentReconciled,
        detail: folio?.advancePaymentReconciliationComplete ? "Folio reconciled" : undefined,
      },
      {
        label: "H1 fulfilled (standard path)",
        ok: h1Ok,
        detail: h1 ? `H1: ${h1.state}` : entry.walkInCompressed ? "Walk-in — no H1" : "No H1",
      },
      {
        label: "VIP arrival notification (if VIP)",
        ok: !isVip || vipNotifications.length > 0,
        detail: isVip
          ? vipNotifications.length > 0
            ? `Issued at check-in commencement`
            : "Required before completion"
          : "Not applicable",
      },
      {
        label: "Registration confirmed",
        ok: registrationConfirmed,
        detail: "Mandatory registration fields captured or confirmed",
      },
      {
        label: "Keys issued (count recorded)",
        ok: keysValid,
        detail: keysValid ? `${parsedKeyCount} key(s)` : "Enter key count ≥ 1",
      },
    ],
    [
      identityVerified,
      guest?.identityVerificationPath,
      latestAssignment,
      roomReady,
      paymentReconciled,
      folio,
      h1Ok,
      h1,
      entry.walkInCompressed,
      isVip,
      vipNotifications.length,
      registrationConfirmed,
      keysValid,
      parsedKeyCount,
    ],
  );

  const canCompleteCheckIn = s6ExitChecks.every((c) => c.ok);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
  };

  const verifyMutation = useMutation({
    mutationFn: () => {
      if (!session || !guest?.id) throw new Error("Guest profile required");
      const body: Parameters<typeof verifyGuestIdentity>[2] = {
        entryId: entry.id,
        verificationPath,
      };
      if (verificationPath === "FIRST_TIME" || verificationPath === "RETURNING_EXPIRED") {
        body.documentType = documentType;
        if (verificationPath === "FIRST_TIME") body.documentNumber = documentNumber.trim();
      }
      return verifyGuestIdentity(session, guest.id, body);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Identity verified");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Verification failed");
    },
  });

  const roomChangeMutation = useMutation({
    mutationFn: () => {
      if (!session) throw new Error("Not signed in");
      return assignRoom(session, entry.id, {
        roomId: roomChangeId.trim(),
        notes: "S6 room change — re-entry to S1",
        reEntryToS1: true,
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Room change initiated — re-select availability at S1");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Room change failed");
    },
  });

  if (entry.currentStage !== "S6") {
    return (
      <StagePanel meta={meta}>
        <Card>
          <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-medium">
              Entry is at <StatusBadge status={entry.currentStage} />
              {entry.currentStage === "S5" && " — complete pre-arrival and progress to S6 first."}
            </p>
            <Button variant="gradient" asChild>
              <Link href={stagePath(entry.id, entry.currentStage)}>
                Open {entry.currentStage}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </StagePanel>
    );
  }

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Check-in context</CardTitle>
            <CardDescription>
              SIG-S6 — identity, keys, and registration; folio converts to LIVE on completion (S6→S7).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Entry:</span>{" "}
              <span className="font-mono">{formatListId(entry.id)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Inquiry:</span>{" "}
              <span className="font-mono">{formatListId(entry.inquiryId)}</span>
            </div>
            {folio && (
              <div>
                <span className="text-muted-foreground">Folio:</span>{" "}
                <span className="font-mono">{formatListId(folio.id)}</span>{" "}
                <StatusBadge status={folio.state} />
              </div>
            )}
            {reservation && (
              <div>
                <span className="text-muted-foreground">Reservation:</span>{" "}
                <span className="font-mono">{formatListId(reservation.id)}</span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Guest:</span> {guestName(entry)}
              {isVip && (
                <Badge variant="secondary" className="ml-2">
                  <Crown className="mr-1 inline h-3 w-3" />
                  {guest?.vipTier}
                </Badge>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">Stay:</span>{" "}
              {reservation?.frozenCheckInDate?.slice(0, 10) ?? entry.checkInDate?.slice(0, 10) ?? "—"} →{" "}
              {reservation?.frozenCheckOutDate?.slice(0, 10) ?? entry.checkOutDate?.slice(0, 10) ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Billing model:</span> {folio?.billingModel ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Frozen rate:</span> BTN{" "}
              {reservation?.frozenRate != null ? String(reservation.frozenRate) : "—"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Guest identity verification
            </CardTitle>
            <CardDescription>
              Policy 16 — verification event required before check-in completion. VIP path still records an event.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {identityVerified ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Verified
                {guest?.identityVerifiedAt && (
                  <span className="text-muted-foreground">
                    · {new Date(guest.identityVerifiedAt).toLocaleString()}
                  </span>
                )}
                {guest?.identityVerificationPath && (
                  <Badge variant="outline">{guest.identityVerificationPath}</Badge>
                )}
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Verification path</span>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={verificationPath}
                      onChange={(e) => setVerificationPath(e.target.value as VerificationPath)}
                      disabled={isVip}
                    >
                      <option value="FIRST_TIME">First-time guest</option>
                      <option value="RETURNING_VALID">Returning — ID valid</option>
                      <option value="RETURNING_EXPIRED">Returning — ID expired (soft flag)</option>
                      <option value="VIP">VIP path</option>
                    </select>
                  </label>
                  {(verificationPath === "FIRST_TIME" || verificationPath === "RETURNING_EXPIRED") && (
                    <>
                      <label className="space-y-1 text-sm">
                        <span className="text-muted-foreground">Document type</span>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                          value={documentType}
                          onChange={(e) => setDocumentType(e.target.value)}
                        >
                          {DOCUMENT_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t.replace(/_/g, " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                      {verificationPath === "FIRST_TIME" && (
                        <label className="space-y-1 text-sm sm:col-span-2">
                          <span className="text-muted-foreground">Document number</span>
                          <Input
                            value={documentNumber}
                            onChange={(e) => setDocumentNumber(e.target.value)}
                            placeholder="As shown on document"
                          />
                        </label>
                      )}
                    </>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={verifyMutation.isPending || !guest?.id}
                  onClick={() => verifyMutation.mutate()}
                >
                  <UserCheck className="mr-2 h-4 w-4" />
                  Record verification
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {isVip && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Crown className="h-4 w-4" />
                VIP arrival notification
              </CardTitle>
              <CardDescription>
                Dispatched at S5→S6 commencement (before keys). Staff must be briefed before the guest reaches the room.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {vipNotifications.length === 0 ? (
                <p className="text-amber-700 dark:text-amber-400">
                  No VIP notification on record — progress from S5 with guest present to trigger commencement dispatch.
                </p>
              ) : (
                vipNotifications.map((n) => (
                  <div key={n.id} className="rounded-lg border bg-muted/30 px-3 py-2">
                    <span className="font-mono text-xs text-muted-foreground">{formatListId(n.id)}</span>
                    <div className="mt-1">
                      Tier <strong>{n.vipTier}</strong> · Room <strong>{n.roomNumber}</strong>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Initiated {new Date(n.checkInInitiatedAt).toLocaleString()}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BedDouble className="h-4 w-4" />
              Room assignment
            </CardTitle>
            <CardDescription>
              Assigned at S5 — must be AVAILABLE_CLEAN or AVAILABLE_INSPECTED at completion.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {latestAssignment ? (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">
                  {formatListId(latestAssignment.id)}
                </span>
                <div className="mt-1">
                  Room{" "}
                  <strong>
                    {latestAssignment.room?.roomNumber ?? latestAssignment.roomId.slice(0, 8)}
                  </strong>
                  {latestAssignment.room?.currentClaimState && (
                    <Badge variant="outline" className="ml-2">
                      {formatClaimState(latestAssignment.room.currentClaimState)}
                    </Badge>
                  )}
                  {latestAssignment.room?.physicalState && (
                    <StatusBadge status={latestAssignment.room.physicalState} className="ml-2" />
                  )}
                </div>
                {latestAssignment.deficientAtAssignment && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    DEFICIENT at assignment
                    {!latestAssignment.acknowledgementAt && " — acknowledgement required"}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-destructive">No room assignment — return to S5.</p>
            )}

            {session && isElevated(session.actorLevel) && (
              <div className="space-y-2 rounded-lg border border-dashed p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Room change at check-in (S6→S1 re-entry, L2+)
                </p>
                <div className="flex flex-wrap gap-2">
                  <select
                    className="h-9 min-w-[140px] flex-1 rounded-md border border-input bg-background px-3 text-sm"
                    value={roomChangeId}
                    onChange={(e) => setRoomChangeId(e.target.value)}
                  >
                    <option value="">Select new room…</option>
                    {(roomsCatalogQuery.data?.items ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {formatRoomPickerLabel({
                          roomNumber: r.roomNumber,
                          currentClaimState: r.currentClaimState,
                          physicalState: r.physicalState,
                          isBlocked: r.isBlocked,
                        })}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={roomChangeMutation.isPending || !roomChangeId.trim()}
                    onClick={() => roomChangeMutation.mutate()}
                  >
                    Change room → S1
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" />
              Folio &amp; payment
            </CardTitle>
            <CardDescription>
              Folio is PROVISIONAL until check-in completes — no live charges before conversion.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge status={folio?.state ?? "—"} />
            <span>
              Outstanding: BTN {folio?.outstandingBalance != null ? String(folio.outstandingBalance) : "—"}
            </span>
            {paymentReconciled ? (
              <span className="text-emerald-700 dark:text-emerald-400">Advance payment reconciled</span>
            ) : (
              <span className="text-amber-700 dark:text-amber-400">Reconcile at S5 before completing check-in</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Handshake className="h-4 w-4" />
              Handoffs
            </CardTitle>
            <CardDescription>
              H1 closes on completion. H2 (housekeeping) and H3 (F&amp;B) are created when you complete check-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">H1:</span>
              {h1 ? (
                <>
                  <span className="font-mono text-xs">{formatListId(h1.id)}</span>
                  <Badge variant="outline">{h1.state}</Badge>
                </>
              ) : (
                <span>Walk-in / no H1</span>
              )}
            </div>
            {(h2 || h3) && (
              <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                {h2 && (
                  <div>
                    H2 → HK: <Badge variant="outline">{h2.state}</Badge>
                    {h2.slaDeadlineAt && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        SLA {new Date(h2.slaDeadlineAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}
                {h3 && (
                  <div>
                    H3 → F&amp;B: <Badge variant="outline">{h3.state}</Badge>
                  </div>
                )}
              </div>
            )}
            {!h2 && !h3 && (
              <p className="text-muted-foreground">
                H2 and H3 will be created automatically when check-in completes (S6→S7).
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              Registration &amp; keys
            </CardTitle>
            <CardDescription>Record key count and confirm registration before completing check-in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex max-w-xs flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Number of keys issued</span>
              <Input
                type="number"
                min={1}
                max={10}
                value={keyCount}
                onChange={(e) => setKeyCount(e.target.value)}
              />
            </label>
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border"
                checked={registrationConfirmed}
                onChange={(e) => setRegistrationConfirmed(e.target.checked)}
              />
              <span>
                Registration complete — mandatory guest fields captured or confirmed for this stay
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4" />
              Complete check-in (S6 → S7)
            </CardTitle>
            <CardDescription>
              Converts folio to LIVE, room to OCCUPIED, creates H2/H3, issues keys — single governed transition.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2">
              {s6ExitChecks.map((check) => (
                <li key={check.label} className="flex items-start gap-2 text-sm">
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div>
                    <span className={check.ok ? "" : "text-muted-foreground"}>{check.label}</span>
                    {check.detail && (
                      <span className="ml-2 text-xs text-muted-foreground">{check.detail}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <ProgressStageButton
              entryId={entry.id}
              version={entry.version}
              targetStage="S7"
              label="Complete check-in → S7"
              disabled={!canCompleteCheckIn}
              navigateOnSuccess
              transitionData={{
                keyCount: parsedKeyCount,
                registrationConfirmed: true,
              }}
            />
            {!canCompleteCheckIn && (
              <p className="text-xs text-muted-foreground">
                Satisfy all checklist items above before completing check-in.
              </p>
            )}
          </CardContent>
        </Card>

        <ApiErrorAlert error={actionError} />
      </div>
    </StagePanel>
  );
}
