"use client";

/**
 * Today (Surface Spec 01) — what needs a person now, the incomplete record, and the hotel's day.
 *
 * Every list here is a selection from the bookings read by date and step (SS01 §7); the backend's
 * own Today feed is register item SS01-P1. Money on the Leaving list is the booking header's
 * billing summary, read per row — nothing is worked out here.
 *
 * Tabs since 2026-11-12 (operator: "todays' tab to be made into tabs instead just single page"):
 * each list is a tab of its own, its count on the tab, the tab in the address (`?tab=`), the page
 * holding still when the tab changes.
 */
import { StayDates } from "@/components/ds/stay-dates";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, type ReactNode } from "react";
import { Button, EmptyState, Tabs } from "@/design-system";
import { Help } from "@/components/ds/help";
import {
  GuestLink,
  LoadFailed,
  LoadingBlock,
  MoreRow,
  OpenRow,
  RowStanding,
  StepChip,
  TimerText,
  bookingMeta,
  usePaged,
} from "@/components/ds/ui";
import { useDeskBookings, useDeskMoney, useRoomsList } from "@/hooks/use-desk-data";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHousekeepingBoard } from "@/hooks/use-housekeeping";
import { useHotelDay } from "@/hooks/use-hotel-day";
import type { DeskListRow } from "@/lib/api/desk";
import type { HousekeepingRoom } from "@/lib/api/housekeeping";
import {
  attentionItems,
  dayLists,
  foldAttention,
  isFold,
  nightsLeft,
  waitingText,
  type AttentionItem,
  type Fold,
} from "@/lib/ds/attention";
import { fmtDay, fmtInstantDay, fmtLongDate, fmtRange, fmtTime, money, plural, span } from "@/lib/ds/format";
import { stepNoOfStage } from "@/lib/ds/steps";

const BANDS_OVER = 15;

type TabId = "attention" | "arriving" | "leaving" | "inhouse" | "clean" | "week" | "inquiries" | "parked" | "tidy";
const TAB_IDS: TabId[] = ["attention", "arriving", "leaving", "inhouse", "clean", "week", "inquiries", "parked", "tidy"];

function roomsWord(r: DeskListRow): string {
  if (r.roomNumbers.length) return r.roomNumbers.join(", ");
  if (r.numberOfRooms) return plural(r.numberOfRooms, "room");
  return "—";
}

/** A tab's count: red while something there is late, amber while something is due soon. */
function TabLabel({ text, n, tone }: { text: string; n: number; tone?: "stop" | "warn" | null }) {
  return (
    <>
      {text}
      <span className={`tab-n${n && tone ? ` ${tone}` : ""}`}>{n}</span>
    </>
  );
}

function AttentionTable({ rows, now, tz }: { rows: Array<AttentionItem | Fold>; now: number; tz: string }) {
  // The first fifteen, then fifteen more at a time (2026-09-25) — not the whole table at once.
  const paged = usePaged(rows);
  return (
    <table className="table zebra">
      <thead>
        <tr>
          <th>Booking</th>
          <th>Step</th>
          <th>Needs</th>
          <th>Waiting</th>
        </tr>
      </thead>
      <tbody>
        {paged.shown.map((it, i) =>
          isFold(it) ? (
            <tr key={`fold:${it.key}`} className={`static${i % 2 ? " alt" : ""}`}>
              <td>
                <b>{it.count} bookings</b>
                <div className="meta">{it.sourceWord}</div>
              </td>
              <td>
                <StepChip step={it.step} />
              </td>
              <td>{it.need} · identical work from one source</td>
              <td>
                <Link className="row-link" href={`/bookings?q=${encodeURIComponent(it.sourceWord)}`}>
                  open Bookings filtered to them
                </Link>
              </td>
            </tr>
          ) : (
            <OpenRow key={it.key} entryId={it.entryId} step={it.step} alt={i % 2 === 1}>
              <td>
                <Link className={`row-link${it.named ? "" : " name-i"}`} href={`/bookings/${encodeURIComponent(it.entryId)}?step=${it.step}`} onClick={(e) => e.stopPropagation()}>
                  {it.name}
                </Link>
                <div className="meta">{it.meta}</div>
              </td>
              <td>
                <StepChip step={it.step} />
              </td>
              <td>
                {it.critical ? <span className="crit-tag">Critical</span> : null} {it.need}
              </td>
              <td>
                <TimerText w={waitingText(it, now, tz)} />
              </td>
            </OpenRow>
          ),
        )}
        <MoreRow more={paged.more} onMore={paged.showMore} colSpan={4} />
      </tbody>
    </table>
  );
}

