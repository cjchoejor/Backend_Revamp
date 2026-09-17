"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Maximize2, Minimize2, UserCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  changeBookingRoom,
  getRoomPlanHistory,
  listRoomChangeCandidates,
  type RoomChangeAdjustments,
  type RoomChangeCandidate,
} from "@/lib/api/entries";
import { listRooms, setRoomBedType } from "@/lib/api/rooms";
import { foldNightsToRangesLabel, mealPlanSummary, operativeRoomCompositions, roomNightsByRoom } from "@/lib/desk/party-rooms";
import { money } from "@/lib/desk/workspace";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import type { EntryDetail } from "@/types/api";
import { DeskConfirmModal } from "./confirm-modal";
import { RoomCompositionPlanner } from "./room-compositions-board";
import { NegotiationDiscountBar, type DiscountUnit } from "./room-compositions-table";

/**
 * In-place room change (2026-08-12, operator ruling): every room row on S5/S6/S7 carries a
 * "Change room" affordance that swaps ONLY that room, from the current page. The backend runs
 * the whole governed journey (new segment, availability re-checked the way S1 checks it, silent
 * re-quote, walk back to this stage) in one call — the desk never navigates away, and nothing
 * is sent to the guest unless the operator sends it.
 *
 * 2026-08-14 (operator request, third pass) — the panel borrows the S1 table's and S2 grid's
 * exact manners:
 *  - a ROOMS × NIGHTS table whose cells SAY their status ("Free" / "Reserved" / "Held" /
 *    "Blocked", S1's cell vocabulary — never blank), with an EXPAND control lifting the table
 *    to a full-screen layer (same `.rst-expandwrap` layer S1 uses; Escape closes) and a
 *    "Show names" toggle printing who holds each taken night in the cell itself;
 *  - the setup grid drives its meal columns the S2 way: plan CHIPS at the top (CP / MAP+L /
 *    MAP+D / AP) — a column exists while its chip is on or a row carries pax; switching a
 *    visible plan off zeroes it (a hidden column must not keep feeding the change) — plus an
 *    "Everyone on…" select that puts each new room's occupants on one plan.
 *
 * Selection: click a free cell to give that night to that room, row "All" for every night the
 * room is free, the current room's own row to KEEP nights (S5/S6). In-house (S7) the guest
 * moves ONCE: one room for all remaining nights.
 *
 * Authority (2026-08-13 ruling, mirrors p58): same-type L1+; any cross-type room needs FOM+
 * (L2+) — below that the cross-type cells are shown but locked.
 */

function bedLabel(t?: string | null) {
  if (!t) return "";
  return t.charAt(0) + t.slice(1).toLowerCase();
}

function bedPhrase(t?: string | null) {
  if (!t) return "";
  return `${bedLabel(t)}${t === "TWIN" ? " beds" : " bed"}`;
}

function levelRank(level?: string) {
  return level === "L4" ? 4 : level === "L3" ? 3 : level === "L2" ? 2 : level === "L1" ? 1 : 0;
}

function shortDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** S1's cell vocabulary — the cell always SAYS what it is, never a blank square. */
const CELL_LABEL: Record<RoomChangeCandidate["perNight"][number]["status"], string> = {
  FREE: "Free",
  RESERVED: "Reserved",
  HELD: "Held",
  BLOCKED: "Blocked",
  MAINTENANCE: "Maint.",
};

const CELL_TINT: Record<string, string> = {
  RESERVED: "rgba(179,89,58,0.16)",
  HELD: "rgba(192,138,62,0.16)",
  BLOCKED: "rgba(138,133,119,0.2)",
  MAINTENANCE: "rgba(138,133,119,0.2)",
};

const CELL_INK: Record<string, string> = {
  FREE: "#4c8a5c",
  RESERVED: "#a14e33",
  HELD: "#9a6e2e",
  BLOCKED: "#6f6a5e",
  MAINTENANCE: "#6f6a5e",
};

function nightWord(status: RoomChangeCandidate["perNight"][number]["status"]) {
  switch (status) {
    case "FREE":
      return "free";
    case "RESERVED":
      return "reserved";
    case "HELD":
      return "held";
    case "BLOCKED":
      return "blocked";
    case "MAINTENANCE":
      return "under maintenance";
  }
}

/** The bed dropdown is all that is left of the old per-room setup draft — every other field
 *  now lives in the S2 composition table (2026-08-19). */
type SetupDraft = { bed: string };

