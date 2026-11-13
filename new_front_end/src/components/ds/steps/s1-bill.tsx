"use client";

/**
 * The bill for the rooms on the table (2026-10-10, operator, after the boss's journey mockup:
 * "it shows total amount of the cost of rooms booked in a day and per day and all together").
 *
 * Every figure is the server's (`POST /entries/:id/availability/price-pick`): each room type as
 * room-nights × rate, then net, service charge, GST and the stay's total, then each night with its
 * rooms and what that night comes to. The desk prints them and adds nothing up. Room
 * only — meals, extra beds and an agreed rate are set on the table at Negotiation, which is
 * also where the quotation prices it exactly.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Help } from "@/components/ds/help";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { pricePick, priceTripPicks, type PickPricing, type TripPickPricing } from "@/lib/api/availability";
import { getBookingRooms } from "@/lib/api/booking-rooms";
import { StayDates } from "@/components/ds/stay-dates";
import { Choice } from "./kit";
import { fmtDay, money, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";

export type BillNight = { date: string; roomIds: string[] };

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (iso: string) => WEEKDAY[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()] ?? "";
const pct = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

type NightRoom = PickPricing["nights"][number]["rooms"][number];

/**
 * A night's rooms in words (2026-10-30, operator: "don't show Premium Suite · room 2, room 1 —
 * just Premium Suite × 2"): the system's rooms counted by type, a room given by number by its
 * number with its type beside it.
 */
