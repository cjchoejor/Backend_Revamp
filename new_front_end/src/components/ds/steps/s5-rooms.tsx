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

export function AssignRoomsCard({
  entry,
  boardOpen,
  setBoardOpen,
}: {
  entry: EntryDetail;
  boardOpen: boolean;
  setBoardOpen: (v: boolean) => void;
}) {
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

  const anchor = planIds[0] ?? null;
  const anchorType = anchor ? byId.get(anchor)?.roomType?.id ?? null : null;
  const anchorTypeName = anchor ? typeOf(anchor) : null;
  const cands = useQuery({
    queryKey: ["room-change-candidates", entry.id, anchor],
    queryFn: () => listRoomChangeCandidates(session!, entry.id, anchor!),
    // Not for a parked booking (2026-09-19): it cannot change rooms until it is resumed, and the
    // backend refuses the question — the board fired four refused requests on every visit.
    enabled: !!session && !!anchor && boardOpen && !past && entry.status === "ACTIVE",
    staleTime: 30_000,
  });
  const freeRooms = useMemo(() => {
    const all = (cands.data?.candidates ?? []).filter((c) =>
      night === "all" ? c.availability === "FREE" : c.perNight.find((p) => p.date === night)?.status === "FREE",
    );
    const same = all.filter((c) => c.sameType || (anchorType && c.roomTypeId === anchorType));
    return { all, same, shown: allTypes ? all : same };
  }, [cands.data, night, allTypes, anchorType]);

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
          {planIds.length ? (
            <Button kind="quiet" compact onClick={() => setBoardOpen(!boardOpen)}>
              {boardOpen ? "Hide the board" : "Who sleeps where"}
            </Button>
          ) : null}
        </>
      }
      meta={
        boardOpen
          ? "Rooms free for these nights, by type. Who sleeps where comes from the room plan set at Negotiation; a room with someone in it is assigned — a claim on the room, no step moved. A different room is taken with Change room on its line: every night is checked again and the price follows."
          : undefined
      }
    >
      {boardOpen && planIds.length ? (
        <div style={{ marginBottom: 12 }}>
          {nights.length > 1 ? (
            <div className="row-acts" style={{ marginBottom: 8, alignItems: "center" }}>
              <span className="meta">Night</span>
              <Choice options={[["all", "All nights"] as const, ...nights.map((d) => [d, fmtDay(d)] as const)]} value={night} onChange={setNight} />
              <span className="meta">{night === "all" ? "the whole stay" : `${fmtDate(night)} only`}</span>
            </div>
          ) : null}
          <div className="grid2" style={{ alignItems: "start", gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)" }}>
            <div className="stack">
              <div className="card" style={{ background: "var(--surface-2)" }}>
                <div className="row-acts" style={{ justifyContent: "space-between" }}>
                  <b>The party · {slots.length}</b>
                  <span className="meta">
                    {plural(slots.filter((s) => s.adult).length, "adult")} · {plural(slots.filter((s) => !s.adult).length, "child", "children")}
                  </span>
                </div>
                <div style={{ marginTop: 6, minHeight: 34 }}>
                  {!comps ? (
                    <span className="meta">No room plan with people in it — the rooms carry the whole party.</span>
                  ) : unplaced.length ? (
                    unplaced.map((s) => <GuestChip key={s.key} slot={s} />)
                  ) : (
                    <span className="meta">everyone has a room{night === "all" ? "" : " this night"}</span>
                  )}
                </div>
              </div>
              {seatingProblem ? (
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
              ) : null}
            </div>
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
                {binIds.map((id) => (
                  <PlanBin
                    key={id}
                    number={numberOf(id)}
                    type={typeOf(id)}
                    cap={capOf(id)}
                    guests={comps ? guestsIn(id) : null}
                    assigned={assignedIds.includes(id)}
                    bed={bedWord(byId.get(id)?.bedType)}
                  />
                ))}
              </div>
              {past ? null : (
                <>
                  <div className="row-acts" style={{ margin: "10px 0 6px", alignItems: "center" }}>
                    <span className="meta">
                      {cands.isLoading
                        ? "asking the house which rooms are free…"
                        : cands.isError
                          ? "the house could not be asked for free rooms"
                          : allTypes
                            ? `${plural(freeRooms.all.length, "room")} free for ${night === "all" ? "these nights" : fmtDay(night)}`
                            : `${freeRooms.same.length} ${anchorTypeName ?? "of this type"} free for ${night === "all" ? "these nights" : fmtDay(night)}`}
                    </span>
                    <Button kind="quiet" compact onClick={() => setAllTypes((v) => !v)}>
                      {allTypes ? `Only ${anchorTypeName ?? "this type"}` : "Show every category"}
                    </Button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
                    {freeRooms.shown.slice(0, 24).map((c) => (
                      <FreeBin key={c.roomId} c={c} cap={capOf(c.roomId)} />
                    ))}
                  </div>
                  {freeRooms.shown.length > 24 ? <div className="meta" style={{ marginTop: 6 }}>and {freeRooms.shown.length - 24} more</div> : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {planIds.length ? (
        <>
          <div className="row-acts" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <span className="meta">
              {multi ? `${plural(planRoomCount, "room")} in the plan · ${assignedIds.length} assigned` : assigned ? "assigned" : "chosen earlier — not yet assigned"}
            </span>
            {planIds.length > 1 ? (
              <Button kind="quiet" compact onClick={() => setOpenRooms(allOpen ? new Set() : new Set(planIds))}>
                {allOpen ? "Hide all details" : "All details"}
              </Button>
            ) : null}
          </div>
          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {planIds.map((id) => (
              <RoomLine
                key={id}
                entry={entry}
                roomId={id}
                number={numberOf(id)}
                type={typeOf(id)}
                room={byId.get(id) ?? null}
                assignment={assignments.find((a) => a.roomId === id)}
                stay={stayRanges.get(id)?.label ?? null}
                stayNights={stayRanges.get(id)?.nightCount ?? null}
                guests={comps ? guestsIn(id).map((s) => s.label) : []}
                comp={compByRoom.get(id) ?? null}
                open={openRooms.has(id)}
                onToggle={() => toggleRoom(id)}
                onChanged={changed}
                canChange={canWork}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="meta">No rooms chosen for this booking yet.</p>
      )}

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

function GuestChip({ slot }: { slot: Slot }) {
  return (
    <span style={{ display: "inline-block", margin: 2 }}>
      <Chip tone={slot.adult ? "default" : "quiet"}>
        {slot.label}
        {slot.band}
      </Chip>
    </span>
  );
}

function PlanBin({
  number,
  type,
  cap,
  guests,
  assigned,
  bed,
}: {
  number: string;
  type: string | null;
  cap: number | null;
  guests: Slot[] | null;
  assigned: boolean;
  bed: string | null;
}) {
  const adults = guests?.filter((g) => g.adult).length ?? 0;
  const kids = (guests?.length ?? 0) - adults;
  return (
    <div className="card" style={{ padding: "8px 10px", borderColor: guests?.length ? "var(--accent-line)" : undefined }}>
      <div>
        <b>Room {number}</b>
        {type ? <span className="meta"> · {type}</span> : null}
      </div>
      <div className="row-acts" style={{ marginTop: 4, alignItems: "center" }}>
        <span className="meta">
          {guests ? `${adults}/${cap ?? "—"}${kids ? ` + ${plural(kids, "child", "children")}` : ""}` : `${cap ?? "—"} max`}
        </span>
        {assigned ? (
          <Chip tone="success" icon="check">
            assigned
          </Chip>
        ) : (
          <Chip tone="quiet">chosen</Chip>
        )}
      </div>
      <div style={{ marginTop: 6, minHeight: 30 }}>
        {guests === null ? <span className="meta">the whole party</span> : guests.length ? guests.map((g) => <GuestChip key={g.key} slot={g} />) : <span className="meta">empty</span>}
      </div>
      {bed ? <div className="meta">{bed}</div> : null}
    </div>
  );
}

function FreeBin({ c, cap }: { c: RoomChangeCandidate; cap: number | null }) {
  return (
    <div className="card" style={{ padding: "8px 10px" }}>
      <div>
        <b>Room {c.roomNumber}</b>
        {c.roomTypeName ? <span className="meta"> · {c.roomTypeName}</span> : null}
      </div>
      <div className="row-acts" style={{ marginTop: 4, alignItems: "center" }}>
        <span className="meta">0/{cap ?? "—"}</span>
        <Chip tone="quiet">free</Chip>
        {c.isDeficient ? <Chip tone="warning">a fault</Chip> : null}
        {!c.sameType ? <Chip tone="quiet">another category · FOM</Chip> : null}
      </div>
      <div className="meta" style={{ marginTop: 6 }}>
        empty{bedWord(c.bedType) ? ` · ${bedWord(c.bedType)}` : ""}
      </div>
    </div>
  );
}

function RoomLine({
  entry,
  roomId,
  number,
  type,
  room,
  assignment,
  stay,
  stayNights,
  guests,
  comp,
  open,
  onToggle,
  onChanged,
  canChange,
}: {
  entry: EntryDetail;
  roomId: string;
  number: string;
  type: string | null;
  room: RoomListItem | null;
  assignment: RoomAssignmentSummary | undefined;
  stay: string | null;
  stayNights: number | null;
  guests: string[];
  comp: RoomCompositionInput | null;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  canChange: boolean;
}) {
  const { past } = useStepMode();
  const status = room ? deriveRoomStatus(room) : null;
  const heads = comp ? comp.occupantCount ?? (comp.adultCount ?? 0) + (comp.cnb6To10Count ?? 0) + (comp.cnbUnder6Count ?? 0) : null;
  const showStatus = status && status !== "reserved" && status !== "ready";
  const ready = roomReady(assignment);
  return (
    <div style={{ borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="sm">
          <b>Room {number}</b>
          <span className="meta">
            {type ? ` · ${type}` : ""}
            {stay ? ` · ${stay}` : ""}
            {heads ? ` · ${plural(heads, "guest")}` : ""}
          </span>
        </span>
        <span className="row-acts" style={{ alignItems: "center" }}>
          {showStatus ? <Chip tone={STATUS_TONE[status!]}>{ROOM_STATUS[status!].label}</Chip> : null}
          {assignment ? (
            ready ? (
              <Chip tone="success" icon="check">
                ready
              </Chip>
            ) : (
              <Chip tone="warning">not ready · housekeeping</Chip>
            )
          ) : null}
          {assignment?.deficientAtAssignment ? <Chip tone="warning">a fault, acknowledged at assignment</Chip> : null}
          <Button kind="quiet" compact onClick={onToggle}>
            {open ? "Hide" : "Details"}
          </Button>
        </span>
      </div>
      <div className="desk-root" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
        {past ? (
          <div inert style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <InitialSelectionCell entryId={entry.id} roomId={roomId} />
            <BedTypeEditor roomId={roomId} />
            <ExtraBedEditor entry={entry} roomId={roomId} onChanged={onChanged} />
          </div>
        ) : (
          <>
            <InitialSelectionCell entryId={entry.id} roomId={roomId} />
            <BedTypeEditor roomId={roomId} />
            <ExtraBedEditor entry={entry} roomId={roomId} onChanged={onChanged} />
          </>
        )}
      </div>
      {canChange ? (
        <div className="desk-root" style={{ marginTop: 4 }}>
          <RoomChangeControl entry={entry} fromRoomId={roomId} fromRoomNumber={number} onChanged={onChanged} compact />
        </div>
      ) : null}
      {open ? (
        <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: "var(--r-control)", background: "var(--surface-2)" }}>
          <Facts wide>
            <Fact k="Staying" meta={stayNights ? plural(stayNights, "night") : undefined}>
              {stay}
            </Fact>
            <Fact k="Guests">{guests.length ? guests.join(" · ") : null}</Fact>
            {comp ? (
              <>
                <Fact k="Occupants">
                  {plural(comp.adultCount ?? 0, "adult")}
                  {comp.cnb6To10Count ? `, ${plural(comp.cnb6To10Count, "child", "children")} 6–10` : ""}
                  {comp.cnbUnder6Count ? `, ${comp.cnbUnder6Count} under 6` : ""}
                  {comp.extraBedCount ? ` · ${plural(comp.extraBedCount, "extra bed")}` : " · no extra bed"}
                </Fact>
                <Fact k="Meals">{mealPlanSummary(comp)}</Fact>
                {comp.negotiatedRoomRate != null || comp.negotiatedExtraBedRate != null ? (
                  <Fact k="Agreed rates">
                    {[
                      comp.negotiatedRoomRate != null ? `room ${money(comp.negotiatedRoomRate)} a night` : null,
                      comp.negotiatedExtraBedRate != null ? `extra bed ${money(comp.negotiatedExtraBedRate)} a night` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Fact>
                ) : null}
                {comp.isFoc || comp.serviceChargeApplies === false || comp.gstApplies === false ? (
                  <Fact k="Waived">
                    <span className="warn-ink">
                      {[comp.isFoc ? "free of charge" : null, comp.serviceChargeApplies === false ? "service charge" : null, comp.gstApplies === false ? "GST" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </Fact>
                ) : null}
              </>
            ) : (
              <Fact k="Room plan">
                <span className="meta">no people or meals recorded for this room at Negotiation</span>
              </Fact>
            )}
          </Facts>
        </div>
      ) : null}
    </div>
  );
}
