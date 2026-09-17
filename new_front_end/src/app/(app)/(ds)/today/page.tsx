"use client";

/**
 * Today (Surface Spec 01) — what needs a person now, the incomplete record, and the hotel's day.
 *
 * Every list here is a selection from the bookings read by date and step (SS01 §7); the backend's
 * own Today feed is register item SS01-P1. Money on the Leaving list is the booking header's
 * billing summary, read per row — nothing is worked out here.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { Button, EmptyState } from "@/design-system";
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
  foldTo,
} from "@/components/ds/ui";
import { useDeskBookings, useDeskMoney, useRoomsList } from "@/hooks/use-desk-data";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import type { DeskListRow } from "@/lib/api/desk";
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
import { fmtDay, fmtInstantDay, fmtLongDate, fmtRange, money, plural } from "@/lib/ds/format";
import { stepNoOfStage } from "@/lib/ds/steps";

const BANDS_OVER = 15;

function leavesWord(r: DeskListRow, today: string | null): string {
  const co = (r.actualCheckOutDate ?? r.checkOutDate)?.slice(0, 10);
  if (!co) return "—";
  return today && co <= today ? "leaves today" : `leaves ${fmtDay(co)}`;
}

function roomsWord(r: DeskListRow): string {
  if (r.roomNumbers.length) return r.roomNumbers.join(", ");
  if (r.numberOfRooms) return plural(r.numberOfRooms, "room");
  return "—";
}

function AttentionTable({ rows, now, tz }: { rows: Array<AttentionItem | Fold>; now: number; tz: string }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Booking</th>
          <th>Step</th>
          <th>Needs</th>
          <th>Waiting</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((it) =>
          isFold(it) ? (
            <tr key={`fold:${it.key}`} className="static">
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
            <OpenRow key={it.key} entryId={it.entryId} step={it.step}>
              <td>
                <Link className={`row-link${it.named ? "" : " name-i"}`} href={`/bookings/${encodeURIComponent(it.entryId)}?step=${it.step}`} onClick={(e) => e.stopPropagation()}>
                  {it.name}
                </Link>
                <div className="meta">{it.meta}</div>
              </td>
              <td>
                <StepChip step={it.step} />
              </td>
              <td>{it.need}</td>
              <td>
                <TimerText w={waitingText(it, now, tz)} />
              </td>
            </OpenRow>
          ),
        )}
      </tbody>
    </table>
  );
}

export default function TodayPage() {
  const router = useRouter();
  const clock = useHotelClock(30_000);
  const hotelDay = useHotelDay();
  const today = hotelDay?.today ?? null;
  const bookings = useDeskBookings();
  const rooms = useRoomsList();
  const rows = useMemo(() => bookings.data?.items ?? [], [bookings.data]);
  const minute = Math.floor(clock.now / 60_000);

  const items = useMemo(
    () => attentionItems(rows, clock.now, today, clock.tz),
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

  const overdue = items.filter((i) => i.band === "overdue");
  const soon = items.filter((i) => i.band === "soon");
  const waiting = items.filter((i) => i.band === "waiting");
  const banded = items.length > BANDS_OVER;
  const endOfWeek = today ? new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) : null;
  const tomorrow = today ? new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;

  const loading = bookings.isLoading || !today;

  return (
    <div className="page">
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

      {bookings.error && !bookings.data ? (
        <LoadFailed what="today's bookings" onRetry={() => void bookings.refetch()} />
      ) : loading ? (
        <LoadingBlock />
      ) : (
        <>
          <section className="block">
            <div className="block-head">
              <h3>Needs attention</h3>
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
                      Waiting · {waiting.length} <span className="meta">· nothing here is due yet · open to see it</span>
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

          {lists.noOutcome.length || lists.noDate.length ? (
            <section className="block">
              <div className="block-head">
                <h3>The record is incomplete</h3>
                <span className="meta">a quiet-hour job · nothing here can be acted on today</span>
              </div>
              <div className="grid2">
                <div>
                  <div className="fact">
                    <span className="k">{lists.noOutcome.length} outcomes never recorded</span>
                    <span className="v">
                      Inquiries whose dates have passed with nothing written down — we cannot tell which were lost to a full house and which went elsewhere.
                    </span>
                  </div>
                  <div className="row-acts">
                    <Button kind="secondary" compact onClick={() => router.push("/bookings?view=nooutcome")}>
                      Open the list
                    </Button>
                    <span className="meta">recording a decline with its reason is not in the backend yet</span>
                  </div>
                </div>
                <div>
                  <div className="fact">
                    <span className="k">{lists.noDate.length} with no dates</span>
                    <span className="v">Open inquiries with no stay dates. They are recorded, but nothing can chase them until a date is entered.</span>
                  </div>
                  <div className="row-acts">
                    <Button kind="secondary" compact onClick={() => router.push("/bookings?view=nodate")}>
                      Open the list
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          <section className="block">
            <div className="block-head">
              <h3>The hotel&apos;s day</h3>
            </div>
            <div className="day">
              <DayList title="Arriving today" rows={lists.arriving} more={`/bookings?from=${today}&to=${today}`} empty={["No arrivals today", ""]}>
                {(r) => (
                  <OpenRow key={r.id} entryId={r.id}>
                    <td>
                      <GuestLink row={r} />
                      <div className="meta">{[roomsWord(r), bookingMeta(r, false)].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td>
                      <RowStanding row={r} hotelToday={today} />
                    </td>
                  </OpenRow>
                )}
              </DayList>
              <DayList
                title="Leaving today"
                rows={lists.leaving}
                more="/bookings?group=In-house"
                empty={["No departures today", ""]}
                foot="Balance due · after advance and credits"
              >
                {(r) => {
                  const m = leavingMoney.byId.get(r.id);
                  const bal = m?.folio?.outstandingBalance;
                  return (
                    <OpenRow key={r.id} entryId={r.id}>
                      <td>
                        <GuestLink row={r} />
                        <div className="meta">{[roomsWord(r), bookingMeta(r, false)].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className={`num ${bal != null ? "money" : "dash"}`}>{bal != null ? money(bal, m?.currency ?? "BTN") : "—"}</td>
                    </OpenRow>
                  );
                }}
              </DayList>
              <DayList title="In-house" rows={lists.inHouse} more="/bookings?group=In-house" empty={["Nobody in-house", ""]}>
                {(r) => (
                  <OpenRow key={r.id} entryId={r.id}>
                    <td>
                      <GuestLink row={r} />
                      <div className="meta">{roomsWord(r)}</div>
                    </td>
                    <td>
                      <span className="ink-2" title={nightsLeft(r, today)}>{leavesWord(r, today)}</span>
                    </td>
                  </OpenRow>
                )}
              </DayList>
              <DayList title="New inquiries" rows={lists.newInquiries} more="/bookings?group=Inquiry" empty={["No new inquiries today", ""]}>
                {(r) => (
                  <OpenRow key={r.id} entryId={r.id}>
                    <td>
                      <GuestLink row={r} />
                      <div className="meta">{bookingMeta(r, false) || "Direct"}</div>
                    </td>
                    <td>
                      <span className="ink-2">{r.checkInDate ? fmtDay(r.checkInDate) : "no date"}</span>
                    </td>
                  </OpenRow>
                )}
              </DayList>
              <DayList
                title="Parked"
                rows={lists.parked}
                more="/bookings?group=Parked"
                empty={["Nothing parked", "A parked booking returns to Needs attention on its follow-up date."]}
              >
                {(r) => (
                  <OpenRow key={r.id} entryId={r.id}>
                    <td>
                      <GuestLink row={r} />
                      <div className="meta">{r.parkReason ?? bookingMeta(r, false)}</div>
                    </td>
                    <td>
                      <span className="ink-2">{r.parkFollowUpAt ? `follow up ${fmtInstantDay(r.parkFollowUpAt, clock.tz)}` : "—"}</span>
                    </td>
                  </OpenRow>
                )}
              </DayList>
            </div>
          </section>

          <section className="block">
            <div className="block-head">
              <h3>Arriving this week</h3>
              <span className="meta">
                {plural(week.length, "booking")}
                {tomorrow && endOfWeek ? ` · ${fmtRange(tomorrow, endOfWeek)}` : ""}
              </span>
            </div>
            {week.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th>Stay</th>
                    <th>Rooms</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {foldTo(week).shown.map((r) => (
                    <OpenRow key={r.id} entryId={r.id}>
                      <td>
                        <GuestLink row={r} />
                        <div className="meta">{bookingMeta(r)}</div>
                      </td>
                      <td>
                        <span className="stay-range">
                          <b>{fmtRange(r.checkInDate, r.checkOutDate)}</b>
                        </span>
                      </td>
                      <td>{r.roomNumbers.length || r.numberOfRooms || "—"}</td>
                      <td>
                        <RowStanding row={r} hotelToday={today} />
                      </td>
                    </OpenRow>
                  ))}
                  <MoreRow more={foldTo(week).more} href={`/bookings?group=Upcoming&from=${tomorrow}&to=${endOfWeek}`} />
                </tbody>
              </table>
            ) : (
              <EmptyState title="Nothing arriving this week" />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function DayList({
  title,
  rows,
  more,
  empty,
  foot,
  children,
}: {
  title: string;
  rows: DeskListRow[];
  more: string;
  empty: [string, string];
  foot?: string;
  children: (r: DeskListRow) => React.ReactNode;
}) {
  const { shown, more: extra } = foldTo(rows);
  return (
    <div className="day-list">
      <h4>
        {title} <span className="meta">{rows.length}</span>
      </h4>
      {rows.length ? (
        <table className="table compact">
          <tbody>
            {shown.map(children)}
            <MoreRow more={extra} href={more} colSpan={2} />
          </tbody>
        </table>
      ) : (
        <EmptyState title={empty[0]}>{empty[1] || null}</EmptyState>
      )}
      {foot && rows.length ? (
        <div className="meta" style={{ marginTop: 6 }}>
          {foot}
        </div>
      ) : null}
    </div>
  );
}
