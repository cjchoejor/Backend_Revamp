"use client";

/**
 * Billing (Surface Spec 00 §2) — the bills that are still open, and the money still owed after a
 * stay. Every figure is the booking's own billing summary from the server; nothing is added up
 * here, so there are no account totals until the backend reports them (receivables by account,
 * register BE-31; statements of account, BE-48).
 */
import { useMemo } from "react";
import { EmptyState, NotAvailableYet } from "@/design-system";
import { GuestLink, LoadFailed, LoadingBlock, OpenRow, RowStanding, bookingMeta } from "@/components/ds/ui";
import { useDeskBookings, useDeskMoney } from "@/hooks/use-desk-data";
import { useHotelDay } from "@/hooks/use-hotel-day";
import type { DeskListRow, DeskMoneyRow } from "@/lib/api/desk";
import { fmtRange, money, plural } from "@/lib/ds/format";
import { bookerOfRow } from "@/lib/ds/status";
import { stepNoOfStage } from "@/lib/ds/steps";

function Cell({ v, cur }: { v: number | null | undefined; cur?: string | null }) {
  return <td className={`num ${v != null ? "money" : "dash"}`}>{v != null ? money(v, cur ?? "BTN") : "—"}</td>;
}

function accountOf(r: DeskListRow): string {
  const b = bookerOfRow(r);
  return b && (b.kind === "agent" || b.kind === "company") ? b.name : "the guest";
}

export default function BillingPage() {
  const today = useHotelDay()?.today ?? null;
  const bookings = useDeskBookings();
  const rows = useMemo(() => bookings.data?.items ?? [], [bookings.data]);

  const open = useMemo(
    () =>
      rows
        .filter((r) => r.status === "ACTIVE" && r.folio && [7, 8].includes(stepNoOfStage(r.currentStage)))
        .sort((a, b) => (a.checkOutDate ?? "").localeCompare(b.checkOutDate ?? "")),
    [rows],
  );
  const after = useMemo(
    () =>
      rows
        .filter((r) => r.folio && (r.folio.state === "OUTSTANDING" || (stepNoOfStage(r.currentStage) === 9 && r.folio.state !== "SETTLED" && r.folio.state !== "CLOSED")))
        .filter((r) => !open.includes(r))
        .sort((a, b) => accountOf(a).localeCompare(accountOf(b)) || (a.checkOutDate ?? "").localeCompare(b.checkOutDate ?? "")),
    [rows, open],
  );
  const ids = useMemo(() => [...open, ...after].map((r) => r.id), [open, after]);
  const m = useDeskMoney(ids);
  const get = (id: string): DeskMoneyRow | undefined => m.byId.get(id);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Billing</h2>
          <div className="meta">
            {plural(open.length, "open bill")} · {plural(after.length, "booking")} still owing after the stay
          </div>
        </div>
      </div>

      {bookings.error && !bookings.data ? (
        <LoadFailed what="the bills" onRetry={() => void bookings.refetch()} />
      ) : bookings.isLoading ? (
        <LoadingBlock />
      ) : (
        <>
          <section className="block">
            <div className="block-head">
              <h3>Open bills</h3>
              <span className="meta">in-house and checking out · the tax invoice is issued at check-out</span>
            </div>
            {open.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th>Stay</th>
                    <th>Status</th>
                    <th className="num">Billed so far</th>
                    <th className="num">Paid</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((r) => {
                    const x = get(r.id);
                    return (
                      <OpenRow key={r.id} entryId={r.id}>
                        <td>
                          <GuestLink row={r} />
                          <div className="meta">{bookingMeta(r)}</div>
                        </td>
                        <td className="nowrap">{fmtRange(r.checkInDate, r.actualCheckOutDate ?? r.checkOutDate)}</td>
                        <td>
                          <RowStanding row={r} hotelToday={today} balance={x?.folio?.outstandingBalance ?? null} />
                        </td>
                        <Cell v={x?.folio?.billedSoFar} cur={x?.currency} />
                        <Cell v={x?.folio?.paymentsReceived} cur={x?.currency} />
                        <Cell v={x?.folio?.outstandingBalance} cur={x?.currency} />
                      </OpenRow>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState title="No open bills">Nobody is in-house.</EmptyState>
            )}
          </section>

          <section className="block">
            <div className="block-head">
              <h3>Still owed after the stay</h3>
              <span className="meta">by who pays · each booking&apos;s own balance</span>
            </div>
            {after.length ? (
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
                  {after.map((r, i) => {
                    const x = get(r.id);
                    const acct = accountOf(r);
                    const first = i === 0 || accountOf(after[i - 1]) !== acct;
                    return (
                      <OpenRow key={r.id} entryId={r.id}>
                        <td>{first ? <b>{acct}</b> : null}</td>
                        <td>
                          <GuestLink row={r} />
                          <div className="meta">{r.id}</div>
                        </td>
                        <td className="nowrap">{fmtRange(r.checkInDate, r.actualCheckOutDate ?? r.checkOutDate)}</td>
                        <Cell v={x?.folio?.outstandingBalance} cur={x?.currency} />
                      </OpenRow>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState title="Nothing owed after a stay" />
            )}
          </section>

          <section className="block">
            <div className="block-head">
              <h3>Outstanding by account</h3>
            </div>
            <NotAvailableYet what="Each agent's and company's total owed, with their statement of account," />
          </section>
        </>
      )}
    </div>
  );
}
