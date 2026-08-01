"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, Undo2, Wand2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listRooms } from "@/lib/api/rooms";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import { RoomCompositionsTable } from "./room-compositions-table";
import { RateReferenceStrip } from "./rate-reference-strip";

/**
 * Guest-board composition planner (2026-07-28) — the people-first replacement for the
 * counts-first grid on the S2 quote step.
 *
 * The booking party from intake (adults + per-child ages) is rendered as one chip per
 * GUEST; sealed rooms are bins. The operator moves people, not numbers:
 *   - tap chips to multi-select, then tap "Place here" on a room — or drag-and-drop;
 *   - with a selection active, a plan bar appears: one tap puts everyone selected on
 *     CP / MAP / AP; a tiny per-chip dropdown handles one-off plans;
 *   - every count the backend needs (occupants, adult / CNB bands, mealPlan*Count
 *     tallies) is DERIVED from chip placement, so the Policy-79 consistency rules hold
 *     by construction — no clamp warnings, no mental arithmetic.
 *
 * Room-level extras (extra beds, SC / GST / FOC, Others à-la-carte pax, negotiated
 * rates) stay as a compact per-room footer, same fields as the counts grid.
 *
 * `RoomCompositionPlanner` is the export the quote step mounts: it defaults to the
 * board whenever the entry carries a party breakdown, and offers the legacy
 * `RoomCompositionsEditor` counts grid as a fallback mode — needed when intake never
 * captured adults/children, or when the quoted occupancy legitimately differs from
 * the intake party. Only the ACTIVE mode is mounted (both auto-emit on mount; keeping
 * both alive would race the parent's single `roomCompositions` state).
 *
 * Age-band cutoffs come from GET /api/lookups/child-policy (admin-editable). CNB 11+
 * is retired (2026-07-28): a declared child above the child band joins the adult pool.
 * NO MONEY IS COMPUTED HERE — the backend prices when the draft is created.
 */

type PlanPick = "NONE" | "CP" | "MAPL" | "MAPD" | "AP" | "OTHERS";

const PLAN_LABEL: Record<PlanPick, string> = {
  NONE: "None (EP)",
  CP: "CP · breakfast",
  MAPL: "MAP · +lunch",
  MAPD: "MAP · +dinner",
  AP: "AP · all meals",
  OTHERS: "Others",
};

/** Short form for the plan bar buttons + chip badge. */
const PLAN_SHORT: Record<PlanPick, string> = {
  NONE: "EP",
  CP: "CP",
  MAPL: "MAP+L",
  MAPD: "MAP+D",
  AP: "AP",
  OTHERS: "Oth",
};

const PLAN_ORDER: PlanPick[] = ["NONE", "CP", "MAPL", "MAPD", "AP", "OTHERS"];

type Band = "ADULT" | "C6TO10" | "UNDER6";

type Guest = {
  /** Stable key — independent of the async policy cutoffs so placements survive the
   *  child-policy lookup resolving after first paint. */
  key: string;
  band: Band;
  label: string;
};

/** Normalise an entry date to a midnight-UTC ISO string (entry dates arrive as full
 *  ISO timestamps; slicing the day out first avoids invalid-date throws). */
