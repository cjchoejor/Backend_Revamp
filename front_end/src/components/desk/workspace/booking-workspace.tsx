"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, Check, ChevronLeft, History, Layers, ListChecks, Lock, Pause, Play } from "lucide-react";
import { SpecialPreference } from "./special-preference";
import { SegmentHistoryPanel } from "./segment-history";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  getBillingSummary,
  getEntry,
  getEntryTimers,
  listEntryCommunications,
  progressStage,
  parkEntry,
  unparkEntry,
} from "@/lib/api/entries";
import { countdownTo, findParkTimer } from "@/lib/desk/timers";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { usePageTitle } from "@/hooks/use-page-title";
import { closeEntryAtS9 } from "@/lib/api/post-stay";
import { activatePreArrival } from "@/lib/api/pre-arrival";
import { completeCheckInToS7 } from "@/lib/api/check-in";
import { listIdentityProofs } from "@/lib/api/identity-proofs";
import { ApiError } from "@/lib/api/client";
import {
  avatarColor,
  dwellTimer,
  formatStayRangeDMY,
  guestName,
  initialsOf,
  partyCaption,
  DESK_STEPS,
  stepForStage,
  type DeskStep,
} from "@/lib/desk/model";
import {
  activeQuotation,
  canConfirm,
  confirmReadiness,
  currentStepOrder,
  deriveFinancials,
  maxReachableOrder,
  money,
  moneyOrDash,
  preconditionsFor,
  s1Readiness,
  canProgressS1,
  s2Readiness,
  canProgressS2,
  s5Readiness,
  canProgressS5,
  s6Readiness,
  s7Readiness,
  canProgressS7,
  s8Readiness,
  canProgressS8,
  s9CloseReadiness,
  canCloseS9,
  type DeskFinancials,
} from "@/lib/desk/workspace";
import { arrivalNightRoomIds } from "@/lib/desk/party-rooms";
import { DeskConfirmModal } from "./confirm-modal";
import { ReEnterMenu } from "./re-enter-menu";
import { InquiryStep as InquiryStepBase } from "./inquiry-step";
import { QuoteStep as QuoteStepBase } from "./quote-step";
import { SetupStep as SetupStepBase } from "./setup-step";
import { ArrivalStep as ArrivalStepBase } from "./arrival-step";
import { CheckInStep as CheckInStepBase } from "./checkin-step";
import { StayStep as StayStepBase } from "./stay-step";
import { CheckOutStep as CheckOutStepBase } from "./checkout-step";
import { PostStayStep as PostStayStepBase } from "./closed-step";
import { ConfirmStep as ConfirmStepBase } from "./confirm-step";
import { CancellationVoucherBlock } from "./confirmation-voucher";
import { BackendRail, BackendRailSlotContext, LiveBackendFeed, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";
import { roomsFromResultSet } from "@/lib/api/availability";

/**
 * The workspace lifts a few UI states (selected step, modal flags, key-count,
 * registration, guest-present, night-audit, park reason) into BookingWorkspace.
 * Any change to those re-renders the parent — so without memo the heavy active
 * step component (and the summary/canvas) would re-render on every such event,
 * even though their props (entry, stable setters) didn't change. Memoising the
 * step components and the two presentational panels means a parent re-render
 * (opening a modal, typing key-count, a child syncing state up) no longer
 * re-renders a step whose props are unchanged. Props passed to these are all
 * referentially stable (entry is structurally-shared by React Query; setters are
 * stable useState dispatchers), so the memo comparison is effective.
 */
const InquiryStep = memo(InquiryStepBase);
const QuoteStep = memo(QuoteStepBase);
const SetupStep = memo(SetupStepBase);
const ArrivalStep = memo(ArrivalStepBase);
const CheckInStep = memo(CheckInStepBase);
const StayStep = memo(StayStepBase);
const CheckOutStep = memo(CheckOutStepBase);
const PostStayStep = memo(PostStayStepBase);
const ConfirmStep = memo(ConfirmStepBase);

type Epi = "cap" | "der" | "sug" | "sys";
const EPI_MARK: Record<Epi, string> = { cap: "✎", der: "∑", sug: "◇", sys: "⚙" };

// Stable no-op passed to a read-only (past) step's setters so it can never drive navigation or
// mutate lifted state. Kept module-level so it stays referentially stable (memo-friendly).
const NOOP = () => {};

function ValRow({ label, value, epi = "cap" }: { label: string; value: ReactNode; epi?: Epi }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className={`val${epi === "der" ? " derived" : ""}`}>
        {value}
        <span className="axis">
          <span className={`axis-mk ${epi}`}>{EPI_MARK[epi]}</span>
        </span>
      </div>
    </div>
  );
}

const DASH = <span style={{ color: "var(--ink-3)" }}>—</span>;

