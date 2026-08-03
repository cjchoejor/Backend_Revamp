"use client";

import { useMemo, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { formatDMY } from "@/lib/desk/model";
import type { AvailabilityRoomResult, PerDateAvailabilityResult } from "@/lib/api/availability";

/**
 * Legacy-PMS-style "Room Status" table for S1 room selection — rows are individual rooms,
 * columns are the stay's nights, each cell a Vacant / Reserved / Deficient chip (mirrors the
 * hotel's previous software so the desk reads it at a glance).
 *
 * ONE table, one selection (2026-08-01 — replaces the old "same rooms" / "different rooms per
 * night" mode toggle, whose two separate selections silently fell out of step):
 *  - clicking a row's LEADING cells (room no / type / beds / booked-by) toggles the room for the
 *    whole stay — it edits the base selection every night shares;
 *  - clicking one night's Vacant cell toggles the room for that night alone — that night then
 *    carries its own room list (a mid-stay room change) until it matches the base again.
 * `selectedIds` is the whole-stay base; `perNightSel` is the night-by-night EFFECTIVE selection
 * (override or base), so what the cells show is always what saving would submit.
 *
 * Purely presentational over the existing availability result; no new data is fetched here.
 */

export type RoomStatusRow = {
  roomId: string;
  roomNumber: string;
  roomTypeName: string;
  /** Max extra beds for the room's type (from the rooms catalog); null → "—". */
  extBeds: number | null;
  /** Which availability bucket the room came from. */
  bucket: "available" | "deficient" | "unavailable";
  /** Engine reason when bucket === "unavailable". */
  unavailabilityReason?: string;
  /**
   * Who holds this room over the searched range — confirmed reservations AND live committed
   * holds, each with the guest/agent contact the backend resolved. Supplied by the availability
   * engine; never derived here.
   */
  occupiedBy?: AvailabilityRoomResult["occupiedBy"];
  /** Out-of-service note when the room is BLOCKED / MAINTENANCE_CONFLICT (nobody booked it). */
  blockedReason?: string | null;
};

export function roomStatusRows(
  available: AvailabilityRoomResult[],
  deficient: AvailabilityRoomResult[],
  unavailable: AvailabilityRoomResult[],
  extBedsByRoomId: Map<string, number>,
): RoomStatusRow[] {
  const seen = new Set<string>();
  const out: RoomStatusRow[] = [];
  const push = (r: AvailabilityRoomResult, bucket: RoomStatusRow["bucket"]) => {
    if (!r.roomId || seen.has(r.roomId)) return;
    seen.add(r.roomId);
    out.push({
      roomId: r.roomId,
      roomNumber: r.roomNumber ?? r.roomId.slice(0, 6),
      roomTypeName: r.roomTypeName ?? "Room",
      extBeds: extBedsByRoomId.get(r.roomId) ?? null,
      bucket,
      unavailabilityReason: r.unavailabilityReason,
      occupiedBy: r.occupiedBy,
      blockedReason: r.blockedReason ?? null,
    });
  };
  available.forEach((r) => push(r, "available"));
  deficient.forEach((r) => push(r, "deficient"));
  unavailable.forEach((r) => push(r, "unavailable"));
  // Sort by room number so floors read in order like the legacy screen.
  return out.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

type CellStatus = "vacant" | "reserved" | "held" | "deficient" | "blocked";

const CELL_LABEL: Record<CellStatus, string> = {
  vacant: "Vacant",
  reserved: "Reserved",
  held: "Held",
  deficient: "Deficient",
  blocked: "Blocked",
};

function reasonLabel(reason?: string): { status: CellStatus; label?: string } {
  switch (reason) {
    case "BLOCKED":
      return { status: "blocked" };
    case "MAINTENANCE_CONFLICT":
      return { status: "blocked", label: "Maintenance" };
    default:
      // CLAIMED / PHYSICAL_NOT_READY — some booking or state holds the room.
      return { status: "reserved" };
  }
}

/** Occupancy context as it arrives per-night (no dates) or whole-stay (with dates). */
type OccupantLike = {
  source?: "RESERVED" | "HOLD";
  entryReferenceNumber?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  guestEmail?: string | null;
  agentType?: "TRAVEL_AGENT" | "CORPORATE" | null;
  agentName?: string | null;
  agentPhone?: string | null;
  agentEmail?: string | null;
  startDate?: string;
  endDate?: string;
};

/** "Dorji Wangmo" — or the agent/corporate name when the guest profile has none. */
function occupantName(o: OccupantLike): string {
  const guest = o.guestName?.trim();
  if (guest && guest !== "Guest") return guest;
  return o.agentName?.trim() || guest || "Guest";
}

/** Compact one-liner for the "Booked by" cell: who + reference. */
function occupantSummary(o: OccupantLike): string {
  const ref = o.entryReferenceNumber?.trim();
  return ref ? `${occupantName(o)} · ${ref}` : occupantName(o);
}

/**
 * Full detail for the hover tooltip — everything the backend resolved, so the operator can
 * call the holder without leaving the availability screen.
 */
function occupantDetail(o: OccupantLike): string {
  const lines: string[] = [];
  lines.push(`${o.source === "HOLD" ? "Held by" : "Reserved by"} ${occupantName(o)}`);
  if (o.entryReferenceNumber) lines.push(`Booking: ${o.entryReferenceNumber}`);
  if (o.startDate && o.endDate) {
    lines.push(`Stay: ${formatDMY(o.startDate.slice(0, 10)) || o.startDate.slice(0, 10)} → ${formatDMY(o.endDate.slice(0, 10)) || o.endDate.slice(0, 10)}`);
  }
  if (o.guestPhone) lines.push(`Phone: ${o.guestPhone}`);
  if (o.guestEmail) lines.push(`Email: ${o.guestEmail}`);
  if (o.agentName) {
    const kind = o.agentType === "CORPORATE" ? "Corporate" : "Travel agent";
    lines.push(`${kind}: ${o.agentName}${o.agentPhone ? ` (${o.agentPhone})` : ""}`);
  }
  if (o.source === "HOLD") lines.push("Hold — not yet confirmed; may expire and free up.");
  return lines.join("\n");
}

export function RoomStatusTable({
  rows,
  nights,
  perDate,
  selectedIds,
  perNightSel,
  maxSelect,
  onToggle,
  onToggleCell,
  onCappedClick,
  disabled,
  dense,
  showNames,
}: {
  rows: RoomStatusRow[];
  /** ISO YYYY-MM-DD for every night of the stay (check-in inclusive, check-out exclusive). */
  nights: string[];
  perDate?: PerDateAvailabilityResult[];
  /** The whole-stay base selection — what a row click edits. */
  selectedIds: string[];
  /** Effective selection per night (override or base) — what the cells show and edit. */
  perNightSel?: Record<string, string[]>;
  maxSelect: number;
  /** Toggle a room for the whole stay. */
  onToggle: (row: RoomStatusRow) => void;
  /** Toggle a room for one night only. */
  onToggleCell?: (row: RoomStatusRow, night: string) => void;
  /** Fired when a pickable room is clicked while the selection is already full — the parent
   *  explains (toast) instead of the click dying silently. */
  onCappedClick?: () => void;
  disabled?: boolean;
  /** Compact rows so the whole room list fits one screen (used by the expanded view). */
  dense?: boolean;
  /** Print the holder's name in the cell itself rather than only on hover. */
  showNames?: boolean;
}) {
  // night → roomId → who holds it that night. Keeps the whole occupancy context, not just the
  // id, so each cell can name the holder. The engine includes CLAIMED rooms in `perDate`, so
  // this covers rooms that the whole-stay bucket marked unavailable.
  const occupiedByNight = useMemo(() => {
    const m = new Map<string, Map<string, OccupantLike>>();
    for (const pd of perDate ?? []) {
      const inner = new Map<string, OccupantLike>();
      for (const o of pd.occupiedRoomIds) inner.set(o.roomId, o as OccupantLike);
      m.set(pd.date, inner);
    }
    return m;
  }, [perDate]);

  /** Rooms the engine returned a per-date breakdown for — those get per-night truth. */
  const perNightRoomIds = useMemo(() => {
    const s = new Set<string>();
    for (const pd of perDate ?? []) {
      pd.availableRoomIds.forEach((id) => s.add(id));
      pd.deficientRoomIds.forEach((id) => s.add(id));
      pd.occupiedRoomIds.forEach((o) => s.add(o.roomId));
    }
    return s;
  }, [perDate]);

  const cellStatus = (row: RoomStatusRow, night: string): { status: CellStatus; label?: string; occ?: OccupantLike } => {
    const occ = occupiedByNight.get(night)?.get(row.roomId);
    if (occ) return { status: occ.source === "HOLD" ? "held" : "reserved", occ };
    // Per-night data is authoritative when the engine computed it for this room — a room can be
    // booked on some nights of the window and free on others. Only fall back to the whole-stay
    // bucket when there's no per-night answer (e.g. BLOCKED rooms, which never enter perDate).
    if (!perNightRoomIds.has(row.roomId) && row.bucket === "unavailable") return reasonLabel(row.unavailabilityReason);
    if (row.bucket === "deficient") return { status: "deficient" };
    return { status: "vacant" };
  };

  // A room is pickable for the whole stay only when every night is vacant/deficient (deficient
  // stays selectable — the acknowledgement is recorded on seal, same as the old picker).
  const pickable = (row: RoomStatusRow) =>
    row.bucket !== "unavailable" && nights.every((n) => !occupiedByNight.get(n)?.has(row.roomId));

  const anyExtBeds = rows.some((r) => r.extBeds != null);
  // Only surface the attribution column when something in this result set is actually taken —
  // an all-vacant search shouldn't grow a column of dashes.
  const anyOccupancy = rows.some((r) => (r.occupiedBy?.length ?? 0) > 0 || !!r.blockedReason);

  /** Effective rooms on one night — the parent supplies override-or-base per night. */
  const nightSel = (n: string): string[] => perNightSel?.[n] ?? selectedIds;
  const setEq = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  // Any night deviating from the base gets the per-night counts in the header — completion is
  // then per night, and the counter alone can't say which night is short.
  const anyNightDiffers = nights.some((n) => !setEq(nightSel(n), selectedIds));

  // When names are shown in-cell they replace the status word, so the chip carries the colour
  // and the text carries the identity. `cellText` keeps that decision in one place.
  const cellText = (status: CellStatus, label: string | undefined, occ: OccupantLike | undefined) =>
    showNames && occ ? occupantName(occ) : label ?? CELL_LABEL[status];

  // Frozen identity columns. A 20-night stay scrolls horizontally well past the room number, so
  // the leading block stays pinned — otherwise you scroll to night 18 and can no longer tell
  // which room the row belongs to. Widths are fixed here (not measured) so each column's `left`
  // offset is just the sum of the ones before it. Ext. Beds is pinned too when present: it sits
  // between Type and Booked by, and leaving a gap in the middle would let it slide underneath.
  const pinWidths: number[] = [dense ? 54 : 64, dense ? 92 : 110];
  if (anyExtBeds) pinWidths.push(dense ? 48 : 58);
  if (anyOccupancy) pinWidths.push(dense ? 150 : 190);
  const pinLefts = pinWidths.map((_, i) => pinWidths.slice(0, i).reduce((a, b) => a + b, 0));
  const pin = (i: number, extra?: CSSProperties): CSSProperties => ({
    left: pinLefts[i],
    width: pinWidths[i],
    minWidth: pinWidths[i],
    maxWidth: pinWidths[i],
    ...extra,
  });
  const lastPin = pinWidths.length - 1;
  const pinCls = (i: number) => `rst-pin${i === lastPin ? " rst-pin-edge" : ""}`;

  return (
    <div className={`rst-wrap${dense ? " dense" : ""}`}>
      <table className="rst">
        <thead>
          <tr>
            <th className={pinCls(0)} style={pin(0)}>
              Room No
            </th>
            <th className={pinCls(1)} style={pin(1)}>
              Type
            </th>
            {anyExtBeds && (
              <th className={pinCls(2)} style={pin(2, { textAlign: "center" })}>
                Ext. Beds
              </th>
            )}
            {anyOccupancy && (
              <th className={pinCls(anyExtBeds ? 3 : 2)} style={pin(anyExtBeds ? 3 : 2)}>
                Booked by
              </th>
            )}
            {nights.map((n, i) => {
              const count = nightSel(n).length;
              const differs = !setEq(nightSel(n), selectedIds);
              return (
                <th key={n} style={{ textAlign: "center" }} title={differs ? "This night has its own rooms" : undefined}>
                  {formatDMY(n) || n} <span style={{ fontWeight: 500 }}>({i + 1})</span>
                  {differs && <span style={{ color: "var(--warn)", fontWeight: 700 }}> •</span>}
                  {anyNightDiffers && (
                    <span className={`rst-nightcount${count === maxSelect ? " done" : ""}`}>
                      {count}/{maxSelect} picked
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const sel = selectedIds.includes(row.roomId);
            const canPick = pickable(row);
            // Single-room mode never hits the cap: clicking another room SWITCHES to it
            // (the parent replaces the selection) instead of being blocked.
            const atCap = !sel && selectedIds.length >= maxSelect && maxSelect > 1;
            const rowClickable = canPick && !disabled && !atCap;
            // Nights (beyond the base) this room is in — a room picked per-night shows its
            // membership on the row even though the whole-stay check is off.
            const nightsWithRoom = nights.filter((n) => nightSel(n).includes(row.roomId)).length;
            const partial = !sel && nightsWithRoom > 0;
            // "capped" = would be pickable, but the selection is full — dimmed harder than a
            // merely-unavailable row, and clicking it explains itself via onCappedClick.
            const rowCls = sel ? "sel" : rowClickable ? "pick" : canPick && atCap ? "dis capped" : "dis";
            const title = !canPick
              ? `Room ${row.roomNumber} — not free for the whole stay${nights.length > 1 ? "; free nights can still be picked in their columns" : ""}`
              : atCap
                ? "Selection limit reached — unselect another room first"
                : `${sel ? "Unselect" : "Select"} room ${row.roomNumber} for the whole stay — single nights in the columns`;
            return (
              <tr
                key={row.roomId}
                className={rowCls}
                title={title}
                onClick={() => {
                  if (disabled) return;
                  if (rowClickable || sel) onToggle(row);
                  else if (canPick && atCap) onCappedClick?.();
                }}
              >
                <td className={`rst-no ${pinCls(0)}`} style={pin(0)}>
                  {sel && <Check style={{ width: 11, height: 11, marginRight: 4, verticalAlign: "-1px" }} />}
                  {row.roomNumber}
                  {partial && (
                    <span
                      style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: "var(--warn)" }}
                      title={`In the selection on ${nightsWithRoom} of ${nights.length} nights`}
                    >
                      {nightsWithRoom}/{nights.length}
                    </span>
                  )}
                </td>
                <td className={`rst-type ${pinCls(1)}`} style={pin(1)}>
                  {row.roomTypeName}
                </td>
                {anyExtBeds && (
                  <td className={`rst-beds ${pinCls(2)}`} style={pin(2)}>
                    {row.extBeds ?? "—"}
                  </td>
                )}
                {anyOccupancy && (
                  <BookedByCell
                    row={row}
                    className={pinCls(anyExtBeds ? 3 : 2)}
                    style={pin(anyExtBeds ? 3 : 2)}
                  />
                )}
                {nights.map((n) => {
                  const { status, label, occ } = cellStatus(row, n);
                  const selectable = status === "vacant" || status === "deficient";
                  if (selectable && onToggleCell) {
                    const cellSel = nightSel(n).includes(row.roomId);
                    // Single-room bookings switch on click (parent replaces), so never "full".
                    const nightFull = !cellSel && maxSelect > 1 && nightSel(n).length >= maxSelect;
                    return (
                      <td key={n} style={{ textAlign: "center" }}>
                        <button
                          type="button"
                          className={`rst-chip ${cellSel ? "sel" : status}`}
                          disabled={disabled || nightFull}
                          title={
                            cellSel
                              ? `Unassign room ${row.roomNumber} on ${formatDMY(n) || n} only — the row unselects the whole stay`
                              : nightFull
                                ? "This night already has its rooms — unassign one on this night first"
                                : `Assign room ${row.roomNumber} on ${formatDMY(n) || n} only — the row selects the whole stay`
                          }
                          onClick={(e) => {
                            // The row behind this cell toggles the whole stay — a night click
                            // must stay a night click.
                            e.stopPropagation();
                            onToggleCell(row, n);
                          }}
                        >
                          {cellSel ? "Selected" : label ?? CELL_LABEL[status]}
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td key={n} style={{ textAlign: "center" }}>
                      <span
                        className={`rst-chip ${status}${showNames && occ ? " named" : ""}`}
                        title={occ ? occupantDetail(occ) : undefined}
                      >
                        {cellText(status, label, occ)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "Booked by" cell — names whoever holds the room over the searched window. Reservations and
 * live committed holds both appear; holds carry a "Held" tag because they can still expire and
 * free the room up, which changes what the operator can promise. Rooms that are simply out of
 * service show the maintenance reason instead — nobody booked those.
 */
function BookedByCell({
  row,
  className = "",
  style,
}: {
  row: RoomStatusRow;
  className?: string;
  style?: CSSProperties;
}) {
  const occupants = row.occupiedBy ?? [];
  if (occupants.length === 0) {
    if (row.blockedReason) {
      return (
        <td className={`rst-bookedby ${className}`} style={style}>
          <span className="rst-oos" title={row.blockedReason}>
            Out of service — {row.blockedReason}
          </span>
        </td>
      );
    }
    return (
      <td className={`rst-bookedby rst-bookedby-none ${className}`} style={style}>
        —
      </td>
    );
  }

  const [first, ...rest] = occupants;
  const fullDetail = occupants.map(occupantDetail).join("\n\n");
  return (
    <td className={`rst-bookedby ${className}`} style={style} title={fullDetail}>
      <span className="rst-who">{occupantSummary(first)}</span>
      {first.source === "HOLD" && <span className="rst-holdtag">Held</span>}
      {rest.length > 0 && <span className="rst-more">+{rest.length} more</span>}
    </td>
  );
}
