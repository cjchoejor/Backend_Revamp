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
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, EmptyState, Icon, Input } from "@/design-system";
import { GuestLink, LoadFailed, LoadingBlock, OpenRow, RowStanding, StandingChip, StepChip, bookingHref } from "@/components/ds/ui";
import { useDeskBookings, useDeskMoney } from "@/hooks/use-desk-data";
import { useHotelDay } from "@/hooks/use-hotel-day";
import type { DeskListRow, DeskMoneyRow } from "@/lib/api/desk";
import { fmtDate, fmtRange, money, nightsOf, plural } from "@/lib/ds/format";
import { bookerOfRow, channelWord, factsFromRow, guestNameOf, standingOf } from "@/lib/ds/status";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

const GROUPS = ["Upcoming", "In-house", "Departed", "All"] as const;
const PAGE = 50;

type Sort = "arrival" | "name";

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
    case "Cancelled":
      return r.status === "CANCELLED";
    default: {
      const i = (STEP_NAMES as readonly string[]).indexOf(group);
      return i >= 0 ? step === i + 1 : true;
    }
  }
}

function haystack(r: DeskListRow, statusWord: string): string {
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
    channelWord(r.inquiry?.sourceChannel),
    statusWord,
    ...r.roomNumbers,
    ...r.quotations.map((q) => q.referenceNumber),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function subline(r: DeskListRow): string {
  const booker = bookerOfRow(r);
  return [
    r.id,
    channelWord(r.inquiry?.sourceChannel),
    booker && (booker.kind === "agent" || booker.kind === "company") ? booker.name : null,
    r.groupBillingMode === "GROUP_MASTER" ? "group" : null,
    r.walkInCompressed ? "walk-in" : null,
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
  const [sort, setSort] = useState<Sort>("arrival");
  const [pages, setPages] = useState(1);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const calRef = useRef<HTMLDetailsElement | null>(null);

  const go = (next: Partial<Record<"group" | "q" | "from" | "to" | "view", string>>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if (p.get("group") === "All") p.delete("group");
    setPages(1);
    router.replace(`/bookings${p.toString() ? `?${p.toString()}` : ""}`);
  };

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
        const word = standingOf(factsFromRow(r), today).word;
        if (!haystack(r, word).includes(needle)) return false;
      }
      // with no search and no date: the last twelve months and everything ahead
      if (!needle && !from && !to && !view && (group === "All" || group === "Departed") && yearAgo && co && co < yearAgo) return false;
      return true;
    });
    const past = (r: DeskListRow) => (r.status !== "ACTIVE" || stepNoOfStage(r.currentStage) === 9 ? 1 : 0);
    const key = (r: DeskListRow) => r.checkInDate?.slice(0, 10) ?? "9999-99-99";
    if (sort === "name") filtered.sort((a, b) => guestNameOf(a.guestProfile).localeCompare(guestNameOf(b.guestProfile)));
    else filtered.sort((a, b) => (group === "All" ? past(a) - past(b) : 0) || key(a).localeCompare(key(b)));
    return filtered;
  }, [all, group, q, from, to, view, sort, today]);

  const shownCount = Math.min(rows.length, PAGE * pages);
  const shown = rows.slice(0, shownCount);
  const moneyIds = useMemo(() => {
    const ids = shown.map((r) => r.id);
    if (previewId && !ids.includes(previewId)) ids.push(previewId);
    return ids;
  }, [shown, previewId]);
  const moneyOf = useDeskMoney(moneyIds);
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
              {sort === "arrival" ? "arrival, soonest first" : "name"} · click a row to preview, double-click to open
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
          {(["Parked", "Cancelled"] as const).map((g) => (
            <Button key={g} kind={g === group ? "secondary" : "quiet"} compact onClick={() => go({ group: g })}>
              {g}
            </Button>
          ))}
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
                  <th>
                    <a className={`th-sort${sort === "name" ? " on" : ""}`} href="#" onClick={(e) => { e.preventDefault(); setSort("name"); }}>
                      Booking{sort === "name" ? " ▾" : ""}
                    </a>
                  </th>
                  <th>
                    <a className={`th-sort${sort === "arrival" ? " on" : ""}`} href="#" onClick={(e) => { e.preventDefault(); setSort("arrival"); }}>
                      Stay{sort === "arrival" ? " ▾" : ""}
                    </a>
                  </th>
                  <th>Rooms</th>
                  <th>Step</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const nights = nightsOf(r.checkInDate, r.actualCheckOutDate ?? r.checkOutDate);
                  const m = moneyOf.byId.get(r.id);
                  const t = totalWord(m);
                  return (
                    <OpenRow key={r.id} entryId={r.id} locked={r.status !== "ACTIVE"} selected={previewId === r.id} onSelect={() => setPreviewId((p) => (p === r.id ? null : r.id))}>
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
                        <div className="meta">{subline(r)}</div>
                      </td>
                      <td>
                        {r.checkInDate ? (
                          <>
                            <span className="stay-range">
                              <b>{fmtRange(r.checkInDate, r.actualCheckOutDate ?? r.checkOutDate)}</b>
                            </span>
                            <div className="meta">{nights ? plural(nights, "night") : ""}</div>
                          </>
                        ) : (
                          <>
                            <span className="dash">—</span>
                            <div className="meta">not set</div>
                          </>
                        )}
                      </td>
                      <td>{r.roomNumbers.length || r.numberOfRooms || "—"}</td>
                      <td>
                        <StepChip step={stepNoOfStage(r.currentStage)} />
                      </td>
                      <td>
                        <RowStanding row={r} hotelToday={today} balance={m?.folio?.outstandingBalance ?? null} />
                      </td>
                      <td className={`num ${t.amount ? "money" : "dash"}`} title={t.kind}>
                        {t.amount ?? "—"}
                      </td>
                    </OpenRow>
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

      {preview ? <Preview row={preview} money={moneyOf.byId.get(preview.id)} today={today} onClose={() => setPreviewId(null)} /> : null}
    </div>
  );
}

function Preview({ row, money: m, today, onClose }: { row: DeskListRow; money?: DeskMoneyRow; today: string | null; onClose: () => void }) {
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
          <div className="meta">{row.id}</div>
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
        <dt>Stay</dt>
        <dd>
          {row.checkInDate ? (
            <>
              <b>{fmtRange(row.checkInDate, row.actualCheckOutDate ?? row.checkOutDate)}</b>
              {nights ? ` · ${plural(nights, "night")}` : ""}
            </>
          ) : (
            <span className="dash">—</span>
          )}
        </dd>
        <dt>Rooms</dt>
        <dd>{row.roomNumbers.length ? row.roomNumbers.join(", ") : row.numberOfRooms ? plural(row.numberOfRooms, "room") : "—"}</dd>
        <dt>Guests</dt>
        <dd>{party || (row.guestCount ? plural(row.guestCount, "guest") : "—")}</dd>
        <dt>Came in as</dt>
        <dd>
          {channelWord(row.inquiry?.sourceChannel)}
          {booker && (booker.kind === "agent" || booker.kind === "company") ? ` · ${booker.name}` : ""}
        </dd>
        <dt>Contact</dt>
        <dd>{[row.contactPersonName, row.contactPersonPhone ?? g?.phone, g?.email].filter(Boolean).join(" · ") || "—"}</dd>
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
