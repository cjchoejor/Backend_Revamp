"use client";

/**
 * The bill, opened from the Billing page (2026-11-09, operator: "a proper page here where it shows a
 * hotel like bill format ... if it has multiple entries their bills together ... and then also open
 * booking option inside"). A trip is one bill: each stay's lines under its own band, then one ladder.
 * Every figure is the server's (`GET /api/desk/bills/:entryId`); nothing is added up here.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, Chip } from "@/design-system";
import { StayDates } from "@/components/ds/stay-dates";
import { LoadFailed, LoadingBlock, bookingHref } from "@/components/ds/ui";
import { METHOD_WORD } from "@/components/ds/workspace/booking-tabs";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { getBillView, type BillStay } from "@/lib/api/desk";
import { fmtDateTime, money, plural } from "@/lib/ds/format";

/** Where a stay's bill stands, in the desk's words. */
function standingOf(s: BillStay): { word: string; tone: "default" | "success" | "warning" | "danger" | "quiet" } {
  if (s.status === "CANCELLED") return { word: "Cancelled", tone: "quiet" };
  switch (s.folioState) {
    case null:
      return { word: "No bill yet", tone: "quiet" };
    case "PROVISIONAL":
      return { word: "Not checked in", tone: "quiet" };
    case "LIVE":
      return { word: s.stage === "S8" ? "Checking out" : "In house", tone: "default" };
    case "OUTSTANDING":
      return s.figures.balance > 0 ? { word: "Owing", tone: "danger" } : { word: "Settled", tone: "success" };
    case "WRITTEN_OFF":
      return { word: "Written off", tone: "quiet" };
    case "NO_SHOW_CLOSED":
      return { word: "No-show", tone: "quiet" };
    default:
      return { word: "Settled", tone: "success" };
  }
}

function placesOf(s: BillStay): string {
  const nights = s.nights != null ? plural(s.nights, "night") : null;
  const rooms = s.rooms.length ? `${s.rooms.length === 1 ? "Room" : "Rooms"} ${s.rooms.join(", ")}` : s.roomCount ? plural(s.roomCount, "room") : null;
  return [nights, rooms].filter(Boolean).join(" · ");
}

