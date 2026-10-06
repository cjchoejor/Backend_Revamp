"use client";

/**
 * Arrival · "Assign the rooms" (prototype `V16.boardCard(b, "assign")`, rulings A2, A6).
 *
 * The board: the party on the left, the rooms on the right as bins, a night strip, and the free
 * rooms of the category for these nights ("Show every category" widens it). Who sleeps where is
 * not stored — it is read from the room plan set at Negotiation, the same derivation the guest
 * table uses — so the chips here are a picture, not a control. A different room is taken with
 * "Change room" on the room's line: the backend re-checks every night and re-prices, and the
 * booking comes back to this step.
 *
 * Under the board, one line per room with what the old Arrival step carried: its nights, heads,
 * live standing and readiness, where it started, the bed setup, the extra beds, the details, and
 * the governed room change. Then the assignment itself — the rooms chosen at Inquiry in one step,
 * or for a single room, that room or another of its type.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Refusal, type ChipTone } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { roomsFromResultSet } from "@/lib/api/availability";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listRoomChangeCandidates, repairPartySeating, type RoomChangeCandidate } from "@/lib/api/entries";
import { listIdentityProofs } from "@/lib/api/identity-proofs";
import { assignRoom, assignRoomsFromSealedPerNight } from "@/lib/api/pre-arrival";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import { listRooms, type RoomListItem } from "@/lib/api/rooms";
import {
  mealPlanSummary,
  operativeRoomCompositions,
  partySeatingIssues,
  partySlotLabels,
  roomNightsByRoom,
  roomStayRangesByRoom,
  seatPartyRoomsByComposition,
} from "@/lib/desk/party-rooms";
import { deriveRoomStatus, ROOM_STATUS, type RoomStatusKey } from "@/lib/desk/rooms";
import { formatRoomPickerLabel } from "@/lib/room-inventory-status";
import { fmtDate, fmtDay, money, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, type EntryDetail, type RoomAssignmentSummary } from "@/types/api";
import {
  BedTypeEditor,
  ExtraBedEditor,
  InitialSelectionCell,
  RoomChangeControl,
} from "@/components/desk/workspace/room-change-control";
import { Choice, DsDialog, Fact, Facts, Live, StepCard, toastRefusal, useRefreshEntry, useStepMode } from "./kit";
import { enumerateNights } from "./use-room-selection";
import { RoomsTable } from "./rooms-table";

export const ROOMS_CARD_ID = "arrival-rooms";

const READY_STATES = new Set(["AVAILABLE_CLEAN", "AVAILABLE_INSPECTED"]);

/** A room is ready for the guest — the same reading the old Arrival step and the handoff use. */
export function roomReady(a: RoomAssignmentSummary | undefined): boolean {
  if (!a) return false;
  const ps = a.room?.physicalState;
  if (ps && READY_STATES.has(ps)) return true;
  if (a.deficientAtAssignment) return Boolean(a.acknowledgementActorId && a.acknowledgementAt);
  return !ps;
}

const BED_WORD: Record<string, string> = { KING: "King bed", TWIN: "Twin beds", QUEEN: "Queen bed", SINGLE: "Single bed" };
const bedWord = (t?: string | null) => (t ? BED_WORD[t] ?? `${t.charAt(0)}${t.slice(1).toLowerCase()} bed` : null);

const STATUS_TONE: Record<RoomStatusKey, ChipTone> = {
  occupied: "default",
  reserved: "quiet",
  ready: "success",
  dirty: "warning",
  inspect: "warning",
  deficient: "danger",
  ooo: "danger",
};

export function useRoomsCatalog() {
  const { session } = useSession();
  // The old room tools share this key — a bed change there refreshes the bins here.
  return useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });
}

type Slot = { key: string; label: string; adult: boolean; band: string };

