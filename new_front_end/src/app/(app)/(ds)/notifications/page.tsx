"use client";

/**
 * Notifications (2026-10-23, operator: "a button where it takes the user to another notification
 * UI where it shows in detail and properly grouped"). Opened from the bell. Two tabs:
 *
 *  - **Needs a person** — the bell's list in full (overdue, due within the hours, and waiting),
 *    grouped by the kind of work: money · arrivals · departures and closing · quotes, holds and
 *    papers · follow-ups. Today groups the same items by urgency; here the desk sees one kind of
 *    work together. Derived on the screen from the bookings read, exactly as the bell and Today are.
 *  - **Alerts sent** — what the system itself sent (a booking at a step too long, a lapse, a
 *    payment reminder, a VIP arrival), read from `GET /api/desk/alerts`, by hotel day, with who
 *    each was for and how the booking stands now.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Chip, EmptyState, Tabs } from "@/design-system";
import { LoadFailed, LoadingBlock, MoreRow, OpenRow, StepChip, TimerText, usePaged } from "@/components/ds/ui";
import { useDeskBookings } from "@/hooks/use-desk-data";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { listDeskAlerts, type DeskAlertTarget } from "@/lib/api/desk";
import {
  ALERT_KIND_WORD,
  TARGET_ORDER,
  TARGET_WORD,
  alertBookingName,
  alertHeadline,
  alertNow,
  alertsByDay,
  groupTargets,
  severityWord,
  type AlertGroup,
} from "@/lib/ds/alerts";
import { WORK_KINDS, attentionItems, waitingText, type AttentionItem, type Band } from "@/lib/ds/attention";
import { fmtLongDate, fmtTime, plural } from "@/lib/ds/format";
import { stepNoOfStage } from "@/lib/ds/steps";

type View = "now" | "sent";
const BAND_WORD: Record<Band, string> = { overdue: "Overdue", soon: "Due soon", waiting: "Waiting" };
const BAND_TONE: Record<Band, "danger" | "warning" | "quiet"> = { overdue: "danger", soon: "warning", waiting: "quiet" };
const RANGES = [1, 7, 14, 31] as const;
const RANGE_WORD: Record<number, string> = { 1: "Today", 7: "7 days", 14: "14 days", 31: "31 days" };

export default function NotificationsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Notifications />
    </Suspense>
  );
}

function Notifications() {
  const router = useRouter();
  const pathname = usePathname() ?? "/notifications";
  const search = useSearchParams();
  const view: View = search.get("view") === "sent" ? "sent" : "now";
  const pickView = (v: string) => {
    const p = new URLSearchParams(search.toString());
    p.set("view", v);
    router.replace(`${pathname}?${p}`, { scroll: false });
  };

  const clock = useHotelClock(30_000);
  const hotelDay = useHotelDay();
  const bookings = useDeskBookings();
  const items = useMemo(
    () => attentionItems(bookings.data?.items ?? [], clock.now, hotelDay?.today ?? null, clock.tz),
    // clock.now moves every 30 s; the list follows it by the minute
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookings.data, hotelDay?.today, Math.floor(clock.now / 60_000)],
  );

  return (
    <div className="page">
      <div className="page-head lead-tabs">
        <div>
          <h2>Notifications</h2>
          <div className="meta">{hotelDay?.today ? fmtLongDate(hotelDay.today) : "Checking the hotel's date…"}</div>
        </div>
        <Tabs
          items={[
            { id: "now", label: "Needs a person", count: items.length },
            { id: "sent", label: "Alerts sent" },
          ]}
          selected={view}
          onSelect={pickView}
        />
      </div>
      {view === "now" ? (
        bookings.error && !bookings.data ? (
          <LoadFailed what="the bookings" onRetry={() => void bookings.refetch()} />
        ) : bookings.isLoading || !hotelDay ? (
          <LoadingBlock />
        ) : (
          <NeedsAPerson items={items} now={clock.now} tz={clock.tz} />
        )
      ) : (
        <AlertsSent tz={clock.tz} today={hotelDay?.today ?? null} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ needs a person */

