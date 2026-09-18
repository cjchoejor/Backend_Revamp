"use client";

/**
 * A guest's record — who they are, how we reach them, and their bookings. Editing a guest record
 * is not in the backend yet (there is no update route and no change trail, register BE-32), so
 * the record reads only.
 */
import { use, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, Chip, EmptyState, Icon, NotAvailableYet } from "@/design-system";
import { GuestLink, LoadFailed, LoadingBlock, OpenRow, RowStanding } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useDeskMoney } from "@/hooks/use-desk-data";
import { getGuestProfile, guestFullName } from "@/lib/api/guest-profiles";
import { listDeskBookings } from "@/lib/api/desk";
import { fmtDate, fmtRange, money } from "@/lib/ds/format";
import { bookerOfRow, channelWord } from "@/lib/ds/status";
import { stepNoOfStage } from "@/lib/ds/steps";

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="fact">
      <span className="k">{k}</span>
      <span className="v">{v || <span className="dash">—</span>}</span>
    </div>
  );
}

export default function GuestRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { session, isLoading } = useSession();
  const today = useHotelDay()?.today ?? null;
  const guest = useQuery({
    queryKey: ["guest", id],
    queryFn: () => getGuestProfile(session!, id),
    enabled: !!session && !isLoading,
  });
  const stays = useQuery({
    queryKey: ["desk-bookings", "guest", id],
    queryFn: () => listDeskBookings(session!, { guestProfileId: id }),
    enabled: !!session && !isLoading,
  });
  const rows = useMemo(() => [...(stays.data?.items ?? [])].sort((a, b) => (b.checkInDate ?? "").localeCompare(a.checkInDate ?? "")), [stays.data]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const m = useDeskMoney(ids);
  const stayed = rows.filter((r) => stepNoOfStage(r.currentStage) >= 7 && r.status !== "CANCELLED");
  const last = stayed[0]?.checkInDate ?? null;
  const g = guest.data;

  if (guest.isLoading || isLoading) {
    return (
      <div className="page">
        <LoadingBlock />
      </div>
    );
  }
  if (!g) {
    return (
      <div className="page">
        <LoadFailed what="this guest" onRetry={() => void guest.refetch()} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <a
            href="/guests"
            className="backlink"
            onClick={(e) => {
              e.preventDefault();
              router.back();
            }}
          >
            <Icon name="chev" /> Back
          </a>
          <h2>
            {guestFullName(g)}{" "}
            {g.vipTier ? (
              <Chip tone="accent" tier>
                VIP · {g.vipTier}
              </Chip>
            ) : null}
          </h2>
          <div className="meta">Guest record{g.nationality ? ` · ${g.nationality}` : ""}</div>
        </div>
        <Button kind="secondary" onClick={() => router.push("/bookings/new")}>
          New booking
        </Button>
      </div>

      <div className="card">
        <div className="grid4">
          <div className="kpi">
            <span className="meta">Bookings</span>
            <span className="figure">{stays.isLoading ? "…" : rows.length}</span>
          </div>
          <div className="kpi">
            <span className="meta">Stayed</span>
            <span className="figure">{stays.isLoading ? "…" : stayed.length}</span>
          </div>
          <div className="kpi">
            <span className="meta">Last stay</span>
            <span className="figure">{last ? fmtDate(last) : "—"}</span>
          </div>
          <div className="kpi">
            <span className="meta">Tier</span>
            <span className="figure">{g.clientTier ? g.clientTier.charAt(0) + g.clientTier.slice(1).toLowerCase() : "—"}</span>
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h4>Who they are</h4>
          <Fact k="Name" v={guestFullName(g)} />
          <Fact k="Nationality" v={g.nationality} />
          <Fact k="VIP" v={g.vipTier} />
        </div>
        <div className="card">
          <h4>How we reach them</h4>
          <Fact k="Phone" v={g.phone} />
          <Fact k="Email" v={g.email} />
        </div>
      </div>

      <section className="block">
        <div className="block-head">
          <h3>What changed</h3>
        </div>
        <NotAvailableYet what="Changes to this guest's record, with who made them," />
      </section>

      <section className="block">
        <div className="block-head">
          <h3>Their bookings</h3>
          <span className="meta">{rows.length}</span>
        </div>
        {stays.error && !stays.data ? (
          <LoadFailed what="their bookings" onRetry={() => void stays.refetch()} />
        ) : stays.isLoading ? (
          <LoadingBlock />
        ) : rows.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Stay</th>
                <th>Rooms</th>
                <th>Status</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const x = m.byId.get(r.id);
                const booker = bookerOfRow(r);
                return (
                  <OpenRow key={r.id} entryId={r.id} locked={r.status !== "ACTIVE"}>
                    <td>
                      <GuestLink row={r} />
                      <div className="meta">
                        {r.id} · {channelWord(r.inquiry?.sourceChannel, r.inquiry?.cameInAs)}
                        {booker && (booker.kind === "agent" || booker.kind === "company") ? ` · ${booker.name}` : ""}
                      </div>
                    </td>
                    <td className="nowrap">{fmtRange(r.checkInDate, r.actualCheckOutDate ?? r.checkOutDate)}</td>
                    <td>{r.roomNumbers.length ? r.roomNumbers.join(", ") : (r.numberOfRooms ?? "—")}</td>
                    <td>
                      <RowStanding row={r} hotelToday={today} balance={x?.folio?.outstandingBalance ?? null} />
                    </td>
                    <td className={`num ${x?.headline.amount != null ? "money" : "dash"}`}>{x?.headline.amount != null ? money(x.headline.amount, x.currency ?? "BTN") : "—"}</td>
                  </OpenRow>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No bookings yet" />
        )}
      </section>
    </div>
  );
}
