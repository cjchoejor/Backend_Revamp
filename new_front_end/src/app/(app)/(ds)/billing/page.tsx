"use client";

/**
 * Billing (Surface Spec 00 §2) — the bills that are still open, and the money still owed after a
 * stay, each a tab with its own search and sort (2026-11-09, operator). Every figure is the booking's
 * own billing summary from the server; nothing is added up here, so there are no account totals
 * until the backend reports them (receivables by account, register BE-31; statements of account,
 * BE-48). Sorting only compares the server's figures.
 */
import { StayDates } from "@/components/ds/stay-dates";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Chip, EmptyState, Input, NotAvailableYet, Tabs } from "@/design-system";
import { Help } from "@/components/ds/help";
import { GuestLink, LoadFailed, LoadingBlock, MoreRow, OpenRow, RowStanding, bookingMeta, usePaged } from "@/components/ds/ui";
import { useDeskBookings, useDeskMoney } from "@/hooks/use-desk-data";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { useRefunds, useRefundsMade } from "@/hooks/use-refunds";
import { RefundsTab } from "@/components/ds/refunds-tab";
import type { DeskListRow, DeskMoneyRow } from "@/lib/api/desk";
import { money, plural } from "@/lib/ds/format";
import { bookerOfRow, rowNameOf } from "@/lib/ds/status";
import { stepNoOfStage } from "@/lib/ds/steps";

function Cell({ v, cur }: { v: number | null | undefined; cur?: string | null }) {
  return <td className={`num ${v != null ? "money" : "dash"}`}>{v != null ? money(v, cur ?? "BTN") : "—"}</td>;
}

/**
 * A row's money: a trip's when the booking is one of several stays (2026-11-10, operator: "it only
 * pulls one stay") — the bill is the trip's, so the list reads the trip's figures, the server's sums.
 */
function figuresOf(x: DeskMoneyRow | undefined) {
  if (!x) return null;
  if (x.trip) {
    return {
      total: x.trip.totalAmount,
      billed: x.trip.billedSoFar,
      paid: x.trip.paymentsReceived,
      balance: x.trip.outstandingBalance,
      paidAhead: x.trip.paidAhead,
      refunded: x.trip.refunded,
      writtenOff: x.trip.writtenOff,
    };
  }
  return {
    total: x.totalAmount,
    billed: x.folio?.billedSoFar ?? null,
    paid: x.folio?.paymentsReceived ?? null,
    balance: x.folio?.outstandingBalance ?? null,
    paidAhead: 0,
    refunded: x.folio?.refunded ?? 0,
    writtenOff: x.folio?.writtenOff ?? 0,
  };
}

/** One row per enquiry: a trip's stays are one bill. The first row of each enquiry stands for it. */
function onePerTrip(rows: DeskListRow[], skip: Set<string> = new Set()): DeskListRow[] {
  const seen = new Set<string>(skip);
  return rows.filter((r) => {
    if (seen.has(r.inquiryId)) return false;
    seen.add(r.inquiryId);
    return true;
  });
}

function accountOf(r: DeskListRow): string {
  const b = bookerOfRow(r);
  return b && (b.kind === "agent" || b.kind === "company") ? b.name : "the guest";
}

const checkOutOf = (r: DeskListRow) => r.actualCheckOutDate ?? r.checkOutDate;
const billHref = (id: string) => `/billing/${encodeURIComponent(id)}`;

type TabId = "open" | "owed" | "closed" | "accounts" | "refunds";
type SortKey = "checkout" | "checkin" | "name" | "account" | "balance" | "billed" | "paid" | "total";
type Sort = { id: string; key: SortKey; dir: 1 | -1; label: string };

const s = (key: SortKey, dir: 1 | -1, label: string): Sort => ({ id: `${key}-${dir === 1 ? "asc" : "desc"}`, key, dir, label });

