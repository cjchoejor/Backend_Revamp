"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Mail, Phone, User, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AvailabilityRoomResult, OccupancyContext, PerDateAvailabilityResult } from "@/lib/api/availability";
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
/**
 * The subset of OccupancyContext + source the calendar cares about per occupied cell.
 * Type-alias so both the memo builder and RoomRow type stay in sync.
 */
type OccupiedCellContext = OccupancyContext & { source: "RESERVED" | "HOLD" };

/**
 * State for the "why is this room unavailable" details modal. Populated when the operator
 * clicks a locked/occupied cell. Null → modal closed.
 */
type OccupancyDetailModal = {
  roomNumber: string;
  roomTypeLabel?: string;
  floorLabel?: string;
  isoDate: string;
  dayLabel: string;
  claimState?: string | null;
  unavailabilityReason?: string | null;
  isMaintenance?: boolean;
  isBlocked?: boolean;
  blockedReason?: string | null;
  isDeficient?: boolean;
  /** Multi-booking case: whole-range unavailableRooms carries an array. Prefer showing all. */
  context: OccupiedCellContext[];
};

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
  const [detailModal, setDetailModal] = useState<OccupancyDetailModal | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  useEffect(() => {
    if (!detailModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailModal]);

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
  //
  // Also builds a parallel map of the booking context for occupied cells so the tooltip can
  // name the guest instead of just saying "Occupied". Same key shape as the status map.
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

  const occupancyContextByDateAndRoom = useMemo(() => {
    if (!perDate || perDate.length === 0) return null;
    const map = new Map<string, Map<string, OccupiedCellContext>>();
    for (const d of perDate) {
      const perRoom = new Map<string, OccupiedCellContext>();
      for (const o of d.occupiedRoomIds) {
        perRoom.set(o.roomId, {
          source: o.source,
          entryReferenceNumber: o.entryReferenceNumber ?? null,
          guestName: o.guestName ?? null,
          guestPhone: o.guestPhone ?? null,
          guestEmail: o.guestEmail ?? null,
          agentType: o.agentType ?? null,
          agentName: o.agentName ?? null,
          agentPhone: o.agentPhone ?? null,
          agentEmail: o.agentEmail ?? null,
        });
      }
      map.set(d.date, perRoom);
    }
    return map;
  }, [perDate]);

  /**
   * Whole-range fallback occupancy: when perDate is missing (older backend, stale config)
   * OR a specific date isn't covered, but the whole-range unavailableRooms bucket carries
   * occupiedBy context, use that instead. Preserves ALL blockages (a room can have several
   * overlapping bookings covering different nights of the range). The tooltip uses the
   * first one; the details modal iterates every blockage.
   */
  const wholeRangeOccupancyByRoomId = useMemo(() => {
    const map = new Map<string, OccupiedCellContext[]>();
    for (const r of unavailableRooms) {
      const blocks = r.occupiedBy ?? [];
      if (blocks.length === 0) continue;
      map.set(
        r.roomId,
        blocks.map((primary) => ({
          source: primary.source,
          entryId: primary.entryId,
          entryReferenceNumber: primary.entryReferenceNumber ?? null,
          guestName: primary.guestName ?? null,
          guestPhone: primary.guestPhone ?? null,
          guestEmail: primary.guestEmail ?? null,
          agentType: primary.agentType ?? null,
          agentName: primary.agentName ?? null,
          agentPhone: primary.agentPhone ?? null,
          agentEmail: primary.agentEmail ?? null,
        })),
      );
    }
    return map;
  }, [unavailableRooms]);

  /**
   * Whole-range status lookup keyed by roomId — used to know whether a room is unavailable
   * because of physical state (MAINTENANCE / BLOCKED) rather than a booking. Powers the
   * details modal's "why is this room off-limits" section.
   */
  const unavailabilityMetaByRoomId = useMemo(() => {
    const map = new Map<string, { reason?: string | null; claimState?: string | null; blockedReason?: string | null }>();
    for (const r of unavailableRooms) {
      map.set(r.roomId, {
        reason: r.unavailabilityReason ?? null,
        claimState: r.claimState ?? null,
        blockedReason: r.blockedReason ?? null,
      });
    }
    return map;
  }, [unavailableRooms]);

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
                  occupancyContextForRoom={
                    occupancyContextByDateAndRoom
                      ? Object.fromEntries(
                          dates.map((d) => [d.iso, occupancyContextByDateAndRoom.get(d.iso)?.get(room.id) ?? null]),
                        )
                      : null
                  }
                  wholeRangeOccupancy={wholeRangeOccupancyByRoomId.get(room.id) ?? []}
                  onOpenDetails={(iso, dayLabel) => {
                    const perDateCtx = occupancyContextByDateAndRoom?.get(iso)?.get(room.id) ?? null;
                    const wholeRange = wholeRangeOccupancyByRoomId.get(room.id) ?? [];
                    const context = perDateCtx ? [perDateCtx] : wholeRange;
                    const meta = unavailabilityMetaByRoomId.get(room.id);
                    setDetailModal({
                      roomNumber: room.roomNumber,
                      roomTypeLabel: room.roomType?.name ?? undefined,
                      floorLabel:
                        typeof room.floorNumber === "number" ? `Floor ${room.floorNumber}` : undefined,
                      isoDate: iso,
                      dayLabel,
                      claimState: meta?.claimState ?? null,
                      unavailabilityReason: meta?.reason ?? null,
                      isMaintenance: meta?.reason === "MAINTENANCE_CONFLICT",
                      isBlocked: meta?.reason === "BLOCKED",
                      blockedReason: meta?.blockedReason ?? null,
                      isDeficient: availabilityByRoomId.get(room.id) === "DEFICIENT",
                      context,
                    });
                  }}
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
          (e.g. 201 for night 1, 301 for night 2). Click a locked cell to see who holds the room.
        </span>
      </div>

      {portalReady && detailModal && createPortal(
        <OccupancyDetailsDialog data={detailModal} onClose={() => setDetailModal(null)} />,
        document.body,
      )}
    </div>
  );
}