export function AssignRoomsCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const refresh = useRefreshEntry(entry.id);
  const catalogQ = useRoomsCatalog();
  const catalog = catalogQ.data?.items ?? [];
  const byId = useMemo(() => new Map(catalog.map((r) => [r.id, r])), [catalog]);
  const policy = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 600_000,
  });
  const youngMax = policy.data?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policy.data?.ageBands.childMaxAge ?? 10;
  const proofs = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session,
  });

  const changed = () =>
    refresh([
      ["rooms"],
      ["rooms-catalog"],
      ["room-plan-history", entry.id],
      ["room-change-candidates", entry.id],
      ["identity-proofs", entry.id],
      ["journey-summary", entry.id],
    ]);

  /* ---- the plan ---- */
  const assignments = entry.roomAssignments ?? [];
  const assignedIds = useMemo(() => Array.from(new Set(assignments.map((a) => a.roomId))), [assignments]);
  const sealed = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected) ?? null;
  const sealedIds = optionSelectedRoomIds(sealed?.optionSelected);
  const numberOfRooms = entry.numberOfRooms ?? 1;
  const multi = numberOfRooms > 1;
  // The rooms the PLAN names (2026-09-18): a night-by-night change keeps 2 rooms a night but puts
  // 3 rooms in the plan, and the card read "3 of 2 assigned" / "Assign all 2 rooms".
  const planRoomCount = Math.max(numberOfRooms, sealedIds.length);
  const holdRoom = entry.committedHold?.roomId ?? null;
  const stayRanges = useMemo(() => roomStayRangesByRoom(entry), [entry]);
  const roomNights = useMemo(() => roomNightsByRoom(entry), [entry]);
  const chrono = (a: string, b: string) => {
    const A = stayRanges.get(a);
    const B = stayRanges.get(b);
    return (A?.firstNight ?? "9999").localeCompare(B?.firstNight ?? "9999") || (B?.nightCount ?? 0) - (A?.nightCount ?? 0);
  };
  const planIds = useMemo(() => {
    const base = assignedIds.length ? assignedIds : sealedIds.length ? sealedIds : holdRoom ? [holdRoom] : [];
    return [...base].sort(chrono);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedIds.join(","), sealedIds.join(","), holdRoom, stayRanges]);

  /* room numbers known before the rooms are assigned */
  const preferred = useMemo(() => {
    if (!sealed?.resultSet) return [];
    const { availableRooms, deficientRooms } = roomsFromResultSet(sealed.resultSet);
    return [...availableRooms, ...deficientRooms];
  }, [sealed]);
  const numberOf = (id: string) =>
    assignments.find((a) => a.roomId === id)?.room?.roomNumber ??
    byId.get(id)?.roomNumber ??
    preferred.find((r) => r.roomId === id)?.roomNumber ??
    id.slice(0, 6);
  const typeOf = (id: string) => byId.get(id)?.roomType?.name ?? preferred.find((r) => r.roomId === id)?.roomTypeName ?? null;
  const capOf = (id: string) => byId.get(id)?.roomType?.maxCapacity ?? byId.get(id)?.roomType?.standardCapacity ?? null;

  /* ---- the party and who sleeps where ---- */
  const comps = useMemo(() => operativeRoomCompositions(entry), [entry]);
  const compByRoom = useMemo(() => new Map((comps ?? []).map((c) => [c.roomId, c])), [comps]);
  const seat = useMemo(() => seatPartyRoomsByComposition(entry, youngMax, childMax), [entry, youngMax, childMax]);
  const slots = useMemo<Slot[]>(() => {
    const labels = partySlotLabels(entry);
    const named = new Map<string, string>();
    for (const p of proofs.data?.items ?? []) {
      if (p.entryId === entry.id && !p.hasFile && p.subjectKey && p.subjectLabel?.trim()) named.set(p.subjectKey, p.subjectLabel.trim());
    }
    const ages = entry.childAges ?? [];
    return [...labels.entries()].map(([key, label]) => {
      const i = key.startsWith("K") ? Number(key.slice(1)) : -1;
      const age = i >= 0 ? ages[i] : undefined;
      const adult = age === undefined || age > childMax;
      const band = age === undefined ? "" : age <= youngMax ? " · under 6" : age <= childMax ? " · 6–10" : ` · ${age}y`;
      return { key, label: named.get(key) ?? label.replace(/ · \d+y$/, ""), adult, band };
    });
  }, [entry, proofs.data, youngMax, childMax]);
  const issues = useMemo(() => partySeatingIssues(entry, youngMax, childMax), [entry, youngMax, childMax]);

  /* ---- the board ---- */
  const nights = useMemo(
    () => enumerateNights(entry.reservation?.frozenCheckInDate ?? entry.checkInDate, entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate),
    [entry.reservation?.frozenCheckInDate, entry.reservation?.frozenCheckOutDate, entry.checkInDate, entry.checkOutDate],
  );
  const [night, setNight] = useState<string>("all");
  const [allTypes, setAllTypes] = useState(false);
  const sleepsOn = (id: string, n: string) => {
    const ns = roomNights.get(id);
    return !ns || ns.length === 0 || ns.includes(n);
  };
  const binIds = night === "all" ? planIds : planIds.filter((id) => sleepsOn(id, night));
  const guestsIn = (id: string) => slots.filter((s) => (seat.get(s.key) ?? []).includes(id));
  const placedKeys = new Set(binIds.flatMap((id) => guestsIn(id).map((s) => s.key)));
  const unplaced = comps ? slots.filter((s) => !placedKeys.has(s.key)) : [];


  /* ---- the lines ---- */
  const [openRooms, setOpenRooms] = useState<Set<string>>(new Set());
  const toggleRoom = (id: string) =>
    setOpenRooms((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOpen = planIds.length > 0 && planIds.every((id) => openRooms.has(id));

  /* ---- assigning ---- */
  const defaultRoom = holdRoom ?? sealedIds[0] ?? "";
  const [roomId, setRoomId] = useState(defaultRoom);
  const [pickOpen, setPickOpen] = useState(false);
  const [bedFilter, setBedFilter] = useState("");
  const [notes, setNotes] = useState("");
  const [seatOpen, setSeatOpen] = useState(false);

  const assignOne = useMutation({
    mutationFn: () => assignRoom(session!, entry.id, { roomId: roomId.trim(), notes: notes.trim() || undefined }),
    onSuccess: () => {
      toast.success(`Room ${numberOf(roomId)} assigned — a claim on the room, no step moved`);
      setPickOpen(false);
      setNotes("");
      changed();
    },
    onError: (e) => toastRefusal(e, "The room could not be assigned"),
  });
  const assignAll = useMutation({
    mutationFn: async () => {
      const out = await assignRoomsFromSealedPerNight(session!, entry.id);
      if (out.count === 0) throw new Error("There is no room plan from Inquiry to assign — choose the rooms at Inquiry first.");
      return out;
    },
    onSuccess: (out) => {
      toast.success(`${plural(out.count, "room assignment")} made from the plan — each room for its own nights`);
      changed();
    },
    onError: (e) => toastRefusal(e, "The rooms could not be assigned"),
  });
  const seatAll = useMutation({
    mutationFn: () => repairPartySeating(session!, entry.id),
    onSuccess: (out) => {
      setSeatOpen(false);
      const lines = out.seating?.lines ?? [];
      if (out.walk.blocked) toast.warning(`The seating is recorded, but the booking is at a different step for now: ${out.walk.blocked.message}`, { duration: 12000 });
      else toast.success(lines.length ? `Everyone has a room. ${lines.join(". ")}.` : "Everyone has a room.", { duration: 12000 });
      if (out.seating?.unresolved.length) toast.warning(out.seating.unresolved.join(" · "), { duration: 12000 });
      changed();
    },
    onError: (e) => toastRefusal(e, "The guests could not be seated"),
  });

  const bedTypes = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of catalog) {
      if (!r.bedType || r.isBlocked) continue;
      m.set(r.bedType, [...(m.get(r.bedType) ?? []), r.roomNumber]);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, nums]) => ({ type, nums: nums.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }));
  }, [catalog]);
  const roomOptions = useMemo(() => {
    const m = new Map<string, { id: string; roomNumber: string; claim?: string; physical?: string; blocked?: boolean; bed?: string | null; type?: string | null }>();
    for (const r of preferred) if (r.roomId) m.set(r.roomId, { id: r.roomId, roomNumber: r.roomNumber ?? r.roomId, claim: r.claimState });
    for (const r of catalog)
      m.set(r.id, { id: r.id, roomNumber: r.roomNumber, claim: r.currentClaimState, physical: r.physicalState, blocked: r.isBlocked, bed: r.bedType ?? null, type: r.roomType?.name ?? null });
    return [...m.values()].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [preferred, catalog]);
  const visibleOptions = bedFilter ? roomOptions.filter((r) => r.bed === bedFilter || r.id === roomId) : roomOptions;

  const assigned = assignedIds.length > 0;
  const canWork = !past && entry.currentStage === "S5" && entry.status === "ACTIVE";
  const seatingProblem = !!comps && !issues.ok;

  return (
    <StepCard
      flow="rooms"
      id={ROOMS_CARD_ID}
      title={assigned ? "Rooms" : "Assign the rooms"}
      right={
        <>
          {assigned ? (
            <Chip tone="success" icon="check">
              {assignedIds.length >= planRoomCount ? "assigned" : `${assignedIds.length} of ${planRoomCount} assigned`}
            </Chip>
          ) : (
            <Chip tone="warning">
              {planRoomCount > numberOfRooms ? `${plural(planRoomCount, "room")} in the plan · ${numberOfRooms} a night` : `${plural(numberOfRooms, "room")} needed`}
            </Chip>
          )}

        </>
      }
      meta="Who sleeps where, on what plan, with what beds — the table the price was negotiated on. Click a room to change it; every night is checked again and the price follows."
    >
      {/* The rooms ARE the S2 table now (2026-10-06, operator: "instead of these cards ... I
          would love the table to be shown here"). The party card, the room bins and the
          free-room cards are gone: the table says who sleeps where, on what plan, with what
          beds — and a room is changed by clicking it there. */}
      {seatingProblem ? (
        <div style={{ marginBottom: 10 }}>
          <Refusal
            kind="state"
            message={
              issues.unseated.length
                ? `${issues.unseated.length} of the party ${issues.unseated.length === 1 ? "has" : "have"} no room yet.`
                : issues.emptyRooms.length
                  ? `${issues.emptyRooms.map((id) => `Room ${numberOf(id)}`).join(", ")} ${issues.emptyRooms.length === 1 ? "has" : "have"} nobody in ${issues.emptyRooms.length === 1 ? "it" : "them"}.`
                  : "The room plan still names a room this booking no longer holds."
            }
            carries="Seating everyone re-prices the plan in a new pass and comes back here; nobody moves rooms."
            actions={
              canWork ? (
                <Button kind="secondary" compact onClick={() => setSeatOpen(true)}>
                  Seat everyone in a room…
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : null}

      <RoomsTable entry={entry} />

      <Live>
        {!assigned && entry.currentStage === "S5" ? (
          multi ? (
            sealed ? (
              <div className="row-acts" style={{ marginTop: 12, alignItems: "center" }}>
                <Button state={assignAll.isPending ? "working" : canWork ? "default" : "inert"} workingLabel="Assigning…" onClick={() => assignAll.mutate()}>
                  Assign all {planRoomCount} rooms
                </Button>
                <span className="meta">the rooms chosen at Inquiry, each for its own nights · a room above can be changed first</span>
              </div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <Refusal kind="state" message={`There is no room plan from Inquiry — ${numberOfRooms} rooms have to be chosen there first.`} carries="A change of rooms before arrival is a new pass from Inquiry — Amend… below." />
              </div>
            )
          ) : (
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <div className="row-acts" style={{ alignItems: "center" }}>
                <Button
                  state={assignOne.isPending ? "working" : roomId && canWork ? "default" : "inert"}
                  title={roomId ? undefined : "choose the room first"}
                  workingLabel="Assigning…"
                  onClick={() => assignOne.mutate()}
                >
                  {roomId ? `Assign room ${numberOf(roomId)}` : "Assign the room"}
                </Button>
                <Button kind="quiet" compact onClick={() => setPickOpen((v) => !v)}>
                  {pickOpen ? "Keep the room chosen earlier" : "Pick another of this type"}
                </Button>
                {roomId && roomId === defaultRoom ? <span className="meta">chosen earlier{typeOf(roomId) ? ` · ${typeOf(roomId)}` : ""}</span> : null}
              </div>
              {pickOpen || !roomId ? (
                <div className="form2">
                  {bedTypes.length ? (
                    <div className="field">
                      <label>Bed setup</label>
                      <select className="input" value={bedFilter} onChange={(e) => setBedFilter(e.target.value)}>
                        <option value="">Any bed setup</option>
                        {bedTypes.map((b) => (
                          <option key={b.type} value={b.type}>
                            {bedWord(b.type)} ({plural(b.nums.length, "room")}) — {b.nums.join(", ")}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  <div className="field">
                    <label>Room</label>
                    <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                      <option value="">Choose a room…</option>
                      {visibleOptions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {formatRoomPickerLabel({ roomNumber: r.roomNumber, currentClaimState: r.claim, physicalState: r.physical, isBlocked: r.blocked })}
                          {r.bed ? ` · ${bedWord(r.bed)}` : ""}
                        </option>
                      ))}
                    </select>
                    <span className="hint">the room is checked for these dates when you assign it</span>
                  </div>
                  <div className="wide field">
                    <label>Note · optional</label>
                    <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="why this room" />
                  </div>
                </div>
              ) : null}
            </div>
          )
        ) : null}
      </Live>

      <DsDialog
        open={seatOpen}
        onClose={() => setSeatOpen(false)}
        busy={seatAll.isPending}
        title="Seat everyone in a room"
        caseLines={[entry.id]}
        footer={
          <>
            <Button kind="quiet" state={seatAll.isPending ? "inert" : "default"} onClick={() => setSeatOpen(false)}>
              Not now
            </Button>
            <Button state={seatAll.isPending ? "working" : "default"} workingLabel="Seating…" onClick={() => seatAll.mutate()}>
              Seat everyone
            </Button>
          </>
        }
      >
        <p className="sm">
          The room plan is set again so that every guest has a room on every night and no room stands empty. It runs as a new pass —
          the price is worked out again, nothing is sent to the guest, and the booking comes back to Arrival. Nobody changes rooms.
        </p>
      </DsDialog>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ pieces */

