"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, Maximize2, Minimize2, Pencil, Search, Sparkles, UserCheck, Users, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  queryAvailabilityByEntry,
  roomsFromResultSet,
  selectAvailabilityOption,
  type AvailabilityQueryResponse,
  type AvailabilityRoomResult,
  type PerDateAvailabilityResult,
} from "@/lib/api/availability";
import { type SealPayload } from "./multi-room-select";
import { RoomStatusTable, roomStatusRows, type RoomStatusRow } from "./room-status-table";
import { listRooms } from "@/lib/api/rooms";
import { getInquiry } from "@/lib/api/inquiries";
import { getAllowedRoomCounts } from "@/lib/api/child-policy";
import { updateEntryIntake } from "@/lib/api/entries";
import { formatDMY, guestName, nightsBetween } from "@/lib/desk/model";
import { money } from "@/lib/desk/workspace";
import { BackendRail, type RailGroup } from "./backend-inline";
import { DateField, nextDayIso } from "@/components/desk/date-field";
import type { BackendItem } from "@/lib/desk/backend-map";
import type { EntryDetail } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";

/**
 * Per-action "what runs in the backend" attribution for S1, surfaced inline next to
 * each operate action so you can watch the machinery as you work (curated from the
 * SIG / DEV-SPEC; references point at the real module / policy id).
 */
const S1_BACKEND: Record<string, BackendItem[]> = {
  intake: [
    { name: "Policy 3 — custodian assignment", ref: "p03-initial-custodian-assignment.ts", detail: "Assigns the owning actor from the inquiry's sourceChannel (throws on an unknown channel).", trace: "^OWNERSHIP_ASSIGNED$" },
    { name: "Policy 64 — group detection", ref: "p64 · registry.groupDetection.guestCountThreshold", detail: "Flags the entry GROUP when guest count crosses the threshold.", trace: "GROUP_BILLING_MODE" },
    { name: "Child / capacity validation", ref: "capacity-validation-service.ts", detail: "BLOCK checks: unaccompanied-minor, adult:child ratio, over-capacity vs room type." },
    { name: "s1-entry-service.createEntry", ref: "services/domain/s1-entry-service.ts", detail: "Creates the Entry and records the head-count breakdown.", trace: "^ENTRY\\.CREATED$" },
    { name: "W20 — ENTRY_EXPIRY armed", ref: "ENTRY_EXPIRY · w20-entry-expiry-worker.ts", detail: "Arms the S1 expiry timer (registry.s1Expiry.minutes)." },
    { name: "S1 state machine", ref: "state-machines/s1-state-machine.ts", detail: "Sets the (ACTIVE, S1) composite state." },
  ],
  search: [
    { name: "Availability query params", ref: "p01-availability-query-params-s1.ts", detail: "Validates dates / guest-count / room-type of the search." },
    { name: "Availability engine", ref: "engines/availability-engine.ts", detail: "Computes available / deficient / unavailable rooms for the window." },
    { name: "Pricing pipeline (indicative)", ref: "engines/pricing-pipeline-engine.ts", detail: "Attaches an indicative-only nightly rate (not a quote)." },
    { name: "s1-availability-service", ref: "services/domain/s1-availability-service.ts", detail: "Persists the AvailabilityConfiguration result set." },
    { name: "W1 — dwell / staleness", ref: "STAGE_DWELL_MONITOR · w1-stage-dwell-monitor.ts", detail: "Marks the result stale after the staleness window; fires dwell warnings.", trace: "^STAGE_DWELL\\." },
  ],
  select: [
    { name: "s1-availability-service.selectOption", ref: "services/domain/s1-availability-service.ts", detail: "Records the preferred room on the configuration.", trace: "^CONFIGURATION_SELECTED$" },
    { name: "Deficiency acknowledgement", ref: "availability deficiency policy", detail: "A deficient room requires an explicit acknowledgement, captured on select." },
  ],
  advance: [
    { name: "Optimistic-lock match", ref: "p01-entry-version-optimistic-lock-match.ts", detail: "Rejects S1→S2 if the entry version is stale." },
    { name: "Policy 12 — duplicate-inquiry S1 exit", ref: "p12 · registry.duplicateInquiry.blockS1Exit", detail: "May block S1 exit when a duplicate inquiry is detected.", trace: "^INQUIRY\\.DUPLICATE_FLAGGED$" },
    { name: "S1 state machine — S1→S2 guard", ref: "state-machines/s1-state-machine.ts", detail: "Requires all S1 exit evidence; no unresolved open loops." },
    { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Advances the composite state to (ACTIVE, S2).", trace: "^ENTRY\\.STAGE_TRANSITION$" },
  ],
};

/** The indicative-pricing chip the S1 availability service attaches (SIG-S1 §1.6 — indicative only). */
type IndicativePricing = {
  rateAmount?: number;
  currency?: string;
  stayNights?: number;
  lineTotalIndicative?: number;
};

function readPricing(p: unknown): IndicativePricing | null {
  if (!p || typeof p !== "object") return null;
  const o = p as IndicativePricing;
  if (typeof o.rateAmount === "number" || typeof o.lineTotalIndicative === "number") return o;
  return null;
}

type Epi = "cap" | "der" | "sug" | "sys";
const EPI_MARK: Record<Epi, string> = { cap: "✎", der: "∑", sug: "◇", sys: "⚙" };

function Fact({ label, value, epi = "cap" }: { label: string; value: React.ReactNode; epi?: Epi }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className={`val${epi === "der" ? " derived" : ""}`}>
        {value}
        <span className="axis">
          <span className={`axis-mk ${epi}`}>{EPI_MARK[epi]}</span>
        </span>
      </div>
    </div>
  );
}

function BlockH({ children, tag }: { children: React.ReactNode; tag?: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
      {tag}
    </div>
  );
}

