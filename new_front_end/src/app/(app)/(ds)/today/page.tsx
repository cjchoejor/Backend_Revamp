"use client";

/**
 * Today (Surface Spec 01) — what needs a person now, the incomplete record, and the hotel's day.
 *
 * Every list here is a selection from the bookings read by date and step (SS01 §7); the backend's
 * own Today feed is register item SS01-P1. Money on the Leaving list is the booking header's
 * billing summary, read per row — nothing is worked out here.
 *
 * The day at a glance (2026-11-12, operator: "todays' tab to be made into tabs", then "can the
 * todays' page be shown in a very creative and efficient way"): a row of tiles, one per list, each
 * with its number large, one line on what is in it, and for the arrivals and departures how far the
 * day has got. A tile opens its list below; the tile in the address (`?tab=`), the page holding still.
 */
import { StayDates } from "@/components/ds/stay-dates";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, type ReactNode } from "react";
import { Button, EmptyState } from "@/design-system";
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

type Tone = "stop" | "warn" | "ok" | null;

function roomsWord(r: DeskListRow): string {
  if (r.roomNumbers.length) return r.roomNumbers.join(", ");
  if (r.numberOfRooms) return plural(r.numberOfRooms, "room");
  return "—";
}

const ymd = (iso: string | null | undefined) => iso?.slice(0, 10) ?? null;

/* ------------------------------------------------------------------ the tiles */

type Tile = {
  id: TabId;
  label: string;
  n: number;
  /** One line on what is in it; its colour says how it stands. */
  sub: ReactNode;
  tone: Tone;
  /** For the arrivals and departures: how far the day has got. */
  progress?: { done: number; total: number };
};

function Glance({ tiles, selected, onSelect }: { tiles: Tile[]; selected: TabId; onSelect: (id: TabId) => void }) {
  return (
    <div className="glance" role="tablist" aria-label="Today's lists" style={{ ["--tiles" as string]: tiles.length }}>
      {tiles.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === selected}
          data-tile={t.id}
          className={`glance-tile${t.tone ? ` ${t.tone}` : ""}${t.n === 0 ? " zero" : ""}`}
          onClick={() => onSelect(t.id)}
        >
          <span className="gt-label">{t.label}</span>
          <span className="gt-n">{t.n}</span>
          {t.progress && t.progress.total > 0 ? (
            <span className="gt-bar" aria-hidden>
              <i style={{ width: `${Math.round((t.progress.done / t.progress.total) * 100)}%` }} />
            </span>
          ) : null}
          <span className="gt-sub">{t.sub}</span>
        </button>
      ))}
    </div>
  );
}

