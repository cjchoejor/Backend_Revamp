"use client";

/**
 * The booking workspace in the new frame (Surface Spec 03 and its 13–14 Sep amendment).
 *
 * header · preference strip · rail | canvas (This step · Booking details · History) | side panel
 * · gate bar with one forward move.
 *
 * Every rule the old workspace enforced is kept: the readiness lists, the order of the moves, the
 * two commitment boundaries behind their dialogs, park and resume, the key checklist that survives
 * a refresh. The step canvases are the working tools the desk has always used, rendered inside
 * `.desk-root` and re-dressed by the bridge stylesheet; they are redesigned one by one.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Dialog, EmptyState, Icon } from "@/design-system";
import { StandingChip, bookingHref } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { usePageTitle } from "@/hooks/use-page-title";
import { useDeskBookings } from "@/hooks/use-desk-data";
import {
  getBillingSummary,
  getEntry,
  getEntryTimers,
  getEntryTrace,
  listEntryCommunications,
  parkEntry,
  progressStage,
  unparkEntry,
  type EntryBillingSummary,
  type EntryCommunication,
  type TimerRecordSummary,
} from "@/lib/api/entries";
import { closeEntryAtS9 } from "@/lib/api/post-stay";
import { useClosureReadiness } from "@/hooks/use-closure-readiness";
import { activatePreArrival } from "@/lib/api/pre-arrival";
import { completeCheckInToS7 } from "@/lib/api/check-in";
import { listIdentityProofs } from "@/lib/api/identity-proofs";
import { updateInquiryNotes } from "@/lib/api/inquiries";
import { ApiError } from "@/lib/api/client";
import { DESK_STEPS, guestName } from "@/lib/desk/model";
import { findParkTimer } from "@/lib/desk/timers";
import {
  canConfirm,
  canProgressS1,
  canProgressS2,
  canProgressS5,
  canProgressS7,
  canProgressS8,
  confirmReadiness,
  currentStepOrder,
  deriveFinancials,
  maxReachableOrder,
  preconditionsFor,
  s1Readiness,
  s2Readiness,
  s5Readiness,
  s6Readiness,
  s7Readiness,
  s8Readiness,
  type Precondition,
} from "@/lib/desk/workspace";
import { arrivalNightRoomIds } from "@/lib/desk/party-rooms";
import { channelWord, factsFromEntry, standingOf } from "@/lib/ds/status";
import { fmtDateTime, fmtDay, fmtRange, fmtStamp, money, nightsOf, plural } from "@/lib/ds/format";
import { PHASES, BOUNDARY_STEPS, STEP_NAMES, STEP_NEEDS, stepNoOfStage, type StepNo } from "@/lib/ds/steps";
import { timerLabel } from "@/lib/ds/timers";
import { isHousekeeping, traceWords } from "@/lib/ds/trace-words";
import { BackendRailSlotContext } from "@/components/desk/workspace/backend-inline";
import { ReEnterMenu } from "@/components/desk/workspace/re-enter-menu";
import type { EntryDetail } from "@/types/api";
import { CaseCards } from "@/components/ds/steps/case-cards";
import { HistoryView } from "@/components/ds/workspace/history-view";
import { DetailsView } from "@/components/ds/workspace/details-view";
import { SidePapers } from "@/components/ds/workspace/side-papers";
import { SideTimer } from "@/components/ds/workspace/side-timer";
import { S1Inquiry } from "@/components/ds/steps/s1-inquiry";
import { S2Negotiation } from "@/components/ds/steps/s2-negotiation";
import { S3SetUp } from "@/components/ds/steps/s3-setup";
import { S4Reserve } from "@/components/ds/steps/s4-reserve";
import { S5Arrival } from "@/components/ds/steps/s5-arrival";
import { S6CheckIn } from "@/components/ds/steps/s6-checkin";
import { S7Stay } from "@/components/ds/steps/s7-stay";
import { S8CheckOut } from "@/components/ds/steps/s8-checkout";
import { S9Closed } from "@/components/ds/steps/s9-closed";
import { atLeast, useRefreshEntry } from "@/components/ds/steps/kit";
const atLeastFom = (level?: string | null) => atLeast(level, "L2");

// The step tools re-render only when their own props change (the parent lifts several UI flags).

const NOOP = () => {};

type View = "step" | "details" | "history";


/* ------------------------------------------------------------------ */

