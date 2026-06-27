"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AvailabilityRoomResult } from "@/lib/api/availability";
import type { RoomListItem } from "@/lib/api/rooms";

type Props = {
  /** ISO date (YYYY-MM-DD). */
  checkInDate: string;
  /** ISO date (YYYY-MM-DD). */
  checkOutDate: string;
  availableRooms: AvailabilityRoomResult[];
  deficientRooms: AvailabilityRoomResult[];
  unavailableRooms: AvailabilityRoomResult[];
  /** All rooms in the hotel — used for the lookup (floor, room type name). */
  allRooms: RoomListItem[];
  /** Called when the operator picks a room type cell. Receives one room id within that type. */
  onSelectRoomType: (room: AvailabilityRoomResult, isDeficient: boolean) => void;
  selectedRoomId?: string | null;
  pendingRoomId?: string | null;
  disabled?: boolean;
};

/**
 * Date × Room-Type availability matrix used as the primary room-finder UI in step 2 of the
 * unified booking flow. Each row is a room type; each column is one night of the stay; each cell
 * shows the count of physically available rooms of that type. The operator picks a type by
 * clicking it (we hand the seal flow one specific room of that type — the front desk does the
 * physical assignment later, not now). Filter chips above narrow by type or floor.
 *
 * NOTE: the current availability engine ignores reservations/holds when computing availability —
 * it returns rooms based on present physical state. So every date column shows the same count.
 * When the backend grows per-date conflict detection (Phase 2.5), the columns will diverge.
 */