/**
 * Details modal shown when the operator clicks an occupied / blocked / maintenance / deficient
 * cell. Renders every blockage on the room within the search range plus any physical-status
 * reasons (blocked / maintenance). Click-outside and Escape close it.
 */
function OccupancyDetailsDialog({ data, onClose }: { data: OccupancyDetailModal; onClose: () => void }) {
  const isPhysicalIssue = data.isMaintenance || data.isBlocked;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="occupancy-details-title"
        className="w-full max-w-lg rounded-lg border border-border bg-card text-card-foreground shadow-2xl animate-in zoom-in-95 duration-150"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border p-5">
          <div>
            <h2 id="occupancy-details-title" className="text-lg font-semibold leading-tight">
              Room {data.roomNumber}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {[data.roomTypeLabel, data.floorLabel].filter(Boolean).join(" · ")}
              {data.roomTypeLabel || data.floorLabel ? " · " : ""}
              {data.dayLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
          {/* Physical-state issues take precedence — the room is off-limits regardless of bookings */}
          {isPhysicalIssue && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="font-medium text-amber-900 dark:text-amber-200">
                {data.isMaintenance ? "Room in maintenance" : "Room blocked"}
              </div>
              {data.blockedReason && (
                <div className="mt-1 text-xs text-amber-800 dark:text-amber-300">{data.blockedReason}</div>
              )}
            </div>
          )}
          {data.isDeficient && !isPhysicalIssue && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="font-medium text-amber-900 dark:text-amber-200">Room flagged deficient</div>
              <div className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                Selectable only with explicit acknowledgement of the deficiency.
              </div>
            </div>
          )}

          {/* Bookings — one card per overlapping blockage */}
          {data.context.length === 0 && !isPhysicalIssue && !data.isDeficient && (
            <p className="text-sm text-muted-foreground">
              No booking context available. This room appears off-limits but the backend didn't attach
              a source. Try refreshing the availability search.
            </p>
          )}

          {data.context.map((ctx, idx) => (
            <div key={idx} className="rounded-md border border-border bg-background/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium",
                    ctx.source === "HOLD"
                      ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
                      : "bg-sky-500/15 text-sky-800 dark:text-sky-200",
                  )}
                >
                  {ctx.source === "HOLD" ? "Committed hold" : "Reserved"}
                </span>
                {ctx.entryReferenceNumber && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {ctx.entryReferenceNumber}
                  </span>
                )}
              </div>

              <div className="flex items-start gap-2 text-sm">
                <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <div className="font-medium">{ctx.guestName?.trim() || "Guest"}</div>
                  {data.claimState && idx === 0 && (
                    <div className="text-[11px] text-muted-foreground">Room state: {data.claimState}</div>
                  )}
                </div>
              </div>

              {(ctx.guestPhone?.trim() || ctx.guestEmail?.trim()) && (
                <div className="grid gap-1 pl-6 text-sm">
                  {ctx.guestPhone?.trim() && (
                    <a
                      href={`tel:${ctx.guestPhone.trim()}`}
                      className="inline-flex items-center gap-2 text-primary hover:underline"
                    >
                      <Phone className="h-3.5 w-3.5" /> {ctx.guestPhone.trim()}
                    </a>
                  )}
                  {ctx.guestEmail?.trim() && (
                    <a
                      href={`mailto:${ctx.guestEmail.trim()}`}
                      className="inline-flex items-center gap-2 text-primary hover:underline"
                    >
                      <Mail className="h-3.5 w-3.5" /> {ctx.guestEmail.trim()}
                    </a>
                  )}
                </div>
              )}

              {ctx.agentName?.trim() && (
                <div className="mt-2 rounded border border-border/60 bg-muted/30 p-2 text-sm space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {ctx.agentType === "CORPORATE" ? "Corporate account" : "Travel agent"}
                  </div>
                  <div className="font-medium">{ctx.agentName.trim()}</div>
                  {ctx.agentPhone?.trim() && (
                    <a
                      href={`tel:${ctx.agentPhone.trim()}`}
                      className="inline-flex items-center gap-2 text-xs text-primary hover:underline"
                    >
                      <Phone className="h-3 w-3" /> {ctx.agentPhone.trim()}
                    </a>
                  )}
                  {ctx.agentEmail?.trim() && (
                    <a
                      href={`mailto:${ctx.agentEmail.trim()}`}
                      className="inline-flex items-center gap-2 text-xs text-primary hover:underline"
                    >
                      <Mail className="h-3 w-3" /> {ctx.agentEmail.trim()}
                    </a>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end border-t border-border p-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RoomRow({
  room,
  dates,
  availabilityBucket,
  perDateForRoom,
  occupancyContextForRoom,
  wholeRangeOccupancy,
  selectionsByDate,
  sealedByDate,
  targetRoomsPerNight,
  disabled,
  onToggleCell,
  onOpenDetails,
}: {
  room: RoomListItem;
  dates: { iso: string; dow: string; dayLabel: string }[];
  availabilityBucket: "AVAILABLE" | "DEFICIENT" | "UNAVAILABLE";
  perDateForRoom: Record<string, "AVAILABLE" | "OCCUPIED_RESERVED" | "OCCUPIED_HOLD" | "DEFICIENT" | null> | null;
  /** Same key shape as perDateForRoom — maps ISO date → who holds the room on that night. */
  occupancyContextForRoom: Record<string, OccupiedCellContext | null> | null;
  /**
   * Fallback whole-range occupancy: every blockage on this room that overlaps the search
   * range. Empty array when the room isn't in unavailableRooms with occupiedBy context.
   * Used by both the tooltip (first entry) and the details modal (all entries).
   */
  wholeRangeOccupancy: OccupiedCellContext[];
  selectionsByDate: Record<string, string[]>;
  sealedByDate: Record<string, string[]>;
  targetRoomsPerNight: number;
  disabled?: boolean;
  onToggleCell: (roomId: string, isoDate: string, isDeficient: boolean) => void;
  /** Called when the operator clicks an unavailable cell — opens the details modal. */
  onOpenDetails: (isoDate: string, dayLabel: string) => void;
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

        // Selection is only allowed when the cell is truly available. Unavailable cells
        // remain BUTTONS (not disabled) so the operator can click them to open a
        // "why is this room off-limits" details modal — but the click never toggles selection.
        const clickableForSelection =
          !disabled && !isSealedHere && !isUnavailableCell && (isSelectedHere || !nightAtCapacity);
        // Details-modal is shown for any unavailable cell (occupied by another booking or
        // whole-range blocked/maintenance/deficient). Sealed / selected cells don't open it.
        const clickableForDetails = !isSealedHere && isUnavailableCell;
        // The button is ALWAYS enabled (no `disabled` attribute) so the click event fires
        // reliably. What the click does depends on cell state, decided in the handler:
        //   - available + capacity → toggle selection
        //   - unavailable → open details modal
        //   - sealed or otherwise no-op → do nothing
        const anyAction = clickableForSelection || clickableForDetails;
        return (
          <td key={d.iso} className="whitespace-nowrap px-1 py-1 text-center">
            <button
              type="button"
              onClick={() => {
                if (clickableForSelection) {
                  onToggleCell(room.id, d.iso, isDeficient || isDeficientCell);
                } else if (clickableForDetails) {
                  onOpenDetails(d.iso, d.dayLabel);
                }
              }}
              className={cn(
                "inline-flex h-8 w-14 items-center justify-center rounded text-[11px] font-medium ring-1 transition",
                isSealedHere && "bg-emerald-600 text-white ring-emerald-700 cursor-default",
                !isSealedHere && isSelectedHere && "bg-primary/40 text-primary-foreground ring-primary/60 cursor-pointer",
                !isSealedHere &&
                  !isSelectedHere &&
                  isAvailableCell &&
                  "bg-emerald-500/15 text-emerald-800 ring-emerald-500/30 hover:bg-emerald-500/30 dark:text-emerald-300 cursor-pointer",
                !isSealedHere &&
                  !isSelectedHere &&
                  isDeficientCell &&
                  "bg-amber-500/15 text-amber-800 ring-amber-500/30 hover:bg-amber-500/30 dark:text-amber-300 cursor-pointer",
                !isSealedHere &&
                  !isSelectedHere &&
                  isUnavailableCell &&
                  "bg-muted text-muted-foreground ring-border hover:bg-muted/80 cursor-pointer",
                !anyAction && !isUnavailableCell && "cursor-not-allowed opacity-70",
              )}
              title={(() => {
                if (isSealedHere) return `Sealed for ${d.dayLabel}`;
                if (isSelectedHere) return `Click to un-select for ${d.dayLabel}`;
                if (nightAtCapacity && !isSelectedHere && !isUnavailableCell)
                  return `Night is full (${targetRoomsPerNight} rooms selected)`;
                if (isUnavailableCell) return "Click for details";
                return `Click to assign ${room.roomNumber} for ${d.dayLabel}`;
              })()}
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
