"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BedDouble,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Handshake,
  ListChecks,
  Plane,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { ApiErrorAlert } from "@/components/stages/shared/api-error-alert";
import { ProgressStageButton } from "@/components/stages/shared/progress-stage-button";
import { useStageTransition } from "@/components/stages/shared/stage-transition-context";
import { STAGES, stagePath } from "@/config/stages";
import {
  acceptHandoff,
  activatePreArrival,
  acknowledgeCreditCeilingTier2,
  assignRoom,
  buildH1FulfilmentEvidence,
  fulfilHandoff,
  getHandoffChecklist,
  patchPreArrivalTask,
} from "@/lib/api/pre-arrival";
import { roomsFromResultSet } from "@/lib/api/availability";
import { getPaymentStatus, reconcileAdvancePayment } from "@/lib/api/reservation-setup";
import { listRooms } from "@/lib/api/rooms";
import { formatClaimState, formatPhysicalState, formatRoomPickerLabel } from "@/lib/room-inventory-status";
import type { HandoffChecklistItem } from "@/lib/api/handoffs";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { formatListId } from "@/lib/readable-id";
import type {
  AvailabilityConfigSummary,
  EntryDetail,
  HandoffSummary,
  PreArrivalTaskSummary,
  RoomAssignmentSummary,
} from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";

type S5WorkspaceProps = {
  entry: EntryDetail;
};

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