function dayToIso(v?: string | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v.slice(0, 10) + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function num(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The stay-nights as YYYY-MM-DD keys — check-in inclusive, check-out exclusive (the guest
 * doesn't eat a booked dinner on the night they've left). This is the set the per-night plan
 * picker offers, so a plan can never be pinned outside the dates the guest chose; the backend
 * re-checks it (`enforceNightOverridesWithinStay`) rather than trusting the picker.
 */
function stayNights(checkIn?: string | null, checkOut?: string | null): string[] {
  if (!checkIn || !checkOut) return [];
  const a = new Date(checkIn.slice(0, 10) + "T00:00:00.000Z").getTime();
  const b = new Date(checkOut.slice(0, 10) + "T00:00:00.000Z").getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return [];
  const out: string[] = [];
  for (let t = a; t < b; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  // Guard against a runaway range (bad data) rendering thousands of chips.
  return out.slice(0, 370);
}

/** "Tue 12 Aug" — compact enough for a chip, unambiguous across month boundaries. */
function nightLabel(key: string): string {
  const d = new Date(key + "T00:00:00.000Z");
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

type RoomExtras = {
  extraBed: string;
  sc: boolean;
  gst: boolean;
  foc: boolean;
  othersB: string;
  othersL: string;
  othersD: string;
  rateRoom: string;
  rateBed: string;
  rateBf: string;
  rateLu: string;
  rateDi: string;
  ratesOpen: boolean;
};

const EMPTY_EXTRAS: RoomExtras = {
  extraBed: "0",
  sc: true,
  gst: true,
  foc: false,
  othersB: "",
  othersL: "",
  othersD: "",
  rateRoom: "",
  rateBed: "",
  rateBf: "",
  rateLu: "",
  rateDi: "",
  ratesOpen: false,
};

/** Rebuild a room's extras from an emitted composition — used when the planner hands the
 *  board the table's last snapshot so a mode switch resumes, not resets. */
function extrasFromComposition(c: RoomCompositionInput): RoomExtras {
  const s = (v: number | undefined | null): string => (v == null ? "" : String(v));
  const anyRate = [c.negotiatedRoomRate, c.negotiatedExtraBedRate, c.negotiatedBreakfastRate, c.negotiatedLunchRate, c.negotiatedDinnerRate].some((v) => v != null);
  return {
    extraBed: String(c.extraBedCount ?? 0),
    sc: c.serviceChargeApplies ?? true,
    gst: c.gstApplies ?? true,
    foc: c.isFoc ?? false,
    othersB: s(c.othersBreakfastPax),
    othersL: s(c.othersLunchPax),
    othersD: s(c.othersDinnerPax),
    rateRoom: s(c.negotiatedRoomRate),
    rateBed: s(c.negotiatedExtraBedRate),
    rateBf: s(c.negotiatedBreakfastRate),
    rateLu: s(c.negotiatedLunchRate),
    rateDi: s(c.negotiatedDinnerRate),
    ratesOpen: anyRate,
  };
}

export function RoomCompositionsBoard({
  sealedRoomIds,
  entryCheckIn,
  entryCheckOut,
  entryAdults,
  entryChildAges,
  initial,
  onChange,
  focusRoomId,
  onFocusRoom,
}: {
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  /** Snapshot from the other planner mode — mount-time seed so switching modes resumes
   *  from the same data. Read once on mount; later prop changes are ignored. */
  initial?: RoomCompositionInput[];
  onChange: (compositions: RoomCompositionInput[]) => void;
  /**
   * Show only this room's bin. null = every sealed room (the original behaviour).
   *
   * DISPLAY ONLY — every sealed room is still emitted, still holds its guests, and still
   * prices. Filtering the emission instead would silently drop the unfocused rooms from the
   * quotation, which is the one thing this must never do.
   */
  focusRoomId?: string | null;
  onFocusRoom?: (roomId: string | null) => void;
}) {
  const { session } = useSession();
  const roomsQuery = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const roomById = new Map((roomsQuery.data?.items ?? []).map((r) => [r.id, r]));

  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const youngMax = policyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policyQuery.data?.ageBands.childMaxAge ?? 10;

  // Same backend capacity envelope the S1 rooms inputs use — surfaces "this party can't
  // fit in the sealed room count" up front, because the fix is back in Inquiry.
  const envAdults = Math.max(0, entryAdults ?? 0);
  const roomEnvelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", envAdults, (entryChildAges ?? []).join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: envAdults, childAges: entryChildAges ?? [] }),
    enabled: !!session && envAdults > 0,
  });
  const roomMin = roomEnvelopeQuery.data?.allowedRoomCounts.min ?? null;

  // The party as individual guests. Child keys are positional (`K3`) rather than
  // band-derived so a placement survives the policy cutoffs arriving and re-banding
  // a child; only the label/band swap, never the key.
  const guests: Guest[] = useMemo(() => {
    const out: Guest[] = [];
    for (let i = 0; i < Math.max(0, entryAdults ?? 0); i++) {
      out.push({ key: `A${i}`, band: "ADULT", label: `Adult ${i + 1}` });
    }
    (entryChildAges ?? []).forEach((age, i) => {
      const band: Band = age <= youngMax ? "UNDER6" : age <= childMax ? "C6TO10" : "ADULT";
      out.push({
        key: `K${i}`,
        band,
        label: band === "ADULT" ? `Guest · ${age}y` : band === "C6TO10" ? `Child · ${age}y` : `Infant · ${age}y`,
      });
    });
    return out;
  }, [entryAdults, entryChildAges, youngMax, childMax]);
  const guestByKey = new Map(guests.map((g) => [g.key, g]));
  /** Chargeable = consumes a capacity slot. Children under 11 share bedding (backend rule —
   *  `computeChargeableOccupants` / the OVER_MAX_OCCUPANCY check exclude them). */
  const isChargeable = (key: string) => guestByKey.get(key)?.band === "ADULT";
  const chargeableIn = (roomId: string) =>
    guests.filter((g) => assign[g.key] === roomId && g.band === "ADULT").length;
  /** The nights the guest actually booked — the only dates a per-night plan may target. */
  const nights = useMemo(() => stayNights(entryCheckIn, entryCheckOut), [entryCheckIn, entryCheckOut]);

  // Mount-time copy of the seed snapshot — deliberately not reactive.
  const initialRef = useRef(initial);
  // guestKey → roomId; missing/"" = unplaced tray.
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<Record<string, PlanPick>>({});
  /**
   * Per-night plan overrides: nightKey → guestKey → plan. A guest with no entry for a night
   * eats on their stay-wide `plans` choice. Keyed by night first because that's how the
   * operator thinks ("what's happening on the 14th?") and how it's emitted.
   */
  const [nightPlans, setNightPlans] = useState<Record<string, Record<string, PlanPick>>>({});
  /** Which night the plan buttons currently write to. null = the whole stay (the default). */
  const [scopeNight, setScopeNight] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<Record<string, RoomExtras>>({});
  // Drop-target highlight while dragging: roomId or "tray".
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Set when the seed counted more people than the intake party has chips for — the
  // board is party-bound, so the overflow can't be represented and gets dropped.
  const [seedShortfall, setSeedShortfall] = useState(false);
  // Transient refused-placement notice (room at its occupancy ceiling).
  const [capMsg, setCapMsg] = useState<string | null>(null);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCap = (msg: string) => {
    setCapMsg(msg);
    if (capTimer.current) clearTimeout(capTimer.current);
    capTimer.current = setTimeout(() => setCapMsg(null), 5000);
  };

  /** The most a room may hold RIGHT NOW: catalog capacity + the extra beds currently set on the
   *  bin. null = capacity unknown (never blocks). Adding a bed below raises it immediately. */
  const ceilingOf = (roomId: string): number | null => {
    const room = roomById.get(roomId);
    const cap = room?.roomType?.maxCapacity ?? room?.roomType?.standardCapacity;
    if (cap == null) return null;
    return cap + (num((extras[roomId] ?? EMPTY_EXTRAS).extraBed) ?? 0);
  };

  useEffect(() => {
    setExtras((prev) => {
      if (sealedRoomIds.every((id) => prev[id])) return prev;
      const seedById = new Map((initialRef.current ?? []).map((c) => [c.roomId, c]));
      const next = { ...prev };
      for (const id of sealedRoomIds) {
        if (!next[id]) {
          const seed = seedById.get(id);
          next[id] = seed ? extrasFromComposition(seed) : { ...EMPTY_EXTRAS };
        }
      }
      return next;
    });
  }, [sealedRoomIds]);

  /** Spread the party, capacity-aware: children go to the earliest room with space (family
   *  stays together while it fits), adults then fill the least-loaded room with space. The
   *  ceiling includes each bin's current extra beds. Whoever doesn't fit stays in the tray —
   *  the tally says so honestly instead of overfilling a bin the placement guard would refuse.
   *  A starting point — every chip stays movable. */
  const autoAssign = () => {
    if (sealedRoomIds.length === 0) return;
    // Load counts CHARGEABLE guests only — children share bedding and consume no slot, so
    // they sit with the first room (family together) without affecting where adults fit.
    const load = new Map<string, number>(sealedRoomIds.map((id) => [id, 0]));
    const fits = (id: string) => {
      const ceiling = ceilingOf(id);
      return ceiling == null || (load.get(id) ?? 0) < ceiling;
    };
    const next: Record<string, string> = {};
    for (const g of guests.filter((x) => x.band !== "ADULT")) {
      next[g.key] = sealedRoomIds[0];
    }
    for (const g of guests.filter((x) => x.band === "ADULT")) {
      const open = sealedRoomIds.filter(fits);
      if (open.length === 0) continue;
      const id = open.reduce((a, b) => ((load.get(b) ?? 0) < (load.get(a) ?? 0) ? b : a));
      next[g.key] = id;
      load.set(id, (load.get(id) ?? 0) + 1);
    }
    setAssign(next);
  };

  /**
   * Rebuild placement + plans from the other mode's snapshot. Counts don't say WHICH
   * same-band guest sits where, so chips are seated deterministically (pool order per
   * band) — interchangeable for pricing, though a specific child's room may swap.
   * Plans fill each room's guests in seat order until the tallies are spent. Rooms the
   * seed counted fuller than the party allows set `seedShortfall` (overflow dropped).
   */
  const deriveFromSeed = (comps: RoomCompositionInput[]) => {
    const pool: Record<Band, string[]> = {
      ADULT: guests.filter((g) => g.band === "ADULT").map((g) => g.key),
      C6TO10: guests.filter((g) => g.band === "C6TO10").map((g) => g.key),
      UNDER6: guests.filter((g) => g.band === "UNDER6").map((g) => g.key),
    };
    const nextAssign: Record<string, string> = {};
    const nextPlans: Record<string, PlanPick> = {};
    const nextNightPlans: Record<string, Record<string, PlanPick>> = {};
    let short = false;
    for (const id of sealedRoomIds) {
      const c = comps.find((x) => x.roomId === id);
      if (!c) continue;
      const seated: string[] = [];
      const take = (band: Band, n: number) => {
        for (let i = 0; i < n; i++) {
          const key = pool[band].shift();
          if (!key) {
            short = true;
            return;
          }
          nextAssign[key] = id;
          seated.push(key);
        }
      };
      take("ADULT", c.adultCount ?? 0);
      take("C6TO10", c.cnb6To10Count ?? 0);
      take("UNDER6", c.cnbUnder6Count ?? 0);
      let seat = 0;
      const planCounts: Array<[PlanPick, number]> = [
        ["CP", c.mealPlanCpCount ?? 0],
        ["MAPL", c.mealPlanMaplCount ?? 0],
        ["MAPD", c.mealPlanMapdCount ?? 0],
        ["AP", c.mealPlanApCount ?? 0],
        ["OTHERS", c.mealPlanOthersCount ?? 0],
      ];
      for (const [plan, n] of planCounts) {
        for (let i = 0; i < n && seat < seated.length; i++) nextPlans[seated[seat++]] = plan;
      }

      // Same derivation for any per-night overrides the seed carries (a board → table → board
      // round trip). Seated in the same order, so a night that matches the room default
      // produces no override on the next emit rather than a redundant one.
      for (const o of c.nightMealOverrides ?? []) {
        const key = String(o.date).slice(0, 10);
        if (!key) continue;
        const forNight: Record<string, PlanPick> = { ...(nextNightPlans[key] ?? {}) };
        let nSeat = 0;
        const nightCounts: Array<[PlanPick, number]> = [
          ["CP", o.mealPlanCpCount ?? 0],
          ["MAPL", o.mealPlanMaplCount ?? 0],
          ["MAPD", o.mealPlanMapdCount ?? 0],
          ["AP", o.mealPlanApCount ?? 0],
          ["OTHERS", o.mealPlanOthersCount ?? 0],
        ];
        for (const [plan, n] of nightCounts) {
          for (let i = 0; i < n && nSeat < seated.length; i++) forNight[seated[nSeat++]] = plan;
        }
        // Everyone else in the room that night sits on EP.
        while (nSeat < seated.length) forNight[seated[nSeat++]] = "NONE";
        nextNightPlans[key] = forNight;
      }
    }
    // Drop nights whose derived plans match the stay-wide ones — they aren't exceptions.
    for (const [night, byGuest] of Object.entries(nextNightPlans)) {
      const differs = Object.entries(byGuest).some(([k, p]) => p !== (nextPlans[k] ?? "NONE"));
      if (!differs) delete nextNightPlans[night];
    }
    setAssign(nextAssign);
    setPlans(nextPlans);
    setNightPlans(nextNightPlans);
    setSeedShortfall(short);
  };

  // First open, once: resume from the other mode's snapshot when it carries people,
  // otherwise auto-assign a sensible split. Ref-guarded against re-renders. Waits for the
  // rooms catalog — auto-assigning before the capacities load would spread blind and could
  // overfill a room the placement guard would then have refused.
  const roomsSettled = roomsQuery.isSuccess || roomsQuery.isError;
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current || sealedRoomIds.length === 0 || guests.length === 0 || !roomsSettled) return;
    if (Object.keys(assign).length > 0) {
      autoRanRef.current = true;
      return;
    }
    autoRanRef.current = true;
    const seed = initialRef.current ?? [];
    const seedHasPeople = seed.some(
      (c) => (c.adultCount ?? 0) + (c.cnb6To10Count ?? 0) + (c.cnbUnder6Count ?? 0) > 0,
    );
    if (seedHasPeople) deriveFromSeed(seed);
    else autoAssign();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sealedRoomIds, guests.length, roomsSettled]);

  // Derive + emit the backend composition rows whenever the board changes. Counts are
  // tallied from chip placement, so adults + bands always equals occupants and plan pax
  // never exceeds occupants (Policy 79 by construction).
  useEffect(() => {
    const out: RoomCompositionInput[] = sealedRoomIds.map((id) => {
      const here = guests.filter((g) => assign[g.key] === id);
      const x = extras[id] ?? EMPTY_EXTRAS;
      const tallyFor = (planOf: (key: string) => PlanPick): Record<PlanPick, number> => {
        const t: Record<PlanPick, number> = { NONE: 0, CP: 0, MAPL: 0, MAPD: 0, AP: 0, OTHERS: 0 };
        for (const g of here) t[planOf(g.key)] += 1;
        return t;
      };
      const tally = tallyFor((k) => plans[k] ?? "NONE");

      // A night is emitted as an override only when a guest IN THIS ROOM has one — otherwise
      // the room-level distribution already describes it, and sending a redundant row would
      // make the backend price the same numbers by a longer path.
      const nightMealOverrides = nights
        .filter((n) => here.some((g) => nightPlans[n]?.[g.key] != null))
        .map((n) => {
          // The override REPLACES the night, so it carries every guest in the room — those
          // without a night-specific pick fall back to their stay-wide plan.
          const t = tallyFor((k) => nightPlans[n]?.[k] ?? plans[k] ?? "NONE");
          const othersHere = t.OTHERS;
          return {
            date: new Date(n + "T00:00:00.000Z").toISOString(),
            mealPlanCpCount: t.CP,
            mealPlanMaplCount: t.MAPL,
            mealPlanMapdCount: t.MAPD,
            mealPlanApCount: t.AP,
            mealPlanOthersCount: othersHere,
            // Room-level à-la-carte pax only make sense while someone is on OTHERS that night.
            othersBreakfastPax: othersHere > 0 ? num(x.othersB) : 0,
            othersLunchPax: othersHere > 0 ? num(x.othersL) : 0,
            othersDinnerPax: othersHere > 0 ? num(x.othersD) : 0,
          };
        });

      return {
        roomId: id,
        startDate: dayToIso(entryCheckIn),
        endDate: dayToIso(entryCheckOut),
        ...(nightMealOverrides.length > 0 ? { nightMealOverrides } : {}),
        occupantCount: here.length,
        adultCount: here.filter((g) => g.band === "ADULT").length,
        cnb6To10Count: here.filter((g) => g.band === "C6TO10").length,
        cnbUnder6Count: here.filter((g) => g.band === "UNDER6").length,
        extraBedCount: num(x.extraBed) ?? 0,
        mealPlanCpCount: tally.CP,
        mealPlanMaplCount: tally.MAPL,
        mealPlanMapdCount: tally.MAPD,
        mealPlanApCount: tally.AP,
        mealPlanOthersCount: tally.OTHERS,
        othersBreakfastPax: num(x.othersB),
        othersLunchPax: num(x.othersL),
        othersDinnerPax: num(x.othersD),
        negotiatedRoomRate: num(x.rateRoom),
        negotiatedExtraBedRate: num(x.rateBed),
        negotiatedBreakfastRate: num(x.rateBf),
        negotiatedLunchRate: num(x.rateLu),
        negotiatedDinnerRate: num(x.rateDi),
        serviceChargeApplies: x.sc,
        // GST is statutory — always applied regardless of any historic seed value.
        gstApplies: true,
        isFoc: x.foc,
      };
    });
    onChange(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assign, plans, nightPlans, nights, extras, sealedRoomIds, guests, entryCheckIn, entryCheckOut]);

  const setExtra = (roomId: string, patch: Partial<RoomExtras>) =>
    setExtras((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? EMPTY_EXTRAS), ...patch } }));

  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Move chips. Interactive placement is hard-blocked at the room's occupancy ceiling
   *  (capacity + extra beds) — a drop that doesn't fully fit is refused whole rather than
   *  silently placing part of the selection. Seed derivation (`deriveFromSeed`) is deliberately
   *  NOT guarded: a table→board round trip must reproduce the table's counts faithfully, and
   *  the over-capacity warning on the bin flags them instead. */
  const placeKeys = (keys: string[], roomId: string | null) => {
    if (roomId) {
      const ceiling = ceilingOf(roomId);
      if (ceiling != null) {
        // Capacity counts CHARGEABLE guests only — children under 11 share bedding and
        // consume no slot (mirrors the backend's OVER_MAX_OCCUPANCY rule), so placing a
        // child succeeds even in a room that is adult-full.
        const current = chargeableIn(roomId);
        const incoming = keys.filter((k) => assign[k] !== roomId && isChargeable(k)).length;
        if (current + incoming > ceiling) {
          const room = roomById.get(roomId);
          const spots = Math.max(0, ceiling - current);
          flashCap(
            `Room ${room?.roomNumber ?? ""} fits ${ceiling} adult-rate guests right now — ${
              spots === 0 ? "it's full" : `only space for ${spots} more`
            }. Add an extra bed on the room, or move someone out (children under ${childMax + 1} don't take a slot).`,
          );
          return;
        }
      }
    }
    setAssign((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        if (roomId) next[k] = roomId;
        else delete next[k];
      }
      return next;
    });
  };

  /** Place the current selection (tap flow) and keep it selected so a plan can be
   *  applied right after — the two most common actions chain without re-picking. */
  const placeSelection = (roomId: string | null) => {
    if (selected.size === 0) return;
    placeKeys([...selected], roomId);
  };

  /**
   * Apply a plan to the current selection, at the current date scope. Whole-stay writes the
   * guest's default; a specific night writes an override for that night only, leaving every
   * other night on the default. Setting a night's plan back to the default clears the
   * override rather than storing a redundant one.
   */
  const applyPlanToSelection = (plan: PlanPick) => {
    if (selected.size === 0) return;
    if (scopeNight == null) {
      setPlans((prev) => {
        const next = { ...prev };
        for (const k of selected) next[k] = plan;
        return next;
      });
      return;
    }
    setNightPlans((prev) => {
      const forNight = { ...(prev[scopeNight] ?? {}) };
      for (const k of selected) {
        if ((plans[k] ?? "NONE") === plan) delete forNight[k];
        else forNight[k] = plan;
      }
      const next = { ...prev };
      if (Object.keys(forNight).length === 0) delete next[scopeNight];
      else next[scopeNight] = forNight;
      return next;
    });
  };

  /** Drop every per-night override for one night, returning it to the stay-wide plans. */
  const clearNight = (night: string) =>
    setNightPlans((prev) => {
      if (!prev[night]) return prev;
      const next = { ...prev };
      delete next[night];
      return next;
    });

  /** Nights carrying at least one override, in stay order — drives the summary strip. */
  const overriddenNights = nights.filter((n) => Object.keys(nightPlans[n] ?? {}).length > 0);

  /** The plan in force for a guest at the current scope — what the chip should show. */
  const planInScope = (key: string): PlanPick =>
    (scopeNight != null ? nightPlans[scopeNight]?.[key] : undefined) ?? plans[key] ?? "NONE";

  // Drag carries the dragged chip — or the whole selection when the chip is part of it.
  const dragKeysRef = useRef<string[]>([]);
  const onChipDragStart = (key: string) => (e: React.DragEvent) => {
    const keys = selected.has(key) ? [...selected] : [key];
    dragKeysRef.current = keys;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", keys.join(","));
  };
  const onZoneDrop = (roomId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const keys = dragKeysRef.current.length
      ? dragKeysRef.current
      : (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
    dragKeysRef.current = [];
    if (keys.length) placeKeys(keys, roomId);
  };
  const zoneDragProps = (zone: string, roomId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver(zone);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Only clear when actually leaving the zone, not moving between its children.
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOver(null);
    },
    onDrop: onZoneDrop(roomId),
  });

  const unplaced = guests.filter((g) => !assign[g.key] || !sealedRoomIds.includes(assign[g.key]));
  const placedCount = guests.length - unplaced.length;
  // Every saved room at its ceiling while people still wait — worth a standing line, not just
  // the transient refusal flash, because no tap can succeed until something changes.
  const allFull =
    sealedRoomIds.length > 0 &&
    sealedRoomIds.every((id) => {
      const ceiling = ceilingOf(id);
      return ceiling != null && chargeableIn(id) >= ceiling;
    }) &&
    // Only adults left in the tray make this a hard stop — children always fit somewhere.
    unplaced.some((g) => g.band === "ADULT");
  // A focus on a room that's no longer sealed (selection changed upstream) falls back to All
  // rather than rendering an empty board.
  const activeFocus = focusRoomId && sealedRoomIds.includes(focusRoomId) ? focusRoomId : null;
  const visibleRoomIds = activeFocus ? [activeFocus] : sealedRoomIds;

  if (sealedRoomIds.length === 0) {
    return (
      <div style={{ padding: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
        Save a room selection in Inquiry first — per-room composition unlocks after that.
      </div>
    );
  }

  const chip = (g: Guest, inRoom: boolean) => {
    // Show the plan for the night being edited, not the stay default — otherwise the operator
    // sets an exception and the chip appears not to have changed.
    const plan = planInScope(g.key);
    const overridden = scopeNight != null && nightPlans[scopeNight]?.[g.key] != null;
    const isSel = selected.has(g.key);
    return (
      <div
        key={g.key}
        className={`rcb-chip band-${g.band.toLowerCase()}${isSel ? " sel" : ""}`}
        draggable
        onDragStart={onChipDragStart(g.key)}
        onDragEnd={() => {
          dragKeysRef.current = [];
          setDragOver(null);
        }}
        onClick={() => toggleSelect(g.key)}
        title={isSel ? "Tap to deselect" : "Tap to select, then tap a room to place — or drag"}
      >
        <span className="b">{g.band === "ADULT" ? "A" : g.band === "C6TO10" ? "C" : "i"}</span>
        <span className="n">{g.label}</span>
        {inRoom && (
          <select
            className={overridden ? "ovr" : undefined}
            value={plan}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const next = e.target.value as PlanPick;
              // The dropdown writes at whatever scope the bar is on, so it and the bulk
              // buttons can never disagree about which night they're editing.
              if (scopeNight == null) {
                setPlans((prev) => ({ ...prev, [g.key]: next }));
                return;
              }
              setNightPlans((prev) => {
                const forNight = { ...(prev[scopeNight] ?? {}) };
                if ((plans[g.key] ?? "NONE") === next) delete forNight[g.key];
                else forNight[g.key] = next;
                const out = { ...prev };
                if (Object.keys(forNight).length === 0) delete out[scopeNight];
                else out[scopeNight] = forNight;
                return out;
              });
            }}
            title={
              scopeNight == null
                ? "Meal plan for this guest, every night"
                : `Meal plan for ${nightLabel(scopeNight)} only`
            }
          >
            {PLAN_ORDER.map((p) => (
              <option key={p} value={p}>
                {PLAN_SHORT[p]}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  };

  return (
    <div className="rcb">
      <div className="rce-bar">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={autoAssign}
          title="Spread the party evenly across the rooms (children stay together in the first room)"
        >
          <Wand2 style={{ width: 13, height: 13 }} /> Auto-assign
        </button>
        <span className="ln" />
        {roomMin != null && (
          <span
            className={`rce-tally${sealedRoomIds.length < roomMin ? " off" : ""}`}
            title="Backend capacity envelope: chargeable guests vs the largest room capacity"
          >
            needs ≥ {roomMin} room{roomMin === 1 ? "" : "s"} · {sealedRoomIds.length} saved
          </span>
        )}
        <span className={`rce-tally${placedCount !== guests.length ? " off" : ""}`}>
          {placedCount} of {guests.length} guests placed
        </span>
      </div>
      {roomMin != null && sealedRoomIds.length < roomMin && (
        <p className="rce-block">
          {roomEnvelopeQuery.data?.chargeableOccupants} chargeable guest
          {(roomEnvelopeQuery.data?.chargeableOccupants ?? 0) === 1 ? "" : "s"} won&rsquo;t fit in{" "}
          {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"} — go back to Inquiry and seal at
          least {roomMin}.
        </p>
      )}
      {seedShortfall && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          The table counted more guests than this booking&rsquo;s party has — the board can only place real
          party members, so the extra seats were dropped. Check the placement before continuing.
        </p>
      )}
      {capMsg && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          {capMsg}
        </p>
      )}
      {allFull && unplaced.length > 0 && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          Every saved room is at its limit — {unplaced.length} guest{unplaced.length === 1 ? "" : "s"} can&rsquo;t
          be placed until you add an extra bed on a room below, or go back to Inquiry and save more rooms.
        </p>
      )}

      {/* Plan bar — appears with a selection; the one place bulk actions live. */}
      {selected.size > 0 && (
        <>
          {/* Date scope. "Whole stay" writes the guest's normal plan; picking a night writes
              an override for that night alone, so "AP on arrival, CP after" is two taps. Only
              nights the guest actually booked are offered. */}
          {nights.length > 1 && (
            <div className="rcb-planbar rcb-nightbar">
              <span className="lbl">applies to:</span>
              <button
                type="button"
                className={scopeNight == null ? "on" : ""}
                onClick={() => setScopeNight(null)}
                title="Set these guests' usual plan for every night of the stay"
              >
                Whole stay
              </button>
              {nights.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`${scopeNight === n ? "on" : ""}${nightPlans[n] ? " has" : ""}`}
                  onClick={() => setScopeNight(n)}
                  title={`Set the plan for ${nightLabel(n)} only${nightPlans[n] ? " — this night already differs" : ""}`}
                >
                  {nightLabel(n)}
                </button>
              ))}
            </div>
          )}
          <div className="rcb-planbar">
            <span className="cnt">{selected.size} selected</span>
            <span className="lbl">{scopeNight == null ? "meal plan:" : `plan on ${nightLabel(scopeNight)}:`}</span>
            {PLAN_ORDER.map((p) => (
              <button key={p} type="button" onClick={() => applyPlanToSelection(p)} title={PLAN_LABEL[p]}>
                {PLAN_SHORT[p]}
              </button>
            ))}
            <span className="ln" />
            {scopeNight != null && nightPlans[scopeNight] && (
              <button
                type="button"
                className="ghost"
                onClick={() => clearNight(scopeNight)}
                title="Drop this night's exceptions — everyone returns to their usual plan"
              >
                Reset night
              </button>
            )}
            <button type="button" className="ghost" onClick={() => placeSelection(null)} title="Move the selection back to the tray">
              <Undo2 style={{ width: 11, height: 11 }} /> To tray
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setSelected(new Set());
                setScopeNight(null);
              }}
            >
              Done
            </button>
          </div>
        </>
      )}

      {/* Standing summary of which nights differ — visible without a selection, so an
          exception set earlier can't be forgotten about. */}
      {overriddenNights.length > 0 && (
        <div className="rcb-nightsum">
          <span className="rce-lbl">Nights that differ</span>
          {overriddenNights.map((n) => (
            <span key={n} className="rcb-nightpill">
              {nightLabel(n)}
              <button type="button" onClick={() => clearNight(n)} title={`Reset ${nightLabel(n)} to the usual plans`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Unplaced tray — also a drop target for pulling guests back out of rooms. */}
      {unplaced.length > 0 && (
        <div className={`rcb-tray${dragOver === "tray" ? " drop" : ""}`} {...zoneDragProps("tray", null)}>
          <div className="rcb-tray-head">
            <span className="rce-lbl">Unplaced guests</span>
            <button
              type="button"
              className="rcb-mini"
              onClick={() => setSelected(new Set(unplaced.map((g) => g.key)))}
              title="Select every unplaced guest"
            >
              <CheckSquare style={{ width: 11, height: 11 }} /> Select all
            </button>
            <span className="rcb-tray-note">tap guests, then tap a room — or drag them in</span>
          </div>
          <div className="rcb-chips">{unplaced.map((g) => chip(g, false))}</div>
        </div>
      )}

      {/* Room focus tabs — jump straight to one room without going back to the table.
          Unfocused rooms keep everything; this only changes what's on screen. */}
      {sealedRoomIds.length > 1 && (
        <div className="rcb-roomtabs">
          <button
            type="button"
            className={activeFocus == null ? "on" : ""}
            onClick={() => onFocusRoom?.(null)}
            title="Show every sealed room"
          >
            All rooms
          </button>
          {sealedRoomIds.map((id) => {
            const n = roomById.get(id)?.roomNumber ?? id.slice(0, 6);
            const count = guests.filter((g) => assign[g.key] === id).length;
            return (
              <button
                key={id}
                type="button"
                className={activeFocus === id ? "on" : ""}
                onClick={() => onFocusRoom?.(activeFocus === id ? null : id)}
                title={`Show room ${n} on its own`}
              >
                {n}
                <span className="c">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="rcb-rooms">
        {visibleRoomIds.map((id) => {
          const room = roomById.get(id);
          const roomNumber = room?.roomNumber ?? id.slice(0, 6);
          const here = guests.filter((g) => assign[g.key] === id);
          const x = extras[id] ?? EMPTY_EXTRAS;
          const othersCount = here.filter((g) => (plans[g.key] ?? "NONE") === "OTHERS").length;
          const cap = room?.roomType?.maxCapacity ?? room?.roomType?.standardCapacity;
          const ceiling = cap != null ? cap + (num(x.extraBed) ?? 0) : null;
          // Capacity counts CHARGEABLE guests only — children under 11 share bedding and
          // consume no slot (backend OVER_MAX_OCCUPANCY rule).
          const chargeable = here.filter((g) => g.band === "ADULT").length;
          const overCap = ceiling != null && chargeable > ceiling;
          const incomingChargeable = [...selected].filter((k) => assign[k] !== id && isChargeable(k)).length;
          const wontFit = ceiling != null && chargeable + incomingChargeable > ceiling;
          // Room closed: at its ceiling it stops being a target for ADULT-rate guests — dimmed,
          // no drop glow, "Full" tag. A selection of only children still places fine.
          const full = ceiling != null && chargeable >= ceiling;
          const blockedForSelection = wontFit && incomingChargeable > 0;
          return (
            <div
              key={id}
              className={`rcb-room${x.foc ? " foc" : ""}${full ? " full" : ""}${dragOver === id && !blockedForSelection ? " drop" : ""}`}
              {...zoneDragProps(id, id)}
            >
              <div className="rcb-room-head">
                <span className="rce-roomno">Room {roomNumber}</span>
                {room?.roomType?.name && <span className="rcb-type">{room.roomType.name}</span>}
                <span className="ln" />
                {full && (
                  <span className="tag warn" style={{ fontSize: 9 }}>
                    Full
                  </span>
                )}
                <span
                  className={`rcb-occ${overCap ? " over" : ""}`}
                  title={
                    ceiling != null
                      ? `${here.length} guest${here.length === 1 ? "" : "s"} in the room · ${chargeable}/${ceiling} capacity used (incl. extra beds) — children under ${childMax + 1} share bedding and don't count`
                      : undefined
                  }
                >
                  {chargeable}
                  {ceiling != null ? `/${ceiling}` : ""}
                  {here.length > chargeable ? ` +${here.length - chargeable}kid` : ""} <span aria-hidden>·</span>{" "}
                  {num(x.extraBed) ?? 0} bed
                </span>
                {here.length > 0 && (
                  <button
                    type="button"
                    className="rcb-mini"
                    onClick={() => setSelected(new Set(here.map((g) => g.key)))}
                    title="Select everyone in this room"
                  >
                    <CheckSquare style={{ width: 11, height: 11 }} /> Select
                  </button>
                )}
              </div>

              {/* A room that's adult-full offers no place action for a selection carrying adults —
                  the Full tag says why, and the extra-bed stepper below reopens it. A selection of
                  only children (no capacity slot) still places. */}
              {selected.size > 0 && !(full && incomingChargeable > 0) && (
                <button
                  type="button"
                  className="rcb-place"
                  disabled={blockedForSelection}
                  title={
                    blockedForSelection
                      ? `Room ${roomNumber} fits ${ceiling} adult-rate guests right now — add an extra bed to raise it`
                      : undefined
                  }
                  onClick={() => placeSelection(id)}
                >
                  {blockedForSelection
                    ? `Only space for ${Math.max(0, (ceiling ?? 0) - chargeable)}`
                    : `+ Place ${selected.size} here`}
                </button>
              )}

              {here.length === 0 && selected.size === 0 ? (
                <p className="rcb-empty">No guests — tap or drag chips in.</p>
              ) : (
                <div className="rcb-chips">{here.map((g) => chip(g, true))}</div>
              )}
              {overCap && (
                <p className="rcb-overcap">
                  {chargeable} adult-rate guests for capacity {cap} + {num(x.extraBed) ?? 0} extra bed
                  {(num(x.extraBed) ?? 0) === 1 ? "" : "s"} — add beds below or move someone out.
                </p>
              )}

              <div className="rcb-foot">
                <span className="rcb-step">
                  <label>Extra beds</label>
                  <button type="button" onClick={() => setExtra(id, { extraBed: String(Math.max(0, (num(x.extraBed) ?? 0) - 1)) })}>
                    −
                  </button>
                  <b>{num(x.extraBed) ?? 0}</b>
                  <button type="button" onClick={() => setExtra(id, { extraBed: String((num(x.extraBed) ?? 0) + 1) })}>
                    +
                  </button>
                </span>
                <span className="ln" />
                <label className="rce-tog">
                  <input type="checkbox" checked={x.sc} onChange={(e) => setExtra(id, { sc: e.target.checked })} /> SC
                </label>
                {/* GST is statutory — not an option (2026-08-01 operator ruling). */}
                <label className="rce-tog" title="GST is mandatory — applied on every room">
                  <input type="checkbox" checked disabled /> GST
                </label>
                <label className="rce-tog">
                  <input type="checkbox" checked={x.foc} onChange={(e) => setExtra(id, { foc: e.target.checked })} /> <b>FOC</b>
                </label>
              </div>

              {othersCount > 0 && (
                <div className="rce-grid three rce-others">
                  <MiniNum label="Others b'fast pax" value={x.othersB} onChange={(v) => setExtra(id, { othersB: v })} />
                  <MiniNum label="Others lunch pax" value={x.othersL} onChange={(v) => setExtra(id, { othersL: v })} />
                  <MiniNum label="Others dinner pax" value={x.othersD} onChange={(v) => setExtra(id, { othersD: v })} />
                </div>
              )}

              <button type="button" className="rce-adv" onClick={() => setExtra(id, { ratesOpen: !x.ratesOpen })}>
                {x.ratesOpen ? "− Hide" : "+ Negotiated rates (optional)"}
              </button>
              {x.ratesOpen && (
                <div className="rce-grid five">
                  <MiniNum label="Room rate" value={x.rateRoom} onChange={(v) => setExtra(id, { rateRoom: v })} />
                  <MiniNum label="Extra bed" value={x.rateBed} onChange={(v) => setExtra(id, { rateBed: v })} />
                  <MiniNum label="Breakfast" value={x.rateBf} onChange={(v) => setExtra(id, { rateBf: v })} />
                  <MiniNum label="Lunch" value={x.rateLu} onChange={(v) => setExtra(id, { rateLu: v })} />
                  <MiniNum label="Dinner" value={x.rateDi} onChange={(v) => setExtra(id, { rateDi: v })} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {unplaced.length > 0 && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          {unplaced.length} guest{unplaced.length === 1 ? "" : "s"} still unplaced — they won&rsquo;t be on the
          quote until placed in a room.
        </p>
      )}
      <p className="rce-hint">
        Totals are priced by the backend when you create the draft — figures appear on the quote below.
        Child meal discounts on per-room plans are pending a backend update; until then every counted
        guest is charged the full plan rate (leave infants on <i>EP</i> if they eat free).
      </p>
    </div>
  );
}

function MiniNum({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <div className="rce-f">
      <label>{label}</label>
      <input type="number" min={0} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * Mode wrapper the quote step mounts. Two modes: the spreadsheet-style table
 * (`RoomCompositionsTable`, default — one row per room, derived Occ, arrow-key cell
 * navigation, bulk fills) and the guest board above (chips into bins). The board needs
 * the intake party breakdown, so its toggle hides when the entry has none; the table
 * works either way (raw counts entry — also the path when quoted occupancy differs
 * from the intake party).
 *
 * State carries ACROSS mode switches (2026-07-28): every emission is kept in
 * `snapshotRef`, and the mode mounting next receives it as its `initial` seed — board
 * work shows up in the table (a room with 3×CP + 1×MAP+L shows both columns) and vice
 * versa. Table → board is a derivation, not a copy: counts can't say which same-band
 * guest sits where, so the board seats chips deterministically to match the tallies
 * (and flags when the table counted more people than the party has). Only the active
 * mode is mounted — both auto-emit on mount, so co-mounting would race the parent's
 * single `roomCompositions` state. The pre-2026-07-28 per-room-cards editor
 * (`RoomCompositionsEditor`) is retired from this wrapper.
 */
export function RoomCompositionPlanner(props: {
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  /** When set, in-progress edits persist per booking (sessionStorage) and survive leaving
   *  the workspace — without it the grid reset to the auto-distributed default on return. */
  persistKey?: string;
  /** When set, the reference-rate strip (per-type room/bed/meal rates from the backend)
   *  renders below the active editor as the anchor for the negotiated-rate cells. */
  entryId?: string;
  onChange: (compositions: RoomCompositionInput[]) => void;
}) {
  const canBoard = (props.entryAdults ?? 0) > 0 || (props.entryChildAges?.length ?? 0) > 0;
  const [mode, setMode] = useState<"table" | "board">("table");
  /**
   * Which room the board shows on its own. Lives here rather than in the board so the table
   * can set it: clicking a room in the grid opens that room in the board, which is the whole
   * point of the affordance. Survives mode switches.
   */
  const [focusRoomId, setFocusRoomId] = useState<string | null>(null);
  // Last emitted compositions — the seed for whichever mode mounts next. A ref, not
  // state: emissions must not re-render the planner (the active editor already did).
  // Hydrated ONCE from sessionStorage (2026-08-01) so leaving the workspace and coming
  // back resumes the edits — hydration must happen before the first child mounts (the
  // editors read `initial` at mount), so it's a lazy ref init, not an effect. This
  // component only ever renders client-side (behind the entry fetch), so no SSR risk.
  const storeKey = props.persistKey ? `desk:rcomp:${props.persistKey}` : null;
  const snapshotRef = useRef<RoomCompositionInput[] | null>(null);
  if (snapshotRef.current === null) {
    snapshotRef.current = [];
    if (storeKey && typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(storeKey);
        const v = raw ? (JSON.parse(raw) as RoomCompositionInput[]) : null;
        if (Array.isArray(v)) snapshotRef.current = v;
      } catch {
        /* corrupt / private mode — start fresh as before */
      }
    }
  }
  const { onChange } = props;
  const handleChange = (compositions: RoomCompositionInput[]) => {
    snapshotRef.current = compositions;
    if (storeKey) {
      try {
        localStorage.setItem(storeKey, JSON.stringify(compositions));
      } catch {
        /* non-fatal — the edits just won't survive navigation */
      }
    }
    onChange(compositions);
  };
  const rateRef = props.entryId ? <RateReferenceStrip entryId={props.entryId} /> : null;
  if (!canBoard)
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <RoomCompositionsTable {...props} onChange={handleChange} initial={snapshotRef.current ?? []} />
        {rateRef}
      </div>
    );
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="seg rce-seg" style={{ justifySelf: "start" }}>
        <button
          type="button"
          className={mode === "table" ? "on" : ""}
          onClick={() => setMode("table")}
          title="Spreadsheet grid — one row per room, arrow keys move between cells, Occ is derived. Carries the board's entries over."
        >
          Table
        </button>
        <button
          type="button"
          className={mode === "board" ? "on" : ""}
          onClick={() => setMode("board")}
          title="Place each guest in a room and pick their meal plan — counts are derived. Carries the table's entries over."
        >
          Guest board
        </button>
      </div>
      {mode === "table" ? (
        <RoomCompositionsTable
          {...props}
          onChange={handleChange}
          initial={snapshotRef.current ?? []}
          onOpenRoomInBoard={(roomId) => {
            setFocusRoomId(roomId);
            setMode("board");
          }}
        />
      ) : (
        <RoomCompositionsBoard
          {...props}
          onChange={handleChange}
          initial={snapshotRef.current ?? []}
          focusRoomId={focusRoomId}
          onFocusRoom={setFocusRoomId}
        />
      )}
      {rateRef}
    </div>
  );
}