export function AvailabilityCalendar({
  checkInDate,
  checkOutDate,
  availableRooms,
  deficientRooms,
  unavailableRooms,
  allRooms,
  onSelectRoomType,
  selectedRoomId,
  pendingRoomId,
  disabled,
}: Props) {
  // --- Filters ---
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [floorFilter, setFloorFilter] = useState<number | null>(null);

  // --- Room lookup map (id -> {floor, typeName}) ---
  const roomLookup = useMemo(() => {
    const map = new Map<string, RoomListItem>();
    allRooms.forEach((r) => map.set(r.id, r));
    return map;
  }, [allRooms]);

  // --- All known room types (from the full hotel inventory, NOT just from search results).
  // The user wants the type filter to list EVERY type the hotel has, even if none are
  // currently available, so they can deliberately scope a search rather than only seeing the
  // types that happened to come back.
  const allRoomTypes = useMemo(() => {
    const map = new Map<string, { id: string; name: string; floors: Set<number> }>();
    allRooms.forEach((r) => {
      const id = r.roomType?.id ?? r.roomTypeId;
      if (!id) return;
      const name = r.roomType?.name ?? r.roomType?.code ?? "Unknown type";
      if (!map.has(id)) map.set(id, { id, name, floors: new Set() });
      if (r.floorNumber != null) map.get(id)!.floors.add(r.floorNumber);
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allRooms]);

  // --- Group available + deficient rooms by type (used to compute per-row counts only) ---
  const grouped = useMemo(() => {
    type Group = {
      roomTypeId: string;
      roomTypeName: string;
      available: AvailabilityRoomResult[];
      deficient: AvailabilityRoomResult[];
      floors: Set<number>;
    };
    const groups = new Map<string, Group>();
    // Seed with every type the hotel has so types with no rows still render (showing 0).
    allRoomTypes.forEach((t) => {
      groups.set(t.id, { roomTypeId: t.id, roomTypeName: t.name, available: [], deficient: [], floors: new Set(t.floors) });
    });
    const addToGroup = (room: AvailabilityRoomResult, bucket: "available" | "deficient") => {
      // Prefer the lookup-derived roomTypeId — the availability engine's `roomTypeId` field
      // is unreliable (sometimes missing on the wire), but the rooms lookup (sourced from
      // /api/rooms) is authoritative. Same for floorNumber, which the engine never returns.
      const looked = roomLookup.get(room.roomId);
      const id = looked?.roomType?.id ?? looked?.roomTypeId ?? room.roomTypeId ?? "_unknown";
      const name = looked?.roomType?.name ?? looked?.roomType?.code ?? "Unknown type";
      if (!groups.has(id)) {
        groups.set(id, { roomTypeId: id, roomTypeName: name, available: [], deficient: [], floors: new Set() });
      }
      const g = groups.get(id)!;
      g[bucket].push(room);
      if (looked?.floorNumber != null) g.floors.add(looked.floorNumber);
    };
    availableRooms.forEach((r) => addToGroup(r, "available"));
    deficientRooms.forEach((r) => addToGroup(r, "deficient"));
    return Array.from(groups.values()).sort((a, b) => a.roomTypeName.localeCompare(b.roomTypeName));
  }, [availableRooms, deficientRooms, roomLookup, allRoomTypes]);

  // Distinct floors across all rooms (for the floor filter dropdown)
  const allFloors = useMemo(() => {
    const set = new Set<number>();
    allRooms.forEach((r) => {
      if (r.floorNumber != null) set.add(r.floorNumber);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [allRooms]);

  // --- Apply filters ---
  const filteredGroups = useMemo(() => {
    return grouped
      .filter((g) => !typeFilter || g.roomTypeId === typeFilter)
      .map((g) => {
        if (floorFilter == null) return g;
        const matchFloor = (r: AvailabilityRoomResult) => roomLookup.get(r.roomId)?.floorNumber === floorFilter;
        return {
          ...g,
          available: g.available.filter(matchFloor),
          deficient: g.deficient.filter(matchFloor),
        };
      })
      .filter((g) => g.available.length + g.deficient.length > 0);
  }, [grouped, typeFilter, floorFilter, roomLookup]);

  // --- Dates across the stay ---
  const dates = useMemo(() => buildDateRange(checkInDate, checkOutDate), [checkInDate, checkOutDate]);
  if (dates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Select check-in and check-out dates to see the availability calendar.
      </p>
    );
  }

  const unavailableByType = unavailableRooms.reduce((acc, r) => {
    const id = r.roomTypeId ?? "_unknown";
    acc.set(id, (acc.get(id) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Filter:</span>
        <FilterDropdown
          label="Type"
          value={typeFilter}
          onChange={setTypeFilter}
          options={allRoomTypes.map((t) => ({ value: t.id, label: t.name }))}
        />
        <FilterDropdown
          label="Floor"
          value={floorFilter == null ? null : String(floorFilter)}
          onChange={(v) => setFloorFilter(v == null ? null : Number(v))}
          options={allFloors.map((f) => ({ value: String(f), label: `Floor ${f}` }))}
        />
        {(typeFilter || floorFilter != null) && (
          <button
            type="button"
            onClick={() => {
              setTypeFilter(null);
              setFloorFilter(null);
            }}
            className="ml-1 inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {filteredGroups.reduce((sum, g) => sum + g.available.length, 0)} rooms available across{" "}
          {filteredGroups.length} types
        </span>
      </div>

      {/* Calendar grid */}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[600px] border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium text-xs uppercase tracking-wide text-muted-foreground">
                Room type
              </th>
              {dates.map((d) => (
                <th key={d.iso} className="min-w-[72px] whitespace-nowrap px-2 py-2 text-center font-medium text-xs">
                  <div className="text-muted-foreground">{d.dow}</div>
                  <div className="text-foreground">{d.dayLabel}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredGroups.length === 0 ? (
              <tr>
                <td colSpan={dates.length + 1} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No rooms match the current filters.
                </td>
              </tr>
            ) : (
              filteredGroups.map((g) => (
                <TypeRow
                  key={g.roomTypeId}
                  group={g}
                  dates={dates}
                  unavailableInType={unavailableByType.get(g.roomTypeId) ?? 0}
                  selectedRoomId={selectedRoomId}
                  pendingRoomId={pendingRoomId}
                  disabled={disabled}
                  onSelectRoomType={onSelectRoomType}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-emerald-500/30 ring-1 ring-emerald-500/40" /> Available
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-amber-500/30 ring-1 ring-amber-500/40" /> Deficient
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-muted ring-1 ring-border" /> Unavailable
        </span>
        <span className="ml-auto italic">
          Click a row to select that room type. Specific room numbers are assigned later (pre-arrival or check-in).
        </span>
      </div>
    </div>
  );
}

function TypeRow({
  group,
  dates,
  unavailableInType,
  selectedRoomId,
  pendingRoomId,
  disabled,
  onSelectRoomType,
}: {
  group: { roomTypeId: string; roomTypeName: string; available: AvailabilityRoomResult[]; deficient: AvailabilityRoomResult[]; floors: Set<number> };
  dates: { iso: string; dow: string; dayLabel: string }[];
  unavailableInType: number;
  selectedRoomId?: string | null;
  pendingRoomId?: string | null;
  disabled?: boolean;
  onSelectRoomType: (room: AvailabilityRoomResult, isDeficient: boolean) => void;
}) {
  const availableCount = group.available.length;
  const deficientCount = group.deficient.length;
  const totalCount = availableCount + deficientCount;
  const isSelectedHere =
    !!selectedRoomId &&
    [...group.available, ...group.deficient].some((r) => r.roomId === selectedRoomId);
  const isPendingHere =
    !!pendingRoomId &&
    [...group.available, ...group.deficient].some((r) => r.roomId === pendingRoomId);

  const handleClick = () => {
    if (disabled || totalCount === 0) return;
    // Per the workflow: at S1 we only commit to a room TYPE. The specific room number is
    // chosen later (pre-arrival or check-in) based on guest preferences, loyalty, etc. We
    // hand the seal flow ONE room of the chosen type so the backend has something to
    // sealable — but we don't surface the room numbers up front to avoid implying a
    // commitment.
    const pick = group.available[0] ?? group.deficient[0];
    if (pick) onSelectRoomType(pick, !group.available.length);
  };

  return (
    <tr
      className={cn(
        "border-b transition-colors",
        totalCount > 0 && !disabled && "cursor-pointer hover:bg-accent/50",
        isPendingHere && "bg-primary/5",
        isSelectedHere && "bg-primary/10 ring-1 ring-primary/30",
      )}
      onClick={handleClick}
    >
      <td className="sticky left-0 z-10 bg-card px-3 py-2 align-top">
        <div className="font-medium">{group.roomTypeName}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
          {group.floors.size > 0 && <span>Floors: {[...group.floors].sort((a, b) => a - b).join(", ")}</span>}
          {unavailableInType > 0 && <span className="rounded bg-muted px-1">+ {unavailableInType} occupied</span>}
          {isSelectedHere && <span className="rounded bg-primary/20 px-1 text-primary">selected</span>}
        </div>
      </td>
      {dates.map((d) => (
        <td key={d.iso} className="whitespace-nowrap px-2 py-2 text-center">
          <CalendarCell available={availableCount} deficient={deficientCount} />
        </td>
      ))}
    </tr>
  );
}

function CalendarCell({ available, deficient }: { available: number; deficient: number }) {
  const total = available + deficient;
  if (total === 0) {
    return (
      <span className="inline-flex h-7 w-12 items-center justify-center rounded bg-muted text-xs text-muted-foreground ring-1 ring-border">
        0
      </span>
    );
  }
  if (available > 0) {
    return (
      <span className="inline-flex h-7 w-12 items-center justify-center rounded bg-emerald-500/15 text-xs font-medium text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
        <CheckCircle2 className="mr-0.5 h-3 w-3" />
        {available}
      </span>
    );
  }
  // Only deficient available
  return (
    <span className="inline-flex h-7 w-12 items-center justify-center rounded bg-amber-500/15 text-xs font-medium text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300">
      <AlertTriangle className="mr-0.5 h-3 w-3" />
      {deficient}
    </span>
  );
}

function FilterDropdown({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="h-7 rounded-md border border-border bg-background px-2 text-xs"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{label}: All</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function buildDateRange(checkIn: string, checkOut: string): { iso: string; dow: string; dayLabel: string }[] {
  if (!checkIn || !checkOut) return [];
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(checkIn);
  const b = re.exec(checkOut);
  if (!a || !b) return [];
  const aDate = new Date(Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3])));
  const bDate = new Date(Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])));
  const days: { iso: string; dow: string; dayLabel: string }[] = [];
  const cur = new Date(aDate);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  while (cur < bDate) {
    const iso = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
    days.push({
      iso,
      dow: DOW[cur.getUTCDay()],
      dayLabel: `${MONTHS[cur.getUTCMonth()]} ${cur.getUTCDate()}`,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (days.length > 90) break;
  }
  return days;
}
