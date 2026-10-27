"use client";

/**
 * The booking workspace in the new frame (Surface Spec 03 and its 13–14 Sep amendment).
 *
 * header · rail | canvas | side panel · gate bar with one forward move.
 *
 * The canvas's tabs read left to right (2026-10-12, operator): This step › the step's own tabs
 * (Stay's Night audit, Rooms, …) › Other ways · Booking details › the booking's five tabs —
 * Charges & payments · Guest requests · Notes · Documents · History — the same on every step.
 * What those five hold was taken out of the steps, the side panel and the header, so nothing on
 * the booking shows twice.
 *
 * Every rule the old workspace enforced is kept: the readiness lists, the order of the moves, the
 * two commitment boundaries behind their dialogs, park and resume, the key checklist that survives
 * a refresh. The step canvases are the working tools the desk has always used, rendered inside
 * `.desk-root` and re-dressed by the bridge stylesheet; they are redesigned one by one.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Dialog, EmptyState, Icon } from "@/design-system";
import { StandingChip, bookingHref } from "@/components/ds/ui";
import { tripOf } from "@/components/ds/workspace/return-stay";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { usePageTitle } from "@/hooks/use-page-title";
import { useDeskBookings, useRoomsList } from "@/hooks/use-desk-data";
import {
  getBillingSummary,
  getEntry,
  getEntryTimers,
  getEntryTrace,
  listEntryCommunications,
  parkEntry,
  progressStage,
  switchStay,
  unparkEntry,
  type TimerRecordSummary,
} from "@/lib/api/entries";
import { closeEntryAtS9 } from "@/lib/api/post-stay";
import { useClosureReadiness } from "@/hooks/use-closure-readiness";
import { useRoomInspections } from "@/hooks/use-room-inspections";
import { useUnansweredDamage } from "@/components/ds/steps/damage-card";
import { activatePreArrival } from "@/lib/api/pre-arrival";
import { completeCheckInToS7 } from "@/lib/api/check-in";
import { listIdentityProofs } from "@/lib/api/identity-proofs";
import { ApiError } from "@/lib/api/client";
import { DESK_STEPS, guestName } from "@/lib/desk/model";
import { AlsoBar, FlowChips, FlowTodo, OtherWaysSlot, StepFlow, anchorFor, numberFlow, revealCard, type FlowItem, type StepPane } from "@/components/ds/steps/kit";
import { QuietScreen } from "@/components/ds/help";
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
import { arrivalNightRoomIds, heldRoomIds, roomsInUseFor } from "@/lib/desk/party-rooms";
import { channelWord, endingOf, factsFromEntry, rowNameOf, standingOf } from "@/lib/ds/status";
import { fmtDateTime, fmtDay, fmtRange, money, nightsOf, plural } from "@/lib/ds/format";
import { PHASES, BOUNDARY_STEPS, STEP_NAMES, STEP_NEEDS, stepNoOfStage, type StepNo } from "@/lib/ds/steps";
import { timerLabel } from "@/lib/ds/timers";
import { BackendRailSlotContext } from "@/components/desk/workspace/backend-inline";
import { ReEnterMenu } from "@/components/desk/workspace/re-enter-menu";
import type { EntryDetail } from "@/types/api";
import { CaseCards } from "@/components/ds/steps/case-cards";
import { HeldPapersCard } from "@/components/ds/workspace/held-papers";
import { ActiveRoomMoves } from "@/components/ds/rooms/room-move-dialog";
import { HistoryView } from "@/components/ds/workspace/history-view";
import { DetailsView } from "@/components/ds/workspace/details-view";
import { BOOKING_TABS, ChargesView, DocumentsView, NotesView, RequestsView, type BookingTab } from "@/components/ds/workspace/booking-tabs";
import { listBookingNotes, listGuestRequests } from "@/lib/api/booking-notes";
import { useStayPrice } from "@/lib/ds/stay-price";
import { HeaderClock, HeaderDwell, SideTimer, StepDwell } from "@/components/ds/workspace/side-timer";
import { useCompactOnScroll, useMeasuredVar } from "@/hooks/use-stage-head";
import { FoldingSide, useSideFolded } from "@/components/ds/workspace/side-panel";
import { S1Inquiry } from "@/components/ds/steps/s1-inquiry";
import { InquirySummaryDialog } from "@/components/ds/steps/s1-summary";
import { StepMoved, type StepMovedNote } from "@/components/ds/workspace/step-moved";
import { S2Negotiation } from "@/components/ds/steps/s2-negotiation";
import { S3SetUp, S3_PANES } from "@/components/ds/steps/s3-setup";
import { S4Reserve, S4_PANES } from "@/components/ds/steps/s4-reserve";
import { S5Arrival } from "@/components/ds/steps/s5-arrival";
import { S6CheckIn } from "@/components/ds/steps/s6-checkin";
import { S7Stay, S7_PANES } from "@/components/ds/steps/s7-stay";
import { keysDue, keysDueWords } from "@/components/ds/steps/s7-rooms";
import { S6_PANES } from "@/components/ds/steps/s6-checkin";
import { S8CheckOut, S8_PANES } from "@/components/ds/steps/s8-checkout";
import { S9Closed, S9_PANES } from "@/components/ds/steps/s9-closed";
import { Overlay, atLeast, useRefreshEntry } from "@/components/ds/steps/kit";
import { declineEntry } from "@/lib/api/reservation-setup";
const atLeastFom = (level?: string | null) => atLeast(level, "L2");

// The step tools re-render only when their own props change (the parent lifts several UI flags).

const NOOP = () => {};

type View = "step" | "other" | "details" | BookingTab;

/** Inquiry's five sections, by the cards the readiness list names (Stage 1 since 2026-10-10). */
const INQUIRY_SECTIONS: Record<string, string> = {
  caller: "The caller",
  asking: "Who is asking",
  stay: "The stay",
  house: "The house",
  wrap: "Wrap up",
};

