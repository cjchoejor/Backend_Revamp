"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AvailabilityRoomResult, PerDateAvailabilityResult } from "@/lib/api/availability";
import type { RoomListItem } from "@/lib/api/rooms";

type Props = {
  /** ISO date (YYYY-MM-DD). */
  checkInDate: string;
  /** ISO date (YYYY-MM-DD). */
  checkOutDate: string;
  availableRooms: AvailabilityRoomResult[];
  deficientRooms: AvailabilityRoomResult[];
  unavailableRooms: AvailabilityRoomResult[];
  /** Per-date breakdown from Phase 2.5. Absent → engine ran date-blind. */
  perDate?: PerDateAvailabilityResult[];
  /** All rooms in the hotel — every one appears as a row (subject to filters). */
  allRooms: RoomListItem[];
  /**
   * Selection state: date (YYYY-MM-DD) → list of roomIds picked for that night. Owned by the
   * parent (S1 workspace) so the seal payload can be built from it.
   */
  selectionsByDate: Record<string, string[]>;
  /**
   * Sealed picks per date — same shape. When present, cells for those rooms/dates render
   * green + non-interactive.
   */
  sealedByDate: Record<string, string[]>;
  /** Target number of rooms per night. Cells lock once a night hits this count. */
  targetRoomsPerNight: number;
  /**
   * Called when the operator clicks a cell. Parent decides whether it's a toggle-on or
   * toggle-off based on current state.
   */
  onToggleCell: (roomId: string, isoDate: string, isDeficient: boolean) => void;
  disabled?: boolean;
};

/**
 * Per-(room, night) availability grid. Replaces the earlier date × room-type layout.
 *
 * Rows are INDIVIDUAL rooms (201, 202, 301, …) filtered by type + floor. Columns are the
 * nights of the stay. Each cell is clickable when the underlying room is available on that
 * night — the operator can pick different rooms on different nights (e.g., 201 for night 1
 * and 301 for night 2). Cells lock once the target-rooms-per-night quota is hit for a date.
 *
 * NOTE on per-date availability: the availability engine today ignores reservations/holds
 * so every date has the same availability set. When the engine grows per-date conflict
 * detection, cells will diverge naturally without a UI change.
 */
