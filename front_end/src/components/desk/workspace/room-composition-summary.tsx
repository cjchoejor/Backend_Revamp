"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RoomAssignmentSummary } from "@/types/api";
import { money } from "@/lib/desk/workspace";

/**
 * Per-room composition summary display (Phase F of per-room track, 2026-07-27;
 * compacted 2026-08-13 — operator report: the card-per-room layout ate the S7 page).
 *
 * Collapsed by default: a single header line with party tallies. Expanded: one dense
 * row per room — occupants · extra beds · meal distribution · negotiated/waiver notes ·
 * frozen total. Same data as before, no card stack.
 *
 * Hidden when no room has composition (legacy bookings) — the caller shows the old
 * summary instead. Tallies are head-counts only; every money figure is read from the
 * assignment rows (no client-side money arithmetic).
 */
/** Whether any assignment carries composition data — callers use it to skip the block heading. */
export function hasRoomComposition(assignments: RoomAssignmentSummary[] | undefined | null): boolean {
  return (assignments ?? []).some(
    (a) => a.occupantCount != null || a.adultCount != null || (a.mealPlanCpCount ?? 0) > 0 || (a.mealPlanMaplCount ?? 0) > 0,
  );
}

export function RoomCompositionSummary({
  assignments,
  currency,
  defaultOpen = false,
}: {
  assignments: RoomAssignmentSummary[];
  currency?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const withComposition = assignments.filter(
    (a) =>
      !(
        a.occupantCount == null && a.adultCount == null && !a.mealPlanCpCount && !a.mealPlanMaplCount &&
        !a.mealPlanMapdCount && !a.mealPlanApCount && !a.mealPlanOthersCount
      ),
  );
  if (withComposition.length === 0) return null;

  // Head-count tallies for the collapsed header (counts, never money).
  let adults = 0;
  let children = 0;
  let extraBeds = 0;
  for (const a of withComposition) {
    adults += a.adultCount ?? 0;
    children += (a.cnb6To10Count ?? 0) + (a.cnbUnder6Count ?? 0);
    extraBeds += a.extraBedCount ?? 0;
  }
  const tallyParts = [
    `${withComposition.length} room${withComposition.length === 1 ? "" : "s"}`,
    `${adults} adult${adults === 1 ? "" : "s"}`,
  ];
  if (children > 0) tallyParts.push(`${children} child${children === 1 ? "" : "ren"}`);
  if (extraBeds > 0) tallyParts.push(`${extraBeds} extra bed${extraBeds === 1 ? "" : "s"}`);

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          border: "1px solid var(--line, #e6e0d4)", borderRadius: 6, padding: "7px 10px",
          background: "var(--surface, #fff)", cursor: "pointer", textAlign: "left",
          font: "inherit", fontSize: 12,
        }}
      >
        <Chevron style={{ width: 13, height: 13, flexShrink: 0, color: "var(--ink-3, #7a6a52)" }} />
        <span style={{ color: "var(--ink-2, #333)" }}>{tallyParts.join(" · ")}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3, #7a6a52)" }}>
          {open ? "Hide" : "Show per room"}
        </span>
      </button>
      {open && (
        <div style={{ display: "grid", gap: 4 }}>
          {withComposition.map((a) => (
            <RoomCompositionRow key={a.id} assignment={a} currency={currency} />
          ))}
        </div>
      )}
    </div>
  );
}

function RoomCompositionRow({ assignment, currency }: { assignment: RoomAssignmentSummary; currency?: string }) {
  const a = assignment;
  const rn = a.room?.roomNumber ?? a.roomId.slice(0, 6);
  const adults = a.adultCount ?? 0;
  const cnb6 = a.cnb6To10Count ?? 0;
  const cnb0 = a.cnbUnder6Count ?? 0;
  const extraBeds = a.extraBedCount ?? 0;

  const occParts: string[] = [`${adults}A`];
  if (cnb6 > 0) occParts.push(`${cnb6}×6-10`);
  if (cnb0 > 0) occParts.push(`${cnb0}×<6`);

  const mealParts: string[] = [];
  if (a.mealPlanCpCount) mealParts.push(`${a.mealPlanCpCount} CP`);
  if (a.mealPlanMaplCount) mealParts.push(`${a.mealPlanMaplCount} MAPL`);
  if (a.mealPlanMapdCount) mealParts.push(`${a.mealPlanMapdCount} MAPD`);
  if (a.mealPlanApCount) mealParts.push(`${a.mealPlanApCount} AP`);
  if (a.mealPlanOthersCount) mealParts.push(`${a.mealPlanOthersCount} Others`);

  const noteParts: string[] = [];
  if (a.negotiatedRoomRate != null) noteParts.push(`Room @ ${money(a.negotiatedRoomRate, currency ?? "BTN")}`);
  if (a.negotiatedExtraBedRate != null) noteParts.push(`Bed @ ${money(a.negotiatedExtraBedRate, currency ?? "BTN")}`);
  if (a.serviceChargeApplies === false) noteParts.push("SC waived");
  if (a.gstApplies === false) noteParts.push("GST waived");

  return (
    <div
      style={{
        display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2,
        border: "1px solid var(--line, #e6e0d4)", borderRadius: 6, padding: "5px 10px",
        background: a.isFoc ? "rgba(200,200,200,0.1)" : "var(--surface, #fff)",
        opacity: a.isFoc ? 0.85 : 1,
        fontSize: 12,
      }}
    >
      <span style={{ fontWeight: 600 }}>Room {rn}</span>
      {a.isFoc && (
        <span style={{
          fontSize: 10, padding: "1px 5px", borderRadius: 3,
          background: "#fff4e5", color: "#7a5a20", alignSelf: "center",
        }}>FOC</span>
      )}
      <span style={{ color: "var(--ink-2, #333)" }}>
        {occParts.join(" + ")}
        {extraBeds > 0 && ` · ${extraBeds} bed${extraBeds === 1 ? "" : "s"}`}
      </span>
      <span style={{ color: "var(--ink-3, #7a6a52)" }}>
        {mealParts.length > 0 ? mealParts.join(" · ") : "EP (room only)"}
      </span>
      {noteParts.length > 0 && (
        <span style={{ fontSize: 11, color: "var(--ink-3, #7a6a52)" }}>{noteParts.join(" · ")}</span>
      )}
      {a.frozenTotal != null && (
        <span style={{ marginLeft: "auto", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
          {money(a.frozenTotal, currency ?? "BTN")}
        </span>
      )}
    </div>
  );
}
