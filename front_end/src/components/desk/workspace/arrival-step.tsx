"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BedDouble, Handshake, ListChecks, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  acceptHandoff,
  acknowledgeCreditCeilingTier2,
  assignRoom,
  assignRoomsFromSealedPerNight,
  buildH1FulfilmentEvidence,
  fulfilHandoff,
  getHandoffChecklist,
  patchPreArrivalTask,
} from "@/lib/api/pre-arrival";
import { roomsFromResultSet } from "@/lib/api/availability";
import { getPaymentStatus, reconcileAdvancePayment } from "@/lib/api/reservation-setup";
import { listRooms } from "@/lib/api/rooms";
import { formatRoomPickerLabel } from "@/lib/room-inventory-status";
import type { HandoffChecklistItem } from "@/lib/api/handoffs";
import { money } from "@/lib/desk/workspace";
import { StepAction } from "./step-action";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail, RoomAssignmentSummary } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";

const BK = STAGE_ACTIONS.S5;

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

const ROOM_READY_STATES = new Set(["AVAILABLE_CLEAN", "AVAILABLE_INSPECTED"]);
function roomReady(a: RoomAssignmentSummary | undefined) {
  if (!a) return false;
  const ps = a.room?.physicalState;
  if (ps && ROOM_READY_STATES.has(ps)) return true;
  if (a.deficientAtAssignment) return Boolean(a.acknowledgementActorId && a.acknowledgementAt);
  return !ps;
}

