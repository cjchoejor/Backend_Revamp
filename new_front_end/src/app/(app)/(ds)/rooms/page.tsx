"use client";

/**
 * Rooms (Surface Spec 00 §2) — for knowing, not choosing. Two sections (2026-10-12, operator):
 *
 * - **Room cards** (named "Tonight" until 2026-10-22) — what the page always showed: every room's commercial standing and its physical
 *   state, kept apart (FIG 1.14), and every hall. A tile opens the fault record: the desk reports,
 *   the FOM verifies, and a room or hall with a fault leaves the pool the moment it is reported.
 * - **Chart** — the house night by night, as on the boss's journey mockup: rooms down the side,
 *   nights across, "Free that night" and "House booked 8/27" on top, and every booking as a bar
 *   styled by how firmly it holds the room (`components/ds/rooms/room-chart.tsx`).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Button, Dialog, EmptyState, RoomTile, Tabs, type RoomPhysical, type RoomStanding } from "@/design-system";
import { RoomChartView } from "@/components/ds/rooms/room-chart";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { DeficiencyPanel } from "@/components/deficiency/deficiency-panel";
import { useDeskBookings, useRoomsList } from "@/hooks/use-desk-data";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { getRoomChart, listSpaces, type RoomChart, type RoomChartBar, type RoomListItem, type SpaceListItem } from "@/lib/api/rooms";
import { callerNameOf, guestNameOf } from "@/lib/ds/status";
import { fmtDay } from "@/lib/ds/format";
import { stepNoOfStage } from "@/lib/ds/steps";
import { groupByRoomType } from "@/lib/ds/group-by-type";

function standingOfRoom(r: RoomListItem): RoomStanding {
  if (r.isUnderMaintenance || r.isBlocked) return "ooo";
  switch ((r.currentClaimState ?? "FREE").toUpperCase()) {
    case "OCCUPIED":
      return "occupied";
    case "CONFIRMED":
      return "reserved";
    case "COMMITTED_HELD":
      return "committed-held";
    case "SPECULATIVELY_HELD":
      return "speculatively-held";
    default:
      return r.isDeficient ? "deficient" : "free";
  }
}

/**
 * What a room is TONIGHT, read off the chart's own claims (2026-10-27, operator: "it says rooms
 * 305 and 306 are held or reserved, but the chart shows nothing"). The room's stored flag is a
 * marker for the strongest claim from today on — a booking a week away included — and can be left
 * behind by a stay that ended without a check-in; the dates are the truth, the same as the chart's.
 */
type Tonight = { standing: RoomStanding; bar: RoomChartBar | null; next: RoomChartBar | null };

function standingOfBar(b: RoomChartBar): RoomStanding {
  switch (b.kind) {
    case "IN_HOUSE":
    case "OVERSTAY":
      return "occupied";
    case "RESERVED":
      return b.paymentPending ? "committed-held" : "reserved";
    case "PROVISIONAL":
      return "speculatively-held";
    default:
      return "committed-held";
  }
}

function tonightByRoom(chart: RoomChart | undefined, today: string | null): Map<string, Tonight> | null {
  if (!chart || !today) return null;
  const out = new Map<string, Tonight>();
  const rank: Record<string, number> = { OVERSTAY: 6, IN_HOUSE: 5, RESERVED: 4, MOVING: 3, HELD: 3, EXTENSION_HELD: 2, PROVISIONAL: 1, CHECKED_OUT: 0 };
  for (const room of chart.rooms) {
    const bars = chart.bars.filter((b) => b.roomId === room.id && b.kind !== "CHECKED_OUT");
    const now = bars.filter((b) => b.from <= today && today < b.to).sort((a, b) => (rank[b.kind] ?? 0) - (rank[a.kind] ?? 0))[0] ?? null;
    const next = bars.filter((b) => b.from > today).sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
    out.set(room.id, { standing: now ? standingOfBar(now) : "free", bar: now, next });
  }
  return out;
}