function NeedsAPerson({ items, now, tz }: { items: AttentionItem[]; now: number; tz: string }) {
  const [band, setBand] = useState<Band | "all">("all");
  const count = (b: Band) => items.filter((i) => i.band === b).length;
  const shown = band === "all" ? items : items.filter((i) => i.band === band);
  const groups = WORK_KINDS.map((k) => ({ ...k, items: shown.filter((i) => i.work === k.id) })).filter((g) => g.items.length);

  if (items.length === 0) return <EmptyState title="Nothing needs a person">Every booking is where it should be for now.</EmptyState>;

  return (
    <>
      <div className="filters">
        <Button kind={band === "all" ? "secondary" : "quiet"} compact aria-pressed={band === "all"} onClick={() => setBand("all")}>
          All · {items.length}
        </Button>
        {(["overdue", "soon", "waiting"] as const).map((b) => (
          <Button key={b} kind={band === b ? "secondary" : "quiet"} compact aria-pressed={band === b} onClick={() => setBand(b)}>
            {BAND_WORD[b]} · {count(b)}
          </Button>
        ))}
        <span className="meta ntf-jump">
          {groups.map((g, i) => (
            <span key={g.id}>
              {i ? " · " : ""}
              <a href={`#ntf-${g.id}`}>
                {g.title} {g.items.length}
              </a>
            </span>
          ))}
        </span>
      </div>
      {groups.length === 0 ? <EmptyState title={`Nothing ${BAND_WORD[band as Band].toLowerCase()}`} /> : null}
      {groups.map((g) => (
        <WorkGroup key={g.id} id={g.id} title={g.title} items={g.items} now={now} tz={tz} />
      ))}
    </>
  );
}

