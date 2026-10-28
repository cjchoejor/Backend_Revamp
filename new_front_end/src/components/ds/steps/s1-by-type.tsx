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
import { useFlowUnsaved } from "./kit";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Counts = Record<string, Record<string, number>>; // night -> type -> count

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
  const [counts, setCounts] = useState<Counts>(() => saved?.counts ?? {});
  const [fixed, setFixed] = useState<string[]>(() => saved?.fixed ?? []);
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
  const preview = useQuery({
    queryKey: ["by-type-preview", entry.id, JSON.stringify(debounced)],
    queryFn: () => sealRoomsByType(session!, entry.id, { ...debounced, preview: true }),
    enabled: !!session && !!configId && allSet,
    placeholderData: (p) => p,
    staleTime: 10_000,
  });
  const answer: SealByTypeAnswer | null = allSet ? (preview.data ?? null) : null;
  const fits = !!answer?.fits && !preview.isFetching;

  // The bill follows the rooms the system would choose.
  const picksKey = answer?.fits ? JSON.stringify(answer.perNight) : "";
  useEffect(() => {
    if (!answer?.fits) {
      onPicks(null);
      return;
    }
    onPicks({ perNight: answer.perNight, labels: labelsForBookingRooms(answer.bookingRooms, typeName), saved: !dirty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksKey, dirty]);

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

  const roomsOfType = (t: string) => catalog.filter((r) => r.roomTypeId === t);
  const [adding, setAdding] = useState("");

  if (!configId) return null;
  if (house.isLoading) return <p className="meta">Asking the house for each type…</p>;

  const shortNights = nights.filter((d) => totalOn(d) !== numberOfRooms);
  const reason = !editable
    ? null
    : stale
      ? "the house is being asked again"
      : shortNights.length
        ? `every night needs ${plural(numberOfRooms, "room")} — ${fmtDay(shortNights[0])} has ${totalOn(shortNights[0])}`
        : preview.isFetching
          ? "checking with the house"
          : answer && !answer.fits
            ? "put right what is listed first"
            : !dirty
              ? "nothing changed"
              : null;

  return (
    <div className="by-type">
      <table className="table compact house-types by-type-grid">
        <thead>
          <tr>
            <th>Type</th>
            <th className="every">
              Every night
              <Help label="About the counts">
                How many rooms of each type the guests need. Set it for every night here, or night by night in the columns. The system chooses
                the rooms — one room for each guest&rsquo;s whole stay — and keeps them until Arrival, where the room numbers are confirmed.
              </Help>
            </th>
            {nights.map((d) => {
              const tot = totalOn(d);
              return (
                <th key={d} className="hn">
                  {WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}
                  <small>{fmtDay(d)}</small>
                  <span className={`bt-tally ${tot === numberOfRooms ? "done" : "short"}`} title={`${tot} of the ${numberOfRooms} rooms asked`}>
                    {tot}/{numberOfRooms}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {types.map((t) => {
            const ev = everyNight(t.roomTypeId);
            return (
              <tr key={t.roomTypeId}>
                <td>
                  {t.name}
                  <span className="meta"> · {t.wholeStay} free every night</span>
                </td>
                <td className="every">
                  <input
                    className="bt-count"
                    inputMode="numeric"
                    aria-label={`${t.name}, every night`}
                    disabled={!editable}
                    value={ev == null ? "" : String(ev)}
                    placeholder={ev == null ? "varies" : "0"}
                    onChange={(e) => setEvery(t.roomTypeId, Number(e.target.value))}
                  />
                </td>
                {nights.map((d) => {
                  const free = t.perNight.find((p) => p.date === d)?.free ?? 0;
                  const v = cell(d, t.roomTypeId);
                  return (
                    <td key={d} className={`hn${v > free ? " over" : ""}`}>
                      <input
                        className="bt-count"
                        inputMode="numeric"
                        aria-label={`${t.name} on ${fmtDay(d)}`}
                        disabled={!editable}
                        value={v ? String(v) : ""}
                        placeholder="0"
                        onChange={(e) => setCell(d, t.roomTypeId, Number(e.target.value))}
                      />
                      <small className={free === 0 ? "none" : v > free ? "over" : ""}>{free} free</small>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="bt-fixed">
        <span className="bt-k">A guest&rsquo;s own room</span>
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
        {editable ? (
          <select
            className="bt-add"
            value={adding}
            aria-label="Ask for a particular room"
            onChange={(e) => {
              const id = e.target.value;
              setAdding("");
              if (!id || fixed.includes(id)) return;
              const t = catalog.find((c) => c.id === id)?.roomTypeId;
              setFixed((f) => [...f, id]);
              // A room of a type nobody asked for yet: count it in on every night.
              if (t) {
                const need = fixed.filter((x) => catalog.find((c) => c.id === x)?.roomTypeId === t).length + 1;
                setCounts((c) => {
                  const next = { ...c };
                  for (const d of nights) if ((next[d]?.[t] ?? 0) < need) next[d] = { ...(next[d] ?? {}), [t]: need };
                  return next;
                });
              }
            }}
          >
            <option value="">+ A particular room</option>
            {types.map((t) => (
              <optgroup key={t.roomTypeId} label={t.name}>
                {roomsOfType(t.roomTypeId)
                  .filter((r) => !fixed.includes(r.id))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      Room {r.roomNumber}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        ) : null}
        {fixed.length === 0 ? <span className="meta">none — the system chooses every room</span> : null}
      </div>

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
                : preview.isFetching
                  ? "Checking…"
                  : "Does not fit yet"}
          </span>
          <Button kind="quiet" compact onClick={onParticular}>
            Choose particular rooms instead
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
