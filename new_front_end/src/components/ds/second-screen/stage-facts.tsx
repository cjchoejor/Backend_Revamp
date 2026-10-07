"use client";

/**
 * The second screen's middle column from Reserve to Closed (2026-10-07, operator: "we have till
 * stage 4 right, do it for all stages"). Each step shows what its desk work is about, read off the
 * booking and the backend's own figures — and every line with a desk card takes the desk there.
 *
 *  Reserve   — the confirmation, the voucher and its answer, the frozen total
 *  Arrival   — the rooms and whether each is ready, the pre-arrival tasks, the advance, the handoff,
 *              the guest at the desk
 *  Check-in  — every guest's details, the ID check, the registration card, VIP, the rooms and keys
 *  Stay      — the money so far, by room, the latest charges, the nights posted, the departments,
 *              disputes, faults, the rooms and keys
 *  Check-out — the bill, the keys back, the inspection, the pre-checkout handoff
 *  Closed    — the invoices, what is still owed, follow-ups, and what the seal still waits for
 *
 * Nothing is added up here: money is printed as the backend gave it; counts are counts.
 */
import { Icon } from "@/design-system";
import type { EntryBillingSummary, EntryCommunication } from "@/lib/api/entries";
import type { RoomListItem } from "@/lib/api/rooms";
import type { GuestDetailsCoverage } from "@/lib/api/identity-proofs";
import { ROOM_STATUS, deriveRoomStatus } from "@/lib/desk/rooms";
import { roomStayRangesByRoom, roomsInUseFor } from "@/lib/desk/party-rooms";
import { effectiveCheckOutIso } from "@/lib/desk/workspace";
import { fmtDateTime, fmtDay, money, plural } from "@/lib/ds/format";
import { enumerateNights } from "@/components/ds/steps/use-room-selection";
import { taskLabel } from "@/components/ds/steps/s5-pre-arrival-tasks";
import { words } from "@/components/ds/steps/kit";
import type { EntryDetail, PaymentStatusSummary } from "@/types/api";

const HANDOFF_WORD: Record<string, string> = {
  CREATED: "told, not yet accepted",
  ACCEPTED: "accepted",
  FULFILLED: "done",
  CLOSED: "closed",
  CANCELLED: "withdrawn",
};
const HANDOFF_NAME: Record<string, string> = { H1: "Front desk", H2: "Housekeeping", H3: "Kitchen", H4: "Pre-checkout", H5: "Post-stay" };

export type DeskLocal = { guestPresent?: boolean; registrationConfirmed?: boolean; keysMarked?: string[] };

type Props = {
  entry: EntryDetail;
  current: number;
  billing: EntryBillingSummary | null;
  payment: PaymentStatusSummary | null;
  communications: EntryCommunication[];
  coverage: GuestDetailsCoverage | null;
  verifiedAt: string | null;
  closure: { canClose: boolean; checks: Array<{ label: string; met: boolean }> } | null;
  local: DeskLocal | null;
  roomById: Map<string, RoomListItem>;
  hotelToday: string | null;
  tz: string;
  onGo: (card: string) => void;
};

