"use client";

/**
 * Bookings (Surface Spec 02) — every booking on one list: search, dates, the phase groups, a
 * preview on click, the workspace on double-click.
 *
 * The list is read once (`GET /api/desk/bookings`, up to 500 rows, newest first) and narrowed on
 * screen — selection, not arithmetic (SS02 §7). The Total column is each booking header's own
 * billing summary, read for the rows on screen.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, EmptyState, Icon, Input } from "@/design-system";
import { GuestLink, LoadFailed, LoadingBlock, OpenRow, RowStanding, StandingChip, StepChip, bookingHref } from "@/components/ds/ui";
import { useDeskBookings, useDeskMoney, useDeskTimers } from "@/hooks/use-desk-data";
import { RowTimer, RowTimerList } from "@/components/ds/row-timer";
import { useHotelDay } from "@/hooks/use-hotel-day";
import type { DeskListRow, DeskMoneyRow, DeskTimerRow } from "@/lib/api/desk";
import { fmtDate, fmtRange, fmtStamp, money, nightsOf, plural, weekdayOf } from "@/lib/ds/format";
import { bookerOfRow, channelWord, factsFromRow, guestNameOf, standingOf } from "@/lib/ds/status";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

const GROUPS = ["Upcoming", "In-house", "Departed", "All"] as const;
const PAGE = 50;

/**
 * How the list is ordered (2026-10-06, operator: "I'm not sure how the default is looking in
 * this table list, it looks very disoriented ... other filters like the check-in date in
 * increasing and decreasing order and some more"). The old default put every OPEN booking first
 * and then everything else, each by check-in — so the dates climbed to December and jumped back
 * to May with nothing saying why. Every order is now ONE order, stated on the page, chosen from
 * the Sort menu or by clicking a column heading, and remembered for this desk.
 */
type SortKey = "checkin" | "checkout" | "booked" | "changed" | "name" | "step";
type SortDir = "asc" | "desc";
type SortId = `${SortKey}-${SortDir}`;

const SORTS: { id: SortId; label: string; words: string }[] = [
  { id: "checkin-asc", label: "Check-in · soonest first", words: "check-in, soonest first" },
  { id: "checkin-desc", label: "Check-in · latest first", words: "check-in, latest first" },
  { id: "checkout-asc", label: "Check-out · soonest first", words: "check-out, soonest first" },
  { id: "checkout-desc", label: "Check-out · latest first", words: "check-out, latest first" },
  { id: "booked-desc", label: "Booked · newest first", words: "when booked, newest first" },
  { id: "booked-asc", label: "Booked · oldest first", words: "when booked, oldest first" },
  { id: "changed-desc", label: "Last changed · most recent first", words: "last changed, most recent first" },
  { id: "changed-asc", label: "Last changed · longest untouched first", words: "last changed, longest untouched first" },
  { id: "name-asc", label: "Guest name · A to Z", words: "guest name, A to Z" },
  { id: "name-desc", label: "Guest name · Z to A", words: "guest name, Z to A" },
  { id: "step-asc", label: "Step · Inquiry to Closed", words: "step, Inquiry to Closed" },
  { id: "step-desc", label: "Step · Closed to Inquiry", words: "step, Closed to Inquiry" },
];
const SORT_IDS = new Set<string>(SORTS.map((s) => s.id));
const SORT_STORE = "desk:bookings-sort";
/** A heading clicked for the first time sorts this way; a second click turns it round. */
const FIRST_DIR: Record<SortKey, SortDir> = { checkin: "asc", checkout: "asc", booked: "desc", changed: "desc", name: "asc", step: "asc" };

const validSort = (v: string | null | undefined): SortId | null => (v && SORT_IDS.has(v) ? (v as SortId) : null);
const sortParts = (id: SortId) => id.split("-") as [SortKey, SortDir];
const sortWords = (id: SortId) => SORTS.find((s) => s.id === id)?.words ?? id;

