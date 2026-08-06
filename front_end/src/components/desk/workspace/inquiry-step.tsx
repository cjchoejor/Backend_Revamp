"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, Maximize2, Minimize2, Pencil, Search, Sparkles, UserCheck, Users, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { releaseCommittedHold } from "@/lib/api/reservation-setup";
import {
  queryAvailabilityByEntry,
  roomsFromResultSet,
  selectAvailabilityOption,
  type AvailabilityQueryResponse,
  type AvailabilityRoomResult,
  type PerDateAvailabilityResult,
} from "@/lib/api/availability";
import { type SealPayload } from "./multi-room-select";
import { RoomStatusTable, roomStatusRows, type RoomStatusRow, type SelectAllOutcome } from "./room-status-table";
import { RoomSelectBoard } from "./room-select-board";
import { listRooms } from "@/lib/api/rooms";
import { getInquiry } from "@/lib/api/inquiries";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import { updateEntryIntake } from "@/lib/api/entries";
import { formatDMY, guestName, nightsBetween } from "@/lib/desk/model";
import { money } from "@/lib/desk/workspace";
import { BackendRail, type RailGroup } from "./backend-inline";
import { DateField, nextDayIso } from "@/components/desk/date-field";
import type { BackendItem } from "@/lib/desk/backend-map";
import type { AvailabilityOptionSelected, EntryDetail } from "@/types/api";
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

/**
 * Rooms this search found under another booking's committed hold, and the GM's way to free one.
 *
 * A held room used to be a dead end: the only things that released a committed hold were a room
 * change, a re-entry, a cancellation or the TTL running out, so a room held for a booking that
 * had stalled sat unusable with a guest standing at the desk. Releasing is now possible, but
 * deliberately not casual — it is a GM decision, it needs a written reason that is recorded
 * against the booking that loses the room, and the backend refuses once that booking is
 * confirmed (then it is a cancellation or a room change, which carry consequences this does not).
 *
 * Speculative holds are listed but not releasable here: their release route is keyed by hold id,
 * which the availability payload does not carry yet.
 */