export function DsWorkspace({ entryId }: { entryId: string }) {
  const { session, isLoading: sessionLoading } = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const refreshEntry = useRefreshEntry(entryId);
  const hotelToday = useHotelDay()?.today ?? null;
  const clock = useHotelClock(30_000);

  const entryQuery = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId),
    enabled: !!session && !sessionLoading,
  });
  const entry = entryQuery.data ?? null;

  // The list row carries what the entry payload does not: the custodian's name, the booker's name.
  const listRow = useDeskBookings().data?.items.find((r) => r.id === entryId) ?? null;

  const paymentStatusQuery = usePaymentStatus(entryId, { enabled: !!entry?.folio });
  const paymentSatisfied = paymentStatusQuery.data?.satisfied;
  const totalReceived = paymentStatusQuery.data?.totalReceived ?? null;
  const requiredAmount = paymentStatusQuery.data?.requiredAmount ?? null;

  const billingQuery = useQuery({
    queryKey: ["billing-summary", entryId, entry?.updatedAt ?? ""],
    queryFn: () => getBillingSummary(session!, entryId),
    enabled: !!session && !sessionLoading && !!entry,
    refetchInterval: 30_000,
  });
  const billing = billingQuery.data ?? null;

  const commsQuery = useQuery({
    queryKey: ["entry-communications", entryId],
    queryFn: () => listEntryCommunications(session!, entryId),
    enabled: !!session && !sessionLoading,
  });
  const communications = commsQuery.data?.items ?? null;

  const identityProofsQuery = useQuery({
    queryKey: ["identity-proofs", entryId],
    queryFn: () => listIdentityProofs(session!, entryId),
    enabled: !!session && !sessionLoading && entry?.currentStage === "S6",
  });
  const guestDetailsCoverage = identityProofsQuery.data?.coverage ?? null;

  const timersQuery = useQuery({
    queryKey: ["entry-timers", entryId],
    queryFn: () => getEntryTimers(session!, entryId),
    enabled: !!session && !sessionLoading,
    refetchInterval: 30_000,
  });
  const traceQuery = useQuery({
    queryKey: ["entry-trace", entryId, entry?.updatedAt ?? ""],
    queryFn: () => getEntryTrace(session!, entryId, 100),
    enabled: !!session && !sessionLoading && !!entry,
  });

  // The seal's own checks, from the backend (2026-09-18) — the desk's copy had drifted from them.
  const closureQuery = useClosureReadiness(entryId, entry?.currentStage === "S9" && entry?.status !== "CLOSED");
  const closure = closureQuery.data ?? null;

  const parked = entry?.status === "PARKED";
  const parkTimer = findParkTimer(timersQuery.data?.items);

  // The step being looked at lives in the address (?step=N), so a link can open a booking at the
  // step that needs attention and Back returns to it.
  const stepParam = Number(params.get("step"));
  const view: View = params.get("view") === "details" ? "details" : params.get("view") === "history" ? "history" : "step";
  const [selected, setSelectedState] = useState<number | null>(stepParam >= 1 && stepParam <= 9 ? stepParam : null);
  const setView = (v: View, step?: number) => {
    const p = new URLSearchParams(params.toString());
    if (v === "step") p.delete("view");
    else p.set("view", v);
    if (step) p.set("step", String(step));
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const setSelected = (n: number) => {
    setSelectedState(n);
    const p = new URLSearchParams(params.toString());
    p.set("step", String(n));
    p.delete("view");
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  // The step tools call setSelected with a plain number; keep the reference stable for memo.
  const setSelectedRef = useRef(setSelected);
  setSelectedRef.current = setSelected;
  const stableSetSelected = useMemo(() => (n: number) => setSelectedRef.current(n), []);

  const currentOrder = entry ? currentStepOrder(entry) : 1;
  const readyToConfirm = entry ? canConfirm(entry, { paymentSatisfied, totalReceived, requiredAmount, communications }) : false;
  const maxReach = !entry ? 1 : entry.currentStage === "S3" && !readyToConfirm ? Math.min(maxReachableOrder(entry), 3) : maxReachableOrder(entry);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [moneyOpen, setMoneyOpen] = useState(false);
  const [guestPresent, setGuestPresent] = useState(false);
  // The registration tick survives a refresh until check-in records it, like the key checklist
  // (2026-09-18) — a reload mid check-in used to clear it silently and lock "Check in" again.
  const registrationStoreKey = `desk:registration:${entryId}`;
  const [registrationConfirmed, setRegistrationConfirmedState] = useState(false);
  useEffect(() => {
    try {
      setRegistrationConfirmedState(localStorage.getItem(registrationStoreKey) === "1");
    } catch {
      /* non-fatal */
    }
  }, [registrationStoreKey]);
  const setRegistrationConfirmed = useMemo(
    () => (v: boolean) => {
      setRegistrationConfirmedState(v);
      try {
        if (v) localStorage.setItem(registrationStoreKey, "1");
        else localStorage.removeItem(registrationStoreKey);
      } catch {
        /* non-fatal */
      }
    },
    [registrationStoreKey],
  );
  const [nightAuditOk, setNightAuditOk] = useState(false);
  const [parkOpen, setParkOpen] = useState(false);
  const [parkReason, setParkReason] = useState("");
  const [parkExitFlow, setParkExitFlow] = useState(false);
  const [exitLeaving, setExitLeaving] = useState<"park" | "plain" | null>(null);
  const pendingExitRef = useRef<string | null>(null);
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);

  /* ---- the per-room key checklist (survives a refresh until check-in stamps it) ---- */
  const [reserveExtras, setReserveExtras] = useState<string[]>([]);
  const reportReserveExtras = useMemo(
    () => (items: string[]) => setReserveExtras((prev) => (prev.join("|") === items.join("|") ? prev : items)),
    [],
  );
  const [issuedKeyRooms, setIssuedKeyRooms] = useState<Record<string, boolean>>({});
  const toggleKeyRoom = useMemo(() => (roomId: string) => setIssuedKeyRooms((prev) => ({ ...prev, [roomId]: !prev[roomId] })), []);
  const setKeyRooms = useMemo(
    () => (roomIds: string[], issued: boolean) =>
      setIssuedKeyRooms((prev) => {
        const next = { ...prev };
        for (const id of roomIds) next[id] = issued;
        return next;
      }),
    [],
  );
  const keyStoreKey = `desk:keys-issued:${entryId}`;
  const keyHydratedRef = useRef(false);
  useEffect(() => {
    keyHydratedRef.current = false;
  }, [keyStoreKey]);
  useEffect(() => {
    if (!entry || keyHydratedRef.current) return;
    keyHydratedRef.current = true;
    const planRooms = new Set((entry.roomAssignments ?? []).map((a) => a.roomId));
    const stored: Record<string, boolean> = {};
    try {
      const raw = localStorage.getItem(keyStoreKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (parsed && typeof parsed === "object") {
        for (const [roomId, issued] of Object.entries(parsed as Record<string, unknown>)) {
          if (issued === true && planRooms.has(roomId)) stored[roomId] = true;
        }
      }
    } catch {
      /* the marks just won't survive navigation */
    }
    for (const a of entry.roomAssignments ?? []) {
      if (a.keyIssuedAt && !a.keyReturnedAt) stored[a.roomId] = true;
    }
    setIssuedKeyRooms((prev) => ({ ...stored, ...prev }));
  }, [entry, keyStoreKey]);
  useEffect(() => {
    if (!keyHydratedRef.current) return;
    try {
      const marked = Object.keys(issuedKeyRooms).filter((id) => issuedKeyRooms[id]);
      if (marked.length) localStorage.setItem(keyStoreKey, JSON.stringify(Object.fromEntries(marked.map((id) => [id, true]))));
      else localStorage.removeItem(keyStoreKey);
    } catch {
      /* non-fatal */
    }
  }, [keyStoreKey, issuedKeyRooms]);

  /* ---- the moves ---- */
  // A move starts and stops clocks, opens handoffs and sends papers, so everything the steps
  // read is refreshed — the side timers kept showing the last step's clocks (e.g. "Arrival window
  // opens · overdue" after Arrival had opened) until their 30-second poll.
  const afterMove = (updated: EntryDetail) => {
    queryClient.setQueryData(["entry", updated.id], updated);
    refreshEntry([["expected-arrival", updated.id], ["competing-claims", updated.id], ["identity-proofs", updated.id]]);
  };
  const fail = (fallback: string) => (e: unknown) => toast.error(e instanceof ApiError ? e.message : fallback);

  const confirmMutation = useMutation({
    mutationFn: () => progressStage(session!, entry!.id, { targetStage: "S4", version: entry!.version }),
    onSuccess: (updated) => {
      afterMove(updated);
      setConfirmOpen(false);
      setSelected(4);
      toast.success("Reserved — the booking is frozen.");
    },
    onError: fail("Reserving failed"),
  });
  const closeMutation = useMutation({
    mutationFn: () => closeEntryAtS9(session!, entry!.id),
    onSuccess: (updated) => {
      afterMove(updated);
      setCloseOpen(false);
      toast.success("Closed — the record is sealed.");
    },
    onError: fail("Closing failed"),
  });
  const advanceMutation = useMutation({
    mutationFn: (vars: { targetStage: string; guestPhysicallyPresent?: boolean }) =>
      progressStage(session!, entry!.id, { targetStage: vars.targetStage, version: entry!.version, guestPhysicallyPresent: vars.guestPhysicallyPresent }),
    onSuccess: (updated) => {
      afterMove(updated);
      const n = currentStepOrder(updated);
      setSelected(n);
      toast.success(`Moved to ${STEP_NAMES[n - 1]}.`);
    },
    onError: fail("Couldn't move forward"),
  });
  const activateMutation = useMutation({
    mutationFn: () => activatePreArrival(session!, entry!.id),
    onSuccess: (updated) => {
      afterMove(updated);
      setSelected(5);
      toast.success("Moved to Arrival.");
    },
    onError: fail("Couldn't open Arrival yet"),
  });
  const checkInMutation = useMutation({
    mutationFn: () => {
      const dayOne = arrivalNightRoomIds(entry!);
      const issued = Array.from(new Set((entry!.roomAssignments ?? []).map((a) => a.roomId))).filter((id) => dayOne.has(id) && issuedKeyRooms[id]);
      return completeCheckInToS7(session!, entry!.id, entry!.version, { keyCount: Math.max(1, issued.length), registrationConfirmed: true, issuedKeyRoomIds: issued });
    },
    onSuccess: (updated) => {
      afterMove(updated);
      setCheckInOpen(false);
      setSelected(7);
      try {
        localStorage.removeItem(keyStoreKey);
        localStorage.removeItem(registrationStoreKey);
      } catch {
        /* non-fatal */
      }
      toast.success("Checked in — the folio is live.");
    },
    onError: fail("Check-in failed"),
  });
  const parkMutation = useMutation({
    mutationFn: () => parkEntry(session!, entry!.id, parkReason.trim()),
    onSuccess: (updated) => {
      afterMove(updated);
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", updated.id] });
      toast.success("Parked — it keeps its place.");
      if (parkExitFlow) {
        setExitLeaving("park");
        const dest = pendingExitRef.current ?? "/bookings";
        pendingExitRef.current = null;
        router.push(dest);
      } else {
        setParkOpen(false);
        setParkReason("");
      }
    },
    onError: fail("Couldn't park this booking"),
  });
  const unparkMutation = useMutation({
    mutationFn: () => unparkEntry(session!, entry!.id),
    onSuccess: (updated) => {
      afterMove(updated);
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", updated.id] });
      toast.success("Resumed — back on the active desk.");
    },
    onError: fail("Couldn't resume this booking"),
  });

  // Land on the step the booking is at (or the Reserve review when Set up is complete).
  useEffect(() => {
    if (!entry || selected !== null) return;
    setSelectedState(readyToConfirm ? 4 : currentStepOrder(entry));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, selected, readyToConfirm]);

  // Every step view starts at the top.
  const viewing = selected ?? currentOrder;
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [viewing, view]);

  const fin = useMemo(() => (entry ? deriveFinancials(entry, { paymentStatus: paymentStatusQuery.data }) : null), [entry, paymentStatusQuery.data]);
  const name = entry ? guestName(entry.guestProfile ?? entry.inquiry?.guestProfile ?? null) : null;
  usePageTitle(entry ? (name !== "Guest" ? name : entry.id) : null);

  // Leaving an unfinished inquiry or negotiation offers the park on the way out — Back, the bar,
  // any link that leaves this booking.
  const parkPromptable = !!entry && entry.status === "ACTIVE" && (entry.currentStage === "S1" || entry.currentStage === "S2");
  useEffect(() => {
    if (!parkPromptable) return;
    window.history.pushState({ deskParkGuard: entryId }, "");
    const onPop = () => {
      window.history.pushState({ deskParkGuard: entryId }, "");
      pendingExitRef.current = "/bookings";
      setParkExitFlow(true);
      setParkOpen(true);
    };
    const onClickCapture = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest?.("a[href^='/']") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank") return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith(bookingHref(entryId)) || href.includes(`edit=${entryId}`) || href.startsWith("/api/")) return;
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
      <div className="page">
        <div className="skeleton" aria-busy="true">
          <span style={{ width: "40%" }} />
          <span style={{ width: "90%" }} />
          <span style={{ width: "70%" }} />
        </div>
      </div>
    );
  }
  if (entryQuery.isError || !entry || !fin) {
    return (
      <div className="page">
        <EmptyState title="Couldn't open this booking">
          {entryQuery.error instanceof ApiError ? entryQuery.error.message : "The hotel server did not answer."}
          <div style={{ marginTop: 10 }}>
            <Link className="btn btn-secondary compact" href="/bookings">
              Back to Bookings
            </Link>
          </div>
        </EmptyState>
      </div>
    );
  }

  const step = DESK_STEPS[viewing - 1];
  const atStep = stepNoOfStage(entry.currentStage);
  const sealed = entry.status === "CLOSED" || entry.status === "CANCELLED" || entry.status === "EXPIRED" || entry.currentStage === "TERMINAL";
  const parkable = !sealed && entry.status === "ACTIVE";
  const promptParkOnExit = parkable && (entry.currentStage === "S1" || entry.currentStage === "S2");

  const confirmStepActive = viewing === 4 && !fin.frozen && entry.currentStage === "S3";
  const confirmedS4Active = viewing === 4 && fin.frozen && entry.currentStage === "S4";
  const live = (key: string, stage: string) => step.key === key && entry.currentStage === stage && viewing === currentOrder;
  const inquiryStepActive = live("inquiry", "S1");
  const quoteStepActive = live("quote", "S2");
  const setupStepActive = live("setup", "S3");
  const arrivalStepActive = live("arrival", "S5");
  const checkInStepActive = live("checkin", "S6");
  const stayStepActive = live("stay", "S7");
  const checkOutStepActive = live("checkout", "S8");
  const closedStepActive = step.key === "closed" && entry.currentStage === "S9" && entry.status !== "CLOSED" && viewing === currentOrder;

  const allAssignedRoomIds = Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.roomId)));
  const dayOneRooms = arrivalNightRoomIds(entry);
  const checkInRoomIds = allAssignedRoomIds.filter((id) => dayOneRooms.has(id));
  const moveDayRoomCount = allAssignedRoomIds.length - checkInRoomIds.length;
  const issuedKeyCount = checkInRoomIds.filter((id) => issuedKeyRooms[id]).length;
  const keysValid = checkInRoomIds.length > 0 && issuedKeyCount === checkInRoomIds.length;
  const canCheckIn = s6Readiness(entry, { guestDetails: guestDetailsCoverage }).every((c) => c.met) && registrationConfirmed && keysValid;

  const segStart = (entry.segments ?? [])[0]?.startedAt ?? null;
  const voucherAnswerRecorded = (communications ?? []).some(
    (c) =>
      c.commType === "CONFIRMATION_VOUCHER" &&
      c.direction === "OUTBOUND" &&
      c.sendStatus === "DISPATCHED" &&
      c.acknowledgementStatus === "RECEIVED" &&
      (!segStart || (c.createdAt ?? "") >= segStart),
  );

  const ready = readyToConfirm && reserveExtras.length === 0;
  const sealedOutcome =
    entry.status === "CANCELLED" ? "Cancelled — a read-only record" : entry.status === "EXPIRED" || entry.currentStage === "TERMINAL" ? "Expired — a read-only record" : "Closed and sealed — a read-only record";

  const preconds: Precondition[] = sealed
    ? []
    : confirmStepActive || setupStepActive
      ? [
          ...confirmReadiness(entry, { paymentSatisfied, totalReceived, requiredAmount, communications }),
          ...(confirmStepActive ? reserveExtras.map((label) => ({ label, met: false })) : []),
        ]
      : inquiryStepActive
        ? s1Readiness(entry)
        : quoteStepActive
          ? s2Readiness(entry)
          : arrivalStepActive
            ? s5Readiness(entry)
            : checkInStepActive
              ? [
                  ...s6Readiness(entry, { guestDetails: guestDetailsCoverage }),
                  { label: "Registration confirmed", met: registrationConfirmed },
                  {
                    label:
                      checkInRoomIds.length > 1 || moveDayRoomCount > 0
                        ? `Every arrival-night key marked (${issuedKeyCount} of ${checkInRoomIds.length})${moveDayRoomCount > 0 ? ` · ${moveDayRoomCount} on the move day` : ""}`
                        : "Room key marked",
                    met: keysValid,
                  },
                ]
              : stayStepActive
                ? [...s7Readiness(entry, hotelToday), { label: "Night audit complete", met: nightAuditOk }]
                : checkOutStepActive
                  ? s8Readiness(entry)
                  : closedStepActive
                    ? closure
                      ? closure.checks.map((c) => ({ label: c.label, met: c.met }))
                      : [{ label: "Checking what is left before the close…", met: false }]
                    : confirmedS4Active
                      ? [{ label: "The guest's answer to the confirmation voucher recorded", met: voucherAnswerRecorded }]
                      : viewing < currentOrder
                        ? []
                        : preconditionsFor(entry, step, hotelToday);
  const unmet = preconds.filter((p) => !p.met).length;

  const viewingPast = view === "step" && (viewing < currentOrder || (sealed && step.key !== "closed")) && !confirmStepActive;

  const gotoStep = (n: number) => {
    if (n > maxReach) {
      toast.info("That step comes later — finish this one first.");
      return;
    }
    setSelected(n);
  };

  const handleExit = () => {
    if (promptParkOnExit) {
      pendingExitRef.current = "/bookings";
      setParkExitFlow(true);
      setParkOpen(true);
    } else router.push("/bookings");
  };

  /* ---- the forward move: one button, its reason beside it ---- */
  const inert = unmet > 0;
  const firstNote = inert ? `${plural(unmet, "thing")} first` : undefined;
  let forward: ReactNode;
  if (sealed || (step.key === "closed" && entry.status === "CLOSED")) {
    forward = (
      <Chip tone="quiet" icon="lock">
        Sealed
      </Chip>
    );
  } else if (parked) {
    forward = (
      <Button state={unparkMutation.isPending ? "working" : "default"} workingLabel="Resuming…" onClick={() => unparkMutation.mutate()}>
        Resume
      </Button>
    );
  } else if (confirmStepActive) {
    forward = (
      <Button icon="lock" state={ready ? "default" : "inert"} reason={ready ? undefined : firstNote} onClick={() => setConfirmOpen(true)}>
        Reserve the booking
      </Button>
    );
  } else if (inquiryStepActive) {
    const ok = canProgressS1(entry);
    forward = (
      <Button state={advanceMutation.isPending ? "working" : ok ? "default" : "inert"} reason={ok ? undefined : firstNote} workingLabel="Moving…" onClick={() => advanceMutation.mutate({ targetStage: "S2" })}>
        Move to Negotiation
      </Button>
    );
  } else if (quoteStepActive) {
    const ok = canProgressS2(entry);
    forward = (
      <Button state={advanceMutation.isPending ? "working" : ok ? "default" : "inert"} reason={ok ? undefined : firstNote} workingLabel="Moving…" onClick={() => advanceMutation.mutate({ targetStage: "S3" })}>
        Move to Set up
      </Button>
    );
  } else if (setupStepActive) {
    forward = (
      <Button state={ready ? "default" : "inert"} reason={ready ? "the booking stays at Set up until you reserve it" : firstNote} onClick={() => setSelected(4)}>
        Move to Reserve
      </Button>
    );
  } else if (confirmedS4Active) {
    forward = (
      <Button
        state={activateMutation.isPending ? "working" : voucherAnswerRecorded ? "default" : "inert"}
        reason={voucherAnswerRecorded ? undefined : "record the guest's answer to the voucher first"}
        workingLabel="Opening…"
        onClick={() => activateMutation.mutate()}
      >
        Move to Arrival
      </Button>
    );
  } else if (arrivalStepActive) {
    const ok = canProgressS5(entry, guestPresent);
    forward = (
      <Button
        state={advanceMutation.isPending ? "working" : ok ? "default" : "inert"}
        reason={ok ? undefined : firstNote}
        workingLabel="Moving…"
        onClick={() => advanceMutation.mutate({ targetStage: "S6", guestPhysicallyPresent: true })}
      >
        Move to Check-in
      </Button>
    );
  } else if (checkInStepActive) {
    forward = (
      <Button icon="lock" state={canCheckIn ? "default" : "inert"} reason={canCheckIn ? undefined : firstNote} onClick={() => setCheckInOpen(true)}>
        Check in &amp; go live
      </Button>
    );
  } else if (stayStepActive) {
    const ok = canProgressS7(entry, nightAuditOk, hotelToday);
    forward = (
      <Button state={advanceMutation.isPending ? "working" : ok ? "default" : "inert"} reason={ok ? undefined : firstNote} workingLabel="Moving…" onClick={() => advanceMutation.mutate({ targetStage: "S8" })}>
        Move to Check-out
      </Button>
    );
  } else if (checkOutStepActive) {
    const ok = canProgressS8(entry);
    forward = (
      <Button state={advanceMutation.isPending ? "working" : ok ? "default" : "inert"} reason={ok ? undefined : firstNote} workingLabel="Moving…" onClick={() => advanceMutation.mutate({ targetStage: "S9" })}>
        Move to Closed
      </Button>
    );
  } else if (closedStepActive) {
    const ok = !!closure?.canClose && atLeastFom(session?.actorLevel);
    forward = (
      <Button icon="lock" state={closeMutation.isPending ? "working" : ok ? "default" : "inert"} reason={ok ? undefined : firstNote} workingLabel="Sealing…" onClick={() => setCloseOpen(true)}>
        Close &amp; seal the record
      </Button>
    );
  } else if (viewing !== currentOrder) {
    forward = (
      <Button kind="secondary" onClick={() => setSelected(currentOrder)}>
        Go to {STEP_NAMES[currentOrder - 1]}
      </Button>
    );
  } else {
    forward = null;
  }

  /* ---- the canvas ---- */
  const openPark = () => {
    setParkExitFlow(false);
    setParkOpen(true);
  };
  /** Each step is drawn by its own canvas (components/ds/steps). */
  const nativeBody = (): ReactNode | null => {
    switch (step.key) {
      case "inquiry":
        return <S1Inquiry entry={entry} past={viewingPast} onPark={parkable ? openPark : undefined} />;
      case "quote":
        return <S2Negotiation entry={entry} past={viewingPast} onPark={parkable ? openPark : undefined} />;
      case "setup":
        return <S3SetUp entry={entry} past={viewingPast} onPark={parkable ? openPark : undefined} goToStep={viewingPast ? NOOP : stableSetSelected} />;
      case "confirm":
        return (
          <S4Reserve
            entry={entry}
            past={viewingPast}
            onPark={parkable ? openPark : undefined}
            goToStep={gotoStep}
            reserve={confirmStepActive ? { onClick: () => setConfirmOpen(true), ready, reason: ready ? undefined : firstNote } : null}
            onOpenItems={confirmStepActive ? reportReserveExtras : undefined}
          />
        );
      case "arrival":
        return (
          <S5Arrival
            entry={entry}
            past={viewingPast}
            onPark={parkable ? openPark : undefined}
            guestPresent={guestPresent}
            setGuestPresent={arrivalStepActive ? setGuestPresent : NOOP}
          />
        );
      case "checkin":
        return (
          <S6CheckIn
            entry={entry}
            past={viewingPast}
            issuedKeyRooms={issuedKeyRooms}
            toggleKeyRoom={checkInStepActive ? toggleKeyRoom : NOOP}
            setKeyRooms={checkInStepActive ? setKeyRooms : NOOP}
            registrationConfirmed={registrationConfirmed}
            setRegistrationConfirmed={checkInStepActive ? setRegistrationConfirmed : NOOP}
            checkIn={checkInStepActive ? { onClick: () => setCheckInOpen(true), ready: canCheckIn, reason: canCheckIn ? undefined : firstNote } : null}
          />
        );
      case "stay":
        return <S7Stay entry={entry} past={viewingPast} setNightAuditOk={stayStepActive ? setNightAuditOk : NOOP} goToStep={viewingPast ? NOOP : stableSetSelected} />;
      case "checkout":
        return <S8CheckOut entry={entry} past={viewingPast} goToStep={viewingPast ? NOOP : stableSetSelected} />;
      case "closed": {
        const canClose = !!closure?.canClose && atLeastFom(session?.actorLevel);
        const closeReason = canClose ? undefined : !atLeastFom(session?.actorLevel) ? "closing needs the FOM" : firstNote;
        return (
          <S9Closed
            entry={entry}
            past={viewingPast}
            close={closedStepActive ? { onClick: () => setCloseOpen(true), ready: canClose, reason: closeReason } : null}
          />
        );
      }
      default:
        return null;
    }
  };
  const native = nativeBody();

  /* ---- the header ---- */
  const standing = standingOf(factsFromEntry(entry, billing?.folio?.outstandingBalance ?? null, listRow ? bookerName(listRow) : null), hotelToday);
  const co = entry.actualCheckOutDate ?? entry.checkOutDate;
  const nights = nightsOf(entry.checkInDate, co);
  const roomNumbers = Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.room?.roomNumber).filter((x): x is string => !!x))).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const cur = billing?.currency ?? fin.currency;
  const totalKind =
    billing?.headline.kind === "BILLED_SO_FAR"
      ? "billed so far"
      : billing?.stayTotal?.earlyDeparture
        ? "shortened stay"
        : billing?.headline.frozen
          ? "as confirmed"
          : "indicative";
  const headline = billing ? billing.headline.amount : fin.frozen ? null : fin.indicativeTotal;
  const booker = listRow ? bookerName(listRow) : null;

  return (
    <BackendRailSlotContext.Provider value={railSlot}>
      <div className="ws">
        <div className="ws-head">
          <div>
            <a
              href="/bookings"
              className="backlink"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleExit();
              }}
            >
              <Icon name="chev" /> Back to Bookings
            </a>
            <div className="who">
              <h2 className={name === "Guest" ? "name-i" : undefined}>{name === "Guest" ? "to come from the agent" : name}</h2>
              <StandingChip standing={standing} />
              {entry.guestProfile?.vipTier ? (
                <Chip tone="accent" tier>
                  VIP
                </Chip>
              ) : null}
              {entry.groupBillingMode === "GROUP_MASTER" ? <Chip>Group</Chip> : null}
            </div>
            <div className="facts">
              <span>{entry.id}</span>
              <span>
                <b>{fmtRange(entry.checkInDate, co)}</b>
                {nights ? ` · ${plural(nights, "night")}` : ""}
              </span>
              <span>
                Rooms <b>{roomNumbers.length || entry.numberOfRooms || "—"}</b>
                {roomNumbers.length ? ` · ${roomNumbers.join(", ")}` : " · not yet assigned"}
              </span>
              <span>
                {channelWord(entry.inquiry?.sourceChannel)}
                {booker ? ` · ${booker}` : ""}
              </span>
              <span>
                Custodian <b>{listRow?.custodianName ?? "—"}</b>
              </span>
            </div>
          </div>
          <div className="total" style={{ position: "relative" }}>
            <button
              type="button"
              className="figure money"
              aria-expanded={moneyOpen}
              onClick={() => {
                setMoneyOpen((o) => !o);
                void billingQuery.refetch();
              }}
            >
              {money(headline, cur)}
            </button>
            <div className="kind">{totalKind} · click for the breakdown</div>
            {moneyOpen ? <MoneyPop billing={billing} currency={cur} segmentNumber={entry.segmentNumber ?? 1} onClose={() => setMoneyOpen(false)} /> : null}
          </div>
        </div>

        <PrefStrip entry={entry} onDetails={() => setView("details", viewing)} />

        <div className="ws-body">
          <nav className="rail" aria-label="Journey">
            {PHASES.map(([phase, steps]) => (
              <div key={phase} style={{ display: "contents" }}>
                <div className={`phase${steps.includes(viewing as StepNo) ? " current" : ""}`}>{phase}</div>
                {steps.map((n) => {
                  const cls = [
                    "step",
                    n === viewing && view === "step" ? "current" : n <= atStep || n <= maxReach ? "reached" : "unreachable",
                    BOUNDARY_STEPS.has(n) ? "boundary" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <a
                      key={n}
                      className={cls}
                      href={`${bookingHref(entry.id)}?step=${n}`}
                      aria-current={n === viewing && view === "step" ? "step" : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        gotoStep(n);
                      }}
                    >
                      <span className="n">{n === 9 && sealed ? <Icon name="lock" /> : n}</span>
                      <span>{STEP_NAMES[n - 1]}</span>
                    </a>
                  );
                })}
              </div>
            ))}
            <div className="legend">
              <span>
                <i />
                cannot be undone
              </span>
              <span>
                Pass {entry.segmentNumber ?? 1} ·{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setView("history", viewing);
                  }}
                >
                  {(entry.segmentNumber ?? 1) > 1 ? "prior passes" : "history"}
                </a>
              </span>
              <span className="desk-root rail-legacy" style={{ marginTop: 6 }}>
                <ReEnterMenu entry={entry} />
              </span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {parked ? (
                  <Button kind="quiet" compact state={unparkMutation.isPending ? "working" : "default"} onClick={() => unparkMutation.mutate()}>
                    Resume
                  </Button>
                ) : parkable ? (
                  <Button
                    kind="quiet"
                    compact
                    onClick={() => {
                      setParkExitFlow(false);
                      setParkOpen(true);
                    }}
                  >
                    Park
                  </Button>
                ) : null}
                <Button kind="quiet" compact onClick={() => router.push(`${bookingHref(entry.id)}/backend`)}>
                  Under the hood
                </Button>
              </span>
              {parked && parkTimer ? <span>parked · expires {fmtDateTime(parkTimer.firesAt, clock.tz)}</span> : null}
            </div>
          </nav>

          <div className="canvas">
            <div className="canvas-tabs" role="tablist">
              <button type="button" className="tab" role="tab" aria-selected={view === "step"} onClick={() => setView("step", viewing)}>
                This step
              </button>
              <button type="button" className="tab" role="tab" aria-selected={view === "details"} onClick={() => setView("details", viewing)}>
                Booking details
              </button>
              <button type="button" className="tab" role="tab" aria-selected={view === "history"} onClick={() => setView("history", viewing)}>
                History
              </button>
            </div>

            {entry.earlyDeparture ? (
              <div className="notice inert">
                <span className="sm">
                  <b>Left early on {fmtDay(entry.earlyDeparture.departureDate)}</b> — booked to {fmtDay(entry.earlyDeparture.originalCheckOutDate)} ·{" "}
                  {entry.earlyDeparture.sleptNights} of {plural(entry.earlyDeparture.bookedNights, "night")} slept ·{" "}
                  {entry.earlyDeparture.feeWaived
                    ? "fee waived"
                    : Number(entry.earlyDeparture.feeAmount) > 0
                      ? `fee ${money(entry.earlyDeparture.feeAmount)} on the folio`
                      : "no fee"}
                </span>
              </div>
            ) : null}

            {view === "details" ? (
              <DetailsView entry={entry} booker={booker} custodian={listRow?.custodianName ?? null} billing={billing ?? null} />
            ) : view === "history" ? (
              <HistoryView entry={entry} billing={billing ?? null} tz={clock.tz} onOpenedPass={(stage) => setSelected(stepNoOfStage(stage))} />
            ) : (
              <>
                <h3>
                  {STEP_NAMES[viewing - 1]} <span className="need">{STEP_NEEDS[viewing as StepNo]}</span>
                </h3>
                {viewingPast ? (
                  <div className="notice inert">
                    <span className="sm">
                      {sealed
                        ? sealedOutcome
                        : `This step was passed on the way to ${STEP_NAMES[currentOrder - 1]} — what it shows is what was decided then; nothing here can be changed. Any change is a governed re-entry.`}
                    </span>
                  </div>
                ) : null}
                <CaseCards
                    entry={entry}
                    step={viewing}
                    events={traceQuery.data?.items ?? []}
                    tz={clock.tz}
                    park={parked ? { reason: listRow?.parkReason ?? null, followUpAt: listRow?.parkFollowUpAt ?? null, lapsesAt: parkTimer?.firesAt ?? null } : null}
                    onResume={parked ? () => unparkMutation.mutate() : undefined}
                    resuming={unparkMutation.isPending}
                    onHistory={() => setView("history", viewing)}
                  />
                {native}
              </>
            )}
            {/* the old side column's "what runs here" target — kept mounted, not shown */}
            <div ref={setRailSlot} hidden />
          </div>

          <SidePanel
            entry={entry}
            sealed={sealed}
            onGo={(n) => gotoStep(n)}
            timers={timersQuery.data?.items ?? []}
            events={traceQuery.data?.items ?? []}
            communications={communications ?? []}
            tz={clock.tz}
            onHistory={() => setView("history", viewing)}
          />
        </div>

        <div className="gatebar">
          {parked ? (
            <div className="sm ink-2">
              Parked · <b>Resume to continue</b>
            </div>
          ) : sealed ? (
            <div className="sm ink-2">{sealedOutcome}</div>
          ) : preconds.length ? (
            <div className="gate">
              {preconds.map((p) => (
                <div key={p.label} className={`item ${p.met ? "met" : "unmet"}`}>
                  <Icon name={p.met ? "check" : "circle"} />
                  <span>{p.label}</span>
                </div>
              ))}
            </div>
          ) : viewing < currentOrder ? (
            <span className="meta">a step already passed · the booking is at {STEP_NAMES[currentOrder - 1]}</span>
          ) : (
            <span />
          )}
          <div className="acts">{forward}</div>
        </div>

        <CommitDialog
          open={confirmOpen}
          title="Reserve the booking"
          caseLines={[<b key="n">{name}</b>, `${entry.id} · ${fmtRange(entry.checkInDate, entry.checkOutDate)}`]}
          lines={[
            fin.indicativeTotal !== null ? `The price freezes at ${money(fin.indicativeTotal, fin.currency)} — the guest is held to it.` : "The price freezes — the guest is held to it.",
            "The rooms lock — no longer offerable to anyone else.",
            "The confirmation voucher goes to whoever booked.",
            "Any later change opens a new pass; it never edits what is frozen.",
          ]}
          confirmLabel="Reserve"
          pending={confirmMutation.isPending}
          onConfirm={() => confirmMutation.mutate()}
          onClose={() => setConfirmOpen(false)}
        />
        <CommitDialog
          open={checkInOpen}
          title="Check in and open the folio"
          caseLines={[<b key="n">{name}</b>, `${entry.id} · ${roomNumbers.length ? `Rooms ${roomNumbers.join(", ")}` : ""}`]}
          lines={["The folio goes live — from here it can only grow.", "The rooms become occupied and the keys are handed over.", "Charges begin posting against the live folio."]}
          confirmLabel="Check in & go live"
          pending={checkInMutation.isPending}
          onConfirm={() => checkInMutation.mutate()}
          onClose={() => setCheckInOpen(false)}
        />
        <CommitDialog
          open={closeOpen}
          title="Close and seal the record"
          caseLines={[<b key="n">{name}</b>, entry.id]}
          lines={[
            "The booking is closed — the record becomes read-only.",
            "A later correction is added as a new layer, never a change to what is sealed.",
            "Post-stay follow-up passes to the system (feedback, payment follow-up, retention).",
          ]}
          confirmLabel="Close & seal"
          pending={closeMutation.isPending}
          onConfirm={() => closeMutation.mutate()}
          onClose={() => setCloseOpen(false)}
        />

        {parkOpen ? (
          <div
            className="scrim open"
            onClick={(e) => {
              if (e.target !== e.currentTarget || parkMutation.isPending || exitLeaving) return;
              pendingExitRef.current = null;
              setParkOpen(false);
            }}
          >
            <Dialog
              register="commit"
              title={parkExitFlow ? "Park this booking before you leave?" : "Park this booking"}
              caseLines={[<b key="n">{name}</b>, entry.id]}
              footer={
                <>
                  {parkExitFlow ? (
                    <Button
                      kind="quiet"
                      state={exitLeaving === "plain" ? "working" : parkMutation.isPending || exitLeaving ? "inert" : "default"}
                      workingLabel="Leaving…"
                      onClick={() => {
                        setExitLeaving("plain");
                        const dest = pendingExitRef.current ?? "/bookings";
                        pendingExitRef.current = null;
                        router.push(dest);
                      }}
                    >
                      Leave without parking
                    </Button>
                  ) : (
                    <Button kind="quiet" onClick={() => setParkOpen(false)}>
                      Not now
                    </Button>
                  )}
                  <Button
                    state={parkMutation.isPending || exitLeaving === "park" ? "working" : !parkReason.trim() || exitLeaving ? "inert" : "default"}
                    workingLabel={exitLeaving === "park" ? "Leaving…" : "Parking…"}
                    onClick={() => parkMutation.mutate()}
                  >
                    {parkExitFlow ? "Park & leave" : "Park"}
                  </Button>
                </>
              }
            >
              <p className="sm">
                Parking pauses the booking without losing its place — it stays at {STEP_NAMES[atStep - 1]}, its expiry waits, and it can be resumed any time. Nothing is
                cancelled or released.
              </p>
              <div className="field">
                <label htmlFor="park-reason">Reason</label>
                <textarea
                  id="park-reason"
                  className="input"
                  style={{ height: 72, paddingTop: 8 }}
                  value={parkReason}
                  onChange={(e) => setParkReason(e.target.value)}
                  placeholder="e.g. waiting on the guest to confirm dates"
                  maxLength={500}
                />
              </div>
            </Dialog>
          </div>
        ) : null}
      </div>
    </BackendRailSlotContext.Provider>
  );
}