const DASH = <span style={{ color: "var(--ink-3)" }}>—</span>;

/** ISO date strings for every night of a stay (check-in inclusive, check-out exclusive), UTC-safe. */
/**
 * The check-in/check-out the most recent availability search actually ran with.
 *
 * `AvailabilityConfiguration.searchCriteria` is written server-side on every search
 * (s1-availability-service), and `availabilityConfigs` arrives newest-first, so [0] is the
 * latest run. Returns empty when the entry has never been searched — caller falls back to the
 * entry's own intake dates.
 */
function lastSearchedWindow(entry: EntryDetail): { checkIn?: string; checkOut?: string } {
  const sc = (entry.availabilityConfigs ?? [])[0]?.searchCriteria as
    | { checkInDate?: unknown; checkOutDate?: unknown }
    | null
    | undefined;
  const iso = (v: unknown) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : undefined);
  const checkIn = iso(sc?.checkInDate);
  const checkOut = iso(sc?.checkOutDate);
  // Both or neither — a half-restored window would fight the nights/check-out sync effect.
  return checkIn && checkOut ? { checkIn, checkOut } : {};
}

function enumerateNights(checkIn?: string | null, checkOut?: string | null): string[] {
  if (!checkIn || !checkOut) return [];
  const start = new Date(`${checkIn.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${checkOut.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const out: string[] = [];
  const cur = new Date(start.getTime());
  let safety = 0;
  while (cur < end && safety++ < 366) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// (The old per-type card grid — RoomTypeCard/RoomBoxes/groupByType — was replaced by the
// legacy-PMS-style RoomStatusTable in ./room-status-table.tsx: rows = rooms, columns = nights.)

export function InquiryStep({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();

  // The search form is seeded from the LAST SEARCH THAT ACTUALLY RAN, not from the entry's
  // intake dates. Every search persists its inputs to `AvailabilityConfiguration.searchCriteria`
  // server-side, so leaving the step and coming back restores the window the operator was
  // working in — previously the component remounted and snapped back to the intake dates,
  // silently discarding a changed night count.
  const searched = lastSearchedWindow(entry);
  const seedCheckIn = searched.checkIn ?? entry.checkInDate?.slice(0, 10) ?? "";
  const seedCheckOut = searched.checkOut ?? entry.checkOutDate?.slice(0, 10) ?? "";

  const [checkIn, setCheckIn] = useState(seedCheckIn);
  const [checkOut, setCheckOut] = useState(seedCheckOut);
  // Nights — check-out derives from check-in + nights; a manual check-out pick recomputes nights.
  const [nightsStr, setNightsStr] = useState(() =>
    String(Math.max(1, seedCheckIn && seedCheckOut ? enumerateNights(seedCheckIn, seedCheckOut).length : 1)),
  );
  // Rooms required for the search — lives on the ENTRY (the seal validates each night against
  // entry.numberOfRooms), so a changed value is PATCHed to the entry when the search runs.
  const [roomsInput, setRoomsInput] = useState(String(entry.numberOfRooms ?? 1));
  const roomsNum = Math.max(0, parseInt(roomsInput || "0", 10) || 0);

  useEffect(() => {
    if (!checkIn) return;
    const n = Math.max(1, parseInt(nightsStr || "1", 10) || 1);
    const d = new Date(`${checkIn}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return;
    d.setUTCDate(d.getUTCDate() + n);
    setCheckOut(d.toISOString().slice(0, 10));
  }, [checkIn, nightsStr]);

  const onCheckOutChange = (v: string) => {
    setCheckOut(v);
    if (checkIn && v) {
      const d = enumerateNights(checkIn, v).length;
      if (d >= 1) setNightsStr(String(d));
    }
  };

  const [searchResult, setSearchResult] = useState<AvailabilityQueryResponse | null>(null);
  // Which room-type cards have their room list expanded (keyed by group key).


  const configs = entry.availabilityConfigs ?? [];
  const latestConfig = configs[0] ?? null;
  const preferredConfig = configs.find((c) => c.optionSelected != null) ?? null;
  const preferredRoomId = optionSelectedRoomIds(preferredConfig?.optionSelected)[0] ?? null;
  const activeConfigId = searchResult?.configurationId ?? latestConfig?.id ?? null;

  // Rooms the guest is committed to, for an at-a-glance summary. Prefer the actual room
  // assignments (present on imported / confirmed bookings — specific room numbers), else fall
  // back to the sealed availability selection's room count. Deduped by room number.
  const assignedRoomNumbers = Array.from(
    new Map((entry.roomAssignments ?? []).map((a) => [a.room?.roomNumber ?? a.roomId, a])).values(),
  ).map((a) => a.room?.roomNumber ?? String(a.roomId).slice(0, 6));
  const sealedRoomIds = optionSelectedRoomIds(preferredConfig?.optionSelected);
  const roomsSelectedLabel = assignedRoomNumbers.length
    ? assignedRoomNumbers.join(", ")
    : sealedRoomIds.length
      ? `${sealedRoomIds.length} room${sealedRoomIds.length === 1 ? "" : "s"} selected · specific rooms assigned at arrival`
      : null;

  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const hasContact = !!(g?.email || g?.phone);
  const nights = nightsBetween(entry.checkInDate, entry.checkOutDate);

  const inquiryQuery = useQuery({
    queryKey: ["inquiry", entry.inquiryId],
    queryFn: () => getInquiry(session!, entry.inquiryId),
    enabled: !!session && !!entry.inquiryId,
  });
  const inquiry = inquiryQuery.data;
  const channel = inquiry?.sourceChannel;
  // Head count is now structured on the entry (adultCount/childCount/childAges) — no longer
  // parsed back out of the inquiry notes.
  const adults = entry.adultCount ?? null;
  const childCount = entry.childCount ?? null;
  const childAges = entry.childAges ?? [];
  const guestsLabel =
    adults != null
      ? `${adults} adult${adults === 1 ? "" : "s"}${childCount ? ` · ${childCount} child${childCount === 1 ? "" : "ren"}${childAges.length ? ` (age${childAges.length === 1 ? "" : "s"} ${childAges.join(", ")})` : ""}` : ""}`
      : entry.guestCount != null
        ? `${entry.guestCount} guest${entry.guestCount === 1 ? "" : "s"}`
        : null;

  // After a successful search the room table appears far below the fold. Scroll to it once it has
  // actually rendered — the rows arrive with the state update that follows this mutation, so
  // scrolling inside onSuccess would target an element that isn't on the page yet.
  const roomsRef = useRef<HTMLDivElement | null>(null);
  const [scrollToRooms, setScrollToRooms] = useState(false);

  const searchMutation = useMutation({
    mutationFn: async () => {
      if (!checkIn || !checkOut) throw new Error("Check-in and check-out dates required");
      // Save a changed rooms-required to the entry FIRST — the selection cap and the seal's
      // per-night validation both read entry.numberOfRooms, so search and entry must agree.
      const rooms = Math.max(1, parseInt(roomsInput || "1", 10) || 1);
      if (rooms !== (entry.numberOfRooms ?? 1)) {
        await updateEntryIntake(session!, entry.id, { numberOfRooms: rooms, expectedVersion: entry.version });
      }
      // Guest count comes from the entry's own recorded composition — not a search-form input.
      return queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guestCount: entry.guestCount ?? undefined,
        useType: entry.useType ?? undefined,
      });
    },
    onSuccess: (data) => {
      setSearchResult(data);
      setScrollToRooms(true);
      toast.success("Availability saved — pick a preferred option");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      // Refresh the live backend feed so the new trace events / timers show immediately.
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Search failed"),
  });

  const selectMutation = useMutation({
    mutationFn: (body: {
      roomId?: string;
      roomIds?: string[];
      perNight?: Array<{ date: string; roomIds: string[] }>;
      deficientRoomIds: string[];
    }) => {
      const configId = searchResult?.configurationId ?? latestConfig?.id;
      if (!configId) throw new Error("Run availability search first");
      const acks = body.deficientRoomIds.length
        ? body.deficientRoomIds.map((roomId) => ({
            roomId,
            acknowledgedAt: new Date().toISOString(),
            note: "Acknowledged at desk inquiry selection",
          }))
        : undefined;
      return selectAvailabilityOption(session!, configId, {
        roomId: body.roomId,
        roomIds: body.roomIds,
        perNight: body.perNight,
        deficientAcknowledgements: acks,
      });
    },
    onSuccess: () => {
      toast.success("Preferred option selected");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Could not select option");
    },
  });

  // --- Inline intake edit (S1 only) -----------------------------------------------------------
  // Lets the operator go back and fix the stay details captured at intake — dates, party
  // composition and room count — without leaving the booking. Persists to the entry via the
  // existing PATCH /entries/:id (S1-only server-side). Kept separate from the availability-search
  // inputs above, which only shape a search and never touch the stored entry.
  const [isEditing, setIsEditing] = useState(false);
  const [edCheckIn, setEdCheckIn] = useState("");
  const [edCheckOut, setEdCheckOut] = useState("");
  const [edAdults, setEdAdults] = useState("1");
  const [edChildren, setEdChildren] = useState("0");
  const [edChildAges, setEdChildAges] = useState<string[]>([]);
  const [edRooms, setEdRooms] = useState("1");

  const beginEdit = () => {
    setEdCheckIn(entry.checkInDate?.slice(0, 10) ?? "");
    setEdCheckOut(entry.checkOutDate?.slice(0, 10) ?? "");
    setEdAdults(String(entry.adultCount ?? entry.guestCount ?? 1));
    setEdChildren(String(entry.childCount ?? 0));
    setEdChildAges((entry.childAges ?? []).map(String));
    setEdRooms(String(entry.numberOfRooms ?? 1));
    setIsEditing(true);
  };

  // Keep the edit form's child-age list in step with its children count.
  const edChildCount = Math.max(0, parseInt(edChildren || "0", 10) || 0);
  useEffect(() => {
    setEdChildAges((prev) => {
      const next = prev.slice(0, edChildCount);
      while (next.length < edChildCount) next.push("");
      return next;
    });
  }, [edChildCount]);

  // Check-out follows check-in in the edit form too (shortest stay is one night).
  useEffect(() => {
    if (!isEditing || !edCheckIn) return;
    const earliest = nextDayIso(edCheckIn);
    if (!earliest) return;
    setEdCheckOut((prev) => (!prev || prev < earliest ? earliest : prev));
  }, [edCheckIn, isEditing]);

  const edAgesComplete =
    edChildCount === 0 ||
    (edChildAges.length === edChildCount && edChildAges.every((a) => a.trim() !== "" && Number(a) >= 0));

  // How many rooms this party actually needs. Backend-authoritative — POST
  // /api/lookups/allowed-room-counts owns the chargeable-occupant + capacity maths so every
  // frontend gets the same answer (the intake form at /desk/bookings/new uses it too). While
  // editing, the envelope tracks the values being typed; otherwise it reflects the saved entry.
  const roomEnvAdults = isEditing
    ? Math.max(1, parseInt(edAdults || "1", 10) || 1)
    : Math.max(1, entry.adultCount ?? entry.guestCount ?? 1);
  const roomEnvChildAges = isEditing
    ? edChildAges.map((x) => parseInt(x || "", 10)).filter((n) => Number.isFinite(n))
    : entry.childAges ?? [];
  const roomEnvelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", roomEnvAdults, roomEnvChildAges.join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: roomEnvAdults, childAges: roomEnvChildAges }),
    enabled: !!session && roomEnvAdults > 0,
  });
  const roomEnvelope = roomEnvelopeQuery.data ?? null;
  const roomMin = roomEnvelope?.allowedRoomCounts.min ?? null;
  const roomMax = roomEnvelope?.allowedRoomCounts.max ?? null;

  // Cap BOTH rooms inputs at the envelope max instead of letting the backend bounce the
  // search with a raw ValidationError. An increase past the max clamps to it and flashes an
  // explanation under the field; decreases and everything at/below max pass through.
  const [roomsCapMsg, setRoomsCapMsg] = useState<string | null>(null);
  // Bumped on EVERY clamp, including repeats — used as the note's React key so the glow
  // animation restarts when the operator keeps clicking the spinner past the limit.
  const [roomsCapPulse, setRoomsCapPulse] = useState(0);
  const roomsCapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomsChange = (setter: (v: string) => void) => (v: string) => {
    if (roomMax != null && v !== "") {
      const n = parseInt(v, 10) || 0;
      if (n > roomMax) {
        setter(String(roomMax));
        const guests = roomEnvelope?.chargeableOccupants ?? 0;
        setRoomsCapMsg(
          `Can't book more rooms than guests — ${guests} chargeable guest${guests === 1 ? "" : "s"} allow${guests === 1 ? "s" : ""} at most ${roomMax} room${roomMax === 1 ? "" : "s"} (every room needs someone in it). Add guests first to book more rooms.`,
        );
        setRoomsCapPulse((n) => n + 1);
        if (roomsCapTimer.current) clearTimeout(roomsCapTimer.current);
        roomsCapTimer.current = setTimeout(() => setRoomsCapMsg(null), 5000);
        return;
      }
    }
    setter(v);
  };
  const roomsCapNotice = roomsCapMsg ? (
    <p
      key={roomsCapPulse}
      className="cap-note"
      style={{ fontSize: 11, color: "var(--warn)", margin: "4px 0 0", fontWeight: 600, lineHeight: 1.45 }}
    >
      {roomsCapMsg}
    </p>
  ) : null;

  /**
   * Auto-set both room inputs to the minimum the party needs, and let the operator raise it
   * from there (a guest may want more rooms than capacity strictly requires).
   *
   * Keyed on the MINIMUM changing, not on every render — otherwise clearing the field to type
   * "10" would momentarily read as 0, trip the bump, and fight the keystroke. A value already
   * at or above the minimum is a deliberate choice and is left alone; only a value below it
   * gets pulled up.
   */
  const appliedRoomMinRef = useRef<number | null>(null);
  useEffect(() => {
    if (roomMin == null) return;
    if (appliedRoomMinRef.current === roomMin) return;
    appliedRoomMinRef.current = roomMin;
    const raise = (prev: string) => {
      const cur = parseInt(prev || "0", 10) || 0;
      return cur >= roomMin ? prev : String(roomMin);
    };
    setRoomsInput(raise);
    setEdRooms(raise);
  }, [roomMin]);
  const roomEnvelopeHint = roomEnvelope ? (
    <p style={{ fontSize: 11, color: "var(--ink-2)", margin: "5px 0 0", lineHeight: 1.45 }}>
      {roomEnvelope.chargeableOccupants} chargeable guest
      {roomEnvelope.chargeableOccupants === 1 ? "" : "s"} · up to {roomEnvelope.maxCapacityUsed} per room →{" "}
      <b>
        minimum {roomEnvelope.allowedRoomCounts.min} room
        {roomEnvelope.allowedRoomCounts.min === 1 ? "" : "s"}
      </b>
      {roomEnvelope.allowedRoomCounts.max > roomEnvelope.allowedRoomCounts.min
        ? ` (up to ${roomEnvelope.allowedRoomCounts.max} allowed)`
        : ""}
      {roomEnvelope.allowedRoomCounts.max > roomEnvelope.allowedRoomCounts.min
        ? " — set to the minimum; raise it if the guest wants more."
        : ""}
    </p>
  ) : null;
  const updateIntakeMutation = useMutation({
    mutationFn: () => {
      const a = Math.max(1, parseInt(edAdults || "1", 10) || 1);
      const c = Math.max(0, parseInt(edChildren || "0", 10) || 0);
      const ages = edChildAges.map((x) => parseInt(x || "", 10)).filter((n) => Number.isFinite(n));
      return updateEntryIntake(session!, entry.id, {
        checkInDate: edCheckIn || undefined,
        checkOutDate: edCheckOut || undefined,
        adultCount: a,
        childCount: c,
        childAges: c > 0 ? (ages.length === c ? ages : undefined) : [],
        guestCount: a + c,
        numberOfRooms: Math.max(1, parseInt(edRooms || "1", 10) || 1),
        expectedVersion: entry.version,
      });
    },
    onSuccess: () => {
      setIsEditing(false);
      toast.success("Stay details updated");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't update the details"),
  });
  const canSaveEdit = !!edCheckIn && !!edCheckOut && edAgesComplete && !updateIntakeMutation.isPending;
  // Editable only while the booking is genuinely at S1 — the server rejects intake edits after that.
  const canEditIntake = entry.currentStage === "S1";

  const { availableRooms, deficientRooms, unavailableRooms, pricing } = useMemo(() => {
    let rooms: ReturnType<typeof roomsFromResultSet> = {
      availableRooms: [],
      deficientRooms: [],
      unavailableRooms: [],
    };
    let resultIndicative: unknown = null;
    if (searchResult?.results) {
      const fromApi = roomsFromResultSet(searchResult.results);
      rooms = {
        availableRooms: searchResult.results.availableRooms ?? fromApi.availableRooms,
        deficientRooms: searchResult.results.deficientRooms ?? fromApi.deficientRooms,
        unavailableRooms: searchResult.results.unavailableRooms ?? fromApi.unavailableRooms,
      };
      resultIndicative = (searchResult.results as { indicativePricing?: unknown }).indicativePricing;
    } else {
      const source = latestConfig?.resultSet ?? preferredConfig?.resultSet;
      if (source) {
        rooms = roomsFromResultSet(source);
        resultIndicative = (source as { indicativePricing?: unknown }).indicativePricing;
      }
    }
    const pricing =
      readPricing(resultIndicative) ?? readPricing(rooms.availableRooms[0]?.pricingIndicative) ?? null;
    return { ...rooms, pricing };
  }, [searchResult, latestConfig, preferredConfig]);

  const hasResults = availableRooms.length + deficientRooms.length + unavailableRooms.length > 0;
  const stale = latestConfig?.isStale || searchResult?.isStale;

  // Ext-bed counts per room come from the rooms catalog — the availability result doesn't carry
  // them, and the legacy room-status layout shows an Ext. Beds column.
  const roomsCatalog = useQuery({ queryKey: ["rooms"], queryFn: () => listRooms(session!), enabled: !!session });
  const extBedsByRoomId = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of roomsCatalog.data?.items ?? []) {
      if (typeof r.roomType?.maxExtraBeds === "number") m.set(r.id, r.roomType.maxExtraBeds);
    }
    return m;
  }, [roomsCatalog.data]);
  const statusRows = useMemo(
    () => roomStatusRows(availableRooms, deficientRooms, unavailableRooms, extBedsByRoomId),
    [availableRooms, deficientRooms, unavailableRooms, extBedsByRoomId],
  );
  // Multi-room selection is driven purely by party size (Entry.numberOfRooms), never the source
  // channel. numberOfRooms > 1 swaps the single-select cards for the multi-room / per-night picker.
  const numberOfRooms = entry.numberOfRooms ?? 1;
  const multiRoom = numberOfRooms > 1;
  const sealedIds = optionSelectedRoomIds(preferredConfig?.optionSelected);
  const perDate = useMemo<PerDateAvailabilityResult[] | undefined>(() => {
    const src =
      (searchResult?.results as { perDate?: unknown } | undefined) ??
      (latestConfig?.resultSet as { perDate?: unknown } | undefined) ??
      (preferredConfig?.resultSet as { perDate?: unknown } | undefined);
    const pd = src?.perDate;
    return Array.isArray(pd) ? (pd as PerDateAvailabilityResult[]) : undefined;
  }, [searchResult, latestConfig, preferredConfig]);
  // Nights come from the entry's own dates (what the backend perNight coverage check validates
  // against), falling back to the search inputs when the entry has no saved dates.
  const stayNights = useMemo(
    () => enumerateNights(entry.checkInDate ?? checkIn, entry.checkOutDate ?? checkOut),
    [entry.checkInDate, entry.checkOutDate, checkIn, checkOut],
  );
  // Nights the table displays. A search may use different dates than the entry's saved stay —
  // the table must follow the search (that's the window the operator asked about). `perDate`
  // already resolves to the fresh search's breakdown, else the last SAVED search's, so the
  // columns keep matching the restored search window across a leave-and-return instead of
  // snapping back to the entry's intake dates while the form shows the searched ones.
  const displayNights = useMemo(() => {
    if (perDate && perDate.length > 0) return perDate.map((p) => p.date);
    if (searchResult) return enumerateNights(checkIn, checkOut);
    return stayNights;
  }, [perDate, searchResult, checkIn, checkOut, stayNights]);

  const handleMultiSeal = (p: SealPayload) => {
    if (!activeConfigId && !latestConfig?.id) {
      toast.error("Run availability search first");
      return;
    }
    selectMutation.mutate({ roomIds: p.roomIds, perNight: p.perNight, deficientRoomIds: p.deficientRoomIds });
  };

  // --- Room-status-table selection ------------------------------------------------------------
  // The table is THE selection surface (legacy-PMS layout). Clicks toggle a LOCAL selection for
  // every mode — click a room to select it, click another to switch (single-room replaces),
  // click the selected one to unselect — then "Save" commits. Local-first because the backend's
  // select endpoint requires at least one room: a saved selection can't be cleared server-side,
  // but an unsaved click can simply be taken back.
  const [tableSel, setTableSel] = useState<string[]>(() => sealedIds.filter(Boolean).slice(0, numberOfRooms));
  const toggleTableRow = (row: RoomStatusRow) => {
    setTableSel((prev) =>
      prev.includes(row.roomId)
        ? prev.filter((x) => x !== row.roomId) // clicked the selected room → unselect
        : numberOfRooms === 1
          ? [row.roomId] // single-room → switch to the clicked room
          : prev.length < numberOfRooms
            ? [...prev, row.roomId]
            : prev,
    );
  };
  const sealTableSelection = () => {
    const deficientRoomIds = tableSel.filter(
      (id) => statusRows.find((r) => r.roomId === id)?.bucket === "deficient",
    );
    // Same expansion the old whole-stay picker used: per-night payload (identical rooms each
    // night) so downstream arrival assignment consumes one uniform shape.
    if (stayNights.length === 0) {
      handleMultiSeal({ roomIds: tableSel, deficientRoomIds });
      return;
    }
    handleMultiSeal({ perNight: stayNights.map((date) => ({ date, roomIds: [...tableSel] })), deficientRoomIds });
  };

  // Per-night assignment ("Different rooms per night") — cells become the click targets and each
  // night needs exactly numberOfRooms rooms. Available on any multi-night stay, including
  // single-room bookings (a mid-stay room change is one room per night, different rooms).
  const [assignMode, setAssignMode] = useState<"same" | "vary">("same");
  const varyActive = assignMode === "vary" && displayNights.length > 1;

  // Expanded view — the room list is the full property (27 rooms on real data), which does not
  // fit the canvas column. Expanding lifts the same table to a full-screen layer with compact
  // rows so every room is visible at once. `showNames` prints the holder in the cell instead of
  // leaving it to a hover tooltip, which is unusable when scanning the whole grid.
  const [expanded, setExpanded] = useState(false);
  const [showNames, setShowNames] = useState(false);
  // Both survive a reload. Read in an effect rather than a useState initialiser so the server
  // render and the first client render agree (sessionStorage doesn't exist during SSR).
  const viewPrefsKey = `desk:rst-view:${entry.id}`;
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(viewPrefsKey);
      if (!raw) return;
      const v = JSON.parse(raw) as { expanded?: boolean; showNames?: boolean };
      if (v.expanded) setExpanded(true);
      if (v.showNames) setShowNames(true);
    } catch {
      /* private mode / corrupt value — fall back to the collapsed default */
    }
  }, [viewPrefsKey]);
  useEffect(() => {
    try {
      sessionStorage.setItem(viewPrefsKey, JSON.stringify({ expanded, showNames }));
    } catch {
      /* non-fatal — the view just won't persist */
    }
  }, [viewPrefsKey, expanded, showNames]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    // Stop the page behind the overlay scrolling with it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);
  const [varySel, setVarySel] = useState<Record<string, string[]>>({});
  const toggleVaryCell = (row: RoomStatusRow, night: string) => {
    setVarySel((prev) => {
      const cur = prev[night] ?? [];
      const next = cur.includes(row.roomId)
        ? cur.filter((x) => x !== row.roomId)
        : cur.length < numberOfRooms
          ? [...cur, row.roomId]
          : cur;
      return { ...prev, [night]: next };
    });
  };
  const nightsAssigned = displayNights.filter((n) => (varySel[n] ?? []).length === numberOfRooms).length;
  const varyComplete = displayNights.length > 0 && nightsAssigned === displayNights.length;
  const sealVarySelection = () => {
    const perNight = displayNights.map((date) => ({ date, roomIds: varySel[date] ?? [] }));
    const allIds = new Set(perNight.flatMap((p) => p.roomIds));
    const deficientRoomIds = Array.from(allIds).filter(
      (id) => statusRows.find((r) => r.roomId === id)?.bucket === "deficient",
    );
    handleMultiSeal({ perNight, deficientRoomIds });
  };

  // The commit action + progress counter. Rendered below the table normally, hoisted into the
  // toolbar when expanded so nothing but the grid occupies the screen.
  // Fires on the render where the rows first exist. `scrollToRooms` is cleared immediately so a
  // later re-render (selecting a room, toggling per-night mode) never yanks the page again.
  useEffect(() => {
    if (!scrollToRooms || statusRows.length === 0) return;
    setScrollToRooms(false);
    const el = roomsRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => cancelAnimationFrame(id);
  }, [scrollToRooms, statusRows.length]);

  const sealReady = varyActive ? varyComplete : tableSel.length === numberOfRooms;
  const sealControls = (
    <>
      <button
        className="btn btn-primary btn-sm"
        disabled={!sealReady || selectMutation.isPending}
        onClick={varyActive ? sealVarySelection : sealTableSelection}
      >
        {selectMutation.isPending
          ? "Saving…"
          : varyActive
            ? "Seal per-night rooms"
            : numberOfRooms === 1
              ? "Save room selection"
              : `Seal ${numberOfRooms} rooms`}
      </button>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: sealReady ? "var(--green-d)" : "var(--ink-3)" }}>
        {varyActive
          ? `${nightsAssigned} of ${displayNights.length} nights assigned`
          : `${tableSel.length} of ${numberOfRooms} selected`}
      </span>
    </>
  );

  // Persistent highlight: a group stays lit once its action has run for this booking (derived from
  // real state, so it survives reloads). `firingKey` adds the transient "running now" pulse.
  const searchUsed = hasResults || !!latestConfig;
  // Persist-light only from the STORED selection — unsaved table clicks are local, and the save
  // itself is covered by firingKey's "● Now" pulse, so a failed save never leaves a false "✓ Ran".
  const selectUsed = !!preferredRoomId || sealedIds.length > 0;
  const activeKeys = [
    "intake",
    searchUsed ? "search" : null,
    selectUsed ? "select" : null,
    entry.currentStage !== "S1" ? "advance" : null,
  ].filter(Boolean) as string[];
  const firingKey = searchMutation.isPending ? "search" : selectMutation.isPending ? "select" : null;
  const railGroups: RailGroup[] = [
    { key: "intake", label: "When the booking was created", items: S1_BACKEND.intake },
    { key: "search", label: "On availability search", items: S1_BACKEND.search },
    { key: "select", label: "On picking a room type", items: S1_BACKEND.select },
    { key: "advance", label: "On advancing to Negotiation", items: S1_BACKEND.advance },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
      {canEditIntake && !isEditing && (
        <Link
          className="ws-back"
          href={`/desk/bookings/new?edit=${entry.id}`}
          style={{ marginBottom: 10, display: "inline-flex" }}
          title="Go back to the Start-a-booking page to edit this booking's stay details"
        >
          <ChevronLeft />
          Start a booking
        </Link>
      )}
      <div className="speak">
        <div className="now">Do this next</div>
        <h2>Understand the stay, then explore availability.</h2>
        <p>
          Capture what the guest needs and search live availability. You pick a <b>preferred option</b> here —
          rates shown are indicative only, not a quote, and the final room is confirmed at arrival.
        </p>
      </div>

      <div className="block">
        <BlockH
          tag={
            canEditIntake && !isEditing ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={beginEdit}
                title="Edit the stay details captured at intake"
              >
                <Pencil style={{ width: 12, height: 12 }} />
                Edit details
              </button>
            ) : null
          }
        >
          The guest
        </BlockH>
        <div className="frow">
          <Fact label="Primary contact" value={guestName(g)} />
          <Fact label="Came in as" value={channel?.replace(/_/g, " ") ?? DASH} />
        </div>
        {!isEditing ? (
          <>
            <div className="frow">
              <Fact label="Phone / email" value={g?.phone || g?.email || DASH} />
              <Fact label="Guests" value={guestsLabel ?? DASH} />
            </div>
            <div className="frow">
              <Fact label="Check-in" value={formatDMY(entry.checkInDate) || DASH} />
              <Fact
                label="Check-out"
                value={
                  formatDMY(entry.checkOutDate)
                    ? `${formatDMY(entry.checkOutDate)}${nights ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}`
                    : DASH
                }
              />
            </div>
          </>
        ) : (
          <>
            <div className="frow">
              <Fact label="Phone / email" value={g?.phone || g?.email || DASH} />
              <div className="field" />
            </div>
            <div className="frow">
              <div className="field">
                <label>Check-in</label>
                <DateField value={edCheckIn} onChange={setEdCheckIn} />
              </div>
              <div className="field">
                <label>Check-out</label>
                <DateField min={nextDayIso(edCheckIn) || undefined} value={edCheckOut} onChange={setEdCheckOut} />
              </div>
            </div>
            <div className="frow">
              <div className="field">
                <label>Adults</label>
                <input type="number" min={1} value={edAdults} onChange={(e) => setEdAdults(e.target.value)} />
              </div>
              <div className="field">
                <label>Children</label>
                <input type="number" min={0} value={edChildren} onChange={(e) => setEdChildren(e.target.value)} />
              </div>
            </div>
            {edChildCount > 0 && (
              <div className="field">
                <label>Child age{edChildCount === 1 ? "" : "s"} (years)</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {edChildAges.map((age, i) => (
                    <input
                      key={i}
                      type="number"
                      min={0}
                      className="dinput"
                      style={{ width: 80 }}
                      placeholder={`#${i + 1}`}
                      value={age}
                      onChange={(e) => setEdChildAges((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="frow">
              <div className="field">
                <label>Number of rooms</label>
                <input
                  type="number"
                  min={roomEnvelope?.allowedRoomCounts.min ?? 1}
                  value={edRooms}
                  max={roomMax ?? undefined}
                  onChange={(e) => roomsChange(setEdRooms)(e.target.value)}
                />
                {roomEnvelopeHint}
            {roomsCapNotice}
                {roomsCapNotice}
              </div>
              <div className="field" />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <button
                className="btn btn-primary btn-sm"
                disabled={!canSaveEdit}
                onClick={() => updateIntakeMutation.mutate()}
              >
                {updateIntakeMutation.isPending ? "Saving…" : "Save details"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={updateIntakeMutation.isPending}
                onClick={() => setIsEditing(false)}
              >
                <X style={{ width: 13, height: 13 }} />
                Cancel
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "2px 0 0", lineHeight: 1.5 }}>
              This edits the stay the guest asked for. The availability search above is separate — re-run it
              after changing dates or party size.
            </p>
          </>
        )}
        {!hasContact && !isEditing && (
          <p style={{ fontSize: 12, color: "var(--warn)", margin: 0 }}>
            A phone or email is required on the guest before this booking can move to Negotiation.
          </p>
        )}
      </div>

      {roomsSelectedLabel && (
        <div className="block">
          <BlockH>Rooms selected</BlockH>
          <div className="frow">
            <Fact
              label={`Room${assignedRoomNumbers.length === 1 ? "" : "s"}`}
              value={roomsSelectedLabel}
            />
            {entry.numberOfRooms ? (
              <Fact
                label="Rooms needed"
                value={`${assignedRoomNumbers.length || sealedRoomIds.length} of ${entry.numberOfRooms}`}
                epi="der"
              />
            ) : null}
          </div>
        </div>
      )}

      <div className="block">
        <BlockH>Explore availability</BlockH>
        {!entry.checkInDate && (
          <p style={{ fontSize: 12, color: "var(--warn)", marginTop: 0, marginBottom: 11 }}>
            This booking has no saved stay dates. Search uses the dates below, but the booking keeps its own
            dates — set them when creating the inquiry.
          </p>
        )}
        <div className="frow" style={{ gridTemplateColumns: "1fr 90px 1fr" }}>
          <div className="field">
            <label>Check-in</label>
            <DateField value={checkIn} onChange={setCheckIn} />
          </div>
          <div className="field">
            <label>Nights</label>
            <input
              type="number"
              min={1}
              value={nightsStr}
              onChange={(e) => setNightsStr(e.target.value)}
              title="Check-out auto-selects from check-in + nights"
            />
          </div>
          <div className="field">
            <label>Check-out</label>
            <DateField min={nextDayIso(checkIn) || undefined} value={checkOut} onChange={onCheckOutChange} />
          </div>
        </div>
        <div className="frow">
          <div className="field">
            <label>Rooms required</label>
            <input
              type="number"
              min={roomEnvelope?.allowedRoomCounts.min ?? 1}
              value={roomsInput}
              max={roomMax ?? undefined}
              onChange={(e) => roomsChange(setRoomsInput)(e.target.value)}
            />
            {roomEnvelopeHint}
            {roomEnvelope && roomsNum > 0 && roomsNum < roomEnvelope.allowedRoomCounts.min && (
              <p style={{ fontSize: 11, color: "var(--warn)", margin: "4px 0 0", fontWeight: 600 }}>
                {roomEnvelope.chargeableOccupants} guests will not fit in {roomsNum} room
                {roomsNum === 1 ? "" : "s"}.
              </p>
            )}
            <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "5px 0 0" }}>
              Saved to the booking when you search — the selection below asks for exactly this many rooms.
            </p>
          </div>
          <div className="field" />
        </div>
        <button className="btn btn-primary" disabled={searchMutation.isPending} onClick={() => searchMutation.mutate()}>
          <Search />
          {hasResults ? "Search again" : "Search availability"}
        </button>
        {stale && (
          <p style={{ fontSize: 11.5, color: "var(--warn)", marginBottom: 0 }}>
            These results are stale — search again before selecting.
          </p>
        )}
      </div>

      {hasResults && (
        <div className="block">
          <BlockH
            tag={
              <span style={{ fontSize: 9, color: "var(--epi-suggest)", fontWeight: 700, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Sparkles style={{ width: 11, height: 11 }} />
                system-offered
              </span>
            }
          >
            Workable options
          </BlockH>

          {pricing && (
            <div className="fact b-transit" style={{ marginBottom: 11, padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
              <span>
                Indicative{pricing.rateAmount != null ? ` ${money(pricing.rateAmount, pricing.currency)}/night` : ""}
                {pricing.lineTotalIndicative != null && (
                  <>
                    {" "}· {money(pricing.lineTotalIndicative, pricing.currency)} for {pricing.stayNights ?? nights ?? "?"} nights
                  </>
                )}
              </span>
              <span className="tag warn" style={{ fontSize: 9.5 }}>not a quote</span>
            </div>
          )}

          {multiRoom && (
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", margin: "0 0 8px", display: "inline-flex", alignItems: "center", gap: 6 }}>
              This booking needs {numberOfRooms} rooms
              {sealedIds.length > 0 && (
                <span className="tag" style={{ background: "var(--terra-wash, transparent)" }}>
                  {sealedIds.length} sealed
                </span>
              )}
            </div>
          )}

          {statusRows.length > 0 ? (
            <div ref={roomsRef} className={expanded ? "rst-expandwrap on" : "rst-expandwrap"}>
              {expanded && (
                <div className="rst-expandbar">
                  <b>Room status · {statusRows.length} rooms</b>
                  <span className="ln" />
                  <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)}>
                    <Minimize2 style={{ width: 13, height: 13 }} /> Close
                  </button>
                </div>
              )}
              <div className="rst-tools">
                {displayNights.length > 1 && (
                  <div className="seg">
                    <button type="button" className={assignMode === "same" ? "on" : ""} onClick={() => setAssignMode("same")}>
                      Same room{numberOfRooms === 1 ? "" : "s"} every night
                    </button>
                    <button type="button" className={assignMode === "vary" ? "on" : ""} onClick={() => setAssignMode("vary")}>
                      Different rooms per night
                    </button>
                  </div>
                )}
                <span className="ln" />
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm${showNames ? " on" : ""}`}
                  onClick={() => setShowNames((v) => !v)}
                  title={
                    showNames
                      ? "Show status words (Reserved / Held) in the cells"
                      : "Print the guest or agent name on each taken room instead of hovering"
                  }
                >
                  {showNames ? <UserCheck style={{ width: 13, height: 13 }} /> : <Users style={{ width: 13, height: 13 }} />}
                  {showNames ? "Names on" : "Show names"}
                </button>
                {!expanded && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setExpanded(true)}
                    title="Expand to full screen — fits every room on one screen"
                  >
                    <Maximize2 style={{ width: 13, height: 13 }} /> Expand
                  </button>
                )}
                {/* The commit action lives in the toolbar in BOTH views. The room table is as tall
                    as the hotel, so a seal button below it meant scrolling past every room to
                    finish — and past the "N of M selected" counter that says whether you can. */}
                {sealControls}
              </div>
              <RoomStatusTable
                rows={statusRows}
                nights={displayNights}
                perDate={perDate}
                mode={varyActive ? "vary" : "same"}
                selectedIds={tableSel}
                perNightSel={varySel}
                maxSelect={numberOfRooms}
                onToggle={toggleTableRow}
                onToggleCell={toggleVaryCell}
                disabled={selectMutation.isPending}
                dense={expanded}
                showNames={showNames}
              />
              {!expanded && statusRows.some((r) => r.bucket === "deficient") && (
                <p style={{ fontSize: 11, color: "var(--warn)", margin: "10px 0 0", display: "inline-flex", gap: 5, alignItems: "center" }}>
                  <AlertTriangle style={{ width: 12, height: 12 }} />
                  Deficient rooms are selectable — an acknowledgement is recorded when you save.
                </p>
              )}
              <p
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  margin: "10px 0 0",
                  lineHeight: 1.5,
                  display: expanded ? "none" : undefined,
                }}
              >
                {varyActive ? (
                  <>
                    Click a <b>Vacant</b> cell to assign that room for that night — each night needs{" "}
                    {numberOfRooms} room{numberOfRooms === 1 ? "" : "s"}. Rooms may differ night to night (a
                    mid-stay room change).
                  </>
                ) : multiRoom ? (
                  <>
                    Click a room&rsquo;s row to add it to the selection; click a selected room to unselect it.
                    <b> Reserved</b> means the room is taken on that night; a room must be free on every night to be
                    picked here.
                  </>
                ) : (
                  <>
                    Click a room to select it, click another to switch, or click the selected room again to
                    unselect. <b>Reserved</b> means the room is taken on that night; a room must be free on every
                    night to be picked here.
                  </>
                )}{" "}
                Nothing is recorded until you save. The price is indicative only, and the final room is confirmed
                at arrival.
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
              No rooms in this result — search again.
            </p>
          )}
        </div>
      )}
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />
    </div>
  );
}
