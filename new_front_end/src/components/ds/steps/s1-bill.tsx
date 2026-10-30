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
import type { ReactNode } from "react";
import { Help } from "@/components/ds/help";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { pricePick, type PickPricing } from "@/lib/api/availability";
import { fmtDay, money, plural } from "@/lib/ds/format";

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
  const pkg = p.byType.find((t) => t.packageName)?.packageName ?? null;
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
        <span className="pb-total money">{money(t.total, c)}</span>
        <span className="pb-sub">
          {plural(t.roomNights, "room-night")} · {plural(pricing.nights.length, "night")} · incl. {pct(pricing.serviceChargeRate)} service charge +{" "}
          {pct(pricing.gstRate)} GST · room only · {basisWords(pricing)}
        </span>
      </div>
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
