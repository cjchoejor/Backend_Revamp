"use client";

/**
 * The Inquiry step's rooms BY TYPE (2026-10-28, docs/room-types-until-arrival.md, operator: "choose
 * the number of room types per date in stage one to stage four, since we assign rooms in stage
 * five"). The desk says how many of each type each night, and any particular room a guest asked
 * for; the system chooses the real rooms — one room for each guest's whole stay — and may move
 * them within the type until Arrival, where the room numbers are proposed and confirmed.
 *
 * Every figure and every rule is the server's: the free rooms per type per night, whether the
 * counts fit, the rooms the system would choose and the other bookings it would move. The desk
 * keeps the counts and sends them.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import {
  getHouseByType,
  labelsForBookingRooms,
  planRoomsByType,
  sealRoomsByType,
  type BookingRoom,
  type SealByTypeAnswer,
} from "@/lib/api/booking-rooms";
import { fmtDay, plural } from "@/lib/ds/format";
import { currentPassConfigs } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";
import { Help } from "@/components/ds/help";
import { Choice, toastRefusal, useFlowUnsaved } from "./kit";
import { queryAvailabilityByEntry } from "@/lib/api/availability";
import { StayDates } from "@/components/ds/stay-dates";
import { enumerateNights } from "./use-room-selection";
import { STAY_SAVED_EVENT, type StaySaved } from "./s1-trip-shared";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Counts = Record<string, Record<string, number>>; // night -> type -> count

/**
 * What the desk has typed in the grid and not saved, kept by the step while the grid is off the
 * page (2026-10-29, operator: "I picked some rooms night by night, clicked Pick every room by
 * number instead and closed it without saving — it should still keep the last state of the house
 * section"). `basis` is what was on record when it was typed; a save in between makes it stale.
 */
export type TypeDraft = { basis: string; counts: Counts; fixed: string[]; byNight: boolean };

/** The booking rooms on the pick in force, when it was made by type. */
export function savedBookingRooms(entry: EntryDetail): BookingRoom[] | null {
  const cfg = currentPassConfigs(entry).find((c) => c.optionSelected != null);
  const br = (cfg?.optionSelected as { bookingRooms?: unknown } | null | undefined)?.bookingRooms;
  return Array.isArray(br) ? (br as BookingRoom[]) : null;
}

function countsOf(rooms: BookingRoom[]): { counts: Counts; fixed: string[] } {
  const counts: Counts = {};
  const fixed = new Set<string>();
  for (const r of rooms) {
    for (const n of r.nights) {
      counts[n.date] ??= {};
      counts[n.date][n.roomTypeId] = (counts[n.date][n.roomTypeId] ?? 0) + 1;
      if (n.fixed && n.roomId) fixed.add(n.roomId);
    }
  }
  return { counts, fixed: [...fixed] };
}

const canon = (counts: Counts, fixed: string[], nights: string[]) =>
  JSON.stringify([
    nights.map((d) => Object.entries(counts[d] ?? {}).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b))),
    [...fixed].sort(),
  ]);

/** One stay's grid, as a trip's house at Inquiry reads it to save every stay at once (2026-11-07). */
export type TypeGridState = {
  entryId: string;
  allSet: boolean;
  fits: boolean;
  dirty: boolean;
  checking: boolean;
  nightsSet: number;
  nightCount: number;
  reason: string | null;
};

/** What the grid has chosen, for the bill — and, in the change panel, for the change itself. */
export type TypePicks = {
  perNight: Array<{ date: string; roomIds: string[] }>;
  labels: Map<string, string>;
  saved: boolean;
  /** The counts as sent — what a change by type posts. */
  byType: { perNight: Array<{ date: string; types: Array<{ roomTypeId: string; count: number }> }>; fixedRoomIds: string[] };
};