export function StageFacts(p: Props) {
  switch (p.current) {
    case 4:
      return <ReserveFacts {...p} />;
    case 5:
      return <ArrivalFacts {...p} />;
    case 6:
      return <CheckInFacts {...p} />;
    case 7:
      return <StayFacts {...p} />;
    case 8:
      return <CheckOutFacts {...p} />;
    case 9:
      return <ClosedFacts {...p} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */

function Facts({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h3>{title}</h3>
      <table className="board-facts">
        <tbody>{children}</tbody>
      </table>
    </>
  );
}

/** One fact; red when something is still to do, green when done; clickable when it has a card. */
function Row({ k, v, state, card, onGo }: { k: string; v: React.ReactNode; state?: "todo" | "done" | null; card?: string; onGo?: (card: string) => void }) {
  const go = card && onGo ? () => onGo(card) : undefined;
  return (
    <tr className={`${state === "todo" ? "missing" : state === "done" ? "done" : ""}${go ? " go" : ""}`} onClick={go} title={go ? "Show it on the desk" : undefined}>
      <th>{k}</th>
      <td>{v}</td>
    </tr>
  );
}

const cur = (b: EntryBillingSummary | null) => b?.currency ?? "BTN";

function advanceWords(payment: PaymentStatusSummary | null, c: string): { v: string; state: "todo" | "done" } | null {
  if (!payment) return null;
  if (payment.requiredAmount <= 0 && payment.totalReceived <= 0) return { v: "no advance asked", state: "done" };
  return {
    v: `asked ${money(payment.requiredAmount, c)} · received ${money(payment.totalReceived, c)}${payment.shortfall > 0 ? ` · ${money(payment.shortfall, c)} still owed` : ""}${payment.creditExtensionActive ? " · covered by the FOM's credit" : ""}`,
    state: payment.satisfied ? "done" : "todo",
  };
}

function MoneyRows({ billing }: { billing: EntryBillingSummary | null }) {
  const f = billing?.folio ?? null;
  const c = cur(billing);
  if (!f) return <Row k="The bill" v="not open yet" />;
  return (
    <>
      <Row k="Billed so far" v={money(f.billedSoFar ?? 0, c)} />
      <Row k="Paid" v={money(f.paymentsReceived ?? 0, c)} />
      <Row k="Balance" v={<b>{money(f.outstandingBalance ?? 0, c)}</b>} state={(f.outstandingBalance ?? 0) > 0 ? "todo" : "done"} />
    </>
  );
}

/** Every room of the plan: its nights, whether it is ready, its key. */
function RoomsNow({ entry, roomById, local, hotelToday, card, onGo, keys }: Props & { card?: string; keys?: boolean }) {
  const rows = roomsInUseFor(entry, hotelToday);
  const ids = [...new Set(rows.map((a) => a.roomId))];
  const ranges = roomStayRangesByRoom(entry);
  const marked = new Set(local?.keysMarked ?? []);
  if (!ids.length) {
    return (
      <>
        <h3>The rooms</h3>
        <p className="quiet">No room assigned yet.</p>
      </>
    );
  }
  return (
    <>
      <h3>The rooms</h3>
      <table className="board-party">
        <thead>
          <tr>
            <th>Room</th>
            <th>Type</th>
            <th>Nights</th>
            <th>Room state</th>
            {keys ? <th>Key</th> : null}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const a = rows.find((r) => r.roomId === id)!;
            const r = roomById.get(id);
            const status = r ? deriveRoomStatus(r) : null;
            const faults = (a.room?.deficientConditionRecords ?? []).filter((d) => !d.resolvedAt).length;
            const keyOut = rows.some((x) => x.roomId === id && x.keyIssuedAt && !x.keyReturnedAt);
            const keyBack = rows.some((x) => x.roomId === id && x.keyReturnedAt);
            const go = card ? () => onGo(card) : undefined;
            return (
              <tr key={id} className={go ? "go" : undefined} onClick={go} title={go ? "Show it on the desk" : undefined}>
                <td className="rn">{r?.roomNumber ?? a.room?.roomNumber ?? id.slice(0, 6)}</td>
                <td>{r?.roomType?.name ?? "—"}</td>
                <td>{ranges.get(id)?.label ?? "—"}</td>
                <td>
                  {status ? <span className={`rs rs-${status}`}>{ROOM_STATUS[status].label}</span> : "—"}
                  {faults ? <span className="warn-ink"> · {plural(faults, "fault")}</span> : null}
                </td>
                {keys ? (
                  <td className={!keyOut && !keyBack && marked.has(id) ? "chg" : undefined}>
                    {keyBack ? "returned" : keyOut ? "with the guest" : marked.has(id) ? "marked — not saved yet" : "not given"}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/* ---- Reserve ---- */
function ReserveFacts(p: Props) {
  const { entry, billing, communications, tz } = p;
  const res = entry.reservation;
  const voucher = [...communications]
    .filter((c) => c.commType === "CONFIRMATION_VOUCHER" && c.sendStatus === "DISPATCHED")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (
    <Facts title="Reserved">
      <Row k="Confirmed" v={res?.confirmedAt ? fmtDateTime(res.confirmedAt, tz) : "not yet"} state={res?.confirmedAt ? "done" : "todo"} />
      <Row k="Total, frozen" v={billing?.headline.amount != null ? money(billing.headline.amount, cur(billing)) : "—"} />
      <Row
        k="Confirmation voucher"
        v={!voucher ? "not sent" : voucher.acknowledgementStatus === "RECEIVED" ? "sent · the guest answered" : `sent ${fmtDateTime(voucher.createdAt, tz)} · no answer yet`}
        state={voucher?.acknowledgementStatus === "RECEIVED" ? "done" : "todo"}
      />
      {(entry as { reservationPaymentPending?: boolean }).reservationPaymentPending ? <Row k="Advance" v="not fully paid — the rooms read Held until it is" state="todo" /> : null}
    </Facts>
  );
}

/* ---- Arrival ---- */
function ArrivalFacts(p: Props) {
  const { entry, payment, billing, local, onGo } = p;
  const tasks = entry.preArrivalTasks ?? [];
  const h1 = [...(entry.handoffs ?? [])].filter((h) => h.handoffType === "H1").sort((a, b) => String(b.assignedAt ?? "").localeCompare(String(a.assignedAt ?? "")))[0];
  const adv = advanceWords(payment, cur(billing));
  return (
    <>
      <RoomsNow {...p} card="rooms" />
      <h3>Pre-arrival tasks</h3>
      {tasks.length ? (
        <ul className="board-tasks">
          {tasks.map((t) => (
            <li key={t.id} className={t.status === "PENDING" ? "todo" : "done"}>
              <button type="button" className="gb-line" onClick={() => onGo("tasks")} title="Show it on the desk">
                <span className="mark">{t.status === "PENDING" ? "•" : <Icon name="check" />}</span>
                {taskLabel(t.taskType)}
                <span className="meta"> · {t.status === "COMPLETE" ? "done" : t.status === "WAIVED" ? `waived${t.waivedReason ? ` — ${t.waivedReason}` : ""}` : "open"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">None set up.</p>
      )}
      <Facts title="Before the guest arrives">
        {adv ? <Row k="Advance" v={adv.v} state={adv.state} card="advance" onGo={onGo} /> : null}
        <Row k="Front-desk handoff" v={h1 ? HANDOFF_WORD[h1.state] ?? words(h1.state) : "not raised yet"} state={h1?.state === "FULFILLED" ? "done" : "todo"} card="handoff" onGo={onGo} />
        <Row k="The guest is here" v={local?.guestPresent ? "yes — marked on the desk" : "not yet"} state={local?.guestPresent ? "done" : "todo"} card="present" onGo={onGo} />
      </Facts>
    </>
  );
}

/* ---- Check-in ---- */
function CheckInFacts(p: Props) {
  const { entry, coverage, verifiedAt, local, payment, billing, tz, onGo } = p;
  const vip = !!entry.guestProfile?.vipTier;
  const adv = advanceWords(payment, cur(billing));
  return (
    <>
      <Facts title="At the counter">
        <Row
          k="Every guest's details"
          v={
            coverage
              ? coverage.vipExempt
                ? "not needed — a VIP booking"
                : coverage.satisfied
                  ? `all ${coverage.totalSlots} recorded`
                  : `${coverage.filledSlots} of ${coverage.totalSlots} — still to record: ${coverage.missing.map((m) => m.label).join(", ")}`
              : "—"
          }
          state={coverage ? (coverage.satisfied ? "done" : "todo") : null}
          card="identity"
          onGo={onGo}
        />
        <Row k="ID checked" v={verifiedAt ? `checked ${fmtDateTime(verifiedAt, tz)}` : "not yet"} state={verifiedAt ? "done" : "todo"} card="identity" onGo={onGo} />
        <Row
          k="Registration card"
          v={entry.registrationCompletedAt ? "signed" : local?.registrationConfirmed ? "signed — recorded with the check-in" : "not signed yet"}
          state={entry.registrationCompletedAt || local?.registrationConfirmed ? "done" : "todo"}
          card="registration"
          onGo={onGo}
        />
        {vip ? (
          <Row k="VIP arrival" v={(entry.vipArrivalNotifications ?? []).length ? "the VIP team is told" : "tell the VIP team"} state={(entry.vipArrivalNotifications ?? []).length ? "done" : "todo"} card="vip" onGo={onGo} />
        ) : null}
        {adv ? <Row k="Advance" v={adv.v} state={adv.state} card="advance" onGo={onGo} /> : null}
      </Facts>
      <RoomsNow {...p} card="rooms" keys />
    </>
  );
}

/* ---- Stay ---- */
function StayFacts(p: Props) {
  const { entry, billing, hotelToday, onGo } = p;
  const c = cur(billing);
  const lines = [...(entry.folio?.lines ?? [])].sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)));
  const recent = lines.filter((l) => !/^(Service charge|GST)\b/i.test(l.description)).slice(0, 5);
  const nights = enumerateNights(entry.checkInDate, effectiveCheckOutIso(entry));
  const slept = hotelToday ? nights.filter((n) => n < hotelToday) : [];
  const posted = new Set(lines.filter((l) => l.lineType === "ROOM_CHARGE").map((l) => String(l.chargeDate).slice(0, 10)));
  const notPosted = slept.filter((n) => !posted.has(n));
  const depts = (entry.handoffs ?? []).filter((h) => h.handoffType === "H2" || h.handoffType === "H3");
  const openDisputes = (entry.disputes ?? []).filter((d) => !/CLOSED|RESOLVED/.test(d.status));
  const openFaults = (entry.roomAssignments ?? []).flatMap((a) => a.room?.deficientConditionRecords ?? []).filter((d) => !d.resolvedAt);
  const byRoom = billing?.folio?.perRoomCharges ?? [];
  return (
    <>
      <Facts title="The bill so far">
        <MoneyRows billing={billing} />
        {byRoom.length > 1 ? <Row k="By room" v={byRoom.map((r) => `${r.roomNumber ?? "—"} ${money(r.charges, c)}`).join(" · ")} card="folio" onGo={onGo} /> : null}
      </Facts>
      {recent.length ? (
        <>
          <h3>Latest charges</h3>
          <ul className="board-feed">
            {recent.map((l) => (
              <li key={l.id}>
                <span>
                  {l.description} · <b>{money(l.amount, c)}</b>
                </span>
                <span className="meta">{fmtDay(l.chargeDate)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Facts title="During the stay">
        <Row
          k="Nights posted"
          v={slept.length ? `${slept.length - notPosted.length} of ${plural(slept.length, "night")} slept${notPosted.length ? ` — not yet: ${notPosted.map((n) => fmtDay(n)).join(", ")}` : ""}` : "no night slept yet"}
          state={notPosted.length ? "todo" : slept.length ? "done" : null}
          card="nights"
          onGo={onGo}
        />
        {depts.map((h) => (
          <Row key={h.id} k={HANDOFF_NAME[h.handoffType] ?? h.handoffType} v={HANDOFF_WORD[h.state] ?? words(h.state)} state={h.state === "CREATED" ? "todo" : "done"} card="departments" onGo={onGo} />
        ))}
        <Row k="Disputes" v={openDisputes.length ? `${plural(openDisputes.length, "open dispute")} — ${openDisputes.map((d) => d.title).join(", ")}` : "none open"} state={openDisputes.length ? "todo" : "done"} card="disputes" onGo={onGo} />
        <Row k="Faults in the rooms" v={openFaults.length ? `${plural(openFaults.length, "fault")} open` : "none open"} state={openFaults.length ? "todo" : "done"} card="faults" onGo={onGo} />
      </Facts>
      <RoomsNow {...p} keys />
    </>
  );
}

/* ---- Check-out ---- */
function CheckOutFacts(p: Props) {
  const { entry, billing, tz, onGo } = p;
  const h4 = [...(entry.handoffs ?? [])].filter((h) => h.handoffType === "H4").sort((a, b) => String(b.assignedAt ?? "").localeCompare(String(a.assignedAt ?? "")))[0];
  const rooms = [...new Set((entry.roomAssignments ?? []).map((a) => a.roomId))];
  const keysOut = (entry.roomAssignments ?? []).filter((a) => a.keyIssuedAt && !a.keyReturnedAt).length;
  const inspection = (entry.roomInspectionRecords ?? [])[0] ?? null;
  const settled = entry.folio?.state === "SETTLED" || entry.folio?.state === "OUTSTANDING";
  return (
    <>
      <Facts title="The bill">
        <MoneyRows billing={billing} />
        <Row k="Settled" v={settled ? (entry.folio?.state === "OUTSTANDING" ? "settled — part still owed" : "settled") : "not yet"} state={settled ? "done" : "todo"} card="settle" onGo={onGo} />
      </Facts>
      <Facts title="The departure">
        <Row k="Keys" v={keysOut ? `${plural(keysOut, "key")} still with the guest` : `all back (${plural(rooms.length, "room")})`} state={keysOut ? "todo" : "done"} card="departure" onGo={onGo} />
        <Row
          k="Room inspection"
          v={inspection ? `${inspection.isDeferred ? "put off" : "done"} ${fmtDateTime(inspection.inspectedAt, tz)}${inspection.damageFound ? " · damage found" : ""}` : "not recorded"}
          state={inspection ? "done" : "todo"}
          card="departure"
          onGo={onGo}
        />
        <Row k="Pre-checkout handoff" v={h4 ? HANDOFF_WORD[h4.state] ?? words(h4.state) : "not raised"} state={h4 && (h4.state === "FULFILLED" || h4.isAutoFulfilled) ? "done" : "todo"} />
      </Facts>
      <RoomsNow {...p} keys />
    </>
  );
}

/* ---- Closed ---- */
function ClosedFacts(p: Props) {
  const { entry, billing, closure, tz } = p;
  const finals = (entry.folio?.invoices ?? []).filter((i) => i.invoiceType === "FINAL" && i.state !== "SUPERSEDED");
  const follow = (entry.followUpTasks ?? []).filter((t) => !t.completedAt).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <>
      <Facts title="After the stay">
        <MoneyRows billing={billing} />
        <Row
          k="Invoice"
          v={finals.length ? finals.map((i) => `${i.invoiceNumber ?? i.id} · ${i.dispatchedAt ? "sent" : "not sent"}`).join(" · ") : "not issued yet"}
          state={finals.some((i) => i.dispatchedAt) ? "done" : "todo"}
        />
        {follow.length ? <Row k="Follow-ups" v={`${plural(follow.length, "open follow-up")} · next ${fmtDateTime(follow[0].dueAt, tz)}`} state="todo" /> : null}
      </Facts>
      {closure ? (
        <>
          <h3>Before the record is sealed</h3>
          <ul className="board-tasks">
            {closure.checks.map((c) => (
              <li key={c.label} className={c.met ? "done" : "todo"}>
                <span className="mark">{c.met ? <Icon name="check" /> : "•"}</span>
                {c.label}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
