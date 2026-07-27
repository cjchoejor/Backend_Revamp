"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Layers, CalendarRange } from "lucide-react";
import { roomTypeShort } from "@/lib/desk/rooms";
import type { AvailabilityRoomResult, PerDateAvailabilityResult } from "@/lib/api/availability";

/** One candidate room, flattened from the availability result (available + deficient buckets). */
export type RoomMeta = {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName: string;
  isDeficient: boolean;
};

export type SealPayload = {
  /** Whole-stay pick — same rooms every night. */
  roomIds?: string[];
  /** Per-night pick — one room set per night (mid-stay room changes). */
  perNight?: Array<{ date: string; roomIds: string[] }>;
  /** Distinct deficient rooms among the picks — the parent turns these into acknowledgements. */
  deficientRoomIds: string[];
};

export function roomMetaFromResults(
  available: AvailabilityRoomResult[],
  deficient: AvailabilityRoomResult[],
): RoomMeta[] {
  const map = (r: AvailabilityRoomResult, isDeficient: boolean): RoomMeta => ({
    roomId: r.roomId,
    roomNumber: r.roomNumber ?? r.roomId.slice(0, 6),
    roomTypeId: r.roomTypeId ?? "__untyped__",
    roomTypeName: r.roomTypeName ?? (r.roomTypeId ? roomTypeShort(r.roomTypeId) : "Room"),
    isDeficient,
  });
  const seen = new Set<string>();
  const out: RoomMeta[] = [];
  for (const r of available) {
    if (r.roomId && !seen.has(r.roomId)) { seen.add(r.roomId); out.push(map(r, false)); }
  }
  for (const r of deficient) {
    if (r.roomId && !seen.has(r.roomId)) { seen.add(r.roomId); out.push(map(r, true)); }
  }
  return out;
}

function groupRooms(rooms: RoomMeta[]): Array<{ typeId: string; label: string; rooms: RoomMeta[] }> {
  const m = new Map<string, RoomMeta[]>();
  for (const r of rooms) {
    const list = m.get(r.roomTypeId);
    if (list) list.push(r);
    else m.set(r.roomTypeId, [r]);
  }
  return Array.from(m.entries()).map(([typeId, list]) => ({ typeId, label: list[0].roomTypeName, rooms: list }));
}

/**
 * Multi-room availability picker used when `entry.numberOfRooms > 1`. Two modes:
 *  - "same"    — pick exactly N rooms used for the whole stay (writes `roomIds`).
 *  - "perNight"— pick N rooms per night; different rooms allowed on different nights, i.e.
 *                mid-stay room changes (writes `perNight`). Only rooms actually free on a
 *                given night (from the engine's per-date breakdown) are offered for that night.
 *
 * Selection is driven purely by party size (numberOfRooms) — nothing here looks at the
 * source channel; a walk-in family and a travel agent see the same picker.
 */