function nightRoomWords(rooms: NightRoom[], roomLabels?: Record<string, string> | null) {
  const byType = new Map<string, number>();
  const fixed: NightRoom[] = [];
  for (const r of rooms) {
    const label = roomLabels?.[r.roomId];
    if (!label) {
      fixed.push(r);
      continue;
    }
    const type = r.roomTypeName ?? label.replace(/\s·\sroom\s\d+$/, "");
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  return { byType: [...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), fixed };
}

/** The nights that hold rooms, in date order, each room once — the query key and the request. */
export function cleanPicks(picks: BillNight[]): BillNight[] {
  return picks
    .filter((p) => p.roomIds.length > 0)
    .map((p) => ({ date: p.date.slice(0, 10), roomIds: [...new Set(p.roomIds)].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function usePickPricing(entryId: string, picks: BillNight[], enabled = true) {
  const { session } = useSession();
  const clean = cleanPicks(picks);
  const key = JSON.stringify(clean);
  const q = useQuery({
    queryKey: ["price-pick", entryId, key],
    queryFn: () => pricePick(session!, entryId, { perNight: clean }),
    enabled: !!session && enabled && clean.length > 0,
    // The figures already shown stay while the next pick is priced — the bill never blinks.
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
  const live = enabled && clean.length > 0;
  return { pricing: live ? (q.data ?? null) : null, loading: live && q.isFetching, error: live ? q.error : null };
}

function basisWords(p: PickPricing) {
  // Room types may be on different packages (2026-11-13): each named once.
  const pkgs = [...new Set(p.byType.map((t) => t.packageName).filter((n): n is string => !!n))];
  const pkg = pkgs.length ? pkgs.join(" and ") : null;
  if (p.party) return `${p.party.name}${pkg ? ` · ${pkg}` : ""}`;
  return "published rates";
}

export function PickBill({
  pricing,
  loading,
  title,
  caption,
  help,
  roomLabels,
}: {
  /** A room the system chose quietly is named by its type, not its number (2026-10-28). */
  roomLabels?: Record<string, string> | null;
  pricing: PickPricing;
  loading?: boolean;
  title: ReactNode;
  /** A message under the bill — something to act on. */
  caption?: ReactNode;
  /** What the bill is, behind a "?" beside its title. */
  help?: ReactNode;
}) {
  const c = pricing.currency;
  const t = pricing.totals;
  return (
    <div className={`pickbill${loading ? " loading" : ""}`} aria-busy={loading || undefined}>
      <div className="pb-head">
        <span className="pb-title">
          {title}
          {help ? <Help label="About this bill">{help}</Help> : null}
        </span>
        <span className="pb-total">
          <span className="pb-total-word">Indicative total</span>
          <span className="money">{money(t.total, c)}</span>
        </span>
        <span className="pb-sub">
          {plural(t.roomNights, "room-night")} · {plural(pricing.nights.length, "night")} · incl. {pct(pricing.serviceChargeRate)} service charge +{" "}
          {pct(pricing.gstRate)} GST · room only · {basisWords(pricing)}
        </span>
      </div>
      <table className="table compact pb-ladder">
        <tbody>
          {pricing.byType.map((ty) => (
            <tr key={ty.roomTypeId}>
              <td>
                {ty.name}
                {new Set(pricing.byType.map((x) => x.packageName).filter(Boolean)).size > 1 && ty.packageName ? (
                  <span className="meta"> · {ty.packageName}</span>
                ) : null}
              </td>
              <td className="num meta">
                {plural(ty.roomNights, "room-night")} × {ty.rate == null ? "no rate on file" : money(ty.rate, c)}
              </td>
              <td className="num money">{ty.net == null ? "—" : money(ty.net, c)}</td>
            </tr>
          ))}
          <tr className="pb-step">
            <td colSpan={2}>Net</td>
            <td className="num money">{money(t.net, c)}</td>
          </tr>
          <tr>
            <td colSpan={2}>Service charge {pct(pricing.serviceChargeRate)}</td>
            <td className="num money">{money(t.serviceCharge, c)}</td>
          </tr>
          <tr>
            <td colSpan={2}>GST {pct(pricing.gstRate)} · on the net and the service charge</td>
            <td className="num money">{money(t.gst, c)}</td>
          </tr>
          <tr className="pb-grand">
            <td colSpan={2}>Total for the stay</td>
            <td className="num money">{money(t.total, c)}</td>
          </tr>
        </tbody>
      </table>
      {/* Each night with its rooms, under the totals (2026-10-30, operator). */}
      <table className="table compact pb-nights">
        <thead>
          <tr>
            <th>Night</th>
            <th>Rooms</th>
            <th className="num">That night</th>
          </tr>
        </thead>
        <tbody>
          <NightRows pricing={pricing} roomLabels={roomLabels} />
        </tbody>
      </table>
      {pricing.unpricedTypes.length ? (
        <div className="sm warn-ink" style={{ marginTop: 6 }}>
          No rate on file for {pricing.unpricedTypes.map((x) => x.name).join(", ")} — those nights are left out of the total.
        </div>
      ) : null}
      {caption ? <div className="meta pb-caption">{caption}</div> : null}
    </div>
  );
}

/** Each night with its rooms and what that night comes to — the server's figures. */
function NightRows({ pricing, roomLabels }: { pricing: PickPricing; roomLabels?: Record<string, string> | null }) {
  const c = pricing.currency;
  return (
    <>
      {pricing.nights.map((n) => {
        const words = nightRoomWords(n.rooms, roomLabels);
        return (
          <tr key={n.date}>
            <td className="pb-night">
              {weekday(n.date)} {fmtDay(n.date)}
              <span className="meta">
                night {n.nightNo} of {pricing.stayNights}
              </span>
            </td>
            <td>
              <span className="pb-rooms">
                {words.byType.map(([type, count]) => (
                  <span key={type} className="pb-room">
                    {count > 1 ? `${type} × ${count}` : type}
                  </span>
                ))}
                {words.fixed.map((r) => (
                  <span key={r.roomId} className="pb-room">
                    Room {r.roomNumber}
                    {r.roomTypeName ? <small>{r.roomTypeName}</small> : null}
                  </span>
                ))}
              </span>
              {n.unpricedRooms ? <span className="meta warn-ink"> · {plural(n.unpricedRooms, "room")} with no rate</span> : null}
            </td>
            <td className="num money">{money(n.total, c)}</td>
          </tr>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ a trip's stays together */

/** Each stay of a trip at Inquiry with its rooms as they stand, priced together by the server (2026-11-07). */
export function useTripPickPricing(entryId: string, stays: Array<{ entryId: string; picks: BillNight[] }>, enabled = true) {
  const { session } = useSession();
  const body = stays.map((s) => ({ entryId: s.entryId, perNight: cleanPicks(s.picks) }));
  const key = JSON.stringify(body);
  const live = enabled && stays.length > 1 && body.some((s) => s.perNight.length > 0);
  const q = useQuery({
    queryKey: ["price-pick-trip", entryId, key],
    queryFn: () => priceTripPicks(session!, entryId, { stays: body }),
    enabled: !!session && live,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
  return { pricing: live ? (q.data ?? null) : null, loading: live && q.isFetching, error: live ? q.error : null };
}

export type TripBillView = "TOGETHER" | "EACH";
const VIEW_KEY = "desk:trip-bill-view";

/** Together or stay by stay — remembered on this computer, a viewer's own convenience. */
export function useTripBillView(): [TripBillView, (v: TripBillView) => void] {
  const [v, setV] = useState<TripBillView>("TOGETHER");
  useEffect(() => {
    try {
      const got = window.localStorage.getItem(VIEW_KEY);
      if (got === "EACH" || got === "TOGETHER") setV(got);
    } catch {
      /* not kept — the default stands */
    }
  }, []);
  const set = (next: TripBillView) => {
    setV(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* not kept */
    }
  };
  return [v, set];
}

/** The rooms each stay's system chose, named by their type — one read per stay, shared with the stay's own. */
function useTripLabels(entries: EntryDetail[]) {
  const { session } = useSession();
  const reads = useQueries({
    queries: entries.map((e) => ({
      queryKey: ["booking-rooms", e.id, e.updatedAt ?? ""],
      queryFn: () => getBookingRooms(session!, e.id),
      enabled: !!session,
      staleTime: 15_000,
    })),
  });
  const out: Record<string, Record<string, string>> = {};
  entries.forEach((e, i) => {
    const d = reads[i]?.data;
    const m: Record<string, string> = {};
    if (d && !d.atArrival) for (const r of d.rooms ?? []) if (r.quiet) m[r.roomId] = r.label;
    out[e.id] = m;
  });
  return out;
}

/**
 * The trip's rooms at Inquiry in one bill (2026-11-07, operator: "show for both, also an option to
 * see all entries' total separately … in the price tab, we need to show for both together in the
 * table, and also have option to see separately"). Together: each stay's room types under its own
 * row with that stay's total, then the trip's net, service charge, GST and total, then every night
 * under its stay. Stay by stay: each stay's total, then each stay's own bill. Every figure is the
 * server's; nothing is added up here.
 */
export function TripPickBill({
  trip,
  entries,
  stayNoOf,
  labelsOverride,
  loading,
  title,
  help,
  caption,
}: {
  trip: TripPickPricing;
  /** Every stay of the trip in this bill, read in full — their dates and their rooms' names. */
  entries: EntryDetail[];
  stayNoOf: (id: string) => number;
  /** Rooms named by type for picks not saved yet (the grids' own labels). */
  labelsOverride?: Record<string, Record<string, string> | undefined>;
  loading?: boolean;
  title: ReactNode;
  help?: ReactNode;
  caption?: ReactNode;
}) {
  const [view, setView] = useTripBillView();
  const read = useTripLabels(entries);
  const labelsOf = (id: string) => ({ ...(read[id] ?? {}), ...(labelsOverride?.[id] ?? {}) });
  const c = trip.currency;
  const t = trip.totals;
  const stays = [...trip.stays].sort((a, b) => stayNoOf(a.entryId) - stayNoOf(b.entryId));
  const name = (id: string) => `Stay ${stayNoOf(id)}`;
  const missing = stays.filter((s) => !s.pricing);
  const nights = stays.reduce((a, s) => a + (s.pricing?.nights.length ?? 0), 0);
  return (
    <div className={`pickbill trip-bill${loading ? " loading" : ""}`} aria-busy={loading || undefined}>
      <div className="pb-head">
        <span className="pb-title">
          {title}
          {help ? <Help label="About this bill">{help}</Help> : null}
        </span>
        <span className="pb-total">
          <span className="pb-total-word">Indicative total · the trip</span>
          <span className="money">{money(t.total, c)}</span>
        </span>
        <span className="pb-sub">
          {plural(stays.length, "stay")} · {plural(t.roomNights, "room-night")} · {plural(nights, "night")} · incl. {pct(trip.serviceChargeRate)} service charge +{" "}
          {pct(trip.gstRate)} GST · room only
        </span>
      </div>
      <div className="trip-bill-switch">
        <Choice
          options={[
            ["TOGETHER", "Together"],
            ["EACH", "Stay by stay"],
          ] as const}
          value={view}
          onChange={(v) => setView(v)}
        />
      </div>
      {missing.length ? (
        <p className="sm warn-ink trip-bill-missing" role="status">
          {missing.map((s) => `Stay ${stayNoOf(s.entryId)}`).join(" and ")} {missing.length === 1 ? "has" : "have"} no rooms chosen yet — not in the trip&rsquo;s total.
        </p>
      ) : null}
      {view === "TOGETHER" ? (
        <>
          <table className="table compact pb-ladder trip-ladder">
            <tbody>
              {stays.map((s) => (
                <Fragment key={s.entryId}>
                  <tr className="trip-stay-h">
                    <td colSpan={3}>
                      <span className="trip-stay-hrow">
                        <span className="trip-stay-name">{name(s.entryId)}</span>
                        {s.checkIn ? <StayDates checkIn={s.checkIn} checkOut={s.checkOut} /> : null}
                        <span className="trip-stay-tot">
                          {s.pricing ? (
                            <>
                              <b className="money">{money(s.pricing.totals.total, c)}</b>
                              <span className="meta"> with taxes</span>
                            </>
                          ) : (
                            <span className="warn-ink">no rooms yet</span>
                          )}
                        </span>
                      </span>
                    </td>
                  </tr>
                  {s.pricing?.byType.map((ty) => (
                    <tr key={ty.roomTypeId} className="trip-sub">
                      <td>{ty.name}</td>
                      <td className="num meta">
                        {plural(ty.roomNights, "room-night")} × {ty.rate == null ? "no rate on file" : money(ty.rate, c)}
                      </td>
                      <td className="num money">{ty.net == null ? "—" : money(ty.net, c)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="pb-step">
                <td colSpan={2}>Net · the trip</td>
                <td className="num money">{money(t.net, c)}</td>
              </tr>
              <tr>
                <td colSpan={2}>Service charge {pct(trip.serviceChargeRate)}</td>
                <td className="num money">{money(t.serviceCharge, c)}</td>
              </tr>
              <tr>
                <td colSpan={2}>GST {pct(trip.gstRate)} · on the net and the service charge</td>
                <td className="num money">{money(t.gst, c)}</td>
              </tr>
              <tr className="pb-grand">
                <td colSpan={2}>Total for the trip</td>
                <td className="num money">{money(t.total, c)}</td>
              </tr>
            </tbody>
          </table>
          <table className="table compact pb-nights">
            <thead>
              <tr>
                <th>Night</th>
                <th>Rooms</th>
                <th className="num">That night</th>
              </tr>
            </thead>
            <tbody>
              {stays.map((s) =>
                s.pricing ? (
                  <Fragment key={s.entryId}>
                    <tr className="trip-night-h">
                      <td colSpan={3}>{name(s.entryId)}</td>
                    </tr>
                    <NightRows pricing={s.pricing} roomLabels={labelsOf(s.entryId)} />
                  </Fragment>
                ) : null,
              )}
            </tbody>
          </table>
        </>
      ) : (
        <>
          <div className="trip-each-totals">
            {stays.map((s) => (
              <span key={s.entryId} className="trip-each">
                <span className="trip-stay-name">{name(s.entryId)}</span>
                {s.pricing ? <b className="money">{money(s.pricing.totals.total, c)}</b> : <span className="warn-ink">no rooms yet</span>}
              </span>
            ))}
            <span className="trip-each trip-each-all">
              <span className="trip-stay-name">The trip</span>
              <b className="money">{money(t.total, c)}</b>
            </span>
          </div>
          {stays.map((s) =>
            s.pricing ? (
              <PickBill
                key={s.entryId}
                pricing={s.pricing}
                roomLabels={labelsOf(s.entryId)}
                title={
                  <span className="trip-each-title">
                    {name(s.entryId)}
                    {s.checkIn ? <StayDates checkIn={s.checkIn} checkOut={s.checkOut} /> : null}
                  </span>
                }
              />
            ) : (
              <p key={s.entryId} className="warn-ink">
                {name(s.entryId)} · no rooms chosen yet.
              </p>
            ),
          )}
        </>
      )}
      {caption ? <div className="meta pb-caption">{caption}</div> : null}
    </div>
  );
}

/**
 * The house card's one line for a trip (2026-11-07): the trip's total, and each stay's own on asking
 * ("an option to see all entries' total separately"). The full bill is in the booking file.
 */
export function TripPickLine({
  trip,
  stayNoOf,
  title,
  loading,
  help,
}: {
  trip: TripPickPricing;
  stayNoOf: (id: string) => number;
  title: ReactNode;
  loading?: boolean;
  help?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const c = trip.currency;
  const stays = [...trip.stays].sort((a, b) => stayNoOf(a.entryId) - stayNoOf(b.entryId));
  return (
    <div className={`trip-line${loading ? " loading" : ""}`}>
      <div className="pb-line">
        <span className="pb-line-k">
          {title} · {plural(stays.length, "stay")}
        </span>
        <b className="money">{money(trip.totals.total, c)}</b>
        <span className="meta">
          {plural(trip.totals.roomNights, "room-night")} · room only, taxes included{trip.complete ? "" : " · a stay has no rooms yet"}
        </span>
        {help ? <Help label="About this figure">{help}</Help> : null}
        <button type="button" className="trip-line-each-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide each stay" : "Each stay"}
        </button>
      </div>
      {open ? (
        <div className="trip-each-totals">
          {stays.map((s) => (
            <span key={s.entryId} className="trip-each">
              <span className="trip-stay-name">
                Stay {stayNoOf(s.entryId)}
              </span>
              {s.checkIn ? <StayDates checkIn={s.checkIn} checkOut={s.checkOut} /> : null}
              {s.pricing ? (
                <>
                  <b className="money">{money(s.pricing.totals.total, c)}</b>
                  <span className="meta">{plural(s.pricing.totals.roomNights, "room-night")}</span>
                </>
              ) : (
                <span className="warn-ink">no rooms yet</span>
              )}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
