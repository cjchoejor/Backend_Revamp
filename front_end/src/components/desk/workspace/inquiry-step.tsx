"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  queryAvailabilityByEntry,
  roomsFromResultSet,
  selectAvailabilityOption,
  type AvailabilityQueryResponse,
  type AvailabilityRoomResult,
} from "@/lib/api/availability";
import { getInquiry } from "@/lib/api/inquiries";
import { roomTypeShort } from "@/lib/desk/rooms";
import { guestName, nightsBetween } from "@/lib/desk/model";
import { money } from "@/lib/desk/workspace";
import { BackendRail, type RailGroup } from "./backend-inline";
import type { BackendItem } from "@/lib/desk/backend-map";
import type { EntryDetail } from "@/types/api";

/**
 * Per-action "what runs in the backend" attribution for S1, surfaced inline next to
 * each operate action so you can watch the machinery as you work (curated from the
 * SIG / DEV-SPEC; references point at the real module / policy id).
 */
const S1_BACKEND: Record<string, BackendItem[]> = {
  intake: [
    { name: "Policy 3 — custodian assignment", ref: "p03-initial-custodian-assignment.ts", detail: "Assigns the owning actor from the inquiry's sourceChannel (throws on an unknown channel)." },
    { name: "Policy 64 — group detection", ref: "p64 · registry.groupDetection.guestCountThreshold", detail: "Flags the entry GROUP when guest count crosses the threshold." },
    { name: "Child / capacity validation", ref: "capacity-validation-service.ts", detail: "BLOCK checks: unaccompanied-minor, adult:child ratio, over-capacity vs room type." },
    { name: "s1-entry-service.createEntry", ref: "services/domain/s1-entry-service.ts", detail: "Creates the Entry and records the head-count breakdown." },
    { name: "W20 — ENTRY_EXPIRY armed", ref: "ENTRY_EXPIRY · w20-entry-expiry-worker.ts", detail: "Arms the S1 expiry timer (registry.s1Expiry.minutes)." },
    { name: "S1 state machine", ref: "state-machines/s1-state-machine.ts", detail: "Sets the (ACTIVE, S1) composite state." },
  ],
  search: [
    { name: "Availability query params", ref: "p01-availability-query-params-s1.ts", detail: "Validates dates / guest-count / room-type of the search." },
    { name: "Availability engine", ref: "engines/availability-engine.ts", detail: "Computes available / deficient / unavailable rooms for the window." },
    { name: "Pricing pipeline (indicative)", ref: "engines/pricing-pipeline-engine.ts", detail: "Attaches an indicative-only nightly rate (not a quote)." },
    { name: "s1-availability-service", ref: "services/domain/s1-availability-service.ts", detail: "Persists the AvailabilityConfiguration result set." },
    { name: "W1 — dwell / staleness", ref: "STAGE_DWELL_MONITOR · w1-stage-dwell-monitor.ts", detail: "Marks the result stale after the staleness window; fires dwell warnings." },
  ],
  select: [
    { name: "s1-availability-service.selectOption", ref: "services/domain/s1-availability-service.ts", detail: "Records the preferred room on the configuration." },
    { name: "Deficiency acknowledgement", ref: "availability deficiency policy", detail: "A deficient room requires an explicit acknowledgement, captured on select." },
  ],
  advance: [
    { name: "Optimistic-lock match", ref: "p01-entry-version-optimistic-lock-match.ts", detail: "Rejects S1→S2 if the entry version is stale." },
    { name: "Policy 12 — duplicate-inquiry S1 exit", ref: "p12 · registry.duplicateInquiry.blockS1Exit", detail: "May block S1 exit when a duplicate inquiry is detected." },
    { name: "S1 state machine — S1→S2 guard", ref: "state-machines/s1-state-machine.ts", detail: "Requires all S1 exit evidence; no unresolved open loops." },
    { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Advances the composite state to (ACTIVE, S2)." },
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

/** A room type with the set of individual rooms of that type returned by availability. */
type RoomTypeGroup = {
  key: string;
  label: string;
  rooms: AvailabilityRoomResult[];
  /** The room a selection acts on (final room is assigned at arrival anyway). */
  representative: AvailabilityRoomResult;
  capacity?: number;
  pricing: IndicativePricing | null;
};

/** Collapse individual rooms into one card per room type (the final room is picked at arrival). */
function groupByType(
  rooms: AvailabilityRoomResult[],
  pricingFallback: IndicativePricing | null,
): RoomTypeGroup[] {
  const map = new Map<string, AvailabilityRoomResult[]>();
  for (const r of rooms) {
    const key = r.roomTypeId ?? "__untyped__";
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }
  return Array.from(map.entries()).map(([key, list]) => {
    const rep = list[0];
    const capacity = Math.max(0, ...list.map((r) => r.capacity ?? 0)) || undefined;
    return {
      key,
      label: rep.roomTypeName ?? (rep.roomTypeId ? roomTypeShort(rep.roomTypeId) : "Room"),
      rooms: list,
      representative: rep,
      capacity,
      pricing: readPricing(rep.pricingIndicative) ?? pricingFallback,
    };
  });
}

/**
 * The individual rooms of a type, as a compact box grid. For available/deficient types each box is
 * individually selectable (picks that exact room); unavailable rooms stay informational. Always shown.
 */
function RoomBoxes({
  group,
  variant,
  onPick,
  selectedRoomId,
  disabled,
}: {
  group: RoomTypeGroup;
  variant: "available" | "deficient" | "unavailable";
  onPick?: (room: AvailabilityRoomResult) => void;
  selectedRoomId?: string | null;
  disabled?: boolean;
}) {
  const pickable = variant !== "unavailable" && !!onPick;
  return (
    <div className="room-box-grid">
      {group.rooms.map((r) => {
        const sel = selectedRoomId != null && r.roomId === selectedRoomId;
        const cls = `room-box${variant === "deficient" ? " deficient" : ""}${variant === "unavailable" ? " unavail" : ""}${pickable ? " pick" : ""}${sel ? " sel" : ""}`;
        const label = r.roomNumber ?? r.roomId.slice(0, 6);
        if (!pickable) {
          return (
            <span key={r.roomId} className={cls} title={`Room ${r.roomNumber ?? r.roomId}`}>
              {label}
            </span>
          );
        }
        return (
          <button
            key={r.roomId}
            type="button"
            className={cls}
            title={`Select room ${r.roomNumber ?? r.roomId}`}
            disabled={disabled}
            aria-pressed={sel}
            onClick={() => onPick!(r)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function RoomTypeCard({
  group,
  variant,
  selected,
  disabled,
  onSelect,
  onPickRoom,
  selectedRoomId,
}: {
  group: RoomTypeGroup;
  variant: "available" | "deficient" | "unavailable";
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  onPickRoom?: (room: AvailabilityRoomResult) => void;
  selectedRoomId?: string | null;
}) {
  const count = group.rooms.length;
  const countLabel = `${count} room${count === 1 ? "" : "s"}`;

  if (variant === "unavailable") {
    return (
      <div className="opt-wrap">
        <div className="opt unavail">
          <span className="ot">
            <span className="otn">{group.label}</span>
            <span className="ots">{countLabel} unavailable</span>
          </span>
          <span className="tag stop">Unavailable</span>
        </div>
        <RoomBoxes group={group} variant={variant} />
      </div>
    );
  }

  const sub = [`${countLabel} ${variant === "deficient" ? "deficient" : "available"}`, group.capacity != null ? `up to ${group.capacity} guests` : null]
    .filter(Boolean)
    .join(" · ");
  const price = group.pricing?.rateAmount != null ? `${money(group.pricing.rateAmount, group.pricing.currency)}/night` : null;

  return (
    <div className="opt-wrap">
      <button
        type="button"
        className={`opt${selected ? " sel" : ""}${variant === "deficient" ? " deficient" : ""}`}
        disabled={disabled}
        onClick={onSelect}
      >
        <span className="radio" />
        <span className="ot">
          <span className="otn">{group.label}</span>
          <span className="ots">{sub}</span>
        </span>
        {variant === "deficient" && (
          <span className="tag warn">
            <AlertTriangle style={{ width: 11, height: 11 }} />
            Deficient
          </span>
        )}
        {price ? <span className="op">{price}</span> : null}
      </button>
      <RoomBoxes group={group} variant={variant} onPick={onPickRoom} selectedRoomId={selectedRoomId} disabled={disabled} />
    </div>
  );
}

export function InquiryStep({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const [checkIn, setCheckIn] = useState(entry.checkInDate?.slice(0, 10) ?? "");
  const [checkOut, setCheckOut] = useState(entry.checkOutDate?.slice(0, 10) ?? "");
  const [adultsInput, setAdultsInput] = useState(String(entry.guestCount ?? 1));
  const [childrenInput, setChildrenInput] = useState("0");
  const partyInited = useRef(false);
  const [searchResult, setSearchResult] = useState<AvailabilityQueryResponse | null>(null);
  const [pendingRoom, setPendingRoom] = useState<string | null>(null);
  // Which room-type cards have their room list expanded (keyed by group key).


  const configs = entry.availabilityConfigs ?? [];
  const latestConfig = configs[0] ?? null;
  const preferredConfig = configs.find((c) => c.optionSelected != null) ?? null;
  const preferredRoomId = preferredConfig?.optionSelected?.roomId ?? null;
  const activeConfigId = searchResult?.configurationId ?? latestConfig?.id ?? null;

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

  // Pre-fill the adults/children search inputs once from the entry's recorded composition.
  useEffect(() => {
    if (partyInited.current) return;
    setAdultsInput(String(adults ?? entry.guestCount ?? 1));
    setChildrenInput(String(childCount ?? 0));
    partyInited.current = true;
  }, [adults, childCount, entry.guestCount]);

  const totalGuests = (Number(adultsInput) || 0) + (Number(childrenInput) || 0);

  const searchMutation = useMutation({
    mutationFn: () => {
      if (!checkIn || !checkOut) throw new Error("Check-in and check-out dates required");
      return queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guestCount: totalGuests || undefined,
        useType: entry.useType ?? undefined,
      });
    },
    onSuccess: (data) => {
      setSearchResult(data);
      setPendingRoom(null);
      toast.success("Availability saved — pick a preferred option");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      // Refresh the live backend feed so the new trace events / timers show immediately.
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Search failed"),
  });

  const selectMutation = useMutation({
    mutationFn: ({ roomId, isDeficient }: { roomId: string; isDeficient: boolean }) => {
      const configId = searchResult?.configurationId ?? latestConfig?.id;
      if (!configId) throw new Error("Run availability search first");
      return selectAvailabilityOption(session!, configId, {
        roomId,
        deficientAcknowledgements: isDeficient
          ? [{ roomId, acknowledgedAt: new Date().toISOString(), note: "Acknowledged at desk inquiry selection" }]
          : undefined,
      });
    },
    onSuccess: () => {
      setPendingRoom(null);
      toast.success("Preferred option selected");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    },
    onError: (e) => {
      setPendingRoom(null);
      toast.error(e instanceof ApiError ? e.message : "Could not select option");
    },
  });

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

  const availableTypes = useMemo(() => groupByType(availableRooms, pricing), [availableRooms, pricing]);
  const deficientTypes = useMemo(() => groupByType(deficientRooms, pricing), [deficientRooms, pricing]);
  const unavailableTypes = useMemo(() => groupByType(unavailableRooms, pricing), [unavailableRooms, pricing]);

  const groupSelected = (group: RoomTypeGroup) =>
    group.rooms.some((r) => r.roomId === preferredRoomId || r.roomId === pendingRoom);

  const handleSelect = (room: AvailabilityRoomResult, isDeficient: boolean) => {
    if (!activeConfigId && !latestConfig?.id) {
      toast.error("Run availability search first");
      return;
    }
    setPendingRoom(room.roomId);
    selectMutation.mutate({ roomId: room.roomId, isDeficient });
  };

  // Persistent highlight: a group stays lit once its action has run for this booking (derived from
  // real state, so it survives reloads). `firingKey` adds the transient "running now" pulse.
  const searchUsed = hasResults || !!latestConfig;
  const selectUsed = !!preferredRoomId || !!pendingRoom;
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
    { key: "advance", label: "On advancing to Quote", items: S1_BACKEND.advance },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
      <div className="speak">
        <div className="now">Do this next</div>
        <h2>Understand the stay, then explore availability.</h2>
        <p>
          Capture what the guest needs and search live availability. You pick a <b>preferred option</b> here —
          rates shown are indicative only, not a quote, and the final room is confirmed at arrival.
        </p>
      </div>

      <div className="block">
        <BlockH>The guest</BlockH>
        <div className="frow">
          <Fact label="Primary contact" value={guestName(g)} />
          <Fact label="Came in as" value={channel?.replace(/_/g, " ") ?? DASH} />
        </div>
        <div className="frow">
          <Fact label="Phone / email" value={g?.phone || g?.email || DASH} />
          <Fact label="Guests" value={guestsLabel ?? DASH} />
        </div>
        {!hasContact && (
          <p style={{ fontSize: 12, color: "var(--warn)", margin: 0 }}>
            A phone or email is required on the guest before this booking can move to Quote.
          </p>
        )}
      </div>

      <div className="block">
        <BlockH>Explore availability</BlockH>
        {!entry.checkInDate && (
          <p style={{ fontSize: 12, color: "var(--warn)", marginTop: 0, marginBottom: 11 }}>
            This booking has no saved stay dates. Search uses the dates below, but the booking keeps its own
            dates — set them when creating the inquiry.
          </p>
        )}
        <div className="frow">
          <div className="field">
            <label>Check-in</label>
            <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </div>
          <div className="field">
            <label>Check-out</label>
            <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          </div>
        </div>
        <div className="frow">
          <div className="field">
            <label>Adults</label>
            <input type="number" min={1} value={adultsInput} onChange={(e) => setAdultsInput(e.target.value)} />
          </div>
          <div className="field">
            <label>Children</label>
            <input type="number" min={0} value={childrenInput} onChange={(e) => setChildrenInput(e.target.value)} />
          </div>
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

          {availableTypes.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", margin: "0 0 7px" }}>Available room types</div>
              <div className="opt-grid">
                {availableTypes.map((group) => (
                  <RoomTypeCard
                    key={group.key}
                    group={group}
                    variant="available"
                    selected={groupSelected(group)}
                    disabled={selectMutation.isPending}
                    onSelect={() => handleSelect(group.representative, false)}
                    onPickRoom={(room) => handleSelect(room, false)}
                    selectedRoomId={pendingRoom ?? preferredRoomId}
                  />
                ))}
              </div>
            </>
          )}
          {deficientTypes.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)", margin: "12px 0 7px" }}>
                Deficient — acknowledgement recorded on select
              </div>
              <div className="opt-grid">
                {deficientTypes.map((group) => (
                  <RoomTypeCard
                    key={group.key}
                    group={group}
                    variant="deficient"
                    selected={groupSelected(group)}
                    disabled={selectMutation.isPending}
                    onSelect={() => handleSelect(group.representative, true)}
                    onPickRoom={(room) => handleSelect(room, true)}
                    selectedRoomId={pendingRoom ?? preferredRoomId}
                  />
                ))}
              </div>
            </>
          )}
          {unavailableTypes.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", margin: "12px 0 7px" }}>
                Unavailable ({unavailableRooms.length})
              </div>
              <div className="opt-grid">
                {unavailableTypes.map((group) => (
                  <RoomTypeCard
                    key={group.key}
                    group={group}
                    variant="unavailable"
                  />
                ))}
              </div>
            </>
          )}

          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "10px 0 0", lineHeight: 1.5 }}>
            These are grouped by <b>room type</b> and suggested from live availability — you pick a preferred type.
            The price is indicative only (no quote is created at this step), and the final room is assigned at
            arrival.
          </p>
        </div>
      )}
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />
    </div>
  );
}