const StepCanvas = memo(StepCanvasBase);
function StepCanvasBase({ step, entry, fin }: { step: DeskStep; entry: EntryDetail; fin: DeskFinancials }) {
  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const name = guestName(g);
  const stay = formatStayRangeDMY(entry.checkInDate, entry.checkOutDate) || "Dates not set";
  const quote = activeQuotation(entry);

  switch (step.key) {
    case "inquiry": {
      const chosen = (entry.availabilityConfigs ?? []).some((c) => c.optionSelected);
      const configCount = (entry.availabilityConfigs ?? []).length;
      return (
        <>
          <Speak now="The inquiry" h2="Understand the stay, then explore availability.">
            What the guest needs. The system offers configurations that work for these dates — you choose one;
            specific room numbers come later, at arrival.
          </Speak>
          <div className="block">
            <BlockH>The guest</BlockH>
            <div className="frow">
              <ValRow label="Primary contact" value={name} />
              <ValRow label="Phone" value={g?.phone ?? DASH} />
            </div>
            <ValRow label="Guests" value={entry.guestCount ?? DASH} />
          </div>
          <div className="block">
            <BlockH>Availability</BlockH>
            <ValRow
              label="Configuration"
              value={chosen ? "Chosen" : configCount ? `${configCount} offered · none chosen yet` : "Not explored yet"}
              epi="sug"
            />
          </div>
        </>
      );
    }
    case "quote": {
      return (
        <>
          <Speak now="Negotiation" h2="Shape the price and send the quote.">
            The figure is still a range — nothing here binds the guest yet.
          </Speak>
          <div className="block">
            <BlockH>The offer</BlockH>
            {quote ? (
              <>
                <ValRow label="Indicative total" value={money(quote.totalAmount, quote.currency)} epi="der" />
                <ValRow label="State" value={quote.state} />
                <ValRow
                  label="Valid until"
                  value={quote.validUntil ? new Date(quote.validUntil).toLocaleString() : DASH}
                  epi="sys"
                />
              </>
            ) : (
              <ValRow label="Quotation" value="No quote drafted yet" />
            )}
          </div>
        </>
      );
    }
    case "setup": {
      const held = !!entry.committedHold || (entry.speculativeHolds ?? []).length > 0;
      return (
        <>
          <Speak now="Set up" h2="Hold the rooms and take a deposit.">
            This places a hold against inventory and records what protects the hotel if the guest cancels. Still
            nothing frozen — the hold has a timer and releases if the booking doesn&rsquo;t confirm in time.
          </Speak>
          <div className="block">
            <BlockH>Hold &amp; deposit</BlockH>
            <ValRow label="Rooms held" value={held ? "Hold placed" : "No hold yet"} epi="sys" />
            <ValRow
              label="Advance payment"
              value={
                fin.advanceReceived == null
                  ? DASH
                  : fin.advanceReceived > 0
                    ? `${money(fin.advanceReceived, fin.currency)} received`
                    : "Not recorded yet"
              }
              epi="sys"
            />
            <ValRow
              label="Cancellation terms shown to guest"
              value={entry.cancellationDisclosure ? "Disclosed & acknowledged" : "Not recorded yet"}
            />
          </div>
        </>
      );
    }
    case "confirm": {
      // Distinct assigned rooms (with their date window when it's a per-night / multi-segment
      // assignment) so a confirmed reservation shows its rooms without opening the Arrival step.
      const roomLabels = Array.from(
        new Map(
          (entry.roomAssignments ?? []).map((a) => [a.room?.roomNumber ?? a.roomId, a]),
        ).values(),
      ).map((a) => a.room?.roomNumber ?? String(a.roomId).slice(0, 6));
      // Before rooms are formally assigned at Arrival (S5), fall back to the room(s) selected +
      // sealed at Inquiry (S1) so the confirm summary isn't blank. Resolves ids → numbers via the
      // sealed availability config's resultSet (same source Arrival uses). The specific room can
      // still be changed at Arrival — this is the selection, not the final assignment.
      const sealedCfg = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
      const sealedRoomIds = optionSelectedRoomIds(sealedCfg?.optionSelected);
      let sealedRoomLabels: string[] = [];
      if (sealedCfg?.resultSet && sealedRoomIds.length) {
        const { availableRooms, deficientRooms } = roomsFromResultSet(sealedCfg.resultSet);
        const byId = new Map(
          [...availableRooms, ...deficientRooms]
            .filter((r) => r.roomId)
            .map((r) => [r.roomId, r.roomNumber ?? r.roomId] as const),
        );
        sealedRoomLabels = sealedRoomIds.map((id) => byId.get(id) ?? String(id).slice(0, 6));
      }
      const roomsAssigned = roomLabels.length > 0;
      const displayRooms = roomsAssigned ? roomLabels : sealedRoomLabels;
      const s4Groups: RailGroup[] = [
        { key: "confirm", label: "On freeze & confirm", items: STAGE_ACTIONS.S4.confirm },
        { key: "activate", label: "On continue to Arrival", items: STAGE_ACTIONS.S4.activate },
      ];
      const s4Active = [
        fin.frozen ? "confirm" : null,
        entry.currentStage !== "S3" && entry.currentStage !== "S4" ? "activate" : null,
      ].filter(Boolean) as string[];
      return (
        <div className="bx-split">
          <div className="bx-main">
          <Speak
            now={fin.frozen ? "Confirmed" : "The one moment that locks"}
            h2={fin.frozen ? "This booking is frozen and live." : "Ready to freeze this booking."}
          >
            {fin.frozen
              ? "Terms are held to the guest. Any change now opens a fresh segment rather than editing what's sealed."
              : "Confirming turns the range into a total the guest is held to, locks the rooms, and sends the confirmation."}
          </Speak>
          <div className="block">
            <BlockH>{fin.frozen ? "What's sealed" : "What gets frozen"}</BlockH>
            <ValRow label="Guest" value={name} />
            <ValRow label="Stay" value={stay} epi="der" />
            <ValRow
              label={`Room${displayRooms.length === 1 ? "" : "s"}${entry.numberOfRooms ? ` (${displayRooms.length}/${entry.numberOfRooms})` : ""}`}
              value={
                displayRooms.length === 0
                  ? "Not assigned yet"
                  : roomsAssigned
                    ? displayRooms.join(", ")
                    : `${displayRooms.join(", ")} — selected at inquiry, assigned at arrival`
              }
              epi="sys"
            />
            <ValRow
              label={fin.frozen ? "Frozen rate" : "Total to be frozen"}
              value={
                fin.frozen
                  ? fin.frozenRate !== null
                    ? money(fin.frozenRate, fin.currency)
                    : DASH
                  : fin.indicativeTotal !== null
                    ? money(fin.indicativeTotal, fin.currency)
                    : DASH
              }
              epi="der"
            />
            {fin.frozen && entry.reservation?.confirmedAt && (
              <ValRow
                label="Confirmed"
                value={new Date(entry.reservation.confirmedAt).toLocaleString()}
                epi="sys"
              />
            )}
          </div>
          </div>

          <BackendRail entryId={entry.id} groups={s4Groups} activeKeys={s4Active} firingKey={null} />
        </div>
      );
    }
    case "arrival": {
      const arrivalRooms = Array.from(
        new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a])).values(),
      ).map((a) => a.room?.roomNumber ?? String(a.roomId).slice(0, 8));
      return (
        <>
          <Speak now="Arrival" h2="Ready the room for arrival.">
            Now the system assigns a specific room and you clear the readiness check. Still reversible — nothing
            about the stay is live yet.
          </Speak>
          <div className="block">
            <BlockH>Readiness</BlockH>
            <ValRow
              label={arrivalRooms.length > 1 ? `Rooms assigned (${arrivalRooms.length}${entry.numberOfRooms ? `/${entry.numberOfRooms}` : ""})` : "Room assigned"}
              value={arrivalRooms.length ? arrivalRooms.join(", ") : "Not assigned yet"}
              epi="sys"
            />
            <ValRow
              label="Advance reconciled"
              value={entry.folio?.advancePaymentReconciliationComplete ? "Reconciled against folio" : "Pending"}
              epi="der"
            />
            <ValRow
              label={arrivalRooms.length > 1 ? "Rooms ready" : "Room ready"}
              value={
                arrivalRooms.length === 0
                  ? DASH
                  : (() => {
                      // Every room must be ready before check-in, so report the weakest link
                      // rather than the first row's state.
                      const states = Array.from(
                        new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a])).values(),
                      ).map((a) => a.room?.physicalState ?? "Assigned");
                      const distinct = Array.from(new Set(states));
                      return distinct.length === 1 ? distinct[0] : `Mixed — ${distinct.join(", ")}`;
                    })()
              }
              epi="sys"
            />
          </div>
        </>
      );
    }
    case "checkin": {
      const live = fin.folio.state === "Live" || fin.folio.state === "Settled";
      // Dedupe by roomId — per-night bookings hold one assignment row per (room, range), and a
      // multi-room party must show every room, not just the first.
      const checkinRooms = Array.from(
        new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a])).values(),
      ).map((a) => a.room?.roomNumber ?? String(a.roomId).slice(0, 8));
      return (
        <>
          <Speak
            now={live ? "Checked in" : "A moment that locks"}
            h2={live ? "Guest is in. The folio is live." : "Verify identity and open the live folio."}
          >
            {live
              ? "Charges now post against a live folio that can only grow — never revert."
              : "Checking in hands over the keys and turns the folio live. Once live, the financial record is permanent."}
          </Speak>
          <div className="block">
            <BlockH>Check-in</BlockH>
            <ValRow label="Guest" value={name} />
            <ValRow
              label={checkinRooms.length === 1 ? "Room" : `Rooms (${checkinRooms.length})`}
              value={checkinRooms.length ? checkinRooms.join(", ") : DASH}
              epi="sys"
            />
            <ValRow
              label="Identity verified"
              value={entry.guestProfile?.identityVerifiedAt ? "Recorded" : "Not yet"}
            />
            <div className="field">
              <label>Folio</label>
              <div className="val">
                <span className={`fact ${fin.folio.frame}`} style={{ padding: "2px 8px", fontSize: 12 }}>
                  {fin.folio.state}
                </span>
                <span className="axis">
                  <span className="axis-mk sys">⚙</span>
                </span>
              </div>
            </div>
          </div>
        </>
      );
    }
    case "stay": {
      const lines = entry.folio?.lines ?? [];
      return (
        <>
          <Speak now="In-house" h2="The stay is live. Post charges as they happen.">
            Every charge adds a line — nothing is ever edited in place. Room charges post themselves each night;
            you post the rest.
          </Speak>
          <div className="folio">
            <div className="folio-h">
              Live folio
              <span className="lk">
                <Lock />
                live · append-only
              </span>
            </div>
            {lines.length === 0 ? (
              <div className="fline">
                <span className="fl-d" style={{ color: "var(--ink-3)" }}>
                  No charges posted yet
                </span>
              </div>
            ) : (
              lines.map((l) => {
                const sys = !!l.nightAuditRecordId;
                return (
                  <div className="fline" key={l.id}>
                    <span className={`fl-mk mk ${sys ? "sys" : "cap"}`}>{sys ? "⚙" : "✎"}</span>
                    <span className="fl-d">
                      {l.description}
                      <small>{new Date(l.chargeDate).toLocaleDateString()}</small>
                    </span>
                    <span className="fl-a">{money(l.amount, l.currency)}</span>
                  </div>
                );
              })
            )}
            {/* No running total: the backend exposes no sum-of-lines field on the folio, and
                totalling the rows here would be frontend-computed money. Balance due (below and on
                the Check-out step) comes from the server's own outstandingBalance. */}
            <div className="fline total">
              <span className="fl-mk mk sys">⚙</span>
              <span className="fl-d">Balance due (from folio)</span>
              <span className="fl-a">{moneyOrDash(fin.outstanding, fin.currency)}</span>
            </div>
          </div>
          <div className="reentry">
            <div className="rh">Need to change something?</div>
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
              A confirmed stay can&rsquo;t be edited in place. Room changes, rate revisions and extensions each
              open a <b>new segment</b> from an earlier step — the current stay seals as history. Use the working
              tools below to start one.
            </p>
          </div>
        </>
      );
    }
    case "checkout": {
      const settled = fin.folio.state === "Settled";
      return (
        <>
          <Speak
            now={settled ? "Settled" : "Check-out"}
            h2={settled ? "Folio settled. Ready to close." : "Settle the folio and collect the keys."}
          >
            {settled
              ? "Payment has been taken; the room goes to housekeeping for turnover."
              : "Take payment for the balance and collect the keys. Processing payment is the last thing you can't reclaim."}
          </Speak>
          <div className="block">
            <BlockH>Settlement</BlockH>
            <ValRow label="Advance already paid" value={moneyOrDash(fin.advanceReceived, fin.currency)} epi="sys" />
            <ValRow label="Balance due" value={moneyOrDash(fin.outstanding, fin.currency)} epi="sys" />
          </div>
        </>
      );
    }
    case "closed": {
      const s9Groups: RailGroup[] = [
        { key: "background", label: "Post-stay workers & services", items: STAGE_ACTIONS.S9.background },
      ];
      return (
        <div className="bx-split">
          <div className="bx-main">
          <Speak now="Closed" h2="This stay is closed and sealed.">
            The record is permanent. Any later correction is added as a new layer on top, never a change to
            what&rsquo;s sealed.
          </Speak>
          <div className="block">
            <BlockH>Sealed record</BlockH>
            <ValRow label="Outcome" value={entry.status === "CLOSED" ? "Closed" : entry.status} epi="der" />
            <ValRow
              label="Closed"
              value={entry.closedAt ? new Date(entry.closedAt).toLocaleString() : DASH}
              epi="sys"
            />
            <div className="field">
              <label>Record</label>
              <div className="val">
                <span className="fact b-bound" style={{ padding: "2px 8px", fontSize: 12 }}>
                  Read-only · sealed
                </span>
                <span className="axis">
                  <span className="axis-mk sys">⚙</span>
                </span>
              </div>
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "10px 0 0", lineHeight: 1.5 }}>
              The stay is sealed, but the workers on the right run in the background after checkout.
            </p>
          </div>
          </div>

          <BackendRail entryId={entry.id} groups={s9Groups} activeKeys={["background"]} firingKey={null} />
        </div>
      );
    }
    default:
      return null;
  }
}