/** What each list is best read in when nobody has chosen. */
function usualSort(group: string): SortId {
  if (group === "Upcoming") return "checkin-asc"; // who arrives next
  if (group === "In-house") return "checkout-asc"; // who leaves next
  return "checkin-desc"; // the latest stays on top, the past running down below
}

const checkInOf = (r: DeskListRow) => r.checkInDate?.slice(0, 10) ?? null;
const checkOutOf = (r: DeskListRow) => (r.actualCheckOutDate ?? r.checkOutDate)?.slice(0, 10) ?? null;

function sortValue(r: DeskListRow, key: SortKey): string | number | null {
  switch (key) {
    case "checkin":
      return checkInOf(r);
    case "checkout":
      return checkOutOf(r);
    case "booked":
      return r.createdAt ?? null;
    case "changed":
      return r.updatedAt ?? null;
    case "name":
      return guestNameOf(r.guestProfile).toLocaleLowerCase();
    case "step":
      return stepNoOfStage(r.currentStage);
  }
}

/** One order, whichever way — a booking with no value for the key always sinks to the end. */
function compareRows(a: DeskListRow, b: DeskListRow, key: SortKey, dir: SortDir): number {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (va == null || vb == null) {
    if (va != null) return -1;
    if (vb != null) return 1;
  } else {
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    if (c) return dir === "asc" ? c : -c;
  }
  // a tie reads by check-in, soonest first, then by booking number
  const ca = checkInOf(a);
  const cb = checkInOf(b);
  if (ca !== cb) return ca == null ? 1 : cb == null ? -1 : ca.localeCompare(cb);
  return a.id.localeCompare(b.id);
}

/**
 * Where today falls in a list sorted by a stay date — the band a row sits in. Each band opens
 * with its own row, so the reader always knows which side of today they are looking at. Nothing
 * is banded until the hotel's day is known (the desk never falls back to the machine's clock).
 */
function bandOf(r: DeskListRow, key: SortKey, today: string | null): { id: string; label: string } | null {
  if (key !== "checkin" && key !== "checkout") return null;
  const d = key === "checkin" ? checkInOf(r) : checkOutOf(r);
  const what = key === "checkin" ? "Check-in" : "Check-out";
  if (!d) return { id: "none", label: "No dates yet" };
  if (!today) return null;
  if (d > today) return { id: "after", label: `${what} after today` };
  if (d === today) return { id: "today", label: `${what} today · ${fmtDate(today)}` };
  return { id: "before", label: `${what} before today` };
}

/** "Tue", or "Tue · today" for the three days a desk speaks of that way. */
function dayWord(iso: string, day: { today: string; tomorrow: string; yesterday: string } | null): string {
  const wd = weekdayOf(iso);
  if (!day) return wd;
  if (iso === day.today) return `${wd} · today`;
  if (iso === day.tomorrow) return `${wd} · tomorrow`;
  if (iso === day.yesterday) return `${wd} · yesterday`;
  return wd;
}

function inGroup(r: DeskListRow, group: string): boolean {
  const step = stepNoOfStage(r.currentStage);
  switch (group) {
    case "All":
      return true;
    case "Upcoming":
      return r.status === "ACTIVE" && step <= 6;
    case "In-house":
      return r.status === "ACTIVE" && (step === 7 || step === 8);
    case "Departed":
      return r.status === "CLOSED" || step === 9;
    case "Parked":
      return r.status === "PARKED";
    // The ended bookings, split the way their own chips read (2026-10-01). Grouping them all
    // under "Cancelled" put a lead the guest turned down beside a priced cancellation at Set
    // up, and left the lapsed ones reachable only from All.
    case "Turned down":
      return r.status === "CANCELLED" && r.closedAs === "DECLINED";
    case "Cancelled":
      return r.status === "CANCELLED" && r.closedAs !== "DECLINED";
    case "Lapsed":
      return r.status === "EXPIRED" && !r.noShowDetermination;
    default: {
      const i = (STEP_NAMES as readonly string[]).indexOf(group);
      return i >= 0 ? step === i + 1 : true;
    }
  }
}

