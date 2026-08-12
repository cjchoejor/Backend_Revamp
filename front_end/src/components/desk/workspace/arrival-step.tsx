"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BedDouble, Handshake, ListChecks } from "lucide-react";
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
import { cancelEntryAtS5, getPaymentStatus } from "@/lib/api/reservation-setup";
import { AdvanceSettlementBlock } from "./advance-settlement";
import { listRooms, setRoomBedType } from "@/lib/api/rooms";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listIdentityProofs } from "@/lib/api/identity-proofs";
import { mealPlanSummary, operativeRoomCompositions, partySlotLabels, seatPartyByComposition } from "@/lib/desk/party-rooms";
import { deriveRoomStatus, ROOM_STATUS } from "@/lib/desk/rooms";
import { money } from "@/lib/desk/workspace";
import { formatRoomPickerLabel } from "@/lib/room-inventory-status";
import type { HandoffChecklistItem } from "@/lib/api/handoffs";
import { StepAction } from "./step-action";
import { DeskConfirmModal } from "./confirm-modal";
import { BackendRail, type RailGroup } from "./backend-inline";
import { CommunicationAcceptanceBlock } from "./communication-acceptance";
import { IdentityProofBlock } from "./identity-proof";
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
  // Collapsed-first room assignment (2026-08-10, operator request): the block used to jump
  // between "sealed plan" and a bare dropdown depending on booking shape. Now the sealed/
  // suggested selection shows as a summary line and the picker (with its bed-type filter,
  // fed from the room registry) only appears on "Change room".
  const [roomEditOpen, setRoomEditOpen] = useState(false);
  const [bedFilter, setBedFilter] = useState("");
  const [h1Completion, setH1Completion] = useState<Record<string, boolean>>({});
  const [waiveReasons, setWaiveReasons] = useState<Record<string, string>>({});
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelWaiver, setCancelWaiver] = useState(false);

  const elevated = isElevated(session?.actorLevel);
  const isGm = session?.actorLevel === "L3" || session?.actorLevel === "L4";

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    // Sending the pre-arrival reminder creates the CommunicationRecord the acceptance block
    // below reads — its own query key, not part of the entry payload (same omission that hid
    // the S3 proforma reply block until a page refresh).
    void queryClient.invalidateQueries({ queryKey: ["entry-communications", entry.id] });
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
    // Always on (app-cache shared): the collapsed summary and sealed-plan lines show each
    // room's bed type even after an assignment exists.
    enabled: !!session,
  });

  const preferredRooms = useMemo(() => {
    if (!sealedPreferred?.resultSet) return [];
    const { availableRooms, deficientRooms } = roomsFromResultSet(sealedPreferred.resultSet);
    return [...availableRooms, ...deficientRooms];
  }, [sealedPreferred]);

  const roomOptions = useMemo(() => {
    const byId = new Map<
      string,
      { id: string; roomNumber: string; physicalState?: string; currentClaimState?: string; isBlocked?: boolean; bedType?: string | null; roomTypeName?: string | null }
    >();
    for (const r of preferredRooms) {
      if (r.roomId) byId.set(r.roomId, { id: r.roomId, roomNumber: r.roomNumber ?? r.roomId, currentClaimState: r.claimState });
    }
    for (const r of roomsCatalogQuery.data?.items ?? []) {
      byId.set(r.id, {
        id: r.id,
        roomNumber: r.roomNumber,
        physicalState: r.physicalState,
        currentClaimState: r.currentClaimState,
        isBlocked: r.isBlocked,
        bedType: r.bedType ?? null,
        roomTypeName: r.roomType?.name ?? null,
      });
    }
    return [...byId.values()].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [preferredRooms, roomsCatalogQuery.data]);

  // Bed setup per room, straight from the room registry (backend) — drives the Twin/King
  // filter and the bed tags on the summary lines. Display form: "KING" → "King".
  const bedLabel = (t?: string | null) => (t ? t.charAt(0) + t.slice(1).toLowerCase() : null);
  const bedTypeByRoomId = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of roomsCatalogQuery.data?.items ?? []) if (r.bedType) m.set(r.id, r.bedType);
    return m;
  }, [roomsCatalogQuery.data]);
  const bedTypes = useMemo(() => {
    // Room numbers per type ride along so the filter options can NAME the rooms
    // ("King (13 rooms) — 201, 304, 501…"), not just count them (2026-08-12, operator request).
    const byType = new Map<string, string[]>();
    for (const r of roomsCatalogQuery.data?.items ?? []) {
      if (!r.bedType || r.isBlocked) continue;
      byType.set(r.bedType, [...(byType.get(r.bedType) ?? []), r.roomNumber]);
    }
    return [...byType.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, roomNumbers]) => ({
        type,
        count: roomNumbers.length,
        roomNumbers: roomNumbers.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      }));
  }, [roomsCatalogQuery.data]);
  // The already-picked room stays visible even when the filter would exclude it — a select
  // whose value has no matching option renders blank while silently keeping the value.
  const visibleRoomOptions = useMemo(
    () => (bedFilter ? roomOptions.filter((r) => r.bedType === bedFilter || r.id === roomId) : roomOptions),
    [roomOptions, bedFilter, roomId],
  );
  // Per-room night coverage from the sealed per-night plan — feeds the multi-room review
  // list (2026-08-10 report: the branch only said "sealed plan ready" with nothing to
  // inspect, so the operator couldn't check which rooms/beds the plan holds).
  const sealedNightsByRoom = useMemo(() => {
    const m = new Map<string, number>();
    const opt = sealedPreferred?.optionSelected as
      | { perNight?: Array<{ date: string; roomIds: Array<{ roomId: string }> }> }
      | null
      | undefined;
    if (opt && Array.isArray(opt.perNight)) {
      for (const night of opt.perNight) for (const r of night.roomIds ?? []) m.set(r.roomId, (m.get(r.roomId) ?? 0) + 1);
    }
    return m;
  }, [sealedPreferred]);

  // Bed type is EDITABLE in place (2026-08-10, operator request): beds get physically
  // reconfigured at the desk's initiative, so each bed tag is a dropdown writing to the room
  // registry (L1 endpoint, traced with the prior value). Each room offers ONLY the bed
  // setups its own ROOM TYPE carries (2026-08-12, operator ruling — a Standard Double never
  // offers Queen; only 301's type has one): the per-room `allowedBedTypes` is SERVER-derived
  // live from the registry, so adding a room or changing a bed type moves every dropdown
  // automatically — nothing hardcoded on either side.
  const allowedBedsByRoomId = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of roomsCatalogQuery.data?.items ?? []) {
      if (r.allowedBedTypes?.length) m.set(r.id, r.allowedBedTypes);
    }
    return m;
  }, [roomsCatalogQuery.data]);
  // Last-resort fallback (payload predates allowedBedTypes): the types in use anywhere.
  const bedVocabulary = useMemo(() => [...new Set(bedTypeByRoomId.values())].sort(), [bedTypeByRoomId]);
  const bedTypeM = useMutation({
    mutationFn: (args: { roomId: string; bedType: string }) => setRoomBedType(session!, args.roomId, args.bedType),
    onSuccess: (r) => {
      toast.success(`Room ${r.roomNumber} set to ${r.bedType === "TWIN" ? "Twin beds" : `${bedLabel(r.bedType)} bed`}`);
      void queryClient.invalidateQueries({ queryKey: ["rooms-catalog"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Could not change the bed type"),
  });
  const bedSelect = (rId: string) => {
    const current = bedTypeByRoomId.get(rId) ?? "";
    const options = allowedBedsByRoomId.get(rId) ?? bedVocabulary;
    return (
      <select
        value={current}
        disabled={bedTypeM.isPending}
        onChange={(e) => {
          if (e.target.value) bedTypeM.mutate({ roomId: rId, bedType: e.target.value });
        }}
        title="Physical bed setup of this room — the options are the setups this room's type carries; changing it updates the room registry (recorded)"
        // Fixed width: "King bed" / "Twin beds" / "Set beds…" would otherwise render each
        // select a different length and the column of rooms looks ragged.
        style={{ width: 108, fontSize: 11.5, padding: "3px 6px" }}
      >
        {!current && <option value="">Set beds…</option>}
        {options.map((t) => (
          <option key={t} value={t}>
            {t === "TWIN" ? "Twin beds" : `${bedLabel(t)} bed`}
          </option>
        ))}
        {/* The room's own value stays visible even if its type's set were to exclude it. */}
        {current && !options.includes(current) && (
          <option value={current}>{current === "TWIN" ? "Twin beds" : `${bedLabel(current)} bed`}</option>
        )}
      </select>
    );
  };

  // Per-room detail expansion (2026-08-11, operator request): each room opens INDIVIDUALLY to
  // show its S2 composition — who sleeps there (named from the guest-detail table above), the
  // meal plan, occupants, extra beds, negotiated rates and FOC/tax flags — and "All details"
  // opens every room at once.
  const [openRooms, setOpenRooms] = useState<Set<string>>(new Set());
  const childPolicyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  // Same query key as the guest-detail block — shared cache, no extra fetch.
  const proofsQuery = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session,
  });
  const compByRoom = useMemo(
    () => new Map((operativeRoomCompositions(entry) ?? []).map((c) => [c.roomId, c])),
    [entry],
  );
  const guestsByRoom = useMemo(() => {
    const seat = seatPartyByComposition(
      entry,
      childPolicyQuery.data?.ageBands.youngChildMaxAge ?? 5,
      childPolicyQuery.data?.ageBands.childMaxAge ?? 10,
    );
    const labels = partySlotLabels(entry);
    // Names typed off the documents in the guest-detail table replace the generic labels.
    const named = new Map<string, string>();
    for (const p of proofsQuery.data?.items ?? []) {
      if (p.entryId === entry.id && !p.hasFile && p.subjectKey && p.subjectLabel?.trim()) {
        named.set(p.subjectKey, p.subjectLabel.trim());
      }
    }
    const m = new Map<string, string[]>();
    for (const [slot, rId] of seat) {
      m.set(rId, [...(m.get(rId) ?? []), named.get(slot) ?? labels.get(slot) ?? slot]);
    }
    return m;
  }, [entry, childPolicyQuery.data, proofsQuery.data]);
  const toggleRoom = (id: string) =>
    setOpenRooms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Head-count on every row — from the S2 composition (occupants per room), with the band
  // breakdown on hover. Null (hidden) when the booking has no composition to read from.
  const peopleOnRow = (rId: string) => {
    const c = compByRoom.get(rId);
    if (!c) return null;
    const adults = c.adultCount ?? 0;
    const cnb6 = c.cnb6To10Count ?? 0;
    const cnb0 = c.cnbUnder6Count ?? 0;
    const total = c.occupantCount ?? adults + cnb6 + cnb0;
    if (total <= 0) return null;
    const parts = [
      adults > 0 ? `${adults} adult${adults === 1 ? "" : "s"}` : null,
      cnb6 > 0 ? `${cnb6} child${cnb6 === 1 ? "" : "ren"} 6–10` : null,
      cnb0 > 0 ? `${cnb0} under-6` : null,
    ].filter(Boolean);
    return (
      <span style={{ color: "var(--ink-3)" }} title={parts.join(", ") || undefined}>
        {" "}· {total} guest{total === 1 ? "" : "s"}
      </span>
    );
  };

  // Live room status on every row — the same collapse (claim + housekeeping + flags) and
  // vocabulary the Rooms page uses, so "Needs cleaning" here means what it means there.
  const statusTag = (rId: string) => {
    const r = roomsCatalogQuery.data?.items.find((x) => x.id === rId);
    if (!r) return null;
    const meta = ROOM_STATUS[deriveRoomStatus(r)];
    return (
      <span className="tag" style={{ color: meta.color }} title="Live room status — claim, housekeeping and service flags">
        {meta.label}
      </span>
    );
  };
  const detailButton = (id: string) => (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleRoom(id)}>
      {openRooms.has(id) ? "Hide" : "Details"}
    </button>
  );
  const roomDetail = (id: string) => {
    if (!openRooms.has(id)) return null;
    const c = compByRoom.get(id);
    const guests = guestsByRoom.get(id) ?? [];
    if (!c && guests.length === 0) {
      return (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "4px 0 0" }}>
          No composition recorded for this room at Negotiation — occupants and meals are set on the
          Quote step&rsquo;s guest board.
        </p>
      );
    }
    const adults = c?.adultCount ?? 0;
    const cnb6 = c?.cnb6To10Count ?? 0;
    const cnb0 = c?.cnbUnder6Count ?? 0;
    const beds = c?.extraBedCount ?? 0;
    const flags = [
      c?.isFoc ? "FOC — fully waived" : null,
      c?.serviceChargeApplies === false ? "service charge waived" : null,
      c?.gstApplies === false ? "GST waived" : null,
    ].filter(Boolean);
    return (
      <div style={{ margin: "4px 0 0", padding: "8px 10px", borderRadius: "var(--r-sm)", background: "var(--cream)", display: "grid", gap: 4, fontSize: 11.5 }}>
        <div>
          <span style={{ color: "var(--ink-3)" }}>Guests: </span>
          {guests.length > 0 ? guests.join(" · ") : "—"}
        </div>
        {c && (
          <>
            <div>
              <span style={{ color: "var(--ink-3)" }}>Occupants: </span>
              {adults} adult{adults === 1 ? "" : "s"}
              {cnb6 > 0 && `, ${cnb6} child${cnb6 === 1 ? "" : "ren"} 6–10`}
              {cnb0 > 0 && `, ${cnb0} under-6`}
              {beds > 0 && ` · ${beds} extra bed${beds === 1 ? "" : "s"}`}
            </div>
            <div>
              <span style={{ color: "var(--ink-3)" }}>Meals: </span>
              {mealPlanSummary(c)}
            </div>
            {(c.negotiatedRoomRate != null || c.negotiatedExtraBedRate != null) && (
              <div style={{ color: "var(--ink-3)" }}>
                Negotiated:{" "}
                {c.negotiatedRoomRate != null && `room ${money(c.negotiatedRoomRate, "BTN")}/night`}
                {c.negotiatedRoomRate != null && c.negotiatedExtraBedRate != null && " · "}
                {c.negotiatedExtraBedRate != null && `extra bed ${money(c.negotiatedExtraBedRate, "BTN")}/night`}
              </div>
            )}
            {flags.length > 0 && <div style={{ color: "var(--warn)" }}>{flags.join(" · ")}</div>}
          </>
        )}
      </div>
    );
  };

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
  // Prompt whenever the server says a credit extension is active and no acknowledgement is on
  // record. This used to additionally require `totalReceived >= ceilingAmount * 0.9` — a 90%
  // advisory threshold invented here. The real thresholds live in the backend
  // (`registry.creditCeiling.advisoryThresholds`) and payment-status doesn't report whether one
  // has been crossed, so the desk asks on the backend booleans alone: it can prompt slightly
  // early, but it can never skip an acknowledgement the gate requires.
  const creditNeedsAck =
    hasCreditCeiling && paymentStatus?.creditExtensionActive && !entry.creditCeilingTier2AcknowledgedAt;

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
  const creditAckM = useMutation(
    wrap(() => acknowledgeCreditCeilingTier2(session!, entry.id), "Credit ceiling acknowledged"),
  );
  const cancelM = useMutation({
    mutationFn: () => cancelEntryAtS5(session!, entry.id, cancelWaiver ? { penaltyWaiverRequested: true } : undefined),
    onSuccess: () => {
      setCancelOpen(false);
      toast.success("Booking cancelled — held room released, no-show timer cancelled.");
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Cancellation failed"),
  });
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
      : creditAckM.isPending
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

      {/* Advance settlement (2026-08-07; moved above room assignment 2026-08-07, operator
          request — settle the money story before the room one): the full picture — plan,
          promise countdown, installment history, "log the remainder", FOM credit extension,
          reconcile. A guest who promised the rest "before check-in" pays it in this window. */}
      <AdvanceSettlementBlock
        entry={entry}
        title="Advance & credit"
        intro="Confirm the advance before arrival: log any remainder the guest sends, or have an FOM cover the gap so check-in isn't blocked."
      >
        {creditNeedsAck && elevated && (
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-ghost btn-sm" disabled={creditAckM.isPending} onClick={() => creditAckM.mutate()}>
              FOM: acknowledge credit ceiling
            </button>
          </div>
        )}
      </AdvanceSettlementBlock>

      {/* Guest details & ID proof (2026-08-10; moved ABOVE room assignment 2026-08-11, operator
          request) — who is arriving, their documents, and which room the S2 board placed them
          in; then the rooms get assigned below. Evidence only; the identity VERIFICATION is
          recorded at Check-in. Collapsed by default (2026-08-12, operator request) — the
          header tag stays live and the returning-guest pull still runs while collapsed. */}
      <IdentityProofBlock entry={entry} collapsible />

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
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                {(() => {
                  // "As a whole": one click opens/closes every room's composition detail.
                  const shownIds = assignments.length > 0 ? [...new Set(assignments.map((a) => a.roomId))] : sealedRoomIds;
                  const allOpen = shownIds.length > 0 && shownIds.every((id) => openRooms.has(id));
                  return shownIds.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setOpenRooms(allOpen ? new Set() : new Set(shownIds))}
                    >
                      {allOpen ? "Hide all details" : "View all details"}
                    </button>
                  ) : null;
                })()}
                <span className={`tag${sealedPreferred ? "" : " warn"}`}>{sealedPreferred ? "sealed plan ready" : "no sealed plan"}</span>
              </span>
            </div>
            {assignments.length > 0 ? (
              // Full-width rows (uniform boxes — .fact is inline-flex and would hug content);
              // the list itself scrolls past ~8 rows so a 10–25 room group stays one screen.
              <div style={{ display: "grid", gap: 6, marginBottom: 11, maxHeight: "46vh", overflowY: "auto", paddingRight: 2 }}>
                {assignments.map((a) => (
                  <div key={a.id}>
                    <div className="fact" style={{ width: "100%", justifyContent: "space-between", fontSize: 12, padding: "6px 10px" }}>
                      <span>
                        Room {a.room?.roomNumber ?? a.roomId.slice(0, 8)}
                        {a.startDate && (
                          <span style={{ color: "var(--ink-3)" }}>
                            {" "}· {a.startDate.slice(0, 10)} → {a.endDate?.slice(0, 10) ?? ""}
                          </span>
                        )}
                        {peopleOnRow(a.roomId)}
                      </span>
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        {statusTag(a.roomId)}
                        {bedSelect(a.roomId)}
                        {detailButton(a.roomId)}
                        <span className={`tag${roomReady(a) ? "" : " warn"}`}>{roomReady(a) ? "ready" : "not ready"}</span>
                      </span>
                    </div>
                    {roomDetail(a.roomId)}
                  </div>
                ))}
              </div>
            ) : (
              sealedRoomIds.length > 0 && (
                // The review list — one row per sealed room with its type, bed setup and night
                // coverage, so the plan can be CHECKED before the one-step assignment instead
                // of trusting a bare "sealed plan ready" tag. Rows are full-width (uniform
                // boxes) and the list scrolls past ~8 rows so a 10–25 room group stays one
                // screen; the hint stays pinned below the scroller.
                <div style={{ marginBottom: 11 }}>
                  <div style={{ display: "grid", gap: 6, maxHeight: "46vh", overflowY: "auto", paddingRight: 2 }}>
                  {sealedRoomIds.map((id) => {
                    const info = roomOptions.find((r) => r.id === id);
                    const nights = sealedNightsByRoom.get(id);
                    return (
                      <div key={id}>
                        <div className="fact" style={{ width: "100%", justifyContent: "space-between", fontSize: 12, padding: "6px 10px" }}>
                          <span>
                            Room {roomNumberById.get(id) ?? info?.roomNumber ?? id.slice(0, 6)}
                            {info?.roomTypeName && <span style={{ color: "var(--ink-3)" }}> · {info.roomTypeName}</span>}
                            {nights != null && nights > 0 && (
                              <span style={{ color: "var(--ink-3)" }}>
                                {" "}· {nights} night{nights === 1 ? "" : "s"}
                              </span>
                            )}
                            {peopleOnRow(id)}
                          </span>
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            {statusTag(id)}
                            {bedSelect(id)}
                            {detailButton(id)}
                          </span>
                        </div>
                        {roomDetail(id)}
                      </div>
                    );
                  })}
                  </div>
                  <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "8px 0 0" }}>
                    These are the rooms selected at Inquiry — assigned in one step below. Need a
                    different room or bed type? Change the selection on the Inquiry step first.
                  </p>
                </div>
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
                {/* Collapsed first (2026-08-10): lead with what Inquiry/Quote already picked —
                    the committed hold's / sealed selection's room — instead of a bare dropdown.
                    The picker (with its bed-type filter) appears only on "Change room". */}
                {(() => {
                  const sel = roomOptions.find((r) => r.id === roomId);
                  if (!sel || roomEditOpen) return null;
                  return (
                    <div style={{ marginBottom: 11 }}>
                      <div className="fact b-transit" style={{ padding: "6px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
                        <span>
                          Selected earlier: <b>Room {sel.roomNumber}</b>
                          {sel.roomTypeName && <span style={{ color: "var(--ink-3)" }}> · {sel.roomTypeName}</span>}
                          {peopleOnRow(sel.id)}
                        </span>
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          {statusTag(sel.id)}
                          {bedSelect(sel.id)}
                          {detailButton(sel.id)}
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRoomEditOpen(true)}>
                            Change room
                          </button>
                        </span>
                      </div>
                      {roomDetail(sel.id)}
                    </div>
                  );
                })()}
                {(roomEditOpen || !roomOptions.some((r) => r.id === roomId)) && (
                  <>
                    <div className="frow">
                      {bedTypes.length > 0 && (
                        <div className="field" style={{ flex: "0 0 auto" }}>
                          <label>Bed type</label>
                          {/* Options NAME the rooms, not just count them (2026-08-12, operator
                              request). maxWidth keeps the closed control from stretching to the
                              longest option once one is picked. */}
                          <select
                            value={bedFilter}
                            onChange={(e) => setBedFilter(e.target.value)}
                            style={{ maxWidth: 360 }}
                          >
                            <option value="">Any bed type</option>
                            {bedTypes.map((b) => (
                              <option key={b.type} value={b.type}>
                                {bedLabel(b.type)} ({b.count} room{b.count === 1 ? "" : "s"}) — {b.roomNumbers.join(", ")}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="field">
                        <label>Select room</label>
                        <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                          <option value="">Choose a room…</option>
                          {visibleRoomOptions.map((r) => (
                            <option key={r.id} value={r.id}>
                              {formatRoomPickerLabel({ roomNumber: r.roomNumber, currentClaimState: r.currentClaimState, physicalState: r.physicalState, isBlocked: r.isBlocked })}
                              {bedLabel(r.bedType) ? ` · ${bedLabel(r.bedType)}` : ""}
                            </option>
                          ))}
                        </select>
                        {defaultRoomId && <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "5px 0 0" }}>Suggested from the committed hold / preferred option.</p>}
                      </div>
                    </div>
                    <div className="field">
                      <label>Notes (optional)</label>
                      <input value={assignNotes} onChange={(e) => setAssignNotes(e.target.value)} />
                    </div>
                  </>
                )}
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

      {/* Guest's answer on the pre-arrival reminder. The reminder opens a W22 window when it goes
          out; this closes it. Evidence only — check-in is not held up by it. */}
      <CommunicationAcceptanceBlock entryId={entry.id} commType="PRE_ARRIVAL_REMINDER" />

      {/* Guest present attestation */}
      <div className="block">
        <BlockH>Guest at the desk</BlockH>
        <label className="checkline" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={guestPresent} onChange={(e) => setGuestPresent(e.target.checked)} />
          <span>The guest is physically present at the front desk (required to check in)</span>
        </label>
      </div>

      {/* Cancel (pre-arrival, terminal) — SIG-S5 §1.7 / Policy 35 */}
      <div className="block" style={{ borderColor: "#e2b3ac" }}>
        <BlockH>Cancel this booking</BlockH>
        <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 0, lineHeight: 1.5 }}>
          Pre-arrival cancellation. Releases the held room, cancels the no-show timer, applies the disclosed
          penalty and refunds the net advance. The booking becomes terminal — there&rsquo;s no undo.
        </p>
        {isGm && (
          <label className="checkline" style={{ cursor: "pointer", marginBottom: 8 }}>
            <input type="checkbox" checked={cancelWaiver} onChange={(e) => setCancelWaiver(e.target.checked)} />
            <span>Waive the cancellation penalty (GM authority)</span>
          </label>
        )}
        <button className="btn btn-ghost" style={{ borderColor: "#e2b3ac", color: "var(--stop)" }} onClick={() => setCancelOpen(true)}>
          Cancel booking
        </button>
      </div>
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />

      <DeskConfirmModal
        open={cancelOpen}
        tone="danger"
        title="Cancel this booking?"
        subtitle={entry.id}
        why="Cancelling before arrival is terminal. Here is exactly what happens:"
        consequences={[
          "The held room is released — it returns to the available pool.",
          "The no-show timer and any pre-arrival tasks are cancelled.",
          <>
            The disclosed cancellation <b>penalty</b>
            {cancelWaiver ? " is waived (GM)" : " (if any) is posted"}; the net advance refunds.
          </>,
          "The booking becomes terminal — this cannot be undone.",
        ]}
        confirmLabel="Cancel booking"
        cancelLabel="Keep booking"
        pending={cancelM.isPending}
        onConfirm={() => cancelM.mutate()}
        onClose={() => setCancelOpen(false)}
      />
    </div>
  );
}
