"use client";

/**
 * The bill for the rooms on the table (2026-10-10, operator, after the boss's journey mockup:
 * "it shows total amount of the cost of rooms booked in a day and per day and all together").
 *
 * Every figure is the server's (`POST /entries/:id/availability/price-pick`): each night with
 * its rooms and what that night comes to, each room type as room-nights × rate, then net,
 * service charge, GST and the stay's total. The desk prints them and adds nothing up. Room
 * only — meals, extra beds and an agreed rate are set on the table at Negotiation, which is
 * also where the quotation prices it exactly.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { pricePick, type PickPricing } from "@/lib/api/availability";
import { fmtDay, money, plural } from "@/lib/ds/format";

export type BillNight = { date: string; roomIds: string[] };

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (iso: string) => WEEKDAY[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()] ?? "";
const pct = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
const nextDay = (iso: string) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A room's nights as spans ending on the checkout morning: "4 → 7 Dec", "4 → 5 Dec · 6 → 7 Dec". */
function spansLabel(nights: string[]): string {
  const sorted = [...new Set(nights.map((n) => n.slice(0, 10)))].sort();
  const spans: Array<{ from: string; last: string }> = [];
  for (const n of sorted) {
    const cur = spans[spans.length - 1];
    if (cur && nextDay(cur.last) === n) cur.last = n;
    else spans.push({ from: n, last: n });
  }
  return spans
    .map(({ from, last }) => {
      const to = nextDay(last);
      const [a, b] = [fmtDay(from), fmtDay(to)];
      const sameMonth = a.split(" ")[1] === b.split(" ")[1];
      return sameMonth ? `${a.split(" ")[0]} → ${b}` : `${a} → ${b}`;
    })
    .join(" · ");
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
  const pkg = p.byType.find((t) => t.packageName)?.packageName ?? null;
  if (p.party) return `${p.party.name}${pkg ? ` · ${pkg}` : ""}`;
  return "published rates";
}

/** Each room type's total, taxes included — the server's allocation, so they add up to the stay. */
function TypeTotals({ pricing }: { pricing: PickPricing }) {
  const priced = pricing.byType.filter((t) => t.total != null);
  if (!priced.length) return null;
  return (
    <span className="pb-types">
      {priced.map((t) => (
        <span key={t.roomTypeId} className="pb-type" title={`${plural(t.roomNights, "room-night")} × ${money(t.rate, pricing.currency)} + service charge + GST`}>
          <span className="pb-type-name">{t.name}</span>
          <span className="pb-type-n">{plural(t.roomNights, "room-night")}</span>
          <b className="money">{money(t.total, pricing.currency)}</b>
        </span>
      ))}
    </span>
  );
}

export function PickBill({
  pricing,
  loading,
  title,
  caption,
}: {
  pricing: PickPricing;
  loading?: boolean;
  title: ReactNode;
  caption?: ReactNode;
}) {
  const c = pricing.currency;
  const t = pricing.totals;
  return (
    <div className={`pickbill${loading ? " loading" : ""}`} aria-busy={loading || undefined}>
      <div className="pb-head">
        <span className="pb-title">{title}</span>
        <span className="pb-total money">{money(t.total, c)}</span>
        <span className="pb-sub">
          {plural(t.roomNights, "room-night")} · {plural(pricing.nights.length, "night")} · incl. {pct(pricing.serviceChargeRate)} service charge +{" "}
          {pct(pricing.gstRate)} GST · room only · {basisWords(pricing)}
        </span>
      </div>
      <TypeTotals pricing={pricing} />

      <table className="table compact pb-nights">
        <thead>
          <tr>
            <th>Night</th>
            <th>Rooms</th>
            <th className="num">That night</th>
          </tr>
        </thead>
        <tbody>
          {pricing.nights.map((n) => {
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
                    {n.rooms.map((r) => (
                      <span key={r.roomId} className="pb-room">
                        {r.roomNumber}
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
        </tbody>
      </table>

      {pricing.byRoom.length ? (
        <div className="pb-byroom meta">
          Rooms:{" "}
          {pricing.byRoom.map((r, i) => (
            <span key={r.roomId}>
              {i ? " · " : ""}
              <b>{r.roomNumber}</b> {spansLabel(r.dates)} ({plural(r.dates.length, "night")})
            </span>
          ))}
        </div>
      ) : null}

      <table className="table compact pb-ladder">
        <tbody>
          {pricing.byType.map((ty) => (
            <tr key={ty.roomTypeId}>
              <td>{ty.name}</td>
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
      {pricing.unpricedTypes.length ? (
        <div className="sm warn-ink" style={{ marginTop: 6 }}>
          No rate on file for {pricing.unpricedTypes.map((x) => x.name).join(", ")} — those nights are left out of the total.
        </div>
      ) : null}
      {caption ? <div className="meta pb-caption">{caption}</div> : null}
    </div>
  );
}
