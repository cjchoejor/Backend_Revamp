"use client";

/**
 * One booking's refunds, on a page of its own (2026-11-12, operator: "when double clicked, it should
 * take the user inside the page where it shows it in a tabular format"). Opened from Billing ›
 * Refunds. Each refund a row: when, at which step, the amount, how it went back, what happened, the
 * reason given, who recorded it. Every figure is the server's (`GET /api/refunds/made/:entryId`).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, EmptyState } from "@/design-system";
import { LoadFailed, LoadingBlock, bookingHref } from "@/components/ds/ui";
import { StayDates } from "@/components/ds/stay-dates";
import { useBookingRefunds } from "@/hooks/use-refunds";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { fmtDateTime, money, plural } from "@/lib/ds/format";
import { stepName, stepNoOfStage } from "@/lib/ds/steps";
import { methodWord, refundStanding } from "./refunds-tab";

const BACK = "/billing?tab=refunds";

export function RefundsPage({ entryId }: { entryId: string }) {
  const router = useRouter();
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const q = useBookingRefunds(entryId);
  const fomUp = !!session && session.actorLevel !== "L1";

  if (session && !fomUp) {
    return (
      <div className="page">
        <EmptyState title="Refunds are for the FOM, the GM and the admin">They carry bank details.</EmptyState>
      </div>
    );
  }
  if (q.error && !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="page">
        <div className="bill-bar">
          <Link href={BACK} className="bill-back">
            ← Refunds
          </Link>
        </div>
        {notFound ? <EmptyState title="No refund was made on this booking" /> : <LoadFailed what="the refunds" onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="page">
        <LoadingBlock />
      </div>
    );
  }
  const b = q.data;
  return (
    <div className="page refunds-page" data-refunds-page={b.entryId}>
      <div className="bill-bar">
        <Link href={BACK} className="bill-back">
          ← Refunds
        </Link>
        <div className="bill-bar-right">
          <div className="bill-owed" data-refunds-page-total>
            <span className="k">Refunded</span>
            <b className="money">{money(b.total, b.currency)}</b>
          </div>
          <Button className="go" onClick={() => router.push(bookingHref(b.entryId))}>
            Open booking
          </Button>
        </div>
      </div>

      <div className="page-head">
        <div>
          <h2>{b.guestName ?? b.entryId}</h2>
          <div className="meta">{[b.entryId, b.party, refundStanding(b)].filter(Boolean).join(" · ")}</div>
        </div>
        <StayDates checkIn={b.checkInDate} checkOut={b.checkOutDate} />
      </div>

      <section className="block">
        <div className="block-head">
          <h3>
            {plural(b.count, "refund")}
          </h3>
        </div>
        <table className="table zebra refund-page-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Step</th>
              <th className="num">Amount</th>
              <th>Back by</th>
              <th>What happened</th>
              <th>Reason</th>
              <th>Recorded by</th>
            </tr>
          </thead>
          <tbody>
            {b.refunds.map((r, i) => (
              <tr key={r.id} className={i % 2 ? "alt" : undefined} data-refund-line={r.id}>
                <td>{fmtDateTime(r.at, clock.tz)}</td>
                <td>{r.stage ? stepName(stepNoOfStage(r.stage)) : "—"}</td>
                <td className="num">
                  <b className="money">{money(r.amount, r.currency)}</b>
                </td>
                <td>
                  {methodWord(r.method)}
                  {r.bank ? <div className="meta">{r.bank}</div> : null}
                  {r.reference ? <div className="meta">{r.reference}</div> : null}
                </td>
                <td>{r.why}</td>
                <td>{r.reason ? <>&ldquo;{r.reason}&rdquo;</> : <span className="ink-3">—</span>}</td>
                <td>{r.by ?? "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>
                <b>Refunded</b>
              </td>
              <td className="num">
                <b className="money">{money(b.total, b.currency)}</b>
              </td>
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
        {b.movedToTrip ? (
          <p className="meta refund-moved">
            {money(b.movedToTrip, b.currency)} also moved to another stay of the trip. It stays the hotel&apos;s, so it is not a refund.
          </p>
        ) : null}
      </section>
    </div>
  );
}