function taskLabel(taskType: string) {
  return taskType.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const ROOM_READY_STATES = new Set(["AVAILABLE_CLEAN", "AVAILABLE_INSPECTED"]);

function isRoomReadinessConfirmed(assignment: RoomAssignmentSummary | undefined) {
  if (!assignment) return false;
  const physicalState = assignment.room?.physicalState;
  if (physicalState && ROOM_READY_STATES.has(physicalState)) return true;
  if (assignment.deficientAtAssignment) {
    return Boolean(assignment.acknowledgementActorId && assignment.acknowledgementAt);
  }
  // Assigned but housekeeping state not loaded — custodian may still attest after verification.
  return !physicalState;
}

export function S5Workspace({ entry }: S5WorkspaceProps) {
  const router = useRouter();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const { startTransition, endTransition } = useStageTransition();
  const meta = STAGES[4];

  const reservation = entry.reservation;
  const folio = entry.folio;
  const handoffs = (entry.handoffs ?? []) as HandoffSummary[];
  const h1 = handoffs.find((h) => h.handoffType === "H1");
  const tasks = (entry.preArrivalTasks ?? []) as PreArrivalTaskSummary[];
  const assignments = (entry.roomAssignments ?? []) as RoomAssignmentSummary[];
  const latestAssignment = assignments[0];

  const sealedPreferred = (entry.availabilityConfigs ?? []).find(
    (c: AvailabilityConfigSummary) => c.sealedAt && c.optionSelected,
  );
  const sealedRoomIds = optionSelectedRoomIds(sealedPreferred?.optionSelected);
  const defaultRoomId =
    entry.committedHold?.roomId ?? sealedRoomIds[0] ?? "";

  const [roomId, setRoomId] = useState(defaultRoomId);
  const [assignNotes, setAssignNotes] = useState("");
  const [h1ChecklistCompletion, setH1ChecklistCompletion] = useState<Record<string, boolean>>({});
  const [waiveReasons, setWaiveReasons] = useState<Record<string, string>>({});
  const [guestPresent, setGuestPresent] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const h1ChecklistQuery = useQuery({
    queryKey: ["handoff-checklist", "H1"],
    queryFn: () => getHandoffChecklist(session!, "H1"),
    enabled: !!session && !!h1 && h1.state === "CREATED",
  });
  const h1ChecklistItems = (h1ChecklistQuery.data?.items ?? []) as HandoffChecklistItem[];

  useEffect(() => {
    if (h1ChecklistItems.length === 0) return;
    setH1ChecklistCompletion((prev) => {
      const next = { ...prev };
      for (const item of h1ChecklistItems) {
        if (next[item.code] === undefined) next[item.code] = false;
      }
      return next;
    });
  }, [h1ChecklistItems]);

  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session && entry.currentStage === "S5" && !latestAssignment,
  });

  const preferredConfigRooms = useMemo(() => {
    if (!sealedPreferred?.resultSet) return [];
    const { availableRooms, deficientRooms } = roomsFromResultSet(sealedPreferred.resultSet);
    return [...availableRooms, ...deficientRooms];
  }, [sealedPreferred]);

  const roomOptions = useMemo(() => {
    const byId = new Map<
      string,
      {
        id: string;
        roomNumber: string;
        physicalState?: string;
        currentClaimState?: string;
        isBlocked?: boolean;
      }
    >();
    for (const r of preferredConfigRooms) {
      if (r.roomId) {
        byId.set(r.roomId, {
          id: r.roomId,
          roomNumber: r.roomNumber ?? r.roomId,
          physicalState: undefined,
          currentClaimState: r.claimState,
        });
      }
    }
    for (const r of roomsCatalogQuery.data?.items ?? []) {
      byId.set(r.id, {
        id: r.id,
        roomNumber: r.roomNumber,
        physicalState: r.physicalState,
        currentClaimState: r.currentClaimState,
        isBlocked: r.isBlocked,
      });
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
    );
  }, [preferredConfigRooms, roomsCatalogQuery.data]);

  useEffect(() => {
    if (roomId || !defaultRoomId) return;
    setRoomId(defaultRoomId);
  }, [defaultRoomId, roomId]);

  const h1MandatoryComplete = h1ChecklistItems
    .filter((i) => i.mandatory)
    .every((i) => h1ChecklistCompletion[i.code] === true);

  const canAcceptH1 =
    h1?.state === "CREATED" &&
    (h1ChecklistItems.length === 0 || h1MandatoryComplete);

  const paymentStatusQuery = useQuery({
    queryKey: ["payment-status", entry.id],
    queryFn: () => getPaymentStatus(session!, entry.id),
    enabled: !!session && !!folio?.id,
  });
  const paymentStatus = paymentStatusQuery.data;

  const hasCreditCeiling = reservation?.creditCeilingIfExtended != null;
  const creditNeedsAck =
    hasCreditCeiling &&
    paymentStatus?.creditExtensionActive &&
    !entry.creditCeilingTier2AcknowledgedAt &&
    paymentStatus.ceilingAmount != null &&
    paymentStatus.totalReceived >= paymentStatus.ceilingAmount * 0.9;

  const paymentReconciled =
    !!folio?.advancePaymentReconciliationComplete || paymentStatus?.satisfied === true;

  const tasksComplete =
    tasks.length > 0 && tasks.every((t) => t.status === "COMPLETE" || t.status === "WAIVED");

  const roomReadinessConfirmed = isRoomReadinessConfirmed(latestAssignment);

  const h1FulfilmentEvidence = latestAssignment
    ? buildH1FulfilmentEvidence({
        roomAssignmentId: latestAssignment.id,
        readinessConfirmed: roomReadinessConfirmed,
        paymentStatusConfirmed: paymentReconciled,
        ceilingProximityAddressed: !creditNeedsAck,
      })
    : null;

  const canFulfilH1 =
    h1?.state === "ACCEPTED" &&
    !!h1FulfilmentEvidence &&
    h1FulfilmentEvidence.readinessConfirmed &&
    h1FulfilmentEvidence.paymentStatusConfirmed &&
    tasksComplete;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
  };

  const activateMutation = useMutation({
    mutationFn: () => {
      startTransition({ targetStage: "S5", label: "Activating pre-arrival…" });
      return activatePreArrival(session!, entry.id);
    },
    onSuccess: (updated) => {
      setActionError(null);
      queryClient.setQueryData(["entry", entry.id], updated);
      invalidate();
      toast.success("Pre-arrival activated — entry is now at S5");
      router.push(stagePath(entry.id, "S5"));
    },
    onError: (e) => {
      endTransition();
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Activation failed");
    },
  });

  const acceptH1Mutation = useMutation({
    mutationFn: () => {
      const completion: Record<string, boolean> = {};
      for (const item of h1ChecklistItems) {
        completion[item.code] = h1ChecklistCompletion[item.code] === true;
      }
      return acceptHandoff(session!, h1!.id, completion);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("H1 handoff accepted");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Accept failed");
    },
  });

  const fulfilH1Mutation = useMutation({
    mutationFn: () => fulfilHandoff(session!, h1!.id, h1FulfilmentEvidence!),
    onSuccess: () => {
      setActionError(null);
      toast.success("H1 handoff fulfilled");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Fulfil failed");
    },
  });

  const assignMutation = useMutation({
    mutationFn: () =>
      assignRoom(session!, entry.id, {
        roomId: roomId.trim(),
        notes: assignNotes.trim() || undefined,
      }),
    onSuccess: () => {
      setActionError(null);
      toast.success("Room assigned");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Assignment failed");
    },
  });

  const reconcileMutation = useMutation({
    mutationFn: () => {
      if (!folio?.id) throw new Error("No folio");
      return reconcileAdvancePayment(session!, folio.id, {
        entryId: entry.id,
        note: "S5 reconciliation",
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Advance payment reconciled");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Reconcile failed");
    },
  });

  const creditAckMutation = useMutation({
    mutationFn: () => acknowledgeCreditCeilingTier2(session!, entry.id),
    onSuccess: (updated) => {
      setActionError(null);
      queryClient.setQueryData(["entry", entry.id], updated);
      toast.success("Credit ceiling proximity acknowledged (FOM)");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Acknowledgement failed");
    },
  });

  const completeTask = (taskId: string) =>
    patchPreArrivalTask(session!, taskId, { action: "COMPLETE" });

  const waiveTask = (taskId: string, reason: string) =>
    patchPreArrivalTask(session!, taskId, { action: "WAIVE", waivedReason: reason });

  const taskMutation = useMutation({
    mutationFn: async ({ taskId, action }: { taskId: string; action: "COMPLETE" | "WAIVE" }) => {
      if (action === "COMPLETE") return completeTask(taskId);
      const reason = waiveReasons[taskId]?.trim();
      if (!reason) throw new Error("Waive reason is required");
      return waiveTask(taskId, reason);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Task updated");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof Error ? e.message : "Task update failed");
    },
  });

  const s5ExitChecks = useMemo(
    () => [
      {
        label: "H1 handoff fulfilled",
        ok: h1?.state === "FULFILLED",
        detail: h1 ? `Current: ${h1.state}` : "No H1 on record",
      },
      {
        label: "Room assigned",
        ok: !!latestAssignment,
        detail: latestAssignment?.room?.roomNumber
          ? `Room ${latestAssignment.room.roomNumber}`
          : undefined,
      },
      {
        label: "Pre-arrival tasks complete or waived",
        ok: tasks.length > 0 && tasks.every((t) => t.status === "COMPLETE" || t.status === "WAIVED"),
        detail: tasks.length === 0 ? "Activate S5 to seed tasks" : `${tasks.filter((t) => t.status === "PENDING").length} pending`,
      },
      {
        label: "Advance payment reconciled",
        ok: !!folio?.advancePaymentReconciliationComplete || paymentStatus?.satisfied === true,
        detail: folio?.advancePaymentReconciliationComplete ? "Folio flagged reconciled" : undefined,
      },
      {
        label: "Credit ceiling FOM ack (if Tier 2)",
        ok: !creditNeedsAck,
        detail: creditNeedsAck ? "FOM acknowledgement required" : undefined,
      },
      {
        label: "Guest physically present (for check-in)",
        ok: guestPresent,
        detail: "Required to progress to S6",
      },
    ],
    [h1, latestAssignment, tasks, folio, paymentStatus, creditNeedsAck, guestPresent],
  );

  const canProgressS6 = s5ExitChecks.every((c) => c.ok);

  if (entry.currentStage === "S4") {
    return (
      <StagePanel meta={meta}>
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plane className="h-4 w-4" />
              Activate pre-arrival (S5)
            </CardTitle>
            <CardDescription>
              SIG-S5 — the pre-arrival window must open before this stage. Same-day arrivals can activate
              immediately (W4 worker logic).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Check-in: {entry.checkInDate?.slice(0, 10) ?? "—"}. Confirm reservation and custodian sign-off on
              S4 first.
            </p>
            <Button
              variant="gradient"
              disabled={activateMutation.isPending || !reservation}
              onClick={() => activateMutation.mutate()}
            >
              {activateMutation.isPending ? "Activating…" : "Activate pre-arrival → S5"}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={stagePath(entry.id, "S4")}>Back to S4 confirmation</Link>
            </Button>
          </CardContent>
        </Card>
        <ApiErrorAlert error={actionError} />
      </StagePanel>
    );
  }

  // Stage-mismatch gate removed — ReadOnlyShell handles past/future stage viewing.

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pre-arrival context</CardTitle>
            <CardDescription>SIG-S5 — readiness before check-in (S6). Folio stays provisional.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            {reservation && (
              <div className="sm:col-span-2">
                <span className="text-muted-foreground">Reservation ID:</span>{" "}
                <span className="font-mono text-xs">{formatListId(reservation.id)}</span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Arrival:</span>{" "}
              {reservation?.frozenCheckInDate?.slice(0, 10) ?? entry.checkInDate?.slice(0, 10) ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Folio:</span>{" "}
              <StatusBadge status={folio?.state ?? "—"} />
            </div>
            <div>
              <span className="text-muted-foreground">Billing:</span> {folio?.billingModel ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Frozen rate:</span> BTN{" "}
              {reservation?.frozenRate != null ? String(reservation.frozenRate) : "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Voucher:</span>{" "}
              {reservation?.confirmationVoucherSent ? (
                <span className="text-emerald-700 dark:text-emerald-400">Sent at S4</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Not recorded</span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Handshake className="h-4 w-4" />
              H1 handoff (reservations → front desk)
            </CardTitle>
            <CardDescription>Accept then fulfil — S5→S6 requires FULFILLED, not only ACCEPTED.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!h1 ? (
              <p className="text-sm text-muted-foreground">No H1 handoff on record.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline">{h1.state}</Badge>
                  <span className="text-muted-foreground">
                    {h1.fromRole} → {h1.toRole}
                  </span>
                  {h1.isAutoFulfilled && <Badge variant="secondary">Auto-fulfilled team</Badge>}
                </div>
                {h1.state === "CREATED" && (
                  <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Acceptance checklist (all mandatory items required)
                    </p>
                    {h1ChecklistQuery.isLoading ? (
                      <p className="text-sm text-muted-foreground">Loading checklist…</p>
                    ) : h1ChecklistItems.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No checklist configured.</p>
                    ) : (
                      h1ChecklistItems.map((item) => (
                        <label
                          key={item.code}
                          className="flex cursor-pointer items-start gap-3 text-sm"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border"
                            checked={h1ChecklistCompletion[item.code] === true}
                            onChange={(e) =>
                              setH1ChecklistCompletion((prev) => ({
                                ...prev,
                                [item.code]: e.target.checked,
                              }))
                            }
                          />
                          <span>
                            {item.description ?? item.code.replace(/_/g, " ").toLowerCase()}
                            {item.mandatory && (
                              <span className="ml-1 text-xs text-destructive">(required)</span>
                            )}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={acceptH1Mutation.isPending || !canAcceptH1}
                    onClick={() => acceptH1Mutation.mutate()}
                  >
                    Accept H1
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={fulfilH1Mutation.isPending || !canFulfilH1}
                    onClick={() => fulfilH1Mutation.mutate()}
                  >
                    Record fulfilment
                  </Button>
                </div>
                {h1.state === "CREATED" && !canAcceptH1 && h1ChecklistItems.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Complete all required checklist items before accepting H1.
                  </p>
                )}
                {h1.state === "ACCEPTED" && !canFulfilH1 && (
                  <p className="text-xs text-muted-foreground">
                    Before fulfilment: assign a room
                    {!latestAssignment && " (not yet assigned)"}
                    {latestAssignment && !roomReadinessConfirmed && " (room not ready or deficient ack missing)"}
                    {!tasksComplete && " · complete or waive all pre-arrival tasks"}
                    {!paymentReconciled && " · reconcile advance payment"}
                    {creditNeedsAck && " · FOM credit ceiling acknowledgement required"}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BedDouble className="h-4 w-4" />
              Room assignment
            </CardTitle>
            <CardDescription>Assign from committed hold or sealed availability selection.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {latestAssignment ? (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                Assigned:{" "}
                <strong>
                  {latestAssignment.room?.roomNumber
                    ? `Room ${latestAssignment.room.roomNumber}`
                    : "Room (number pending)"}
                </strong>
                {latestAssignment.room?.currentClaimState && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatClaimState(latestAssignment.room.currentClaimState)}
                  </span>
                )}
                {latestAssignment.room?.physicalState && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatPhysicalState(latestAssignment.room.physicalState)}
                  </span>
                )}
                {latestAssignment.deficientAtAssignment && (
                  <Badge className="ml-2" variant="outline">
                    Deficient acknowledged
                  </Badge>
                )}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Select room</label>
                  <select
                    className="flex h-10 w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                  >
                    <option value="">Choose a room…</option>
                    {roomOptions.map((r) => (
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
                  {defaultRoomId && (
                    <p className="text-xs text-muted-foreground">
                      Suggested from committed hold / sealed availability.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Notes (optional)</label>
                  <Input value={assignNotes} onChange={(e) => setAssignNotes(e.target.value)} />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={assignMutation.isPending || !roomId.trim()}
                  onClick={() => assignMutation.mutate()}
                >
                  Assign room
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="h-4 w-4" />
              Pre-arrival tasks
            </CardTitle>
            <CardDescription>All tasks must be COMPLETE or WAIVED before check-in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tasks yet. If you just landed on S5, refresh — or re-run activation from S4.
              </p>
            ) : (
              tasks.map((task) => (
                <div key={task.id} className="rounded-lg border px-3 py-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{taskLabel(task.taskType)}</span>
                    <StatusBadge status={task.status} />
                  </div>
                  {task.status === "PENDING" && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={taskMutation.isPending}
                        onClick={() => taskMutation.mutate({ taskId: task.id, action: "COMPLETE" })}
                      >
                        Complete
                      </Button>
                      <Input
                        className="max-w-xs text-xs"
                        placeholder="Waive reason (required)"
                        value={waiveReasons[task.id] ?? ""}
                        onChange={(e) =>
                          setWaiveReasons((prev) => ({ ...prev, [task.id]: e.target.value }))
                        }
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={taskMutation.isPending}
                        onClick={() => taskMutation.mutate({ taskId: task.id, action: "WAIVE" })}
                      >
                        Waive
                      </Button>
                    </div>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment & credit</CardTitle>
            <CardDescription>Advance reconciliation and credit ceiling proximity (Policy 28 / 44).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {paymentStatus && (
              <div className="grid gap-1">
                <p>
                  Received: {paymentStatus.totalReceived} / required {paymentStatus.requiredAmount}
                  {paymentStatus.satisfied ? (
                    <span className="ml-2 text-emerald-600">Satisfied</span>
                  ) : (
                    <span className="ml-2 text-amber-600">Shortfall {paymentStatus.shortfall}</span>
                  )}
                </p>
                {hasCreditCeiling && (
                  <p className="text-muted-foreground">
                    Credit ceiling: {String(reservation?.creditCeilingIfExtended)}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={reconcileMutation.isPending || folio?.advancePaymentReconciliationComplete}
                onClick={() => reconcileMutation.mutate()}
              >
                Reconcile advance payment
              </Button>
              {creditNeedsAck && session && isElevated(session.actorLevel) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={creditAckMutation.isPending}
                  onClick={() => creditAckMutation.mutate()}
                >
                  FOM: acknowledge credit ceiling (Tier 2)
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4" />
              S5 exit → Check-in (S6)
            </CardTitle>
            <CardDescription>SIG-S5 §1.5 — all guards must pass before guest check-in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {s5ExitChecks.map((item) => (
              <div key={item.label} className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm">
                  {item.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span>{item.label}</span>
                </div>
                {item.detail && <p className="pl-6 text-xs text-muted-foreground">{item.detail}</p>}
              </div>
            ))}
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border"
                checked={guestPresent}
                onChange={(e) => setGuestPresent(e.target.checked)}
              />
              Guest is physically present at the front desk
            </label>
            <ProgressStageButton
              entryId={entry.id}
              version={entry.version}
              targetStage="S6"
              label="Progress to check-in (S6)"
              disabled={!canProgressS6}
              guestPhysicallyPresent={guestPresent}
            />
          </CardContent>
        </Card>

        <ApiErrorAlert error={actionError} />
      </div>
    </StagePanel>
  );
}