function physicalOfRoom(r: RoomListItem): RoomPhysical | undefined {
  if (r.isBlocked) return "blocked";
  if (r.isUnderMaintenance) return "out-of-order";
  const claim = (r.currentClaimState ?? "").toUpperCase();
  const ps = (r.physicalState ?? "").toUpperCase();
  if (claim === "DEPARTED_DIRTY" || ps === "DIRTY") return "needs-cleaning";
  if (ps === "AVAILABLE_INSPECTED") return "inspected";
  if (ps === "AVAILABLE_CLEAN" || claim === "DEPARTED_CLEAN") return "clean";
  if (ps === "UNDER_MAINTENANCE") return "out-of-order";
  return undefined;
}

const BED_WORD: Record<string, string> = { KING: "King", TWIN: "Twin", QUEEN: "Queen", SINGLE: "Single" };

type Target = { kind: "room"; id: string; label: string } | { kind: "space"; id: string; label: string };

type RoomsView = "tonight" | "chart";
const VIEW_KEY = "desk:rooms-view";

// The view lives in the address, so the page reads search params — Next wants that under Suspense.
export default function RoomsPage() {
  return (
    <Suspense fallback={null}>
      <RoomsPageBody />
    </Suspense>
  );
}

function RoomsPageBody() {
  const { session, isLoading } = useSession();
  const queryClient = useQueryClient();
  const rooms = useRoomsList();
  const bookings = useDeskBookings();
  const spaces = useQuery({
    queryKey: ["spaces"],
    queryFn: () => listSpaces(session!),
    enabled: !!session && !isLoading,
  });
  const [target, setTarget] = useState<Target | null>(null);

  // Which section — in the address (`?view=chart`), and remembered for this desk.
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [remembered, setRemembered] = useState<RoomsView | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === "chart" || v === "tonight") setRemembered(v);
    } catch {
      /* private mode — the address decides */
    }
  }, []);
  const asked = params.get("view");
  const view: RoomsView = asked === "chart" || asked === "tonight" ? asked : (remembered ?? "tonight");
  const pickView = (v: string) => {
    const next = v === "chart" ? "chart" : "tonight";
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* non-fatal */
    }
    setRemembered(next);
    const p = new URLSearchParams(params.toString());
    p.set("view", next);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTarget(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target]);

  const items = useMemo(
    () => [...(rooms.data?.items ?? [])].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true })),
    [rooms.data],
  );

  // Who is in each room tonight, and who holds it next — names only, from the bookings list.
  // Judged by each room's own nights against the hotel's day (2026-09-19): the last booking read
  // used to win, so a booking stuck at Check-in since 2 Sep named room 202 over tonight's guest.
  // Tonight's holder first (the furthest step), then the next to arrive, then the latest to leave.
  const hotelToday = useHotelDay()?.today ?? null;
  const occupant = useMemo(() => {
    const best = new Map<string, { name: string; rank: number; step: number; start: string; end: string }>();
    for (const b of bookings.data?.items ?? []) {
      const step = stepNoOfStage(b.currentStage);
      if (b.status !== "ACTIVE" || step < 4 || step > 8) continue;
      const ci = b.checkInDate?.slice(0, 10) ?? "";
      const co = b.checkOutDate?.slice(0, 10) ?? "";
      const spans = b.roomAssignments.length
        ? b.roomAssignments
            .filter((a) => !!a.room?.roomNumber)
            .map((a) => ({ room: a.room!.roomNumber, start: a.startDate?.slice(0, 10) ?? ci, end: a.endDate?.slice(0, 10) ?? co }))
        : b.roomNumbers.map((n) => ({ room: n, start: ci, end: co }));
      for (const sp of spans) {
        const rank = !hotelToday ? 0 : sp.start <= hotelToday && hotelToday < sp.end ? 3 : sp.start > hotelToday ? 2 : 1;
        const cur = best.get(sp.room);
        const better =
          !cur ||
          rank > cur.rank ||
          (rank === cur.rank &&
            (rank === 3 ? step > cur.step : rank === 2 ? sp.start < cur.start : rank === 1 ? sp.end > cur.end : step >= 6));
        if (better) best.set(sp.room, { name: guestNameOf(b.guestProfile), rank, step, start: sp.start, end: sp.end });
      }
    }
    return new Map([...best].map(([room, v]) => [room, v.name]));
  }, [bookings.data, hotelToday]);

  // Tonight and the next booking of each room, from the chart (62 nights — the chart's own ceiling).
  const chart = useQuery({
    queryKey: ["room-chart", "cards", hotelToday],
    queryFn: () => getRoomChart(session!, { from: hotelToday!, nights: 62 }),
    enabled: !!session && !isLoading && !!hotelToday && view === "tonight",
    refetchInterval: 60_000,
  });
  const tonight = useMemo(() => tonightByRoom(chart.data, hotelToday), [chart.data, hotelToday]);
  const bookingName = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of chart.data?.bookings ?? []) {
      const g = b.guestProfile && (b.guestProfile.firstName || b.guestProfile.lastName) ? guestNameOf(b.guestProfile) : null;
      m.set(b.entryId, g ?? callerNameOf(b.inquiry) ?? b.partyName ?? "a booking");
    }
    return m;
  }, [chart.data]);
  // Out of order stays the room's own fact; everything else is tonight's booking. Until the chart
  // answers, the room's flag stands in.
  const standingNow = (r: RoomListItem): RoomStanding => {
    if (r.isUnderMaintenance || r.isBlocked) return "ooo";
    const t = tonight?.get(r.id);
    if (!t) return standingOfRoom(r);
    return t.standing === "free" && r.isDeficient ? "deficient" : t.standing;
  };

  const count = (pred: (r: RoomListItem) => boolean) => items.filter(pred).length;
  const occupied = count((r) => standingNow(r) === "occupied");
  const held = count((r) => ["reserved", "committed-held", "speculatively-held"].includes(standingNow(r)));
  const out = count((r) => !!(r.isBlocked || r.isUnderMaintenance || r.isDeficient));
  const free = count((r) => standingNow(r) === "free");

  const spaceItems = spaces.data?.items ?? [];

  return (
    <div className="page">
      {/* The two sections sit beside the title, so the chart has the height below (2026-10-22). */}
      <div className="page-head lead-tabs">
        <div>
          <h2>Rooms</h2>
          <div className="meta">
            Tonight · {occupied} of {items.length} occupied · for knowing, not choosing{chart.isLoading && view === "tonight" ? " · reading tonight…" : ""}
          </div>
        </div>
        <Tabs
          items={[
            { id: "tonight", label: "Room cards" },
            { id: "chart", label: "Chart" },
          ]}
          selected={view}
          onSelect={pickView}
        />
      </div>

      {view === "chart" ? (
        <RoomChartView onOpenRoom={(r) => setTarget({ kind: "room", id: r.id, label: `Room ${r.roomNumber}` })} />
      ) : rooms.error && !rooms.data ? (
        <LoadFailed what="the rooms" onRetry={() => void rooms.refetch()} />
      ) : rooms.isLoading ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState title="No rooms configured yet">Rooms are added in the console under Inventory.</EmptyState>
      ) : (
        <>
          <div className="grid4">
            {[
              ["Free", free],
              ["Occupied", occupied],
              ["Reserved · block", held],
              ["Out of order · deficient", out],
            ].map(([k, v]) => (
              <div className="card kpi" key={k}>
                <span className="meta">{k}</span>
                <span className="figure">{v}</span>
              </div>
            ))}
          </div>

          {/* Grouped by room type (2026-10-26, operator: "show rooms here in room types category"),
              each type in the order of its lowest room number, as on the chart. */}
          <div className="type-groups flow">
            {groupByRoomType(items, (r) => r.roomType?.name, (r) => r.roomNumber).map((g) => {
              const busy = g.rooms.filter((r) => standingNow(r) === "occupied").length;
              const freeHere = g.rooms.filter((r) => standingNow(r) === "free").length;
              return (
                <div key={g.name} className="floor type-group">
                  <div className="tg-head">
                    <b>{g.name}</b>
                    <span className="meta">
                      {g.rooms.length} {g.rooms.length === 1 ? "room" : "rooms"} · {freeHere} free · {busy} occupied
                    </span>
                  </div>
                  <div className="tiles">
                    {g.rooms.map((r) => {
                      const standing = standingNow(r);
                      const t = tonight?.get(r.id) ?? null;
                      const bed = r.bedType ? BED_WORD[r.bedType] ?? r.bedType : null;
                      // A room free tonight but kept for a later stay says from when.
                      const later = t && !t.bar && t.next ? `${t.next.kind === "RESERVED" ? "reserved" : "held"} from ${fmtDay(t.next.from)}` : null;
                      const who = t?.bar ? bookingName.get(t.bar.entryId) : occupant.get(r.roomNumber);
                      return (
                        <RoomTile
                          key={r.id}
                          number={r.roomNumber}
                          standing={standing}
                          occupant={standing === "free" ? undefined : (who ?? (standing === "occupied" ? "in-house" : standing === "ooo" || standing === "deficient" ? "out of service" : "held"))}
                          physical={physicalOfRoom(r)}
                          qualifier={r.isDeficient && standing !== "deficient" ? "fault reported" : undefined}
                          note={later ? <span>{bed ? `${bed} · ` : ""}{later}</span> : (bed ?? undefined)}
                          onSelect={() => setTarget({ kind: "room", id: r.id, label: `Room ${r.roomNumber}` })}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="meta">
            {items.length} rooms · select one to report a fault or see one already reported. A room&apos;s status changes through its own work — check-out,
            housekeeping, inspection — not from this board.
          </p>

          <section className="block">
            <div className="block-head">
              <h3>Halls and spaces</h3>
              <span className="meta">a hall with an open fault is refused when a booking asks for it</span>
            </div>
            {spaces.error && !spaces.data ? (
              <LoadFailed what="the spaces" onRetry={() => void spaces.refetch()} />
            ) : spaces.isLoading ? (
              <LoadingBlock />
            ) : spaceItems.length === 0 ? (
              <EmptyState title="No halls or spaces configured">They are added in the console under Inventory → Spaces.</EmptyState>
            ) : (
              <div className="floor">
                <div className="tiles">
                  {spaceItems.map((s: SpaceListItem) => (
                    <RoomTile
                      key={s.id}
                      number={s.code}
                      standing={s.isDeficient ? "deficient" : !s.isAvailable ? "ooo" : s.isEventInProgress ? "occupied" : "free"}
                      occupant={s.isEventInProgress ? "event in progress" : undefined}
                      note={`${s.name} · ${s.capacity || s.defaultCapacity} seats`}
                      onSelect={() => setTarget({ kind: "space", id: s.id, label: s.name })}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {target ? (
        <div className="scrim open" onClick={(e) => e.target === e.currentTarget && setTarget(null)}>
          <Dialog
            register="report"
            title={`Faults · ${target.label}`}
            footer={
              <Button kind="quiet" onClick={() => setTarget(null)}>
                Close
              </Button>
            }
          >
            <p className="sm">Report a fault, or review one already raised. The desk reports; the FOM verifies or rejects.</p>
            <DeficiencyPanel
              target={target.kind === "room" ? { roomId: target.id } : { spaceId: target.id }}
              targetLabel={target.label}
              onChanged={() => {
                void queryClient.invalidateQueries({ queryKey: target.kind === "room" ? ["rooms"] : ["spaces"] });
                void queryClient.invalidateQueries({ queryKey: ["room-chart"] });
              }}
            />
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
