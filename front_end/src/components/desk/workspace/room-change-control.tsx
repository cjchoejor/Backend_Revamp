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
import { foldNightsToRangesLabel, mealPlanSummary, operativeRoomCompositions } from "@/lib/desk/party-rooms";
import { money } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";

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

/** Whole-number draft parser — empty/invalid reads as "not set". */
function parseCount(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

type SetupDraft = { bed: string; eb: string; cp: string; mapl: string; mapd: string; ap: string };
type MealKey = "cp" | "mapl" | "mapd" | "ap";

const MEAL_KEYS: MealKey[] = ["cp", "mapl", "mapd", "ap"];
const MEAL_META: Record<MealKey, { chip: string; head: string; title: string }> = {
  cp: { chip: "CP", head: "CP", title: "CP · breakfast" },
  mapl: { chip: "MAP +L", head: "MAP +L", title: "MAP · breakfast + lunch" },
  mapd: { chip: "MAP +D", head: "MAP +D", title: "MAP · breakfast + dinner" },
  ap: { chip: "AP", head: "AP", title: "AP · all meals" },
};

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
  /** S2-style plan chips — a meal column shows while its chip is on or a row carries pax. */
  const [activeMealPlans, setActiveMealPlans] = useState<Set<MealKey>>(new Set());

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

  // Seed a setup draft the first time a room enters the selection; keep existing edits.
  useEffect(() => {
    setSetups((prev) => {
      const next = { ...prev };
      let touched = false;
      for (const id of selectedNewRooms) {
        if (next[id]) continue;
        const cat = catalogById.get(id);
        next[id] = {
          bed: cat?.bedType ?? "",
          eb: fromComp ? String(fromComp.extraBedCount ?? 0) : "",
          cp: fromComp ? String(fromComp.mealPlanCpCount ?? 0) : "",
          mapl: fromComp ? String(fromComp.mealPlanMaplCount ?? 0) : "",
          mapd: fromComp ? String(fromComp.mealPlanMapdCount ?? 0) : "",
          ap: fromComp ? String(fromComp.mealPlanApCount ?? 0) : "",
        };
        touched = true;
      }
      return touched ? next : prev;
    });
  }, [selectedNewRooms, catalogById, fromComp]);

  // ── S2-style meal columns: chip on OR pax present anywhere ────────────────────────────────
  const visibleMeals = MEAL_KEYS.filter(
    (k) => activeMealPlans.has(k) || selectedNewRooms.some((id) => (parseCount(setups[id]?.[k] ?? "") ?? 0) > 0),
  );
  /** Chip toggle — switching a visible plan OFF zeroes its column (a hidden column must not
   *  keep feeding the change), matching the S2 grid exactly. */
  const togglePlan = (k: MealKey) => {
    if (visibleMeals.includes(k)) {
      setActiveMealPlans((prev) => {
        const n = new Set(prev);
        n.delete(k);
        return n;
      });
      setSetups((prev) => {
        const next = { ...prev };
        for (const id of selectedNewRooms) next[id] = { ...next[id], [k]: "0" };
        return next;
      });
    } else {
      setActiveMealPlans((prev) => new Set(prev).add(k));
    }
  };
  /** "Everyone on…" — each new room's occupants onto one plan (zeroes the others). */
  const everyoneOn = (k: MealKey | "none") => {
    const occ = String(fromOccupants ?? 0);
    if (k !== "none") setActiveMealPlans((prev) => new Set(prev).add(k));
    setSetups((prev) => {
      const next = { ...prev };
      for (const id of selectedNewRooms) {
        next[id] = { ...next[id], cp: "0", mapl: "0", mapd: "0", ap: "0", ...(k === "none" ? {} : { [k]: occ }) };
      }
      return next;
    });
  };

  // Client-side mirror of the backend's meal ceiling (sum of plans ≤ occupants), per room.
  const mealOverRooms = useMemo(() => {
    if (!fromComp || fromOccupants == null || fromOccupants <= 0) return [];
    return selectedNewRooms.filter((id) => {
      const d = setups[id];
      if (!d) return false;
      const sum =
        (parseCount(d.cp) ?? fromComp.mealPlanCpCount ?? 0) +
        (parseCount(d.mapl) ?? fromComp.mealPlanMaplCount ?? 0) +
        (parseCount(d.mapd) ?? fromComp.mealPlanMapdCount ?? 0) +
        (parseCount(d.ap) ?? fromComp.mealPlanApCount ?? 0) +
        (fromComp.mealPlanOthersCount ?? 0);
      return sum > fromOccupants;
    });
  }, [selectedNewRooms, setups, fromComp, fromOccupants]);

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
    const roomSetups: Array<RoomChangeAdjustments & { roomId: string }> = [];
    for (const id of selectedNewRooms) {
      const d = setups[id];
      if (!d) continue;
      const cat = catalogById.get(id);
      const adj: RoomChangeAdjustments = {};
      if (d.bed && d.bed !== (cat?.bedType ?? "")) adj.bedType = d.bed;
      if (fromComp) {
        const eb = parseCount(d.eb);
        if (eb != null && eb !== (fromComp.extraBedCount ?? 0)) adj.extraBedCount = eb;
        const cp = parseCount(d.cp) ?? fromComp.mealPlanCpCount ?? 0;
        const mapl = parseCount(d.mapl) ?? fromComp.mealPlanMaplCount ?? 0;
        const mapd = parseCount(d.mapd) ?? fromComp.mealPlanMapdCount ?? 0;
        const ap = parseCount(d.ap) ?? fromComp.mealPlanApCount ?? 0;
        const mealsChanged =
          cp !== (fromComp.mealPlanCpCount ?? 0) ||
          mapl !== (fromComp.mealPlanMaplCount ?? 0) ||
          mapd !== (fromComp.mealPlanMapdCount ?? 0) ||
          ap !== (fromComp.mealPlanApCount ?? 0);
        if (mealsChanged) {
          adj.mealPlanCpCount = cp;
          adj.mealPlanMaplCount = mapl;
          adj.mealPlanMapdCount = mapd;
          adj.mealPlanApCount = ap;
        }
      }
      if (Object.keys(adj).length > 0) roomSetups.push({ roomId: id, ...adj });
    }
    const uniform = selectedNewRooms.length === 1 && keptNights.length === 0;
    return {
      fromRoomId,
      ...(uniform
        ? { toRoomId: selectedNewRooms[0] }
        : { perNight: nights.map((d) => ({ date: d, roomId: nightSel[d] })) }),
      reason: reason.trim(),
      ...(roomSetups.length > 0 ? { roomSetups } : {}),
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
      if (out.walk.blocked) {
        toast.warning(
          `${moved} — the booking is at ${out.walk.reachedStage}, not back at this step yet: ${out.walk.blocked.message}`,
          { duration: 12000 },
        );
      } else if (out.pricing.delta != null && Math.abs(out.pricing.delta) >= 0.01) {
        const dir = out.pricing.delta > 0 ? "+" : "−";
        toast.success(
          `${moved} · new total ${money(out.pricing.newTotal)} (was ${money(out.pricing.priorTotal)}, ${dir}${money(Math.abs(out.pricing.delta))}).${kept}${beds} Nothing was sent to the guest — send the new quote only if they ask.`,
          { duration: 12000 },
        );
      } else {
        toast.success(`${moved} — price unchanged.${kept}${beds} Everything else about the booking carried.`);
      }
      setOpen(false);
      setExpanded(false);
      setNightSel({});
      setSetups({});
      setActiveMealPlans(new Set());
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

          {/* S2-style setup grid — plan chips drive the meal columns; one row per NEW room. */}
          {selectedNewRooms.length > 0 && (
            <div style={{ border: "1px dashed var(--line-2)", borderRadius: 8, padding: "8px 10px", marginBottom: 8, overflowX: "auto", flex: "0 0 auto" }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>
                Set up the new room{selectedNewRooms.length === 1 ? "" : "s"} — carried from Room {fromRoomNumber}, change anything the guest wants
              </div>
              {fromComp && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) everyoneOn(e.target.value as MealKey | "none");
                    }}
                    title="Set every new room's meal-plan pax to its occupants on one plan"
                    style={{ fontSize: 11, padding: "3px 6px" }}
                  >
                    <option value="">Everyone on…</option>
                    <option value="none">None (EP)</option>
                    <option value="cp">CP · breakfast</option>
                    <option value="mapl">MAP · +lunch</option>
                    <option value="mapd">MAP · +dinner</option>
                    <option value="ap">AP · all meals</option>
                  </select>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--ink-3)" }}>
                    Meals
                  </span>
                  {MEAL_KEYS.map((k) => {
                    const on = visibleMeals.includes(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        className={`rct-chip${on ? " on" : ""}`}
                        onClick={() => togglePlan(k)}
                        title={
                          on
                            ? `${MEAL_META[k].title} — click to remove the column (zeroes its pax)`
                            : `${MEAL_META[k].title} — click to add the column`
                        }
                      >
                        {MEAL_META[k].chip}
                      </button>
                    );
                  })}
                  {visibleMeals.length === 0 && (
                    <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>EP (room only) — add a plan to put guests on meals</span>
                  )}
                </div>
              )}
              <table style={{ borderCollapse: "collapse", fontSize: 11.5, minWidth: 420 }}>
                <thead>
                  <tr>
                    {setupHeadCell("Room")}
                    {setupHeadCell("Nights")}
                    {setupHeadCell("Guests")}
                    {setupHeadCell("Bed setup")}
                    {fromComp && setupHeadCell("Extra beds")}
                    {fromComp && visibleMeals.map((k) => setupHeadCell(MEAL_META[k].head, MEAL_META[k].title))}
                    {!fromComp && setupHeadCell("")}
                  </tr>
                </thead>
                <tbody>
                  {selectedNewRooms.map((id) => {
                    const c = candidateById.get(id);
                    const cat = catalogById.get(id);
                    const bedOptions = cat?.allowedBedTypes?.length ? cat.allowedBedTypes : (roomsCatalogQuery.data?.bedTypes ?? []);
                    const d = setups[id];
                    const nightsHere = nightsOfRoom(id);
                    return (
                      <tr key={id}>
                        <td style={{ padding: "4px 8px", fontWeight: 600, whiteSpace: "nowrap" }}>
                          {c?.roomNumber ?? "?"}
                          <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>{c?.roomTypeName ? ` · ${c.roomTypeName}` : ""}</span>
                        </td>
                        <td style={{ padding: "4px 8px", color: "var(--ink-3)", whiteSpace: "nowrap" }} title={`${nightsHere.length} night${nightsHere.length === 1 ? "" : "s"}`}>
                          {nightsHere.length}
                          {nightsHere.length > 0 && ` · ${foldNightsToRangesLabel(nightsHere)}`}
                        </td>
                        <td style={{ padding: "4px 8px", color: "var(--ink-3)" }}>{fromOccupants ?? "—"}</td>
                        <td style={{ padding: "4px 8px" }}>
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
                        </td>
                        {fromComp ? (
                          <>
                            <td style={{ padding: "4px 8px" }}>{setupInput(id, "eb")}</td>
                            {visibleMeals.map((k) => (
                              <td key={k} style={{ padding: "4px 8px" }}>
                                {setupInput(id, k)}
                              </td>
                            ))}
                          </>
                        ) : (
                          <td style={{ padding: "4px 8px", fontSize: 11, color: "var(--ink-3)" }}>
                            no per-room composition recorded — meals/extra beds can&apos;t be adjusted here
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {keptNights.length > 0 && (
                    <tr>
                      <td style={{ padding: "4px 8px", fontWeight: 600, whiteSpace: "nowrap" }}>
                        {fromRoomNumber}
                        <span style={{ color: "var(--ink-3)", fontWeight: 400 }}> · kept</span>
                      </td>
                      <td style={{ padding: "4px 8px", color: "var(--ink-3)", whiteSpace: "nowrap" }} title={`${keptNights.length} night${keptNights.length === 1 ? "" : "s"}`}>
                        {keptNights.length}
                        {keptNights.length > 0 && ` · ${foldNightsToRangesLabel(keptNights)}`}
                      </td>
                      <td colSpan={2 + (fromComp ? 1 + visibleMeals.length : 1)} style={{ padding: "4px 8px", fontSize: 11, color: "var(--ink-3)" }}>
                        keeps its current setup for the nights the guest stays in it
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {fromComp && (
                <p style={{ fontSize: 10.5, color: "var(--ink-3)", margin: "6px 0 0", lineHeight: 1.5 }}>
                  Meal counts are guests on each plan{fromOccupants != null && fromOccupants > 0 ? ` (of ${fromOccupants})` : ""} — like the S2
                  grid: chips add or remove plan columns, switching one off zeroes it. Leave everything as-is to carry the current setup;
                  whatever you change is priced into the new total by the backend the moment the swap completes. Changing a room&apos;s meal
                  plan clears its night-by-night meal exceptions.
                </p>
              )}
              {mealOverRooms.length > 0 && (
                <p style={{ fontSize: 11.5, color: "var(--stop, #b3593a)", margin: "6px 0 0" }}>
                  Meal plans cover more guests than sleep in{" "}
                  {mealOverRooms.map((id) => `Room ${candidateById.get(id)?.roomNumber ?? "?"}`).join(", ")} (max {fromOccupants}) — reduce the
                  counts.
                </p>
              )}
            </div>
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
                    mealOverRooms.length > 0 ||
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
