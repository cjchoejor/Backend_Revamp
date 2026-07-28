"use client";

import type { RoomAssignmentSummary } from "@/types/api";
import { money } from "@/lib/desk/workspace";

/**
 * Per-room composition summary display (Phase F of per-room track, 2026-07-27).
 *
 * Renders a compact card per room showing what the operator captured at S2:
 *   - Occupants breakdown (adults / CNB age bands)
 *   - Meal-plan distribution
 *   - Extra beds
 *   - Negotiated rates (only when they differ from defaults)
 *   - SC / GST / FOC toggles
 *   - Frozen total
 *
 * Hidden when no room has composition (legacy bookings) — the caller shows the old
 * summary instead.
 */
export function RoomCompositionSummary({
  assignments,
  currency,
}: {
  assignments: RoomAssignmentSummary[];
  currency?: string;
}) {
  // Only render if at least one assignment has composition data.
  const hasComposition = assignments.some(
    (a) => a.occupantCount != null || a.adultCount != null || (a.mealPlanCpCount ?? 0) > 0 || (a.mealPlanMaplCount ?? 0) > 0,
  );
  if (!hasComposition) return null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {assignments.map((a) => {
        const isEmpty =
          a.occupantCount == null && a.adultCount == null && !a.mealPlanCpCount && !a.mealPlanMaplCount &&
          !a.mealPlanMapdCount && !a.mealPlanApCount && !a.mealPlanOthersCount;
        if (isEmpty) return null;
        return (
          <RoomCompositionCard key={a.id} assignment={a} currency={currency} />
        );
      })}
    </div>
  );
}

function RoomCompositionCard({ assignment, currency }: { assignment: RoomAssignmentSummary; currency?: string }) {
  const a = assignment;
  const rn = a.room?.roomNumber ?? a.roomId.slice(0, 6);
  const adults = a.adultCount ?? 0;
  const cnb6 = a.cnb6To10Count ?? 0;
  const cnb0 = a.cnbUnder6Count ?? 0;
  const extraBeds = a.extraBedCount ?? 0;

  const mealParts: string[] = [];
  if (a.mealPlanCpCount) mealParts.push(`${a.mealPlanCpCount} CP`);
  if (a.mealPlanMaplCount) mealParts.push(`${a.mealPlanMaplCount} MAPL`);
  if (a.mealPlanMapdCount) mealParts.push(`${a.mealPlanMapdCount} MAPD`);
  if (a.mealPlanApCount) mealParts.push(`${a.mealPlanApCount} AP`);
  if (a.mealPlanOthersCount) mealParts.push(`${a.mealPlanOthersCount} Others`);
  const mealPlanStr = mealParts.length > 0 ? mealParts.join(" · ") : "None";

  return (
    <div
      style={{
        border: "1px solid var(--line, #e6e0d4)", borderRadius: 6, padding: 10,
        background: a.isFoc ? "rgba(200,200,200,0.1)" : "var(--surface, #fff)",
        opacity: a.isFoc ? 0.8 : 1,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>
          Room {rn}
          {a.isFoc && (
            <span style={{
              marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 3,
              background: "#fff4e5", color: "#7a5a20",
            }}>FOC</span>
          )}
        </div>
        {a.frozenTotal != null && (
          <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {money(a.frozenTotal, currency ?? "BTN")}
          </div>
        )}
      </div>
      <div style={{ display: "grid", gap: 3, color: "var(--ink-2, #333)" }}>
        <div>
          <span style={{ color: "var(--ink-3, #7a6a52)" }}>Occupants: </span>
          {adults} adult{adults === 1 ? "" : "s"}
          {cnb6 > 0 && `, ${cnb6} CNB 6-10`}
          {cnb0 > 0 && `, ${cnb0} CNB <6`}
          {extraBeds > 0 && ` · ${extraBeds} extra bed${extraBeds === 1 ? "" : "s"}`}
        </div>
        <div>
          <span style={{ color: "var(--ink-3, #7a6a52)" }}>Meals: </span>
          {mealPlanStr}
        </div>
        {(a.negotiatedRoomRate != null || a.negotiatedExtraBedRate != null) && (
          <div style={{ fontSize: 11, color: "var(--ink-3, #7a6a52)" }}>
            Negotiated:{" "}
            {a.negotiatedRoomRate != null && `Room ${money(a.negotiatedRoomRate, currency ?? "BTN")}`}
            {a.negotiatedExtraBedRate != null && ` · Extra bed ${money(a.negotiatedExtraBedRate, currency ?? "BTN")}`}
          </div>
        )}
        {(a.serviceChargeApplies === false || a.gstApplies === false) && (
          <div style={{ fontSize: 11, color: "var(--ink-3, #7a6a52)" }}>
            {a.serviceChargeApplies === false && "Service charge waived"}
            {a.serviceChargeApplies === false && a.gstApplies === false && " · "}
            {a.gstApplies === false && "GST waived"}
          </div>
        )}
      </div>
    </div>
  );
}