/** The booking file's tabs on the right in the stage-template layout — Booking first. */
// The Stage 1 header's Re-enter and Under the hood buttons, hidden for now (2026-10-27).
const HEAD_TOOLS = false;
const FILE_TABS: ReadonlyArray<readonly ["details" | BookingTab, string]> = [["details", "Booking"], ...BOOKING_TABS];
// What each tab reads as when the file is narrow (2026-10-27, operator: on a smaller screen the
// tabs ran onto two rows). The full name stays on hover.
const FILE_TAB_SHORT: Record<"details" | BookingTab, string> = {
  details: "Booking",
  money: "Charges",
  requests: "Requests",
  notes: "Notes",
  docs: "Papers",
  history: "History",
};


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
  const [sideFolded, setSideFolded] = useSideFolded();

  const entryQuery = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId),
    enabled: !!session && !sessionLoading,
    // A booking is often worked from two screens: re-read it on return and every half minute, so a
    // change made on the other screen (a room move, a new quotation) shows here too (2026-10-13).
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const entry = entryQuery.data ?? null;
  // Another screen moved this booking on (client.ts raises the event on a stale refusal): re-read it.
  useEffect(() => {
    const onStale = () => refreshEntry();
    window.addEventListener("desk:stale-booking", onStale);
    return () => window.removeEventListener("desk:stale-booking", onStale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId]);

  // The list row carries what the entry payload does not: the custodian's name, the booker's name.
  const listRow = useDeskBookings().data?.items.find((r) => r.id === entryId) ?? null;
  // The room registry, to name the rooms a booking holds before Arrival assigns them.
  const roomList = useRoomsList().data?.items;

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
  // The price as it stands — the Negotiation table or the Inquiry picks while nothing is saved, so
  // the header and Charges & payments show what is chosen and follow every change (2026-10-12).
  const stayPrice = useStayPrice(entry, billing);

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
  // Verified at THIS stay — the check-in gate's own reading (2026-09-18).
  const stayIdentityVerified = !!identityProofsQuery.data?.verification;

  // The five tabs say how much is in them (the mockup's counts): open requests, notes and open
  // to-dos — a to-do past its time in red.
  const requestsQuery = useQuery({
    queryKey: ["guest-requests", entryId],
    queryFn: () => listGuestRequests(session!, entryId),
    enabled: !!session && !sessionLoading,
  });
  const notesQuery = useQuery({
    queryKey: ["booking-notes", entryId],
    queryFn: () => listBookingNotes(session!, entryId),
    enabled: !!session && !sessionLoading,
    refetchInterval: 60_000,
  });

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
  // Each room's inspection at Check-out (2026-10-26 — one inspection per room).
  const inspections = useRoomInspections(entry, entry?.currentStage === "S8").data ?? null;
  const damage = useUnansweredDamage(entry, entry?.currentStage === "S8");

  const parked = entry?.status === "PARKED";
  const parkTimer = findParkTimer(timersQuery.data?.items);

  // The step being looked at lives in the address (?step=N), so a link can open a booking at the
  // step that needs attention and Back returns to it.
  const stepParam = Number(params.get("step"));
  const viewParam = params.get("view");
  const VIEWS: readonly View[] = ["other", "details", "money", "requests", "notes", "docs", "history"];
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : "step";
  // History opens on a lens when another tab sends the desk there (Charges & payments → its log).
  const lensParam = params.get("lens");
  const [selected, setSelectedState] = useState<number | null>(stepParam >= 1 && stepParam <= 9 ? stepParam : null);
  const setView = (v: View, step?: number, lens?: string) => {
    const p = new URLSearchParams(params.toString());
    if (v === "step") p.delete("view");
    else p.set("view", v);
    if (lens) p.set("lens", lens);
    else p.delete("lens");
    if (step) p.set("step", String(step));
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  // A step's own pane — Stay's Night audit, Room change, … (2026-09-25). Null is This step.
  const paneParam = params.get("pane");
  const setPane = (key: string | null) => {
    const p = new URLSearchParams(params.toString());
    p.delete("view");
    if (key) p.set("pane", key);
    else p.delete("pane");
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
  // The booking header stays put under the topbar (2026-09-29, operator: "so they know which
  // guest they are working on"). The sticky columns and the sticky house card sit below it, so
  // its height — the facts line wraps — is measured onto the workspace as `--ws-head-h` and the
  // stylesheet offsets them by it. A callback ref, since the header mounts after the loading state.
  const headObserver = useRef<ResizeObserver | null>(null);
  const headRef = useCallback((head: HTMLDivElement | null) => {
    headObserver.current?.disconnect();
    headObserver.current = null;
    if (!head) return;
    const ws = head.closest<HTMLElement>(".ws");
    if (!ws) return;
    const apply = () => ws.style.setProperty("--ws-head-h", `${head.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(head);
    headObserver.current = ro;
  }, []);
  // The Stage 1 layout's bar, measured like the head, and its compact head once scrolled (2026-10-27).
  const barRef = useMeasuredVar("--ws-bar-h");
  const compactHead = useCompactOnScroll();
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  // Where the step's "other ways" render — the tab beside This step (2026-09-25).
  const [otherSlot, setOtherSlot] = useState<HTMLElement | null>(null);
  // Stage 1's fixed bar (2026-10-27): where its other ways' buttons and their open form render.
  const [alsoButtons, setAlsoButtons] = useState<HTMLElement | null>(null);
  const [alsoPanel, setAlsoPanel] = useState<HTMLElement | null>(null);

  /* ---- the per-room key checklist (survives a refresh until check-in stamps it) ---- */
  const [reserveExtras, setReserveExtras] = useState<string[]>([]);
  const reportReserveExtras = useMemo(
    () => (items: string[]) => setReserveExtras((prev) => (prev.join("|") === items.join("|") ? prev : items)),
    [],
  );
  /** Negotiation's own open items — the table's changes not priced yet (2026-10-19). */
  const [negotiationExtras, setNegotiationExtras] = useState<string[]>([]);
  const reportNegotiationExtras = useMemo(
    () => (items: string[]) => setNegotiationExtras((prev) => (prev.join("|") === items.join("|") ? prev : items)),
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
    // A refusal closes the dialog (2026-09-18): it stayed open over the page, hiding the very
    // control the refusal points to (Acknowledge an overlap…, the missing line to fix).
    onError: (e) => {
      setConfirmOpen(false);
      fail("Reserving failed")(e);
    },
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
  /** The look back before Negotiation (2026-10-22): Continue opens it, its Confirm moves the booking. */
  const [summaryOpen, setSummaryOpen] = useState(false);
  /** A move said in the middle of the screen (2026-10-27) — the Inquiry's move to Negotiation. */
  const [moved, setMoved] = useState<StepMovedNote | null>(null);
  const closeMoved = useCallback(() => setMoved(null), []);
  const advanceMutation = useMutation({
    mutationFn: (vars: { targetStage: string; guestPhysicallyPresent?: boolean; announce?: boolean }) =>
      progressStage(session!, entry!.id, { targetStage: vars.targetStage, version: entry!.version, guestPhysicallyPresent: vars.guestPhysicallyPresent }),
    onSuccess: (updated, vars) => {
      afterMove(updated);
      const n = currentStepOrder(updated);
      setSelected(n);
      // A move announced in the middle of the screen needs no toast as well.
      if (!vars.announce) toast.success(`Moved to ${STEP_NAMES[n - 1]}.`);
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
    // A reason passed in is the inline form's (Negotiation's Other ways); the dialog's is in state.
    mutationFn: (reason?: string) => parkEntry(session!, entry!.id, (reason ?? parkReason).trim()),
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
  /**
   * The guest said no (2026-10-01). Offered at Inquiry and Negotiation only — from Set up the
   * booking carries money and the priced cancellation is the way out. The dialog lives here
   * rather than in each step so the two canvases cannot word the same act differently.
   */
  const declineMutation = useMutation({
    mutationFn: (reason: string) => declineEntry(session!, entry!.id, reason),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["entry", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry!.id] });
      void queryClient.invalidateQueries({ queryKey: ["desk-bookings"] });
      toast.success(
        res.roomsReleased > 0
          ? `Turned down — ${plural(res.roomsReleased, "room")} back on the board.`
          : "Turned down — the record says why.",
      );
    },
    onError: fail("Couldn't turn this booking down"),
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

  // Every step view starts at the top. A booking tab does too on the rail layout, where it replaces
  // the canvas — but not on the Stage 1 layout, where it opens in the booking file BESIDE the work
  // (and the bar's other ways open above the bar): there the page stays exactly where it is
  // (2026-10-27, operator: "the working screen was scrolled down, and when I clicked Charges &
  // payments in the booking file, the working screen scrolled").
  const viewing = selected ?? currentOrder;
  const lastPlace = useRef({ viewing, view });
  useEffect(() => {
    const prev = lastPlace.current;
    lastPlace.current = { viewing, view };
    if (prev.viewing === viewing && viewing === 1) return;
    window.scrollTo({ top: 0 });
  }, [viewing, view]);

  const fin = useMemo(() => (entry ? deriveFinancials(entry, { paymentStatus: paymentStatusQuery.data }) : null), [entry, paymentStatusQuery.data]);
  const guestNamed = entry ? guestName(entry.guestProfile ?? entry.inquiry?.guestProfile ?? null) : null;
  // Until the guest staying is named (Wrap up, 2026-10-12) the booking goes by its caller.
  const name = entry ? (guestNamed !== "Guest" ? guestNamed : rowNameOf({ guestProfile: null, inquiry: entry.inquiry ?? null })) : null;
  const nameIsGuest = guestNamed !== null && guestNamed !== "Guest";
  usePageTitle(entry ? (name ?? entry.id) : null);

  /**
   * The other stays of this trip (2026-10-06, operator: "the user has to constantly switch between
   * stays, and it keeps asking if I want to park or not while switching — can it not ask that,
   * maybe from the backend it can park it on its own"). A link to one of them is not leaving the
   * enquiry, so it does not ask: `POST /entries/:id/switch-stay` parks this stay when it sits at
   * Inquiry or Negotiation ("Switching stays to make configurations") and resumes the other when a
   * switch parked it. A park somebody made on purpose is never undone by a switch.
   */
  const tripKey = (entry?.inquiry?.entries ?? [])
    .map((s) => s.id)
    .filter((id) => id !== entryId)
    .join(",");
  const tripSiblingOf = (href: string): string | null => {
    const m = /^\/bookings\/([^/?#]+)/.exec(href);
    return m && tripKey.split(",").includes(m[1]) ? m[1] : null;
  };
  const switchingRef = useRef(false);
  useEffect(() => {
    if (!session || !tripKey) return;
    const siblings = tripKey.split(",");
    const onTripClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest?.("a[href^='/']") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank") return;
      const href = a.getAttribute("href") ?? "";
      const m = /^\/bookings\/([^/?#]+)/.exec(href);
      const to = m && siblings.includes(m[1]) ? m[1] : null;
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      if (switchingRef.current) return;
      switchingRef.current = true;
      void (async () => {
        try {
          const out = await switchStay(session, entryId, to);
          const said = [
            out.parked ? `${entryId} parked while you work on ${to}` : null,
            out.resumed ? `${to} resumed` : null,
          ].filter(Boolean);
          if (said.length) toast.success(said.join(" · "));
          if (out.parkRefused) toast.warning(`${entryId} was left as it was — ${out.parkRefused}`);
          if (out.resumeRefused) toast.warning(`${to} stays parked — ${out.resumeRefused}`);
          for (const id of [entryId, to]) {
            for (const k of [["entry", id], ["entry-timers", id], ["entry-trace", id]]) void queryClient.invalidateQueries({ queryKey: k });
          }
          void queryClient.invalidateQueries({ queryKey: ["desk-bookings"] });
        } catch (err) {
          toast.error(`Moved to ${to}, but ${entryId} could not be parked — ${err instanceof Error ? err.message : "try parking it by hand"}`);
        } finally {
          switchingRef.current = false;
          router.push(href);
        }
      })();
    };
    document.addEventListener("click", onTripClick, true);
    return () => document.removeEventListener("click", onTripClick, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, entryId, tripKey]);

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
      if (href.startsWith(bookingHref(entryId)) || href.startsWith("/api/")) return;
      // another stay of this trip — the switch handles it, with no question
      if (tripSiblingOf(href)) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parkPromptable, entryId, tripKey]);

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
  /** A parked lead may be turned down too — the guest ringing back to decline is what a park waits for. */
  const declinable =
    !sealed && (entry.status === "ACTIVE" || entry.status === "PARKED") && (entry.currentStage === "S1" || entry.currentStage === "S2");
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
  const canCheckIn = s6Readiness(entry, { guestDetails: guestDetailsCoverage, identityVerified: stayIdentityVerified }).every((c) => c.met) && registrationConfirmed && keysValid;

  const segStart = (entry.segments ?? [])[0]?.startedAt ?? null;
  const voucherAnswerRecorded = (communications ?? []).some(
    (c) =>
      c.commType === "CONFIRMATION_VOUCHER" &&
      c.direction === "OUTBOUND" &&
      c.sendStatus === "DISPATCHED" &&
      c.inForce !== false &&
      c.acknowledgementStatus === "RECEIVED" &&
      (!segStart || (c.createdAt ?? "") >= segStart),
  );

  const ready = readyToConfirm && reserveExtras.length === 0;
  // A no-show says so — the imported ones sit EXPIRED at the end, and read "Expired" (2026-09-18).
  // Since 2026-10-01 the ending itself is on the row, so this reads the same words the lists do
  // (the stage could not say: the cancellation routes wipe it to TERMINAL), and adds what the
  // operator said, which only the record has room for.
  const ending = endingOf(entry.closedAs);
  const endedSaid = (entry.closedReason ?? "").trim();
  const sealedOutcome = ending
    ? `${ending.word}${ending.qualifier ? ` — ${ending.qualifier}` : ""}${endedSaid ? `: “${endedSaid}”` : ""} — a read-only record`
    : entry.status === "CANCELLED"
      ? "Cancelled — a read-only record"
      : entry.folio?.state === "NO_SHOW_CLOSED"
        ? entry.status === "CLOSED"
          ? "A no-show, closed and sealed — a read-only record"
          : "A no-show — a read-only record"
        : entry.status === "EXPIRED" || entry.currentStage === "TERMINAL"
          ? `${entry.currentStage === "S2" ? "The negotiation lapsed" : entry.currentStage === "S1" ? "The inquiry lapsed" : "Expired"} — a read-only record`
          : "Closed and sealed — a read-only record";
  // An ending without a stay is said in red, on the step and in the bar (2026-10-27, operator: "if it
  // is lapsed it should show in red or prominent way"). A booking closed after its stay stays quiet,
  // and so does one folded into the guest's other booking.
  const endedEarly =
    (entry.status === "CANCELLED" || entry.status === "EXPIRED" || entry.folio?.state === "NO_SHOW_CLOSED") && entry.closedAs !== "COMBINED";
  const sealedHead = sealedOutcome.replace(/ — a read-only record$/, "");
  const sealedNotice = endedEarly ? (
    <div className="notice ended" role="status">
      <span className="ended-mark" aria-hidden="true">
        !
      </span>
      <span>
        <b>{sealedHead}</b>
        <span className="rest">
          {entry.closedAt ? ` · ${fmtDateTime(entry.closedAt, clock.tz)}` : ""} · a read-only record — nothing on it can be changed
        </span>
      </span>
    </div>
  ) : (
    <div className="notice inert">
      <span className="sm">{sealedOutcome}</span>
    </div>
  );

  const preconds0: Precondition[] = sealed
    ? []
    : confirmStepActive || setupStepActive
      ? [
          ...confirmReadiness(entry, { paymentSatisfied, totalReceived, requiredAmount, communications }),
          ...(confirmStepActive ? reserveExtras.map((label) => ({ label, met: false })) : []),
        ]
      : inquiryStepActive
        ? s1Readiness(entry)
        : quoteStepActive
          ? [...s2Readiness(entry), ...negotiationExtras.map((label) => ({ label, met: false, card: "quote" }))]
          : arrivalStepActive
            ? s5Readiness(entry, hotelToday, { guestPresent })
            : checkInStepActive
              ? s6Readiness(entry, {
                  guestDetails: guestDetailsCoverage,
                  identityVerified: stayIdentityVerified,
                  registrationConfirmed,
                  keys: {
                    label:
                      checkInRoomIds.length > 1 || moveDayRoomCount > 0
                        ? `Every arrival-night key marked (${issuedKeyCount} of ${checkInRoomIds.length})${moveDayRoomCount > 0 ? ` · ${moveDayRoomCount} on the move day` : ""}`
                        : "Room key marked",
                    met: keysValid,
                  },
                })
              : stayStepActive
                ? [...s7Readiness(entry, hotelToday), { label: "Night audit complete", met: nightAuditOk, card: "nights" }]
                : checkOutStepActive
                  ? s8Readiness(entry, { inspections, damage })
                  : closedStepActive
                    ? closure
                      ? [...closure.checks.map((c) => ({ label: c.label, met: c.met })), { label: "Sealing needs the FOM", met: atLeastFom(session?.actorLevel) }]
                      : [{ label: "Checking what is left before the close…", met: false }]
                    : confirmedS4Active
                      ? [{ label: "The guest's answer to the confirmation voucher recorded", met: voucherAnswerRecorded }]
                      : viewing < currentOrder
                        ? []
                        : preconditionsFor(entry, step, hotelToday);
  // Reserve shows Set up's checklist, but Set up's cards are not on this page — so the items are
  // listed plainly there rather than numbered onto sections that cannot be scrolled to.
  const preconds: Precondition[] = confirmStepActive ? preconds0.map((p) => ({ label: p.label, met: p.met })) : preconds0;
  const unmet = preconds.filter((p) => !p.met).length;
  // The step's numbered to-do: the items that have a section on this page, in the order they are
  // done. The rail prints it, and each card takes its own number from it (2026-09-25).
  // Stage 1 is laid out as five numbered sections (2026-10-10), so it numbers by section.
  const flowItems: FlowItem[] = numberFlow(preconds, { bySection: inquiryStepActive });
  const inherited = preconds.filter((p) => !p.card);
  const nextUp = flowItems.find((i) => !i.met) ?? null;
  // Stage 1 in the stage-template layout (2026-10-27, operator: "do the changes for stage one only
  // and we'll see"): the clocks in the header, the journey and the step's sections as lines under
  // it, the step always on the left, the booking file — Booking · Charges & payments · Guest
  // requests · Notes · Documents · History — always on the right, and the step's other ways in
  // the fixed bar at the foot. The other steps keep the rail, the tabs and the side panel.
  const topLayout = viewing === 1;
  const goToCard = (card?: string) => {
    if (!card) return;
    // The card may live in one of the step's panes: open that pane first, then scroll once the
    // card is actually on screen (the pane arrives with the next render). In the stage-template
    // layout the step is always on screen, so the file on the right keeps its tab.
    const owner = panes.find((p) => p.cards.includes(card))?.key ?? null;
    if (!topLayout && (view !== "step" || owner !== pane)) {
      if (owner !== pane) setPane(owner);
      else setView("step", viewing);
    }
    let tries = 0;
    const attempt = () => {
      const el = document.getElementById(anchorFor(card));
      if (!el || el.closest("[hidden]")) {
        if (tries++ < 20) window.setTimeout(attempt, 60);
        return;
      }
      revealCard(el);
    };
    window.requestAnimationFrame(attempt);
  };

  const viewingPast = (viewing < currentOrder || (sealed && step.key !== "closed")) && !confirmStepActive;
  // The panes this step declares — Stay's Night audit, Room change, … — and which one is open.
  // Check-in gained a Rooms tab of its own (2026-10-06) — the rooms moved out of the Room card.
  // The Closed step keeps its tail open on a sealed booking (a payment, a late charge, a tax
  // invoice), so its tabs show on a CLOSED record too — never on a cancelled or expired one.
  const panes: StepPane[] = (() => {
    if (viewingPast) return [];
    if (step.key === "closed") return entry.folio && entry.status !== "CANCELLED" && entry.status !== "EXPIRED" ? S9_PANES : [];
    if (sealed) return [];
    if (step.key === "stay") return S7_PANES;
    if (step.key === "checkin") return S6_PANES;
    if (step.key === "setup") return S3_PANES;
    if (step.key === "confirm") return S4_PANES;
    if (step.key === "checkout") return S8_PANES;
    return [];
  })();
  const pane = panes.some((p) => p.key === paneParam) ? paneParam : null;
  // The keys owed today on a move day — counted on Stay's Keys tab (2026-10-26).
  const keysOwedNow = step.key === "stay" && !viewingPast ? keysDue(entry, hotelToday) : { collect: [], handOver: [] };
  const keysOwedCount = keysOwedNow.collect.length + keysOwedNow.handOver.length;
  const keysOwed = keysDueWords(keysOwedNow);

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
      <Button className="go" state={ok ? "default" : "inert"} reason={ok ? undefined : firstNote} onClick={() => setSummaryOpen(true)}>
        Continue
      </Button>
    );
  } else if (quoteStepActive) {
    const ok = canProgressS2(entry) && negotiationExtras.length === 0;
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
    const ok = canProgressS5(entry, guestPresent, hotelToday);
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
    const ok = canProgressS8(entry, { inspections, damage });
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
  /** Park and turn down from Other ways' own tabs, the reason typed there (2026-10-17). */
  const parkNow = (reason: string) => parkMutation.mutate(reason);
  const declineNow = (reason: string) => declineMutation.mutate(reason);
  /** Each step is drawn by its own canvas (components/ds/steps). */
  const nativeBody = (): ReactNode | null => {
    switch (step.key) {
      case "inquiry":
        return (
          <S1Inquiry
            entry={entry}
            past={viewingPast}
            parkNow={parkable ? parkNow : undefined}
            parking={parkMutation.isPending}
            declineNow={declinable ? declineNow : undefined}
            declining={declineMutation.isPending}
          />
        );
      case "quote":
        return (
          <S2Negotiation
            entry={entry}
            past={viewingPast}
            parkNow={parkable ? parkNow : undefined}
            parking={parkMutation.isPending}
            declineNow={declinable ? declineNow : undefined}
            declining={declineMutation.isPending}
            onOpenItems={quoteStepActive ? reportNegotiationExtras : undefined}
          />
        );
      case "setup":
        return (
          <S3SetUp
            entry={entry}
            past={viewingPast}
            parkNow={parkable ? parkNow : undefined}
            parking={parkMutation.isPending}
            goToStep={viewingPast ? NOOP : stableSetSelected}
            pane={pane}
          />
        );
      case "confirm":
        return (
          <S4Reserve
            entry={entry}
            past={viewingPast}
            parkNow={parkable ? parkNow : undefined}
            parking={parkMutation.isPending}
            goToStep={gotoStep}
            reserve={confirmStepActive ? { onClick: () => setConfirmOpen(true), ready, reason: ready ? undefined : firstNote } : null}
            onOpenItems={confirmStepActive ? reportReserveExtras : undefined}
            pane={pane}
          />
        );
      case "arrival":
        return (
          <S5Arrival
            entry={entry}
            past={viewingPast}
            parkNow={parkable ? parkNow : undefined}
            parking={parkMutation.isPending}
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
            pane={pane}
            openPane={setPane}
          />
        );
      case "stay":
        return (
          <S7Stay
            entry={entry}
            past={viewingPast}
            setNightAuditOk={stayStepActive ? setNightAuditOk : NOOP}
            goToStep={viewingPast ? NOOP : stableSetSelected}
            pane={pane}
            openPane={setPane}
          />
        );
      case "checkout":
        return (
          <S8CheckOut
            entry={entry}
            past={viewingPast}
            goToStep={viewingPast ? NOOP : stableSetSelected}
            pane={pane}
            openPane={setPane}
          />
        );
      case "closed": {
        const canClose = !!closure?.canClose && atLeastFom(session?.actorLevel);
        const closeReason = canClose ? undefined : !atLeastFom(session?.actorLevel) ? "closing needs the FOM" : firstNote;
        return (
          <S9Closed
            entry={entry}
            past={viewingPast}
            close={closedStepActive ? { onClick: () => setCloseOpen(true), ready: canClose, reason: closeReason } : null}
            pane={pane}
            openPane={setPane}
          />
        );
      }
      default:
        return null;
    }
  };
  const native = nativeBody();

  /* ---- the five tabs' counts ---- */
  const tabCount = (k: BookingTab): ReactNode => {
    if (k === "requests") {
      const open = requestsQuery.data?.counts.open ?? 0;
      return open ? <span className="tab-n warn">{open}</span> : null;
    }
    if (k === "notes") {
      const c = notesQuery.data?.counts;
      if (!c) return null;
      const n = c.notes + c.openTodos;
      return (
        <>
          {n ? <span className="tab-n">{n}</span> : null}
          {c.overdueTodos ? <span className="tab-n stop">{c.overdueTodos} late</span> : null}
        </>
      );
    }
    if (k === "docs") {
      const n = (entry.quotations ?? []).length + (entry.folio?.invoices ?? []).length + (entry.reservation ? 1 : 0);
      return n ? <span className="tab-n">{n}</span> : null;
    }
    return null;
  };

  /* ---- the header ---- */
  const standing = standingOf(
    factsFromEntry(entry, billing?.folio?.outstandingBalance ?? null, listRow ? bookerName(listRow) : null, hotelToday),
    hotelToday,
  );
  const co = entry.actualCheckOutDate ?? entry.checkOutDate;
  const nights = nightsOf(entry.checkInDate, co);
  // The trip: this enquiry's other stays, when the guest left and came back (2026-09-25).
  const trip = tripOf(entry);
  // The rooms the guest is in NOW — a room left behind by a mid-stay move is not one of them.
  const roomNumbers = Array.from(
    new Set(
      roomsInUseFor(entry, hotelToday)
        .map((a) => a.room?.roomNumber)
        .filter((x): x is string => !!x),
    ),
  ).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  // Before Arrival assigns them, the rooms the booking holds are named from its newest pick — a
  // room move re-seals it, so the header follows the move (2026-10-13).
  // "held" only when something holds them — a committed hold or a live provisional block
  // (2026-10-19, operator: a booking whose rooms another guest reserved first read "206 · held").
  // An UPGRADED block holds nothing of its own: its claim passed to the committed hold.
  const roomsActuallyHeld =
    entry.committedHold?.state === "PLACED" ||
    entry.committedHold?.state === "CONFIRMED" ||
    (entry.speculativeHolds ?? []).some((h) => h.state === "PLACED");
  const heldRoomNumbers = roomNumbers.length
    ? []
    : heldRoomIds(entry)
        .map((id) => roomList?.find((r) => r.id === id)?.roomNumber)
        .filter((x): x is string => !!x)
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const cur = billing?.currency ?? fin.currency;
  const totalKind =
    billing?.headline.kind === "BILLED_SO_FAR"
      ? "billed so far"
      : billing?.stayTotal?.earlyDeparture
        ? "shortened stay"
        : billing?.headline.frozen
          ? "as confirmed"
          : "indicative";
  const fromScreen = stayPrice.source === "TABLE" || stayPrice.source === "PICKS";
  const headline = fromScreen ? stayPrice.amount : billing ? billing.headline.amount : fin.frozen ? null : fin.indicativeTotal;
  const booker = listRow ? bookerName(listRow) : null;

  const headInner = (
    <>
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
              <h2 className={nameIsGuest ? undefined : "name-i"}>{name}</h2>
              <StandingChip standing={standing} />
              {entry.guestProfile?.vipTier ? (
                <Chip tone="accent" tier>
                  VIP
                </Chip>
              ) : null}
              {entry.groupBillingMode === "GROUP_MASTER" ? <Chip>Group</Chip> : null}
            </div>
            <div className="facts">
              <span>
                {entry.id}
                {trip.stays.length > 1 ? ` · stay ${trip.position} of ${trip.stays.length}` : ""}
              </span>
              <span>
                Enquiry <b>{entry.inquiry?.id ?? "—"}</b>
              </span>
              {trip.others.length ? (
                <span>
                  Also this trip{" "}
                  {trip.others.slice(0, 2).map((s, i) => (
                    <span key={s.id}>
                      {i ? ", " : ""}
                      <Link href={bookingHref(s.id)}>{fmtRange(s.checkInDate, s.checkOutDate)}</Link>
                    </span>
                  ))}
                  {trip.others.length > 2 ? ` and ${trip.others.length - 2} more` : ""}
                </span>
              ) : null}
              <span>
                <b>{fmtRange(entry.checkInDate, co)}</b>
                {nights ? ` · ${plural(nights, "night")}` : ""}
              </span>
              <span>
                Rooms <b>{roomNumbers.length || entry.numberOfRooms || "—"}</b>
                {roomNumbers.length
                  ? ` · ${roomNumbers.join(", ")}`
                  : heldRoomNumbers.length
                    ? ` · ${heldRoomNumbers.join(", ")} · ${roomsActuallyHeld ? "held" : "picked, not held"}`
                    : " · not yet assigned"}
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
          <div className="total">
            {/* The figure opens Charges & payments (2026-10-12) — the breakdown lives there now. */}
            <button
              type="button"
              className="figure money"
              aria-pressed={view === "money"}
              onClick={() => {
                void billingQuery.refetch();
                setView(view === "money" ? "step" : "money", viewing);
              }}
            >
              {money(headline, cur)}
            </button>
            <div className={`kind${fromScreen && stayPrice.unsaved ? " warn-ink" : ""}`}>
              {fromScreen
                ? stayPrice.source === "PICKS"
                  ? `rooms only · ${stayPrice.unsaved ? "picked, not saved" : "indicative"}`
                  : stayPrice.unsaved
                    ? "on the table · not saved"
                    : "on the table · indicative"
                : totalKind}{" "}
              · charges &amp; payments
            </div>
          </div>
    </>
  );
  const gateStatus = (
    <>
          {parked ? (
            <div className="sm ink-2">
              Parked · <b>Resume to continue</b>
            </div>
          ) : sealed ? (
            endedEarly ? (
              <div className="sm stop-ink">
                <b>{sealedHead}</b> — a read-only record
              </div>
            ) : (
              <div className="sm ink-2">{sealedOutcome}</div>
            )
          ) : preconds.length ? (
            // The full list lives in the side panel, numbered (2026-09-25) — the bar says what is
            // next and takes you to it, so the move and the reason for waiting sit together.
            <div className="gate">
              {nextUp ? (
                <button type="button" className="item unmet" onClick={() => goToCard(nextUp.card)}>
                  <Icon name="circle" />
                  <span>
                    Next · <b>{nextUp.n}</b> {nextUp.label}
                  </span>
                </button>
              ) : unmet > 0 ? (
                <div className="item unmet">
                  <Icon name="circle" />
                  <span>{preconds.find((p) => !p.met)?.label}</span>
                </div>
              ) : (
                <div className="item met">
                  <Icon name="check" />
                  <span>everything this step needs is done</span>
                </div>
              )}
            </div>
          ) : viewing < currentOrder ? (
            <span className="meta">a step already passed · the booking is at {STEP_NAMES[currentOrder - 1]}</span>
          ) : (
            <span />
          )}
    </>
  );
  const dialogs = (
    <>
        <StepMoved note={moved} onClose={closeMoved} />

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
        <InquirySummaryDialog
          entry={entry}
          open={summaryOpen && inquiryStepActive}
          busy={advanceMutation.isPending}
          onClose={() => setSummaryOpen(false)}
          onConfirm={() =>
            advanceMutation.mutate(
              { targetStage: "S2", announce: true },
              {
                onSuccess: () => {
                  setSummaryOpen(false);
                  setMoved({
                    title: "The inquiry is made",
                    from: "Inquiry",
                    to: "Negotiation",
                    who: [name, entry.id].filter(Boolean).join(" · "),
                    next: "Next: set who sleeps where, price the rooms and send the quotation.",
                  });
                },
              },
            )
          }
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
          <Overlay>
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
                      onClick={() => parkMutation.mutate(undefined)}
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
          </Overlay>
        ) : null}
    </>
  );

  if (topLayout) {
    const headerClocks = runningClocks(entry, timersQuery.data?.items ?? [], (paymentStatusQuery.data?.paymentPlan?.plan ?? "FULL") !== "FULL");
    const dwell = entry.stageDwellRecords?.[0];
    const fileTab: "details" | BookingTab = view === "step" || view === "other" ? "details" : view;
    const sectionsLeft = flowItems.filter((i) => !i.met).length;
    return (
      <BackendRailSlotContext.Provider value={railSlot}>
        <StepFlow items={flowItems} on={!viewingPast && !sealed} fold={inquiryStepActive ? "done" : null}>
          <div className="ws ws-top theme-blue">
            {/* The header, the journey and the step's sections stay put under the topbar; their
                height is measured onto --ws-head-h so the file on the right sticks below them. */}
            <div className={`ws-topstick${compactHead ? " compact" : ""}`} ref={headRef}>
              <div className={`ws-head${endedEarly ? " ended" : ""}`}>
                {headInner}
                <div className="hrow">
                  <div className="hclocks">
                    {headerClocks.length ? (
                      headerClocks.map(({ t, label }) => <HeaderClock key={t.id} timer={t} label={label} />)
                    ) : (
                      <span className="meta">No clock running</span>
                    )}
                    {dwell && !sealed ? <HeaderDwell since={dwell.enteredAt} /> : null}
                  </div>
                  <div className="hacts">
                    {parked ? (
                      <Button kind="secondary" state={unparkMutation.isPending ? "working" : "default"} workingLabel="Resuming…" onClick={() => unparkMutation.mutate()}>
                        Resume
                      </Button>
                    ) : null}
                    {parked && parkTimer ? <span className="meta">parked · expires {fmtDateTime(parkTimer.firesAt, clock.tz)}</span> : null}
                    {/* Hidden for now (2026-10-27, operator: "hide these buttons, I don't think we need it
                        anyway") — Re-enter and Under the hood; flip HEAD_TOOLS to bring them back. */}
                    {HEAD_TOOLS ? (
                      <>
                        <span className="desk-root">
                          <ReEnterMenu entry={entry} />
                        </span>
                        <Button kind="quiet" compact onClick={() => router.push(`${bookingHref(entry.id)}/backend`)}>
                          Under the hood
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <nav className="journey" aria-label="Journey">
                {PHASES.map(([phase, steps]) => (
                  <Fragment key={phase}>
                    <span className="jgrp">{phase}</span>
                    {steps.map((n) => {
                      const reach = n <= atStep || n <= maxReach;
                      // An ending without a stay does not tick Closed: it reads red, with its lock.
                      const stopped = n === 9 && sealed && endedEarly;
                      const done = !stopped && (n < currentOrder || (n === 9 && sealed));
                      const cls = ["jst", done ? "done" : "", stopped ? "stopped" : "", n === viewing ? "cur" : "", reach ? "" : "later", BOUNDARY_STEPS.has(n) ? "boundary" : ""]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <a
                          key={n}
                          className={cls}
                          href={`${bookingHref(entry.id)}?step=${n}`}
                          aria-current={n === viewing ? "step" : undefined}
                          aria-disabled={reach ? undefined : true}
                          title={stopped ? sealedHead : reach ? (BOUNDARY_STEPS.has(n) ? "Cannot be undone once passed" : undefined) : "Comes later"}
                          onClick={(e) => {
                            e.preventDefault();
                            if (reach) gotoStep(n);
                          }}
                        >
                          <span className="n">{done ? <Icon name="check" /> : stopped ? <Icon name="lock" /> : n}</span>
                          {STEP_NAMES[n - 1]}
                        </a>
                      );
                    })}
                  </Fragment>
                ))}
              </nav>
              <div className="stagebar">
                <h3>
                  {viewing} · {STEP_NAMES[viewing - 1]}
                </h3>
                <span className="verb">{STEP_NEEDS[viewing as StepNo]}</span>
                {viewingPast || sealed ? null : <FlowChips names={INQUIRY_SECTIONS} onGo={goToCard} />}
              </div>
            </div>

            <div className="ws-split">
              <div className="canvas">
                {entry.earlyDeparture ? (
                  <div className="notice inert">
                    <span className="sm">
                      <b>Left early on {fmtDay(entry.earlyDeparture.departureDate)}</b>
                    </span>
                  </div>
                ) : null}
                <QuietScreen>
                  {viewingPast ? (
                    sealed ? (
                      sealedNotice
                    ) : (
                      <div className="notice inert">
                        <span className="sm">
                          {`This step was passed on the way to ${STEP_NAMES[currentOrder - 1]} — what it shows is what was decided then; nothing here can be changed. To change it, work from the step the booking is at now.`}
                        </span>
                      </div>
                    )
                  ) : null}
                  {!sealed ? <ActiveRoomMoves entryId={entry.id} tz={clock.tz} /> : null}
                  {!sealed ? <HeldPapersCard entryId={entry.id} tz={clock.tz} /> : null}
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
                  {!viewingPast && !sealed ? <div className="todo-h">To do now</div> : null}
                  <AlsoBar buttons={alsoButtons} panel={alsoPanel}>
                    <OtherWaysSlot node={null}>{native}</OtherWaysSlot>
                  </AlsoBar>
                  {!viewingPast && !sealed && preconds.length ? (
                    // What the move checks, in one place (the stage template's "Before you move on"):
                    // each section, then what the system does when the booking moves on. The move
                    // itself is in the bar at the foot.
                    <div className="card before-move">
                      <h4>Before you move on</h4>
                      <table className="compact">
                        <tbody>
                          {Object.entries(INQUIRY_SECTIONS).map(([card, title]) => {
                            const own = flowItems.filter((i) => i.card === card);
                            if (!own.length) return null;
                            const met = own.every((i) => i.met);
                            return (
                              <tr key={card} className="pick" onClick={() => goToCard(card)}>
                                <td className={met ? "ok-ink" : "warn-ink"}>{met ? <Icon name="check" /> : "●"}</td>
                                <td>{title}</td>
                                <td className="meta">{met ? "done" : own.filter((i) => !i.met).map((i) => i.label).join(" · ")}</td>
                              </tr>
                            );
                          })}
                          {inherited.map((p) => (
                            <tr key={p.label}>
                              <td className={p.met ? "ok-ink" : "warn-ink"}>{p.met ? <Icon name="check" /> : "→"}</td>
                              <td colSpan={2} className="meta">
                                {p.label}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className={`before-move-foot ${sectionsLeft ? "wait" : "ready"}`}>
                        {sectionsLeft
                          ? `${plural(sectionsLeft, "thing")} still to do`
                          : `${STEP_NAMES[viewing - 1]} is done · next: ${STEP_NAMES[viewing] ?? ""}`}
                      </div>
                    </div>
                  ) : null}
                </QuietScreen>
                {/* the old side column's "what runs here" target — kept mounted, not shown */}
                <div ref={setRailSlot} hidden />
              </div>

              <aside className="file" aria-label="Booking file">
                <div className="ftitle">Booking file · the record</div>
                <div className="ftabs" role="tablist">
                  {FILE_TABS.map(([k, label]) => (
                    <button key={k} type="button" role="tab" className="ftab" title={label} aria-selected={fileTab === k} onClick={() => setView(k, viewing)}>
                      <span className="ft-long">{label}</span>
                      <span className="ft-short">{FILE_TAB_SHORT[k]}</span>
                      {k === "details" ? null : tabCount(k)}
                    </button>
                  ))}
                </div>
                <div className="fbody">
                  {fileTab === "details" ? (
                    <DetailsView
                      entry={entry}
                      booker={booker}
                      custodian={listRow?.custodianName ?? null}
                      onEdit={entry.currentStage === "S1" && !sealed ? () => setSelected(1) : null}
                    />
                  ) : fileTab === "money" ? (
                    <ChargesView entry={entry} billing={billing ?? null} tz={clock.tz} onPaymentHistory={() => setView("history", viewing, "money")} />
                  ) : fileTab === "requests" ? (
                    <RequestsView entry={entry} sealed={sealed} tz={clock.tz} />
                  ) : fileTab === "notes" ? (
                    <NotesView entry={entry} tz={clock.tz} />
                  ) : fileTab === "docs" ? (
                    <DocumentsView entry={entry} communications={communications ?? []} tz={clock.tz} sealed={sealed} onGo={(n) => gotoStep(n)} />
                  ) : (
                    <HistoryView
                      key={lensParam ?? "all"}
                      entry={entry}
                      tz={clock.tz}
                      initialLens={lensParam}
                      onOpenedPass={(stage) => setSelected(stepNoOfStage(stage))}
                    />
                  )}
                </div>
              </aside>
            </div>

            {/* The fixed bar: what else is possible here on the left, the move on the right. */}
            <div className="gatebar top" ref={barRef}>
              <div className="also-panel-slot" ref={setAlsoPanel} />
              <div className="also">
                <span className="also-h">Also possible here</span>
                <div className="also-btns" ref={setAlsoButtons} />
              </div>
              <div className="gate-status">{gateStatus}</div>
              <div className="acts">{forward}</div>
            </div>
            {dialogs}
          </div>
        </StepFlow>
      </BackendRailSlotContext.Provider>
    );
  }

  return (
    <BackendRailSlotContext.Provider value={railSlot}>
      <div className="ws">
        <div className="ws-head" ref={headRef}>
          {headInner}
        </div>

        <div className={`ws-body${sideFolded ? " side-folded" : ""}`}>
          {/* The column carries the ink down to the gate bar; the nav inside it sticks (2026-09-29). */}
          <div className="rail-col">
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
          </div>

          <div className="canvas">
            <div className="canvas-tabs" role="tablist">
              {/* Two groups (2026-10-12): the step's own tabs, then the booking's five — so on Stay,
                  which carries the most, the five wrap together rather than splitting. */}
              <div className="tabgroup">
              <button type="button" className="tab" role="tab" aria-selected={view === "step" && !pane} onClick={() => (pane ? setPane(null) : setView("step", viewing))}>
                This step
              </button>
              {panes.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className="tab"
                  role="tab"
                  aria-selected={view === "step" && pane === p.key}
                  title={p.key === "keys" && keysOwed.length ? keysOwed.join(" · ") : undefined}
                  onClick={() => setPane(p.key)}
                >
                  {p.label}
                  {p.key === "keys" && keysOwedCount ? <span className="tab-n stop">{keysOwedCount}</span> : null}
                </button>
              ))}
              {viewingPast || sealed ? null : (
                <button type="button" className="tab" role="tab" aria-selected={view === "other"} onClick={() => setView("other", viewing)}>
                  Other ways
                </button>
              )}
              <button type="button" className="tab" role="tab" aria-selected={view === "details"} onClick={() => setView("details", viewing)}>
                Booking details
              </button>
              </div>
              <div className="tabgroup booking">
                {BOOKING_TABS.map(([k, label]) => (
                  <button key={k} type="button" className="tab" role="tab" aria-selected={view === k} onClick={() => setView(k, viewing)}>
                    {label}
                    {tabCount(k)}
                  </button>
                ))}
              </div>
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
              <DetailsView
                entry={entry}
                booker={booker}
                custodian={listRow?.custodianName ?? null}
                onEdit={entry.currentStage === "S1" && !sealed ? () => setSelected(1) : null}
              />
            ) : view === "money" ? (
              <ChargesView entry={entry} billing={billing ?? null} tz={clock.tz} onPaymentHistory={() => setView("history", viewing, "money")} />
            ) : view === "requests" ? (
              <RequestsView entry={entry} sealed={sealed} tz={clock.tz} />
            ) : view === "notes" ? (
              <NotesView entry={entry} tz={clock.tz} />
            ) : view === "docs" ? (
              <DocumentsView entry={entry} communications={communications ?? []} tz={clock.tz} sealed={sealed} onGo={(n) => gotoStep(n)} />
            ) : view === "history" ? (
              <HistoryView
                key={lensParam ?? "all"}
                entry={entry}
                tz={clock.tz}
                initialLens={lensParam}
                onOpenedPass={(stage) => setSelected(stepNoOfStage(stage))}
              />
            ) : null}
            {/* This step and Other ways are the same canvas: the step's own cards here, its other
                ways portalled into the pane below (2026-09-25). The canvas stays mounted while any
                other tab is open (2026-10-12), so a look at Charges & payments never loses what the
                operator has half-typed into the step — the Negotiation table above all. */}
            {/* Explanations on request — every step since 2026-10-20 (the context's default). */}
            <QuietScreen>
            <div hidden={view !== "step" && view !== "other"}>
                <h3>
                  {STEP_NAMES[viewing - 1]}{" "}
                  <span className="need">
                    {view === "other" ? "what else it can do" : pane ? panes.find((p) => p.key === pane)?.label.toLowerCase() : STEP_NEEDS[viewing as StepNo]}
                  </span>
                </h3>
                {viewingPast ? (
                  sealed ? (
                    sealedNotice
                  ) : (
                    <div className="notice inert">
                      <span className="sm">
                        {`This step was passed on the way to ${STEP_NAMES[currentOrder - 1]} — what it shows is what was decided then; nothing here can be changed. To change it, work from the step the booking is at now.`}
                      </span>
                    </div>
                  )
                ) : null}
                <div hidden={view !== "step"}>
                {/* Papers a walk re-issued and held — whichever walk ran, the send-or-not question is here. */}
                {!sealed ? <ActiveRoomMoves entryId={entry.id} tz={clock.tz} /> : null}
                {!sealed ? <HeldPapersCard entryId={entry.id} tz={clock.tz} /> : null}
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
                </div>
                <StepFlow items={flowItems} on={!viewingPast && !sealed} fold={inquiryStepActive ? "done" : null}>
                  <OtherWaysSlot node={otherSlot}>
                    <div hidden={view !== "step"}>{native}</div>
                  </OtherWaysSlot>
                </StepFlow>
                <div hidden={view !== "other"}>
                  <div ref={setOtherSlot} />

                </div>
            </div>
            </QuietScreen>
            {/* the old side column's "what runs here" target — kept mounted, not shown */}
            <div ref={setRailSlot} hidden />
          </div>

          <SidePanel
            entry={entry}
            sealed={sealed}
            onGo={(n) => gotoStep(n)}
            todo={view === "step" && !viewingPast && !sealed ? flowItems : []}
            todoInherited={view === "step" && !viewingPast && !sealed ? inherited : []}
            onGoToCard={goToCard}
            timers={timersQuery.data?.items ?? []}
            folded={sideFolded}
            onFold={setSideFolded}
            promiseIsForTheRest={(paymentStatusQuery.data?.paymentPlan?.plan ?? "FULL") !== "FULL"}
          />
        </div>

        <div className="gatebar">
          {gateStatus}
          <div className="acts">{forward}</div>
        </div>
        {dialogs}
      </div>
    </BackendRailSlotContext.Provider>
  );
}

/** Who recorded an event, in words — the system is "system", a person is their name. */
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
    <Overlay>
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
    </Overlay>
  );
}

function SidePanel({
  entry,
  sealed,
  onGo,
  todo,
  todoInherited,
  onGoToCard,
  timers,
  folded,
  onFold,
  promiseIsForTheRest,
}: {
  entry: EntryDetail;
  sealed: boolean;
  onGo: (step: number) => void;
  todo: FlowItem[];
  todoInherited: Precondition[];
  onGoToCard: (card?: string) => void;
  timers: TimerRecordSummary[];
  folded: boolean;
  onFold: (folded: boolean) => void;
  /** The payment plan is part now, the rest later (or instalments): the promise clock is the rest's. */
  promiseIsForTheRest: boolean;
}) {
  const running = runningClocks(entry, timers, promiseIsForTheRest);
  const dwell = entry.stageDwellRecords?.[0];
  return (
    <FoldingSide folded={folded} onFold={onFold} clocks={running} todo={todo} also={todoInherited}>
      <div>
        <h4>Timers</h4>
        <div className="list">
          {running.length ? (
            running.map(({ t, label }) => <SideTimer key={t.id} timer={t} label={label} />)
          ) : (
            <span className="meta">nothing running</span>
          )}
          {dwell && !sealed ? <StepDwell since={dwell.enteredAt} /> : null}
        </div>
      </div>
      <FlowTodo items={todo} also={todoInherited} onGo={onGoToCard} />
    </FoldingSide>
  );
}

/**
 * The booking's running clocks as the desk names them, soonest first — one list for the side panel
 * and the header (2026-10-27), so the two cannot read a clock differently.
 */
function runningClocks(entry: EntryDetail, timers: TimerRecordSummary[], promiseIsForTheRest: boolean): Array<{ t: TimerRecordSummary; label: string }> {
  // The housekeeping (H2) and kitchen (H3) handoffs share one clock code; name them apart by
  // the handoff each clock is on, or both read "Housekeeping to accept".
  const handoffTypeById = new Map((entry.handoffs ?? []).map((h) => [h.id, h.handoffType]));
  const labelOf = (t: TimerRecordSummary) => {
    if (t.timerCode === "H2_H3_ACCEPTANCE_W25" && t.entityId) {
      const kind = handoffTypeById.get(t.entityId);
      if (kind === "H3") return "Kitchen to accept";
      if (kind === "H2") return "Housekeeping to accept";
    }
    // On a part-now plan the clock runs until the REST is in — a part payment does not stop it
    // (2026-10-23, operator: "I paid the advance, why didn't the timer stop").
    if (t.timerCode === "ADVANCE_PROMISE_DEADLINE_W38" && promiseIsForTheRest) return "Rest of the advance promised by";
    return timerLabel(t);
  };
  const sorted = timers
    .filter((t) => t.status === "SCHEDULED")
    .map((t) => ({ t, label: labelOf(t) }))
    .filter((x): x is { t: (typeof timers)[number]; label: string } => !!x.label)
    .sort((a, b) => a.t.firesAt.localeCompare(b.t.firesAt));
  // One reminder per night of the stay: only the next is worth a row (2026-10-13, operator: "why
  // is the night audit timer showing for all the days, instead of just the upcoming date").
  const nightClocks = sorted.filter((x) => x.t.timerCode === "NIGHT_AUDIT_STAY_NIGHT_W37");
  const laterNights = nightClocks.length - 1;
  // One housekeeping clock per room released at check-out, all with one label — they read as the
  // same clock three times (2026-10-26, operator). Each names its room, and rooms due at the same
  // moment share one row: "Rooms 302, 303, 304 cleaned by".
  const roomNumberById = new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)]));
  const cleanGroups = new Map<string, string[]>();
  for (const x of sorted) {
    if (x.t.timerCode !== "HOUSEKEEPING_SLA_W24") continue;
    const at = x.t.firesAt.slice(0, 16);
    const room = (x.t.entityId && roomNumberById.get(x.t.entityId)) || null;
    cleanGroups.set(at, [...(cleanGroups.get(at) ?? []), ...(room ? [room] : [])]);
  }
  const cleanSeen = new Set<string>();
  return sorted
    .filter((x) => x.t.timerCode !== "NIGHT_AUDIT_STAY_NIGHT_W37" || x === nightClocks[0])
    .filter((x) => {
      if (x.t.timerCode !== "HOUSEKEEPING_SLA_W24") return true;
      const at = x.t.firesAt.slice(0, 16);
      if (cleanSeen.has(at)) return false;
      cleanSeen.add(at);
      return true;
    })
    .map((x) => {
      if (x === nightClocks[0] && laterNights > 0) {
        return { ...x, label: `${x.label} · then ${laterNights} more ${laterNights === 1 ? "night" : "nights"}` };
      }
      if (x.t.timerCode === "HOUSEKEEPING_SLA_W24") {
        const rooms = [...new Set(cleanGroups.get(x.t.firesAt.slice(0, 16)) ?? [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return { ...x, label: rooms.length ? `${rooms.length > 1 ? "Rooms" : "Room"} ${rooms.join(", ")} cleaned by` : "Room cleaned by" };
      }
      return x;
    })
    .slice(0, 8);
}


