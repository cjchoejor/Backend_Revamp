"use client";

/**
 * Shift — the front desk's handover, in the order of the paper form. The backend has no shift yet
 * (register BE-73): nothing typed here could be kept, so the typed sections wait, and only what
 * the record already holds is shown — the bills still open and the state of the rooms.
 */
import { useMemo } from "react";
import { Button, Chip, EmptyState, NotAvailableYet } from "@/design-system";
import { GuestLink, LoadingBlock, OpenRow } from "@/components/ds/ui";
import { ROLE_WORD } from "@/components/ds/app-shell";
import { useDeskBookings, useDeskMoney, useRoomsList } from "@/hooks/use-desk-data";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { clockParts, money } from "@/lib/ds/format";
import { stepNoOfStage } from "@/lib/ds/steps";
import type { ReactNode } from "react";

function Section({ n, title, auto, children }: { n: number; title: string; auto: boolean; children: ReactNode }) {
  return (
    <div className="section-n">
      <span className="n">{n}</span>
      <div className="card" style={{ width: "100%" }}>
        <h4>
          {title}
          <span className="auto">{auto ? "pre-filled" : "typed"}</span>
        </h4>
        <div style={{ marginTop: 8 }}>{children}</div>
      </div>
    </div>
  );
}

const WAITS = "the backend has no shift yet — nothing typed here could be kept";

export default function ShiftPage() {
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const bookings = useDeskBookings();
  const rooms = useRoomsList();

  const inHouse = useMemo(
    () => (bookings.data?.items ?? []).filter((r) => r.status === "ACTIVE" && [7, 8].includes(stepNoOfStage(r.currentStage)) && r.folio),
    [bookings.data],
  );
  const ids = useMemo(() => inHouse.map((r) => r.id), [inHouse]);
  const m = useDeskMoney(ids);
  const owing = inHouse.filter((r) => (m.byId.get(r.id)?.folio?.outstandingBalance ?? 0) > 0);

  const items = rooms.data?.items ?? [];
  const claim = (s: string) => items.filter((r) => (r.currentClaimState ?? "").toUpperCase() === s).length;
  const counts = {
    free: items.filter((r) => ["FREE", "DEPARTED_CLEAN"].includes((r.currentClaimState ?? "FREE").toUpperCase()) && !r.isBlocked && !r.isUnderMaintenance).length,
    reserved: claim("CONFIRMED") + claim("COMMITTED_HELD"),
    occupied: claim("OCCUPIED"),
    dirty: items.filter((r) => (r.physicalState ?? "").toUpperCase() === "DIRTY" || (r.currentClaimState ?? "").toUpperCase() === "DEPARTED_DIRTY").length,
    ooo: items.filter((r) => r.isBlocked || r.isUnderMaintenance).length,
    deficient: items.filter((r) => r.isDeficient).length,
  };
  const now = clockParts(clock.now, clock.tz);

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <div>
          <h2>Shift</h2>
          <div className="meta">Front desk handing over and taking over · the paper form, in order · {WAITS}</div>
        </div>
      </div>

      <div className="sections">
        <Section n={1} title="Shift and staff" auto>
          <div className="row-acts">
            <Chip tone="solid">
              {now.date} · {now.time}
            </Chip>
            <span className="sm">
              Handing over <b>{session?.displayName ?? session?.username ?? "—"}</b>
              {session ? ` · ${ROLE_WORD[session.actorLevel] ?? ""}` : ""} · taking over <span className="dash">—</span>
            </span>
          </div>
        </Section>
        <Section n={2} title="Opening float and petty cash" auto={false}>
          <NotAvailableYet what="The opening float and petty cash" />
        </Section>
        <Section n={3} title="Cash and payments by method" auto>
          <NotAvailableYet what="Payments taken this shift, by method," />
        </Section>
        <Section n={4} title="Closing count and variance" auto={false}>
          <NotAvailableYet what="The closing count and its difference" />
        </Section>
        <Section n={5} title="Outstanding bills" auto>
          {bookings.isLoading ? (
            <LoadingBlock />
          ) : owing.length ? (
            <table className="table compact">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Room</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {owing.map((r) => {
                  const x = m.byId.get(r.id);
                  return (
                    <OpenRow key={r.id} entryId={r.id}>
                      <td>
                        <GuestLink row={r} /> <span className="meta">· {r.id}</span>
                      </td>
                      <td>{r.roomNumbers.join(", ") || "—"}</td>
                      <td className="num money">{money(x?.folio?.outstandingBalance, x?.currency ?? "BTN")}</td>
                    </OpenRow>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No in-house bill carries a balance" />
          )}
        </Section>
        <Section n={6} title="Room status summary" auto>
          <div className="row-acts">
            <Chip>Free {counts.free}</Chip>
            <Chip tone="solid">Reserved {counts.reserved}</Chip>
            <Chip tone="solid" icon="person">
              Occupied {counts.occupied}
            </Chip>
            <Chip icon="broom">Needs cleaning {counts.dirty}</Chip>
            <Chip tone="warning" icon="wrench">
              Out of order {counts.ooo}
            </Chip>
            <Chip tone="warning" icon="alert">
              Deficient {counts.deficient}
            </Chip>
          </div>
        </Section>
        <Section n={7} title="Guest matters" auto={false}>
          <NotAvailableYet what="Notes for the next shift about a guest" />
        </Section>
        <Section n={8} title="Messages and deliveries" auto={false}>
          <NotAvailableYet what="Messages taken and parcels held" />
        </Section>
        <Section n={9} title="Maintenance" auto={false}>
          <div className="row-acts" style={{ marginBottom: 8 }}>
            {items
              .filter((r) => r.isDeficient || r.isBlocked || r.isUnderMaintenance)
              .map((r) => (
                <Chip key={r.id} tone="warning" icon={r.isDeficient ? "alert" : "wrench"}>
                  {r.roomNumber}
                  {r.blockedReason ? ` · ${r.blockedReason}` : r.isDeficient ? " · fault reported" : ""}
                </Chip>
              ))}
          </div>
          <span className="meta">Faults are reported from the room on Rooms.</span>
        </Section>
        <Section n={10} title="Events and key log" auto>
          <NotAvailableYet what="Today's events and the keys out" />
        </Section>
        <Section n={11} title="Remarks and supervisor verification" auto={false}>
          <div className="row-acts">
            <Button icon="lock" state="inert" reason={WAITS}>
              Close shift and hand over
            </Button>
            <Button kind="secondary" state="inert" unlockRole="FOM">
              Cash handover to the FOM
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
