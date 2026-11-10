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
import { EmptyState, Input, NotAvailableYet, Tabs } from "@/design-system";
import { Help } from "@/components/ds/help";
import { GuestLink, LoadFailed, LoadingBlock, OpenRow, RowStanding, bookingMeta } from "@/components/ds/ui";
import { useDeskBookings, useDeskMoney } from "@/hooks/use-desk-data";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { useRefunds } from "@/hooks/use-refunds";
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
    return { total: x.trip.totalAmount, billed: x.trip.billedSoFar, paid: x.trip.paymentsReceived, balance: x.trip.outstandingBalance, paidAhead: x.trip.paidAhead };
  }
  return { total: x.totalAmount, billed: x.folio?.billedSoFar ?? null, paid: x.folio?.paymentsReceived ?? null, balance: x.folio?.outstandingBalance ?? null, paidAhead: 0 };
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

type TabId = "open" | "owed" | "accounts" | "refunds";
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
  s("checkout", -1, "Check-out · latest first"),
  s("checkout", 1, "Check-out · oldest first"),
  s("name", 1, "Guest · A to Z"),
  s("name", -1, "Guest · Z to A"),
];

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
  const tabParam = params.get("tab");
  const tab: TabId = tabParam === "owed" || tabParam === "accounts" ? tabParam : tabParam === "refunds" && fom ? "refunds" : "open";
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

  const sorts = tab === "owed" ? OWED_SORTS : OPEN_SORTS;
  const chosen = sorts.find((x) => x.id === params.get("sort")) ?? null;
  const sort = chosen ?? sorts[0]!;
  const all = tab === "owed" ? owing : open;
  const needle = q.toLowerCase();
  const shown = useMemo(
    () => sortRows(needle ? all.filter((r) => haystack(r).includes(needle)) : all, sort, (id) => m.byId.get(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, needle, sort.id, m.byId],
  );
  const groupByAccount = sort.key === "account";
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
            { id: "accounts", label: "Outstanding by account" },
            ...(fom ? [{ id: "refunds", label: <>Refunds<span className={`tab-n${refundsWaiting ? " warn" : ""}`}>{refundsWaiting}</span></> }] : []),
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
                {tab === "open" ? <p>Guests in-house or checking out. The tax invoice is issued at check-out.</p> : <p>Money still owed once the stay is over, by who pays. Each row is that booking&apos;s own balance.</p>}
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
              <table className="table">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th>Stay</th>
                    <th>Status</th>
                    <th className="num">
                      Total amount
                      <Help label="About the total amount">
                        What the whole stay comes to: the stay as priced, with everything added to it during the stay. It is known before
                        the nights are billed.
                      </Help>
                    </th>
                    <th className="num">
                      Billed so far
                      <Help label="About billed so far">
                        What is on the bill now: each night is added by the night audit once it has passed, and each charge as it is posted.
                        A guest still in the hotel has nights to come, so this is less than the total.
                      </Help>
                    </th>
                    <th className="num">Paid</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const x = get(r.id);
                    const f = figuresOf(x);
                    return (
                      <OpenRow key={r.id} entryId={r.id} href={billHref(r.id)}>
                        <td>
                          <GuestLink row={r} href={billHref(r.id)} />
                          <div className="meta">{x?.trip ? `Trip · ${x.trip.stays.length} stays · ${r.inquiryId}` : bookingMeta(r)}</div>
                        </td>
                        <td className="nowrap"><TripDates row={r} x={x} /></td>
                        <td>
                          <RowStanding row={r} hotelToday={today} balance={x?.folio?.outstandingBalance ?? null} />
                        </td>
                        <Cell v={f?.total} cur={x?.currency} />
                        <Cell v={f?.billed} cur={x?.currency} />
                        <Cell v={f?.paid} cur={x?.currency} />
                        <BalanceCell f={f} cur={x?.currency} />
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
          ) : shown.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Who pays</th>
                  <th>Booking</th>
                  <th>Stay</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const x = get(r.id);
                  const f = figuresOf(x);
                  const acct = accountOf(r);
                  const first = !groupByAccount || i === 0 || accountOf(shown[i - 1]!) !== acct;
                  return (
                    <OpenRow key={r.id} entryId={r.id} href={billHref(r.id)}>
                      <td>{first ? <b>{acct}</b> : null}</td>
                      <td>
                        <GuestLink row={r} href={billHref(r.id)} />
                        <div className="meta">{x?.trip ? `Trip · ${x.trip.stays.length} stays · ${r.inquiryId}` : r.id}</div>
                      </td>
                      <td className="nowrap"><TripDates row={r} x={x} /></td>
                      <BalanceCell f={f} cur={x?.currency} />
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

/** The stay's dates — a trip's from its first check-in to its last check-out, with how many stays. */
function TripDates({ row, x }: { row: DeskListRow; x: DeskMoneyRow | undefined }) {
  const stays = x?.trip?.stays ?? null;
  if (!stays) return <StayDates stacked checkIn={row.checkInDate} checkOut={checkOutOf(row)} />;
  return (
    <>
      <StayDates stacked checkIn={stays[0]?.checkIn ?? row.checkInDate} checkOut={stays[stays.length - 1]?.checkOut ?? checkOutOf(row)} />
      <div className="meta" style={{ marginTop: 2 }}>{stays.length} stays</div>
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
