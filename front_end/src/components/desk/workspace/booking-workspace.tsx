"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronLeft, Lock, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { getEntry, progressStage, parkEntry, unparkEntry } from "@/lib/api/entries";
import { activatePreArrival } from "@/lib/api/pre-arrival";
import { completeCheckInToS7 } from "@/lib/api/check-in";
import { ApiError } from "@/lib/api/client";
import {
  avatarColor,
  dwellTimer,
  formatStayRange,
  guestName,
  initialsOf,
  partyCaption,
  DESK_STEPS,
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
  type DeskFinancials,
} from "@/lib/desk/workspace";
import { DeskConfirmModal } from "./confirm-modal";
import { InquiryStep as InquiryStepBase } from "./inquiry-step";
import { QuoteStep as QuoteStepBase } from "./quote-step";
import { SetupStep as SetupStepBase } from "./setup-step";
import { ArrivalStep as ArrivalStepBase } from "./arrival-step";
import { CheckInStep as CheckInStepBase } from "./checkin-step";
import { StayStep as StayStepBase } from "./stay-step";
import { CheckOutStep as CheckOutStepBase } from "./checkout-step";
import type { EntryDetail } from "@/types/api";

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

type Epi = "cap" | "der" | "sug" | "sys";
const EPI_MARK: Record<Epi, string> = { cap: "✎", der: "∑", sug: "◇", sys: "⚙" };

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
  const stay = formatStayRange(entry.checkInDate, entry.checkOutDate) || "Dates not set";
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
          <Speak now="The quote" h2="Shape the price and send the quote.">
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
              value={fin.advanceReceived > 0 ? money(fin.advanceReceived, fin.currency) + " received" : "Not recorded yet"}
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
      return (
        <>
          <Speak
            now={fin.frozen ? "Confirmed" : "The one moment that locks"}
            h2={fin.frozen ? "This booking is frozen and live." : "Ready to freeze this booking."}
          >
            {fin.frozen
              ? "Terms are held to the guest. Any change now opens a fresh round rather than editing what's sealed."
              : "Confirming turns the range into a total the guest is held to, locks the rooms, and sends the confirmation."}
          </Speak>
          <div className="block">
            <BlockH>{fin.frozen ? "What's sealed" : "What gets frozen"}</BlockH>
            <ValRow label="Guest" value={name} />
            <ValRow label="Stay" value={stay} epi="der" />
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
        </>
      );
    }
    case "arrival": {
      const ra = (entry.roomAssignments ?? [])[0];
      return (
        <>
          <Speak now="Arrival" h2="Ready the room for arrival.">
            Now the system assigns a specific room and you clear the readiness check. Still reversible — nothing
            about the stay is live yet.
          </Speak>
          <div className="block">
            <BlockH>Readiness</BlockH>
            <ValRow label="Room assigned" value={ra?.room?.roomNumber ? `Room ${ra.room.roomNumber}` : "Not assigned yet"} epi="sys" />
            <ValRow
              label="Advance reconciled"
              value={entry.folio?.advancePaymentReconciliationComplete ? "Reconciled against folio" : "Pending"}
              epi="der"
            />
            <ValRow
              label="Room ready"
              value={ra?.room?.physicalState ?? (ra ? "Assigned" : DASH)}
              epi="sys"
            />
          </div>
        </>
      );
    }
    case "checkin": {
      const live = fin.folio.state === "Live" || fin.folio.state === "Settled";
      const ra = (entry.roomAssignments ?? [])[0];
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
            <ValRow label="Room" value={ra?.room?.roomNumber ? `Room ${ra.room.roomNumber}` : DASH} epi="sys" />
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
      const total = fin.chargesTotal;
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
            <div className="fline total">
              <span className="fl-mk mk der">∑</span>
              <span className="fl-d">Running total</span>
              <span className="fl-a">{money(total, fin.currency)}</span>
            </div>
          </div>
          <div className="reentry">
            <div className="rh">Need to change something?</div>
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
              A confirmed stay can&rsquo;t be edited in place. Room changes, rate revisions and extensions each
              open a <b>new round</b> from an earlier step — the current stay seals as history. Use the working
              tools below to start one.
            </p>
          </div>
        </>
      );
    }
    case "checkout": {
      const settled = fin.folio.state === "Settled";
      const balance =
        fin.outstanding !== null
          ? fin.outstanding
          : Math.max(0, fin.chargesTotal - fin.advanceReceived);
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
            <ValRow label="Charges total" value={money(fin.chargesTotal, fin.currency)} epi="der" />
            <ValRow label="Advance already paid" value={money(fin.advanceReceived, fin.currency)} />
            <ValRow label="Balance due" value={money(balance, fin.currency)} epi="der" />
          </div>
        </>
      );
    }
    case "closed": {
      return (
        <>
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
          </div>
        </>
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

const SummaryRail = memo(SummaryRailBase);
function SummaryRailBase({ entry, fin }: { entry: EntryDetail; fin: DeskFinancials }) {
  const stay = formatStayRange(entry.checkInDate, entry.checkOutDate) || "—";
  const nightsTxt = fin.nights ? ` · ${fin.nights}n` : "";
  const priceAmount = fin.frozen
    ? fin.frozenTotal ?? fin.frozenRate
    : fin.indicativeTotal;
  return (
    <aside className="summary">
      <div className="sum-h">
        <div className="t">This booking</div>
        <span className={`commit-tag ${fin.frozen ? "frozen" : "indic"}`}>
          {fin.frozen ? <Check /> : null}
          {fin.frozen ? "Confirmed · frozen" : "Indicative · not committed"}
        </span>
      </div>
      <div className="sum-body">
        <div className={`sum-price ${fin.frozen ? "frozen" : "indic"}`}>
          {fin.frozen && <div className="stamp">FROZEN</div>}
          <div className="pl">{fin.frozen ? "✓ Confirmed" : "Indicative"}</div>
          <div className="amt" style={{ color: fin.frozen ? "var(--green-d)" : "var(--warn)" }}>
            {priceAmount !== null && priceAmount !== undefined ? money(priceAmount, fin.currency) : "—"}
          </div>
          <div className="sub">
            {fin.frozen ? "held to the guest" : "a range while terms are shaped"}
            {nightsTxt}
          </div>
        </div>
        <div className="sum-line">
          <span className="k">Folio</span>
          <span className="v">
            <span className={`fact ${fin.folio.frame}`} style={{ padding: "1px 8px", fontSize: 11 }}>
              {fin.folio.state}
            </span>
          </span>
        </div>
        <div className="sum-line">
          <span className="k">Stay</span>
          <span className="v mono">
            {stay}
            {nightsTxt}
          </span>
        </div>
        {fin.chargesTotal > 0 && (
          <div className="sum-line">
            <span className="k">Charges so far</span>
            <span className="v mono">{money(fin.chargesTotal, fin.currency)}</span>
          </div>
        )}
        <div className="sum-line">
          <span className="k">Advance</span>
          <span className="v mono">
            {fin.advanceReceived > 0 ? money(fin.advanceReceived, fin.currency) : "—"}
          </span>
        </div>
        <div className="sum-note">
          {fin.frozen
            ? "The frozen figures carry to every later step unchanged — you never re-enter them."
            : "Nothing here is binding yet. The price is a range and the rooms aren't locked."}
        </div>
      </div>
    </aside>
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
  const queryClient = useQueryClient();
  const currentOrder = entry ? currentStepOrder(entry) : 1;
  const maxReach = entry ? maxReachableOrder(entry) : 1;
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [guestPresent, setGuestPresent] = useState(false);
  const [keyCount, setKeyCount] = useState("1");
  const [registrationConfirmed, setRegistrationConfirmed] = useState(false);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [nightAuditOk, setNightAuditOk] = useState(false);
  const [parkOpen, setParkOpen] = useState(false);
  const [parkReason, setParkReason] = useState("");

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

  // Routine forward step (no commitment boundary) — e.g. Inquiry → Quote.
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
    mutationFn: () =>
      completeCheckInToS7(session!, entry!.id, entry!.version, {
        keyCount: Math.max(1, parseInt(keyCount, 10) || 1),
        registrationConfirmed: true,
      }),
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

  // Park / unpark — a governed temporary hold, valid only at S1/S2 (SIG-S1 §3.4 / SIG-S2 §3.3).
  const parkMutation = useMutation({
    mutationFn: () => parkEntry(session!, entry!.id, parkReason.trim() || undefined),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entry", entry!.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      setParkOpen(false);
      setParkReason("");
      toast.success("Booking parked — it's paused but keeps its place.");
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
      toast.success("Booking resumed — back on the active desk.");
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't resume this booking");
    },
  });

  // Default the viewing pointer once loaded — land on Confirm when it's ready to freeze.
  useEffect(() => {
    if (entry) setSelected((s) => s ?? (canConfirm(entry) ? 4 : currentStepOrder(entry)));
  }, [entry]);

  const fin = useMemo(() => (entry ? deriveFinancials(entry) : null), [entry]);

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
  const parked = entry.status === "PARKED";
  // Park is a governed hold only at the active negotiation stages (S1/S2).
  const parkable = entry.currentStage === "S1" || entry.currentStage === "S2";
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
  const keysValid = (parseInt(keyCount, 10) || 0) > 0;
  const canCheckIn = s6Readiness(entry).every((c) => c.met) && registrationConfirmed && keysValid;
  // After the freeze, the Confirm step (still S4 until W4 fires) offers to open pre-arrival.
  const confirmedS4Active = viewing === 4 && fin.frozen && entry.currentStage === "S4";
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
  const ready = canConfirm(entry);
  const preconds = confirmStepActive
    ? confirmReadiness(entry)
    : inquiryStepActive
      ? s1Readiness(entry)
      : quoteStepActive
        ? s2Readiness(entry)
        : setupStepActive
          ? confirmReadiness(entry)
          : arrivalStepActive
            ? s5Readiness(entry)
            : checkInStepActive
              ? [
                  ...s6Readiness(entry),
                  { label: "Registration confirmed", met: registrationConfirmed },
                  { label: "Keys recorded", met: keysValid },
                ]
              : stayStepActive
                ? [...s7Readiness(entry), { label: "Night audit complete", met: nightAuditOk }]
                : checkOutStepActive
                  ? s8Readiness(entry)
                  : preconditionsFor(entry, step);
  const needsLabel = setupStepActive
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

  return (
    <div className="ws">
      {/* journey rail */}
      <nav className="track">
        <div className="track-h">This booking&rsquo;s journey</div>
        {DESK_STEPS.map((s) => {
          const future = s.order > maxReach;
          const cls = ["tnode", viewing === s.order ? "cur" : "", s.order < currentOrder ? "done" : "", future ? "future" : ""]
            .filter(Boolean)
            .join(" ");
          const glyph =
            s.order < currentOrder ? <Check style={{ stroke: "#fff" }} /> : s.bound ? <Lock /> : s.order;
          return (
            <button key={s.order} className={cls} onClick={() => gotoStep(s.order)}>
              <span className="g">{glyph}</span>
              <span className="tl">
                {s.label}
                <small>{s.sub}</small>
              </span>
            </button>
          );
        })}
      </nav>

      {/* canvas */}
      <div className="canvas-wrap">
        <div className="canvas-top">
          <button className="ws-back" onClick={() => router.push("/desk/bookings")}>
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
          {parked && (
            <span className="timer warn" style={{ gap: 5 }}>
              <Pause />
              Parked
            </span>
          )}
          {parkable &&
            (parked ? (
              <button
                className="btn btn-ghost btn-sm"
                disabled={unparkMutation.isPending}
                onClick={() => unparkMutation.mutate()}
              >
                <Play />
                {unparkMutation.isPending ? "Resuming…" : "Resume"}
              </button>
            ) : (
              <button
                className="btn btn-ghost btn-sm"
                disabled={parkMutation.isPending}
                onClick={() => setParkOpen(true)}
              >
                <Pause />
                Park
              </button>
            ))}
          <span className={`timer ${timer?.level ?? ""}`}>{fin.frozen ? "Confirmed" : timer?.text}</span>
        </div>

        <div className="canvas-scroll">
          <div className="canvas">
            {inquiryStepActive ? (
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
                keyCount={keyCount}
                setKeyCount={setKeyCount}
                registrationConfirmed={registrationConfirmed}
                setRegistrationConfirmed={setRegistrationConfirmed}
                setSelected={setSelected}
              />
            ) : stayStepActive ? (
              <StayStep entry={entry} setNightAuditOk={setNightAuditOk} setSelected={setSelected} />
            ) : checkOutStepActive ? (
              <CheckOutStep entry={entry} setSelected={setSelected} />
            ) : (
              <StepCanvas step={step} entry={entry} fin={fin} />
            )}
          </div>
        </div>

        {/* gate bar */}
        <div className="gatebar">
          <div className="gate-inner">
            <div className="needs">
              <span className="nl">{needsLabel}</span>
              {preconds.map((p) => (
                <span key={p.label} className={`need${p.met ? " met" : ""}`}>
                  <span className="nd" />
                  {p.label}
                </span>
              ))}
            </div>
            {parked ? (
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
                {advanceMutation.isPending ? "Moving…" : "Continue to Quote"}
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
              <button className="adv commit" onClick={() => setSelected(4)}>
                <Lock />
                Review &amp; confirm
              </button>
            ) : confirmedS4Active ? (
              <button className="adv" disabled={activateMutation.isPending} onClick={() => activateMutation.mutate()}>
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
            ) : onLiveStep ? (
              step.key === "closed" ? (
                <button className="adv" disabled>
                  <Lock />
                  Sealed · read-only
                </button>
              ) : (
                <button className="adv" onClick={() => setSelected(currentOrder)}>
                  Go to current step
                  <ArrowRight />
                </button>
              )
            ) : (
              <button className="adv" onClick={() => setSelected(currentOrder)}>
                Go to current step
                <ArrowRight />
              </button>
            )}
          </div>
        </div>
      </div>

      <SummaryRail entry={entry} fin={fin} />

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
            Any later change opens a <b>new round</b> — it won&rsquo;t quietly edit what&rsquo;s sealed.
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

      {parkOpen && (
        <div
          className="scrim"
          onClick={(e) => e.target === e.currentTarget && !parkMutation.isPending && setParkOpen(false)}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Park this booking">
            <div className="modal-top" style={{ background: "var(--warn-t)", borderBottomColor: "#e6cf9a" }}>
              <div className="modal-ic" style={{ background: "var(--warn)" }}>
                <Pause />
              </div>
              <div>
                <h3>Park this booking?</h3>
                <p>
                  {name} · {sub}
                </p>
              </div>
            </div>
            <div className="modal-body">
              <p className="why">
                Parking pauses this booking without losing its place. It stays at the same step — you can resume it
                any time. Nothing is cancelled or released.
              </p>
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="park-reason">Reason (optional)</label>
                <textarea
                  id="park-reason"
                  value={parkReason}
                  onChange={(e) => setParkReason(e.target.value)}
                  placeholder="e.g. waiting on the guest to confirm dates"
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setParkOpen(false)} disabled={parkMutation.isPending}>
                Not now
              </button>
              <button
                className="btn btn-primary"
                style={{ background: "var(--warn)" }}
                onClick={() => parkMutation.mutate()}
                disabled={parkMutation.isPending}
              >
                <Pause />
                {parkMutation.isPending ? "Parking…" : "Park booking"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