export function BillPage({ entryId }: { entryId: string }) {
  const { session } = useSession();
  const router = useRouter();
  const { tz } = useHotelClock(60_000);
  const q = useQuery({
    queryKey: ["bill-view", entryId],
    queryFn: () => getBillView(session!, entryId),
    enabled: !!session,
    refetchInterval: 30_000,
  });
  if (q.error && !q.data) return <div className="page"><LoadFailed what="the bill" onRetry={() => void q.refetch()} /></div>;
  if (!q.data) return <div className="page"><LoadingBlock /></div>;

  const b = q.data;
  const cur = b.currency;
  const many = b.stays.length > 1;
  const only = many ? null : (b.stays[0] ?? null);
  const f = b.figures;
  const owing = f.balance > 0;
  const stillRunning = b.stays.some((s) => s.folioState === "LIVE" || s.folioState === "PROVISIONAL");
  const invoices = b.stays.flatMap((s) => s.taxInvoices);
  const guest = b.forGuest ?? b.stays.find((s) => s.entryId === entryId)?.guest ?? null;
  const showing = owing ? { k: "Balance due", v: f.balance, cls: "due" } : f.paidAhead > 0 ? { k: "Paid ahead", v: f.paidAhead, cls: "clear" } : { k: "Nothing owed", v: 0, cls: "clear" };

  return (
    <div className="page bill-page">
      <div className="bill-bar">
        <Link href="/billing" className="bill-back">
          ← Billing
        </Link>
        <div className="bill-bar-right">
          <div className={`bill-owed ${showing.cls}`} data-bill-owed>
            <span className="k">{showing.k}</span>
            <b className="money">{money(showing.v, cur)}</b>
          </div>
          <Button kind="secondary" icon="print" onClick={() => window.print()}>
            Print
          </Button>
          <Button className="go" onClick={() => router.push(bookingHref(entryId))}>
            Open booking
          </Button>
        </div>
      </div>

      <article className="bill-sheet" aria-label="The bill">
        <header className="bill-mast">
          <div className="bill-hotel">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {b.hotel.logo ? <img src={b.hotel.logo} alt="" /> : null}
            <div>
              <h3>{b.hotel.name}</h3>
              <div className="sm">{b.hotel.address}</div>
              <div className="sm muted">{[b.hotel.phone, b.hotel.email].filter(Boolean).join(" · ")}</div>
              {b.hotel.tpn || b.hotel.gstTpn ? <div className="sm muted">{[b.hotel.tpn ? `TPN ${b.hotel.tpn}` : null, b.hotel.gstTpn ? `GST TPN ${b.hotel.gstTpn}` : null].filter(Boolean).join(" · ")}</div> : null}
            </div>
          </div>
          <div className="bill-title">
            <h2>Guest bill</h2>
            <div className="sm muted">As at {fmtDateTime(b.asAt, tz)}</div>
            {invoices.length ? (
              <div className="sm">Tax invoice {invoices.map((i) => i.number).join(", ")}</div>
            ) : stillRunning ? (
              <div className="sm muted">Running bill · not a tax invoice</div>
            ) : null}
          </div>
        </header>

        <dl className="bill-parties">
          <div>
            <dt>Billed to</dt>
            <dd>
              <b>{b.billedTo}</b>
              {b.customerTpn ? <span className="muted"> · TPN {b.customerTpn}</span> : null}
            </dd>
          </div>
          {guest && guest !== b.billedTo ? (
            <div>
              <dt>Guest</dt>
              <dd>{guest}</dd>
            </div>
          ) : null}
          <div>
            <dt>{only ? "Booking" : "Enquiry"}</dt>
            <dd className="mono">{only ? only.entryId : b.inquiryId}</dd>
          </div>
          {only ? (
            <div className="wide">
              <dt>Stay</dt>
              <dd className="bill-staydd">
                <StayDates checkIn={only.checkIn} checkOut={only.checkOut} />
                <span className="sm">{placesOf(only)}</span>
                <Chip tone={standingOf(only).tone}>{standingOf(only).word}</Chip>
              </dd>
            </div>
          ) : null}
        </dl>

        <table className="table bill-lines">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Date</th>
              <th>Description</th>
              <th style={{ width: 90 }}>Room</th>
              <th className="num" style={{ width: 130 }}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {b.stays.map((s) => (
              <StayRows key={s.entryId} s={s} many={many} cur={cur} onOpen={() => router.push(bookingHref(s.entryId))} />
            ))}
          </tbody>
        </table>

        <div className="bill-foot">
          <section className="bill-pays" aria-label="Payments">
            <h4>Payments</h4>
            {b.payments.length ? (
              <table className="table compact">
                <tbody>
                  {b.payments.map((p) => (
                    <tr key={p.id} className="static">
                      <td className="nowrap">{fmtDateTime(p.at, tz)}</td>
                      <td>
                        {p.direction === "OUT" ? "Refund" : "Received"}
                        {p.method ? ` · ${METHOD_WORD[p.method] ?? p.method.toLowerCase()}` : ""}
                        {many ? ` · Stay ${p.stayNo}` : ""}
                        {p.note ? <span className="sub">{p.note}</span> : null}
                      </td>
                      <td className="num money nowrap">{p.direction === "OUT" ? money(-p.amount, cur) : money(p.amount, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="sm muted" style={{ margin: 0 }}>
                Nothing received yet.
              </p>
            )}
          </section>

          <dl className="bill-ladder" aria-label="The totals">
            <Rung k="Net value" v={money(f.net, cur)} />
            <Rung k="Service charge" v={money(f.serviceCharge, cur)} />
            <Rung k="GST" v={money(f.gst, cur)} />
            <Rung k={many ? "Total for the trip" : "Total"} v={money(f.total, cur)} cls="total" />
            <Rung k="Received" v={money(-f.received, cur)} />
            {f.refunded ? <Rung k="Refunded" v={money(f.refunded, cur)} /> : null}
            {f.writtenOff ? <Rung k="Written off" v={money(-f.writtenOff, cur)} /> : null}
            {f.settledBefore ? <Rung k="Settled before this system" v={money(-f.settledBefore, cur)} /> : null}
            <Rung k={owing ? "Balance due" : "Nothing owed"} v={money(f.balance, cur)} cls={`balance ${owing ? "due" : "clear"}`} />
            {f.paidAhead ? <Rung k="Paid ahead" v={money(f.paidAhead, cur)} cls="ahead" /> : null}
          </dl>
        </div>
      </article>
    </div>
  );
}

function Rung({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className={`rung${cls ? ` ${cls}` : ""}`} data-rung={k}>
      <dt>{k}</dt>
      <dd className="money">{v}</dd>
    </div>
  );
}

function StayRows({ s, many, cur, onOpen }: { s: BillStay; many: boolean; cur: string; onOpen: () => void }) {
  const standing = standingOf(s);
  const colSpanEmpty = (
    <tr className="static bill-empty">
      <td colSpan={4} className="sm muted">
        {s.folioState === null ? "No bill yet." : "Nothing billed so far."}
      </td>
    </tr>
  );
  return (
    <>
      {many ? (
        <tr className="static bill-stay" data-bill-stay={s.stayNo}>
          <td colSpan={3}>
            <div className="bs">
              <b>Stay {s.stayNo}</b>
              <StayDates checkIn={s.checkIn} checkOut={s.checkOut} />
              <span className="sm">{placesOf(s)}</span>
              <Chip tone={standing.tone}>{standing.word}</Chip>
              <Button kind="secondary" compact className="bill-open" onClick={onOpen}>
                Open booking
              </Button>
            </div>
          </td>
          <td className="num money">
            <b>{money(s.figures.total, cur)}</b>
            <span className="sub">with taxes</span>
          </td>
        </tr>
      ) : null}
      {s.rows.length
        ? s.rows.map((r) => (
            <tr key={r.key} className="static">
              <td className="nowrap">{r.when}</td>
              <td>
                {r.description}
                {r.qty > 1 ? <span className="sub">{`${r.qty} nights × ${money(r.rate, cur)}`}</span> : null}
              </td>
              <td>{r.place ?? "—"}</td>
              <td className="num money">{money(r.amount, cur)}</td>
            </tr>
          ))
        : colSpanEmpty}
    </>
  );
}