function Speak({ now, h2, children }: { now: string; h2: string; children: ReactNode }) {
  return (
    <div className="speak">
      <div className="now">{now}</div>
      <h2>{h2}</h2>
      <p>{children}</p>
    </div>
  );
}

function BlockH({ children }: { children: ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}

export function BookingWorkspace({ entryId }: { entryId: string }) {
  const { session, isLoading: sessionLoading } = useSession();
  const router = useRouter();

  const entryQuery = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId),
    enabled: !!session && !sessionLoading,
  });

  const entry = entryQuery.data ?? null;

  // Browser-tab title = the customer, not the product (2026-08-03, operator request): with
  // several booking tabs open, "LEGPHEL PMS" × N tells the operator nothing — the guest's
  // name is the tab's identity. Falls back to the booking id while the guest is unnamed, and
  // restores the app default when the workspace unmounts (back to Bookings, etc.).
  useEffect(() => {
    if (!entry) return;
    const name = guestName(entry.guestProfile ?? entry.inquiry?.guestProfile ?? null);
    document.title = name !== "Guest" ? `${name} · ${entry.id}` : entry.id;
    return () => {
      document.title = "LEGPHEL PMS";
    };
  }, [entry]);

  // Authoritative advance-payment position from the server (payment OR FOM credit extension —
  // raw folio payments alone miss the credit-extension path, SIG-S3 Policy 42). It supplies both
  // the confirm gate's `satisfied` flag AND every "advance paid" figure the workspace renders, so
  // it is fetched from the moment a folio exists rather than only at S3.
  const paymentStatusQuery = usePaymentStatus(entryId, { enabled: !!entry?.folio });
  const paymentSatisfied = paymentStatusQuery.data?.satisfied;
  // Amount actually RECEIVED — distinct from `satisfied`. The backend's proforma-dispatch gate
  // keys on this, because a voluntary advance against a zero threshold still needs the invoice
  // sent even though the advance requirement already reads as satisfied.
  const totalReceived = paymentStatusQuery.data?.totalReceived ?? null;
  // What the hotel actually demands (config threshold or the desk's per-booking requirement).
  // 0 hides the vacuous "Advance settled" checklist line — nothing is being asked for.
  const requiredAmount = paymentStatusQuery.data?.requiredAmount ?? null;

  // Live money position for the header total + breakdown (2026-08-13, operator request): the
  // header shows THE total — server-computed on the current commercial basis, so a room change
  // or re-entry re-prices it automatically — and clicking it opens the full breakdown (billed
  // so far / payments / balance). Keyed on entry.updatedAt so entry mutations refresh it, plus
  // a 30s cadence for folio movement that never touches the entry row (night-audit posts,
  // another terminal's charges).
  const billingQuery = useQuery({
    queryKey: ["billing-summary", entryId, entryQuery.data?.updatedAt ?? ""],
    queryFn: () => getBillingSummary(session!, entryId),
    enabled: !!session && !sessionLoading && !!entryQuery.data,
    refetchInterval: 30_000,
  });
  const billing = billingQuery.data ?? null;

  // Guest answers to the governed communications (2026-07-31). The S3 checklist's "Guest's answer
  // to the proforma recorded" item mirrors the backend gate
  // `enforceDispatchedProformaGuestAnswerRecordedForS4Confirmation`, which reads
  // CommunicationRecord.acknowledgementStatus — a field that lives on NO other query the workspace
  // makes. Without this fetch the item's lookup ran over an empty array and could never tick, so a
  // captured answer left the freeze permanently blocked on the desk while the backend was happy.
  // Shares the exact query key CommunicationAcceptanceBlock uses, so capturing an answer there
  // invalidates this too and the checklist goes green in the same beat.
  const commsQuery = useQuery({
    queryKey: ["entry-communications", entryId],
    queryFn: () => listEntryCommunications(session!, entryId),
    enabled: !!session && !sessionLoading,
  });
  const communications = commsQuery.data?.items ?? null;

  // Guest-detail coverage for the S6 check-in gate (2026-08-11, operator ruling): every guest
  // needs a document number or an ID photo on file before "Check in & go live" — VIP bookings
  // exempt. Mirrors the backend's completeCheckInToS7 gate client-side; shares the guest-detail
  // table's query key, so a save there flips this checklist in the same beat.
  const identityProofsQuery = useQuery({
    queryKey: ["identity-proofs", entryId],
    queryFn: () => listIdentityProofs(session!, entryId),
    enabled: !!session && !sessionLoading && entryQuery.data?.currentStage === "S6",
  });
  const guestDetailsCoverage = identityProofsQuery.data?.coverage ?? null;

  // Park expiry — parking cancels the short stage-expiry timer and arms a long PARKING_FOLLOW_UP
  // one in its place (SIG-S1 §3.4: a parked booking still expires, just on a 30-day window). The
  // backend already runs that clock; the operator should be able to see it rather than assume a
  // park is open-ended. Only fetched while the booking is actually parked.
  const parked = entry?.status === "PARKED";
  // Timers now also feed the floating live pill (active-timer count), so they're fetched for
  // every booking — not just parked ones. The drawer's LiveBackendFeed shares this key at 8s.
  const timersQuery = useQuery({
    queryKey: ["entry-timers", entryId],
    queryFn: () => getEntryTimers(session!, entryId),
    enabled: !!session && !sessionLoading,
    // Refresh occasionally so the countdown doesn't drift far from the server's own clock.
    refetchInterval: 30_000,
  });
  const parkTimer = findParkTimer(timersQuery.data?.items);

  // Backend side column (live feed + what-runs) — one permanent, always-visible panel with two
  // tabs, replacing the old separate left feed + right rail. The rail slot is the portal target
  // each step's BackendRail teleports into; it stays mounted across tab switches.
  const [sideTab, setSideTab] = useState<"live" | "runs">("live");
  // Segments is a top-level view rather than a side tab: on a re-entered booking the operator
  // needs the FULL sealed detail of an earlier segment (and the reuse action), which doesn't fit
  // the narrow side column. Toggled from the header chip; replaces the step canvas while open.
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  // Readiness popover on the journey-row gate cluster (replaces the bottom gate bar's list).
  const [needsOpen, setNeedsOpen] = useState(false);
  // Money-breakdown popover on the header total.
  const [totalOpen, setTotalOpen] = useState(false);
  // Local tick so the countdown moves between refetches.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!parkTimer) return;
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [parkTimer?.id]);
  const parkCountdown = parkTimer ? countdownTo(parkTimer.firesAt, nowTick) : null;

  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  // The journey rail tells the truth about the backend stage (2026-08-01, operator ruling):
  // Set up (3) stays the CURRENT step — never green, never sealed — until the freeze actually
  // moves the entry to S4. The Confirm review (4) is still reachable from S3 via
  // maxReachableOrder, but visiting it is just viewing a screen; only "Freeze & confirm"
  // advances the stage. (The former `setupDone` promotion marked Set up completed the moment
  // the review was reached with green gates, which read as "S3 done / stage moved" while the
  // backend was still at S3 — exactly the confusion this removes.)
  const currentOrder = entry ? currentStepOrder(entry) : 1;
  // Whether the S3 exit checklist is fully green — computed up here because it now gates
  // BOTH the rail (node 4 stays a locked future step until then) and the Review & confirm
  // button, not just the freeze itself.
  const readyToConfirm = entry
    ? canConfirm(entry, { paymentSatisfied, totalReceived, requiredAmount, communications })
    : false;
  const maxReach = !entry
    ? 1
    : entry.currentStage === "S3" && !readyToConfirm
      ? Math.min(maxReachableOrder(entry), 3)
      : maxReachableOrder(entry);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [guestPresent, setGuestPresent] = useState(false);
  // Per-room key issuance (2026-08-11, operator request): one radio per assigned room on the
  // Check-in step — the hotel tracks EACH key handed over, not a bare count. keyCount sent to
  // the backend = number of rooms marked issued.
  const [issuedKeyRooms, setIssuedKeyRooms] = useState<Record<string, boolean>>({});
  const toggleKeyRoom = (roomId: string) =>
    setIssuedKeyRooms((prev) => ({ ...prev, [roomId]: !prev[roomId] }));
  const [registrationConfirmed, setRegistrationConfirmed] = useState(false);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [nightAuditOk, setNightAuditOk] = useState(false);
  const [parkOpen, setParkOpen] = useState(false);
  const [parkReason, setParkReason] = useState("");
  // The same dialog serves two entry points: the S1/S2 exit prompt (where leaving is the point)
  // and the in-place Park button on later stages (where the operator wants to stay put).
  const [parkExitFlow, setParkExitFlow] = useState(false);
  // Where the operator was actually headed when the park prompt intercepted them —
  // a sidebar link's href or (for browser Back) the bookings list. Honoured on leave.
  const pendingExitRef = useRef<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);

  // Native confirm/freeze — the S3→S4 commitment boundary (SIG-S4).
  const confirmMutation = useMutation({
    mutationFn: () => progressStage(session!, entry!.id, { targetStage: "S4", version: entry!.version }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      setConfirmOpen(false);
      setSelected(4);
      toast.success("Booking confirmed and frozen.");
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Confirmation failed");
    },
  });

  // Native S9 seal — the discrete closeEntryAtS9 (sets status → CLOSED). The S8→S9 progression
  // only moves the stage; this is the actual permanent seal.
  const closeMutation = useMutation({
    mutationFn: () => closeEntryAtS9(session!, entry!.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      setCloseOpen(false);
      toast.success("Engagement closed — record sealed.");
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Closure failed");
    },
  });

  // Routine forward step (no commitment boundary) — e.g. Inquiry → Negotiation.
  const advanceMutation = useMutation({
    mutationFn: (vars: { targetStage: string; guestPhysicallyPresent?: boolean }) =>
      progressStage(session!, entry!.id, {
        targetStage: vars.targetStage,
        version: entry!.version,
        guestPhysicallyPresent: vars.guestPhysicallyPresent,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      setSelected(currentStepOrder(updated));
      toast.success("Moved to the next step.");
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't move forward");
    },
  });

  // S4 (confirmed) → S5: open the pre-arrival window (W4 activation).
  const activateMutation = useMutation({
    mutationFn: () => activatePreArrival(session!, entry!.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      setSelected(5);
      toast.success("Pre-arrival open — now at Arrival.");
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't open pre-arrival yet");
    },
  });

  // S6 → S7: complete check-in (folio goes live). The second commitment boundary.
  const checkInMutation = useMutation({
    mutationFn: () => {
      // Only arrival-night rooms' keys go out at check-in (2026-08-14 key-swap ruling) —
      // the backend refuses ids for rooms the guest moves into later.
      const dayOne = arrivalNightRoomIds(entry!);
      const issued = Array.from(new Set((entry!.roomAssignments ?? []).map((a) => a.roomId))).filter(
        (id) => dayOne.has(id) && issuedKeyRooms[id],
      );
      return completeCheckInToS7(session!, entry!.id, entry!.version, {
        keyCount: Math.max(1, issued.length),
        registrationConfirmed: true,
        issuedKeyRoomIds: issued,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      setCheckInOpen(false);
      setSelected(7);
      toast.success("Checked in — the folio is live.");
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Check-in failed");
    },
  });

  // Park / unpark — a governed temporary hold on any ACTIVE entry (Part 3 §3.2.8; SIG-S1 §3.3,
  // SIG-S2 §3.3, SIG-S3 §3, SIG-S4 §3.1, SIG-S5 §3.1). Reason is required (recorded on the trace);
  // parking swaps the short stage-expiry timer for the long park-expiry one.
  const parkMutation = useMutation({
    mutationFn: () => parkEntry(session!, entry!.id, parkReason.trim()),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      // The park-expiry timer is armed inside the same transaction — pull it so the header shows
      // the new countdown immediately instead of on the next poll.
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry!.id] });
      setParkOpen(false);
      setParkReason("");
      toast.success("Booking parked — it's paused but keeps its place.");
      // Only leave when the park came from the exit prompt. Parking in place from a later stage
      // should keep the operator where they are, looking at the now-parked booking. Honour the
      // destination the operator was actually headed to (sidebar link / browser Back).
      if (parkExitFlow) {
        const dest = pendingExitRef.current ?? "/desk/bookings";
        pendingExitRef.current = null;
        router.push(dest);
      }
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't park this booking");
    },
  });

  const unparkMutation = useMutation({
    mutationFn: () => unparkEntry(session!, entry!.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry!.id] });
      toast.success("Booking resumed — back on the active desk.");
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't resume this booking");
    },
  });

  // Default the viewing pointer once loaded — land on the Confirm review when it's ready to
  // freeze (a view choice only; Set up remains the current step until the freeze).
  useEffect(() => {
    if (!entry || selected !== null) return;
    const ready = readyToConfirm;
    setSelected(ready ? 4 : currentStepOrder(entry));
  }, [entry, selected, paymentSatisfied, totalReceived, requiredAmount, communications]);

  // Start every step view at the TOP (2026-08-08 report: advancing S1→…→S9 opened the next
  // step wherever the previous one was scrolled to — the canvas swaps content but the
  // scroller keeps its position). One reset covers all nine steps, the Segments view and the
  // sealed/read-only variants — they all render inside `.canvas-scroll`. Narrow layouts flip
  // that div to overflow:visible and scroll the shell's `.content` (or the window) instead,
  // so those reset too.
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = canvasScrollRef.current;
    el?.scrollTo({ top: 0 });
    (el?.closest(".content") as HTMLElement | null)?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [selected, segmentsOpen]);

  const fin = useMemo(
    () => (entry ? deriveFinancials(entry, { paymentStatus: paymentStatusQuery.data }) : null),
    [entry, paymentStatusQuery.data],
  );

  // Name the tab after the guest — the desk routinely has several bookings open at once, and
  // identically-titled tabs can only be told apart by clicking into them.
  usePageTitle(entry ? guestName(entry.guestProfile ?? entry.inquiry?.guestProfile) : null);

  // The park offer must catch EVERY way out, not just the "Bookings" button (2026-08-01):
  // browser Back (and Alt+←) plus in-app links (sidebar, "All bookings") were bypassing the
  // exit prompt entirely. Two interceptors, armed only while the booking is park-promptable
  // (ACTIVE at S1/S2 — same rule as promptParkOnExit, derived here entry-safely because this
  // effect must sit above the loading early-returns):
  //  - a history sentinel: Back pops onto it, we re-arm and open the park dialog instead;
  //  - a capture-phase click guard on internal /desk links, which records the intended
  //    destination so "Park & leave" / "Leave without parking" still end up where the
  //    operator was going. Links within this booking (workspace views, its intake edit)
  //    pass through untouched.
  const parkPromptable =
    !!entry &&
    entry.status === "ACTIVE" &&
    (entry.currentStage === "S1" || entry.currentStage === "S2");
  useEffect(() => {
    if (!parkPromptable) return;
    window.history.pushState({ deskParkGuard: entryId }, "");
    const onPop = () => {
      window.history.pushState({ deskParkGuard: entryId }, "");
      pendingExitRef.current = "/desk/bookings";
      setParkExitFlow(true);
      setParkOpen(true);
    };
    const onClickCapture = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest?.("a[href^='/desk'], a[href^='/admin']") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      // Same-booking destinations aren't an exit.
      if (href.startsWith(`/desk/bookings/${entryId}`) || href.includes(`edit=${entryId}`)) return;
      e.preventDefault();
      e.stopPropagation();
      pendingExitRef.current = href;
      setParkExitFlow(true);
      setParkOpen(true);
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [parkPromptable, entryId]);

  if (sessionLoading || entryQuery.isLoading) {
    return (
      <div className="view">
        <p className="lead">Opening the booking…</p>
      </div>
    );
  }
  if (entryQuery.isError || !entry || !fin) {
    return (
      <div className="view">
        <p className="lead">Couldn&rsquo;t load this booking.</p>
        <Link className="btn btn-ghost btn-sm" href="/desk/bookings" style={{ marginTop: 12 }}>
          Back to bookings
        </Link>
      </div>
    );
  }

  const viewing = selected ?? currentOrder;
  const step = DESK_STEPS[viewing - 1];
  const name = guestName(entry.guestProfile ?? entry.inquiry?.guestProfile);
  const sub = `${partyCaption(entry)}`;
  // Sealed = terminal, no forward action: closed stay, cancellation, or expired no-show.
  // Every step is freely browsable as read-only history; nothing nudges you onward.
  const sealed =
    entry.status === "CLOSED" ||
    entry.status === "CANCELLED" ||
    entry.status === "EXPIRED" ||
    entry.currentStage === "TERMINAL";
  // Park is a governed hold available from any live stage — DEV-SPEC-001 Part 3 §3.2.8
  // ("any (ACTIVE, Sn) ──► (PARKED, Sn)"), restated per-stage in SIG-S1/S2/S3/S4/S5/S7. The
  // backend guard is authoritative (p01-entry-park-allowed-stages); this only decides whether
  // to offer the affordance. It used to read S1/S2 only, mirroring a backend narrowing that had
  // no spec basis and blocked the S3–S5 parks the SIGs mandate.
  const parkable = !sealed && entry.status === "ACTIVE";
  // Whether to *offer* the park on the way out. Deliberately narrower than `parkable`: an
  // unfinished enquiry/quote is the case where "pause it, don't lose it" is the natural exit,
  // whereas nagging on every visit to an in-house stay would be noise. Parking later stages is
  // still permitted — it's just a deliberate act rather than an exit prompt.
  const promptParkOnExit = parkable && (entry.currentStage === "S1" || entry.currentStage === "S2");
  const timer = fin.frozen ? null : dwellTimer(entry.updatedAt);

  // Steps with native actions wired into the desk (vs. the deep-link bridge).
  const confirmStepActive = viewing === 4 && !fin.frozen && entry.currentStage === "S3";
  const inquiryStepActive = step.key === "inquiry" && entry.currentStage === "S1" && viewing === currentOrder;
  const quoteStepActive = step.key === "quote" && entry.currentStage === "S2" && viewing === currentOrder;
  const setupStepActive = step.key === "setup" && entry.currentStage === "S3" && viewing === currentOrder;
  const arrivalStepActive = step.key === "arrival" && entry.currentStage === "S5" && viewing === currentOrder;
  const checkInStepActive = step.key === "checkin" && entry.currentStage === "S6" && viewing === currentOrder;
  const stayStepActive = step.key === "stay" && entry.currentStage === "S7" && viewing === currentOrder;
  const checkOutStepActive = step.key === "checkout" && entry.currentStage === "S8" && viewing === currentOrder;
  // S9 reached but not yet sealed → the actionable post-stay step (distinct from the read-only
  // sealed canvas that shows once status === CLOSED).
  const closedStepActive =
    step.key === "closed" && entry.currentStage === "S9" && entry.status !== "CLOSED" && viewing === currentOrder;
  // Check-in issues keys only for rooms occupied on the ARRIVAL night (2026-08-14, key-swap
  // ruling): a room a per-night split moves the guest into later gets its key at S7 on the
  // move day, after the vacated room's key is returned. The backend refuses future-room ids.
  const allAssignedRoomIds = Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.roomId)));
  const dayOneRooms = arrivalNightRoomIds(entry);
  const checkInRoomIds = allAssignedRoomIds.filter((id) => dayOneRooms.has(id));
  const moveDayRoomCount = allAssignedRoomIds.length - checkInRoomIds.length;
  const issuedKeyCount = checkInRoomIds.filter((id) => issuedKeyRooms[id]).length;
  const keysValid = checkInRoomIds.length > 0 && issuedKeyCount === checkInRoomIds.length;
  const canCheckIn =
    s6Readiness(entry, { guestDetails: guestDetailsCoverage }).every((c) => c.met) &&
    registrationConfirmed &&
    keysValid;
  // After the freeze, the Confirm step (still S4 until W4 fires) offers to open pre-arrival.
  const confirmedS4Active = viewing === 4 && fin.frozen && entry.currentStage === "S4";
  // S4→S5 gate (2026-08-07, operator ruling): the guest's answer to the confirmation voucher
  // must be RECORDED before Arrival opens. Mirrors the backend's W4 check (segment-scoped,
  // OTA auto-acknowledges); the button locks with the reason instead of 409ing on click.
  const segStartIsoForVoucher = (entry.segments ?? [])[0]?.startedAt ?? null;
  const voucherAnswerRecorded = (communications ?? []).some(
    (c) =>
      c.commType === "CONFIRMATION_VOUCHER" &&
      c.direction === "OUTBOUND" &&
      c.sendStatus === "DISPATCHED" &&
      c.acknowledgementStatus === "RECEIVED" &&
      (!segStartIsoForVoucher || (c.createdAt ?? "") >= segStartIsoForVoucher),
  );
  const onLiveStep =
    viewing === currentOrder &&
    !confirmStepActive &&
    !inquiryStepActive &&
    !quoteStepActive &&
    !setupStepActive &&
    !arrivalStepActive &&
    !checkInStepActive &&
    !stayStepActive &&
    !checkOutStepActive &&
    !confirmedS4Active;
  const ready = canConfirm(entry, { paymentSatisfied, totalReceived, requiredAmount, communications });
  // On a sealed booking every step is read-only history — show the outcome, not pending gates.
  const sealedOutcome =
    entry.status === "CANCELLED"
      ? "Booking cancelled — read-only record"
      : entry.status === "EXPIRED" || entry.currentStage === "TERMINAL"
        ? "Expired (no-show) — read-only record"
        : "Stay closed & sealed — read-only record";
  const preconds = sealed
    ? [{ label: sealedOutcome, met: true }]
    : confirmStepActive
    ? confirmReadiness(entry, { paymentSatisfied, totalReceived, requiredAmount, communications })
    : inquiryStepActive
      ? s1Readiness(entry)
      : quoteStepActive
        ? s2Readiness(entry)
        : setupStepActive
          ? confirmReadiness(entry, { paymentSatisfied, totalReceived, requiredAmount, communications })
          : arrivalStepActive
            ? s5Readiness(entry)
            : checkInStepActive
              ? [
                  ...s6Readiness(entry, { guestDetails: guestDetailsCoverage }),
                  { label: "Registration confirmed", met: registrationConfirmed },
                  {
                    label:
                      checkInRoomIds.length > 1 || moveDayRoomCount > 0
                        ? `Room keys issued (${issuedKeyCount}/${checkInRoomIds.length})${
                            moveDayRoomCount > 0
                              ? ` · ${moveDayRoomCount} on the move day`
                              : ""
                          }`
                        : "Room key issued",
                    met: keysValid,
                  },
                ]
              : stayStepActive
                ? [...s7Readiness(entry), { label: "Night audit complete", met: nightAuditOk }]
                : checkOutStepActive
                  ? s8Readiness(entry)
                  : closedStepActive
                    ? s9CloseReadiness(entry)
                    : preconditionsFor(entry, step);
  const needsLabel = sealed
    ? "This booking"
    : setupStepActive
    ? "Before this can be confirmed"
    : confirmStepActive || checkInStepActive
      ? checkInStepActive
        ? "Before the folio goes live"
        : "Before this can freeze"
      : onLiveStep || inquiryStepActive || quoteStepActive || arrivalStepActive || stayStepActive || checkOutStepActive
        ? "Before you continue"
        : "This step";

  const gotoStep = (n: number) => {
    if (n > maxReach) {
      toast.info("That step comes later — finish this one first.");
      return;
    }
    setSelected(n);
  };

  // Viewing an already-completed (earlier) step → render its FULL working surface, but read-only,
  // rather than the compact summary. All setters are no-ops and the subtree is `inert` so nothing
  // can be clicked, typed, or navigated. "Done" = strictly before the current step.
  //
  // A SEALED booking gets the same treatment on EVERY step (2026-07-31): an EXPIRED entry keeps
  // its stage (S1 stays S1), so the `*StepActive` flags below stayed true and the live working
  // surface rendered — the operator could still search availability and save rooms on an expired
  // booking while the gate bar claimed "read-only record". The backend now refuses those writes
  // (ENTRY_SEALED_READ_ONLY), and here the canvas goes inert so they can't be attempted.
  // The terminal "closed" step keeps its dedicated sealed summary canvas (StepCanvas) instead.
  const viewingDoneStep = viewing < currentOrder || (sealed && step.key !== "closed");
  const readOnlyStepBody = () => {
    switch (step.key) {
      case "inquiry":
        return <InquiryStep entry={entry} />;
      case "quote":
        return <QuoteStep entry={entry} />;
      case "setup":
        return <SetupStep entry={entry} setSelected={NOOP} />;
      case "confirm":
        return <ConfirmStep entry={entry} />;
      case "arrival":
        return <ArrivalStep entry={entry} guestPresent={guestPresent} setGuestPresent={NOOP} />;
      case "checkin":
        return (
          <CheckInStep
            entry={entry}
            issuedKeyRooms={issuedKeyRooms}
            toggleKeyRoom={NOOP}
            registrationConfirmed={registrationConfirmed}
            setRegistrationConfirmed={NOOP}
          />
        );
      case "stay":
        return <StayStep entry={entry} setNightAuditOk={NOOP} setSelected={NOOP} />;
      case "checkout":
        return <CheckOutStep entry={entry} setSelected={NOOP} />;
      case "closed":
        return <PostStayStep entry={entry} />;
      default:
        return <StepCanvas step={step} entry={entry} fin={fin} />;
    }
  };

  // Exit interception: leaving a still-parkable booking (S1/S2, active, not already parked) opens
  // the park dialog so the operator can choose to pause it on the way out — parking is a governed
  // exit choice now, not a standalone header button. Everything else navigates straight back.
  const handleExit = () => {
    if (promptParkOnExit && !parked) {
      setParkExitFlow(true);
      setParkOpen(true);
    } else router.push("/desk/bookings");
  };

  const metCount = preconds.filter((p) => p.met).length;
  const allMet = metCount === preconds.length;

  return (
    <BackendRailSlotContext.Provider value={railSlot}>
    <div className="ws">
      {/* top bar — guest header + key figures, with the horizontal booking journey beneath */}
      <div className="ws-top">
        <div className="ws-head">
          <button className="ws-back" onClick={handleExit}>
            <ChevronLeft />
            Bookings
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="gb-av" style={{ background: avatarColor(entry.id) }}>
              {initialsOf(name)}
            </div>
            <div>
              <div className="gb-name">{name}</div>
              <div className="gb-sub mono">{sub}</div>
            </div>
          </div>
          <div className="topspace" />
          <div className="jsum">
            {/* Readable business IDs — Entry (ENT-…) over its originating Inquiry (INQ-…),
                as a labelled column alongside the other key figures. */}
            <div className="jsum-i" title="Entry number · Inquiry number">
              <span className="k">Reference</span>
              <span className="v mono" style={{ fontSize: 12 }}>{entry.id}</span>
              {entry.inquiryId && (
                <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", fontWeight: 500 }}>
                  {entry.inquiryId}
                </span>
              )}
            </div>
            <span className={`commit-tag ${fin.frozen ? "frozen" : "indic"}`}>
              {fin.frozen ? <Check /> : null}
              {fin.frozen ? "Confirmed" : "Indicative"}
            </span>
            {/* The header shows THE total (2026-08-13, operator request — replaced the frozen
                per-night rate): the stay total on the CURRENT commercial basis, computed by
                GET /entries/:id/billing-summary, so a room upgrade / re-entry re-prices it with
                no desk arithmetic. Click opens the full money breakdown, which tracks the folio
                live as bills post. */}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="jsum-i"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", font: "inherit" }}
                onClick={() => {
                  setTotalOpen((o) => !o);
                  void billingQuery.refetch();
                }}
                title="See the full money position — stay total, billed so far, payments, balance"
              >
                <span className="k">
                  {billing?.headline.kind === "BILLED_SO_FAR"
                    ? "Billed so far"
                    : billing?.headline.frozen
                      ? "Total · frozen"
                      : "Total · indicative"}
                  {" ▾"}
                </span>
                <span className="v mono">
                  {moneyOrDash(
                    billing ? billing.headline.amount : fin.frozen ? null : fin.indicativeTotal,
                    billing?.currency ?? fin.currency,
                  )}
                </span>
              </button>
              {totalOpen && (
                <div className="jgate-pop" style={{ width: 360 }} onMouseLeave={() => setTotalOpen(false)}>
                  {(() => {
                    const cur = billing?.currency ?? fin.currency;
                    const row = (label: ReactNode, value: number | null, opts?: { bold?: boolean; muted?: boolean }) => (
                      <div
                        style={{
                          display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
                          fontSize: 12, fontWeight: opts?.bold ? 700 : 500,
                          color: opts?.muted ? "var(--ink-3)" : "var(--ink)",
                        }}
                      >
                        <span>{label}</span>
                        <span className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>
                          {moneyOrDash(value, cur)}
                        </span>
                      </div>
                    );
                    const st = billing?.stayTotal;
                    const fo = billing?.folio ?? null;
                    return (
                      <div style={{ display: "grid", gap: 7 }}>
                        <div style={{ fontSize: 8.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-3)", fontWeight: 700 }}>
                          Money on this booking
                        </div>
                        {row(
                          <>Stay total {st?.frozen ? "· frozen" : "· indicative"}</>,
                          st?.amount ?? null,
                          { bold: true },
                        )}
                        {st?.basis === "PER_NIGHT_TIMES_NIGHTS" && st.perNightAmount != null && (
                          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -4 }}>
                            {money(st.perNightAmount, cur)} / night
                            {st.nights != null ? ` × ${st.nights} night${st.nights === 1 ? "" : "s"}` : ""}
                          </div>
                        )}
                        {st?.segmentNumber != null && (entry.segmentNumber ?? 1) > 1 && (
                          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -4 }}>
                            Basis: segment {st.segmentNumber} quote — re-priced on every room change / re-entry.
                          </div>
                        )}
                        {/* Per-room price breakdown (2026-08-13, operator request): what each room
                            costs — room, meal plan, extra bed — from the quote's own stored pricing. */}
                        {billing?.rooms && billing.rooms.length > 0 && (
                          <>
                            <div style={{ borderTop: "1px solid var(--line-2)", margin: "2px 0" }} />
                            <div style={{ fontSize: 8.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-3)", fontWeight: 700 }}>
                              Per room
                            </div>
                            <div style={{ display: "grid", gap: 6, maxHeight: 280, overflowY: "auto" }}>
                              {billing.rooms.map((r, i) => {
                                const m = r.mealCounts;
                                const mealParts: string[] = [];
                                if (m?.cp) mealParts.push(`${m.cp} CP`);
                                if (m?.mapl) mealParts.push(`${m.mapl} MAPL`);
                                if (m?.mapd) mealParts.push(`${m.mapd} MAPD`);
                                if (m?.ap) mealParts.push(`${m.ap} AP`);
                                if (m?.others) mealParts.push(`${m.others} Others`);
                                const bits: string[] = [];
                                if (r.roomSubtotal != null) bits.push(`room ${money(r.roomSubtotal, cur)}`);
                                if ((r.mealsSubtotal ?? 0) > 0 || mealParts.length > 0) {
                                  bits.push(
                                    `meals ${moneyOrDash(r.mealsSubtotal, cur)}${mealParts.length ? ` (${mealParts.join(" · ")}${r.mealsVaryByNight ? " · varies by night" : ""})` : ""}`,
                                  );
                                }
                                if (r.extraBedCount > 0) {
                                  bits.push(
                                    `${r.extraBedCount} extra bed${r.extraBedCount === 1 ? "" : "s"} ${moneyOrDash(r.extraBedSubtotal, cur)}`,
                                  );
                                }
                                return (
                                  <div key={r.roomId ?? i} style={{ display: "grid", gap: 1 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, fontSize: 12 }}>
                                      <span style={{ fontWeight: 600 }}>
                                        Room {r.roomNumber ?? "—"}
                                        {r.roomTypeName ? <span style={{ fontWeight: 500, color: "var(--ink-3)" }}> · {r.roomTypeName}</span> : null}
                                        {r.nights != null ? <span style={{ fontWeight: 500, color: "var(--ink-3)" }}> · {r.nights} night{r.nights === 1 ? "" : "s"}</span> : null}
                                        {r.isFoc ? <span style={{ fontWeight: 700, color: "var(--warn, #7a5a20)" }}> · FOC</span> : null}
                                      </span>
                                      <span className="mono" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                                        {moneyOrDash(r.total, cur)}
                                      </span>
                                    </div>
                                    {r.isFoc ? (
                                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>Complimentary — no charge.</div>
                                    ) : bits.length > 0 ? (
                                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{bits.join(" · ")}</div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                            <div style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                              Room / meals / bed figures are net; each room&rsquo;s total adds service charge &amp; GST.
                              {billing.rooms.some((r) => r.componentsPreDiscount)
                                ? " Components shown before the booking discount — the totals are after it."
                                : ""}
                            </div>
                          </>
                        )}
                        <div style={{ borderTop: "1px solid var(--line-2)", margin: "2px 0" }} />
                        {fo ? (
                          <>
                            {row(
                              <>Billed so far{fo.lineCount > 0 ? ` · ${fo.lineCount} line${fo.lineCount === 1 ? "" : "s"}` : ""}</>,
                              fo.billedSoFar,
                            )}
                            {row("Payments received", fo.paymentsReceived)}
                            {fo.refunded != null && row("Refunded", fo.refunded)}
                            {fo.writtenOff != null && row("Written off", fo.writtenOff)}
                            {row("Balance", fo.outstandingBalance, { bold: true })}
                          </>
                        ) : (
                          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>No folio yet — nothing billed.</div>
                        )}
                        <div style={{ fontSize: 10.5, color: "var(--ink-3)", borderTop: "1px solid var(--line-2)", paddingTop: 6 }}>
                          All figures computed by the backend. Updates live as bills post — a room upgrade or
                          re-entry re-prices the stay total automatically.
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
            <div className="jsum-i">
              <span className="k">Folio</span>
              <span className="v">{fin.folio.state}</span>
            </div>
          </div>
          {parked && (
            <span
              className={`timer ${parkCountdown?.level || "warn"}`}
              style={{ gap: 5 }}
              title={
                parkTimer
                  ? `Park expiry (PARKING_FOLLOW_UP) fires ${new Date(parkTimer.firesAt).toLocaleString()} — the booking expires then unless it's resumed.`
                  : "Parked — paused, but it keeps its place in the journey."
              }
            >
              <Pause />
              {parkCountdown ? `Parked · expires ${parkCountdown.text}` : "Parked"}
            </span>
          )}
          {/* At S1/S2 the park is offered on the way out (handleExit) — pausing an unfinished
              enquiry is an exit choice. From S3 onward there's no exit prompt, so the park needs
              its own deliberate affordance; without one the stages the SIGs mandate a park for
              (S3–S5, S7) would be unreachable from the desk. */}
          {parkable && !promptParkOnExit && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setParkExitFlow(false);
                setParkOpen(true);
              }}
              title="Pause this booking — it keeps its place."
            >
              <Pause />
              Park
            </button>
          )}
          {/* Gate on `parked` alone — NOT on `parkable`, which requires status ACTIVE and so is
              always false for the very entries that need this button. */}
          {parked && (
            <button className="btn btn-ghost btn-sm" disabled={unparkMutation.isPending} onClick={() => unparkMutation.mutate()}>
              <Play />
              {unparkMutation.isPending ? "Resuming…" : "Resume"}
            </button>
          )}
          <ReEnterMenu entry={entry} />
          {/* Segments — sealed history of every prior pass through the journey, plus the
              recall-and-revalidate action to reuse an earlier segment's basis (Canon §59). */}
          <button
            className={`btn btn-sm ${segmentsOpen ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setSegmentsOpen((o) => !o)}
            title="See every segment this booking has been through — and reuse an earlier one as the basis"
          >
            <History />
            {(entry.segmentNumber ?? 1) > 1 ? `Segments · ${entry.segmentNumber}` : "Segments"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => router.push(`/desk/bookings/${entry.id}/backend`)}
            title="See every policy, state machine, engine, worker, timer & the decision journey"
          >
            <Layers />
            Under the hood
          </button>
          <span className={`timer ${timer?.level ?? ""}`}>{fin.frozen ? "Confirmed" : timer?.text}</span>
        </div>

        <div className="jrow">
          <nav className="jrail">
            {DESK_STEPS.map((s) => {
              const future = s.order > maxReach;
              // Pre-freeze, the Confirm review is just a screen — the stage indicator stays on
              // Set up (3) because the backend is still at S3; nothing moves until the freeze
              // (2026-08-01, operator ruling).
              const isCur = confirmStepActive ? s.order === 3 : viewing === s.order;
              const cls = ["jnode", isCur ? "cur" : "", s.order < currentOrder ? "done" : "", future ? "future" : ""]
                .filter(Boolean)
                .join(" ");
              // Done steps show their stage number (white on the filled green node) rather than a
              // tick — the number keeps the S1…S9 position legible at a glance. Locked (bound,
              // not-yet-reached) steps still show a padlock.
              const glyph = s.order < currentOrder ? s.order : s.bound ? <Lock /> : s.order;
              return (
                <button key={s.order} className={cls} onClick={() => gotoStep(s.order)}>
                  <span className="g">{glyph}</span>
                  <span className="jl">
                    {s.label}
                    <small>{s.sub}</small>
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Gate cluster — the old bottom gate bar, relocated onto the journey row: a readiness
              chip (click → checklist popover) + the step's advance / commit CTA. */}
          <div className="jgate">
            <button
              type="button"
              className={`jgate-chip${allMet ? " ready" : ""}`}
              onClick={() => setNeedsOpen((o) => !o)}
              title={needsLabel}
            >
              <ListChecks style={{ width: 13, height: 13 }} />
              {metCount}/{preconds.length} ready
            </button>
            {needsOpen && (
              <div className="jgate-pop" onMouseLeave={() => setNeedsOpen(false)}>
                <div className="needs">
                  <span className="nl">{needsLabel}</span>
                  {preconds.map((p) => (
                    <span key={p.label} className={`need${p.met ? " met" : ""}`}>
                      <span className="nd" />
                      {p.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {sealed ? (
              <button className="adv" disabled>
                <Lock />
                Sealed · read-only
              </button>
            ) : parked ? (
              <button
                className="adv"
                disabled={unparkMutation.isPending}
                onClick={() => unparkMutation.mutate()}
              >
                <Play />
                {unparkMutation.isPending ? "Resuming…" : "Resume to continue"}
              </button>
            ) : confirmStepActive ? (
              <button
                className={`adv commit${ready ? "" : " locked"}`}
                disabled={!ready}
                onClick={() => ready && setConfirmOpen(true)}
              >
                <Lock />
                Freeze &amp; confirm
              </button>
            ) : inquiryStepActive ? (
              <button
                className={`adv${canProgressS1(entry) ? "" : " locked"}`}
                disabled={!canProgressS1(entry) || advanceMutation.isPending}
                onClick={() => advanceMutation.mutate({ targetStage: "S2" })}
              >
                {advanceMutation.isPending ? "Moving…" : "Continue to Negotiation"}
                <ArrowRight />
              </button>
            ) : quoteStepActive ? (
              <button
                className={`adv${canProgressS2(entry) ? "" : " locked"}`}
                disabled={!canProgressS2(entry) || advanceMutation.isPending}
                onClick={() => advanceMutation.mutate({ targetStage: "S3" })}
              >
                {advanceMutation.isPending ? "Moving…" : "Continue to Set up"}
                <ArrowRight />
              </button>
            ) : setupStepActive ? (
              <button
                className={`adv commit${ready ? "" : " locked"}`}
                disabled={!ready}
                onClick={() => ready && setSelected(4)}
                title={
                  ready
                    ? "Open the Confirm review — the stage stays Set up (S3) until you freeze"
                    : "Finish the checklist above first — the review opens when Set up is complete"
                }
              >
                <Lock />
                Review &amp; confirm
              </button>
            ) : confirmedS4Active ? (
              <button
                className={`adv${voucherAnswerRecorded ? "" : " locked"}`}
                disabled={!voucherAnswerRecorded || activateMutation.isPending}
                onClick={() => voucherAnswerRecorded && activateMutation.mutate()}
                title={
                  voucherAnswerRecorded
                    ? "Open the pre-arrival window (S5)"
                    : "Record the guest's answer to the confirmation voucher first — send the voucher (if it hasn't gone out) and capture their reply on this step."
                }
              >
                {activateMutation.isPending ? "Opening…" : "Continue to Arrival"}
                <ArrowRight />
              </button>
            ) : arrivalStepActive ? (
              <button
                className={`adv${canProgressS5(entry, guestPresent) ? "" : " locked"}`}
                disabled={!canProgressS5(entry, guestPresent) || advanceMutation.isPending}
                onClick={() => advanceMutation.mutate({ targetStage: "S6", guestPhysicallyPresent: true })}
              >
                {advanceMutation.isPending ? "Moving…" : "Continue to Check-in"}
                <ArrowRight />
              </button>
            ) : checkInStepActive ? (
              <button
                className={`adv commit${canCheckIn ? "" : " locked"}`}
                disabled={!canCheckIn}
                onClick={() => canCheckIn && setCheckInOpen(true)}
              >
                <Lock />
                Check in &amp; go live
              </button>
            ) : stayStepActive ? (
              <button
                className={`adv${canProgressS7(entry, nightAuditOk) ? "" : " locked"}`}
                disabled={!canProgressS7(entry, nightAuditOk) || advanceMutation.isPending}
                onClick={() => advanceMutation.mutate({ targetStage: "S8" })}
              >
                {advanceMutation.isPending ? "Moving…" : "Continue to Check-out"}
                <ArrowRight />
              </button>
            ) : checkOutStepActive ? (
              <button
                className={`adv${canProgressS8(entry) ? "" : " locked"}`}
                disabled={!canProgressS8(entry) || advanceMutation.isPending}
                onClick={() => advanceMutation.mutate({ targetStage: "S9" })}
              >
                {advanceMutation.isPending ? "Closing…" : "Close & seal the stay"}
                <ArrowRight />
              </button>
            ) : closedStepActive ? (
              <button
                className={`adv commit${canCloseS9(entry, session?.actorLevel) ? "" : " locked"}`}
                disabled={!canCloseS9(entry, session?.actorLevel) || closeMutation.isPending}
                onClick={() => canCloseS9(entry, session?.actorLevel) && setCloseOpen(true)}
              >
                <Lock />
                {closeMutation.isPending ? "Sealing…" : "Close & seal the record"}
              </button>
            ) : onLiveStep && step.key === "closed" ? (
              <button className="adv" disabled>
                <Lock />
                Sealed · read-only
              </button>
            ) : (
              <button className="adv" onClick={() => setSelected(currentOrder)}>
                Go to current step
                <ArrowRight />
              </button>
            )}
          </div>
        </div>

        {/* Special preference — pinned in the non-scrolling top bar so it stays on screen through
            every stage (S1…S9). Add/edit in place; shows the saved value so it's never duplicated. */}
        <SpecialPreference entry={entry} />
      </div>

      {/* body — full-width canvas; the live feed + backend rail live in the right drawer */}
      <div className="ws-body">
        <div className="canvas-wrap">
          <div className="canvas-scroll" ref={canvasScrollRef}>
          <div
            className={`canvas${
              segmentsOpen ||
              viewingDoneStep ||
              inquiryStepActive ||
              quoteStepActive ||
              setupStepActive ||
              arrivalStepActive ||
              checkInStepActive ||
              stayStepActive ||
              checkOutStepActive ||
              step.key === "confirm" ||
              step.key === "closed"
                ? " canvas-wide"
                : ""
            }`}
          >
            {segmentsOpen ? (
              <>
                <div className="speak">
                  <div className="now">Segments</div>
                  <h2>Every pass this booking has been through.</h2>
                  <p>
                    A change after confirmation never edits what came before — it seals the current segment as history
                    and opens a fresh one. Earlier segments are read-only, and reusing one re-checks it against today
                    before it becomes the basis.
                  </p>
                </div>
                <SegmentHistoryPanel
                  entryId={entry.id}
                  currentStage={entry.currentStage}
                  // A copy re-enters the booking at an earlier stage. Follow it there instead of
                  // leaving the canvas on the step the booking has just left.
                  onSegmentOpened={(toStage) => setSelected(stepForStage(toStage).order)}
                />
              </>
            ) : viewingDoneStep ? (
              <div style={{ position: "relative" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--ink-2)",
                    background: "var(--paper-2, rgba(0,0,0,0.04))",
                    border: "1px solid var(--line)",
                    borderRadius: 999,
                    padding: "4px 10px",
                  }}
                >
                  <Lock style={{ width: 12, height: 12 }} />
                  {sealed ? sealedOutcome : "Completed step · read-only"}
                </div>
                </div>
                {/* `inert` (React 19) makes the whole subtree non-interactive + non-focusable,
                    so the full step surface is visible but nothing can be actioned. */}
                <div inert>{readOnlyStepBody()}</div>
                {/* Cancelled bookings carry their guest-facing outcome document at the end
                    (2026-08-07, operator request) — OUTSIDE the inert wrapper, because viewing
                    and printing the voucher must stay clickable on a read-only record. */}
                {entry.status === "CANCELLED" && <CancellationVoucherBlock entry={entry} />}
              </div>
            ) : inquiryStepActive ? (
              <InquiryStep entry={entry} />
            ) : quoteStepActive ? (
              <QuoteStep entry={entry} />
            ) : setupStepActive ? (
              <SetupStep entry={entry} setSelected={setSelected} />
            ) : arrivalStepActive ? (
              <ArrivalStep entry={entry} guestPresent={guestPresent} setGuestPresent={setGuestPresent} />
            ) : checkInStepActive ? (
              <CheckInStep
                entry={entry}
                issuedKeyRooms={issuedKeyRooms}
                toggleKeyRoom={toggleKeyRoom}
                registrationConfirmed={registrationConfirmed}
                setRegistrationConfirmed={setRegistrationConfirmed}
              />
            ) : stayStepActive ? (
              <StayStep entry={entry} setNightAuditOk={setNightAuditOk} setSelected={setSelected} />
            ) : checkOutStepActive ? (
              <CheckOutStep entry={entry} setSelected={setSelected} />
            ) : closedStepActive ? (
              <PostStayStep entry={entry} />
            ) : confirmStepActive || confirmedS4Active ? (
              <ConfirmStep entry={entry} />
            ) : (
              <StepCanvas step={step} entry={entry} fin={fin} />
            )}
          </div>
        </div>

        </div>

        {/* Backend side column — always on screen: Live activity + What runs here as tabs.
            The runs tab is the portal slot each step's BackendRail teleports into; both tab
            bodies stay mounted so neither loses state (nor the portal target) on switch. */}
        <aside className="ws-side">
          <div className="ws-side-h">
            <div className="seg">
              <button type="button" className={sideTab === "live" ? "on" : ""} onClick={() => setSideTab("live")}>
                <Activity style={{ width: 13, height: 13 }} />
                Live activity
              </button>
              <button type="button" className={sideTab === "runs" ? "on" : ""} onClick={() => setSideTab("runs")}>
                <Layers style={{ width: 13, height: 13 }} />
                What runs
              </button>
            </div>
          </div>
          <div className="ws-side-body">
            <div style={{ display: sideTab === "live" ? "block" : "none" }}>
              <LiveBackendFeed entryId={entry.id} currentStage={entry.currentStage} />
            </div>
            <div style={{ display: sideTab === "runs" ? "block" : "none" }} ref={setRailSlot} />
          </div>
        </aside>
      </div>

      <DeskConfirmModal
        open={confirmOpen}
        title="Freeze this booking?"
        subtitle={`${name} · ${sub}`}
        why="Confirming commits the hotel and the guest. Here is exactly what becomes binding:"
        consequences={[
          fin.indicativeTotal !== null ? (
            <>
              The price freezes at <b>{money(fin.indicativeTotal, fin.currency)}</b> — the guest is held to it.
            </>
          ) : (
            "The price freezes — the guest is held to it."
          ),
          "The rooms lock — no longer offerable to anyone else.",
          "A confirmation goes to the guest automatically.",
          <>
            Any later change opens a <b>new segment</b> — it won&rsquo;t quietly edit what&rsquo;s sealed.
          </>,
        ]}
        confirmLabel="Freeze & confirm"
        pending={confirmMutation.isPending}
        onConfirm={() => confirmMutation.mutate()}
        onClose={() => setConfirmOpen(false)}
      />

      <DeskConfirmModal
        open={checkInOpen}
        title="Check the guest in?"
        subtitle={`${name} · ${sub}`}
        why="Check-in turns the folio live. Here is what becomes permanent:"
        consequences={[
          <>
            The folio goes <b>live</b> — from here it can only grow, never revert to a draft.
          </>,
          "The room becomes occupied and the keys are issued.",
          "Charges begin posting against the live folio.",
        ]}
        confirmLabel="Check in & go live"
        pending={checkInMutation.isPending}
        onConfirm={() => checkInMutation.mutate()}
        onClose={() => setCheckInOpen(false)}
      />

      <DeskConfirmModal
        open={closeOpen}
        title="Close & seal the record?"
        subtitle={`${name} · ${sub}`}
        why="Closing permanently seals the engagement. Here is what becomes final:"
        consequences={[
          "The entry is marked CLOSED — the record is sealed and read-only.",
          "Any later correction is added as a new layer on top, never a change to what is sealed.",
          "Post-stay follow-up passes to the background workers (feedback, payment follow-up, retention).",
        ]}
        confirmLabel="Close & seal"
        pending={closeMutation.isPending}
        onConfirm={() => closeMutation.mutate()}
        onClose={() => setCloseOpen(false)}
      />

      {parkOpen && (
        <div
          className="scrim"
          onClick={(e) => {
            if (e.target !== e.currentTarget || parkMutation.isPending) return;
            // Dismissed = staying on the booking; forget the intercepted destination.
            pendingExitRef.current = null;
            setParkOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Park this booking">
            <div className="modal-top" style={{ background: "var(--warn-t)", borderBottomColor: "#e6cf9a" }}>
              <div className="modal-ic" style={{ background: "var(--warn)" }}>
                <Pause />
              </div>
              <div>
                <h3>Park this booking before you leave?</h3>
                <p>
                  {name} · {sub}
                </p>
              </div>
            </div>
            <div className="modal-body">
              <p className="why">
                You&rsquo;re about to leave this booking. Parking pauses it without losing its place — it
                stays at the same step, its expiry timer is paused, and you can resume any time. Nothing is
                cancelled or released. Prefer to keep it running? Leave without parking.
              </p>
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="park-reason">Reason (required)</label>
                <textarea
                  id="park-reason"
                  value={parkReason}
                  onChange={(e) => setParkReason(e.target.value)}
                  placeholder="e.g. waiting on the guest to confirm dates"
                  maxLength={500}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  const dest = pendingExitRef.current ?? "/desk/bookings";
                  pendingExitRef.current = null;
                  router.push(dest);
                }}
                disabled={parkMutation.isPending}
              >
                Leave without parking
              </button>
              <button
                className="btn btn-primary"
                style={{ background: "var(--warn)" }}
                onClick={() => parkMutation.mutate()}
                disabled={parkMutation.isPending || !parkReason.trim()}
              >
                <Pause />
                {parkMutation.isPending ? "Parking…" : "Park & leave"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </BackendRailSlotContext.Provider>
  );
}