export function MultiRoomSelect({
  numberOfRooms,
  candidateRooms,
  perDate,
  nights,
  onSeal,
  isSealing,
  sealedRoomIds,
}: {
  numberOfRooms: number;
  candidateRooms: RoomMeta[];
  perDate?: PerDateAvailabilityResult[];
  nights: string[];
  onSeal: (p: SealPayload) => void;
  isSealing: boolean;
  sealedRoomIds: string[];
}) {
  const [mode, setMode] = useState<"same" | "perNight">("same");
  const roomById = useMemo(() => new Map(candidateRooms.map((r) => [r.roomId, r])), [candidateRooms]);
  const hasPerDate = !!perDate && perDate.length > 0;

  // Rooms free on each night. Deficient rooms stay selectable (with an acknowledgement). When
  // the engine ran date-blind (no perDate), every candidate room is treated as free every night.
  const availByNight = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const allIds = new Set(candidateRooms.map((r) => r.roomId));
    for (const night of nights) {
      const pd = hasPerDate ? perDate!.find((p) => p.date === night) : undefined;
      if (pd) m.set(night, new Set([...pd.availableRoomIds, ...pd.deficientRoomIds]));
      else m.set(night, new Set(allIds));
    }
    return m;
  }, [perDate, hasPerDate, nights, candidateRooms]);

  // For "same" mode a room must be free on EVERY night (it's kept the whole stay).
  const freeAllNights = useMemo(
    () => new Set(candidateRooms.filter((r) => nights.every((n) => availByNight.get(n)?.has(r.roomId))).map((r) => r.roomId)),
    [candidateRooms, nights, availByNight],
  );

  // -------- same-rooms-whole-stay state --------
  const [sameSel, setSameSel] = useState<string[]>(() => sealedRoomIds.filter((id) => id).slice(0, numberOfRooms));
  const toggleSame = (roomId: string) =>
    setSameSel((prev) =>
      prev.includes(roomId)
        ? prev.filter((x) => x !== roomId)
        : prev.length < numberOfRooms
          ? [...prev, roomId]
          : prev,
    );
  const sameComplete = sameSel.length === numberOfRooms;

  // -------- different-rooms-per-night state --------
  const [byNight, setByNight] = useState<Record<string, string[]>>(() => {
    const seed: Record<string, string[]> = {};
    for (const n of nights) seed[n] = Array(numberOfRooms).fill("");
    return seed;
  });
  const setSlot = (date: string, i: number, roomId: string) =>
    setByNight((prev) => {
      const arr = [...(prev[date] ?? Array(numberOfRooms).fill(""))];
      arr[i] = roomId;
      return { ...prev, [date]: arr };
    });
  const prefillAllNights = () => {
    // Seed every night with the whole-stay picks (only where that room is free that night).
    setByNight(() => {
      const next: Record<string, string[]> = {};
      for (const n of nights) {
        const free = availByNight.get(n) ?? new Set<string>();
        next[n] = Array.from({ length: numberOfRooms }, (_, i) => {
          const candidate = sameSel[i];
          return candidate && free.has(candidate) ? candidate : "";
        });
      }
      return next;
    });
    setMode("perNight");
  };
  const nightComplete = (date: string) => {
    const arr = byNight[date] ?? [];
    return new Set(arr.filter(Boolean)).size === numberOfRooms;
  };
  const perNightComplete = nights.every(nightComplete);

  const sealSame = () => {
    const deficientRoomIds = sameSel.filter((id) => roomById.get(id)?.isDeficient);
    // Expand "same rooms whole stay" into a per-night payload (identical rooms each night) so
    // downstream arrival assignment has ONE uniform shape to consume — the backend folds the
    // identical consecutive nights back into a single full-range assignment per room. Falls
    // back to the whole-stay `roomIds` shape only when the entry has no dates to enumerate.
    if (nights.length === 0) {
      onSeal({ roomIds: sameSel, deficientRoomIds });
      return;
    }
    const perNight = nights.map((date) => ({ date, roomIds: [...sameSel] }));
    onSeal({ perNight, deficientRoomIds });
  };
  const sealPerNight = () => {
    const perNight = nights.map((d) => ({ date: d, roomIds: (byNight[d] ?? []).filter(Boolean) }));
    const allIds = new Set(perNight.flatMap((p) => p.roomIds));
    const deficientRoomIds = Array.from(allIds).filter((id) => roomById.get(id)?.isDeficient);
    onSeal({ perNight, deficientRoomIds });
  };

  const groups = useMemo(() => groupRooms(candidateRooms), [candidateRooms]);

  return (
    <div>
      {/* Mode switch */}
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={mode === "same" ? "on" : ""} onClick={() => setMode("same")}>
          <Layers style={{ width: 14, height: 14 }} />
          Same rooms every night
        </button>
        <button type="button" className={mode === "perNight" ? "on" : ""} onClick={() => setMode("perNight")}>
          <CalendarRange style={{ width: 14, height: 14 }} />
          Different rooms per night
        </button>
      </div>

      {mode === "same" ? (
        <>
          <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 9 }}>
            Pick <b>{numberOfRooms}</b> room{numberOfRooms === 1 ? "" : "s"} — used for the whole stay.{" "}
            <span style={{ color: sameComplete ? "var(--good, var(--terra))" : "var(--ink-3)", fontWeight: 600 }}>
              {sameSel.length} of {numberOfRooms} selected
            </span>
            {hasPerDate && (
              <span style={{ color: "var(--ink-3)" }}> · only rooms free on every night are shown</span>
            )}
          </div>
          {groups.map((grp) => {
            const selectable = grp.rooms.filter((r) => freeAllNights.has(r.roomId));
            const blocked = grp.rooms.filter((r) => !freeAllNights.has(r.roomId));
            if (selectable.length === 0 && blocked.length === 0) return null;
            return (
              <div key={grp.typeId} style={{ marginBottom: 11 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", margin: "0 0 6px" }}>{grp.label}</div>
                <div className="room-box-grid">
                  {selectable.map((r) => {
                    const sel = sameSel.includes(r.roomId);
                    const atCap = !sel && sameSel.length >= numberOfRooms;
                    return (
                      <button
                        key={r.roomId}
                        type="button"
                        className={`room-box pick${r.isDeficient ? " deficient" : ""}${sel ? " sel" : ""}`}
                        aria-pressed={sel}
                        disabled={isSealing || atCap}
                        title={`${r.isDeficient ? "Deficient — " : ""}Room ${r.roomNumber}${atCap ? " (limit reached)" : ""}`}
                        onClick={() => toggleSame(r.roomId)}
                      >
                        {sel && <Check style={{ width: 10, height: 10, marginRight: 2 }} />}
                        {r.roomNumber}
                      </button>
                    );
                  })}
                  {blocked.map((r) => (
                    <span
                      key={r.roomId}
                      className="room-box unavail"
                      title={`Room ${r.roomNumber} — not free on every night. Use "Different rooms per night".`}
                    >
                      {r.roomNumber}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={!sameComplete || isSealing} onClick={sealSame}>
              {isSealing ? "Sealing…" : `Seal ${numberOfRooms} room${numberOfRooms === 1 ? "" : "s"}`}
            </button>
            {sameSel.length > 0 && (
              <button className="btn btn-ghost btn-sm" disabled={isSealing} onClick={prefillAllNights}>
                Vary some nights →
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 4 }}>
            Assign <b>{numberOfRooms}</b> room{numberOfRooms === 1 ? "" : "s"} for each night. Rooms may differ
            night to night (a mid-stay room change).
          </div>
          {!hasPerDate && (
            <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "0 0 8px" }}>
              The availability engine returned no per-date breakdown, so every room is offered for every night.
              Conflicts are still re-checked on seal.
            </p>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            {nights.map((date, ni) => {
              const free = availByNight.get(date) ?? new Set<string>();
              const freeRooms = candidateRooms.filter((r) => free.has(r.roomId));
              const slots = byNight[date] ?? Array(numberOfRooms).fill("");
              const done = nightComplete(date);
              return (
                <div
                  key={date}
                  className="fact"
                  style={{ display: "block", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: "var(--r-md)" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      Night {ni + 1} · {date}
                    </span>
                    <span style={{ fontSize: 10.5, color: done ? "var(--terra)" : "var(--ink-3)", fontWeight: 600 }}>
                      {done ? "✓ complete" : `${slots.filter(Boolean).length}/${numberOfRooms}`} · {freeRooms.length} free
                    </span>
                  </div>
                  <div className="room-box-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                    {Array.from({ length: numberOfRooms }, (_, i) => {
                      const current = slots[i] ?? "";
                      const takenElsewhere = new Set(slots.filter((_, j) => j !== i).filter(Boolean));
                      return (
                        <select
                          key={i}
                          value={current}
                          disabled={isSealing}
                          onChange={(e) => setSlot(date, i, e.target.value)}
                          style={{ fontSize: 12 }}
                        >
                          <option value="">— room {i + 1} —</option>
                          {freeRooms
                            .filter((r) => r.roomId === current || !takenElsewhere.has(r.roomId))
                            .map((r) => (
                              <option key={r.roomId} value={r.roomId}>
                                {r.roomNumber} · {r.roomTypeName}
                                {r.isDeficient ? " (deficient)" : ""}
                              </option>
                            ))}
                        </select>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={!perNightComplete || isSealing} onClick={sealPerNight}>
              {isSealing ? "Sealing…" : "Seal per-night rooms"}
            </button>
            {sameSel.length === numberOfRooms && (
              <button className="btn btn-ghost btn-sm" disabled={isSealing} onClick={prefillAllNights}>
                Prefill all nights with whole-stay picks
              </button>
            )}
          </div>
        </>
      )}

      {candidateRooms.some((r) => r.isDeficient) && (
        <p style={{ fontSize: 11, color: "var(--warn)", margin: "10px 0 0", display: "inline-flex", gap: 5, alignItems: "center" }}>
          <AlertTriangle style={{ width: 12, height: 12 }} />
          Deficient rooms are selectable — an acknowledgement is recorded automatically when you seal.
        </p>
      )}
    </div>
  );
}
