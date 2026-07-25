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
  type PerDateAvailabilityResult,
} from "@/lib/api/availability";
import { MultiRoomSelect, roomMetaFromResults, type SealPayload } from "./multi-room-select";
import { getInquiry } from "@/lib/api/inquiries";
import { roomTypeShort } from "@/lib/desk/rooms";
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

/** ISO date strings for every night of a stay (check-in inclusive, check-out exclusive), UTC-safe. */
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
 * The individual rooms of a type, as a compact box grid. Available / deficient boxes pick
 * that specific room. Unavailable boxes open an occupancy-details dialog showing WHO holds
 * the room (guest, phone, email, agent) so the operator can reach out without leaving S1.
 */
function RoomBoxes({
  group,
  variant,
  onPick,
  selectedRoomId,
  disabled,
  onShowOccupancy,
}: {
  group: RoomTypeGroup;
  variant: "available" | "deficient" | "unavailable";
  onPick?: (room: AvailabilityRoomResult) => void;
  selectedRoomId?: string | null;
  disabled?: boolean;
  onShowOccupancy?: (room: AvailabilityRoomResult) => void;
}) {
  const pickable = variant !== "unavailable" && !!onPick;
  return (
    <div className="room-box-grid">
      {group.rooms.map((r) => {
        const sel = selectedRoomId != null && r.roomId === selectedRoomId;
        const cls = `room-box${variant === "deficient" ? " deficient" : ""}${variant === "unavailable" ? " unavail" : ""}${pickable ? " pick" : ""}${sel ? " sel" : ""}`;
        const label = r.roomNumber ?? r.roomId.slice(0, 6);
        if (variant === "unavailable") {
          // Unavailable rooms are now clickable — opens a modal showing who holds the room.
          return (
            <button
              key={r.roomId}
              type="button"
              className={cls}
              title="Click to see who holds this room"
              onClick={() => onShowOccupancy?.(r)}
              style={{ cursor: "pointer" }}
            >
              {label}
            </button>
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

/**
 * Modal shown when the operator clicks an unavailable room. Renders each overlapping
 * booking (guest, contact links, agent/corporate) plus any physical-status reason.
 * Escape + click-outside + Close button all dismiss.
 */
function OccupancyDetailsModal({ room, onClose }: { room: AvailabilityRoomResult; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const blockages = room.occupiedBy ?? [];
  const reason = room.unavailabilityReason;
  const isPhysicalIssue = reason === "MAINTENANCE_CONFLICT" || reason === "BLOCKED";

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        role="dialog" aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)", color: "var(--ink-1, #111)",
          borderRadius: 10, maxWidth: 520, width: "100%",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)", border: "1px solid var(--line, #e6e0d4)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line, #e6e0d4)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.2 }}>Room {room.roomNumber ?? room.roomId.slice(0, 6)}</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-3, #7a6a52)", marginTop: 3 }}>
              {[room.roomTypeName, room.claimState ? `state ${room.claimState}` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: 0, cursor: "pointer", fontSize: 20, color: "var(--ink-3, #7a6a52)", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 20, maxHeight: "70vh", overflowY: "auto" }}>
          {isPhysicalIssue && (
            <div style={{ padding: 12, borderRadius: 6, background: "#fff4e5", border: "1px solid #f5c37e", marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {reason === "MAINTENANCE_CONFLICT" ? "Room in maintenance" : "Room blocked"}
              </div>
              {room.blockedReason && (
                <div style={{ fontSize: 12, color: "#7a5a20", marginTop: 4 }}>{room.blockedReason}</div>
              )}
            </div>
          )}

          {blockages.length === 0 && !isPhysicalIssue && (
            <p style={{ fontSize: 13, color: "var(--ink-3, #7a6a52)" }}>
              This room is off-limits but the backend didn&apos;t attach booking details. Try refreshing the availability search.
            </p>
          )}

          {blockages.map((b, idx) => (
            <div key={idx} style={{
              border: "1px solid var(--line, #e6e0d4)", borderRadius: 8,
              padding: 14, marginBottom: 10, background: "var(--surface-2, #fafaf5)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
                  background: b.source === "HOLD" ? "#fff4e5" : "#e5f0ff",
                  color: b.source === "HOLD" ? "#7a5a20" : "#1e4b8f",
                }}>
                  {b.source === "HOLD" ? "Committed hold" : "Reserved"}
                </span>
                {b.entryReferenceNumber && (
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--ink-3, #7a6a52)" }}>
                    {b.entryReferenceNumber}
                  </span>
                )}
              </div>

              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
                {b.guestName?.trim() || "Guest"}
              </div>

              {(b.guestPhone || b.guestEmail) && (
                <div style={{ display: "grid", gap: 4, fontSize: 13, marginBottom: 8 }}>
                  {b.guestPhone && (
                    <a href={`tel:${b.guestPhone}`} style={{ color: "var(--accent, #a44f2b)", textDecoration: "none" }}>
                      📞 {b.guestPhone}
                    </a>
                  )}
                  {b.guestEmail && (
                    <a href={`mailto:${b.guestEmail}`} style={{ color: "var(--accent, #a44f2b)", textDecoration: "none" }}>
                      ✉ {b.guestEmail}
                    </a>
                  )}
                </div>
              )}

              {b.agentName && (
                <div style={{
                  marginTop: 10, padding: 10, borderRadius: 6, background: "var(--surface, #fff)",
                  border: "1px solid var(--line, #e6e0d4)",
                }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--ink-3, #7a6a52)", marginBottom: 3 }}>
                    {b.agentType === "CORPORATE" ? "Corporate account" : "Travel agent"}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{b.agentName}</div>
                  {b.agentPhone && (
                    <div style={{ fontSize: 12, marginTop: 3 }}>
                      <a href={`tel:${b.agentPhone}`} style={{ color: "var(--accent, #a44f2b)", textDecoration: "none" }}>📞 {b.agentPhone}</a>
                    </div>
                  )}
                  {b.agentEmail && (
                    <div style={{ fontSize: 12, marginTop: 3 }}>
                      <a href={`mailto:${b.agentEmail}`} style={{ color: "var(--accent, #a44f2b)", textDecoration: "none" }}>✉ {b.agentEmail}</a>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line, #e6e0d4)", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid var(--line, #e6e0d4)",
              background: "var(--surface, #fff)", color: "var(--ink-1, #111)", cursor: "pointer", fontSize: 13,
            }}
          >
            Close
          </button>
        </div>
      </div>
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
  onShowOccupancy,
}: {
  group: RoomTypeGroup;
  variant: "available" | "deficient" | "unavailable";
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  onPickRoom?: (room: AvailabilityRoomResult) => void;
  selectedRoomId?: string | null;
  onShowOccupancy?: (room: AvailabilityRoomResult) => void;
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
        <RoomBoxes group={group} variant={variant} onShowOccupancy={onShowOccupancy} />
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

  // Same rule as intake: a check-in date drags check-out to the next day unless a later one is
  // already set. Keeps the search window valid without overwriting a deliberate multi-night stay.
  useEffect(() => {
    if (!checkIn) return;
    const earliest = nextDayIso(checkIn);
    if (!earliest) return;
    setCheckOut((prev) => (!prev || prev < earliest ? earliest : prev));
  }, [checkIn]);

  const [searchResult, setSearchResult] = useState<AvailabilityQueryResponse | null>(null);
  const [pendingRoom, setPendingRoom] = useState<string | null>(null);
  // Room whose occupancy-details modal is currently open (null → closed).
  const [occupancyModalRoom, setOccupancyModalRoom] = useState<AvailabilityRoomResult | null>(null);
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

  // Multi-room selection is driven purely by party size (Entry.numberOfRooms), never the source
  // channel. numberOfRooms > 1 swaps the single-select cards for the multi-room / per-night picker.
  const numberOfRooms = entry.numberOfRooms ?? 1;
  const multiRoom = numberOfRooms > 1;
  const sealedIds = optionSelectedRoomIds(preferredConfig?.optionSelected);
  const candidateRooms = useMemo(
    () => roomMetaFromResults(availableRooms, deficientRooms),
    [availableRooms, deficientRooms],
  );
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

  const groupSelected = (group: RoomTypeGroup) =>
    group.rooms.some((r) => r.roomId === preferredRoomId || r.roomId === pendingRoom);

  const handleSelect = (room: AvailabilityRoomResult, isDeficient: boolean) => {
    if (!activeConfigId && !latestConfig?.id) {
      toast.error("Run availability search first");
      return;
    }
    setPendingRoom(room.roomId);
    selectMutation.mutate({ roomId: room.roomId, deficientRoomIds: isDeficient ? [room.roomId] : [] });
  };

  const handleMultiSeal = (p: SealPayload) => {
    if (!activeConfigId && !latestConfig?.id) {
      toast.error("Run availability search first");
      return;
    }
    selectMutation.mutate({ roomIds: p.roomIds, perNight: p.perNight, deficientRoomIds: p.deficientRoomIds });
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
        {!hasContact && (
          <p style={{ fontSize: 12, color: "var(--warn)", margin: 0 }}>
            A phone or email is required on the guest before this booking can move to Quote.
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
        <div className="frow">
          <div className="field">
            <label>Check-in</label>
            <DateField value={checkIn} onChange={setCheckIn} />
          </div>
          <div className="field">
            <label>Check-out</label>
            <DateField min={nextDayIso(checkIn) || undefined} value={checkOut} onChange={setCheckOut} />
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

          {multiRoom && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", margin: "0 0 8px", display: "inline-flex", alignItems: "center", gap: 6 }}>
                This booking needs {numberOfRooms} rooms
                {sealedIds.length > 0 && (
                  <span className="tag" style={{ background: "var(--terra-wash, transparent)" }}>
                    {sealedIds.length} sealed
                  </span>
                )}
              </div>
              {candidateRooms.length > 0 ? (
                <MultiRoomSelect
                  numberOfRooms={numberOfRooms}
                  candidateRooms={candidateRooms}
                  perDate={perDate}
                  nights={stayNights}
                  onSeal={handleMultiSeal}
                  isSealing={selectMutation.isPending}
                  sealedRoomIds={sealedIds}
                />
              ) : (
                <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                  No selectable rooms in this result — search again.
                </p>
              )}
            </>
          )}

          {!multiRoom && availableTypes.length > 0 && (
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
          {!multiRoom && deficientTypes.length > 0 && (
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
                    onShowOccupancy={(room) => setOccupancyModalRoom(room)}
                  />
                ))}
              </div>
            </>
          )}

          {!multiRoom && (
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "10px 0 0", lineHeight: 1.5 }}>
              These are grouped by <b>room type</b> and suggested from live availability — you pick a preferred type.
              The price is indicative only (no quote is created at this step), and the final room is assigned at
              arrival.
            </p>
          )}
        </div>
      )}
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />

      {occupancyModalRoom && (
        <OccupancyDetailsModal
          room={occupancyModalRoom}
          onClose={() => setOccupancyModalRoom(null)}
        />
      )}
    </div>
  );
}
