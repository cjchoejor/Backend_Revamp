"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BedDouble, FileEdit, Handshake, KeyRound, Lock, Moon, Receipt, Scale } from "lucide-react";
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
import { getBillingSummary, issueRoomKey, returnRoomKey } from "@/lib/api/entries";
import type { HandoffChecklistItem } from "@/lib/api/handoffs";
import { money, moneyOrDash } from "@/lib/desk/workspace";
import { roomStayRangesByRoom } from "@/lib/desk/party-rooms";
import { DeskConfirmModal, DeskSuccessModal } from "./confirm-modal";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";
import { RoomCompositionSummary, hasRoomComposition } from "./room-composition-summary";
import { BedTypeEditor, InitialSelectionCell, RoomChangeControl } from "./room-change-control";

const BK = STAGE_ACTIONS.S7;

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
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
  const correctable = useMemo(
    () => folioLines.filter((l) => !l.description.toLowerCase().startsWith("sales tax") && !l.description.toLowerCase().startsWith("correction for")),
    [folioLines],
  );
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

      {/* Live folio */}
      <div className="block">
        <BlockH>
          <Receipt style={{ width: 13, height: 13 }} />
          Live folio
        </BlockH>
        <div className="folio" style={{ marginBottom: 12 }}>
          <div className="folio-h">
            Charges
            <span className="lk">
              <Lock />
              live · append-only
            </span>
          </div>
          {folioLines.length === 0 ? (
            <div className="fline">
              <span className="fl-d" style={{ color: "var(--ink-3)" }}>
                No charges yet
              </span>
            </div>
          ) : (
            folioLines.map((l) => {
              const sys = !!l.nightAuditRecordId;
              return (
                <div className="fline" key={l.id}>
                  <span className={`fl-mk mk ${sys ? "sys" : "cap"}`}>{sys ? "⚙" : "✎"}</span>
                  <span className="fl-d">
                    {l.description}
                    <small>
                      {l.lineType} · {l.chargeDate?.slice(0, 10)}
                      {sys ? " · audit" : ""}
                      {/* Which room the charge belongs to (2026-08-14) — blank = whole booking. */}
                      {l.roomId ? ` · Room ${roomNumberById.get(l.roomId) ?? "?"}` : ""}
                    </small>
                  </span>
                  <span className="fl-a">{money(l.amount, l.currency)}</span>
                </div>
              );
            })
          )}
          {/* Per-room charge subtotals (2026-08-14, operator request) — SERVER-summed in the
              billing-summary folio block, never added up here. Booking-wide lines get their
              own row so every line is accounted for in exactly one bucket. */}
          {perRoomCharges && perRoomCharges.length > 0 && (
            <>
              {perRoomCharges.map((r) => (
                <div className="fline" key={r.roomId} style={{ background: "var(--cream)" }}>
                  <span className="fl-mk mk sys">Σ</span>
                  <span className="fl-d">
                    Room {r.roomNumber ?? "?"} — charges so far
                    <small>{r.lineCount} line{r.lineCount === 1 ? "" : "s"}</small>
                  </span>
                  <span className="fl-a">{money(r.charges, currency)}</span>
                </div>
              ))}
              {unassignedCharges && (
                <div className="fline" style={{ background: "var(--cream)" }}>
                  <span className="fl-mk mk sys">Σ</span>
                  <span className="fl-d">
                    Whole booking (no room named)
                    <small>{unassignedCharges.lineCount} line{unassignedCharges.lineCount === 1 ? "" : "s"}</small>
                  </span>
                  <span className="fl-a">{money(unassignedCharges.charges, currency)}</span>
                </div>
              )}
            </>
          )}
          {/* The server owns the folio's balance; there is no sum-of-lines field, so the running
              total is the backend's outstandingBalance rather than a total added up here. */}
          <div className="fline total">
            <span className="fl-mk mk sys">⚙</span>
            <span className="fl-d">Balance due (from folio)</span>
            <span className="fl-a">{moneyOrDash(folio?.outstandingBalance, currency)}</span>
          </div>
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
            </p>
            <div className="field">
              <label>Which posted charge is wrong?</label>
              <select value={correctLineId} onChange={(e) => setCorrectLineId(e.target.value)}>
                <option value="">Choose a charge from the folio…</option>
                {correctable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.roomId ? `[Room ${roomNumberById.get(l.roomId) ?? "?"}] ` : ""}
                    {l.lineType} — {l.description} ({String(l.amount)})
                  </option>
                ))}
              </select>
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