function taskLabel(t: string) {
  return t.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ArrivalStep({
  entry,
  guestPresent,
  setGuestPresent,
}: {
  entry: EntryDetail;
  guestPresent: boolean;
  setGuestPresent: (v: boolean) => void;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const reservation = entry.reservation;
  const folio = entry.folio;
  const h1 = (entry.handoffs ?? []).find((h) => h.handoffType === "H1");
  const tasks = entry.preArrivalTasks ?? [];
  const assignments = entry.roomAssignments ?? [];
  const latestAssignment = assignments[0];
  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const defaultRoomId = entry.committedHold?.roomId ?? optionSelectedRoomIds(sealedPreferred?.optionSelected)[0] ?? "";

  // Multi-room bookings (party-size driven, not source channel) assign every sealed room in one
  // bulk call rather than the single-room picker below.
  const numberOfRooms = entry.numberOfRooms ?? 1;
  const multiRoom = numberOfRooms > 1;
  const sealedRoomIds = optionSelectedRoomIds(sealedPreferred?.optionSelected);

  const [roomId, setRoomId] = useState(defaultRoomId);
  const [assignNotes, setAssignNotes] = useState("");
  const [h1Completion, setH1Completion] = useState<Record<string, boolean>>({});
  const [waiveReasons, setWaiveReasons] = useState<Record<string, string>>({});

  const elevated = isElevated(session?.actorLevel);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
  };
  const wrap = <T,>(fn: () => Promise<T>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(msg);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const h1ChecklistQuery = useQuery({
    queryKey: ["handoff-checklist", "H1"],
    queryFn: () => getHandoffChecklist(session!, "H1"),
    enabled: !!session && !!h1 && h1.state === "CREATED",
  });
  const h1Items = (h1ChecklistQuery.data?.items ?? []) as HandoffChecklistItem[];
  useEffect(() => {
    if (h1Items.length === 0) return;
    setH1Completion((prev) => {
      const next = { ...prev };
      for (const i of h1Items) if (next[i.code] === undefined) next[i.code] = false;
      return next;
    });
  }, [h1Items]);

  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session && !latestAssignment,
  });

  const preferredRooms = useMemo(() => {
    if (!sealedPreferred?.resultSet) return [];
    const { availableRooms, deficientRooms } = roomsFromResultSet(sealedPreferred.resultSet);
    return [...availableRooms, ...deficientRooms];
  }, [sealedPreferred]);

  const roomOptions = useMemo(() => {
    const byId = new Map<string, { id: string; roomNumber: string; physicalState?: string; currentClaimState?: string; isBlocked?: boolean }>();
    for (const r of preferredRooms) {
      if (r.roomId) byId.set(r.roomId, { id: r.roomId, roomNumber: r.roomNumber ?? r.roomId, currentClaimState: r.claimState });
    }
    for (const r of roomsCatalogQuery.data?.items ?? []) {
      byId.set(r.id, { id: r.id, roomNumber: r.roomNumber, physicalState: r.physicalState, currentClaimState: r.currentClaimState, isBlocked: r.isBlocked });
    }
    return [...byId.values()].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [preferredRooms, roomsCatalogQuery.data]);

  useEffect(() => {
    if (roomId || !defaultRoomId) return;
    setRoomId(defaultRoomId);
  }, [defaultRoomId, roomId]);

  // Room number lookup for the multi-room sealed-plan summary (before assignments materialise).
  const roomNumberById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of preferredRooms) if (r.roomId) m.set(r.roomId, r.roomNumber ?? r.roomId);
    for (const a of assignments) if (a.room?.roomNumber) m.set(a.roomId, a.room.roomNumber);
    return m;
  }, [preferredRooms, assignments]);

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

  const paymentReconciled = !!folio?.advancePaymentReconciliationComplete || paymentStatus?.satisfied === true;
  const tasksComplete = tasks.length > 0 && tasks.every((t) => t.status === "COMPLETE" || t.status === "WAIVED");
  // For a multi-room booking every assigned room must be ready; single-room keeps the prior check.
  const readinessConfirmed = multiRoom
    ? assignments.length > 0 && assignments.every((a) => roomReady(a))
    : roomReady(latestAssignment);

  const h1MandatoryComplete = h1Items.filter((i) => i.mandatory).every((i) => h1Completion[i.code] === true);
  const canAcceptH1 = h1?.state === "CREATED" && (h1Items.length === 0 || h1MandatoryComplete);
  const canFulfilH1 =
    h1?.state === "ACCEPTED" && !!latestAssignment && readinessConfirmed && paymentReconciled && tasksComplete;

  const acceptM = useMutation(
    wrap(() => {
      const completion: Record<string, boolean> = {};
      for (const i of h1Items) completion[i.code] = h1Completion[i.code] === true;
      return acceptHandoff(session!, h1!.id, completion);
    }, "Handoff accepted"),
  );
  const fulfilM = useMutation(
    wrap(
      () =>
        fulfilHandoff(
          session!,
          h1!.id,
          buildH1FulfilmentEvidence({
            roomAssignmentId: latestAssignment!.id,
            readinessConfirmed,
            paymentStatusConfirmed: paymentReconciled,
            ceilingProximityAddressed: !creditNeedsAck,
          }),
        ),
      "Handoff fulfilled",
    ),
  );
  const assignM = useMutation(
    wrap(() => assignRoom(session!, entry.id, { roomId: roomId.trim(), notes: assignNotes.trim() || undefined }), "Room assigned"),
  );
  const bulkAssignM = useMutation(
    wrap(async () => {
      const res = await assignRoomsFromSealedPerNight(session!, entry.id);
      if (res.count === 0) throw new Error("No per-night selection to assign — re-seal rooms at the Inquiry step.");
      return res;
    }, "Rooms assigned"),
  );
  const reconcileM = useMutation(
    wrap(() => {
      if (!folio?.id) throw new Error("No folio");
      return reconcileAdvancePayment(session!, folio.id, { entryId: entry.id, note: "Arrival reconciliation" });
    }, "Advance reconciled"),
  );
  const creditAckM = useMutation(
    wrap(() => acknowledgeCreditCeilingTier2(session!, entry.id), "Credit ceiling acknowledged"),
  );
  const taskM = useMutation({
    mutationFn: async ({ taskId, action }: { taskId: string; action: "COMPLETE" | "WAIVE" }) => {
      if (action === "COMPLETE") return patchPreArrivalTask(session!, taskId, { action: "COMPLETE" });
      const reason = waiveReasons[taskId]?.trim();
      if (!reason) throw new Error("Waive reason required");
      return patchPreArrivalTask(session!, taskId, { action: "WAIVE", waivedReason: reason });
    },
    onSuccess: () => {
      toast.success("Task updated");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Task update failed"),
  });

  const currency = folio?.lines?.[0]?.currency;

  // Persistent highlight: each group stays lit once its action has run (derived from real handoff /
  // assignment / reconciliation state). `firingKey` adds the transient "running now" pulse.
  const activeKeys = [
    h1 && (h1.state === "ACCEPTED" || h1.state === "FULFILLED") ? "handoff" : null,
    latestAssignment ? "assign" : null,
    paymentReconciled || entry.creditCeilingTier2AcknowledgedAt ? "reconcile" : null,
    entry.currentStage !== "S5" ? "advance" : null,
  ].filter(Boolean) as string[];
  const firingKey = acceptM.isPending || fulfilM.isPending
    ? "handoff"
    : assignM.isPending
      ? "assign"
      : reconcileM.isPending || creditAckM.isPending
        ? "reconcile"
        : null;
  const railGroups: RailGroup[] = [
    { key: "handoff", label: "On the H1 handoff", items: BK.handoff },
    { key: "assign", label: "On assigning a room", items: BK.assign },
    { key: "reconcile", label: "On reconciling advance / credit", items: BK.reconcile },
    { key: "advance", label: "On advancing to Check-in", items: BK.advance },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
      <div className="speak">
        <div className="now">Do this next</div>
        <h2>Ready the room for arrival.</h2>
        <p>
          Accept the handoff from reservations, assign a specific room, clear the pre-arrival checklist, and
          confirm the advance. Still reversible — nothing about the stay is live yet.
        </p>
      </div>

      {/* H1 handoff */}
      <div className="block">
        <BlockH>
          <Handshake style={{ width: 13, height: 13 }} />
          Handoff to front desk
        </BlockH>
        {!h1 ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>No handoff on record.</p>
        ) : (
          <>
            <div className="fact b-transit" style={{ marginBottom: 11, padding: "6px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
              <span>
                {h1.fromRole} → {h1.toRole}
              </span>
              <span className="tag">{h1.state}</span>
            </div>
            {h1.state === "CREATED" && (
              <div style={{ marginBottom: 11 }}>
                {h1ChecklistQuery.isLoading ? (
                  <p style={{ fontSize: 12, color: "var(--ink-3)" }}>Loading checklist…</p>
                ) : h1Items.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No checklist configured.</p>
                ) : (
                  h1Items.map((item) => (
                    <label key={item.code} className="checkline" style={{ cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={h1Completion[item.code] === true}
                        onChange={(e) => setH1Completion((prev) => ({ ...prev, [item.code]: e.target.checked }))}
                      />
                      <span>
                        {item.description ?? item.code.replace(/_/g, " ").toLowerCase()}
                        {item.mandatory && <span style={{ color: "var(--stop)", fontSize: 11 }}> (required)</span>}
                      </span>
                    </label>
                  ))
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <StepAction
                label="Accept handoff"
                doneLabel="Handoff accepted"
                done={h1.state === "ACCEPTED" || h1.state === "FULFILLED"}
                pending={acceptM.isPending}
                disabled={!canAcceptH1}
                onClick={() => acceptM.mutate()}
              />
              <StepAction
                label="Record fulfilment"
                doneLabel="Fulfilled"
                done={h1.state === "FULFILLED"}
                pending={fulfilM.isPending}
                disabled={!canFulfilH1}
                onClick={() => fulfilM.mutate()}
              />
            </div>
            {h1.state === "ACCEPTED" && !canFulfilH1 && (
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "8px 0 0", lineHeight: 1.5 }}>
                Before fulfilment: assign a ready room, complete pre-arrival tasks, and reconcile the advance.
              </p>
            )}
          </>
        )}
      </div>

      {/* Room assignment */}
      <div className="block">
        <BlockH>
          <BedDouble style={{ width: 13, height: 13 }} />
          Room assignment
        </BlockH>
        {multiRoom ? (
          <>
            <div className="fact b-transit" style={{ marginBottom: 11, padding: "6px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
              <span>
                {numberOfRooms} rooms needed · {assignments.length} assigned
              </span>
              <span className={`tag${sealedPreferred ? "" : " warn"}`}>{sealedPreferred ? "sealed plan ready" : "no sealed plan"}</span>
            </div>
            {assignments.length > 0 ? (
              <div style={{ display: "grid", gap: 6, marginBottom: 11 }}>
                {assignments.map((a) => (
                  <div key={a.id} className="fact" style={{ justifyContent: "space-between", fontSize: 12, padding: "6px 10px" }}>
                    <span>
                      Room {a.room?.roomNumber ?? a.roomId.slice(0, 8)}
                      {a.startDate && (
                        <span style={{ color: "var(--ink-3)" }}>
                          {" "}· {a.startDate.slice(0, 10)} → {a.endDate?.slice(0, 10) ?? ""}
                        </span>
                      )}
                    </span>
                    <span className={`tag${roomReady(a) ? "" : " warn"}`}>{roomReady(a) ? "ready" : "not ready"}</span>
                  </div>
                ))}
              </div>
            ) : (
              sealedRoomIds.length > 0 && (
                <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "0 0 11px" }}>
                  Sealed plan: {sealedRoomIds.map((id) => roomNumberById.get(id) ?? id.slice(0, 6)).join(", ")}
                  {" — assigned in one step below."}
                </p>
              )
            )}
            <StepAction
              className="btn btn-primary"
              label={`Assign all ${numberOfRooms} rooms`}
              doneLabel={`${assignments.length} room${assignments.length === 1 ? "" : "s"} assigned`}
              done={assignments.length > 0}
              pending={bulkAssignM.isPending}
              disabled={!sealedPreferred || assignments.length > 0}
              onClick={() => bulkAssignM.mutate()}
            />
            {!sealedPreferred && (
              <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "8px 0 0" }}>
                No sealed room plan — go back to the Inquiry step and seal {numberOfRooms} rooms first.
              </p>
            )}
          </>
        ) : (
          <>
            {!latestAssignment && (
              <>
                <div className="field">
                  <label>Select room</label>
                  <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                    <option value="">Choose a room…</option>
                    {roomOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {formatRoomPickerLabel({ roomNumber: r.roomNumber, currentClaimState: r.currentClaimState, physicalState: r.physicalState, isBlocked: r.isBlocked })}
                      </option>
                    ))}
                  </select>
                  {defaultRoomId && <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "5px 0 0" }}>Suggested from the committed hold / preferred option.</p>}
                </div>
                <div className="field">
                  <label>Notes (optional)</label>
                  <input value={assignNotes} onChange={(e) => setAssignNotes(e.target.value)} />
                </div>
              </>
            )}
            <StepAction
              className="btn btn-primary"
              label="Assign room"
              doneLabel={`${latestAssignment?.room?.roomNumber ? `Room ${latestAssignment.room.roomNumber} assigned` : "Room assigned"}${latestAssignment?.deficientAtAssignment ? " · deficient acknowledged" : ""}`}
              done={!!latestAssignment}
              pending={assignM.isPending}
              disabled={!roomId.trim()}
              onClick={() => assignM.mutate()}
            />
          </>
        )}
      </div>

      {/* Pre-arrival tasks */}
      <div className="block">
        <BlockH>
          <ListChecks style={{ width: 13, height: 13 }} />
          Pre-arrival tasks
        </BlockH>
        {tasks.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>No tasks seeded yet.</p>
        ) : (
          tasks.map((task) => (
            <div key={task.id} style={{ borderBottom: "1px dashed var(--line)", padding: "8px 0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{taskLabel(task.taskType)}</span>
                <span className={`tag ${task.status === "PENDING" ? "warn" : ""}`}>{task.status}</span>
              </div>
              {task.status === "PENDING" && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
                  <button className="btn btn-ghost btn-sm" disabled={taskM.isPending} onClick={() => taskM.mutate({ taskId: task.id, action: "COMPLETE" })}>
                    Complete
                  </button>
                  <input
                    className="dinput"
                    style={{ flex: 1, minWidth: 140 }}
                    placeholder="Waive reason"
                    value={waiveReasons[task.id] ?? ""}
                    onChange={(e) => setWaiveReasons((prev) => ({ ...prev, [task.id]: e.target.value }))}
                  />
                  <button className="btn btn-ghost btn-sm" disabled={taskM.isPending} onClick={() => taskM.mutate({ taskId: task.id, action: "WAIVE" })}>
                    Waive
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Payment & credit */}
      <div className="block">
        <BlockH>Advance &amp; credit</BlockH>
        {paymentStatus && (
          <div className="fact b-transit" style={{ marginBottom: 11, padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
            <span>
              Received {money(paymentStatus.totalReceived, currency)} / required {money(paymentStatus.requiredAmount, currency)}
            </span>
            <span className={`tag ${paymentStatus.satisfied ? "" : "warn"}`}>
              {paymentStatus.satisfied ? "Satisfied" : `Short ${money(paymentStatus.shortfall, currency)}`}
            </span>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <StepAction
            label="Reconcile advance"
            doneLabel="Reconciled"
            done={!!folio?.advancePaymentReconciliationComplete}
            pending={reconcileM.isPending}
            onClick={() => reconcileM.mutate()}
          />
          <button className="btn btn-ghost btn-sm" disabled={paymentStatusQuery.isFetching} onClick={() => paymentStatusQuery.refetch()}>
            <RefreshCw style={{ width: 12, height: 12 }} />
            Refresh
          </button>
          {creditNeedsAck && elevated && (
            <button className="btn btn-ghost btn-sm" disabled={creditAckM.isPending} onClick={() => creditAckM.mutate()}>
              FOM: acknowledge credit ceiling
            </button>
          )}
        </div>
      </div>

      {/* Guest present attestation */}
      <div className="block">
        <BlockH>Guest at the desk</BlockH>
        <label className="checkline" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={guestPresent} onChange={(e) => setGuestPresent(e.target.checked)} />
          <span>The guest is physically present at the front desk (required to check in)</span>
        </label>
      </div>
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />
    </div>
  );
}