/** Rooms occupied tonight, as a meter beside the title. */
function Occupancy({ occupied, total }: { occupied: number; total: number }) {
  if (!total) return null;
  return (
    <div className="occ-meter" title={`${occupied} of ${total} rooms have a guest in them tonight`}>
      <span className="occ-k">Rooms tonight</span>
      <span className="occ-n">
        <b>{occupied}</b> of {total} occupied
      </span>
      <span className="occ-bar" aria-hidden>
        <i style={{ width: `${Math.round((occupied / total) * 100)}%` }} />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ the lists */

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

/** One of the hotel's day lists, set out across the page; what is already done sits under its own band. */
function DayTable({
  rows,
  done,
  doneWord,
  heads,
  cells,
  href,
  empty,
}: {
  rows: DeskListRow[];
  done?: DeskListRow[];
  doneWord?: string;
  heads: ReactNode[];
  cells: (r: DeskListRow) => ReactNode[];
  href: string;
  empty: [string, string?];
}) {
  const paged = usePaged(rows);
  const finished = done ?? [];
  if (!rows.length && !finished.length) return <EmptyState title={empty[0]}>{empty[1] || null}</EmptyState>;
  return (
    <table className="table zebra">
      <thead>
        <tr>
          {heads.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length ? null : (
          <tr className="static">
            <td colSpan={heads.length} className="meta">
              {empty[0]} still to come.
            </td>
          </tr>
        )}
        {paged.shown.map((r, i) => (
          <OpenRow key={r.id} entryId={r.id} alt={i % 2 === 1}>
            {cells(r).map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </OpenRow>
        ))}
        <MoreRow more={paged.more} onMore={paged.showMore} href={href} colSpan={heads.length} />
        {finished.length ? (
          <>
            <tr className="list-band done-band">
              <td colSpan={heads.length}>
                ✓ {doneWord}
                <span className="n">{finished.length}</span>
              </td>
            </tr>
            {finished.map((r, i) => (
              <OpenRow key={`done:${r.id}`} entryId={r.id} alt={i % 2 === 1}>
                {cells(r).map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </OpenRow>
            ))}
          </>
        ) : null}
      </tbody>
    </table>
  );
}

const who = (r: DeskListRow) => (
  <>
    <GuestLink row={r} />
    <div className="meta">{bookingMeta(r, false) || "Direct"}</div>
  </>
);
const stay = (r: DeskListRow) => (
  <span className="stay-range">
    <StayDates stacked checkIn={r.checkInDate} checkOut={r.actualCheckOutDate ?? r.checkOutDate} />
  </span>
);

/* ------------------------------------------------------------------ the page */

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

  // How far the day has got: who has already come in today, and who has already left.
  const arrivedToday = useMemo(() => lists.inHouse.filter((r) => ymd(r.checkInDate) === today), [lists.inHouse, today]);
  const leftToday = useMemo(
    () =>
      rows.filter(
        (r) =>
          stepNoOfStage(r.currentStage) === 9 &&
          r.status !== "CANCELLED" &&
          r.status !== "EXPIRED" &&
          !r.noShowDetermination &&
          ymd(r.actualCheckOutDate ?? r.checkOutDate) === today,
      ),
    [rows, today],
  );

  const week = useMemo(() => {
    if (!today) return [];
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    return rows
      .filter((r) => {
        const ci = ymd(r.checkInDate);
        const step = stepNoOfStage(r.currentStage);
        return r.status === "ACTIVE" && step >= 4 && step <= 5 && !!ci && ci > today && ci <= end;
      })
      .sort((a, b) => (a.checkInDate ?? "").localeCompare(b.checkInDate ?? ""));
  }, [rows, today]);

  const moneyIds = useMemo(() => [...lists.leaving, ...leftToday].map((r) => r.id), [lists.leaving, leftToday]);
  const leavingMoney = useDeskMoney(moneyIds);
  const owes = (r: DeskListRow) => {
    const bal = leavingMoney.byId.get(r.id)?.folio?.outstandingBalance;
    return bal != null && Number(bal) > 0;
  };
  const owing = lists.leaving.filter(owes).length;

  const roomItems = rooms.data?.items ?? [];
  const occupied = roomItems.filter((r) => r.currentClaimState?.toUpperCase() === "OCCUPIED").length;
  const toClean = (board.data?.rooms ?? []).filter((r) => r.state === "TO_CLEAN");
  const lateRooms = toClean.filter((r) => r.toClean?.overdue || (r.toClean?.cleanBy && Date.parse(r.toClean.cleanBy) <= clock.now));
  const neededToday = toClean.filter((r) => r.nextGuest?.arrivesToday).length;

  const overdue = items.filter((i) => i.band === "overdue");
  const soon = items.filter((i) => i.band === "soon");
  const waiting = items.filter((i) => i.band === "waiting");
  const banded = items.length > BANDS_OVER;
  const endOfWeek = today ? new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) : null;
  const tomorrow = today ? new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
  const tidyCount = lists.noOutcome.length + lists.noDate.length;
  const followUpDue = lists.parked.filter((r) => r.parkFollowUpAt && Date.parse(r.parkFollowUpAt) <= clock.now).length;
  const guestsIn = lists.inHouse.reduce((n, r) => n + (r.guestCount ?? (r.adultCount ?? 0) + (r.childCount ?? 0)), 0);
  const roomsIn = lists.inHouse.reduce((n, r) => n + (r.roomNumbers.length || r.numberOfRooms || 0), 0);

  const asked = params.get("tab") as TabId | null;
  const tab: TabId = asked && TAB_IDS.includes(asked) ? asked : "attention";
  const pick = (id: TabId) => {
    const p = new URLSearchParams(params.toString());
    if (id === "attention") p.delete("tab");
    else p.set("tab", id);
    router.replace(`/today${p.toString() ? `?${p.toString()}` : ""}`, { scroll: false });
  };

  const arrivalsTotal = lists.arriving.length + arrivedToday.length;
  const departuresTotal = lists.leaving.length + leftToday.length;

  const tiles: Tile[] = [
    {
      id: "attention",
      label: "Needs attention",
      n: items.length,
      tone: overdue.length ? "stop" : soon.length ? "warn" : items.length ? null : "ok",
      sub: items.length ? (
        <>
          {overdue.length ? <b className="stop-ink">{overdue.length} overdue</b> : <span>none overdue</span>}
          {soon.length ? <> · <b className="warn-ink">{soon.length} due soon</b></> : null}
          {waiting.length ? <> · {waiting.length} waiting</> : null}
        </>
      ) : (
        <span className="ok-ink">all clear</span>
      ),
    },
    {
      id: "arriving",
      label: "Arriving today",
      n: lists.arriving.length,
      tone: arrivalsTotal && !lists.arriving.length ? "ok" : null,
      progress: { done: arrivedToday.length, total: arrivalsTotal },
      sub: arrivalsTotal ? (
        lists.arriving.length ? (
          <>
            still to come · <b>{arrivedToday.length}</b> of {arrivalsTotal} checked in
          </>
        ) : (
          <span className="ok-ink">all {arrivalsTotal} checked in</span>
        )
      ) : (
        "no arrivals today"
      ),
    },
    {
      id: "leaving",
      label: "Leaving today",
      n: lists.leaving.length,
      tone: owing ? "warn" : departuresTotal && !lists.leaving.length ? "ok" : null,
      progress: { done: leftToday.length, total: departuresTotal },
      sub: departuresTotal ? (
        lists.leaving.length ? (
          <>
            still to leave · <b>{leftToday.length}</b> of {departuresTotal} gone
            {owing ? <> · <b className="warn-ink">{owing} {owing === 1 ? "owes" : "owe"} money</b></> : null}
          </>
        ) : (
          <span className="ok-ink">all {departuresTotal} checked out</span>
        )
      ) : (
        "no departures today"
      ),
    },
    {
      id: "inhouse",
      label: "In-house",
      n: lists.inHouse.length,
      tone: null,
      sub: lists.inHouse.length ? `${plural(guestsIn, "guest")} · ${plural(roomsIn, "room")}` : "nobody in-house",
    },
    {
      id: "clean",
      label: "Rooms to clean",
      n: toClean.length,
      tone: lateRooms.length ? "stop" : neededToday ? "warn" : toClean.length ? null : "ok",
      sub: lateRooms.length ? (
        <b className="stop-ink">{lateRooms.length} past the clean-by time</b>
      ) : neededToday ? (
        <b className="warn-ink">{plural(neededToday, "room")} needed today</b>
      ) : toClean.length ? (
        "none needed today"
      ) : board.data ? (
        <span className="ok-ink">every room is clean</span>
      ) : (
        "checking…"
      ),
    },
    {
      id: "week",
      label: "Next 7 days",
      n: week.length,
      tone: null,
      sub: week.length ? `arriving · first ${fmtDay(week[0].checkInDate!)}` : "no arrivals booked",
    },
    {
      id: "inquiries",
      label: "New inquiries",
      n: lists.newInquiries.length,
      tone: null,
      sub: "since midnight",
    },
    {
      id: "parked",
      label: "Parked",
      n: lists.parked.length,
      tone: followUpDue ? "warn" : null,
      sub: followUpDue ? <b className="warn-ink">{followUpDue} to follow up now</b> : lists.parked.length ? "waiting to be picked up" : "nothing parked",
    },
    ...(tidyCount || tab === "tidy"
      ? [{ id: "tidy" as TabId, label: "To tidy", n: tidyCount, tone: (tidyCount ? "warn" : null) as Tone, sub: "the record, when it is quiet" }]
      : []),
  ];

  const loading = bookings.isLoading || !today;
  const titles: Record<TabId, [string, string | null]> = {
    attention: ["Needs attention", null],
    arriving: ["Arriving today", today ? `/bookings?from=${today}&to=${today}` : null],
    leaving: ["Leaving today", "/bookings?group=In-house"],
    inhouse: ["In-house", "/bookings?group=In-house"],
    clean: ["Rooms to clean", "/housekeeping"],
    week: [`Arriving ${tomorrow && endOfWeek ? fmtRange(tomorrow, endOfWeek) : "the next 7 days"}`, tomorrow ? `/bookings?group=Upcoming&from=${tomorrow}&to=${endOfWeek}` : null],
    inquiries: ["New inquiries today", "/bookings?group=Inquiry"],
    parked: ["Parked", "/bookings?group=Parked"],
    tidy: ["The record to tidy", null],
  };
  const [title, listHref] = titles[tab];

  return (
    <div className="page today-page">
      <div className="page-head">
        <div>
          <h2>Today</h2>
          <div className="meta">{today ? fmtLongDate(today) : "Checking the hotel's date…"}</div>
        </div>
        <div className="today-acts">
          <Occupancy occupied={occupied} total={roomItems.length} />
          <Button onClick={() => router.push("/bookings/new")}>New booking</Button>
        </div>
      </div>

      {bookings.error && !bookings.data ? (
        <LoadFailed what="today's bookings" onRetry={() => void bookings.refetch()} />
      ) : loading ? (
        <LoadingBlock />
      ) : (
        <>
          <Glance tiles={tiles} selected={tab} onSelect={pick} />

          <section className="block" data-today-tab={tab}>
            <div className="block-head">
              <h3>{title}</h3>
              {tab === "attention" && items.length ? (
                <span className="meta">
                  {overdue.length} overdue · {soon.length} within the next hours · {waiting.length} waiting
                </span>
              ) : listHref ? (
                <Link className="row-link" href={listHref}>
                  {tab === "clean" ? "Open Housekeeping →" : "Open in Bookings →"}
                </Link>
              ) : null}
            </div>

            {tab === "attention" ? (
              items.length === 0 ? (
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
              )
            ) : tab === "arriving" ? (
              <DayTable
                rows={lists.arriving}
                done={arrivedToday}
                doneWord="Checked in today"
                heads={["Booking", "Stay", "Rooms", "Where it stands"]}
                cells={(r) => [who(r), stay(r), roomsWord(r), <RowStanding key="s" row={r} hotelToday={today} />]}
                href={titles.arriving[1] ?? "/bookings"}
                empty={["No arrivals today"]}
              />
            ) : tab === "leaving" ? (
              <DayTable
                rows={lists.leaving}
                done={leftToday}
                doneWord="Checked out today"
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
                    <span key="b" className={`num ${bal != null ? "money" : "dash"}${owes(r) ? " warn-ink" : ""}`} style={{ display: "block", textAlign: "right", fontWeight: owes(r) ? 700 : undefined }}>
                      {bal != null ? money(bal, m?.currency ?? "BTN") : "—"}
                    </span>,
                  ];
                }}
                href="/bookings?group=In-house"
                empty={["No departures today"]}
              />
            ) : tab === "inhouse" ? (
              <DayTable
                rows={lists.inHouse}
                heads={["Booking", "Stay", "Rooms", "Leaves"]}
                cells={(r) => [who(r), stay(r), roomsWord(r), <span key="l" className="ink-2">{nightsLeft(r, today)}</span>]}
                href="/bookings?group=In-house"
                empty={["Nobody in-house"]}
              />
            ) : tab === "clean" ? (
              <RoomsToClean rooms={toClean} loaded={!!board.data} now={clock.now} tz={clock.tz} />
            ) : tab === "week" ? (
              week.length ? (
                <WeekTable rows={week} today={today} href={titles.week[1] ?? "/bookings"} />
              ) : (
                <EmptyState title="Nothing arriving in the next 7 days" />
              )
            ) : tab === "inquiries" ? (
              <DayTable
                rows={lists.newInquiries}
                heads={["Booking", "Stay", "Where it stands"]}
                cells={(r) => [who(r), r.checkInDate ? stay(r) : <span key="d" className="ink-2">no dates yet</span>, <RowStanding key="s" row={r} hotelToday={today} />]}
                href="/bookings?group=Inquiry"
                empty={["No new inquiries today"]}
              />
            ) : tab === "parked" ? (
              <DayTable
                rows={lists.parked}
                heads={["Booking", "Why it was parked", "Follow up"]}
                cells={(r) => {
                  const due = !!r.parkFollowUpAt && Date.parse(r.parkFollowUpAt) <= clock.now;
                  return [
                    who(r),
                    <span key="w">{r.parkReason ?? "—"}</span>,
                    due ? (
                      <b key="f" className="warn-ink">now</b>
                    ) : (
                      <span key="f" className="ink-2">{r.parkFollowUpAt ? fmtInstantDay(r.parkFollowUpAt, clock.tz) : "—"}</span>
                    ),
                  ];
                }}
                href="/bookings?group=Parked"
                empty={["Nothing parked", "A parked booking returns to Needs attention on its follow-up date."]}
              />
            ) : tidyCount ? (
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
        </>
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