function WorkGroup({ id, title, items, now, tz }: { id: string; title: string; items: AttentionItem[]; now: number; tz: string }) {
  const paged = usePaged(items);
  const n = (b: Band) => items.filter((i) => i.band === b).length;
  return (
    <section className="block ntf-group" id={`ntf-${id}`}>
      <div className="block-head">
        <h3>
          {title} <span className="meta">{items.length}</span>
        </h3>
        <span className="row-acts">
          {n("overdue") ? <Chip tone="danger">{n("overdue")} overdue</Chip> : null}
          {n("soon") ? <Chip tone="warning">{n("soon")} due soon</Chip> : null}
          {n("waiting") ? <Chip tone="quiet">{n("waiting")} waiting</Chip> : null}
        </span>
      </div>
      <table className="table ntf-table ntf-now">
        <thead>
          <tr>
            <th>What it needs</th>
            <th>Booking</th>
            <th>Step</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {paged.shown.map((it) => (
            <OpenRow key={it.key} entryId={it.entryId} step={it.step}>
              <td>
                <span className="ntf-need">
                  <Chip tone={BAND_TONE[it.band]}>{BAND_WORD[it.band]}</Chip>
                  <b>{it.need}</b>
                </span>
              </td>
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
                <TimerText w={waitingText(it, now, tz)} />
              </td>
            </OpenRow>
          ))}
          <MoreRow more={paged.more} onMore={paged.showMore} colSpan={4} />
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------------ alerts sent */

function AlertsSent({ tz, today }: { tz: string; today: string | null }) {
  const { session, isLoading } = useSession();
  const [days, setDays] = useState<number>(7);
  const [who, setWho] = useState<DeskAlertTarget | "all">("all");
  const q = useQuery({
    queryKey: ["desk-alerts", days],
    queryFn: () => listDeskAlerts(session!, { days }),
    enabled: !!session && !isLoading,
    refetchInterval: 60_000,
  });
  const all = q.data?.items ?? [];
  const shown = who === "all" ? all : all.filter((a) => a.targets.includes(who));
  const byDay = useMemo(() => alertsByDay(shown, tz), [shown, tz]);
  const yesterday = today ? new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : null;
  const dayTitle = (ymd: string) => (ymd === today ? `Today · ${fmtLongDate(ymd)}` : ymd === yesterday ? `Yesterday · ${fmtLongDate(ymd)}` : fmtLongDate(ymd));

  return (
    <>
      <div className="filters">
        {RANGES.map((d) => (
          <Button key={d} kind={days === d ? "secondary" : "quiet"} compact aria-pressed={days === d} onClick={() => setDays(d)}>
            {RANGE_WORD[d]}
          </Button>
        ))}
        <span className="meta">· For</span>
        <Button kind={who === "all" ? "secondary" : "quiet"} compact aria-pressed={who === "all"} onClick={() => setWho("all")}>
          Everyone · {all.length}
        </Button>
        {TARGET_ORDER.map((t) => {
          const n = all.filter((a) => a.targets.includes(t)).length;
          return (
            <Button key={t} kind={who === t ? "secondary" : "quiet"} compact aria-pressed={who === t} onClick={() => setWho(t)}>
              {TARGET_WORD[t]} · {n}
            </Button>
          );
        })}
      </div>
      {q.error && !q.data ? (
        <LoadFailed what="the alerts" onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <LoadingBlock />
      ) : byDay.length === 0 ? (
        <EmptyState title="No alerts sent">{who === "all" ? `Nothing in the last ${days === 1 ? "day" : `${days} days`}.` : `None for the ${TARGET_WORD[who]} in this time.`}</EmptyState>
      ) : (
        <>
          {byDay.map((d) => (
            <section className="block ntf-group" key={d.ymd}>
              <div className="block-head">
                <h3>{dayTitle(d.ymd)}</h3>
                <span className="meta">{plural(d.count, "alert")}{d.groups.length < d.count ? ` · ${plural(d.groups.length, "booking")}` : ""}</span>
              </div>
              <AlertTable groups={d.groups} tz={tz} />
            </section>
          ))}
          {q.data && q.data.count >= q.data.limit ? <p className="meta">The newest {q.data.limit} alerts — pick a shorter time to see the rest.</p> : null}
        </>
      )}
    </>
  );
}

function AlertTable({ groups, tz }: { groups: AlertGroup[]; tz: string }) {
  const paged = usePaged(groups);
  return (
    <table className="table ntf-table ntf-sent">
      <thead>
        <tr>
          <th>Time</th>
          <th>What was sent</th>
          <th>For</th>
          <th>Booking</th>
          <th>Now</th>
        </tr>
      </thead>
      <tbody>
        {paged.shown.map((g) => {
          const a = g.head;
          const sev = severityWord(a);
          const name = alertBookingName(a);
          const nowState = alertNow(a);
          const step = a.booking ? stepNoOfStage(a.booking.currentStage) : undefined;
          const earlier = g.alerts.filter((x) => x.id !== a.id);
          const row = (
            <>
              <td className="nowrap">{fmtTime(g.alerts[0].at, tz)}</td>
              <td>
                <span className="ntf-need">
                  <Chip tone={a.severity === "ESCALATION" ? "danger" : a.severity === "CRITICAL" ? "warning" : "quiet"}>{ALERT_KIND_WORD[a.kind]}</Chip>
                  <b>{alertHeadline(a)}</b>
                  {sev ? <span className={`ntf-sev s-${a.severity?.toLowerCase()}`}>{sev}</span> : null}
                </span>
                {earlier.length ? (
                  <div className="meta">
                    also {earlier.map((x) => `${fmtTime(x.at, tz)}${severityWord(x) ? ` (${severityWord(x)})` : ""}`).join(" · ")}
                  </div>
                ) : null}
              </td>
              <td>
                <span className="row-acts">
                  {groupTargets(g).length ? groupTargets(g).map((t) => <Chip key={t}>{TARGET_WORD[t]}</Chip>) : <span className="dash">—</span>}
                </span>
              </td>
              <td>
                {a.entryId ? (
                  <Link className={`row-link${name.named ? "" : " name-i"}`} href={`/bookings/${encodeURIComponent(a.entryId)}${step ? `?step=${step}` : ""}`} onClick={(e) => e.stopPropagation()}>
                    {name.name}
                  </Link>
                ) : (
                  <span className="dash">—</span>
                )}
                {a.entryId ? <div className="meta">{a.entryId}</div> : null}
              </td>
              <td className={nowState.tone === "warn" ? "warn-ink" : nowState.tone === "ok" ? "ok-ink" : "ink-2"}>
                <b>{nowState.text}</b>
              </td>
            </>
          );
          return a.entryId && a.booking ? (
            <OpenRow key={g.key} entryId={a.entryId} step={step}>
              {row}
            </OpenRow>
          ) : (
            <tr key={g.key} className="static">
              {row}
            </tr>
          );
        })}
        <MoreRow more={paged.more} onMore={paged.showMore} colSpan={5} />
      </tbody>
    </table>
  );
}
