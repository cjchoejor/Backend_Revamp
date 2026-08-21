"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BedDouble, FileEdit, Handshake, KeyRound, Moon, Receipt, Scale } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  acceptHandoff,
  amendEntry,
  buildH4FulfilmentEvidence,
  correctFolioCharge,
  createH4Handoff,
  finalizeDeficientCondition,
  fulfilHandoff,
  getHandoffChecklist,
  getNightAuditRecord,
  openDispute,
  postCreditNote,
  postFolioCharge,
  progressDispute,
  runNightAudit,
} from "@/lib/api/in-stay";
import { cancelEntryEarlyDeparture } from "@/lib/api/reservation-setup";
import { getBillingSummary, issueAllRoomKeys, issueRoomKey, returnRoomKey } from "@/lib/api/entries";
import { IdentityProofBlock } from "./identity-proof";
import { FolioLinesTable, FolioTabStrip, filterLinesByTab, isTaxCompanion, roomTabsFor, type FolioTab } from "./folio-lines";
import type { HandoffChecklistItem } from "@/lib/api/handoffs";
import { money, moneyOrDash } from "@/lib/desk/workspace";
import { roomStayRangesByRoom } from "@/lib/desk/party-rooms";
import { DeskConfirmModal, DeskSuccessModal } from "./confirm-modal";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";
import { RoomCompositionSummary, hasRoomComposition } from "./room-composition-summary";
import { BedTypeEditor, ExtraBedEditor, InitialSelectionCell, RoomChangeControl } from "./room-change-control";

const BK = STAGE_ACTIONS.S7;

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}
/** "16 Aug" — the move-in day a not-yet-occupied room's key waits for. */
function shortDay(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function isElevated(level?: string) {
  return level === "L2" || level === "L3" || level === "L4";
}
function lastStayNightYmd(checkOutIso: string) {
  const d = new Date(checkOutIso);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1));
  return last.toISOString().slice(0, 10);
}
function terminalDeficient(status: string) {
  return status === "RESOLVED" || status === "UNRESOLVED" || status === "DEFICIENT_UNRESOLVED_AT_CHECKOUT";
}
function h4Initiated(state?: string, rejectedAt?: string | null) {
  if (!state || rejectedAt) return false;
  return ["CREATED", "ACCEPTED", "FULFILLED", "CLOSED"].includes(state);
}