function haystack(r: DeskListRow, statusWord: string, statusQualifier = ""): string {
  const g = r.guestProfile;
  const booker = bookerOfRow(r);
  return [
    guestNameOf(g),
    g?.phone,
    g?.email,
    r.id,
    r.inquiryId,
    r.inquiry?.referenceNumber,
    r.contactPersonName,
    r.contactPersonPhone,
    booker?.name,
    channelWord(r.inquiry?.sourceChannel, r.inquiry?.cameInAs),
    statusWord,
    // the ending's qualifier too, so "no answer" and "the offer was not taken up" are searchable
    statusQualifier,
    ...r.roomNumbers,
    ...r.quotations.map((q) => q.referenceNumber),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function subline(r: DeskListRow, extra?: string | null): string {
  const booker = bookerOfRow(r);
  return [
    r.id,
    channelWord(r.inquiry?.sourceChannel, r.inquiry?.cameInAs),
    booker && (booker.kind === "agent" || booker.kind === "company") ? booker.name : null,
    r.groupBillingMode === "GROUP_MASTER" ? "group" : null,
    r.walkInCompressed ? "walk-in" : null,
    extra,
  ]
    .filter(Boolean)
    .join(" · ");
}

function totalWord(m?: DeskMoneyRow): { amount: string | null; kind: string } {
  if (!m || m.headline.amount == null) return { amount: null, kind: "" };
  const kind = m.headline.kind === "BILLED_SO_FAR" ? "billed so far" : m.headline.frozen ? "frozen" : "indicative";
  return { amount: money(m.headline.amount, m.currency ?? "BTN"), kind };
}

function BookingsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const hotelDay = useHotelDay();
  const today = hotelDay?.today ?? null;
  const bookings = useDeskBookings();

  const group = params.get("group") ?? "All";
  const q = params.get("q") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const view = params.get("view") ?? "";

  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  // An order chosen here is kept in the address (Back returns to it) and remembered for this desk.
  const [storedSort, setStoredSort] = useState<SortId | null>(null);
  useEffect(() => {
    try {
      setStoredSort(validSort(localStorage.getItem(SORT_STORE)));
    } catch {
      /* private window or blocked storage — the usual order stands */
    }
  }, []);
  const chosenSort = validSort(params.get("sort")) ?? storedSort;
  const sort: SortId = chosenSort ?? usualSort(group);
  const [sortKey, sortDir] = sortParts(sort);
  const [pages, setPages] = useState(1);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const calRef = useRef<HTMLDetailsElement | null>(null);

  const go = (next: Partial<Record<"group" | "q" | "from" | "to" | "view" | "sort", string>>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if (p.get("group") === "All") p.delete("group");
    setPages(1);
    router.replace(`/bookings${p.toString() ? `?${p.toString()}` : ""}`);
  };

  const chooseSort = (id: SortId | null) => {
    setStoredSort(id);
    try {
      if (id) localStorage.setItem(SORT_STORE, id);
      else localStorage.removeItem(SORT_STORE);
    } catch {
      /* not remembered — it still applies on this screen */
    }
    go({ sort: id ?? "" });
  };
  const sortByHeading = (key: SortKey) =>
    chooseSort(`${key}-${key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : FIRST_DIR[key]}` as SortId);
  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  // Typing narrows the list after a short pause; the words live in the address so Back returns to them.
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => go({ q: text.trim() }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const all = useMemo(() => bookings.data?.items ?? [], [bookings.data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const yearAgo = today ? new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10) : null;
    const filtered = all.filter((r) => {
      if (!inGroup(r, group)) return false;
      const ci = r.checkInDate?.slice(0, 10) ?? null;
      const co = (r.actualCheckOutDate ?? r.checkOutDate)?.slice(0, 10) ?? null;
      if (view === "nodate" && !(r.status === "ACTIVE" && stepNoOfStage(r.currentStage) <= 2 && !ci)) return false;
      if (view === "nooutcome" && !(r.status === "ACTIVE" && stepNoOfStage(r.currentStage) <= 2 && ci && today && ci < today)) return false;
      if (from || to) {
        if (!ci) return false;
        const lo = from || to;
        const hi = to || from;
        // a stay touches the window when it starts on or before its last day and ends after its first
        if (!(ci <= hi && (co ?? ci) >= lo)) return false;
      }
      if (needle) {
        const st = standingOf(factsFromRow(r), today);
        if (!haystack(r, st.word, st.qualifier).includes(needle)) return false;
      }
      // with no search and no date: the last twelve months and everything ahead
      if (!needle && !from && !to && !view && (group === "All" || group === "Departed") && yearAgo && co && co < yearAgo) return false;
      return true;
    });
    filtered.sort((a, b) => compareRows(a, b, sortKey, sortDir));
    return filtered;
  }, [all, group, q, from, to, view, sortKey, sortDir, today]);

  /** How many bookings each band holds — over the whole list, not just the rows on screen. */
  const bandCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of rows) {
      const b = bandOf(r, sortKey, today);
      if (b) out.set(b.id, (out.get(b.id) ?? 0) + 1);
    }
    return out;
  }, [rows, sortKey, today]);

  const shownCount = Math.min(rows.length, PAGE * pages);
  const shown = rows.slice(0, shownCount);
  const moneyIds = useMemo(() => {
    const ids = shown.map((r) => r.id);
    if (previewId && !ids.includes(previewId)) ids.push(previewId);
    return ids;
  }, [shown, previewId]);
  const moneyOf = useDeskMoney(moneyIds);
  // What each booking is waiting on — the soonest clock it is running (2026-09-25).
  const timersOf = useDeskTimers(moneyIds);
  const preview = previewId ? all.find((r) => r.id === previewId) ?? null : null;

  const active: Array<[string, () => void]> = [];
  if (group !== "All") active.push([group, () => go({ group: "" })]);
  if (from || to) active.push([from && to && from !== to ? fmtRange(from, to) : `on ${fmtDate(from || to)}`, () => go({ from: "", to: "" })]);
  if (q) active.push([`“${q}”`, () => go({ q: "" })]);
  if (view === "nodate") active.push(["no dates", () => go({ view: "" })]);
  if (view === "nooutcome") active.push(["dates passed, no outcome", () => go({ view: "" })]);

  const clearAll = () => {
    setPages(1);
    setText("");
    router.replace("/bookings");
  };

  return (
    <div className={`page bookings-page${preview ? " with-preview" : ""}`}>
      <div style={{ display: "grid", gap: "var(--s3)", alignContent: "start", minHeight: 0 }}>
        <div className="page-head">
          <div>
            <h2>Bookings</h2>
            <div className="meta">
              {rows.length.toLocaleString("en-IN")} shown
              {!q && !from && !to && !view ? " · the last twelve months and everything ahead · older through Date… or the search" : ""} · sorted by{" "}
              <b>{sortWords(sort)}</b>
              {chosenSort ? "" : " (the usual for this list)"} · click a row to preview, double-click to open
            </div>
          </div>
          <Button onClick={() => router.push("/bookings/new")}>New booking</Button>
        </div>

        <div className="filters">
          <div className="field searchwrap" style={{ width: 340 }}>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, phone, reference, room, agent or status" aria-label="Search bookings" />
          </div>
          <details className="calwrap" ref={calRef}>
            <summary className="btn btn-secondary compact">
              <Icon name="clock" />
              {from || to ? (from && to && from !== to ? fmtRange(from, to) : `On ${fmtDate(from || to)}`) : "Date…"}
            </summary>
            <div className="pop-cal" style={{ width: 320 }}>
              <div className="cal-range">
                <label className="cal-box">
                  <span className="meta">From</span>
                  <input className="input" type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
                </label>
                <label className="cal-box">
                  <span className="meta">To</span>
                  <input className="input" type="date" value={draftTo} min={draftFrom || undefined} onChange={(e) => setDraftTo(e.target.value)} />
                </label>
                <div className="row-acts" style={{ gridColumn: "1 / -1" }}>
                  <Button
                    compact
                    onClick={() => {
                      go({ from: draftFrom, to: draftTo || draftFrom });
                      if (calRef.current) calRef.current.open = false;
                    }}
                  >
                    Show these dates
                  </Button>
                  {today ? (
                    <Button
                      kind="quiet"
                      compact
                      onClick={() => {
                        setDraftFrom(today);
                        setDraftTo(today);
                        go({ from: today, to: today });
                        if (calRef.current) calRef.current.open = false;
                      }}
                    >
                      Today
                    </Button>
                  ) : null}
                </div>
              </div>
              <span className="meta">A booking shows when any night of its stay falls between the two dates.</span>
            </div>
          </details>
          {GROUPS.map((g) => (
            <Button key={g} kind={g === group ? "secondary" : "quiet"} compact onClick={() => go({ group: g })}>
              {g}
            </Button>
          ))}
          <span className="meta">·</span>
          {(["Parked", "Turned down", "Lapsed", "Cancelled"] as const).map((g) => (
            <Button key={g} kind={g === group ? "secondary" : "quiet"} compact onClick={() => go({ group: g })}>
              {g}
            </Button>
          ))}
          <label className="sortwrap">
            <span className="meta">Sort</span>
            <select className="input" value={chosenSort ?? ""} onChange={(e) => chooseSort(validSort(e.target.value))} aria-label="Sort the bookings">
              <option value="">Usual for this list · {SORTS.find((s) => s.id === usualSort(group))?.label}</option>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {active.length ? (
          <div className="row-acts" style={{ marginTop: -4 }}>
            <span className="meta">Showing</span>
            {active.map(([label, clear]) => (
              <span className="chip solid" key={label}>
                {label}{" "}
                <button type="button" onClick={clear} aria-label={`Clear ${label}`} style={{ marginLeft: 4, background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0 }}>
                  ×
                </button>
              </span>
            ))}
            <Button kind="quiet" compact onClick={clearAll}>
              Clear all
            </Button>
          </div>
        ) : null}

        {bookings.error && !bookings.data ? (
          <LoadFailed what="the bookings" onRetry={() => void bookings.refetch()} />
        ) : bookings.isLoading ? (
          <LoadingBlock />
        ) : (
          <div className="table-scroll">
            <table className="table compact">
              <thead>
                <tr>
                  {(
                    [
                      ["name", "Booking"],
                      ["checkin", "Check-in"],
                      ["checkout", "Check-out"],
                    ] as const
                  ).map(([key, label]) => (
                    <th key={key}>
                      <a
                        className={`th-sort${sortKey === key ? " on" : ""}`}
                        href="#"
                        title={sortKey === key ? "Click to turn the order round" : `Sort by ${label.toLowerCase()}`}
                        onClick={(e) => {
                          e.preventDefault();
                          sortByHeading(key);
                        }}
                      >
                        {label}
                        {arrow(key)}
                      </a>
                    </th>
                  ))}
                  <th className="num">Nights</th>
                  <th className="num">Rooms</th>
                  <th>
                    <a
                      className={`th-sort${sortKey === "step" ? " on" : ""}`}
                      href="#"
                      title={sortKey === "step" ? "Click to turn the order round" : "Sort by step"}
                      onClick={(e) => {
                        e.preventDefault();
                        sortByHeading("step");
                      }}
                    >
                      Step{arrow("step")}
                    </a>
                  </th>
                  <th>Status</th>
                  <th>Clock</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const ci = checkInOf(r);
                  const co = checkOutOf(r);
                  const nights = nightsOf(ci, co);
                  const m = moneyOf.byId.get(r.id);
                  const t = totalWord(m);
                  const band = bandOf(r, sortKey, today);
                  const opensBand = band && band.id !== (i > 0 ? bandOf(shown[i - 1], sortKey, today)?.id : null);
                  const when =
                    sortKey === "booked"
                      ? `booked ${fmtStamp(r.createdAt, hotelDay?.timezone)}`
                      : sortKey === "changed"
                        ? `changed ${fmtStamp(r.updatedAt, hotelDay?.timezone)}`
                        : null;
                  return (
                    <Fragment key={r.id}>
                    {opensBand ? (
                      <tr className={`list-band ${band.id}`}>
                        <td colSpan={9}>
                          {band.label}
                          <span className="n">{plural(bandCounts.get(band.id) ?? 0, "booking")}</span>
                        </td>
                      </tr>
                    ) : null}
                    <OpenRow entryId={r.id} locked={r.status !== "ACTIVE"} selected={previewId === r.id} onSelect={() => setPreviewId((p) => (p === r.id ? null : r.id))}>
                      <td>
                        <GuestLink row={r} />
                        {r.guestProfile?.vipTier ? (
                          <>
                            {" "}
                            <Chip tone="accent" tier>
                              VIP
                            </Chip>
                          </>
                        ) : null}
                        <div className="meta">{subline(r, when)}</div>
                      </td>
                      <td className="date-cell">
                        {ci ? (
                          <>
                            <b>{fmtDate(ci)}</b>
                            <div className="meta">{dayWord(ci, hotelDay)}</div>
                          </>
                        ) : (
                          <>
                            <span className="dash">—</span>
                            <div className="meta">not set</div>
                          </>
                        )}
                      </td>
                      <td className="date-cell">
                        {co ? (
                          <>
                            <b>{fmtDate(co)}</b>
                            <div className="meta">{dayWord(co, hotelDay)}</div>
                          </>
                        ) : (
                          <span className="dash">—</span>
                        )}
                      </td>
                      <td className={`num${nights ? "" : " dash"}`}>{nights ?? "—"}</td>
                      <td className="num">{r.roomNumbers.length || r.numberOfRooms || "—"}</td>
                      <td>
                        <StepChip step={stepNoOfStage(r.currentStage)} />
                      </td>
                      <td>
                        <RowStanding row={r} hotelToday={today} balance={m?.folio?.outstandingBalance ?? null} />
                      </td>
                      <td>
                        <RowTimer row={timersOf.byId.get(r.id)} />
                      </td>
                      <td className={`num ${t.amount ? "money" : "dash"}`} title={t.kind}>
                        {t.amount ?? "—"}
                      </td>
                    </OpenRow>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 ? <EmptyState title="No bookings match">Clear a filter, or check the dates.</EmptyState> : null}
            {shownCount < rows.length ? (
              <div className="row-acts table-foot">
                <Button kind="secondary" compact onClick={() => setPages((p) => p + 1)}>
                  Show 50 more
                </Button>
                <span className="meta">
                  {shownCount} of {rows.length}
                </span>
              </div>
            ) : rows.length ? (
              <div className="table-foot meta">
                {rows.length} of {rows.length} · end of the list
                {all.length >= 500 ? " · the desk reads the newest 500 bookings; narrow by date for older ones" : ""}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {preview ? (
        <Preview row={preview} money={moneyOf.byId.get(preview.id)} timers={timersOf.byId.get(preview.id)} today={today} onClose={() => setPreviewId(null)} />
      ) : null}
    </div>
  );
}

function Preview({
  row,
  money: m,
  timers,
  today,
  onClose,
}: {
  row: DeskListRow;
  money?: DeskMoneyRow;
  timers?: DeskTimerRow;
  today: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const g = row.guestProfile;
  const booker = bookerOfRow(row);
  const st = standingOf(factsFromRow(row, m?.folio?.outstandingBalance ?? null), today);
  const nights = nightsOf(row.checkInDate, row.actualCheckOutDate ?? row.checkOutDate);
  const t = totalWord(m);
  const party = [row.adultCount ? plural(row.adultCount, "adult") : null, row.childCount ? plural(row.childCount, "child", "children") : null].filter(Boolean).join(" · ");
  return (
    <aside className="preview" aria-label="Booking preview">
      <div className="pv-head">
        <div>
          <h3 className={g && guestNameOf(g) !== "to come from the agent" ? "" : "name-i"}>{guestNameOf(g)}</h3>
          <div className="meta">
            {row.id} · Enquiry <b>{row.inquiryId}</b>
          </div>
        </div>
        <Button kind="quiet" compact onClick={onClose} aria-label="Close the preview">
          ×
        </Button>
      </div>
      <div className="row-acts pv-acts">
        <Button kind="secondary" compact onClick={() => router.push(bookingHref(row.id))}>
          Open booking
        </Button>
        <Button kind="secondary" compact state={g ? "default" : "inert"} onClick={() => g && router.push(`/guests/${g.id}`)}>
          Guest record
        </Button>
      </div>
      <div className="row-acts pv-chips">
        <StandingChip standing={st} />
        <StepChip step={stepNoOfStage(row.currentStage)} />
      </div>
      <dl className="pv">
        <dt>Check-in</dt>
        <dd>
          {row.checkInDate ? (
            <>
              <b>{fmtDate(row.checkInDate)}</b> <span className="meta">{weekdayOf(row.checkInDate)}</span>
            </>
          ) : (
            <span className="dash">—</span>
          )}
        </dd>
        <dt>Check-out</dt>
        <dd>
          {checkOutOf(row) ? (
            <>
              <b>{fmtDate(checkOutOf(row))}</b> <span className="meta">{weekdayOf(checkOutOf(row))}</span>
            </>
          ) : (
            <span className="dash">—</span>
          )}
        </dd>
        <dt>Nights</dt>
        <dd>{nights ?? <span className="dash">—</span>}</dd>
        <dt>Rooms</dt>
        <dd>{row.roomNumbers.length ? row.roomNumbers.join(", ") : row.numberOfRooms ? plural(row.numberOfRooms, "room") : "—"}</dd>
        <dt>Guests</dt>
        <dd>{party || (row.guestCount ? plural(row.guestCount, "guest") : "—")}</dd>
        <dt>Came in as</dt>
        <dd>
          {channelWord(row.inquiry?.sourceChannel, row.inquiry?.cameInAs)}
          {booker && (booker.kind === "agent" || booker.kind === "company") ? ` · ${booker.name}` : ""}
        </dd>
        <dt>Contact</dt>
        <dd>{[row.contactPersonName, row.contactPersonPhone ?? g?.phone, g?.email].filter(Boolean).join(" · ") || "—"}</dd>
        <dt>Clocks</dt>
        <dd>
          <RowTimerList row={timers} />
        </dd>
        <dt>Total</dt>
        <dd>
          {t.amount ? <span className="money">{t.amount}</span> : <span className="dash">—</span>} <span className="meta">{t.kind}</span>
        </dd>
        {m?.folio ? (
          <>
            <dt>Paid</dt>
            <dd>{money(m.folio.paymentsReceived, m.currency ?? "BTN")}</dd>
            <dt>Balance</dt>
            <dd>{money(m.folio.outstandingBalance, m.currency ?? "BTN")}</dd>
          </>
        ) : null}
        <dt>Needs</dt>
        <dd>{st.qualifier || "—"}</dd>
        <dt>With</dt>
        <dd>{row.custodianName ?? "—"}</dd>
        {row.parkReason ? (
          <>
            <dt>Parked</dt>
            <dd>{row.parkReason}</dd>
          </>
        ) : null}
        {row.inquiry?.notes ? (
          <>
            <dt>Preference</dt>
            <dd>{row.inquiry.notes}</dd>
          </>
        ) : null}
      </dl>
    </aside>
  );
}

export default function BookingsPage() {
  return (
    <Suspense fallback={null}>
      <BookingsScreen />
    </Suspense>
  );
}
