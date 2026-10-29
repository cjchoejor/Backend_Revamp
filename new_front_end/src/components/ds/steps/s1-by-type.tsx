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
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import {
  getHouseByType,
  labelsForBookingRooms,
  sealRoomsByType,
  type BookingRoom,
  type SealByTypeAnswer,
} from "@/lib/api/booking-rooms";
import { fmtDay, plural } from "@/lib/ds/format";
import { currentPassConfigs } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";
import { Help } from "@/components/ds/help";
import { Choice, useFlowUnsaved } from "./kit";

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
}: {
  entry: EntryDetail;
  configId: string | null;
  stale: boolean;
  nights: string[];
  numberOfRooms: number;
  catalog: Array<{ id: string; roomNumber: string; roomTypeId?: string; roomType?: { name?: string | null } | null }>;
  editable: boolean;
  /** The rooms the system would choose, night by night, with their labels — for the bill. */
  onPicks: (p: { perNight: Array<{ date: string; roomIds: string[] }>; labels: Map<string, string>; saved: boolean } | null) => void;
  onSaved: () => void;
  onParticular: () => void;
  /** The counts typed last time the grid was on the page, unsaved — taken back when they still fit. */
  draft?: TypeDraft | null;
  onDraft?: (d: TypeDraft) => void;
}) {
  const { session } = useSession();
  const house = useQuery({
    queryKey: ["house-by-type", entry.id, configId, entry.updatedAt],
    queryFn: () => getHouseByType(session!, entry.id),
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
  // What was on record for these nights when the desk typed — a draft typed on another basis
  // (saved since, or other dates) is not taken back.
  const basis = `${nights.join(",")}|${canon(saved?.counts ?? {}, saved?.fixed ?? [], nights)}`;
  const fromDraft = draft && draft.basis === basis ? draft : null;
  const [counts, setCounts] = useState<Counts>(() => fromDraft?.counts ?? saved?.counts ?? {});
  const [fixed, setFixed] = useState<string[]>(() => fromDraft?.fixed ?? saved?.fixed ?? []);
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
  const dirty = key !== (savedKey ?? canon({}, [], nights));
  useFlowUnsaved("house", editable && dirty, "The rooms picked saved");

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
    queryKey: ["by-type-preview", entry.id, JSON.stringify(debounced)],
    queryFn: () => sealRoomsByType(session!, entry.id, { ...debounced, preview: true }),
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
    onPicks({ perNight: answer.perNight, labels: labelsForBookingRooms(answer.bookingRooms, typeName), saved: !dirty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksKey, dirty, checking]);

  const save = useMutation({
    mutationFn: () => sealRoomsByType(session!, entry.id, body),
    onSuccess: (a) => {
      const moved = a.check?.moves.length ?? 0;
      toast.success(
        `The rooms are chosen and on record — the system keeps a room of each type for the guests${moved ? `, and moved ${plural(moved, "other booking")} within its type to make way` : ""}`,
      );
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "The rooms could not be recorded"),
  });

  const [byNightAsked, setByNightAsked] = useState(() => fromDraft?.byNight ?? false);
  useEffect(() => {
    onDraft?.({ basis, counts, fixed, byNight: byNightAsked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basis, counts, fixed, byNightAsked]);

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
  const shown = types.filter((t) => inUse(t.roomTypeId) || nights.some((d) => freeOn(t.roomTypeId, d) > 0));
  const full = types.filter((t) => !shown.includes(t));
  // Most stays take the same rooms every night: one dropdown per type, and the nights show only
  // what is free. Night by night opens a dropdown per night — by itself when the nights differ.
  const oneNight = nights.length <= 1;
  const varies = shown.some((t) => everyNight(t.roomTypeId) == null);
  const byNight = oneNight || byNightAsked || varies;

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
      {oneNight ? null : (
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
                    {tot === numberOfRooms ? "✓ " : ""}
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
                <td className="bt-type">{t.name}</td>
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

      {editable ? (
        <div className="row-acts rooms-saverow">
          <span className={`bt-state ${fits && allSet ? "ok-ink" : "stop-ink"}`}>
            {!allSet
              ? `${nights.filter((d) => totalOn(d) === numberOfRooms).length} of ${plural(nights.length, "night")} set`
              : fits
                ? dirty
                  ? "It fits — save it"
                  : "Saved"
                : checking
                  ? "Checking…"
                  : "Does not fit yet"}
          </span>
          <Button kind="quiet" compact onClick={onParticular}>
            Pick every room by number instead
          </Button>
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
        </div>
      ) : null}
    </div>
  );
}
