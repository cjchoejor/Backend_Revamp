"use client";

/**
 * The Inquiry step's room choice, in one place (ported from the old desk's inquiry step, where it
 * had been unified on 2026-08-01): `base` is the rooms used on every night; `overrides` holds the
 * FULL room list of any night that deliberately differs. The house card's "Take it", the room
 * table and the guest board all write this one selection, and one save sends it.
 *
 * The rules kept from the old desk, each one a bug it had once:
 *  - a row click means "the whole stay" and is capped per night, not by the base's length;
 *  - a night cell copies the base on first edit, and an override equal to the base is dropped;
 *  - an empty base is not an empty selection (a partly-free room lives only in the overrides);
 *  - a lowered room count trims the picks and says so;
 *  - "saved" is decided by comparing the picks with what the server holds, never by a flag.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { RoomStatusRow, SelectAllOutcome } from "@/components/desk/workspace/room-status-table";
import type { AvailabilityOptionSelected } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";
import { fmtDay, plural } from "@/lib/ds/format";

export type NightPick = { date: string; roomIds: string[] };

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export const canonNights = (pn: NightPick[]) =>
  pn
    .map((p) => `${String(p.date).slice(0, 10)}=${[...p.roomIds].sort().join(",")}`)
    .sort()
    .join("|");

/** ISO dates of every night of a stay (check-in inclusive, check-out exclusive), UTC-safe. */
export function enumerateNights(checkIn?: string | null, checkOut?: string | null): string[] {
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

export function useRoomSelection({
  entryId,
  numberOfRooms,
  savedOption,
  displayNights,
  stayNights,
}: {
  entryId: string;
  numberOfRooms: number;
  savedOption: AvailabilityOptionSelected | null | undefined;
  displayNights: string[];
  stayNights: string[];
}) {
  const seed = (): { base: string[]; overrides: Record<string, string[]> } => {
    const opt = savedOption;
    if (opt && "perNight" in opt && Array.isArray(opt.perNight) && opt.perNight.length > 0) {
      const perNight = opt.perNight.map((p) => ({ date: String(p.date).slice(0, 10), roomIds: p.roomIds.map((r) => r.roomId) }));
      const base = perNight[0].roomIds.filter((id) => perNight.every((p) => p.roomIds.includes(id))).slice(0, numberOfRooms);
      const overrides: Record<string, string[]> = {};
      for (const p of perNight) if (!sameSet(p.roomIds, base)) overrides[p.date] = [...p.roomIds];
      return { base, overrides };
    }
    return { base: optionSelectedRoomIds(opt).filter(Boolean).slice(0, numberOfRooms), overrides: {} };
  };
  const [base, setBase] = useState<string[]>(() => seed().base);
  const [overrides, setOverrides] = useState<Record<string, string[]>>(() => seed().overrides);

  // In-progress picks survive leaving the booking (same key as the old desk, so nothing is lost).
  const storeKey = `desk:rst-sel:${entryId}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storeKey);
      if (!raw) return;
      const v = JSON.parse(raw) as { base?: string[]; overrides?: Record<string, string[]>; tableSel?: string[]; varySel?: Record<string, string[]> };
      const rawBase = Array.isArray(v.base) ? v.base : Array.isArray(v.tableSel) ? v.tableSel : [];
      const clean = rawBase.filter((x) => typeof x === "string").slice(0, numberOfRooms);
      const rawOv = v.overrides ?? v.varySel;
      const ov: Record<string, string[]> = {};
      if (rawOv && typeof rawOv === "object") {
        for (const [night, ids] of Object.entries(rawOv)) {
          if (Array.isArray(ids) && !sameSet(ids, clean)) ov[night] = ids.filter((x) => typeof x === "string").slice(0, numberOfRooms);
        }
      }
      if (clean.length === 0 && Object.keys(ov).length === 0) return;
      setBase(clean);
      setOverrides(ov);
    } catch {
      /* private mode or a corrupt value — the saved selection stands */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]);
  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ base, overrides }));
    } catch {
      /* non-fatal */
    }
  }, [storeKey, base, overrides]);

  // A lowered room count trims the picks rather than leaving "3 of 2" standing.
  useEffect(() => {
    const over = base.length > numberOfRooms || Object.values(overrides).some((ids) => ids.length > numberOfRooms);
    if (!over) return;
    setBase((p) => (p.length > numberOfRooms ? p.slice(0, numberOfRooms) : p));
    setOverrides((p) => Object.fromEntries(Object.entries(p).map(([n, ids]) => [n, ids.length > numberOfRooms ? ids.slice(0, numberOfRooms) : ids])));
    toast.info(`This booking now needs ${plural(numberOfRooms, "room")} — the extra picks were dropped. Check them before saving.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numberOfRooms]);

  const effectiveNight = (n: string): string[] => overrides[n] ?? base;
  const effectiveByNight = useMemo(() => Object.fromEntries(displayNights.map((n) => [n, overrides[n] ?? base])), [displayNights, overrides, base]);
  const differingNights = useMemo(
    () => displayNights.filter((n) => overrides[n] != null && !sameSet(overrides[n], base)),
    [displayNights, overrides, base],
  );
  const nightsDiffer = differingNights.length > 0;

  const toggleRow = (row: RoomStatusRow) => {
    const id = row.roomId;
    const onEveryNight = displayNights.length > 0 ? displayNights.every((n) => effectiveNight(n).includes(id)) : base.includes(id);
    const inertInBase = base.includes(id) && displayNights.length > 0 && !displayNights.some((n) => effectiveNight(n).includes(id));
    if (onEveryNight || inertInBase) {
      setBase((p) => p.filter((x) => x !== id));
      setOverrides((p) => Object.fromEntries(Object.entries(p).map(([n, ids]) => [n, ids.filter((x) => x !== id)])));
      return;
    }
    if (numberOfRooms === 1) {
      setBase([id]);
      setOverrides({});
      return;
    }
    const full = displayNights.filter((n) => !effectiveNight(n).includes(id) && effectiveNight(n).length >= numberOfRooms);
    if (full.length > 0) {
      toast.info(
        `${full.length === displayNights.length ? "Every night" : full.map((n) => fmtDay(n)).join(", ")} already ${full.length === 1 ? "has" : "have"} ${plural(numberOfRooms, "room")} — free one on ${full.length === 1 ? "that night" : "those nights"} first, or change just the nights this room is for.`,
      );
      return;
    }
    setBase((p) => (p.includes(id) || p.length >= numberOfRooms ? p : [...p, id]));
    setOverrides((p) => Object.fromEntries(Object.entries(p).map(([n, ids]) => [n, ids.includes(id) ? ids : [...ids, id]])));
  };

  const toggleCell = (row: RoomStatusRow, night: string) => {
    setOverrides((p) => {
      const cur = p[night] ?? base;
      const next = cur.includes(row.roomId)
        ? cur.filter((x) => x !== row.roomId)
        : numberOfRooms === 1
          ? [row.roomId]
          : cur.length < numberOfRooms
            ? [...cur, row.roomId]
            : cur;
      if (next === cur) return p;
      const out = { ...p };
      if (sameSet(next, base)) delete out[night];
      else out[night] = next;
      return out;
    });
  };

  /** Says out loud what a room's "Select all" could not take — the dates, and who holds them. */
  const reportSelectAll = (row: RoomStatusRow, outcome: SelectAllOutcome) => {
    const gaps = [
      ...outcome.blocked.map((b) => `${fmtDay(b.date)} — ${b.status === "held" ? "held" : b.status === "blocked" ? "out of service" : "reserved"}${b.holder ? ` (${b.holder})` : ""}`),
      ...outcome.full.map((d) => `${fmtDay(d)} — that night already has its ${plural(numberOfRooms, "room")}`),
    ];
    if (gaps.length === 0) {
      toast.success(`Room ${row.roomNumber} taken on all ${plural(outcome.picked.length, "night")}.`);
      return;
    }
    toast.warning(
      outcome.picked.length > 0
        ? `Room ${row.roomNumber} taken on ${outcome.picked.length} of ${plural(displayNights.length, "night")}.`
        : `Room ${row.roomNumber} is not free on any night of this stay.`,
      { description: `Not available: ${gaps.join(" · ")}`, duration: 9000 },
    );
  };

  /** Replace the whole choice at once — "Take it". */
  const setWholeStay = (ids: string[]) => {
    setBase(ids.slice(0, numberOfRooms));
    setOverrides({});
  };

  /** What a save sends right now. Uniform stays expand over the booking's own nights. */
  const payload = (): { perNight?: NightPick[]; roomIds?: string[]; allIds: string[] } => {
    if (nightsDiffer) {
      const perNight = displayNights.map((date) => ({ date, roomIds: [...effectiveNight(date)] }));
      return { perNight, allIds: [...new Set(perNight.flatMap((p) => p.roomIds))] };
    }
    if (stayNights.length === 0) return { roomIds: base, allIds: base };
    return { perNight: stayNights.map((date) => ({ date, roomIds: [...base] })), allIds: base };
  };

  const nightsReady = displayNights.filter((n) => effectiveNight(n).length === numberOfRooms).length;
  const ready = nightsDiffer ? displayNights.length > 0 && nightsReady === displayNights.length : base.length === numberOfRooms;

  const savedCanon = useMemo(() => {
    const opt = savedOption;
    if (!opt) return null;
    if ("perNight" in opt && Array.isArray(opt.perNight)) {
      return canonNights(opt.perNight.map((p) => ({ date: p.date, roomIds: p.roomIds.map((r) => r.roomId) })));
    }
    const ids = optionSelectedRoomIds(opt);
    if (ids.length === 0) return null;
    return stayNights.length > 0 ? canonNights(stayNights.map((date) => ({ date, roomIds: ids }))) : `*=${[...ids].sort().join(",")}`;
  }, [savedOption, stayNights]);
  const currentCanon = useMemo(() => {
    if (nightsDiffer) return canonNights(displayNights.map((date) => ({ date, roomIds: overrides[date] ?? base })));
    if (base.length === 0) return null;
    return stayNights.length > 0 ? canonNights(stayNights.map((date) => ({ date, roomIds: base }))) : `*=${[...base].sort().join(",")}`;
  }, [nightsDiffer, overrides, displayNights, base, stayNights]);
  const submittedRef = useRef<string | null>(null);

  const allPicked = useMemo(() => [...new Set([...base, ...Object.values(overrides).flat()])], [base, overrides]);

  return {
    base,
    setBase,
    overrides,
    setOverrides,
    effectiveByNight,
    differingNights,
    nightsDiffer,
    toggleRow,
    toggleCell,
    reportSelectAll,
    setWholeStay,
    payload,
    nightsReady,
    ready,
    savedCanon,
    currentCanon,
    submittedRef,
    allPicked,
    resetNights: () => setOverrides({}),
    sameSet,
  };
}
