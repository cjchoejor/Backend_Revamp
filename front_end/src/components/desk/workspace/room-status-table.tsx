"use client";

import { useMemo } from "react";
import { Check } from "lucide-react";
import { formatDMY } from "@/lib/desk/model";
import type { AvailabilityRoomResult, PerDateAvailabilityResult } from "@/lib/api/availability";

/**
 * Legacy-PMS-style "Room Status" table for S1 room selection — rows are individual rooms,
 * columns are the stay's nights, each cell a Vacant / Reserved / Deficient chip (mirrors the
 * hotel's previous software so the desk reads it at a glance).
 *
 * Two selection modes:
 *  - "same"  — whole-stay: clicking a row toggles that room for every night (up to `maxSelect`).
 *              A room qualifies only when it's free on all nights.
 *  - "vary"  — per-night: each vacant cell is its own click target; a room is assigned night by
 *              night (mid-stay room changes). Each night needs `maxSelect` rooms.
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
    });
  };
  available.forEach((r) => push(r, "available"));
  deficient.forEach((r) => push(r, "deficient"));
  unavailable.forEach((r) => push(r, "unavailable"));
  // Sort by room number so floors read in order like the legacy screen.
  return out.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

type CellStatus = "vacant" | "reserved" | "deficient" | "blocked";

const CELL_LABEL: Record<CellStatus, string> = {
  vacant: "Vacant",
  reserved: "Reserved",
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

export function RoomStatusTable({
  rows,
  nights,
  perDate,
  mode = "same",
  selectedIds,
  perNightSel,
  maxSelect,
  onToggle,
  onToggleCell,
  disabled,
}: {
  rows: RoomStatusRow[];
  /** ISO YYYY-MM-DD for every night of the stay (check-in inclusive, check-out exclusive). */
  nights: string[];
  perDate?: PerDateAvailabilityResult[];
  mode?: "same" | "vary";
  /** Whole-stay selection ("same" mode). */
  selectedIds: string[];
  /** Per-night selection ("vary" mode): night → roomIds. */
  perNightSel?: Record<string, string[]>;
  maxSelect: number;
  onToggle: (row: RoomStatusRow) => void;
  onToggleCell?: (row: RoomStatusRow, night: string) => void;
  disabled?: boolean;
}) {
  const occupiedByNight = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const pd of perDate ?? []) m.set(pd.date, new Set(pd.occupiedRoomIds.map((o) => o.roomId)));
    return m;
  }, [perDate]);

  const cellStatus = (row: RoomStatusRow, night: string): { status: CellStatus; label?: string } => {
    if (row.bucket === "unavailable") return reasonLabel(row.unavailabilityReason);
    if (occupiedByNight.get(night)?.has(row.roomId)) return { status: "reserved" };
    if (row.bucket === "deficient") return { status: "deficient" };
    return { status: "vacant" };
  };

  // A room is pickable for the whole stay only when every night is vacant/deficient (deficient
  // stays selectable — the acknowledgement is recorded on seal, same as the old picker).
  const pickable = (row: RoomStatusRow) =>
    row.bucket !== "unavailable" && nights.every((n) => !occupiedByNight.get(n)?.has(row.roomId));

  const anyExtBeds = rows.some((r) => r.extBeds != null);
  const vary = mode === "vary";

  return (
    <div className="rst-wrap">
      <table className="rst">
        <thead>
          <tr>
            <th>Room No</th>
            <th>Type</th>
            {anyExtBeds && <th style={{ textAlign: "center" }}>Ext. Beds</th>}
            {nights.map((n, i) => {
              const count = perNightSel?.[n]?.length ?? 0;
              return (
                <th key={n} style={{ textAlign: "center" }}>
                  {formatDMY(n) || n} <span style={{ fontWeight: 500 }}>({i + 1})</span>
                  {vary && (
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
            const sel = !vary && selectedIds.includes(row.roomId);
            const canPick = !vary && pickable(row);
            // Single-room mode never hits the cap: clicking another room SWITCHES to it
            // (the parent replaces the selection) instead of being blocked.
            const atCap = !sel && selectedIds.length >= maxSelect && maxSelect > 1;
            const rowClickable = canPick && !disabled && !atCap;
            const rowCls = sel ? "sel" : rowClickable ? "pick" : "dis";
            const title = vary
              ? `Room ${row.roomNumber} — pick nights in the columns`
              : !canPick
                ? `Room ${row.roomNumber} — not free for the whole stay`
                : atCap
                  ? "Selection limit reached — unselect another room first"
                  : `${sel ? "Unselect" : "Select"} room ${row.roomNumber}`;
            return (
              <tr
                key={row.roomId}
                className={vary ? "dis" : rowCls}
                title={title}
                onClick={() => !vary && (rowClickable || sel) && !disabled && onToggle(row)}
              >
                <td className="rst-no">
                  {sel && <Check style={{ width: 11, height: 11, marginRight: 4, verticalAlign: "-1px" }} />}
                  {row.roomNumber}
                </td>
                <td className="rst-type">{row.roomTypeName}</td>
                {anyExtBeds && <td className="rst-beds">{row.extBeds ?? "—"}</td>}
                {nights.map((n) => {
                  const { status, label } = cellStatus(row, n);
                  if (vary) {
                    const cellSel = (perNightSel?.[n] ?? []).includes(row.roomId);
                    const selectable = status === "vacant" || status === "deficient";
                    const nightFull = !cellSel && (perNightSel?.[n]?.length ?? 0) >= maxSelect;
                    return (
                      <td key={n} style={{ textAlign: "center" }}>
                        {selectable ? (
                          <button
                            type="button"
                            className={`rst-chip ${cellSel ? "sel" : status}`}
                            disabled={disabled || nightFull}
                            title={
                              cellSel
                                ? `Unassign room ${row.roomNumber} on ${formatDMY(n) || n}`
                                : nightFull
                                  ? "This night already has its rooms — unassign one first"
                                  : `Assign room ${row.roomNumber} on ${formatDMY(n) || n}`
                            }
                            onClick={() => onToggleCell?.(row, n)}
                          >
                            {cellSel ? "Selected" : label ?? CELL_LABEL[status]}
                          </button>
                        ) : (
                          <span className={`rst-chip ${status}`}>{label ?? CELL_LABEL[status]}</span>
                        )}
                      </td>
                    );
                  }
                  const cls = sel && status !== "reserved" && status !== "blocked" ? "sel" : status;
                  const text = sel && cls === "sel" ? "Selected" : label ?? CELL_LABEL[status];
                  return (
                    <td key={n} style={{ textAlign: "center" }}>
                      <span className={`rst-chip ${cls}`}>{text}</span>
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