const OPEN_SORTS: Sort[] = [
  s("checkout", 1, "Check-out · soonest first"),
  s("checkout", -1, "Check-out · latest first"),
  s("checkin", 1, "Check-in · soonest first"),
  s("checkin", -1, "Check-in · latest first"),
  s("balance", -1, "Balance · highest first"),
  s("balance", 1, "Balance · lowest first"),
  s("total", -1, "Total amount · highest first"),
  s("total", 1, "Total amount · lowest first"),
  s("billed", -1, "Billed so far · highest first"),
  s("billed", 1, "Billed so far · lowest first"),
  s("paid", -1, "Paid · highest first"),
  s("paid", 1, "Paid · lowest first"),
  s("name", 1, "Guest · A to Z"),
  s("name", -1, "Guest · Z to A"),
];

const OWED_SORTS: Sort[] = [
  s("account", 1, "Who pays · A to Z"),
  s("account", -1, "Who pays · Z to A"),
  s("balance", -1, "Balance · highest first"),
  s("balance", 1, "Balance · lowest first"),
  s("total", -1, "Total amount · highest first"),
  s("billed", -1, "Billed so far · highest first"),
  s("paid", -1, "Paid · highest first"),
  s("checkout", -1, "Check-out · latest first"),
  s("checkout", 1, "Check-out · oldest first"),
  s("name", 1, "Guest · A to Z"),
  s("name", -1, "Guest · Z to A"),
];

// Closed bills sort by the stay and the guest only: their money is read for the page on screen.
const CLOSED_SORTS: Sort[] = [
  s("checkout", -1, "Check-out · latest first"),
  s("checkout", 1, "Check-out · oldest first"),
  s("name", 1, "Guest · A to Z"),
  s("name", -1, "Guest · Z to A"),
  s("account", 1, "Who pays · A to Z"),
];

/** A bill with nothing left on it: settled, written off, or its balance at zero. */
const CLOSED_STATES = new Set(["SETTLED", "CLOSED", "WRITTEN_OFF"]);

/** How a closed bill ended, in the desk's words. A bill that never carried anything says so. */
function closedWord(r: DeskListRow, f: ReturnType<typeof figuresOf>): { word: string; tone: "success" | "warning" | "quiet" } {
  const st = r.folio?.state;
  if (st === "WRITTEN_OFF") return { word: "Written off", tone: "warning" };
  if (f && !f.billed && !f.paid) return { word: r.status === "CANCELLED" ? "Cancelled · nothing billed" : "Nothing billed", tone: "quiet" };
  if (r.status === "CANCELLED") return { word: "Cancelled · settled", tone: "quiet" };
  return { word: st === "SETTLED" || st === "CLOSED" ? "Settled" : "Paid in full", tone: "success" };
}