/** One of the hotel's day lists, set out across the page. */
function DayTable({
  rows,
  heads,
  cells,
  href,
  empty,
  foot,
}: {
  rows: DeskListRow[];
  heads: ReactNode[];
  cells: (r: DeskListRow) => ReactNode[];
  href: string;
  empty: [string, string?];
  foot?: ReactNode;
}) {
  const paged = usePaged(rows);
  if (!rows.length) return <EmptyState title={empty[0]}>{empty[1] || null}</EmptyState>;
  return (
    <>
      <table className="table zebra">
        <thead>
          <tr>
            {heads.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paged.shown.map((r, i) => (
            <OpenRow key={r.id} entryId={r.id} alt={i % 2 === 1}>
              {cells(r).map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </OpenRow>
          ))}
          <MoreRow more={paged.more} onMore={paged.showMore} href={href} colSpan={heads.length} />
        </tbody>
      </table>
      {foot ? (
        <div className="meta" style={{ marginTop: 6 }}>
          {foot}
        </div>
      ) : null}
    </>
  );
}

const who = (r: DeskListRow, withMeta = true) => (
  <>
    <GuestLink row={r} />
    {withMeta ? <div className="meta">{bookingMeta(r, false) || "Direct"}</div> : null}
  </>
);
const stay = (r: DeskListRow) => (
  <span className="stay-range">
    <StayDates stacked checkIn={r.checkInDate} checkOut={r.actualCheckOutDate ?? r.checkOutDate} />
  </span>
);

function TodayPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const clock = useHotelClock(30_000);
  const hotelDay = useHotelDay();
  const today = hotelDay?.today ?? null;
  const bookings = useDeskBookings();
  const rooms = useRoomsList();
  const board = useHousekeepingBoard();
  const rows = useMemo(() => bookings.data?.items ?? [], [bookings.data]);
  const minute = Math.floor(clock.now / 60_000);

  const items = useMemo(
    () => attentionItems(rows, clock.now, today, clock.tz, bookings.data?.repliesOff),
    // re-derived once a minute, not on every clock tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, today, clock.tz, minute],
  );
  const lists = useMemo(() => dayLists(rows, today, clock.tz), [rows, today, clock.tz]);

  const week = useMemo(() => {
    if (!today) return [];
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    return rows
      .filter((r) => {
        const ci = r.checkInDate?.slice(0, 10);
        const step = stepNoOfStage(r.currentStage);
        return r.status === "ACTIVE" && step >= 4 && step <= 5 && !!ci && ci > today && ci <= end;
      })
      .sort((a, b) => (a.checkInDate ?? "").localeCompare(b.checkInDate ?? ""));
  }, [rows, today]);

  const leavingIds = useMemo(() => lists.leaving.map((r) => r.id), [lists.leaving]);
  const leavingMoney = useDeskMoney(leavingIds);

  const roomItems = rooms.data?.items ?? [];
  const occupied = roomItems.filter((r) => r.currentClaimState?.toUpperCase() === "OCCUPIED").length;
  const toClean = (board.data?.rooms ?? []).filter((r) => r.state === "TO_CLEAN");
  const lateRooms = toClean.filter((r) => r.toClean?.overdue || (r.toClean?.cleanBy && Date.parse(r.toClean.cleanBy) <= clock.now));

  const overdue = items.filter((i) => i.band === "overdue");
  const soon = items.filter((i) => i.band === "soon");
  const waiting = items.filter((i) => i.band === "waiting");
  const banded = items.length > BANDS_OVER;
  const endOfWeek = today ? new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) : null;
  const tomorrow = today ? new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
  const tidyCount = lists.noOutcome.length + lists.noDate.length;

  const asked = params.get("tab") as TabId | null;
  const tab: TabId = asked && TAB_IDS.includes(asked) ? asked : "attention";
  const pick = (id: string) => {
    const p = new URLSearchParams(params.toString());
    if (id === "attention") p.delete("tab");
    else p.set("tab", id);
    router.replace(`/today${p.toString() ? `?${p.toString()}` : ""}`, { scroll: false });
  };

  const loading = bookings.isLoading || !today;

  return (
    <div className="page today-page">
      <div className="page-head">
        <div>
          <h2>Today</h2>
          <div className="meta">
            {today ? fmtLongDate(today) : "Checking the hotel's date…"}
            {roomItems.length ? (
              <>
                {" "}· rooms occupied tonight <b>{occupied}</b> of {roomItems.length}
              </>
            ) : null}
          </div>
        </div>
        <Button onClick={() => router.push("/bookings/new")}>New booking</Button>
      </div>

      <div className="page-head lead-tabs today-tabs">
        <Tabs
          items={[
            { id: "attention", label: <TabLabel text="Needs attention" n={items.length} tone={overdue.length ? "stop" : soon.length ? "warn" : null} /> },
            { id: "arriving", label: <TabLabel text="Arriving today" n={lists.arriving.length} /> },
            { id: "leaving", label: <TabLabel text="Leaving today" n={lists.leaving.length} /> },
            { id: "inhouse", label: <TabLabel text="In-house" n={lists.inHouse.length} /> },
            { id: "clean", label: <TabLabel text="Rooms to clean" n={toClean.length} tone={lateRooms.length ? "stop" : null} /> },
            { id: "week", label: <TabLabel text="Next 7 days" n={week.length} /> },
            { id: "inquiries", label: <TabLabel text="New inquiries" n={lists.newInquiries.length} /> },
            { id: "parked", label: <TabLabel text="Parked" n={lists.parked.length} /> },
            ...(tidyCount || tab === "tidy" ? [{ id: "tidy", label: <TabLabel text="To tidy" n={tidyCount} tone="warn" /> }] : []),
          ]}
          selected={tab}
          onSelect={pick}
        />
      </div>

      {bookings.error && !bookings.data ? (
        <LoadFailed what="today's bookings" onRetry={() => void bookings.refetch()} />
      ) : loading ? (
        <LoadingBlock />
      ) : tab === "attention" ? (
        <section className="block" data-today-tab="attention">
          <div className="block-head">
            <span className="meta">
              {plural(items.length, "thing")} · {overdue.length} overdue · {soon.length} within the next hours · {waiting.length} waiting
            </span>
          </div>
          {items.length === 0 ? (
            <EmptyState title="Nothing needs attention">Every booking is where it should be for now.</EmptyState>
          ) : banded ? (
            <>
              {overdue.length ? (
                <>
                  <h4 style={{ margin: "6px 0" }}>
                    Overdue <span className="meta">{overdue.length}</span>
                  </h4>
                  <AttentionTable rows={foldAttention(overdue)} now={clock.now} tz={clock.tz} />
                </>
              ) : null}
              {soon.length ? (
                <>
                  <h4 style={{ margin: "12px 0 6px" }}>
                    Within the next hours <span className="meta">{soon.length}</span>
                  </h4>
                  <AttentionTable rows={foldAttention(soon)} now={clock.now} tz={clock.tz} />
                </>
              ) : null}
              {waiting.length ? (
                <details className="fold" style={{ marginTop: 12 }}>
                  <summary>
                    Waiting · {waiting.length}
                    <Help label="About waiting">Nothing here is due yet. Open it to see each one.</Help>
                  </summary>
                  <div className="fold-body">
                    <AttentionTable rows={foldAttention(waiting)} now={clock.now} tz={clock.tz} />
                  </div>
                </details>
              ) : null}
            </>
          ) : (
            <AttentionTable rows={foldAttention(items)} now={clock.now} tz={clock.tz} />
          )}
        </section>
      ) : tab === "arriving" ? (
        <section className="block" data-today-tab="arriving">
          <DayTable
            rows={lists.arriving}
            heads={["Booking", "Stay", "Rooms", "Where it stands"]}
            cells={(r) => [who(r), stay(r), roomsWord(r), <RowStanding key="s" row={r} hotelToday={today} />]}
            href={`/bookings?from=${today}&to=${today}`}
            empty={["No arrivals today"]}
          />
        </section>
      ) : tab === "leaving" ? (
        <section className="block" data-today-tab="leaving">
          <DayTable
            rows={lists.leaving}
            heads={[
              "Booking",
              "Stay",
              "Rooms",
              "Where it stands",
              <span key="b" className="num">
                Balance due
                <Help label="About the balance">What is still owed on the bill, after the advance and any credits.</Help>
              </span>,
            ]}
            cells={(r) => {
              const m = leavingMoney.byId.get(r.id);
              const bal = m?.folio?.outstandingBalance;
              return [
                who(r),
                stay(r),
                roomsWord(r),
                <RowStanding key="s" row={r} hotelToday={today} />,
                <span key="b" className={`num ${bal != null ? "money" : "dash"}`} style={{ display: "block", textAlign: "right" }}>
                  {bal != null ? money(bal, m?.currency ?? "BTN") : "—"}
                </span>,
              ];
            }}
            href="/bookings?group=In-house"
            empty={["No departures today"]}
          />
        </section>
      ) : tab === "inhouse" ? (
        <section className="block" data-today-tab="inhouse">
          <DayTable
            rows={lists.inHouse}
            heads={["Booking", "Stay", "Rooms", "Leaves"]}
            cells={(r) => [who(r), stay(r), roomsWord(r), <span key="l" className="ink-2">{nightsLeft(r, today)}</span>]}
            href="/bookings?group=In-house"
            empty={["Nobody in-house"]}
          />
        </section>
      ) : tab === "clean" ? (
        <section className="block" data-today-tab="clean">
          <RoomsToClean rooms={toClean} loaded={!!board.data} now={clock.now} tz={clock.tz} />
        </section>
      ) : tab === "week" ? (
        <section className="block" data-today-tab="week">
          <div className="block-head">
            <span className="meta">
              Arriving {tomorrow && endOfWeek ? fmtRange(tomorrow, endOfWeek) : "the next 7 days"}
            </span>
          </div>
          {week.length ? (
            <WeekTable rows={week} today={today} href={`/bookings?group=Upcoming&from=${tomorrow}&to=${endOfWeek}`} />
          ) : (
            <EmptyState title="Nothing arriving in the next 7 days" />
          )}
        </section>
      ) : tab === "inquiries" ? (
        <section className="block" data-today-tab="inquiries">
          <DayTable
            rows={lists.newInquiries}
            heads={["Booking", "Stay", "Where it stands"]}
            cells={(r) => [who(r), r.checkInDate ? stay(r) : <span key="d" className="ink-2">no dates yet</span>, <RowStanding key="s" row={r} hotelToday={today} />]}
            href="/bookings?group=Inquiry"
            empty={["No new inquiries today"]}
          />
        </section>
      ) : tab === "parked" ? (
        <section className="block" data-today-tab="parked">
          <DayTable
            rows={lists.parked}
            heads={["Booking", "Why it was parked", "Follow up"]}
            cells={(r) => [
              who(r),
              <span key="w">{r.parkReason ?? "—"}</span>,
              <span key="f" className="ink-2">{r.parkFollowUpAt ? fmtInstantDay(r.parkFollowUpAt, clock.tz) : "—"}</span>,
            ]}
            href="/bookings?group=Parked"
            empty={["Nothing parked", "A parked booking returns to Needs attention on its follow-up date."]}
          />
        </section>
      ) : (
        <section className="block" data-today-tab="tidy">
          <div className="block-head">
            <span className="meta">
              The record to tidy
              <Help label="About this list">A quiet-hour job: nothing here can be done for a guest today. It is the record to tidy.</Help>
            </span>
          </div>
          {tidyCount ? (
            <div className="grid2">
              <div>
                <div className="fact">
                  <span className="k">
                    {plural(lists.noOutcome.length, "outcome")} never recorded
                    <Help label="About outcomes never recorded">
                      Inquiries whose dates have passed with nothing written down — nobody can tell which were lost to a full house and
                      which went elsewhere. Open each and cancel it with the guest&apos;s words, so the reason is kept.
                    </Help>
                  </span>
                </div>
                <div className="row-acts">
                  <Button kind="secondary" compact onClick={() => router.push("/bookings?view=nooutcome")}>
                    Open the list
                  </Button>
                </div>
              </div>
              <div>
                <div className="fact">
                  <span className="k">
                    {plural(lists.noDate.length, "inquiry", "inquiries")} with no dates
                    <Help label="About inquiries with no dates">Open inquiries with no stay dates. They are recorded, but nothing can chase them until a date is entered.</Help>
                  </span>
                </div>
                <div className="row-acts">
                  <Button kind="secondary" compact onClick={() => router.push("/bookings?view=nodate")}>
                    Open the list
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState title="Nothing to tidy">Every inquiry has its dates and every past one its outcome.</EmptyState>
          )}
        </section>
      )}
    </div>
  );
}