export function RoomChangeControl({
  entry,
  fromRoomId,
  fromRoomNumber,
  onChanged,
  compact,
}: {
  entry: EntryDetail;
  fromRoomId: string;
  fromRoomNumber: string;
  /** Parent's cache invalidation — the change touches the entry, quotes, timers, rooms. */
  onChanged: () => void;
  /** Renders the trigger as a small inline link-button (for dense room rows). */
  compact?: boolean;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  /** night ISO date → roomId holding it (the from-room itself = keep that night). */
  const [nightSel, setNightSel] = useState<Record<string, string>>({});
  /** Per NEW room setup drafts (strings so backspace/partial typing behaves). */
  const [setups, setSetups] = useState<Record<string, SetupDraft>>({});
  /** S1-style expanded layer + in-cell holder names. */
  const [expanded, setExpanded] = useState(false);
  const [showNames, setShowNames] = useState(false);
  /**
   * The setup section IS the S2 negotiation table (2026-08-19, operator request — "I need that
   * negotiation table exactly [as] in S2"): the real `RoomCompositionPlanner`, so the rooms just
   * selected are set up with the same grid, guest bands, meal columns, extra beds, per-room
   * NEGOTIATED RATES, SC/FOC toggles, live backend pricing — and the booking discount beside it.
   * Its emission is posted as `roomCompositions`, the full basis, instead of the old field-patch
   * `roomSetups`. Bed setup stays a separate `roomSetups` entry: it is a room-registry fact, not
   * a composition field, and the backend admits it alongside the table for exactly that reason.
   */
  const [repriceComps, setRepriceComps] = useState<RoomCompositionInput[]>([]);
  const [discountValue, setDiscountValue] = useState("");
  const [discountUnit, setDiscountUnit] = useState<DiscountUnit>("percent");
  const [discountBasis, setDiscountBasis] = useState("");

  const stage = entry.currentStage;
  const atS7 = stage === "S7";
  // Same-type swaps are open to the whole desk (L1+); cross-type (upgrade/downgrade) is FOM+.
  const canCrossType = levelRank(session?.actorLevel) >= 2;

  const candidatesQuery = useQuery({
    queryKey: ["room-change-candidates", entry.id, fromRoomId],
    queryFn: () => listRoomChangeCandidates(session!, entry.id, fromRoomId),
    enabled: !!session && open,
    staleTime: 30_000,
  });
  // Rooms catalog (shared app-wide key) — bed setups per room for the setup grid.
  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session && open,
  });
  const catalogById = useMemo(
    () => new Map((roomsCatalogQuery.data?.items ?? []).map((r) => [r.id, r])),
    [roomsCatalogQuery.data],
  );

  // Escape closes the expanded layer (same manners as the S1 table's layer).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // The from-room's carried setup — the operative quotation's composition row for this room.
  const fromComp = useMemo(() => {
    const comps = operativeRoomCompositions(entry);
    return comps?.find((c) => c.roomId === fromRoomId) ?? null;
  }, [entry, fromRoomId]);
  const fromOccupants =
    fromComp?.occupantCount ??
    (fromComp ? (fromComp.adultCount ?? 0) + (fromComp.cnb6To10Count ?? 0) + (fromComp.cnbUnder6Count ?? 0) : null);
  const fromCatalog = catalogById.get(fromRoomId) ?? null;

  const nights = useMemo(() => candidatesQuery.data?.substitutionNights ?? [], [candidatesQuery.data]);
  const candidates = candidatesQuery.data?.candidates ?? [];
  const candidateById = useMemo(() => new Map(candidates.map((c) => [c.roomId, c])), [candidates]);
  const sameTypeCandidates = candidates.filter((c) => c.sameType);
  const otherTypeCandidates = candidates.filter((c) => !c.sameType);

  // ── Selection derivations ──────────────────────────────────────────────────────────────────
  const allAssigned = nights.length > 0 && nights.every((d) => !!nightSel[d]);
  const keptNights = nights.filter((d) => nightSel[d] === fromRoomId);
  const selectedNewRooms = useMemo(() => {
    const seen: string[] = [];
    for (const d of nights) {
      const id = nightSel[d];
      if (id && id !== fromRoomId && !seen.includes(id)) seen.push(id);
    }
    return seen;
  }, [nights, nightSel, fromRoomId]);
  const nothingChanges = allAssigned && selectedNewRooms.length === 0;
  const crossTypeLocked = selectedNewRooms.some((id) => !(candidateById.get(id)?.sameType ?? true)) && !canCrossType;

  // ── The negotiation table's scope ──────────────────────────────────────────────────────────
  const level = session?.actorLevel ?? "L1";
  /**
   * Rates / FOC / SC waivers / the discount are a RATE REVISION on a confirmed booking: FOM
   * (L2+) before arrival, GM (L3+) in-house. Mirrors p58 `enforceRepriceAuthorityForStage` so
   * the cells explain themselves instead of the walk refusing after the re-entry committed.
   * In-house they lock outright — a per-night override cannot carry a rate, so nights already
   * posted to the folio would silently re-price.
   */
  const lockCommercial = atS7 || levelRank(level) < 2;
  /** What the carried row would look like on each newly selected room — the table's seed. */
  const seedComps = useMemo(() => {
    if (!fromComp) return [];
    return selectedNewRooms.map((id) => {
      const crossType = !(candidateById.get(id)?.sameType ?? true);
      // A cross-type move prices at the NEW type's own rate: the negotiation was for the old
      // type, and the backend's carry drops it — so the seed must not show it either.
      const { negotiatedRoomRate, ...rest } = fromComp;
      return { ...(crossType ? rest : fromComp), ...rest, roomId: id, ...(crossType ? {} : { negotiatedRoomRate }) };
    });
  }, [fromComp, selectedNewRooms, candidateById]);
  /** Every OTHER room of the booking, carried untouched — the table only shows what's moving. */
  const untouchedComps = useMemo(() => {
    const comps = operativeRoomCompositions(entry) ?? [];
    const moving = new Set([fromRoomId, ...selectedNewRooms]);
    return comps.filter((c) => !moving.has(c.roomId));
  }, [entry, fromRoomId, selectedNewRooms]);
  /**
   * Pre-flight seating check (2026-08-21, operator ruling): what the table would leave behind —
   * a night on which not everyone has a room, a new room with nobody in it. The backend seats
   * them automatically on save and says where; this says it BEFORE the click so an emptied row
   * is never a surprise. Mirrors the payload assembly in `buildPayload`.
   */
  const seatingPreview = useMemo(() => {
    if (!fromComp || selectedNewRooms.length === 0) return null;
    const table = new Map(repriceComps.map((c) => [c.roomId, c]));
    const rows: RoomCompositionInput[] = [
      ...untouchedComps,
      ...selectedNewRooms.map((id) => table.get(id) ?? seedComps.find((s) => s.roomId === id)).filter((c): c is RoomCompositionInput => !!c),
      ...(keptNights.length > 0 || atS7 ? [fromComp] : []),
    ];
    const party = (entry.adultCount ?? 0) + (entry.childAges?.length ?? 0) || Math.max(1, entry.guestCount ?? 1);
    const occ = (c?: RoomCompositionInput) => (c ? (c.adultCount ?? 0) + (c.cnb6To10Count ?? 0) + (c.cnbUnder6Count ?? 0) : 0);
    // The plan AFTER the change: every room's nights as today, the from-room's changed nights
    // handed to the rooms picked per night (the from-room keeps only the nights picked for it).
    const planned = new Map<string, Set<string>>();
    for (const [id, ns] of roomNightsByRoom(entry)) {
      planned.set(id, new Set(id === fromRoomId ? ns.filter((d) => !nights.includes(d)) : ns));
    }
    for (const d of nights) {
      const id = nightSel[d];
      if (!id) continue;
      planned.set(id, new Set([...(planned.get(id) ?? []), d]));
    }
    const shortNights = nights.filter((d) => {
      const sum = [...planned.entries()].filter(([, ns]) => ns.has(d)).reduce((acc, [id]) => acc + occ(rows.find((c) => c.roomId === id)), 0);
      return sum < party;
    });
    const emptyRooms = selectedNewRooms.filter((id) => occ(rows.find((c) => c.roomId === id)) === 0);
    return shortNights.length > 0 || emptyRooms.length > 0 ? { shortNights, emptyRooms } : null;
  }, [fromComp, selectedNewRooms, repriceComps, untouchedComps, seedComps, keptNights, atS7, entry, fromRoomId, nights, nightSel]);
  const carriedDiscount = useMemo(() => {
    const quotes = (entry.quotations ?? []).slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    for (const q of quotes) {
      const d = (q.commercialTerms as { requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis?: string } } | null)
        ?.requestedDiscount;
      if (d) return d;
    }
    return null;
  }, [entry.quotations]);
  // Seed the discount fields from the booking's live concession, once the panel opens.
  useEffect(() => {
    if (!open) return;
    setDiscountValue(
      carriedDiscount?.discountPercent != null
        ? String(carriedDiscount.discountPercent)
        : carriedDiscount?.discountAmount != null
          ? String(carriedDiscount.discountAmount)
          : "",
    );
    setDiscountUnit(carriedDiscount?.discountAmount != null ? "amount" : "percent");
    setDiscountBasis(carriedDiscount?.discountBasis ?? "");
  }, [open, carriedDiscount]);

  // Seed the bed dropdown the first time a room enters the selection; keep existing edits.
  // (Everything else the operator sets up is seeded into the composition table itself.)
  useEffect(() => {
    setSetups((prev) => {
      const next = { ...prev };
      let touched = false;
      for (const id of selectedNewRooms) {
        if (next[id]) continue;
        next[id] = { bed: catalogById.get(id)?.bedType ?? "" };
        touched = true;
      }
      return touched ? next : prev;
    });
  }, [selectedNewRooms, catalogById]);


  // ── Cell interactions ──────────────────────────────────────────────────────────────────────
  const freeOnNight = (c: RoomChangeCandidate, date: string) =>
    c.perNight.find((n) => n.date === date)?.status === "FREE";

  const toggleCell = (roomId: string, date: string) => {
    if (atS7) {
      selectWholeRow(roomId);
      return;
    }
    setNightSel((prev) => {
      const next = { ...prev };
      if (next[date] === roomId) delete next[date];
      else next[date] = roomId;
      return next;
    });
  };

  /** Row "All": take every night this room is free (S1's deliberately-partial select-all);
   *  if it already holds all those nights, clear them instead. */
  const selectWholeRow = (roomId: string) => {
    const isFrom = roomId === fromRoomId;
    const c = candidateById.get(roomId);
    const takable = nights.filter((d) => (isFrom ? true : c ? freeOnNight(c, d) : false));
    if (atS7 && !isFrom && takable.length < nights.length) return; // S7: one room, all nights
    setNightSel((prev) => {
      const holdsAll = takable.length > 0 && takable.every((d) => prev[d] === roomId);
      const next = { ...prev };
      for (const d of takable) {
        if (holdsAll) delete next[d];
        else next[d] = roomId;
      }
      return next;
    });
  };

  // ── Payload ────────────────────────────────────────────────────────────────────────────────
  const buildPayload = () => {
    // Bed setup only — every other field now comes from the composition table below, and the
    // backend admits a bedType-only setup alongside it (a registry fact, not a priced one).
    const roomSetups: Array<RoomChangeAdjustments & { roomId: string }> = [];
    for (const id of selectedNewRooms) {
      const bed = setups[id]?.bed;
      const cat = catalogById.get(id);
      if (bed && bed !== (cat?.bedType ?? "")) roomSetups.push({ roomId: id, bedType: bed });
    }

    /**
     * `roomCompositions` must describe EXACTLY the rooms the plan holds after the change — the
     * backend refuses a mismatch by name rather than silently dropping a room. That set is:
     * every untouched room, plus the newly selected ones, plus the from-room when it survives
     * (nights the guest keeps at S5/S6, or its already-slept nights in-house).
     */
    const fromSurvives = keptNights.length > 0 || atS7;
    const table = new Map(repriceComps.map((c) => [c.roomId, c]));
    const composed: RoomCompositionInput[] = [
      ...untouchedComps,
      ...selectedNewRooms.map((id) => table.get(id) ?? seedComps.find((s) => s.roomId === id)).filter(Boolean as unknown as (v: RoomCompositionInput | undefined) => v is RoomCompositionInput),
      ...(fromSurvives && fromComp ? [fromComp] : []),
    ];
    // Only send a table when there is one to send (a booking with no composition to carry keeps
    // the pre-2026-08-19 behaviour: the change carries whatever the backend resolves).
    const sendComps = !!fromComp && composed.length > 0;

    // The discount rides along ONLY when it actually moved and the operator may move it —
    // resending an unchanged one would re-measure it against THIS operator's ceiling and could
    // refuse a same-type swap on a booking carrying a GM-approved concession.
    const dNum = Number(discountValue);
    const dLive = Number.isFinite(dNum) && dNum > 0;
    const next: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null = dLive
      ? {
          ...(discountUnit === "percent" ? { discountPercent: dNum } : { discountAmount: dNum }),
          discountBasis: discountBasis.trim() || "Negotiated at the desk",
        }
      : null;
    const discountMoved =
      (next?.discountPercent ?? null) !== (carriedDiscount?.discountPercent ?? null) ||
      (next?.discountAmount ?? null) !== (carriedDiscount?.discountAmount ?? null) ||
      (!!next && !!carriedDiscount && (next.discountBasis ?? "") !== (carriedDiscount.discountBasis ?? ""));

    const uniform = selectedNewRooms.length === 1 && keptNights.length === 0;
    return {
      fromRoomId,
      ...(uniform
        ? { toRoomId: selectedNewRooms[0] }
        : { perNight: nights.map((d) => ({ date: d, roomId: nightSel[d] })) }),
      reason: reason.trim(),
      ...(roomSetups.length > 0 ? { roomSetups } : {}),
      ...(sendComps ? { roomCompositions: composed } : {}),
      ...(sendComps && !lockCommercial && discountMoved ? { requestedDiscount: next } : {}),
    };
  };

  const changeM = useMutation({
    mutationFn: () => changeBookingRoom(session!, entry.id, buildPayload()),
    onSuccess: (out) => {
      const dest = (out.toRooms?.length ? out.toRooms : [{ ...out.toRoom, nights: [] as string[] }])
        .map((r) => `${r.roomNumber}${r.nights.length > 0 && (out.toRooms?.length ?? 0) + (out.keptNights?.length ?? 0) > 1 ? ` (${r.nights.map(shortDate).join(", ")})` : ""}`)
        .join(" + ");
      const kept = out.keptNights?.length
        ? ` Keeps Room ${out.fromRoom.roomNumber} on ${out.keptNights.map(shortDate).join(", ")}.`
        : "";
      const beds = out.appliedBedTypes?.length
        ? ` Beds: ${out.appliedBedTypes.map((b) => `${b.roomNumber} → ${bedPhrase(b.bedType)}`).join(", ")}.`
        : "";
      const moved = `Room ${out.fromRoom.roomNumber} → ${dest}`;
      // The backend's seating repair, when the compositions did not seat everyone on their own.
      const seated = out.seating?.repaired && out.seating.lines.length ? ` Seating: ${out.seating.lines.join("; ")}.` : "";
      if (out.seating?.unresolved?.length) toast.warning(out.seating.unresolved.join(" · "), { duration: 12000 });
      if (out.walk.blocked) {
        toast.warning(
          `${moved} — the booking is at ${out.walk.reachedStage}, not back at this step yet: ${out.walk.blocked.message}`,
          { duration: 12000 },
        );
      } else if (out.pricing.delta != null && Math.abs(out.pricing.delta) >= 0.01) {
        const dir = out.pricing.delta > 0 ? "+" : "−";
        toast.success(
          `${moved} · new total ${money(out.pricing.newTotal)} (was ${money(out.pricing.priorTotal)}, ${dir}${money(Math.abs(out.pricing.delta))}).${kept}${beds}${seated} Nothing was sent to the guest — send the new quote only if they ask.`,
          { duration: 12000 },
        );
      } else {
        toast.success(`${moved} — price unchanged.${kept}${beds}${seated} Everything else about the booking carried.`, seated ? { duration: 12000 } : undefined);
      }
      setOpen(false);
      setExpanded(false);
      setNightSel({});
      setSetups({});
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["rooms-catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["room-change-candidates", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["room-plan-history", entry.id] });
      onChanged();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "The room change was refused"),
  });

  // ── Table pieces ───────────────────────────────────────────────────────────────────────────
  const stickyCol: React.CSSProperties = {
    position: "sticky",
    left: 0,
    background: "var(--panel-solid, #fdfaf3)",
    zIndex: 1,
    textAlign: "left",
    borderRight: "1px solid var(--line-2)",
    padding: "4px 8px",
    whiteSpace: "nowrap",
  };
  const cellW = showNames ? 92 : 68;
  const cellBase: React.CSSProperties = {
    minWidth: cellW,
    height: 30,
    padding: 0,
    borderBottom: "1px solid var(--line-2)",
    borderRight: "1px solid var(--line-2)",
    textAlign: "center",
    fontSize: 10,
  };

  /** First name + surname initial — enough to recognise, short enough for a cell. */
  const holderShort = (name: string | null | undefined) => {
    if (!name) return null;
    const parts = name.trim().split(/\s+/);
    return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  };

  const roomLabel = (num: string, typeName: string | null | undefined, bed: string | null | undefined, withType: boolean) => (
    <>
      <span style={{ fontWeight: 600 }}>{num}</span>
      {withType && typeName ? <span style={{ color: "var(--ink-3)" }}> · {typeName}</span> : null}
      {bed ? <span style={{ color: "var(--ink-3)" }}> · {bedPhrase(bed)}</span> : null}
    </>
  );

  const allButton = (roomId: string, enabled: boolean, title: string) => (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={!enabled}
      onClick={() => selectWholeRow(roomId)}
      title={title}
      style={{ fontSize: 10, padding: "1px 6px", marginLeft: 6, opacity: enabled ? 1 : 0.4 }}
    >
      All
    </button>
  );

  const candidateRow = (c: RoomChangeCandidate, withType: boolean) => {
    const rowLocked = !c.sameType && !canCrossType;
    const freeAll = c.freeNightCount >= nights.length;
    const allEnabled = !rowLocked && (atS7 ? freeAll : c.freeNightCount > 0);
    return (
      <tr key={c.roomId} style={rowLocked ? { opacity: 0.55 } : undefined}>
        <td style={stickyCol}>
          {roomLabel(c.roomNumber, c.roomTypeName, c.bedType, withType)}
          {c.isDeficient && (
            <span className="tag warn" style={{ marginLeft: 6, fontSize: 9.5 }} title="Known deficiency — make sure the guest accepts it">
              deficient
            </span>
          )}
          {rowLocked && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-3)" }}>needs FOM</span>}
          {allButton(
            c.roomId,
            allEnabled,
            atS7
              ? freeAll
                ? `Move to Room ${c.roomNumber} for all remaining nights`
                : "In-house the guest moves to one room for ALL remaining nights — this room is not free on every night"
              : `Take every night Room ${c.roomNumber} is free`,
          )}
        </td>
        {nights.map((date) => {
          const n = c.perNight.find((p) => p.date === date);
          const status = n?.status ?? "FREE";
          const isFree = status === "FREE";
          const selected = nightSel[date] === c.roomId;
          const clickable = isFree && !rowLocked && (!atS7 || c.freeNightCount >= nights.length);
          const holder = n?.claimedBy?.guestName ? ` (${n.claimedBy.guestName})` : "";
          // The cell SAYS its status (S1 vocabulary); with names on, the holder replaces the
          // status word on taken nights — the tint carries the colour, the text the identity.
          const text = selected
            ? "✓ picked"
            : showNames && n?.claimedBy?.guestName
              ? holderShort(n.claimedBy.guestName)
              : CELL_LABEL[status];
          return (
            <td key={date} style={{ ...cellBase, background: selected ? "#4c8a5c" : (CELL_TINT[status] ?? "rgba(76,138,92,0.07)") }}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => toggleCell(c.roomId, date)}
                title={
                  rowLocked
                    ? "Cross-type change needs FOM (L2+)"
                    : `${shortDate(date)} — ${nightWord(status)}${holder}${clickable ? (selected ? " · click to unpick" : " · click to pick") : ""}`
                }
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "transparent",
                  cursor: clickable ? "pointer" : "default",
                  color: selected ? "#fff" : (CELL_INK[status] ?? "var(--ink-3)"),
                  fontSize: 10,
                  fontWeight: selected ? 700 : isFree ? 500 : 400,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {text}
              </button>
            </td>
          );
        })}
      </tr>
    );
  };

  const groupRow = (label: string) => (
    <tr>
      <td
        colSpan={1 + nights.length}
        style={{
          padding: "3px 8px",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          color: "var(--ink-3)",
          background: "rgba(0,0,0,0.035)",
          borderBottom: "1px solid var(--line-2)",
          position: "sticky",
          left: 0,
        }}
      >
        {label}
      </td>
    </tr>
  );

  // ── Setup grid helpers ─────────────────────────────────────────────────────────────────────
  const setupInput = (roomId: string, key: keyof SetupDraft, width = 52) => (
    <input
      inputMode="numeric"
      value={setups[roomId]?.[key] ?? ""}
      onChange={(e) => setSetups((prev) => ({ ...prev, [roomId]: { ...prev[roomId], [key]: e.target.value } }))}
      style={{ width, fontSize: 11.5, padding: "3px 6px", textAlign: "center" }}
    />
  );

  const nightsOfRoom = (roomId: string) => nights.filter((d) => nightSel[d] === roomId);

  const summaryStrip = nights.map((d) => {
    const id = nightSel[d];
    const label = !id
      ? "choose"
      : id === fromRoomId
        ? `keep ${fromRoomNumber}`
        : (candidateById.get(id)?.roomNumber ?? "?");
    return { date: d, label, missing: !id };
  });

  const setupHeadCell = (label: string, title?: string) => (
    <th
      key={label}
      title={title}
      style={{ padding: "3px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--ink-3)", borderBottom: "1px solid var(--line-2)", textAlign: "left" }}
    >
      {label}
    </th>
  );

  return (
    <div style={compact && !expanded ? { display: "inline-block" } : undefined}>
      <button
        className="btn btn-ghost btn-sm"
        style={compact ? { fontSize: 11, padding: "2px 8px" } : undefined}
        onClick={() => {
          setOpen((v) => !v);
          setExpanded(false);
        }}
        title="Swap only this room — the rest of the booking carries. The backend re-checks availability night by night and re-prices as if the booking were re-made, without leaving this page."
      >
        <ArrowLeftRight style={{ width: 11, height: 11 }} />
        {open ? "Cancel change" : `Change room ${fromRoomNumber}`}
      </button>

      {open && (
        <div
          className={expanded ? "rst-expandwrap on" : undefined}
          style={{
            marginTop: expanded ? 0 : 8,
            border: expanded ? "none" : "1px solid var(--line-2)",
            borderRadius: expanded ? 0 : 10,
            padding: expanded ? undefined : "10px 12px",
            background: expanded ? undefined : "var(--panel, rgba(255,255,255,0.5))",
            maxWidth: expanded ? undefined : 720,
          }}
        >
          {expanded && (
            <div className="rst-expandbar">
              <b>
                Move Room {fromRoomNumber} · {nights.length} night{nights.length === 1 ? "" : "s"}
              </b>
              <span className="ln" />
              <button
                type="button"
                className={`btn btn-ghost btn-sm${showNames ? " on" : ""}`}
                onClick={() => setShowNames((v) => !v)}
                title={showNames ? "Back to status words in the cells" : "Print who holds each taken night in the cell itself"}
              >
                {showNames ? <UserCheck style={{ width: 13, height: 13 }} /> : <Users style={{ width: 13, height: 13 }} />}
                {showNames ? "Names on" : "Show names"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)}>
                <Minimize2 style={{ width: 13, height: 13 }} /> Close
              </button>
            </div>
          )}

          {!expanded && (
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Move Room {fromRoomNumber}
              {atS7 ? " — from tonight onward" : ""}
              {nights.length > 0 ? ` · ${nights.length} night${nights.length === 1 ? "" : "s"} (${shortDate(nights[0])} – ${shortDate(nights[nights.length - 1])})` : ""}
            </div>
          )}
          {!expanded && (
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 8px", lineHeight: 1.5 }}>
              Pick a room for each night, exactly like the S1 table — the same room for the whole stay (row&nbsp;“All”), or
              different rooms on different nights{atS7 ? "" : ", or keep the current room for some nights"}. Guests, payments
              and paperwork carry unchanged; the backend re-checks availability and re-prices as if the booking were set up
              fresh, and comes straight back to this step. Nothing is sent to the guest unless you send it.
              {atS7 ? " In-house the guest moves once — one room for all remaining nights; nights already slept stay billed on the current room." : ""}
              {" "}A same-type swap needs no approval; any different-type room (upgrade or downgrade) needs FOM (L2+).
            </p>
          )}

          {/* What the room is set up as today — the baseline the setup grid carries from. */}
          {(fromComp || fromCatalog?.bedType) && (
            <div className="fact" style={{ display: "block", padding: "6px 10px", fontSize: 11.5, marginBottom: 8, lineHeight: 1.5, flex: "0 0 auto" }}>
              <strong>Room {fromRoomNumber} today:</strong>{" "}
              {[
                fromOccupants != null && fromOccupants > 0 ? `${fromOccupants} guest${fromOccupants === 1 ? "" : "s"}` : null,
                fromComp ? mealPlanSummary(fromComp) : null,
                fromComp ? `${fromComp.extraBedCount ?? 0} extra bed${(fromComp.extraBedCount ?? 0) === 1 ? "" : "s"}` : null,
                fromCatalog?.bedType ? bedPhrase(fromCatalog.bedType) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}

          {candidatesQuery.isLoading && <p style={{ fontSize: 12, color: "var(--ink-3)" }}>Checking availability night by night…</p>}
          {candidatesQuery.isError && (
            <p style={{ fontSize: 12, color: "var(--stop)" }}>
              {candidatesQuery.error instanceof ApiError ? candidatesQuery.error.message : "Could not load the available rooms"}
            </p>
          )}

          {candidates.length > 0 && nights.length > 0 && (
            <div style={{ marginBottom: 8, flex: "0 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
              {!expanded && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginBottom: 2 }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setExpanded(true)}
                    title="Lift the table to the full screen — more rooms and nights on screen, with holder names available in-cell"
                  >
                    <Maximize2 style={{ width: 12, height: 12 }} /> Expand
                  </button>
                </div>
              )}
              <div
                style={{
                  maxHeight: expanded ? "calc(100vh - 320px)" : 280,
                  overflow: "auto",
                  border: "1px solid var(--line-2)",
                  borderRadius: 8,
                }}
              >
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11.5 }}>
                  <thead>
                    <tr>
                      <th style={{ ...stickyCol, top: 0, zIndex: 2, fontSize: 10.5, color: "var(--ink-3)" }}>Room</th>
                      {nights.map((d) => (
                        <th
                          key={d}
                          style={{
                            ...cellBase,
                            position: "sticky",
                            top: 0,
                            background: "var(--panel-solid, #fdfaf3)",
                            zIndex: 1,
                            fontSize: 10.5,
                            fontWeight: 600,
                            height: 26,
                          }}
                        >
                          {shortDate(d)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Current room — keep nights (S5/S6) */}
                    <tr style={{ background: "rgba(76,138,92,0.05)" }}>
                      <td style={stickyCol}>
                        {roomLabel(fromRoomNumber, candidatesQuery.data?.fromRoom.roomTypeName, fromCatalog?.bedType ?? null, false)}
                        <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-3)" }}>current room</span>
                        {!atS7 && allButton(fromRoomId, true, "Keep the current room for every night (then nothing changes)")}
                      </td>
                      {nights.map((date) => {
                        const selected = nightSel[date] === fromRoomId;
                        return (
                          <td key={date} style={{ ...cellBase, background: selected ? "#7d9a63" : "rgba(76,138,92,0.06)" }}>
                            <button
                              type="button"
                              disabled={atS7}
                              onClick={() => toggleCell(fromRoomId, date)}
                              title={
                                atS7
                                  ? "In-house the guest moves once — keeping some nights isn't available mid-stay"
                                  : `${shortDate(date)} — the guest's current room${selected ? " · kept (click to unpick)" : " · click to KEEP this night"}`
                              }
                              style={{
                                width: "100%",
                                height: "100%",
                                border: "none",
                                background: "transparent",
                                cursor: atS7 ? "default" : "pointer",
                                color: selected ? "#fff" : "var(--ink-3)",
                                fontSize: 10,
                                fontWeight: selected ? 700 : 400,
                              }}
                            >
                              {selected ? "✓ keep" : "Current"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                    {sameTypeCandidates.length > 0 && groupRow(`Same type — ${candidatesQuery.data?.fromRoom.roomTypeName ?? "same rate"} · anyone can swap`)}
                    {sameTypeCandidates.map((c) => candidateRow(c, false))}
                    {otherTypeCandidates.length > 0 &&
                      groupRow(canCrossType ? "Different type — upgrade/downgrade, price will change" : "Different type — upgrade/downgrade · needs FOM (L2+)")}
                    {otherTypeCandidates.map((c) => candidateRow(c, true))}
                  </tbody>
                </table>
              </div>

              {/* Which room holds each night, stated with dates. */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginTop: 6, flex: "0 0 auto" }}>
                {summaryStrip.map((s) => (
                  <span
                    key={s.date}
                    className={`tag${s.missing ? " warn" : ""}`}
                    style={{ fontSize: 10.5 }}
                    title={s.missing ? "This night has no room yet — pick a cell in its column" : undefined}
                  >
                    {shortDate(s.date)} → {s.label}
                  </span>
                ))}
                {nothingChanges && (
                  <span style={{ fontSize: 11, color: "var(--stop)" }}>Every night keeps the current room — nothing changes.</span>
                )}
              </div>
            </div>
          )}

          {/* THE S2 NEGOTIATION TABLE (2026-08-19, operator request — "I need that negotiation
              table exactly [as] in S2"). Not a lookalike: this is `RoomCompositionPlanner`
              itself — the same grid and guest board, the same guest bands and meal chips, the
              same per-room negotiated-rate columns with their reference-rate anchors and live
              backend pricing, the same Σ footer and LIVE TOTAL — scoped to the rooms just
              selected and seeded from what Room {fromRoomNumber} carries today. The booking
              discount sits above it, exactly as at S2.

              Rates / FOC / SC waivers / the discount are a rate revision on a confirmed booking,
              so they lock below FOM and in-house entirely (p58, mirrored here). Bed setup stays
              its own dropdown per row below — a registry fact, not a priced one. */}
          {selectedNewRooms.length > 0 && fromComp && (
            <div style={{ border: "1px dashed var(--line-2)", borderRadius: 8, padding: "8px 10px", marginBottom: 8, flex: "0 0 auto" }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>
                Set up the new room{selectedNewRooms.length === 1 ? "" : "s"} — carried from Room {fromRoomNumber}, change anything the guest wants
              </div>
              {lockCommercial && (
                <p style={{ fontSize: 11, color: "var(--warn)", margin: "0 0 8px", lineHeight: 1.5 }}>
                  {atS7
                    ? "Rates, FOC / service-charge waivers and the discount are locked while the guest is in-house — a mid-stay rate revision is the GM's call through re-entry. Guests, meals and extra beds are yours to change."
                    : `Rates, FOC / service-charge waivers and the discount need FOM authority (L2+) on a confirmed booking — you are ${level}. Guests, meals and extra beds are yours to change.`}
                </p>
              )}
              <NegotiationDiscountBar
                discountValue={discountValue}
                discountUnit={discountUnit}
                discountBasis={discountBasis}
                lockCommercial={lockCommercial}
                onDiscountChange={(patch) => {
                  if (patch.value !== undefined) setDiscountValue(patch.value);
                  if (patch.unit !== undefined) setDiscountUnit(patch.unit);
                  if (patch.basis !== undefined) setDiscountBasis(patch.basis);
                }}
              />
              <RoomCompositionPlanner
                sealedRoomIds={selectedNewRooms}
                entryCheckIn={entry.checkInDate ?? null}
                entryCheckOut={entry.checkOutDate ?? null}
                entryAdults={entry.adultCount ?? entry.guestCount ?? null}
                entryChildAges={entry.childAges ?? null}
                entryId={entry.id}
                lockCommercial={lockCommercial}
                initialCompositions={seedComps}
                onChange={setRepriceComps}
              />
              {/* Bed setup per selected room — the one thing the composition table has no column
                  for, because it describes the ROOM's beds rather than the booking's terms. */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Bed setup</span>
                {selectedNewRooms.map((id) => {
                  const c = candidateById.get(id);
                  const cat = catalogById.get(id);
                  const bedOptions = cat?.allowedBedTypes?.length ? cat.allowedBedTypes : (roomsCatalogQuery.data?.bedTypes ?? []);
                  const d = setups[id];
                  return (
                    <label key={id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5 }}>
                      <b>{c?.roomNumber ?? "?"}</b>
                      <select
                        value={d?.bed ?? ""}
                        onChange={(e) => setSetups((prev) => ({ ...prev, [id]: { ...prev[id], bed: e.target.value } }))}
                        title="Physical bed setup for this room — only the setups its own beds can be arranged into"
                        style={{ width: 104, fontSize: 11.5, padding: "3px 6px" }}
                      >
                        {!d?.bed && <option value="">Keep as is</option>}
                        {bedOptions.map((t) => (
                          <option key={t} value={t}>
                            {t === "TWIN" ? "Twin beds" : `${bedLabel(t)} bed`}
                          </option>
                        ))}
                        {d?.bed && !bedOptions.includes(d.bed) && <option value={d.bed}>{bedPhrase(d.bed)}</option>}
                      </select>
                    </label>
                  );
                })}
                {keptNights.length > 0 && (
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    Room {fromRoomNumber} keeps its current setup for the {keptNights.length} night
                    {keptNights.length === 1 ? "" : "s"} the guest stays in it ({foldNightsToRangesLabel(keptNights)}).
                  </span>
                )}
              </div>
            </div>
          )}
          {seatingPreview && (
            <p
              className="fact"
              style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginBottom: 8, border: "1px solid var(--warn)", background: "var(--warn-t)" }}
            >
              {seatingPreview.emptyRooms.length > 0 &&
                `Room ${seatingPreview.emptyRooms.map((id) => candidateById.get(id)?.roomNumber ?? "?").join(", ")} would have no guests. `}
              {seatingPreview.shortNights.length > 0 &&
                `Not everyone would have a room on ${foldNightsToRangesLabel(seatingPreview.shortNights)}. `}
              On save the guests are seated automatically — into the emptiest room with space on every night — and the
              confirmation says where.
            </p>
          )}
          {/* A booking with no per-room composition has nothing to set up — the swap still runs. */}
          {selectedNewRooms.length > 0 && !fromComp && (
            <p className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12, width: "100%", marginBottom: 8 }}>
              This booking has no per-room composition recorded (a legacy or flat-priced quote), so there is
              nothing to set up here — the room swap itself still runs and re-prices.
            </p>
          )}

          {candidates.length > 0 && (
            <div className="frow" style={{ alignItems: "flex-end", gap: 10, flexWrap: "wrap", flex: "0 0 auto" }}>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>Reason (recorded on the audit trail — one word is fine)</label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. aircon fault in 302" />
              </div>
              <div className="field">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={
                    changeM.isPending ||
                    !allAssigned ||
                    nothingChanges ||
                    crossTypeLocked ||
                    reason.trim().length === 0
                  }
                  onClick={() => changeM.mutate()}
                  title={
                    !allAssigned
                      ? "Every night needs a room first"
                      : nothingChanges
                        ? "Every night keeps the current room — nothing changes"
                        : crossTypeLocked
                          ? "A different-type room is selected — needs FOM (L2+)"
                          : reason.trim().length === 0
                            ? "Type a reason first — one word is fine"
                            : undefined
                  }
                >
                  {changeM.isPending
                    ? "Changing…"
                    : selectedNewRooms.length > 1
                      ? `Move to ${selectedNewRooms.length} rooms`
                      : selectedNewRooms.length === 1
                        ? `Swap to Room ${candidateById.get(selectedNewRooms[0])?.roomNumber ?? ""}`
                        : "Swap room"}
                </button>
              </div>
            </div>
          )}

          {selectedNewRooms.some((id) => !(candidateById.get(id)?.sameType ?? true)) && canCrossType && (
            <div className="fact b-transit" style={{ marginTop: 8, padding: "6px 10px", fontSize: 11.5, display: "block", lineHeight: 1.5, flex: "0 0 auto" }}>
              A different-type room is selected, so the stay re-prices at each room&apos;s own rate — the new total (and the
              difference) shows the moment the swap completes. The bill already sent and the advance already paid stand; a
              fresh quote exists silently and goes out only if the guest asks for it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Initially selected" cell (2026-08-13, operator request): every S5–S7 room row keeps stating
 * what the FIRST selection was — room and bed setup as sealed at Inquiry — permanently, so a
 * room change or a bed-type change never erases where the booking started. Reads the
 * backend-derived room-plan history (first sealed config + room-change chain + bed-type
 * traces); nothing is computed client-side. Amber when the room or the bed has moved since.
 */
export function InitialSelectionCell({ entryId, roomId }: { entryId: string; roomId: string }) {
  const { session } = useSession();
  const historyQuery = useQuery({
    queryKey: ["room-plan-history", entryId],
    queryFn: () => getRoomPlanHistory(session!, entryId),
    enabled: !!session,
    staleTime: 60_000,
  });

  const item = historyQuery.data?.rooms.find((r) => r.currentRoomId === roomId) ?? null;
  if (!item) return null;

  const changed = item.roomChanged || item.bedTypeChanged;
  const label = item.initialRoomNumber
    ? `Room ${item.initialRoomNumber}${item.initialBedType ? ` · ${bedLabel(item.initialBedType)}${item.initialBedType === "TWIN" ? " beds" : " bed"}` : ""}`
    : "not recorded";

  const titleBits: string[] = [];
  if (item.initialRoomNumber) {
    titleBits.push(
      `First selection: Room ${item.initialRoomNumber}${item.initialRoomTypeName ? ` (${item.initialRoomTypeName})` : ""}${
        item.initialBedType ? `, ${bedLabel(item.initialBedType)} bed setup` : ""
      }`,
    );
  } else {
    titleBits.push("The first selection predates the room-change record — origin unknown");
  }
  for (const c of item.changes) {
    titleBits.push(
      `Changed ${shortDate(c.at)}: Room ${c.fromRoomNumber ?? "?"} → ${c.toRoomNumber ?? "?"}${c.reason ? ` (${c.reason})` : ""}`,
    );
  }
  if (item.bedTypeChanged) {
    titleBits.push(`Bed setup was ${bedLabel(item.initialBedType)} at selection — now ${bedLabel(item.currentBedType)}`);
  }

  return (
    <span
      className={`tag${changed ? " warn" : ""}`}
      title={titleBits.join("\n")}
      style={{ whiteSpace: "nowrap" }}
    >
      Initially: {label}
    </span>
  );
}

/**
 * Bed-type dropdown, extracted from the S5 pattern so S6/S7 room rows carry it too
 * (2026-08-12, operator request: bed type editable S5–S7). Self-contained: reads the shared
 * rooms catalog (same query key app-wide) and writes through the L1 bed-type endpoint; each
 * room offers only the setups its own type carries (`allowedBedTypes`, server-derived).
 */
export function BedTypeEditor({ roomId }: { roomId: string }) {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });

  const room = useMemo(
    () => (roomsCatalogQuery.data?.items ?? []).find((r) => r.id === roomId) ?? null,
    [roomsCatalogQuery.data, roomId],
  );
  const vocabulary = useMemo(() => {
    const all = new Set<string>();
    for (const r of roomsCatalogQuery.data?.items ?? []) if (r.bedType) all.add(r.bedType);
    return [...all].sort();
  }, [roomsCatalogQuery.data]);

  const bedTypeM = useMutation({
    mutationFn: (bedType: string) => setRoomBedType(session!, roomId, bedType),
    onSuccess: (r) => {
      toast.success(`Room ${r.roomNumber} set to ${r.bedType === "TWIN" ? "Twin beds" : `${bedLabel(r.bedType)} bed`}`);
      void queryClient.invalidateQueries({ queryKey: ["rooms-catalog"] });
      // The "Initially" cells compare against the live registry — keep them honest.
      void queryClient.invalidateQueries({ queryKey: ["room-plan-history"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Could not change the bed type"),
  });

  if (!room) return null;
  const current = room.bedType ?? "";
  const options = room.allowedBedTypes?.length ? room.allowedBedTypes : vocabulary;

  return (
    <select
      value={current}
      disabled={bedTypeM.isPending}
      onChange={(e) => {
        if (e.target.value) bedTypeM.mutate(e.target.value);
      }}
      title="Physical bed setup of this room — the options are the setups this room's type carries; changing it updates the room registry (recorded)"
      style={{ width: 108, fontSize: 11.5, padding: "3px 6px" }}
    >
      {!current && <option value="">Set beds…</option>}
      {options.map((t) => (
        <option key={t} value={t}>
          {t === "TWIN" ? "Twin beds" : `${bedLabel(t)} bed`}
        </option>
      ))}
      {current && !options.includes(current) && (
        <option value={current}>{current === "TWIN" ? "Twin beds" : `${bedLabel(current)} bed`}</option>
      )}
    </select>
  );
}

/**
 * Extra-bed selector on every S5–S7 room row (2026-08-19, operator request — "right now it only
 * shows if it's selected or not"). The count lives on the room's composition row of the OPERATIVE
 * quotation, and once the booking is frozen that row is commercial terms — so changing it is a
 * SETUP-ONLY change through the same governed journey a room change takes (`POST /room-change`
 * with `adjustments` and no target room): new segment, silent re-price at the current extra-bed
 * rate, straight back to this step. In-house (S7) the new count applies from TONIGHT — slept
 * nights keep the old count on the bill. The consequence modal says exactly that, with the
 * reason prefilled and editable, before anything commits. No money is computed here: the toast
 * prints the server's own prior / new total and delta.
 *
 * Renders nothing on bookings without a per-room composition (legacy imports) — same as the
 * read-only tag it replaces, since "no extra bed" must be a recorded answer, not an absence.
 */
export function ExtraBedEditor({
  entry,
  roomId,
  onChanged,
}: {
  entry: EntryDetail;
  roomId: string;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });
  const room = useMemo(
    () => (roomsCatalogQuery.data?.items ?? []).find((r) => r.id === roomId) ?? null,
    [roomsCatalogQuery.data, roomId],
  );
  const comp = useMemo(
    () => (operativeRoomCompositions(entry) ?? []).find((c) => c.roomId === roomId) ?? null,
    [entry, roomId],
  );
  const [asked, setAsked] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  const roomNumber = room?.roomNumber ?? comp?.roomId?.slice(0, 6) ?? roomId.slice(0, 6);
  const current = comp?.extraBedCount ?? 0;
  const inHouse = String(entry.currentStage) === "S7";
  // The type's ceiling (registry) — an auto-added p78 bed above it stays visible as the current value.
  const maxExtraBeds = room?.roomType?.maxExtraBeds ?? null;
  const ceiling = Math.max(maxExtraBeds ?? 0, current);

  const changeM = useMutation({
    mutationFn: (n: number) =>
      changeBookingRoom(session!, entry.id, {
        fromRoomId: roomId,
        reason: reason.trim() || `Extra beds on Room ${roomNumber}: ${current} → ${n}`,
        adjustments: { extraBedCount: n },
      }),
    onSuccess: (out, n) => {
      const what = `Room ${out.fromRoom.roomNumber} · ${n === 0 ? "no extra bed" : `${n} extra bed${n === 1 ? "" : "s"}`}${
        inHouse ? " from tonight" : ""
      }`;
      if (out.walk.blocked) {
        toast.warning(
          `${what} — the booking is at ${out.walk.reachedStage}, not back at this step yet: ${out.walk.blocked.message}`,
          { duration: 12000 },
        );
      } else if (out.pricing.delta != null && Math.abs(out.pricing.delta) >= 0.01) {
        const dir = out.pricing.delta > 0 ? "+" : "−";
        toast.success(
          `${what} · new total ${money(out.pricing.newTotal)} (was ${money(out.pricing.priorTotal)}, ${dir}${money(Math.abs(out.pricing.delta))}). Nothing was sent to the guest.`,
          { duration: 10000 },
        );
      } else {
        toast.success(`${what} — recorded; the price did not move.`);
      }
      setAsked(null);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["room-change-candidates", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["room-plan-history", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["billing-summary", entry.id] });
      onChanged();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "The extra-bed change was refused");
      setAsked(null);
    },
  });

  if (!comp) return null;

  const label = (n: number) => (n === 0 ? "No extra bed" : `${n} extra bed${n === 1 ? "" : "s"}`);
  const options = Array.from({ length: ceiling + 1 }, (_, i) => i);
  const locked = ceiling === 0;

  return (
    <>
      <select
        value={current}
        disabled={changeM.isPending || locked}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isInteger(n) || n === current) return;
          setAsked(n);
          setReason(`Extra beds on Room ${roomNumber}: ${current} → ${n}`);
        }}
        title={
          locked
            ? `${room?.roomType?.name ?? "This room type"} takes no extra bed`
            : `Extra beds on this room's composition${
                comp.negotiatedExtraBedRate != null ? ` · negotiated ${money(comp.negotiatedExtraBedRate, "BTN")}/night` : ""
              } — changing it re-prices the stay${inHouse ? " from tonight" : ""}${
                maxExtraBeds != null ? ` (up to ${maxExtraBeds} for this type)` : ""
              }`
        }
        style={{ width: 118, fontSize: 11.5, padding: "3px 6px", color: current === 0 ? "var(--ink-3)" : undefined }}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {label(n)}
          </option>
        ))}
      </select>
      <DeskConfirmModal
        open={asked != null}
        title={`Change extra beds on Room ${roomNumber}`}
        subtitle={`${label(current)} → ${asked == null ? "" : label(asked).toLowerCase()}${inHouse ? " · from tonight" : " · for the stay"}`}
        why={
          <span style={{ display: "inline-flex", flexDirection: "column", gap: 6, width: "100%" }}>
            <span>
              The extra bed is part of the booking's priced terms, so this re-prices the stay at the current
              extra-bed rate — the same governed walk a room change takes.
            </span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ whiteSpace: "nowrap" }}>Reason</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={`Extra beds on Room ${roomNumber}: ${current} → ${asked ?? ""}`}
                style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
                autoFocus
              />
            </label>
          </span>
        }
        consequences={[
          "A new segment opens; the booking is re-priced silently and walks straight back to this step — nothing is sent to the guest unless you send it.",
          inHouse
            ? "Applies from tonight — the nights already slept keep the old count on the bill."
            : "Applies to every night of the stay.",
          "The header total and the per-room breakdown move to the new figure.",
        ]}
        confirmLabel="Apply"
        pending={changeM.isPending}
        onConfirm={() => {
          if (asked != null) changeM.mutate(asked);
        }}
        onClose={() => {
          if (!changeM.isPending) setAsked(null);
        }}
      />
    </>
  );
}