function haystack(r: DeskListRow): string {
  return [
    rowNameOf(r),
    r.id,
    r.inquiryId,
    r.inquiry?.referenceNumber,
    r.inquiry?.callerPhone,
    r.inquiry?.callerEmail,
    r.contactPersonName,
    r.contactPersonPhone,
    accountOf(r),
    bookerOfRow(r)?.name,
    ...r.roomNumbers,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Comparing the server's figures, never adding them. A row with no value goes to the end. */
function sortRows(rows: DeskListRow[], sort: Sort, moneyOf: (id: string) => DeskMoneyRow | undefined): DeskListRow[] {
  const value = (r: DeskListRow): string | number | null | undefined => {
    const f = figuresOf(moneyOf(r.id));
    switch (sort.key) {
      case "checkout":
        return checkOutOf(r);
      case "checkin":
        return r.checkInDate;
      case "name":
        return rowNameOf(r).toLowerCase();
      case "account":
        return accountOf(r).toLowerCase();
      case "balance":
        return f?.balance;
      case "billed":
        return f?.billed;
      case "total":
        return f?.total;
      case "paid":
        return f?.paid;
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const noA = va === null || va === undefined;
    const noB = vb === null || vb === undefined;
    if (noA || noB) return noA && noB ? a.id.localeCompare(b.id) : noA ? 1 : -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return c !== 0 ? c * sort.dir : (checkOutOf(a) ?? "").localeCompare(checkOutOf(b) ?? "") || a.id.localeCompare(b.id);
  });
}

function BillingScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const today = useHotelDay()?.today ?? null;
  const bookings = useDeskBookings();
  const rows = useMemo(() => bookings.data?.items ?? [], [bookings.data]);

  // Refunds waiting to go back moved here from Notifications (2026-11-10, operator): money going
  // out is billing's work. The FOM's and above — the list carries bank details.
  const { session } = useSession();
  const fom = !!session && session.actorLevel !== "L1";
  const clock = useHotelClock(60_000);
  const refundsWaiting = useRefunds("waiting").data?.items.length ?? 0;
  const bookingsRefunded = useRefundsMade().data?.totals.bookings ?? 0;
  const tabParam = params.get("tab");
  const tab: TabId =
    tabParam === "owed" || tabParam === "closed" || tabParam === "accounts" ? tabParam : tabParam === "refunds" && fom ? "refunds" : "open";
  const q = params.get("q") ?? "";
  const go = (next: Partial<Record<"tab" | "q" | "sort" | "refund", string>>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if (p.get("tab") === "open") p.delete("tab");
    router.replace(`/billing${p.toString() ? `?${p.toString()}` : ""}`, { scroll: false });
  };

  // The search goes to the address a moment after typing stops, so Back returns to it.
  const [text, setText] = useState(q);
  // Only a change from outside (Back, a link) fills the box: the address catching up with what was
  // typed a moment ago must never wipe what has been typed since.
  const sentQ = useRef(q);
  useEffect(() => {
    if (q !== sentQ.current) {
      sentQ.current = q;
      setText(q);
    }
  }, [q]);
  useEffect(() => {
    if (text.trim() === sentQ.current) return;
    const t = window.setTimeout(() => {
      sentQ.current = text.trim();
      go({ q: text.trim() });
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // ← Billing on a bill comes back to this same tab, search and order.
  useEffect(() => {
    try {
      sessionStorage.setItem("desk:billing-list", `/billing${params.toString() ? `?${params.toString()}` : ""}`);
    } catch {
      /* it just goes back to the first tab */
    }
  }, [params]);

  // A trip is one bill (2026-11-10): one row per enquiry — under Open bills while any stay is in house
  // or checking out, else under Still owed — reading the whole trip's figures.
  const open = useMemo(
    () =>
      onePerTrip(
        rows
          .filter((r) => r.status === "ACTIVE" && r.folio && [7, 8].includes(stepNoOfStage(r.currentStage)))
          .sort((a, b) => (a.checkOutDate ?? "").localeCompare(b.checkOutDate ?? "")),
      ),
    [rows],
  );
  const after = useMemo(
    () =>
      onePerTrip(
        rows
          .filter((r) => r.folio && (r.folio.state === "OUTSTANDING" || (stepNoOfStage(r.currentStage) === 9 && r.folio.state !== "SETTLED" && r.folio.state !== "CLOSED")))
          .filter((r) => !open.includes(r))
          .sort((a, b) => accountOf(a).localeCompare(accountOf(b)) || (a.checkOutDate ?? "").localeCompare(b.checkOutDate ?? "")),
        new Set(open.map((r) => r.inquiryId)),
      ),
    [rows, open],
  );
  const ids = useMemo(() => [...open, ...after].map((r) => r.id), [open, after]);
  const m = useDeskMoney(ids);
  const get = (id: string): DeskMoneyRow | undefined => m.byId.get(id);
  // What is actually owed, by the server's balance (2026-09-18): a bill can read "owing" with
  // nothing owed — 53 imported folios do — and the list showed them all as owing Nu 0.00. A row
  // stays while its balance is still loading.
  const owing = useMemo(
    () =>
      after.filter((r) => {
        const b = figuresOf(m.byId.get(r.id))?.balance;
        return b == null || b > 0;
      }),
    [after, m.byId],
  );

  // Closed bills (2026-11-10, operator: "where are the bills that are closed shown"): a bill with
  // nothing left on it — settled, written off, or at zero by the server's balance — and no stay of
  // its trip still open or owing. Newest check-out first.
  const closedAll = useMemo(() => {
    const busy = new Set([...open, ...owing].map((r) => r.inquiryId));
    const zeroAfter = new Set(
      after
        .filter((r) => {
          const b = figuresOf(m.byId.get(r.id))?.balance;
          return b != null && Math.abs(b) < 0.005;
        })
        .map((r) => r.id),
    );
    return onePerTrip(
      rows
        .filter((r) => r.folio && !busy.has(r.inquiryId) && (zeroAfter.has(r.id) || CLOSED_STATES.has(r.folio.state)))
        .sort((a, b) => (checkOutOf(b) ?? "").localeCompare(checkOutOf(a) ?? "")),
      busy,
    );
  }, [rows, open, owing, after, m.byId]);

  const sorts = tab === "owed" ? OWED_SORTS : tab === "closed" ? CLOSED_SORTS : OPEN_SORTS;
  const chosen = sorts.find((x) => x.id === params.get("sort")) ?? null;
  const sort = chosen ?? sorts[0]!;
  const all = tab === "owed" ? owing : tab === "closed" ? closedAll : open;
  const needle = q.toLowerCase();
  const shown = useMemo(
    () => sortRows(needle ? all.filter((r) => haystack(r).includes(needle)) : all, sort, (id) => m.byId.get(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, needle, sort.id, m.byId],
  );
  const groupByAccount = sort.key === "account";
  // A closed bill's money is read for the page on screen only — there can be hundreds.
  const closedPage = usePaged(tab === "closed" ? shown : [], 25);
  const mc = useDeskMoney(useMemo(() => closedPage.shown.map((r) => r.id), [closedPage.shown]));
  const nothingMatches = (
    <EmptyState title="No bill matches">Nothing here for &ldquo;{q}&rdquo;. Try a name, booking number, room or agency.</EmptyState>
  );

  return (
    <div className="page billing-page">
      <div className="page-head lead-tabs">
        <div>
          <h2>Billing</h2>
          <div className="meta">
            {plural(open.length, "open bill")} · {plural(owing.length, "booking")} still owing after the stay
          </div>
        </div>
        <Tabs
          items={[
            { id: "open", label: <>Open bills<span className="tab-n">{open.length}</span></> },
            { id: "owed", label: <>Still owed after the stay<span className={`tab-n${owing.length ? " warn" : ""}`}>{owing.length}</span></> },
            { id: "closed", label: <>Closed bills<span className="tab-n">{closedAll.length}</span></> },
            { id: "accounts", label: "Outstanding by account" },
            ...(fom ? [{ id: "refunds", label: <>Refunds<span className="tab-n">{bookingsRefunded}</span>{refundsWaiting ? <span className="tab-n warn" data-refunds-to-make>{refundsWaiting} to make</span> : null}</> }] : []),
          ]}
          selected={tab}
          onSelect={(id) => go({ tab: id, sort: "", refund: "" })}
        />
      </div>

      {bookings.error && !bookings.data ? (
        <LoadFailed what="the bills" onRetry={() => void bookings.refetch()} />
      ) : bookings.isLoading ? (
        <LoadingBlock />
      ) : tab === "refunds" ? (
        <RefundsTab tz={clock.tz} focusId={params.get("refund")} />
      ) : tab === "accounts" ? (
        <NotAvailableYet what="Each agent's and company's total owed, with their statement of account," />
      ) : (
        <>
          <div className="filters">
            <div className="field searchwrap" style={{ width: 340 }}>
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, phone, booking, room or agency" aria-label="Search the bills" />
            </div>
            <span className="meta" data-bill-count>
              {needle ? `${shown.length} of ${all.length}` : plural(all.length, "bill")}
              <Help label="What is on this list">
                {tab === "open" ? (
                  <p>Guests in-house or checking out. The tax invoice is issued at check-out.</p>
                ) : tab === "closed" ? (
                  <p>Bills with nothing left on them: settled, paid in full after the stay, or written off by the GM. A trip shows once.</p>
                ) : (
                  <p>Money still owed once the stay is over, by who pays. Each row is that booking&apos;s own balance.</p>
                )}
              </Help>
            </span>
            <label className="sortwrap">
              <span className="meta">Sort</span>
              <select className="input" value={sort.id} onChange={(e) => go({ sort: e.target.value === sorts[0]!.id ? "" : e.target.value })} aria-label="Sort the bills">
                {sorts.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {tab === "open" ? (
            shown.length ? (
              <table className="table zebra">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th>Stay</th>
                    <th>Status</th>
                    <MoneyHeads />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => {
                    const x = get(r.id);
                    const f = figuresOf(x);
                    return (
                      <OpenRow key={r.id} entryId={r.id} href={billHref(r.id)} alt={i % 2 === 1}>
                        <td>
                          <GuestLink row={r} href={billHref(r.id)} />
                          <div className="meta">{x?.trip ? `Trip · ${x.trip.stays.length} stays · ${r.inquiryId}` : bookingMeta(r)}</div>
                        </td>
                        <td className="nowrap"><TripDates row={r} x={x} /></td>
                        <td>
                          <RowStanding row={r} hotelToday={today} balance={x?.folio?.outstandingBalance ?? null} />
                        </td>
                        <MoneyCells f={f} cur={x?.currency} />
                      </OpenRow>
                    );
                  })}
                </tbody>
              </table>
            ) : needle ? (
              nothingMatches
            ) : (
              <EmptyState title="No open bills">Nobody is in-house.</EmptyState>
            )
          ) : tab === "closed" ? (
            shown.length ? (
              <table className="table zebra">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th>Stay</th>
                    <th>Who pays</th>
                    <th>How it closed</th>
                    <th className="num">Billed</th>
                    <th className="num">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {closedPage.shown.map((r, i) => {
                    const x = mc.byId.get(r.id) ?? get(r.id);
                    const f = figuresOf(x);
                    const how = closedWord(r, f);
                    return (
                      <OpenRow key={r.id} entryId={r.id} href={billHref(r.id)} alt={i % 2 === 1}>
                        <td>
                          <GuestLink row={r} href={billHref(r.id)} />
                          <div className="meta">{x?.trip ? `Trip · ${x.trip.stays.length} stays · ${r.inquiryId}` : r.id}</div>
                        </td>
                        <td className="nowrap"><TripDates row={r} x={x} /></td>
                        <td>{accountOf(r)}</td>
                        <td>
                          <Chip tone={how.tone}>{how.word}</Chip>
                        </td>
                        <Cell v={f?.billed} cur={x?.currency} />
                        <td className={`num ${f?.paid != null ? "money" : "dash"}`}>
                          {f?.paid != null ? money(f.paid, x?.currency ?? "BTN") : "—"}
                          {/* Where money paid went (2026-11-10): a cancelled stay's advance given back, the GM's write-off. */}
                          {f && f.refunded > 0 ? <div className="meta">{money(f.refunded, x?.currency ?? "BTN")} refunded</div> : null}
                          {f && f.writtenOff > 0 ? <div className="meta">{money(f.writtenOff, x?.currency ?? "BTN")} written off</div> : null}
                        </td>
                      </OpenRow>
                    );
                  })}
                  <MoreRow more={closedPage.more} colSpan={6} onMore={closedPage.showMore} step={25} />
                </tbody>
              </table>
            ) : needle ? (
              nothingMatches
            ) : (
              <EmptyState title="No closed bills yet" />
            )
          ) : shown.length ? (
            <table className="table zebra">
              <thead>
                <tr>
                  <th>Who pays</th>
                  <th>Booking</th>
                  <th>Stay</th>
                  <th>Status</th>
                  <MoneyHeads />
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const x = get(r.id);
                  const f = figuresOf(x);
                  const acct = accountOf(r);
                  const first = !groupByAccount || i === 0 || accountOf(shown[i - 1]!) !== acct;
                  return (
                    <OpenRow key={r.id} entryId={r.id} href={billHref(r.id)} alt={i % 2 === 1}>
                      <td>{first ? <b>{acct}</b> : null}</td>
                      <td>
                        <GuestLink row={r} href={billHref(r.id)} />
                        <div className="meta">{x?.trip ? `Trip · ${x.trip.stays.length} stays · ${r.inquiryId}` : r.id}</div>
                      </td>
                      <td className="nowrap"><TripDates row={r} x={x} /></td>
                      <td>
                        <RowStanding row={r} hotelToday={today} balance={x?.folio?.outstandingBalance ?? null} />
                      </td>
                      <MoneyCells f={f} cur={x?.currency} />
                    </OpenRow>
                  );
                })}
              </tbody>
            </table>
          ) : needle ? (
            nothingMatches
          ) : (
            <EmptyState title="Nothing owed after a stay" />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The stay's dates, one line a stay, the same small boxes on every row (2026-11-10, operator: "it
 * doesn't show which stays are there", then "this doesn't look good, make it better"): a trip's stays
 * each on a line, "Stay 1" right beside its own dates.
 */
function TripDates({ row, x }: { row: DeskListRow; x: DeskMoneyRow | undefined }) {
  const stays = x?.trip?.stays ?? null;
  if (!stays) {
    return (
      <div className="bl-stays">
        <div className="bl-stay">
          {/* Room where a trip says "Stay 1", so every row's dates line up down the column. */}
          <span className="bl-stayno" aria-hidden />
          <StayDates compact checkIn={row.checkInDate} checkOut={checkOutOf(row)} />
        </div>
      </div>
    );
  }
  return (
    <div className="bl-stays trip">
      {stays.map((s) => (
        <div key={s.entryId} className="bl-stay">
          <span className="bl-stayno">Stay {s.stayNo}</span>
          <StayDates compact checkIn={s.checkIn} checkOut={s.checkOut} />
        </div>
      ))}
    </div>
  );
}

/**
 * The money columns, the same on Open bills and Still owed (2026-11-10, operator: "this needs column
 * names like in open bills"). Every figure is the server's.
 */
function MoneyHeads() {
  return (
    <>
      <th className="num">
        Total amount
        <Help label="About the total amount">
          What the whole stay comes to: the stay as priced, with everything added to it during the stay. It is known before the nights
          are billed.
        </Help>
      </th>
      <th className="num">
        Billed so far
        <Help label="About billed so far">
          What is on the bill now: each night is added by the night audit once it has passed, and each charge as it is posted. A guest
          still in the hotel has nights to come, so this is less than the total.
        </Help>
      </th>
      <th className="num">Paid</th>
      <th className="num">Balance</th>
    </>
  );
}

function MoneyCells({ f, cur }: { f: ReturnType<typeof figuresOf>; cur?: string | null }) {
  return (
    <>
      <Cell v={f?.total} cur={cur} />
      <Cell v={f?.billed} cur={cur} />
      <Cell v={f?.paid} cur={cur} />
      <BalanceCell f={f} cur={cur} />
    </>
  );
}

/** The balance, and money a stay paid ahead — kept apart, as the bill keeps it. */
function BalanceCell({ f, cur }: { f: ReturnType<typeof figuresOf>; cur?: string | null }) {
  const v = f?.balance;
  return (
    <td className={`num ${v != null ? "money" : "dash"}`}>
      {v != null ? money(v, cur ?? "BTN") : "—"}
      {f && f.paidAhead > 0 ? <div className="meta">{money(f.paidAhead, cur ?? "BTN")} paid ahead</div> : null}
    </td>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingScreen />
    </Suspense>
  );
}