export function RoomsByType({
  entry,
  configId,
  stale,
  nights,
  numberOfRooms,
  catalog,
  editable,
  onPicks,
  onSaved,
  onParticular,
  draft,
  onDraft,
  stay,
  noSave = false,
  flowKey = "house",
  combined,
}: {
  entry: EntryDetail;
  configId: string | null;
  stale: boolean;
  nights: string[];
  numberOfRooms: number;
  catalog: Array<{ id: string; roomNumber: string; roomTypeId?: string; roomType?: { name?: string | null } | null }>;
  editable: boolean;
  /** The rooms the system would choose, night by night, with their labels — for the bill. */
  onPicks: (p: TypePicks | null) => void;
  onSaved: () => void;
  onParticular: () => void;
  /** The counts typed last time the grid was on the page, unsaved — taken back when they still fit. */
  draft?: TypeDraft | null;
  onDraft?: (d: TypeDraft) => void;
  /**
   * A stay that is not the booking's yet — "Change the dates, rooms or guests" (2026-10-29, operator:
   * "it doesn't show the availability chart like in S1 … adopt the same style in all stages"): the
   * house and the plan are asked for these dates, and the grid saves nothing itself (`noSave`); the
   * change it belongs to posts the counts.
   */
  stay?: { checkIn: string; checkOut: string };
  noSave?: boolean;
  /** The step section whose unsaved state the grid reports — none in the change panel. */
  flowKey?: string | null;
  /**
   * One stay's columns of a trip's house at Inquiry (2026-11-07, operator: "show column for both
   * stays and user can book the room types for both stays here at once"): a caption over the
   * columns, every type in one order so the stays' rows line up, the type names only on the first,
   * and no Save of its own — the trip's house saves every stay.
   */
  combined?: {
    caption: ReactNode;
    typeOrder: Array<{ roomTypeId: string; name: string }>;
    showTypeColumn: boolean;
    onState: (s: TypeGridState) => void;
    saveRef: (fn: (() => Promise<unknown>) | null) => void;
  };
}) {
  const { session } = useSession();
  const house = useQuery({
    queryKey: ["house-by-type", entry.id, configId, entry.updatedAt, stay?.checkIn ?? "", stay?.checkOut ?? ""],
    queryFn: () => getHouseByType(session!, entry.id, stay ? { checkInDate: stay.checkIn, checkOutDate: stay.checkOut } : undefined),
    enabled: !!session && !!configId,
    staleTime: 15_000,
  });
  const types = house.data?.types ?? [];
  const typeName = (id: string) => types.find((t) => t.roomTypeId === id)?.name ?? catalog.find((r) => r.roomTypeId === id)?.roomType?.name ?? "Room";

  // ---- what is saved, and what the desk has typed --------------------------------------------
  const saved = useMemo(() => {
    const br = savedBookingRooms(entry);
    if (br) return countsOf(br);
    // A pick saved by number: its rooms counted by type, so the desk starts from what it chose.
    const cfg = currentPassConfigs(entry).find((c) => c.optionSelected != null);
    const opt = cfg?.optionSelected as { perNight?: Array<{ date: string; roomIds: Array<{ roomId: string }> }> } | null | undefined;
    if (!opt?.perNight) return null;
    const counts: Counts = {};
    for (const n of opt.perNight) {
      for (const r of n.roomIds) {
        const t = catalog.find((c) => c.id === r.roomId)?.roomTypeId;
        if (!t) continue;
        counts[n.date] ??= {};
        counts[n.date][t] = (counts[n.date][t] ?? 0) + 1;
      }
    }
    return { counts, fixed: [] as string[] };
  }, [entry, catalog]);
  const savedKey = saved && savedBookingRooms(entry) ? canon(saved.counts, saved.fixed, nights) : null;
  /**
   * New dates (the change panel): the counts saved for the old nights carry to the new ones — each
   * new night takes its own date's counts when the stay had it, else the first night's.
   */
  const seed = useMemo(() => {
    if (!saved) return null;
    if (nights.every((d) => saved.counts[d])) return saved;
    const first = Object.keys(saved.counts).sort()[0];
    const tmpl = first ? saved.counts[first] : {};
    const counts: Counts = {};
    for (const d of nights) counts[d] = { ...(saved.counts[d] ?? tmpl) };
    return { counts, fixed: saved.fixed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, nights.join(",")]);
  // What was on record for these nights when the desk typed — a draft typed on another basis
  // (saved since, or other dates) is not taken back.
  const basis = `${nights.join(",")}|${canon(saved?.counts ?? {}, saved?.fixed ?? [], nights)}`;
  const fromDraft = draft && draft.basis === basis ? draft : null;
  const [counts, setCounts] = useState<Counts>(() => fromDraft?.counts ?? seed?.counts ?? {});
  const [fixed, setFixed] = useState<string[]>(() => fromDraft?.fixed ?? seed?.fixed ?? []);
  // The change panel's new nights: a night the grid has no counts for yet takes the first night's.
  const nightsKey = nights.join(",");
  useEffect(() => {
    if (!stay) return;
    setCounts((c) => {
      const first = Object.keys(c).sort()[0];
      if (!first || nights.every((d) => c[d])) return c;
      const next: Counts = {};
      for (const d of nights) next[d] = { ...(c[d] ?? c[first]) };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nightsKey]);
  const seededFor = useRef(savedKey);
  useEffect(() => {
    // Saved again (here or on another screen): the grid follows what is on record.
    if (savedKey && savedKey !== seededFor.current) {
      seededFor.current = savedKey;
      setCounts(saved!.counts);
      setFixed(saved!.fixed);
    }
  }, [savedKey, saved]);
  const key = canon(counts, fixed, nights);
  // In the change panel "not saved" means other rooms than the booking holds, however they were first
  // picked: a pick by number carries over as its counts and is no change until the desk changes them.
  const dirty = noSave && saved ? key !== canon(saved.counts, saved.fixed, nights) : key !== (savedKey ?? canon({}, [], nights));
  // A grid with no section of its own reports under a key of its own, so it never clears the section it sits in.
  useFlowUnsaved(flowKey ?? "by-type-grid", flowKey != null && editable && dirty, "The rooms picked saved");

  const cell = (d: string, t: string) => counts[d]?.[t] ?? 0;
  const setCell = (d: string, t: string, v: number) =>
    setCounts((c) => ({ ...c, [d]: { ...(c[d] ?? {}), [t]: Math.max(0, Math.min(99, Math.floor(v) || 0)) } }));
  const setEvery = (t: string, v: number) =>
    setCounts((c) => {
      const next = { ...c };
      for (const d of nights) next[d] = { ...(next[d] ?? {}), [t]: Math.max(0, Math.min(99, Math.floor(v) || 0)) };
      return next;
    });
  const everyNight = (t: string) => {
    const vs = nights.map((d) => cell(d, t));
    return vs.every((v) => v === vs[0]) ? vs[0] : null;
  };
  const totalOn = (d: string) => Object.values(counts[d] ?? {}).reduce((a, b) => a + b, 0);
  const allSet = nights.length > 0 && nights.every((d) => totalOn(d) === numberOfRooms);

  // ---- the server's answer for what is typed --------------------------------------------------
  const body = useMemo(
    () => ({
      configurationId: configId ?? "",
      perNight: nights.map((d) => ({ date: d, types: Object.entries(counts[d] ?? {}).map(([roomTypeId, count]) => ({ roomTypeId, count })) })),
      fixedRoomIds: fixed,
    }),
    [configId, nights, counts, fixed],
  );
  const [debounced, setDebounced] = useState(body);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(body), 350);
    return () => clearTimeout(t);
  }, [body]);
  const settled = JSON.stringify(debounced) === JSON.stringify(body);
  const preview = useQuery({
    queryKey: ["by-type-preview", entry.id, JSON.stringify(debounced), stay?.checkIn ?? "", stay?.checkOut ?? "", numberOfRooms],
    queryFn: () =>
      stay
        ? planRoomsByType(session!, entry.id, {
            checkInDate: stay.checkIn,
            checkOutDate: stay.checkOut,
            numberOfRooms,
            perNight: debounced.perNight,
            fixedRoomIds: debounced.fixedRoomIds,
          })
        : sealRoomsByType(session!, entry.id, { ...debounced, preview: true }),
    enabled: !!session && !!configId && allSet && settled,
    placeholderData: (p) => p,
    staleTime: 10_000,
  });
  // Only the answer for the counts on screen counts — never the one before it, still on hand
  // while the new one is asked.
  const checking = allSet && (!settled || preview.isFetching || preview.isPlaceholderData);
  const answer: SealByTypeAnswer | null = allSet && !checking ? (preview.data ?? null) : null;
  const fits = !!answer?.fits;

  // The bill follows the rooms the system would choose; it holds still while the house is asked.
  const picksKey = answer?.fits ? JSON.stringify(answer.perNight) : "";
  useEffect(() => {
    if (checking) return;
    if (!answer?.fits) {
      onPicks(null);
      return;
    }
    onPicks({
      perNight: answer.perNight,
      labels: labelsForBookingRooms(answer.bookingRooms, typeName),
      saved: !dirty,
      byType: { perNight: body.perNight.map((n) => ({ date: n.date, types: n.types.filter((t) => t.count > 0) })), fixedRoomIds: body.fixedRoomIds },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksKey, dirty, checking]);

  const save = useMutation({
    mutationFn: () => sealRoomsByType(session!, entry.id, body),
    onSuccess: (a) => {
      if (combined) return;
      const moved = a.check?.moves.length ?? 0;
      toast.success(
        `The rooms are chosen and on record — the system keeps a room of each type for the guests${moved ? `, and moved ${plural(moved, "other booking")} within its type to make way` : ""}`,
      );
      onSaved();
    },
    onError: (e) => {
      if (!combined) toast.error(e instanceof Error ? e.message : "The rooms could not be recorded");
    },
  });

  const [byNightAsked, setByNightAsked] = useState(() => fromDraft?.byNight ?? false);
  useEffect(() => {
    onDraft?.({ basis, counts, fixed, byNight: byNightAsked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basis, counts, fixed, byNightAsked]);
  // Once the nights have differed, night by night stays open (2026-10-29, operator: the table
  // resizing as rooms are picked is "useless noise") — the desk goes back to Same every night itself.
  const countsVary =
    nights.length > 1 && [...new Set(nights.flatMap((d) => Object.keys(counts[d] ?? {})))].some((t) => everyNight(t) == null);
  useEffect(() => {
    if (countsVary && !byNightAsked) setByNightAsked(true);
  }, [countsVary, byNightAsked]);

  const shortNights = nights.filter((d) => totalOn(d) !== numberOfRooms);
  const reason = !editable
    ? null
    : stale
      ? "the house is being asked again"
      : shortNights.length
        ? `every night needs ${plural(numberOfRooms, "room")} — ${fmtDay(shortNights[0])} has ${totalOn(shortNights[0])}`
        : checking
          ? "checking with the house"
          : answer && !answer.fits
            ? "put right what is listed first"
            : !dirty
              ? "nothing changed"
              : null;
  const onState = combined?.onState;
  const stateKey = JSON.stringify([allSet, fits, dirty, checking, nights.length - shortNights.length, nights.length, reason]);
  useEffect(() => {
    onState?.({ entryId: entry.id, allSet, fits, dirty, checking, nightsSet: nights.length - shortNights.length, nightCount: nights.length, reason });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, onState]);
  const saveRef = combined?.saveRef;
  useEffect(() => {
    saveRef?.(() => save.mutateAsync());
    return () => saveRef?.(null);
  }, [saveRef, save.mutateAsync]);

  if (!configId) return null;
  if (house.isLoading) return <p className="meta">Asking the house for each type…</p>;

  // ---- what each box may offer --------------------------------------------------------------
  // A count is offered only when it can stand: no more than the type has free that night, and no
  // more than the rooms the booking still needs that night. A guest's own room keeps its type
  // counted, so the box never goes below it.
  const freeOn = (t: string, d: string) => types.find((x) => x.roomTypeId === t)?.perNight.find((p) => p.date === d)?.free ?? 0;
  const fixedOf = (t: string) => fixed.filter((id) => catalog.find((c) => c.id === id)?.roomTypeId === t).length;
  const capOn = (t: string, d: string) => Math.max(0, Math.min(freeOn(t, d), numberOfRooms - (totalOn(d) - cell(d, t))));
  const capEvery = (t: string) => (nights.length ? Math.min(...nights.map((d) => capOn(t, d))) : 0);
  const span = (lo: number, hi: number) => (hi < lo ? [] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
  /** green — the type alone covers the booking; amber — some, fewer than asked; red — none. */
  const freeTone = (n: number) => (n <= 0 ? "none" : n < numberOfRooms ? "few" : "plenty");
  // The words sit on the number itself (2026-10-28, operator: "the words on top is not something the
  // user will see, keep the words near the numbers short but understandable"): "6 free", "only 1
  // free" when the type alone cannot cover the booking, "none free".
  const freeWords = (n: number) => (n <= 0 ? "none free" : n < numberOfRooms ? `only ${n} free` : `${n} free`);
  const freeMeans = (n: number) =>
    n <= 0 ? "" : n < numberOfRooms ? ` — fewer than the ${plural(numberOfRooms, "room")} this booking needs` : ` — enough for all ${plural(numberOfRooms, "room")}`;
  const shut = (name: string, t: string, d: string) =>
    freeOn(t, d) === 0
      ? `No ${name} free on ${fmtDay(d)}`
      : `${fmtDay(d)} already has its ${plural(numberOfRooms, "room")} — lower another type first`;

  // A type with nothing free on any night, and nothing asked of it, is named in one line instead
  // of a row of empty boxes.
  const inUse = (t: string) => fixedOf(t) > 0 || nights.some((d) => cell(d, t) > 0);
  // In a trip's house every type shows, in one order for every stay, so the rows line up.
  const shown = combined
    ? combined.typeOrder.map(
        (o) =>
          types.find((t) => t.roomTypeId === o.roomTypeId) ??
          ({ roomTypeId: o.roomTypeId, name: o.name, perNight: [], wholeStay: 0, wholeStayUncertain: false } as unknown as (typeof types)[number]),
      )
    : types.filter((t) => inUse(t.roomTypeId) || nights.some((d) => freeOn(t.roomTypeId, d) > 0));
  const full = combined ? [] : types.filter((t) => !shown.includes(t));
  const typeCol = !combined || combined.showTypeColumn;
  // Most stays take the same rooms every night: one dropdown per type, and the nights show only
  // what is free. Night by night opens a dropdown per night — by itself when the nights differ.
  const oneNight = nights.length <= 1;
  const varies = shown.some((t) => everyNight(t.roomTypeId) == null);
  const byNight = oneNight || byNightAsked || varies;

  /** One box: what is free (coloured), then how many are taken — a dropdown of what can stand. */
  const pickCell = (o: {
    label: string;
    free: number;
    freeTitle: string;
    value: number | null;
    lo: number;
    hi: number;
    shutTitle: string;
    onPick: (v: number) => void;
    /** the night's free count only — the count is set in "Every night" */
    freeOnly?: boolean;
  }) => {
    const over = o.value != null && o.value > o.hi;
    const choices = span(o.lo, o.hi);
    if (over) choices.push(o.value!);
    const canChoose = editable && (choices.length > 1 || (o.value == null && choices.length > 0));
    return (
      <div className={`bt-cell${o.value ? " picked" : ""}${over ? " over" : ""}`}>
        <span className={`bt-free ${freeTone(o.free)}`} title={`${o.freeTitle}${freeMeans(o.free)}`}>
          {freeWords(o.free)}
        </span>
        {o.freeOnly ? null : <span className="bt-take">take</span>}
        {o.freeOnly ? null : canChoose ? (
          <select
            className={`bt-pick${o.value == null ? " varies" : ""}`}
            aria-label={o.label}
            title={over ? `More than can be taken — ${o.hi} at most` : undefined}
            value={o.value == null ? "" : String(o.value)}
            onChange={(e) => {
              if (e.target.value !== "") o.onPick(Number(e.target.value));
            }}
          >
            {o.value == null ? (
              <option value="" disabled>
                varies
              </option>
            ) : null}
            {choices.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        ) : (
          <span className="bt-none" role="img" aria-label={`${o.label}: ${o.value ?? 0}`} title={editable ? o.shutTitle : undefined}>
            {o.value ? o.value : "–"}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="by-type">
      {/* Same rooms every night, or a box per night — a choice of its own above the grid
          (2026-10-28, operator: "night by night button needs to be more prominent"). Night by
          night opens by itself when the nights already differ, and Same every night waits until
          they agree again. */}
      {combined ? (
        <div className="bt-cap">
          <div className="bt-cap-who">{combined.caption}</div>
          {oneNight ? null : (
            <Choice
              options={[
                ["same", "Same every night"],
                ["night", "Night by night"],
              ] as const}
              value={byNight ? "night" : "same"}
              disabled={varies}
              onChange={(v) => setByNightAsked(v === "night")}
            />
          )}
        </div>
      ) : oneNight ? null : (
        <div className="bt-modebar">
          <Choice
            options={[
              ["same", "Same every night"],
              ["night", "Night by night"],
            ] as const}
            value={byNight ? "night" : "same"}
            disabled={varies}
            onChange={(v) => setByNightAsked(v === "night")}
          />
          {varies ? <span className="bt-modebar-note">The nights differ, so each night has its own box</span> : null}
        </div>
      )}
      <div className="bt-scroll">
      <table className="table compact house-types by-type-grid">
        <thead>
          <tr>
            {typeCol ? (
            <th>
              Type
              <Help label="About the counts">
                Pick how many rooms of each type the guests need — for every night at once, or night by night. Beside each type is how
                many are free: green when that type alone has enough for the booking, amber (&ldquo;only&rdquo;) when it has fewer, red
                when none are free; under Every night, free for the whole stay. A box offers only what can stand: never more than is
                free, and never more than the rooms the booking still needs that night. The system
                chooses the rooms, one room for each guest&rsquo;s whole stay, and keeps them until Arrival, where the room numbers are
                confirmed.
              </Help>
            </th>
            ) : null}
            {oneNight ? null : <th className="every">Every night</th>}
            {nights.map((d) => {
              const tot = totalOn(d);
              const left = numberOfRooms - tot;
              return (
                <th key={d} className="hn">
                  <span className="bt-day">
                    {WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]} {fmtDay(d)}
                  </span>
                  <span
                    className={`bt-tally ${tot === numberOfRooms ? "done" : "short"}`}
                    title={left === 0 ? "Every room this night is picked" : left > 0 ? `${plural(left, "room")} still to pick` : `${-left} too many`}
                  >
                    {/* The tick keeps its place when it is not shown, so a night turning done never widens the grid. */}
                    <span className={`bt-tick${tot === numberOfRooms ? "" : " off"}`} aria-hidden>
                      ✓
                    </span>
                    {tot} of {numberOfRooms} picked
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((t) => {
            const ev = everyNight(t.roomTypeId);
            const lo = fixedOf(t.roomTypeId);
            return (
              <tr key={t.roomTypeId}>
                {typeCol ? <td className="bt-type">{t.name}</td> : null}
                {oneNight ? null : (
                <td className="every">
                  {pickCell({
                    label: `${t.name}, every night`,
                    free: t.wholeStay,
                    freeTitle: `${t.wholeStay} ${t.name} free for the whole stay${t.wholeStayUncertain ? " — perhaps more" : ""}`,
                    value: ev,
                    lo,
                    hi: Math.max(lo, capEvery(t.roomTypeId)),
                    shutTitle: `No more ${t.name} can be taken on every night`,
                    onPick: (v) => setEvery(t.roomTypeId, v),
                  })}
                </td>
                )}
                {nights.map((d) => {
                  const free = freeOn(t.roomTypeId, d);
                  return (
                    <td key={d} className="hn">
                      {pickCell({
                        label: `${t.name} on ${fmtDay(d)}`,
                        free,
                        freeTitle: `${free} ${t.name} free on ${fmtDay(d)}`,
                        value: cell(d, t.roomTypeId),
                        lo,
                        hi: Math.max(lo, capOn(t.roomTypeId, d)),
                        shutTitle: shut(t.name, t.roomTypeId, d),
                        onPick: (v) => setCell(d, t.roomTypeId, v),
                        freeOnly: !byNight,
                      })}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {full.length ? (
        <p className="bt-full">
          <span className="bt-free none">none free</span> on these nights: {full.map((t) => t.name).join(" · ")}
        </p>
      ) : null}

      {fixed.length > 0 ? (
        <div className="bt-fixed">
          <span className="bt-k">Kept for the guest</span>
          {fixed.map((id) => {
            const r = catalog.find((c) => c.id === id);
            return (
              <span key={id} className="bt-chip">
                Room {r?.roomNumber ?? "?"}
                <small>{typeName(r?.roomTypeId ?? "")}</small>
                {editable ? (
                  <button type="button" aria-label={`Let the system choose instead of Room ${r?.roomNumber}`} onClick={() => setFixed((f) => f.filter((x) => x !== id))}>
                    ×
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}

      {answer && !answer.fits ? (
        <div className="bt-refusals" role="alert">
          <span className="mark" aria-hidden>!</span>
          <div>
            {answer.refusals.map((r) => (
              <div key={r}>{r}</div>
            ))}
          </div>
        </div>
      ) : null}
      {answer?.fits && (answer.check?.moves.length ?? 0) > 0 ? (
        <p className="meta bt-moves">
          To fit, the system moves {answer.check!.moves.map((m) => `${m.booking} from ${m.fromRoomNumber} to ${m.toRoomNumber}`).join(", ")} — same type,
          nothing else changes for them.
        </p>
      ) : null}

      {editable && !combined ? (
        <div className="row-acts rooms-saverow">
          <span className={`bt-state ${fits && allSet ? "ok-ink" : "stop-ink"}`}>
            {!allSet
              ? `${nights.filter((d) => totalOn(d) === numberOfRooms).length} of ${plural(nights.length, "night")} set`
              : fits
                ? noSave
                  ? "It fits"
                  : dirty
                    ? "It fits — save it"
                    : "Saved"
                : checking
                  ? "Checking…"
                  : "Does not fit yet"}
          </span>
          <Button kind="quiet" compact onClick={onParticular}>
            Pick every room by number instead
          </Button>
          {noSave ? null : (
          <Button
            className="go"
            style={{ marginLeft: "auto" }}
            state={save.isPending ? "working" : reason ? "inert" : "default"}
            title={reason ?? undefined}
            workingLabel="Saving…"
            onClick={() => save.mutate()}
          >
            Save the rooms
          </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ a trip's house at Inquiry */

type Catalog = Array<{ id: string; roomNumber: string; roomTypeId?: string; roomType?: { name?: string | null } | null }>;
type CombinedProps = NonNullable<Parameters<typeof RoomsByType>[0]["combined"]>;

/** Every type in one order for every stay of a trip's house — by the hotel's rooms, lowest room first. */
export function typeOrderOf(catalog: Catalog) {
  const seen = new Map<string, string>();
  const rooms = [...catalog].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  for (const r of rooms) if (r.roomTypeId && !seen.has(r.roomTypeId)) seen.set(r.roomTypeId, r.roomType?.name ?? "Room");
  return [...seen].map(([roomTypeId, name]) => ({ roomTypeId, name }));
}

function StayCaption({ entry, stayNo, mine }: { entry: EntryDetail; stayNo: number; mine: boolean }) {
  return (
    <>
      <span className="bt-cap-line">
        <b>Stay {stayNo}</b>
        <span className="meta">
          {mine ? "this booking" : entry.id} · {plural(entry.numberOfRooms ?? 1, "room")}
        </span>
      </span>
      <StayDates checkIn={entry.checkInDate} checkOut={entry.checkOutDate} />
    </>
  );
}

/**
 * A TRIP'S HOUSE AT INQUIRY (2026-11-07, operator: "show column for both stays and user can book the
 * room types for both stays here at once, that way, stage one can be done together here"). Each
 * stay's own grid side by side — its own nights, its own rooms asked, its own house answer and its
 * own checks — the type names once, on the first, and one Save that saves every stay changed. Each
 * stay is saved through its own pick by type, as on its own page.
 */
export function TripHouse({
  entry,
  others,
  stayNoOf,
  catalog,
  editable,
  renderCurrent,
  onParticular,
  onAllSaved,
  drafts,
  onOtherPicks,
}: {
  entry: EntryDetail;
  others: EntryDetail[];
  stayNoOf: (id: string) => number;
  catalog: Catalog;
  editable: boolean;
  /** This booking's own grid, with the house card's own props and the trip's `combined`. */
  renderCurrent: (combined: CombinedProps) => ReactNode;
  onParticular: () => void;
  onAllSaved: () => void;
  /** The other stays' counts not saved yet, kept while the by-number pop-up is open (held by the house card). */
  drafts?: Record<string, TypeDraft>;
  /** Another stay's rooms as its grid has them, for the trip's figure (null while they do not fit). */
  onOtherPicks?: (entryId: string, p: TypePicks | null) => void;
}) {
  const typeOrder = useMemo(() => typeOrderOf(catalog), [catalog]);
  const stays = [entry, ...others].sort((a, b) => stayNoOf(a.id) - stayNoOf(b.id));
  const [states, setStates] = useState<Record<string, TypeGridState>>({});
  const onState = useMemo(
    () => (st: TypeGridState) => setStates((p) => (JSON.stringify(p[st.entryId]) === JSON.stringify(st) ? p : { ...p, [st.entryId]: st })),
    [],
  );
  const savers = useRef<Record<string, (() => Promise<unknown>) | null>>({});
  const saveRefs = useRef<Record<string, (fn: (() => Promise<unknown>) | null) => void>>({});
  const saveRefFor = (id: string) =>
    (saveRefs.current[id] ??= (fn) => {
      savers.current[id] = fn;
    });
  const combinedFor = (e: EntryDetail, first: boolean): CombinedProps => ({
    caption: <StayCaption entry={e} stayNo={stayNoOf(e.id)} mine={e.id === entry.id} />,
    typeOrder,
    showTypeColumn: first,
    onState,
    saveRef: saveRefFor(e.id),
  });

  const list = stays.map((e) => ({ id: e.id, n: stayNoOf(e.id), st: states[e.id] }));
  const ready = (st?: TypeGridState) => !!st && st.allSet && st.fits && !st.checking;
  const anyDirty = list.some((x) => x.st?.dirty);
  const held = list.find((x) => !ready(x.st));
  useFlowUnsaved("house", editable && anyDirty, "The rooms picked saved");
  const reason = !editable
    ? null
    : held
      ? `stay ${held.n}: ${held.st?.reason ?? (held.st?.checking ? "checking with the house" : "the house is being asked")}`
      : !anyDirty
        ? "nothing changed"
        : null;

  const saveAll = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const x of list) {
        if (!x.st?.dirty) continue;
        const save = savers.current[x.id];
        if (!save) throw new Error(`Stay ${x.n}'s rooms are not ready to save yet`);
        try {
          await save();
        } catch (e) {
          throw new Error(`Stay ${x.n}: ${e instanceof Error ? e.message : String(e)}`);
        }
        n++;
      }
      return n;
    },
    onSuccess: (n) => {
      toast.success(`The rooms are chosen for ${plural(n, "stay")} — the system keeps a room of each type for the guests`);
      onAllSaved();
    },
    onError: (e) => toastRefusal(e, "The rooms could not be recorded"),
  });

  // Captions of one height, so every stay's rows line up — taller when a stay offers Same every night.
  const multi = stays.some((e) => enumerateNights(e.checkInDate, e.checkOutDate).length > 1);
  return (
    <div className={`trip-house${multi ? " has-multi" : ""}`}>
      <div className="trip-house-cols">
        {stays.map((e, i) => (
          <div key={e.id} className={`trip-house-col${i === 0 ? " first" : ""}`}>
            {e.id === entry.id ? (
              renderCurrent(combinedFor(e, i === 0))
            ) : (
              <OtherStayTypeColumn
                entry={e}
                stayNo={stayNoOf(e.id)}
                catalog={catalog}
                editable={editable}
                combined={combinedFor(e, i === 0)}
                draft={drafts?.[e.id] ?? null}
                onDraft={drafts ? (d) => void (drafts[e.id] = d) : undefined}
                onPicks={onOtherPicks ? (p) => onOtherPicks(e.id, p) : undefined}
              />
            )}
          </div>
        ))}
      </div>
      {editable ? (
        <div className="row-acts rooms-saverow">
          <span className="bt-state trip-state">
            {list.map((x) => (
              <span key={x.id} className={ready(x.st) ? "ok-ink" : "stop-ink"}>
                Stay {x.n}
                {ready(x.st) ? (x.st!.dirty ? " · it fits" : " ✓") : x.st ? ` · ${x.st.nightsSet} of ${plural(x.st.nightCount, "night")} set` : " · asking the house"}
              </span>
            ))}
          </span>
          <Button kind="quiet" compact onClick={onParticular}>
            Pick every room by number instead
          </Button>
          <Button
            className="go"
            style={{ marginLeft: "auto" }}
            state={saveAll.isPending ? "working" : reason ? "inert" : "default"}
            title={reason ?? undefined}
            workingLabel="Saving…"
            onClick={() => saveAll.mutate()}
          >
            Save the rooms
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Another stay's columns in a trip's house: the house asked for its own dates — when it never was,
 * when its dates changed, when the answer has gone old, and when its row in The stay is saved — and
 * its own grid.
 */
function OtherStayTypeColumn({
  entry,
  stayNo,
  catalog,
  editable,
  combined,
  draft,
  onDraft,
  onPicks,
}: {
  entry: EntryDetail;
  stayNo: number;
  catalog: Catalog;
  editable: boolean;
  combined: CombinedProps;
  draft?: TypeDraft | null;
  onDraft?: (d: TypeDraft) => void;
  onPicks?: (p: TypePicks | null) => void;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const latest = currentPassConfigs(entry)[0] ?? null;
  const sc = (latest?.searchCriteria ?? null) as { checkInDate?: unknown; checkOutDate?: unknown } | null;
  const ymd = (v: unknown) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null);
  const ci = entry.checkInDate?.slice(0, 10) ?? null;
  const co = entry.checkOutDate?.slice(0, 10) ?? null;
  const nights = useMemo(() => enumerateNights(entry.checkInDate, entry.checkOutDate), [entry.checkInDate, entry.checkOutDate]);
  const ask = useMutation({
    mutationFn: (over?: StaySaved) =>
      queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: over?.checkInDate ?? ci!,
        checkOutDate: over?.checkOutDate ?? co!,
        guestCount: (over?.guestCount ?? entry.guestCount) ?? undefined,
        useType: entry.useType ?? undefined,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["entry", entry.id] }),
    onError: (e) => toastRefusal(e, `The house could not be asked for stay ${stayNo}`),
  });
  const askKey =
    !editable || !ci || !co
      ? null
      : !latest
        ? "none"
        : latest.isStale
          ? `stale:${latest.id}`
          : ymd(sc?.checkInDate) !== ci || ymd(sc?.checkOutDate) !== co
            ? `${ci}|${co}`
            : null;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!askKey || asked.current === askKey || ask.isPending || !session) return;
    // Started once the effect has settled (the 2026-10-23 rule for a one-shot mutation from an effect).
    const t = setTimeout(() => {
      asked.current = askKey;
      ask.mutate(undefined);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, ask.isPending, session]);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<StaySaved & { entryId: string }>).detail;
      if (!d || d.entryId !== entry.id || !d.checkInDate || !d.checkOutDate) return;
      asked.current = `${d.checkInDate}|${d.checkOutDate}`;
      askRef.current.mutate({ checkInDate: d.checkInDate, checkOutDate: d.checkOutDate, guestCount: d.guestCount });
    };
    window.addEventListener(STAY_SAVED_EVENT, on);
    return () => window.removeEventListener(STAY_SAVED_EVENT, on);
  }, [entry.id]);
  const waiting = !latest || !!askKey || ask.isPending;
  const onState = combined.onState;
  useEffect(() => {
    if (!waiting) return;
    onState({ entryId: entry.id, allSet: false, fits: false, dirty: false, checking: true, nightsSet: 0, nightCount: nights.length, reason: "the house is being asked" });
  }, [waiting, onState, entry.id, nights.length]);
  if (waiting) {
    return (
      <div className="by-type">
        <div className="bt-cap">
          <div className="bt-cap-who">{combined.caption}</div>
        </div>
        <p className="meta">{ask.isError ? "The house could not be asked for this stay." : "Asking the house for this stay…"}</p>
        {ask.isError ? (
          <Button kind="quiet" compact onClick={() => ask.mutate(undefined)}>
            Try asking the house again
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <RoomsByType
      entry={entry}
      configId={latest!.id}
      stale={!!latest!.isStale}
      nights={nights}
      numberOfRooms={entry.numberOfRooms ?? 1}
      catalog={catalog}
      editable={editable}
      onPicks={onPicks ?? (() => {})}
      onSaved={() => {}}
      onParticular={() => {}}
      flowKey={null}
      combined={combined}
      draft={draft}
      onDraft={onDraft}
    />
  );
}