function HeldRoomRelease({
  perDate,
  statusRows,
  onReleased,
}: {
  perDate?: PerDateAvailabilityResult[];
  statusRows: RoomStatusRow[];
  onReleased: () => void;
}) {
  const { session } = useSession();
  const isGm = session?.actorLevel === "L3" || session?.actorLevel === "L4";
  const [target, setTarget] = useState<{ entryId: string; roomLabel: string; holder: string } | null>(null);
  const [reason, setReason] = useState("");

  const roomName = useMemo(() => new Map(statusRows.map((r) => [r.roomId, r.roomNumber])), [statusRows]);
  /** One row per (booking, room) held over this window — a hold spanning three nights is one row. */
  const held = useMemo(() => {
    const out = new Map<string, { entryId: string; roomId: string; kind: string; holder: string; ref: string | null; nights: number }>();
    for (const d of perDate ?? []) {
      for (const o of d.occupiedRoomIds) {
        if (o.source !== "HOLD" || !o.entryId) continue;
        const key = `${o.entryId}:${o.roomId}`;
        const cur = out.get(key);
        if (cur) cur.nights += 1;
        else
          out.set(key, {
            entryId: o.entryId,
            roomId: o.roomId,
            kind: (o as { holdKind?: string }).holdKind ?? "COMMITTED",
            holder: o.guestName ?? "Guest",
            ref: o.entryReferenceNumber ?? null,
            nights: 1,
          });
      }
    }
    return [...out.values()].sort((a, b) => (roomName.get(a.roomId) ?? "").localeCompare(roomName.get(b.roomId) ?? "", undefined, { numeric: true }));
  }, [perDate, roomName]);

  const release = useMutation({
    mutationFn: () => releaseCommittedHold(session!, target!.entryId, { releaseReason: reason.trim() }),
    onSuccess: () => {
      toast.success(`Room ${target?.roomLabel} released — search again to pick it up.`);
      setTarget(null);
      setReason("");
      onReleased();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not release the hold"),
  });

  if (held.length === 0) return null;

  return (
    <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--line-2)", borderRadius: "var(--r-md)" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.03em" }}>
        HELD BY ANOTHER BOOKING
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "4px 0 8px", lineHeight: 1.5 }}>
        These rooms are promised to someone else. A hold can be released by a GM when the other
        booking has stalled — the reason is recorded against it.
      </p>
      {held.map((h) => (
        <div key={`${h.entryId}:${h.roomId}`} className="pickrow" style={{ borderRadius: "var(--r-sm)" }}>
          <span>
            <b>Room {roomName.get(h.roomId) ?? h.roomId}</b>
            <span style={{ color: "var(--ink-3)" }}>
              {" "}
              · {h.kind === "SPECULATIVE" ? "tentative hold" : "committed hold"} · {h.holder}
              {h.ref ? ` · ${h.ref}` : ""} · {h.nights} night{h.nights === 1 ? "" : "s"}
            </span>
          </span>
          {h.kind === "SPECULATIVE" ? (
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>expires on its own</span>
          ) : isGm ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setTarget({ entryId: h.entryId, roomLabel: roomName.get(h.roomId) ?? h.roomId, holder: h.holder });
                setReason("");
              }}
            >
              Release
            </button>
          ) : (
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>GM can release</span>
          )}
        </div>
      ))}

      {target && (
        <div style={{ marginTop: 10, padding: "10px 12px", border: "1px solid var(--warn)", background: "var(--warn-t)", borderRadius: "var(--r-md)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--warn)" }}>
            Release room {target.roomLabel} from {target.holder}?
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "4px 0 8px", lineHeight: 1.5 }}>
            Their booking loses this room and nothing tells them automatically — someone has to.
            Every room that booking is holding is freed, not just this one.
          </p>
          <input
            className="dinput"
            placeholder="Why is this being released? (recorded on their booking)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={reason.trim().length < 3 || release.isPending}
              onClick={() => release.mutate()}
            >
              {release.isPending ? "Releasing…" : "Release the room"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTarget(null)}>
              Keep the hold
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
  // Follow the entry when the rooms-required changes upstream — "Edit details" on this very step
  // PATCHes it, and a useState initialiser only runs once. Left stale this field didn't merely
  // display the old number: the search below PATCHes the entry back to whatever it holds, so the
  // edit was silently reverted the next time the operator searched. Keyed on the entry's value so
  // typing in the field is never overwritten mid-edit.
  const lastEntryRoomsRef = useRef(entry.numberOfRooms ?? 1);
  useEffect(() => {
    const n = entry.numberOfRooms ?? 1;
    if (n === lastEntryRoomsRef.current) return;
    lastEntryRoomsRef.current = n;
    setRoomsInput(String(n));
  }, [entry.numberOfRooms]);

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
  // Live child-policy bands for the edit form's age hint (cache-shared with intake/boards).
  // Pricing cut ≠ supervision cut: 11+ is charged as an adult while still a minor.
  const childPolicyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const cpYoungMax = childPolicyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const cpChildMax = childPolicyQuery.data?.ageBands.childMaxAge ?? 10;
  const cpMinAdult = childPolicyQuery.data?.unaccompaniedMinor.minimumAge ?? 18;
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
  // Max occupancy per room (catalog data) — the guest board's capacity ceiling.
  const capacityByRoomId = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of roomsCatalog.data?.items ?? []) {
      const cap = r.roomType?.maxCapacity ?? r.roomType?.standardCapacity;
      if (typeof cap === "number") m.set(r.id, cap);
    }
    return m;
  }, [roomsCatalog.data]);
  // The second ceiling the backend enforces (OVER_MAX_CHILDREN): capacity counts only chargeable
  // guests, so without this a bed-full room would take unlimited under-11s.
  const maxChildrenByRoomId = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of roomsCatalog.data?.items ?? []) {
      if (typeof r.roomType?.maxChildren === "number") m.set(r.id, r.roomType.maxChildren);
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

  // Canonical form of the last SUBMITTED selection — lets the save button show "Saved"
  // right away on success instead of waiting for the entry refetch (see `showSaved` below).
  const submittedCanonRef = useRef<string | null>(null);
  const handleMultiSeal = (p: SealPayload) => {
    if (!activeConfigId && !latestConfig?.id) {
      toast.error("Run availability search first");
      return;
    }
    // Remember exactly what was submitted so the button can show "Saved" immediately on
    // success, before the entry refetch brings the server's copy back (see `showSaved`).
    submittedCanonRef.current = p.perNight
      ? canonNights(p.perNight)
      : `*=${[...(p.roomIds ?? [])].sort().join(",")}`;
    selectMutation.mutate({ roomIds: p.roomIds, perNight: p.perNight, deficientRoomIds: p.deficientRoomIds });
  };

  // --- Room selection: ONE authority ----------------------------------------------------------
  // A single canonical selection drives every view (2026-08-01, operator request — the old
  // same/vary/board triple kept three parallel stores, so per-night picks were invisible in the
  // whole-stay view and vice versa). `baseSel` is the rooms used on every night; `nightOverrides`
  // holds the FULL room list for any night that deliberately differs (a mid-stay room change).
  // Table row clicks edit baseSel, night cells edit overrides, the guest board writes both —
  // there is no second selection to fall out of step with.
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const seedFromSaved = (): { base: string[]; overrides: Record<string, string[]> } => {
    const opt = preferredConfig?.optionSelected as AvailabilityOptionSelected | null | undefined;
    if (opt && "perNight" in opt && Array.isArray(opt.perNight) && opt.perNight.length > 0) {
      const perNight = opt.perNight.map((p) => ({
        date: String(p.date).slice(0, 10),
        roomIds: p.roomIds.map((r) => r.roomId),
      }));
      const base = perNight[0].roomIds
        .filter((id) => perNight.every((p) => p.roomIds.includes(id)))
        .slice(0, numberOfRooms);
      const overrides: Record<string, string[]> = {};
      for (const p of perNight) {
        if (!sameSet(p.roomIds, base)) overrides[p.date] = [...p.roomIds];
      }
      return { base, overrides };
    }
    return { base: sealedIds.filter(Boolean).slice(0, numberOfRooms), overrides: {} };
  };
  const [baseSel, setBaseSel] = useState<string[]>(() => seedFromSaved().base);
  const [nightOverrides, setNightOverrides] = useState<Record<string, string[]>>(() => seedFromSaved().overrides);
  // In-progress (unsaved) picks survive leaving the workspace and coming back. Hydrated in an
  // effect (SSR-safe); an empty stored list is NOT restored, so the saved-selection seed above
  // keeps priority. Reads the pre-unification `{tableSel, varySel}` shape too.
  const selStoreKey = `desk:rst-sel:${entry.id}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(selStoreKey);
      if (!raw) return;
      const v = JSON.parse(raw) as {
        base?: string[];
        overrides?: Record<string, string[]>;
        tableSel?: string[];
        varySel?: Record<string, string[]>;
      };
      const base = Array.isArray(v.base) ? v.base : Array.isArray(v.tableSel) ? v.tableSel : null;
      if (base && base.length > 0) {
        const clean = base.filter((x) => typeof x === "string").slice(0, numberOfRooms);
        setBaseSel(clean);
        const ov = v.overrides ?? v.varySel;
        if (ov && typeof ov === "object") {
          const next: Record<string, string[]> = {};
          for (const [night, ids] of Object.entries(ov)) {
            if (Array.isArray(ids) && !sameSet(ids, clean)) next[night] = ids.filter((x) => typeof x === "string");
          }
          setNightOverrides(next);
        }
      }
    } catch {
      /* corrupt / private mode — start from the saved selection as before */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selStoreKey]);
  // Rooms-required can change AFTER rooms were picked ("Edit details" on this step). The cap is
  // enforced on every click, but a lowered number would otherwise leave a selection standing that
  // is over the new limit — visibly "3 of 2 selected", and unsaveable with no way to tell which
  // room to drop. Trim to the new count instead, oldest picks kept, and say so.
  useEffect(() => {
    const over =
      baseSel.length > numberOfRooms ||
      Object.values(nightOverrides).some((ids) => ids.length > numberOfRooms);
    if (!over) return;
    setBaseSel((prev) => (prev.length > numberOfRooms ? prev.slice(0, numberOfRooms) : prev));
    setNightOverrides((prev) => {
      const next: Record<string, string[]> = {};
      for (const [night, ids] of Object.entries(prev)) {
        next[night] = ids.length > numberOfRooms ? ids.slice(0, numberOfRooms) : ids;
      }
      return next;
    });
    toast.info(
      `This booking now needs ${numberOfRooms} room${numberOfRooms === 1 ? "" : "s"} — the extra picks were dropped. Check the selection before saving.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numberOfRooms]);

  /** The rooms actually in force on one night — its override, else the whole-stay rooms. */
  const effectiveNight = (n: string): string[] => nightOverrides[n] ?? baseSel;
  const effectiveByNight = useMemo(
    () => Object.fromEntries(displayNights.map((n) => [n, nightOverrides[n] ?? baseSel])),
    [displayNights, nightOverrides, baseSel],
  );
  const differingNights = useMemo(
    () => displayNights.filter((n) => nightOverrides[n] != null && !sameSet(nightOverrides[n], baseSel)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayNights, nightOverrides, baseSel],
  );
  const nightsDiffer = differingNights.length > 0;
  /**
   * Row click = "use this room for the WHOLE stay", so it writes every night, not just the base.
   *
   * Editing the base alone was wrong once any night carried an override: the base then applies to
   * no night at all, so its length is not the selection size. A 6-room booking with all 6 rooms
   * placed per night could still take two more row clicks — the base was only at 4 — and those
   * rooms showed a row checkmark while every one of their night cells read Vacant. The cap has to
   * be measured per night, because that is what actually gets saved.
   */
  const toggleTableRow = (row: RoomStatusRow) => {
    const id = row.roomId;
    const onEveryNight =
      displayNights.length > 0
        ? displayNights.every((n) => effectiveNight(n).includes(id))
        : baseSel.includes(id);
    // A room can sit in the base while every night overrides it away — nothing uses it, but it
    // would return the moment the differences are reset. Clicking such a room clears it rather
    // than trying (and failing) to add a room that is already there.
    const inertInBase =
      baseSel.includes(id) && displayNights.length > 0 && !displayNights.some((n) => effectiveNight(n).includes(id));

    if (onEveryNight || inertInBase) {
      setBaseSel((prev) => prev.filter((x) => x !== id));
      setNightOverrides((prev) =>
        Object.fromEntries(Object.entries(prev).map(([night, ids]) => [night, ids.filter((x) => x !== id)])),
      );
      return;
    }

    // Single-room bookings switch outright — per-night differences are meaningless for one room.
    if (numberOfRooms === 1) {
      setBaseSel([id]);
      setNightOverrides({});
      return;
    }

    const fullNights = displayNights.filter(
      (n) => !effectiveNight(n).includes(id) && effectiveNight(n).length >= numberOfRooms,
    );
    if (fullNights.length > 0) {
      toast.info(
        `${fullNights.length === displayNights.length ? "Every night" : `${fullNights.map((n) => formatDMY(n) || n).join(", ")}`} already ${
          fullNights.length === 1 ? "has" : "have"
        } ${numberOfRooms} room${numberOfRooms === 1 ? "" : "s"} — free one up on ${
          fullNights.length === 1 ? "that night" : "those nights"
        } first, or change just the nights you want this room on.`,
      );
      return;
    }
    setBaseSel((prev) => (prev.includes(id) || prev.length >= numberOfRooms ? prev : [...prev, id]));
    setNightOverrides((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([night, ids]) => [night, ids.includes(id) ? ids : [...ids, id]]),
      ),
    );
  };
  /** One night's cell: copy-on-first-edit from the whole-stay rooms; an override that comes back
   *  to match them is dropped, so "differs" is always real rather than a stale flag. */
  const toggleNightCell = (row: RoomStatusRow, night: string) => {
    setNightOverrides((prev) => {
      const cur = prev[night] ?? baseSel;
      const next = cur.includes(row.roomId)
        ? cur.filter((x) => x !== row.roomId)
        : numberOfRooms === 1
          ? [row.roomId]
          : cur.length < numberOfRooms
            ? [...cur, row.roomId]
            : cur;
      if (next === cur) return prev; // night already full — the cell shows why
      const out = { ...prev };
      if (sameSet(next, baseSel)) delete out[night];
      else out[night] = next;
      return out;
    });
  };

  /**
   * Says what a row's "Select all nights" click could NOT do.
   *
   * The click takes every night the room is free and leaves the rest — a guest wanting three
   * nights in a room that is booked on the first still gets nights 2 and 3. That partial result
   * has to be stated out loud, naming the dates and who holds them, or the operator reads a
   * half-filled row as a whole-stay booking and promises a night the hotel has already sold.
   */
  const reportSelectAll = (row: RoomStatusRow, outcome: SelectAllOutcome) => {
    const { picked, blocked, full } = outcome;
    const label = (d: string) => formatDMY(d) || d;
    const gaps = [
      ...blocked.map((b) => `${label(b.date)} — ${b.status === "held" ? "held" : b.status === "blocked" ? "out of service" : "reserved"}${b.holder ? ` (${b.holder})` : ""}`),
      ...full.map((d) => `${label(d)} — this night already has its ${numberOfRooms} room${numberOfRooms === 1 ? "" : "s"}`),
    ];
    if (gaps.length === 0) {
      toast.success(`Room ${row.roomNumber} taken on all ${picked.length} night${picked.length === 1 ? "" : "s"}.`);
      return;
    }
    const total = displayNights.length;
    toast.warning(
      picked.length > 0
        ? `Room ${row.roomNumber} taken on ${picked.length} of ${total} night${total === 1 ? "" : "s"}.`
        : `Room ${row.roomNumber} is not free on any night of this stay.`,
      { description: `Not available: ${gaps.join(" · ")}`, duration: 9000 },
    );
  };

  // Guest-board selection (2026-07-31) — the S2 quote board's chips-into-bins interaction as an
  // alternative way to pick rooms: place the party, and the occupied rooms ARE the selection.
  // Writes the same canonical selection the table writes (base via onSelectionChange, overrides
  // via onPerNightChange), so the seal button, counter and deficient-acknowledgement flow are
  // shared unchanged. Needs the intake party breakdown for chips.
  const canBoardParty = (entry.adultCount ?? 0) > 0 || (entry.childAges ?? []).length > 0;
  const [viewMode, setViewMode] = useState<"table" | "board">("table");
  const boardActive = viewMode === "board" && canBoardParty;
  // The board emits base rooms first, then the per-night picture (same effect, in that order) —
  // the ref carries the fresh base into the per-night handler without waiting for a re-render.
  const boardBaseRef = useRef<string[]>([]);
  // The board mounts knowing only the whole-stay rooms, so its first uniform emission is an echo
  // of its own seed, not the operator saying "make every night the same" — don't let it wipe
  // per-night picks made in the table. Any LATER uniform emission is a real decision and clears.
  const boardEchoRef = useRef(false);
  useEffect(() => {
    if (boardActive) boardEchoRef.current = true;
  }, [boardActive]);

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
  // Persist the in-progress picks whenever they change — hydrated above.
  useEffect(() => {
    try {
      localStorage.setItem(selStoreKey, JSON.stringify({ base: baseSel, overrides: nightOverrides }));
    } catch {
      /* non-fatal — the picks just won't survive navigation */
    }
  }, [selStoreKey, baseSel, nightOverrides]);

  // The commit action + progress counter. Rendered below the table normally, hoisted into the
  // toolbar when expanded so nothing but the grid occupies the screen.
  // Fires on the render where the rows first exist. `scrollToRooms` is cleared immediately so a
  // later re-render (selecting a room, toggling a night cell) never yanks the page again.
  useEffect(() => {
    if (!scrollToRooms || statusRows.length === 0) return;
    setScrollToRooms(false);
    const el = roomsRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => cancelAnimationFrame(id);
  }, [scrollToRooms, statusRows.length]);

  // ONE seal for every view, reading the canonical selection. Uniform stays keep the historic
  // whole-stay expansion over the entry's own nights; per-night differences submit exactly the
  // nights on display (what the operator saw and assigned).
  const sealSelection = () => {
    const allIds = nightsDiffer
      ? [...new Set(displayNights.flatMap((n) => effectiveNight(n)))]
      : baseSel;
    const deficientRoomIds = allIds.filter(
      (id) => statusRows.find((r) => r.roomId === id)?.bucket === "deficient",
    );
    if (nightsDiffer) {
      handleMultiSeal({
        perNight: displayNights.map((date) => ({ date, roomIds: [...effectiveNight(date)] })),
        deficientRoomIds,
      });
      return;
    }
    if (stayNights.length === 0) {
      handleMultiSeal({ roomIds: baseSel, deficientRoomIds });
      return;
    }
    handleMultiSeal({ perNight: stayNights.map((date) => ({ date, roomIds: [...baseSel] })), deficientRoomIds });
  };
  const nightsReady = displayNights.filter((n) => effectiveNight(n).length === numberOfRooms).length;
  const sealReady = nightsDiffer
    ? displayNights.length > 0 && nightsReady === displayNights.length
    : baseSel.length === numberOfRooms;

  // ---- Saved-vs-dirty button state (2026-08-01, operator request) ----------------------------
  // The standard "settings form" pattern: the button reads "Save…" while the picks differ from
  // what the server holds, and flips to a green "✓ Saved…" (disabled — nothing to do) once they
  // match. It's DERIVED by comparing selections, not a flag set on click — so any change to the
  // picks (table click, board drag, per-night cell) flips it back to "Save…" automatically, and
  // reloading the page shows the truth rather than a stale flag.
  const canonNights = (pn: Array<{ date: string; roomIds: string[] }>) =>
    pn
      .map((p) => `${String(p.date).slice(0, 10)}=${[...p.roomIds].sort().join(",")}`)
      .sort()
      .join("|");
  // What the server currently holds, normalised to the same shape the save paths submit.
  const savedCanon = useMemo(() => {
    const opt = preferredConfig?.optionSelected as AvailabilityOptionSelected | null | undefined;
    if (!opt) return null;
    if ("perNight" in opt && Array.isArray(opt.perNight)) {
      return canonNights(opt.perNight.map((p) => ({ date: p.date, roomIds: p.roomIds.map((r) => r.roomId) })));
    }
    const ids = optionSelectedRoomIds(opt);
    if (ids.length === 0) return null;
    return stayNights.length > 0
      ? canonNights(stayNights.map((date) => ({ date, roomIds: ids })))
      : `*=${[...ids].sort().join(",")}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredConfig?.optionSelected, stayNights]);
  // What clicking Save right now would submit — mirrors sealSelection exactly.
  const currentCanon = useMemo(() => {
    if (nightsDiffer) return canonNights(displayNights.map((date) => ({ date, roomIds: nightOverrides[date] ?? baseSel })));
    if (baseSel.length === 0) return null;
    return stayNights.length > 0
      ? canonNights(stayNights.map((date) => ({ date, roomIds: baseSel })))
      : `*=${[...baseSel].sort().join(",")}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nightsDiffer, nightOverrides, displayNights, baseSel, stayNights]);
  // Bridge the gap between a successful save and the entry refetch delivering the server's copy.
  const justSaved = selectMutation.isSuccess && submittedCanonRef.current != null && submittedCanonRef.current === currentCanon;
  const showSaved =
    !selectMutation.isPending && currentCanon != null && ((savedCanon != null && savedCanon === currentCanon) || justSaved);

  const saveLabel = nightsDiffer ? "Save per-night rooms" : numberOfRooms === 1 ? "Save room selection" : `Save ${numberOfRooms} rooms`;
  const savedLabel = nightsDiffer ? "✓ Saved per-night rooms" : numberOfRooms === 1 ? "✓ Room selection saved" : `✓ Saved ${numberOfRooms} rooms`;

  const sealControls = (
    <>
      <button
        className={`btn btn-sm${showSaved ? "" : " btn-primary"}`}
        style={
          showSaved
            ? {
                background: "var(--green-t)",
                borderColor: "var(--green-t2)",
                color: "var(--green-d)",
                // Beat `.btn[disabled]`'s dimming — this is a settled state, not an unavailable action.
                opacity: 1,
              }
            : undefined
        }
        disabled={showSaved || !sealReady || selectMutation.isPending}
        title={showSaved ? "This selection is saved — change a room to edit it" : undefined}
        onClick={sealSelection}
      >
        {/* One verb everywhere — this is a SAVE (re-doable via "Change selection"), and the
            old Save/Seal split by room count read as two different actions. */}
        {selectMutation.isPending ? "Saving…" : showSaved ? savedLabel : saveLabel}
      </button>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: sealReady ? "var(--green-d)" : "var(--ink-3)" }}>
        {nightsDiffer
          ? `${nightsReady} of ${displayNights.length} nights ready`
          : `${baseSel.length} of ${numberOfRooms} selected`}
      </span>
      {/* The selection has exactly one authority — this chip says what it currently holds, in
          BOTH views, so "which one is active" is never a guess. Differences are droppable in one
          click rather than by hunting each overridden cell. */}
      {displayNights.length > 1 &&
        (nightsDiffer ? (
          <span
            className="tag warn"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            title={`Nights with their own rooms: ${differingNights.map((n) => formatDMY(n) || n).join(", ")}`}
          >
            {differingNights.length} night{differingNights.length === 1 ? "" : "s"} differ
            <button
              type="button"
              onClick={() => setNightOverrides({})}
              style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit", textDecoration: "underline", font: "inherit" }}
              title="Drop the per-night differences — every night goes back to the whole-stay rooms"
            >
              reset
            </button>
          </span>
        ) : (
          <span className="tag" title="One selection applies to every night. Click a single night's cell in the table to make that night differ.">
            Same rooms every night
          </span>
        ))}
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
                      max={Math.max(0, cpMinAdult - 1)}
                      className="dinput"
                      style={{ width: 80 }}
                      placeholder={`#${i + 1}`}
                      value={age}
                      onChange={(e) => setEdChildAges((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                    />
                  ))}
                </div>
                <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "6px 0 0", lineHeight: 1.5 }}>
                  The age sets the charge: under {cpYoungMax + 1} stay and eat free · {cpYoungMax + 1}–{cpChildMax}{" "}
                  pay child rates ·{" "}
                  <b>
                    {cpChildMax + 1}–{Math.max(0, cpMinAdult - 1)} are charged as adults
                  </b>{" "}
                  (own bed, full room &amp; meals) while still counting as minors for supervision. Anyone{" "}
                  {cpMinAdult}+ goes under Adults.
                </p>
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
                  {sealedIds.length} saved
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
                {canBoardParty && (
                  <div className="seg">
                    <button
                      type="button"
                      className={!boardActive ? "on" : ""}
                      onClick={() => setViewMode("table")}
                      title="Room-status grid — click a room to use it every night, or a single night's cell to change just that night"
                    >
                      Table
                    </button>
                    <button
                      type="button"
                      className={boardActive ? "on" : ""}
                      onClick={() => {
                        // The full-screen layer is a table affordance.
                        setExpanded(false);
                        setViewMode("board");
                      }}
                      title="Place each guest in a room — rooms with guests become the selection"
                    >
                      Guest board
                    </button>
                  </div>
                )}
                <span className="ln" />
                {!boardActive && (
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
                )}
                {!expanded && !boardActive && (
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
              {boardActive ? (
                <RoomSelectBoard
                  rows={statusRows}
                  nights={displayNights}
                  perDate={perDate}
                  entryAdults={entry.adultCount}
                  entryChildAges={entry.childAges}
                  maxRooms={numberOfRooms}
                  selectedRoomIds={baseSel}
                  // Nights the table gave their own rooms, so a single-night pick survives the
                  // switch into the board instead of being dropped to the whole-stay base.
                  initialPerNight={effectiveByNight}
                  onSelectionChange={(ids) => {
                    boardBaseRef.current = ids;
                    setBaseSel(ids);
                  }}
                  onPerNightChange={(pn, diffs) => {
                    // Writes the SAME canonical store the table edits — overrides are the nights
                    // whose placement differs from the base the board just emitted.
                    const base = boardBaseRef.current;
                    if (diffs) {
                      boardEchoRef.current = false;
                      setNightOverrides(
                        Object.fromEntries(
                          pn.filter((p) => !sameSet(p.roomIds, base)).map((p) => [p.date, p.roomIds]),
                        ),
                      );
                    } else if (boardEchoRef.current) {
                      // Mount echo — the board seeds uniform; the table's per-night picks stand.
                      boardEchoRef.current = false;
                    } else {
                      setNightOverrides({});
                    }
                  }}
                  capacityByRoomId={capacityByRoomId}
                  maxChildrenByRoomId={maxChildrenByRoomId}
                  capacitiesReady={roomsCatalog.isSuccess || roomsCatalog.isError}
                  disabled={selectMutation.isPending}
                />
              ) : (
                <RoomStatusTable
                  rows={statusRows}
                  nights={displayNights}
                  perDate={perDate}
                  selectedIds={baseSel}
                  perNightSel={effectiveByNight}
                  maxSelect={numberOfRooms}
                  onToggle={toggleTableRow}
                  onToggleCell={toggleNightCell}
                  onSelectAllNights={reportSelectAll}
                  onCappedClick={() =>
                    toast.info(
                      nightsDiffer
                        ? `Every night already has its ${numberOfRooms} room${numberOfRooms === 1 ? "" : "s"} — free one up first, or click this room under a single night to use it on that night only.`
                        : `All ${numberOfRooms} rooms this booking needs are selected — unselect one first to swap it for this one.`,
                    )
                  }
                  disabled={selectMutation.isPending}
                  dense={expanded}
                  showNames={showNames}
                />
              )}
              {!expanded && <HeldRoomRelease perDate={perDate} statusRows={statusRows} onReleased={() => searchMutation.reset()} />}
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
                  // The board block carries its own hints — this paragraph explains table clicks.
                  display: expanded || boardActive ? "none" : undefined,
                }}
              >
                {multiRoom ? (
                  <>
                    Click a room&rsquo;s row (the left columns) to add it for the <b>whole stay</b>; click a
                    selected room to unselect it.
                  </>
                ) : (
                  <>
                    Click a room&rsquo;s row (the left columns) to select it for the <b>whole stay</b> — click
                    another to switch, or the selected room again to unselect.
                  </>
                )}{" "}
                {displayNights.length > 1 && (
                  <>
                    Click a single night&rsquo;s <b>Vacant</b> cell to change just that night (a mid-stay room
                    change) — that night then keeps its own rooms until you reset it.{" "}
                  </>
                )}
                <b>Reserved</b> means the room is taken on that night.{" "}
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