export function StayStep({
  entry,
  setNightAuditOk,
  setSelected,
}: {
  entry: EntryDetail;
  setNightAuditOk: (v: boolean) => void;
  setSelected: (n: number) => void;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const elevated = isElevated(session?.actorLevel);
  const isGm = session?.actorLevel === "L3" || session?.actorLevel === "L4";
  const [earlyDepartOpen, setEarlyDepartOpen] = useState(false);
  const [earlyDepartWaiver, setEarlyDepartWaiver] = useState(false);

  const reservation = entry.reservation;
  const folio = entry.folio;
  const folioLines = folio?.lines ?? [];
  const folioLive = folio?.state === "LIVE";
  const handoffs = entry.handoffs ?? [];
  const h2 = handoffs.find((h) => h.handoffType === "H2" && h.stageContext === "S6");
  const h3 = handoffs.find((h) => h.handoffType === "H3" && h.stageContext === "S6");
  const h4 = handoffs.find((h) => h.handoffType === "H4");
  const assignment = (entry.roomAssignments ?? [])[0];
  // A multi-room booking has one RoomAssignment per (room, date-range) — dedupe by roomId,
  // keeping only rooms whose assignment is still current (an S7 room change end-dates the old
  // room's row at tonight, so it drops off this list while its slept nights stay billed).
  const distinctRooms = useMemo(() => {
    const todayYmdLocal = new Date().toISOString().slice(0, 10);
    const rows = (entry.roomAssignments ?? []).filter((a) => {
      if (!a.endDate) return true;
      return String(a.endDate).slice(0, 10) > todayYmdLocal;
    });
    return Array.from(new Map(rows.map((a) => [a.roomId, a])).values());
  }, [entry.roomAssignments]);
  // Which NIGHTS each room holds (2026-08-14, operator request) — shown beside each room.
  const stayRangesByRoom = useMemo(() => roomStayRangesByRoom(entry), [entry]);
  // Rows in CHRONOLOGICAL order (2026-08-14): first night first, longer stays before shorter
  // on a tie — a split's rooms sit adjacent, in the order slept.
  const distinctRoomsChrono = useMemo(() => {
    const key = (id: string) => stayRangesByRoom.get(id);
    return [...distinctRooms].sort(
      (a, b) =>
        (key(a.roomId)?.firstNight ?? "9999").localeCompare(key(b.roomId)?.firstNight ?? "9999") ||
        (key(b.roomId)?.nightCount ?? 0) - (key(a.roomId)?.nightCount ?? 0),
    );
  }, [distinctRooms, stayRangesByRoom]);
  // ── Key lifecycle (2026-08-14, operator ruling): a sequential room change is a key SWAP —
  // the vacated room's key comes back FIRST, and only then does the new room's key go out
  // (backend hard gate PRIOR_ROOM_KEY_OUTSTANDING; mirrored here so the button explains
  // itself instead of 409ing). Covers ALL rooms of the plan, including vacated ones that
  // have dropped off the Rooms-in-use list above but whose key is still with the guest.
  const keyPlan = useMemo(() => {
    const rows = entry.roomAssignments ?? [];
    const byRoom = new Map<string, typeof rows>();
    for (const a of rows) byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), a]);
    const todayIso = new Date().toISOString().slice(0, 10);
    const items = Array.from(byRoom.entries()).map(([roomId, rs]) => {
      const stay = stayRangesByRoom.get(roomId);
      const keyOut = rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt);
      const keyReturned = !keyOut && rs.some((r) => r.keyReturnedAt);
      // Vacated = every dated range of this room has ended (its move-out morning reached).
      // ONLY then is "Return key" offered (2026-08-16, operator ruling — while the guest
      // still has nights left in the room, the row just says "Key with guest"; the backend
      // refuses a premature return too). A room kept to checkout returns its key at S8.
      const vacated = rs.length > 0 && rs.every((r) => r.endDate && String(r.endDate).slice(0, 10) <= todayIso);
      return {
        roomId,
        roomNumber: rs[0].room?.roomNumber ?? roomId.slice(0, 8),
        stay,
        keyOut,
        keyReturned,
        vacated,
        movesInToday: stay?.firstNight === todayIso,
        movesInLater: !!stay?.firstNight && stay.firstNight > todayIso,
      };
    });
    items.sort(
      (x, y) =>
        (x.stay?.firstNight ?? "9999").localeCompare(y.stay?.firstNight ?? "9999") ||
        (y.stay?.nightCount ?? 0) - (x.stay?.nightCount ?? 0),
    );
    return items;
  }, [entry.roomAssignments, entry.checkOutDate, stayRangesByRoom]);
  // The Keys block earns its place on sequential plans and on any booking with key stamps;
  // a legacy single-room stay with no stamps stays clean.
  const showKeysBlock = keyPlan.length > 1 || keyPlan.some((k) => k.keyOut || k.keyReturned);
  // Mirror of the backend gate: two rooms with DISJOINT night ranges are sequential — one
  // party, one key set — so an outstanding key on any disjoint room blocks this room's
  // issue, in BOTH directions. Parallel (overlapping) rooms never block each other.
  const keyBlockersFor = (roomId: string) => {
    const rows = entry.roomAssignments ?? [];
    const checkInIso = entry.checkInDate ? String(entry.checkInDate).slice(0, 10) : null;
    const checkOutIso = entry.checkOutDate ? String(entry.checkOutDate).slice(0, 10) : null;
    const rangesFor = (id: string) =>
      rows
        .filter((a) => a.roomId === id)
        .map((a) => ({
          start: a.startDate ? String(a.startDate).slice(0, 10) : checkInIso,
          end: a.endDate ? String(a.endDate).slice(0, 10) : checkOutIso,
        }));
    const overlap = (x: { start: string | null; end: string | null }, y: { start: string | null; end: string | null }) =>
      !x.start || !x.end || !y.start || !y.end ? true : x.start < y.end && y.start < x.end;
    const target = rangesFor(roomId);
    return keyPlan.filter((k) => {
      if (k.roomId === roomId || !k.keyOut) return false;
      const other = rangesFor(k.roomId);
      return !other.some((o) => target.some((t) => overlap(t, o)));
    });
  };

  // roomId → room number, for the per-line room chips and the charge-form room select.
  const roomNumberById = useMemo(
    () => new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)])),
    [entry.roomAssignments],
  );
  // Per-room charge subtotals are SERVER-summed (billing-summary folio block) — the desk
  // shows, never adds. Same key shape as the workspace header's query so the caches share.
  const billingQuery = useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session && !!entry.folio?.id,
    refetchInterval: 30_000,
  });
  const perRoomCharges = billingQuery.data?.folio?.perRoomCharges ?? null;
  const unassignedCharges = billingQuery.data?.folio?.unassignedCharges ?? null;

  const deficientRecords = assignment?.room?.deficientConditionRecords ?? [];
  const disputes = entry.disputes ?? [];
  const currency = folioLines[0]?.currency;

  const checkOutIso = reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? "";
  const lastNightYmd = checkOutIso ? lastStayNightYmd(checkOutIso) : "";

  const [lineType, setLineType] = useState("F_AND_B");
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [chargeDate, setChargeDate] = useState("");
  // Per-room folio attribution (2026-08-14): which room this charge belongs to. "" = the
  // whole booking. Applies to both "Post a charge" and the credit note.
  const [chargeRoomId, setChargeRoomId] = useState("");
  // Posted-charge receipt (2026-08-17, operator request): a success dialog naming what was
  // posted and for which room, the inputs cleared for the next charge, and the button flashing
  // "Posted ✓" for ~2s while the dialog is up.
  const [postedInfo, setPostedInfo] = useState<null | {
    description: string;
    amount: string | number;
    currency?: string;
    lineType: string;
    roomNumber: string | null;
  }>(null);
  const [postedFlash, setPostedFlash] = useState(false);
  const [correctLineId, setCorrectLineId] = useState("");
  const [correctMode, setCorrectMode] = useState<"adjust" | "setNet">("adjust");
  const [correctDelta, setCorrectDelta] = useState("");
  const [correctToAmount, setCorrectToAmount] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  const [disputeTitle, setDisputeTitle] = useState("");
  const [disputeDesc, setDisputeDesc] = useState("");
  const [h4DeficientFlag, setH4DeficientFlag] = useState("NOT_APPLICABLE");
  const [h4Checklist, setH4Checklist] = useState<Record<string, boolean>>({});
  const [naDate, setNaDate] = useState("");
  const [amendType, setAmendType] = useState("INCLUSION_CHANGE");
  const [amendReason, setAmendReason] = useState("");
  const [amendTerms, setAmendTerms] = useState("");

  useEffect(() => {
    const t = new Date().toISOString().slice(0, 10);
    setChargeDate(t);
    setNaDate(lastNightYmd || t);
  }, [lastNightYmd]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    if (lastNightYmd) void queryClient.invalidateQueries({ queryKey: ["night-audit", lastNightYmd] });
  };
  const wrap = <T,>(fn: () => Promise<T>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(msg);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const nightAuditQuery = useQuery({
    queryKey: ["night-audit", lastNightYmd],
    queryFn: () => getNightAuditRecord(session!, lastNightYmd),
    enabled: !!session && !!lastNightYmd,
  });
  const nightAuditOk = nightAuditQuery.data?.runStatus === "COMPLETE";
  useEffect(() => {
    setNightAuditOk(nightAuditOk);
  }, [nightAuditOk, setNightAuditOk]);

  const h4ChecklistQuery = useQuery({
    queryKey: ["handoff-checklist", "H4"],
    queryFn: () => getHandoffChecklist(session!, "H4"),
    enabled: !!session && !!h4 && h4.state === "CREATED",
  });
  const h4Items = (h4ChecklistQuery.data?.items ?? []) as HandoffChecklistItem[];

  // Key swap (2026-08-14): issue / take back one room's key. The backend enforces the
  // return-first hard gate; these just surface its answer.
  const issueKeyM = useMutation({
    mutationFn: (roomId: string) => issueRoomKey(session!, entry.id, roomId),
    onSuccess: (r) => {
      toast.success(`Key issued for Room ${r.roomNumber}`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't issue the key"),
  });
  const returnKeyM = useMutation({
    mutationFn: (roomId: string) => returnRoomKey(session!, entry.id, roomId),
    onSuccess: (r) => {
      toast.success(`Key back from Room ${r.roomNumber}`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't record the key return"),
  });
  // All the keys the guest can hold right now, in one act (2026-08-19, operator request). The
  // SET is the server's decision — the desk reports what it did and, in the S1 "Select all"
  // manner, says out loud what it left out rather than letting a partial batch read as complete.
  const issueAllKeysM = useMutation({
    mutationFn: () => issueAllRoomKeys(session!, entry.id),
    onSuccess: (out) => {
      const n = out.issued.length;
      const notes = out.skipped
        .filter((s) => s.reason !== "ALREADY_OUT")
        .map((s) =>
          s.reason === "PRIOR_ROOM_KEY_OUTSTANDING"
            ? `Room ${s.roomNumber} waits for Room ${s.blockedBy.map((b) => b.roomNumber).join(", ")}'s key to come back`
            : `Room ${s.roomNumber}'s key comes on the move day${s.movesInOn ? ` · ${shortDay(s.movesInOn)}` : ""}`,
        );
      if (n === 0) {
        toast.info(notes.length > 0 ? `No key issued — ${notes.join(" · ")}` : "Every key is already with the guest");
      } else {
        const what = `${n} key${n === 1 ? "" : "s"} issued · Room ${out.issued.map((i) => i.roomNumber).join(", ")}`;
        if (notes.length > 0) toast.warning(`${what}. ${notes.join(" · ")}`, { duration: 10000 });
        else toast.success(what);
      }
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't issue the keys"),
  });
  /** Rooms a bulk issue would actually hand over now — mirrors the server's default set. */
  const bulkIssuable = keyPlan.filter((k) => !k.keyOut && !k.movesInLater && keyBlockersFor(k.roomId).length === 0);

  const postChargeM = useMutation({
    mutationFn: () => {
      const amt = Number.parseFloat(amount);
      if (!folio?.id || !Number.isFinite(amt)) throw new Error("Valid amount required");
      return postFolioCharge(session!, folio.id, {
        entryId: entry.id,
        lineType,
        description: desc.trim() || lineType,
        amount: amt,
        chargeDate: chargeDate ? `${chargeDate}T12:00:00.000Z` : undefined,
        roomId: chargeRoomId || undefined,
      });
    },
    // Posted-charge receipt (2026-08-17): dialog with the posted facts, inputs cleared for
    // the next charge, button flashing "Posted ✓" while the dialog is up.
    onSuccess: (line) => {
      invalidate();
      setPostedInfo({
        description: line.description,
        amount: line.amount,
        currency: line.currency,
        lineType: line.lineType,
        roomNumber: line.roomId ? roomNumberById.get(line.roomId) ?? null : null,
      });
      setDesc("");
      setAmount("");
      setPostedFlash(true);
      window.setTimeout(() => setPostedFlash(false), 1800);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't post the charge"),
  });
  const creditNoteM = useMutation(
    wrap(() => {
      const amt = Number.parseFloat(amount);
      if (!folio?.id || !Number.isFinite(amt) || amt <= 0) throw new Error("Valid amount required");
      return postCreditNote(session!, folio.id, {
        entryId: entry.id,
        description: desc.trim() || "Credit note",
        amount: amt,
        creditDate: new Date().toISOString(),
        roomId: chargeRoomId || undefined,
      });
    }, "Credit note posted"),
  );
  const correctM = useMutation(
    wrap(() => {
      if (!folio?.id || !correctLineId) throw new Error("Select a line to correct");
      const body: Parameters<typeof correctFolioCharge>[2] = {
        entryId: entry.id,
        originalFolioLineId: correctLineId,
        reason: correctReason.trim(),
        correctionDate: new Date().toISOString(),
      };
      if (correctMode === "setNet") {
        const net = Number.parseFloat(correctToAmount);
        if (!Number.isFinite(net)) throw new Error("Enter the net amount to set the line to");
        body.correctToAmount = net;
      } else {
        const v = Number.parseFloat(correctDelta);
        if (!Number.isFinite(v) || v === 0) throw new Error("Enter a non-zero adjustment");
        body.correctionAmount = v;
      }
      return correctFolioCharge(session!, folio.id, body);
    }, "Correction posted"),
  );
  const nightAuditM = useMutation(wrap(() => runNightAudit(session!, `${naDate}T00:00:00.000Z`), "Night audit run"));
  const createH4M = useMutation(wrap(() => createH4Handoff(session!, entry.id, { notes: "Pre-checkout coordination" }), "Pre-checkout handoff created"));
  const acceptH4M = useMutation(
    wrap(() => {
      const c: Record<string, boolean> = {};
      for (const i of h4Items) c[i.code] = h4Checklist[i.code] === true;
      return acceptHandoff(session!, h4!.id, c);
    }, "Handoff accepted"),
  );
  const fulfilH4M = useMutation(wrap(() => fulfilHandoff(session!, h4!.id, buildH4FulfilmentEvidence(h4DeficientFlag)), "Handoff fulfilled"));
  const openDisputeM = useMutation(
    wrap(() => {
      if (!folio?.id) throw new Error("No folio");
      return openDispute(session!, { entryId: entry.id, folioId: folio.id, title: disputeTitle.trim(), description: disputeDesc.trim() || undefined });
    }, "Dispute opened"),
  );
  const deficientM = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "RESOLVED" | "UNRESOLVED" }) =>
      finalizeDeficientCondition(session!, id, { status, resolutionNotes: status === "RESOLVED" ? "Resolved during stay" : "Unresolved — carries to checkout" }),
    onSuccess: () => {
      toast.success("Deficiency updated");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });
  const amendM = useMutation(
    wrap(() => {
      const segmentId = entry.segments?.[0]?.id;
      if (!segmentId) throw new Error("No segment");
      return amendEntry(session!, entry.id, {
        amendmentType: amendType,
        segmentId,
        amendmentPath: "PATH_2",
        requestedBy: session!.userId,
        authorisedBy: session!.userId,
        authorityBasis: "FOM mid-stay amendment",
        reason: amendReason.trim(),
        newTermsSummary: amendTerms.trim(),
        stageAtAmendment: "S7",
      });
    }, "Amendment recorded"),
  );
  const earlyDepartM = useMutation({
    mutationFn: () =>
      cancelEntryEarlyDeparture(session!, entry.id, earlyDepartWaiver ? { penaltyWaiverRequested: true } : undefined),
    onSuccess: () => {
      setEarlyDepartOpen(false);
      toast.success("Early departure recorded — stay ended, room released.");
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Early departure failed"),
  });
  const openDisputes = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS");
  // Only CHARGES are correctable: the SC/GST companions ride on their charge (the backend refuses
  // to correct a tax line directly — a charge correction re-posts its own tax deltas), and an
  // earlier correction line is never the thing to correct. The legacy "sales tax" prefix check
  // predates today's companion descriptions, so it let every GST / service-charge line through
  // to a dead-end pick (2026-08-21).
  const correctable = useMemo(
    () => folioLines.filter((l) => !isTaxCompanion(l) && !l.description.toLowerCase().startsWith("sales tax") && !l.description.toLowerCase().startsWith("correction for")),
    [folioLines],
  );
  // The picker splits by room / whole booking exactly like the folio above (2026-08-21, operator
  // request) — same tab strip, same slicing. Its tab is independent of the folio's so a pick in
  // progress never jumps; a line hidden by a tab switch is dropped from the selection.
  const [correctTab, setCorrectTab] = useState<FolioTab>("ALL");
  const correctRoomTabs = useMemo(() => roomTabsFor(correctable, roomNumberById), [correctable, roomNumberById]);
  const correctHasRoomless = correctable.some((l) => !l.roomId);
  const correctableVisible = useMemo(() => filterLinesByTab(correctable, correctTab), [correctable, correctTab]);
  const pickCorrectTab = (tab: FolioTab) => {
    setCorrectTab(tab);
    if (correctLineId && !filterLinesByTab(correctable, tab).some((l) => l.id === correctLineId)) setCorrectLineId("");
  };
  const h4MandatoryComplete = h4Items.filter((i) => i.mandatory).every((i) => h4Checklist[i.code] === true);

  // Night audit runs only for a *completed* operating day. A future date is never valid; today is
  // allowed (it may be the final stay night needed for same-day checkout) but flagged, because
  // running it seals the day to further charges (SIG-S7 §2.2 / Policy 61).
  const todayYmd = new Date().toISOString().slice(0, 10);
  const naFuture = !!naDate && naDate > todayYmd;
  const naIsToday = naDate === todayYmd;

  // Persistent highlight: each group stays lit once its action has run (derived from real folio /
  // audit / handoff / dispute state). `firingKey` adds the transient "running now" pulse.
  const activeKeys = [
    folioLines.length > 0 ? "charge" : null,
    nightAuditOk ? "nightAudit" : null,
    h4 ? "handoff" : null,
    disputes.length > 0 ? "dispute" : null,
    entry.currentStage !== "S7" ? "advance" : null,
  ].filter(Boolean) as string[];
  const firingKey = postChargeM.isPending || creditNoteM.isPending || correctM.isPending
    ? "charge"
    : nightAuditM.isPending
      ? "nightAudit"
      : createH4M.isPending || acceptH4M.isPending || fulfilH4M.isPending
        ? "handoff"
        : openDisputeM.isPending
          ? "dispute"
          : null;
  const railGroups: RailGroup[] = [
    { key: "charge", label: "On posting a charge / correction", items: BK.charge },
    { key: "nightAudit", label: "On the night audit", items: BK.nightAudit },
    { key: "handoff", label: "On the H4 pre-checkout handoff", items: BK.handoff },
    { key: "dispute", label: "On opening / reviewing a dispute", items: BK.dispute },
    { key: "advance", label: "On advancing to Check-out", items: BK.advance },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
      <div className="speak">
        <div className="now">In-house</div>
        <h2>The stay is live. Post charges as they happen.</h2>
        <p>
          Every charge adds a line — nothing is edited in place; use a correction to fix one. Room charges post
          themselves each night in the audit; you post the rest.
        </p>
      </div>


      {/* Per-room composition summary (Phase F of per-room track, 2026-07-27; collapsed by
          default since 2026-08-13 — a tally header line, expandable to one dense row per room
          with occupants, meals, negotiated rates, and the per-room frozen total). Hidden on
          legacy bookings without composition data. */}
      {hasRoomComposition(entry.roomAssignments) && (
        <div className="block">
          <BlockH>Per-room composition</BlockH>
          <RoomCompositionSummary assignments={entry.roomAssignments ?? []} currency={currency} />
        </div>
      )}

      {/* Rooms in use (2026-08-12, operator ruling): each room carries its live bed-setup
          dropdown AND an in-place "Change room" — the swap runs the whole governed journey
          server-side (new segment, availability re-checked, silent re-price, back to Stay)
          and takes effect from tonight; slept nights stay billed on the old room. Same-type
          swaps are L1+; cross-type upgrades/downgrades need FOM (L2+) — the picker locks
          those options below that (2026-08-13 ruling). */}
      {distinctRooms.length > 0 && (
        <div className="block">
          <BlockH>
            <BedDouble style={{ width: 13, height: 13 }} />
            Rooms in use
          </BlockH>
          <div style={{ display: "grid", gap: 8 }}>
            {distinctRoomsChrono.map((a) => (
              <div key={a.roomId} style={{ display: "grid", gap: 6 }}>
                <div
                  className="fact b-bound"
                  style={{ padding: "8px 12px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}
                >
                  <span>
                    Room {a.room?.roomNumber ?? a.roomId.slice(0, 8)}
                    {/* The nights the guest sleeps in THIS room (2026-08-14) — one range, or
                        several after a mid-stay change (old room keeps its slept span). */}
                    {(() => {
                      const stay = stayRangesByRoom.get(a.roomId);
                      return stay ? (
                        <span
                          style={{ color: "var(--ink-3)", fontWeight: 400, fontSize: 11.5 }}
                          title={`${stay.nightCount} night${stay.nightCount === 1 ? "" : "s"} in this room`}
                        >
                          {" "}· {stay.label}
                        </span>
                      ) : null;
                    })()}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    {/* What this slot STARTED as (2026-08-13) — survives every room/bed change. */}
                    <InitialSelectionCell entryId={entry.id} roomId={a.roomId} />
                    <BedTypeEditor roomId={a.roomId} />
                    {/* Extra beds, editable in-house (2026-08-19): applies from tonight, slept nights keep
                        the old count — a setup-only change through the room-change journey. */}
                    <ExtraBedEditor entry={entry} roomId={a.roomId} onChanged={invalidate} />
                  </span>
                </div>
                <RoomChangeControl
                  entry={entry}
                  fromRoomId={a.roomId}
                  fromRoomNumber={a.room?.roomNumber ?? a.roomId.slice(0, 8)}
                  onChanged={invalidate}
                  compact
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Keys (2026-08-14, operator ruling): a sequential room change — 501 nights 1–2 then
          302 night 3 — is a key SWAP on the move day. The vacated room's key comes back
          FIRST; the new room's key is HARD-blocked until it does (backend
          PRIOR_ROOM_KEY_OUTSTANDING, mirrored on the button). Vacated rooms drop off the
          Rooms-in-use list above but keep a row HERE while their key is with the guest. */}
      {showKeysBlock && (
        <div className="block">
          <BlockH>
            <KeyRound style={{ width: 13, height: 13 }} />
            Keys
          </BlockH>
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 8px" }}>
            A room move is a key swap — take the old room&apos;s key back first; the new room&apos;s
            key won&apos;t issue while the old one is still with the guest. The final key comes back
            at Check-out.
          </p>
          {/* All at once (2026-08-19, operator request) — one click for a whole party instead of
              one button per room. Deliberately partial: the server decides the set and the toast
              names what it left out (a sequential room still waits for the key it swaps with). */}
          {keyPlan.length > 1 && (
            <div
              className="fact b-transit"
              style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between", marginBottom: 8 }}
            >
              <span>
                {keyPlan.filter((k) => k.keyOut).length} of {keyPlan.length} keys with the guest
                {bulkIssuable.length > 0 && (
                  <span style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
                    {" "}
                    · {bulkIssuable.length} ready to hand over
                  </span>
                )}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={issueAllKeysM.isPending || bulkIssuable.length === 0}
                title={
                  bulkIssuable.length === 0
                    ? "No key can go out right now — every key is either with the guest or waiting on a swap or a move day"
                    : `Hand over Room ${bulkIssuable.map((k) => k.roomNumber).join(", ")}'s key${bulkIssuable.length === 1 ? "" : "s"} in one go`
                }
                onClick={() => issueAllKeysM.mutate()}
              >
                <KeyRound style={{ width: 12, height: 12 }} />
                {issueAllKeysM.isPending ? "Issuing…" : "Issue all keys"}
              </button>
            </div>
          )}
          <div style={{ display: "grid", gap: 6 }}>
            {keyPlan.map((k) => {
              const blockers = !k.keyOut ? keyBlockersFor(k.roomId) : [];
              const moveIn =
                k.stay?.firstNight != null
                  ? new Date(`${k.stay.firstNight}T00:00:00`).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                    })
                  : null;
              return (
                <div
                  key={k.roomId}
                  className="fact b-bound"
                  style={{ padding: "8px 12px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}
                >
                  <span style={{ display: "grid", gap: 2 }}>
                    <span>
                      Room {k.roomNumber}
                      {k.stay ? (
                        <span style={{ color: "var(--ink-3)", fontWeight: 400, fontSize: 11.5 }}> · {k.stay.label}</span>
                      ) : null}
                    </span>
                    {k.keyOut && k.vacated ? (
                      <span style={{ fontSize: 11.5, color: "var(--warn)", fontWeight: 600 }}>
                        Guest has moved out of this room — collect its key
                      </span>
                    ) : blockers.length > 0 ? (
                      // The receiving room says exactly what unlocks it, naming the room(s).
                      <span style={{ fontSize: 11.5, color: "var(--warn)" }}>
                        Get this key after Room {blockers.map((b) => b.roomNumber).join(", ")}&apos;s key is returned
                      </span>
                    ) : !k.keyOut && !k.keyReturned && k.movesInToday ? (
                      <span style={{ fontSize: 11.5, color: "var(--warn)" }}>Guest moves in today — issue the key</span>
                    ) : !k.keyOut && !k.keyReturned && k.movesInLater && moveIn ? (
                      <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Moves in {moveIn} — key on the move day</span>
                    ) : null}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {k.keyOut ? (
                      <>
                        <span className="tag">Key with guest</span>
                        {/* "Return key" only once the guest has actually MOVED OUT (2026-08-16,
                            operator ruling) — the button rides with the amber collect-the-key
                            subtext. While nights remain in the room, and on rooms kept to
                            checkout (203 — S8 collects that key), the row just states the fact. */}
                        {k.vacated && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={returnKeyM.isPending}
                            title={`Take Room ${k.roomNumber}'s key back from the guest`}
                            onClick={() => returnKeyM.mutate(k.roomId)}
                          >
                            Return key
                          </button>
                        )}
                      </>
                    ) : k.keyReturned ? (
                      <>
                        <span
                          className="tag"
                          style={{ color: "var(--green-d)", borderColor: "var(--green-d)", background: "var(--green-t, transparent)" }}
                        >
                          Key returned
                        </span>
                        {/* A returned key can go out again (guest re-enters, mistaken return,
                            or the move day arrives) — same hard gate as a first issue. */}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={issueKeyM.isPending || blockers.length > 0}
                          title={
                            blockers.length > 0
                              ? `Get this key after Room ${blockers.map((b) => b.roomNumber).join(", ")}'s key is returned`
                              : `Hand Room ${k.roomNumber}'s key to the guest again`
                          }
                          onClick={() => issueKeyM.mutate(k.roomId)}
                        >
                          Issue again
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={issueKeyM.isPending || blockers.length > 0}
                        title={
                          blockers.length > 0
                            ? `Get this key after Room ${blockers.map((b) => b.roomNumber).join(", ")}'s key is returned`
                            : `Hand Room ${k.roomNumber}'s key to the guest`
                        }
                        onClick={() => issueKeyM.mutate(k.roomId)}
                      >
                        Issue key
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Guest details during the stay (2026-08-21, operator request: "sometimes guest detail
          can be put in S5 and later made changes in S7 or S6"). Same table as Arrival and
          Check-in — collapsed by default here, since in-house it is a correction surface, not
          a capture one. A row confirmed earlier stays locked until "Make changes" unlocks it. */}
      <IdentityProofBlock entry={entry} collapsible />

      {/* Live folio */}
      <div className="block">
        <BlockH>
          <Receipt style={{ width: 13, height: 13 }} />
          Live folio
        </BlockH>
        {/* Compact tabular folio (2026-08-21) — see FolioLinesTable for the two elongation
            fixes: table rows behind a scroll cap, and SC/GST companions folded under their
            charge. Σ per-room + balance stay pinned below the scroll. */}
        <div style={{ marginBottom: 12 }}>
          <FolioLinesTable
            lines={folioLines}
            roomNumberById={roomNumberById}
            perRoomCharges={perRoomCharges}
            unassignedCharges={unassignedCharges}
            chargeBreakdown={billingQuery.data?.folio?.chargeBreakdown ?? null}
            balance={folio?.outstandingBalance ?? null}
            currency={currency}
            // An open room tab becomes the default "For room" of the charge form below (2026-08-21,
            // "keep tab of each room separately") — still freely changeable before posting.
            onTabChange={(t) => setChargeRoomId(typeof t === "string" ? "" : t.roomId)}
          />
        </div>

        {!folioLive && <p style={{ fontSize: 12, color: "var(--stop)", marginTop: 0 }}>Folio must be live (complete check-in first).</p>}

        <div className="frow">
          <div className="field">
            <label>Type</label>
            <select value={lineType} onChange={(e) => setLineType(e.target.value)}>
              <option value="F_AND_B">F &amp; B</option>
              <option value="SERVICE">Service</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="field">
            <label>For room</label>
            {/* Per-room folio attribution (2026-08-14): the room this charge belongs to —
                the room-service dinner goes on 501, not the whole party's bill. Optional. */}
            <select value={chargeRoomId} onChange={(e) => setChargeRoomId(e.target.value)}>
              <option value="">Whole booking</option>
              {keyPlan.map((k) => (
                <option key={k.roomId} value={k.roomId}>
                  Room {k.roomNumber}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Amount</label>
            <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="frow">
          <div className="field">
            <label>Description</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="field">
            <label>Charge date</label>
            <input type="date" value={chargeDate} onChange={(e) => setChargeDate(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className={`btn btn-primary${postedFlash ? " is-done" : ""}`}
            disabled={postChargeM.isPending || !folioLive || postedFlash}
            onClick={() => postChargeM.mutate()}
          >
            {postedFlash ? "Posted ✓" : "Post a charge"}
          </button>
          {elevated && (
            <button className="btn btn-ghost" disabled={creditNoteM.isPending || !folioLive} onClick={() => creditNoteM.mutate()}>
              Post credit note (L2+)
            </button>
          )}
        </div>

        {correctable.length > 0 && (
          <div style={{ marginTop: 12, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 4 }}>Correct a charge</div>
            <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "0 0 9px", lineHeight: 1.55 }}>
              A live folio is append-only — nothing already posted can be edited or deleted. Correcting adds a
              second, offsetting line next to the original, so the bill shows both the mistake and the fix.
              The charge&rsquo;s <b>service charge and GST move with it</b> — their corrections post
              automatically, at the rates that charge was taxed at.
            </p>
            {/* "Which posted charge is wrong?" is a TABLE, not a dropdown (2026-08-21, operator
                request): an <option> crammed room, type, description and amount into one string,
                which is exactly the moment an operator needs to compare charges side by side —
                a wrong charge is spotted by scanning dates and amounts down a column. Clicking a
                row picks it; everything below still works off `correctLineId`. */}
            <div className="field">
              <label>
                Which posted charge is wrong?{" "}
                <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>
                  — {correctableVisible.length} posted charge{correctableVisible.length === 1 ? "" : "s"}
                  {correctTab === "ALL" ? "" : correctTab === "WHOLE" ? " on the whole booking" : ` on Room ${correctRoomTabs.find((r) => r.roomId === correctTab.roomId)?.roomNumber ?? "?"}`}
                  {correctLineId ? "" : " · click the row to pick one"}
                </span>
              </label>
              <div style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
                {(correctRoomTabs.length > 0 || correctHasRoomless) && (
                  <FolioTabStrip
                    roomTabs={correctRoomTabs}
                    hasRoomless={correctHasRoomless}
                    tab={correctTab}
                    onChange={pickCorrectTab}
                    roomTitle={(n) => `Only the charges posted against Room ${n}`}
                  />
                )}
                <div style={{ maxHeight: 260, overflowY: "auto", overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        {(correctTab === "ALL" ? ["", "Date", "Room", "Charge", "Type", "Amount"] : ["", "Date", "Charge", "Type", "Amount"]).map((h, i, arr) => (
                          <th
                            key={h || `c${i}`}
                            style={{
                              position: "sticky",
                              top: 0,
                              zIndex: 1,
                              background: "var(--cream)",
                              textAlign: i === arr.length - 1 ? "right" : "left",
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                              color: "var(--ink-3)",
                              padding: "5px 7px",
                              borderBottom: "1px solid var(--line-2)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {correctableVisible.length === 0 && (
                        <tr>
                          <td colSpan={6} style={{ padding: "10px 8px", color: "var(--ink-3)", fontSize: 12 }}>
                            Nothing posted here yet
                          </td>
                        </tr>
                      )}
                      {correctableVisible.map((l) => {
                        const picked = correctLineId === l.id;
                        const sys = !!l.nightAuditRecordId;
                        const cell: React.CSSProperties = {
                          padding: "6px 7px",
                          borderBottom: "1px dashed var(--line)",
                          background: picked ? "var(--cream)" : undefined,
                          whiteSpace: "nowrap",
                        };
                        return (
                          <tr
                            key={l.id}
                            onClick={() => setCorrectLineId(l.id)}
                            style={{ cursor: "pointer" }}
                            title={`${l.description} — ${money(l.amount, l.currency)}${sys ? " · posted by the night audit" : ""}`}
                          >
                            <td style={{ ...cell, width: 26, textAlign: "center" }}>
                              <input
                                type="radio"
                                name="correctLine"
                                checked={picked}
                                onChange={() => setCorrectLineId(l.id)}
                                style={{ cursor: "pointer" }}
                              />
                            </td>
                            <td style={{ ...cell, color: "var(--ink-2)" }}>{l.chargeDate?.slice(0, 10) ?? "—"}</td>
                            {correctTab === "ALL" && (
                              <td style={{ ...cell, color: l.roomId ? undefined : "var(--ink-3)" }}>
                                {l.roomId ? `Room ${roomNumberById.get(l.roomId) ?? "?"}` : "Whole booking"}
                              </td>
                            )}
                            {/* The description carries the detail, so it is the one column allowed
                                to wrap rather than widen the table past the canvas. */}
                            <td style={{ ...cell, whiteSpace: "normal", minWidth: 150, fontWeight: picked ? 600 : 400 }}>
                              <span style={{ marginRight: 5, color: "var(--ink-3)" }} title={sys ? "Posted by the night audit" : "Posted at the desk"}>
                                {sys ? "⚙" : "✎"}
                              </span>
                              {l.description}
                            </td>
                            <td style={{ ...cell, color: "var(--ink-3)", fontSize: 11 }}>{l.lineType}</td>
                            <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                              {money(l.amount, l.currency)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="field">
              <label>Mode</label>
              <div style={{ display: "flex", gap: 14, fontSize: 12.5 }}>
                <label className="checkline" style={{ cursor: "pointer" }}>
                  <input type="radio" name="correctMode" checked={correctMode === "adjust"} onChange={() => setCorrectMode("adjust")} />
                  <span>Adjust by ±</span>
                </label>
                <label className="checkline" style={{ cursor: "pointer" }}>
                  <input type="radio" name="correctMode" checked={correctMode === "setNet"} onChange={() => setCorrectMode("setNet")} />
                  <span>Set net to</span>
                </label>
              </div>
            </div>
            <div className="frow">
              {correctMode === "adjust" ? (
                <div className="field">
                  <label>Adjust by ± (e.g. −50)</label>
                  <input type="number" value={correctDelta} onChange={(e) => setCorrectDelta(e.target.value)} />
                </div>
              ) : (
                <div className="field">
                  <label>Set line net to</label>
                  <input type="number" value={correctToAmount} onChange={(e) => setCorrectToAmount(e.target.value)} />
                </div>
              )}
              <div className="field">
                <label>Reason</label>
                <input value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} />
              </div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              disabled={correctM.isPending || !correctLineId || (correctMode === "adjust" ? !correctDelta : !correctToAmount)}
              onClick={() => correctM.mutate()}
            >
              Post correction
            </button>
          </div>
        )}
      </div>

      {/* Night audit */}
      <div className="block">
        <BlockH>
          <Moon style={{ width: 13, height: 13 }} />
          Night audit
        </BlockH>
        <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
          <span>Final stay night {lastNightYmd || "—"}</span>
          <span className={`tag ${nightAuditOk ? "" : "warn"}`}>{nightAuditQuery.data?.runStatus ?? "not run"}</span>
        </div>
        <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "7px 0 0", lineHeight: 1.5 }}>
          Night audit is a <b>hotel-wide</b> run for an operating date — not per booking. If it already
          shows complete for this night, it was run for the property (by you on another booking, or the
          nightly worker); it does not need re-running here.
        </p>
        {elevated ? (
          <>
            <div className="frow" style={{ marginTop: 9 }}>
              <div className="field">
                <label>Run for date (L2+)</label>
                <input type="date" value={naDate} max={todayYmd} onChange={(e) => setNaDate(e.target.value)} />
              </div>
              <div className="field" style={{ alignSelf: "end" }}>
                <button
                  className="btn btn-ghost"
                  disabled={nightAuditM.isPending || nightAuditOk || naFuture || !naDate}
                  onClick={() => nightAuditM.mutate()}
                >
                  {nightAuditM.isPending
                    ? "Running…"
                    : nightAuditOk
                      ? `✓ Night audit complete${lastNightYmd ? ` for ${lastNightYmd}` : ""}`
                      : "Run night audit"}
                </button>
              </div>
            </div>
            {naFuture && (
              <p style={{ fontSize: 11.5, color: "var(--stop)", margin: "6px 0 0" }}>
                Night audit can only run for a completed (past) day — a future date isn&rsquo;t valid.
              </p>
            )}
            {naIsToday && !nightAuditOk && (
              <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "6px 0 0" }}>
                This seals <b>today</b> to further charges — post all of today&rsquo;s charges first.
              </p>
            )}
          </>
        ) : (
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "8px 0 0" }}>Running the night audit requires FOM (L2+).</p>
        )}
      </div>

      {/* Handoffs */}
      <div className="block">
        <BlockH>
          <Handshake style={{ width: 13, height: 13 }} />
          Handoffs
        </BlockH>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 11 }}>
          {h2 && <span className="tag">HK · {h2.state}</span>}
          {h3 && <span className="tag">F&amp;B · {h3.state}</span>}
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 7 }}>Pre-checkout (H4)</div>
        {!h4 ? (
          <button className="btn btn-ghost btn-sm" disabled={createH4M.isPending} onClick={() => createH4M.mutate()}>
            Start pre-checkout handoff
          </button>
        ) : (
          <>
            <div className="fact b-transit" style={{ padding: "6px 11px", fontSize: 12.5, marginBottom: 9, width: "100%", justifyContent: "space-between" }}>
              <span>H4</span>
              <span className="tag">{h4.state}</span>
            </div>
            {h4.state === "CREATED" && h4Items.length > 0 && (
              <div style={{ marginBottom: 9 }}>
                {h4Items.map((i) => (
                  <label key={i.code} className="checkline" style={{ cursor: "pointer" }}>
                    <input type="checkbox" checked={h4Checklist[i.code] === true} onChange={(e) => setH4Checklist((p) => ({ ...p, [i.code]: e.target.checked }))} />
                    <span>{i.description ?? i.code}</span>
                  </label>
                ))}
                <button className="btn btn-ghost btn-sm" disabled={acceptH4M.isPending || !h4MandatoryComplete} onClick={() => acceptH4M.mutate()} style={{ marginTop: 7 }}>
                  Accept handoff
                </button>
              </div>
            )}
            {h4.state === "ACCEPTED" && (
              <div className="frow">
                <div className="field">
                  <label>Deficiency final status</label>
                  <select value={h4DeficientFlag} onChange={(e) => setH4DeficientFlag(e.target.value)}>
                    <option value="NOT_APPLICABLE">Not applicable</option>
                    <option value="RESOLVED">Resolved</option>
                    <option value="UNRESOLVED_AT_CHECKOUT">Unresolved at checkout</option>
                    <option value="RECORDED">Recorded</option>
                  </select>
                </div>
                <div className="field" style={{ alignSelf: "end" }}>
                  <button className="btn btn-ghost" disabled={fulfilH4M.isPending} onClick={() => fulfilH4M.mutate()}>
                    Fulfil handoff
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Deficiencies */}
      {deficientRecords.length > 0 && (
        <div className="block">
          <BlockH>
            <AlertTriangle style={{ width: 13, height: 13 }} />
            Room deficiencies
          </BlockH>
          {deficientRecords.map((d) => (
            <div key={d.id} style={{ borderBottom: "1px dashed var(--line)", padding: "8px 0" }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {d.category}: {d.description}
              </div>
              <span className={`tag ${terminalDeficient(d.status) ? "" : "warn"}`} style={{ marginTop: 5, display: "inline-flex" }}>
                {d.status}
              </span>
              {!terminalDeficient(d.status) && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
                  <button className="btn btn-ghost btn-sm" disabled={deficientM.isPending} onClick={() => deficientM.mutate({ id: d.id, status: "RESOLVED" })}>
                    Mark resolved
                  </button>
                  <button className="btn btn-ghost btn-sm" disabled={deficientM.isPending} onClick={() => deficientM.mutate({ id: d.id, status: "UNRESOLVED" })}>
                    Mark unresolved
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Disputes */}
      <div className="block">
        <BlockH>
          <Scale style={{ width: 13, height: 13 }} />
          Disputes
        </BlockH>
        {disputes.length > 0 &&
          disputes.map((d) => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
              <span style={{ fontSize: 13 }}>
                <b>{d.title}</b>
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className={`tag ${d.status === "RESOLVED" ? "" : "warn"}`}>{d.status}</span>
                {d.status === "OPEN" && elevated && (
                  <button className="btn btn-ghost btn-sm" onClick={() => progressDispute(session!, d.id, "IN_PROGRESS").then(invalidate)}>
                    Start review
                  </button>
                )}
              </span>
            </div>
          ))}
        <div className="frow" style={{ marginTop: disputes.length ? 11 : 0 }}>
          <div className="field">
            <label>New dispute</label>
            <input value={disputeTitle} onChange={(e) => setDisputeTitle(e.target.value)} placeholder="Title" />
          </div>
          <div className="field">
            <label>Description (optional)</label>
            <input value={disputeDesc} onChange={(e) => setDisputeDesc(e.target.value)} placeholder="What is disputed" />
          </div>
          <div className="field" style={{ alignSelf: "end" }}>
            <button className="btn btn-ghost" disabled={openDisputeM.isPending || !disputeTitle.trim()} onClick={() => openDisputeM.mutate()}>
              Open dispute
            </button>
          </div>
        </div>
      </div>

      {/* Amendments & room change */}
      {elevated && (
        <div className="block">
          <BlockH>
            <FileEdit style={{ width: 13, height: 13 }} />
            Amendments &amp; room change (L2+)
          </BlockH>
          <div className="frow">
            <div className="field">
              <label>Amendment type</label>
              <select value={amendType} onChange={(e) => setAmendType(e.target.value)}>
                <option value="INCLUSION_CHANGE">Inclusion change</option>
                <option value="MEAL_PLAN_CHANGE">Meal plan change</option>
                <option value="DISCOUNT">Discount</option>
              </select>
            </div>
            <div className="field">
              <label>Reason</label>
              <input value={amendReason} onChange={(e) => setAmendReason(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>New terms summary</label>
            <input value={amendTerms} onChange={(e) => setAmendTerms(e.target.value)} />
          </div>
          <button className="btn btn-ghost btn-sm" disabled={amendM.isPending || !amendReason.trim() || !amendTerms.trim()} onClick={() => amendM.mutate()}>
            Record amendment
          </button>
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "10px 0 0" }}>
            Need a different room? Each room in the <b>Rooms in use</b> block above carries its own
            &ldquo;Change room&rdquo; — the swap happens right here, from tonight onward.
          </p>
        </div>
      )}

      {/* Early departure (post-check-in, terminal) — SIG-S7 Policy 36 */}
      <div className="block" style={{ borderColor: "#e2b3ac" }}>
        <BlockH>
          <AlertTriangle style={{ width: 13, height: 13 }} />
          Early departure
        </BlockH>
        <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 0, lineHeight: 1.5 }}>
          Guest is leaving before the booked checkout. Ends the stay now, posts the disclosed penalty on the
          live folio, releases the room and terminates the booking — there&rsquo;s no undo.
        </p>
        {isGm && (
          <label className="checkline" style={{ cursor: "pointer", marginBottom: 8 }}>
            <input type="checkbox" checked={earlyDepartWaiver} onChange={(e) => setEarlyDepartWaiver(e.target.checked)} />
            <span>Waive the early-departure penalty (GM authority)</span>
          </label>
        )}
        <button className="btn btn-ghost" style={{ borderColor: "#e2b3ac", color: "var(--stop)" }} onClick={() => setEarlyDepartOpen(true)}>
          Record early departure
        </button>
      </div>
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />

      {/* Posted-charge receipt (2026-08-17): what just landed on the folio, and for whom. */}
      <DeskSuccessModal
        open={!!postedInfo}
        title="Charge posted"
        subtitle={entry.id}
        lines={
          postedInfo
            ? [
                <>
                  <b>{money(postedInfo.amount, postedInfo.currency)}</b> — {postedInfo.description}
                </>,
                <>
                  {postedInfo.lineType === "F_AND_B" ? "F & B" : postedInfo.lineType} ·{" "}
                  {postedInfo.roomNumber ? `for Room ${postedInfo.roomNumber}` : "for the whole booking"}
                </>,
                "Service charge and GST companion lines post automatically alongside.",
              ]
            : []
        }
        onClose={() => setPostedInfo(null)}
      />

      <DeskConfirmModal
        open={earlyDepartOpen}
        tone="danger"
        title="Record early departure?"
        subtitle={entry.id}
        why="Ending an in-house stay early is terminal. Here is exactly what happens:"
        consequences={[
          "The stay ends now — the guest is checked out ahead of the booked date.",
          <>
            The disclosed early-departure <b>penalty</b>
            {earlyDepartWaiver ? " is waived (GM)" : " (if any) is posted on the live folio"}.
          </>,
          "The room is released to housekeeping.",
          "The booking becomes terminal — this cannot be undone.",
        ]}
        confirmLabel="Record early departure"
        cancelLabel="Keep the stay"
        pending={earlyDepartM.isPending}
        onConfirm={() => earlyDepartM.mutate()}
        onClose={() => setEarlyDepartOpen(false)}
      />
    </div>
  );
}