/** Who recorded an event, in words — the system is "system", a person is their name. */
function whoDid(ev: { actorId: string; actorLevel: string; actorName?: string }): string {
  if (ev.actorId === "SYSTEM" || ev.actorLevel === "SYSTEM" || ev.actorName === "SYSTEM") return "system";
  return ev.actorName ?? ev.actorId;
}

function bookerName(row: { inquiry: { travelAgent: { displayName: string } | null; corporateAccount: { displayName: string } | null } | null }): string | null {
  return row.inquiry?.travelAgent?.displayName ?? row.inquiry?.corporateAccount?.displayName ?? null;
}

/* ------------------------------------------------------------------ */

function CommitDialog({
  open,
  title,
  caseLines,
  lines,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  caseLines: ReactNode[];
  lines: string[];
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="scrim open" onClick={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <Dialog
        register="commit"
        title={title}
        caseLines={caseLines}
        footer={
          <>
            <Button kind="quiet" state={pending ? "inert" : "default"} onClick={onClose}>
              Not yet
            </Button>
            <Button icon="lock" state={pending ? "working" : "default"} workingLabel="Working…" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <p className="sm">This cannot be undone. What becomes binding:</p>
        <ul className="plain-list sm" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

function MoneyPop({ billing, currency, segmentNumber, onClose }: { billing: EntryBillingSummary | null; currency: string; segmentNumber: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(".ws-head .total")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const st = billing?.stayTotal;
  const fo = billing?.folio ?? null;
  const row = (label: ReactNode, value: number | null | undefined, bold?: boolean) => (
    <div className={`ml${bold ? " b" : ""}`}>
      <span>{label}</span>
      <span className="money">{money(value, currency)}</span>
    </div>
  );
  return (
    <div className="money-pop" ref={ref} role="dialog" aria-label="Money on this booking">
      <h4 style={{ marginBottom: 6 }}>Money on this booking</h4>
      {!billing ? <p className="meta">Reading the figures…</p> : null}
      {row(`Stay total · ${st?.frozen ? "as confirmed" : "indicative"}`, st?.amount, true)}
      {st?.basis === "PER_NIGHT_TIMES_NIGHTS" && st.perNightAmount != null ? (
        <div className="meta">
          {money(st.perNightAmount, currency)} a night{st.nights != null ? ` · ${plural(st.nights, "night")}` : ""}
        </div>
      ) : null}
      {st?.earlyDeparture ? (
        <div className="meta">
          shortened: {st.earlyDeparture.sleptNights} nights slept · {money(st.earlyDeparture.forgoneRoomTotal, currency)} not charged
        </div>
      ) : null}
      {st?.segmentNumber != null && segmentNumber > 1 ? <div className="meta">priced on pass {st.segmentNumber} — every room change re-prices it</div> : null}
      {billing?.rooms?.length ? (
        <>
          <h4 style={{ margin: "10px 0 4px", fontSize: "var(--t-sm)" }}>Per room</h4>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {billing.rooms.map((r, i) => {
              const m = r.mealCounts;
              const meals = [m?.cp ? `${m.cp} CP` : null, m?.mapl ? `${m.mapl} MAP+L` : null, m?.mapd ? `${m.mapd} MAP+D` : null, m?.ap ? `${m.ap} AP` : null, m?.others ? `${m.others} other` : null]
                .filter(Boolean)
                .join(" · ");
              const bits = [
                r.roomSubtotal != null ? `room ${money(r.roomSubtotal, currency)}` : null,
                (r.mealsSubtotal ?? 0) > 0 || meals ? `meals ${money(r.mealsSubtotal, currency)}${meals ? ` (${meals}${r.mealsVaryByNight ? " · varies by night" : ""})` : ""}` : null,
                r.extraBedCount > 0 ? `${plural(r.extraBedCount, "extra bed")} ${money(r.extraBedSubtotal, currency)}` : null,
              ].filter(Boolean);
              return (
                <div key={r.roomId ?? i} style={{ padding: "3px 0" }}>
                  <div className="ml">
                    <span>
                      <b>Room {r.roomNumber ?? "—"}</b>
                      <span className="meta">
                        {r.roomTypeName ? ` · ${r.roomTypeName}` : ""}
                        {r.nights != null ? ` · ${plural(r.nights, "night")}` : ""}
                        {r.isFoc ? " · free of charge" : ""}
                      </span>
                    </span>
                    <span className="money">{money(r.total, currency)}</span>
                  </div>
                  {bits.length ? <div className="meta">{bits.join(" · ")}</div> : null}
                </div>
              );
            })}
          </div>
          <div className="meta">
            Room, meals and bed are net; each room&apos;s total adds service charge and GST.
            {billing.rooms.some((r) => r.componentsPreDiscount) ? " Parts are before the booking discount; totals after it." : ""}
          </div>
        </>
      ) : null}
      <div style={{ borderTop: "1px solid var(--line)", margin: "8px 0 4px" }} />
      {fo ? (
        <>
          {row(`Billed so far${fo.lineCount ? ` · ${plural(fo.lineCount, "line")}` : ""}`, fo.billedSoFar)}
          {row("Payments received", fo.paymentsReceived)}
          {fo.refunded != null ? row("Refunded", fo.refunded) : null}
          {fo.writtenOff != null ? row("Written off", fo.writtenOff) : null}
          {row("Balance", fo.outstandingBalance, true)}
        </>
      ) : (
        <p className="meta">No folio yet — nothing billed.</p>
      )}
      <p className="meta" style={{ marginTop: 6 }}>
        Every figure comes from the hotel server and follows the folio as bills post.
      </p>
    </div>
  );
}

function PrefStrip({ entry, onDetails }: { entry: EntryDetail; onDetails: () => void }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const current = entry.inquiry?.notes?.trim() ?? "";
  const sealed = entry.status !== "ACTIVE" && entry.status !== "PARKED";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const save = useMutation({
    mutationFn: () => updateInquiryNotes(session!, entry.inquiryId, draft.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["desk-bookings"] });
      toast.success("Preference saved.");
      setEditing(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save the preference"),
  });
  return (
    <div className="pref">
      <Icon name="info" />
      {editing ? (
        <>
          <input
            className="input"
            autoFocus
            style={{ flex: 1, height: 30 }}
            value={draft}
            maxLength={2000}
            placeholder="e.g. high floor, quiet room, honeymoon — allergic to nuts"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save.mutate();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <Button compact state={save.isPending ? "working" : "default"} onClick={() => save.mutate()}>
            Save
          </Button>
          <Button kind="quiet" compact onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          {current ? (
            <span>
              Preference · <b>{current}</b>
            </span>
          ) : (
            <span className="meta">{sealed ? "No preference was recorded" : "No preference recorded yet"}</span>
          )}
          {/* A sealed booking's preference is part of the record (2026-09-18). */}
          {sealed ? null : (
            <Button
              kind="quiet"
              compact
              onClick={() => {
                setDraft(current);
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button kind="secondary" compact onClick={onDetails}>
            Booking details
          </Button>
        </>
      )}
    </div>
  );
}

function SidePanel({
  entry,
  sealed,
  onGo,
  timers,
  events,
  communications,
  tz,
  onHistory,
}: {
  entry: EntryDetail;
  sealed: boolean;
  onGo: (step: number) => void;
  timers: TimerRecordSummary[];
  events: import("@/lib/trace/humanize").TraceEvent[];
  communications: EntryCommunication[];
  tz: string;
  onHistory: () => void;
}) {
  // The housekeeping (H2) and kitchen (H3) handoffs share one clock code; name them apart by
  // the handoff each clock is on, or both read "Housekeeping to accept".
  const handoffTypeById = new Map((entry.handoffs ?? []).map((h) => [h.id, h.handoffType]));
  const labelOf = (t: TimerRecordSummary) => {
    if (t.timerCode === "H2_H3_ACCEPTANCE_W25" && t.entityId) {
      const kind = handoffTypeById.get(t.entityId);
      if (kind === "H3") return "Kitchen to accept";
      if (kind === "H2") return "Housekeeping to accept";
    }
    return timerLabel(t);
  };
  const running = timers
    .filter((t) => t.status === "SCHEDULED")
    .map((t) => ({ t, label: labelOf(t) }))
    .filter((x): x is { t: (typeof timers)[number]; label: string } => !!x.label)
    .sort((a, b) => a.t.firesAt.localeCompare(b.t.firesAt))
    .slice(0, 8);
  const recent = events.filter((e) => !isHousekeeping(e.eventType)).slice(0, 6);
  return (
    <aside className="side">
      <div>
        <h4>Timers</h4>
        <div className="list">
          {running.length ? (
            running.map(({ t, label }) => <SideTimer key={t.id} timer={t} label={label} />)
          ) : (
            <span className="meta">nothing running</span>
          )}
        </div>
      </div>
      <div>
        <h4>Recent</h4>
        <div className="list">
          {recent.length ? (
            recent.map((ev) => (
              <div className="row" key={ev.id}>
                <span className="t">{traceWords(ev)}</span>
                <span className="meta">
                  {fmtStamp(ev.timestamp, tz)} · {whoDid(ev)}
                </span>
              </div>
            ))
          ) : (
            <span className="quiet">nothing yet</span>
          )}
        </div>
        <div className="row-acts" style={{ marginTop: 6 }}>
          <Button kind="quiet" compact onClick={onHistory}>
            See all history
          </Button>
        </div>
      </div>
      <SidePapers entry={entry} communications={communications} tz={tz} sealed={sealed} onGo={onGo} />
    </aside>
  );
}