export default function TodayPage() {
  return (
    <Suspense fallback={null}>
      <TodayPageInner />
    </Suspense>
  );
}

function WeekTable({ rows, today, href }: { rows: DeskListRow[]; today: string | null; href: string }) {
  const paged = usePaged(rows);
  return (
    <table className="table zebra">
      <thead>
        <tr>
          <th>Booking</th>
          <th>Stay</th>
          <th>Rooms</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {paged.shown.map((r, i) => (
          <OpenRow key={r.id} entryId={r.id} alt={i % 2 === 1}>
            <td>
              <GuestLink row={r} />
              <div className="meta">{bookingMeta(r)}</div>
            </td>
            <td>
              <span className="stay-range">
                <StayDates stacked checkIn={r.checkInDate} checkOut={r.checkOutDate} />
              </span>
            </td>
            <td>{r.roomNumbers.length || r.numberOfRooms || "—"}</td>
            <td>
              <RowStanding row={r} hotelToday={today} />
            </td>
          </OpenRow>
        ))}
        <MoreRow more={paged.more} onMore={paged.showMore} href={href} />
      </tbody>
    </table>
  );
}

/** The rooms a guest has left, waiting to be cleaned (2026-10-26) — late ones first, in red. */
function RoomsToClean({ rooms, loaded, now, tz }: { rooms: HousekeepingRoom[]; loaded: boolean; now: number; tz: string }) {
  const paged = usePaged(rooms);
  if (!rooms.length) return <EmptyState title={loaded ? "Every room is clean" : "Checking the rooms…"} />;
  return (
    <table className="table zebra">
      <thead>
        <tr>
          <th>Room</th>
          <th>Left by</th>
          <th>Next guest</th>
          <th>Clean by</th>
        </tr>
      </thead>
      <tbody>
        {paged.shown.map((r, i) => {
          const due = r.toClean?.cleanBy ? new Date(r.toClean.cleanBy).getTime() : null;
          const late = r.toClean?.overdue || (due != null && due <= now);
          return (
            <tr key={r.roomId} className={i % 2 ? "alt" : undefined}>
              <td>
                <Link className="row-link" href="/housekeeping">
                  <b>Room {r.roomNumber}</b>
                </Link>
                <div className="meta">{r.roomTypeName ?? ""}</div>
              </td>
              <td>
                {r.toClean?.leftBy ? (
                  <Link className="row-link" href={`/bookings/${encodeURIComponent(r.toClean.leftBy.entryId)}`}>
                    {r.toClean.leftBy.guestName ?? r.toClean.leftBy.entryId}
                  </Link>
                ) : (
                  "—"
                )}
                {r.toClean?.leftAt ? <div className="meta">left {fmtInstantDay(r.toClean.leftAt, tz)}, {fmtTime(r.toClean.leftAt, tz)}</div> : null}
              </td>
              <td>
                {r.nextGuest ? (
                  <>
                    {r.nextGuest.arrivesToday ? <b>{r.nextGuest.guestName ?? r.nextGuest.entryId}</b> : <span>{r.nextGuest.guestName ?? r.nextGuest.entryId}</span>}
                    <div className="meta">
                      {r.nextGuest.arrivesToday ? "arrives today" : `arrives ${fmtDay(r.nextGuest.arrives)}`}
                      {r.nextGuest.expectedArrivalTime ? ` · ${r.nextGuest.expectedArrivalTime}` : ""}
                    </div>
                  </>
                ) : (
                  <span className="ink-2">—</span>
                )}
              </td>
              <td>
                {due == null ? "—" : late ? <b className="stop-ink">late {span(now - due)}</b> : <span className="ink-2">by {fmtTime(r.toClean!.cleanBy, tz)}</span>}
              </td>
            </tr>
          );
        })}
        <MoreRow more={paged.more} onMore={paged.showMore} href="/housekeeping" colSpan={4} />
      </tbody>
    </table>
  );
}