export function AvailabilityCalendar({
  checkInDate,
  checkOutDate,
  availableRooms,
  deficientRooms,
  unavailableRooms,
  perDate,
  allRooms,
  selectionsByDate,
  sealedByDate,
  targetRoomsPerNight,
  onToggleCell,
  disabled,
}: Props) {
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [floorFilter, setFloorFilter] = useState<number | null>(null);

  // Whole-range bucket lookup — used as the fallback when perDate isn't supplied and as the
  // baseline "physically usable" answer regardless of date (a room that's currently in
  // maintenance isn't available on any date, even if no reservation blocks it).
  const availabilityByRoomId = useMemo(() => {
    const map = new Map<string, "AVAILABLE" | "DEFICIENT" | "UNAVAILABLE">();
    availableRooms.forEach((r) => map.set(r.roomId, "AVAILABLE"));
    deficientRooms.forEach((r) => map.set(r.roomId, "DEFICIENT"));
    unavailableRooms.forEach((r) => map.set(r.roomId, "UNAVAILABLE"));
    return map;
  }, [availableRooms, deficientRooms, unavailableRooms]);

  // Per-(date, roomId) lookup from Phase 2.5 breakdown. When present, this trumps the
  // whole-range answer for cell rendering — a room can be AVAILABLE overall but OCCUPIED on
  // a specific night due to another guest's reservation.
  const perDateByDateAndRoom = useMemo(() => {
    if (!perDate || perDate.length === 0) return null;
    const map = new Map<string, Map<string, "AVAILABLE" | "OCCUPIED_RESERVED" | "OCCUPIED_HOLD" | "DEFICIENT">>();
    for (const d of perDate) {
      const perRoom = new Map<string, "AVAILABLE" | "OCCUPIED_RESERVED" | "OCCUPIED_HOLD" | "DEFICIENT">();
      d.availableRoomIds.forEach((id) => perRoom.set(id, "AVAILABLE"));
      d.deficientRoomIds.forEach((id) => perRoom.set(id, "DEFICIENT"));
      d.occupiedRoomIds.forEach((o) => perRoom.set(o.roomId, o.source === "HOLD" ? "OCCUPIED_HOLD" : "OCCUPIED_RESERVED"));
      map.set(d.date, perRoom);
    }
    return map;
  }, [perDate]);

  // Room-type + floor lookups derived from the full hotel list.
  const allRoomTypes = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    allRooms.forEach((r) => {
      const id = r.roomType?.id ?? r.roomTypeId;
      if (!id) return;
      if (!map.has(id)) map.set(id, { id, name: r.roomType?.name ?? r.roomType?.code ?? "Unknown type" });
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [allRooms]);

  const allFloors = useMemo(() => {
    const set = new Set<number>();
    allRooms.forEach((r) => {
      if (typeof r.floorNumber === "number") set.add(r.floorNumber);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [allRooms]);

  const filteredRooms = useMemo(() => {
    return allRooms
      .filter((r) => {
        if (typeFilter && (r.roomType?.id ?? r.roomTypeId) !== typeFilter) return false;
        if (floorFilter != null && r.floorNumber !== floorFilter) return false;
        return true;
      })
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [allRooms, typeFilter, floorFilter]);

  const dates = useMemo(() => buildDateRange(checkInDate, checkOutDate), [checkInDate, checkOutDate]);
  if (dates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Select check-in and check-out dates to see the availability calendar.
      </p>
    );
  }

  const isSealed = Object.values(sealedByDate).some((ids) => ids.length > 0);

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
          {filteredRooms.length} rooms · {dates.length} {dates.length === 1 ? "night" : "nights"}
        </span>
      </div>

      {/* Per-night progress */}
      {targetRoomsPerNight > 0 && !isSealed && (
        <div className="grid gap-1 rounded-lg border bg-muted/20 px-3 py-2 text-xs sm:grid-cols-2 md:grid-cols-4">
          {dates.map((d) => {
            const picked = (selectionsByDate[d.iso] ?? []).length;
            const done = picked >= targetRoomsPerNight;
            return (
              <span
                key={d.iso}
                className={cn(
                  "inline-flex items-center gap-1",
                  done ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
                )}
              >
                {done ? <Check className="h-3 w-3" /> : <span className="inline-block h-3 w-3 rounded-full border border-current" />}
                {d.dayLabel}: <span className="font-mono">{picked}/{targetRoomsPerNight}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Grid */}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[600px] border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium text-xs uppercase tracking-wide text-muted-foreground">
                Room
              </th>
              {dates.map((d) => (
                <th key={d.iso} className="min-w-[68px] whitespace-nowrap px-2 py-2 text-center font-medium text-xs">
                  <div className="text-muted-foreground">{d.dow}</div>
                  <div className="text-foreground">{d.dayLabel}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRooms.length === 0 ? (
              <tr>
                <td colSpan={dates.length + 1} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No rooms match the current filters.
                </td>
              </tr>
            ) : (
              filteredRooms.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  dates={dates}
                  availabilityBucket={availabilityByRoomId.get(room.id) ?? "UNAVAILABLE"}
                  perDateForRoom={
                    perDateByDateAndRoom
                      ? Object.fromEntries(
                          dates.map((d) => [d.iso, perDateByDateAndRoom.get(d.iso)?.get(room.id) ?? null]),
                        )
                      : null
                  }
                  selectionsByDate={selectionsByDate}
                  sealedByDate={sealedByDate}
                  targetRoomsPerNight={targetRoomsPerNight}
                  disabled={disabled || isSealed}
                  onToggleCell={onToggleCell}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-emerald-500/20 ring-1 ring-emerald-500/40" /> Available
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-amber-500/20 ring-1 ring-amber-500/40" /> Deficient
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-muted ring-1 ring-border" /> Occupied / blocked
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-primary/40 ring-1 ring-primary/60" /> Selected
        </span>
        <span className="ml-auto italic">
          Click a cell to assign that room for that night. Different rooms per night are allowed
          (e.g. 201 for night 1, 301 for night 2).
        </span>
      </div>
    </div>
  );
}

function RoomRow({
  room,
  dates,
  availabilityBucket,
  perDateForRoom,
  selectionsByDate,
  sealedByDate,
  targetRoomsPerNight,
  disabled,
  onToggleCell,
}: {
  room: RoomListItem;
  dates: { iso: string; dow: string; dayLabel: string }[];
  availabilityBucket: "AVAILABLE" | "DEFICIENT" | "UNAVAILABLE";
  perDateForRoom: Record<string, "AVAILABLE" | "OCCUPIED_RESERVED" | "OCCUPIED_HOLD" | "DEFICIENT" | null> | null;
  selectionsByDate: Record<string, string[]>;
  sealedByDate: Record<string, string[]>;
  targetRoomsPerNight: number;
  disabled?: boolean;
  onToggleCell: (roomId: string, isoDate: string, isDeficient: boolean) => void;
}) {
  const isDeficient = availabilityBucket === "DEFICIENT";

  return (
    <tr className="border-b hover:bg-accent/20">
      <td className="sticky left-0 z-10 bg-card px-3 py-2 align-top">
        <div className="font-mono text-sm font-medium">{room.roomNumber}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
          {room.roomType?.name && <span>{room.roomType.name}</span>}
          {typeof room.floorNumber === "number" && <span>· F{room.floorNumber}</span>}
          {isDeficient && (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-2.5 w-2.5" /> deficient
            </span>
          )}
        </div>
      </td>
      {dates.map((d) => {
        const selectedForNight = selectionsByDate[d.iso] ?? [];
        const sealedForNight = sealedByDate[d.iso] ?? [];
        const isSealedHere = sealedForNight.includes(room.id);
        const isSelectedHere = selectedForNight.includes(room.id);
        const nightAtCapacity = selectedForNight.length >= targetRoomsPerNight;

        // Per-date status is authoritative when available. A room can be AVAILABLE overall
        // but OCCUPIED_RESERVED on a specific night, or the reverse. Fall back to the
        // whole-range bucket when perDate isn't supplied.
        const perDateStatus = perDateForRoom?.[d.iso] ?? null;
        const isUnavailableCell =
          perDateStatus != null
            ? perDateStatus === "OCCUPIED_RESERVED" || perDateStatus === "OCCUPIED_HOLD"
            : availabilityBucket === "UNAVAILABLE";
        const isDeficientCell = perDateStatus === "DEFICIENT" || (perDateStatus == null && availabilityBucket === "DEFICIENT");
        const isAvailableCell = !isUnavailableCell && !isDeficientCell;

        const clickable = !disabled && !isSealedHere && !isUnavailableCell && (isSelectedHere || !nightAtCapacity);
        return (
          <td key={d.iso} className="whitespace-nowrap px-1 py-1 text-center">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onToggleCell(room.id, d.iso, isDeficient || isDeficientCell)}
              className={cn(
                "inline-flex h-8 w-14 items-center justify-center rounded text-[11px] font-medium ring-1 transition",
                isSealedHere && "bg-emerald-600 text-white ring-emerald-700",
                !isSealedHere && isSelectedHere && "bg-primary/40 text-primary-foreground ring-primary/60",
                !isSealedHere &&
                  !isSelectedHere &&
                  isAvailableCell &&
                  "bg-emerald-500/15 text-emerald-800 ring-emerald-500/30 hover:bg-emerald-500/30 dark:text-emerald-300",
                !isSealedHere &&
                  !isSelectedHere &&
                  isDeficientCell &&
                  "bg-amber-500/15 text-amber-800 ring-amber-500/30 hover:bg-amber-500/30 dark:text-amber-300",
                !isSealedHere &&
                  !isSelectedHere &&
                  isUnavailableCell &&
                  "bg-muted text-muted-foreground ring-border cursor-not-allowed",
                clickable && "cursor-pointer",
              )}
              title={
                isSealedHere
                  ? `Sealed for ${d.dayLabel}`
                  : isSelectedHere
                    ? `Click to un-select for ${d.dayLabel}`
                    : nightAtCapacity && !isSelectedHere
                      ? `Night is full (${targetRoomsPerNight} rooms selected)`
                      : perDateStatus === "OCCUPIED_RESERVED"
                        ? "Occupied by another reservation this night"
                        : perDateStatus === "OCCUPIED_HOLD"
                          ? "Held by another booking this night"
                          : isUnavailableCell
                            ? "Occupied or blocked"
                            : `Click to assign ${room.roomNumber} for ${d.dayLabel}`
              }
            >
              {isSealedHere ? "✓" : isSelectedHere ? "●" : isUnavailableCell ? "—" : ""}
            </button>
          </td>
        );
      })}
    </tr>
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
