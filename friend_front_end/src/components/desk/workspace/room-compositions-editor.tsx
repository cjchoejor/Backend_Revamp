"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { listRooms } from "@/lib/api/rooms";
import type { RoomCompositionInput } from "@/lib/api/quotations";

/**
 * Per-room composition editor (Phase E of per-room track, 2026-07-27).
 *
 * Given a list of sealed room IDs from the S2 booking, render a compact form per room:
 *   - Occupants + adult / CNB age-band counts
 *   - Extra beds
 *   - Meal-plan distribution (CP / MAPL / MAPD / AP / Others counts)
 *   - À-la-carte pax when Others > 0
 *   - Collapsible negotiated rates
 *   - Room-level toggles (Service Charge / GST / FOC)
 *
 * Emits the current state via `onChange(compositions)` — the parent submits it as
 * `roomCompositions` in the `createQuotation` call. Draft state is local to this component.
 */
export function RoomCompositionsEditor({
  sealedRoomIds,
  entryCheckIn,
  entryCheckOut,
  onChange,
}: {
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  onChange: (compositions: RoomCompositionInput[]) => void;
}) {
  const { session } = useSession();
  const roomsQuery = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const roomNumberById = new Map(
    (roomsQuery.data?.items ?? []).map((r) => [r.id, r.roomNumber]),
  );

  // Composition state, keyed by roomId. Every field a string so operator can backspace-empty
  // without the value snapping to 0.
  type FieldMap = Record<string, string>;
  const [state, setState] = useState<Record<string, FieldMap>>({});
  const [toggles, setToggles] = useState<Record<string, { sc: boolean; gst: boolean; foc: boolean }>>({});
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({});

  // Initialise a row when a new roomId shows up — sensible defaults.
  useEffect(() => {
    setState((prev) => {
      const next = { ...prev };
      for (const id of sealedRoomIds) {
        if (!next[id]) {
          next[id] = {
            occupantCount: "",
            adultCount: "",
            cnb11PlusCount: "",
            cnb6To10Count: "",
            cnbUnder6Count: "",
            extraBedCount: "0",
            mealPlanCpCount: "0",
            mealPlanMaplCount: "0",
            mealPlanMapdCount: "0",
            mealPlanApCount: "0",
            mealPlanOthersCount: "0",
            othersBreakfastPax: "",
            othersLunchPax: "",
            othersDinnerPax: "",
            negotiatedRoomRate: "",
            negotiatedExtraBedRate: "",
            negotiatedBreakfastRate: "",
            negotiatedLunchRate: "",
            negotiatedDinnerRate: "",
          };
        }
      }
      return next;
    });
    setToggles((prev) => {
      const next = { ...prev };
      for (const id of sealedRoomIds) {
        if (!next[id]) next[id] = { sc: true, gst: true, foc: false };
      }
      return next;
    });
  }, [sealedRoomIds]);

  // Emit whenever anything changes. Convert string fields to numbers; omit empty ones so the
  // backend treats them as "use default" rather than "0".
  useEffect(() => {
    const out: RoomCompositionInput[] = sealedRoomIds
      .filter((id) => state[id])
      .map((id) => {
        const f = state[id];
        const t = toggles[id] ?? { sc: true, gst: true, foc: false };
        const num = (k: string): number | undefined => {
          const v = f[k];
          if (v == null || v === "") return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        return {
          roomId: id,
          startDate: entryCheckIn ? new Date(entryCheckIn + "T00:00:00.000Z").toISOString() : undefined,
          endDate: entryCheckOut ? new Date(entryCheckOut + "T00:00:00.000Z").toISOString() : undefined,
          occupantCount: num("occupantCount"),
          adultCount: num("adultCount"),
          cnb11PlusCount: num("cnb11PlusCount"),
          cnb6To10Count: num("cnb6To10Count"),
          cnbUnder6Count: num("cnbUnder6Count"),
          extraBedCount: num("extraBedCount"),
          mealPlanCpCount: num("mealPlanCpCount"),
          mealPlanMaplCount: num("mealPlanMaplCount"),
          mealPlanMapdCount: num("mealPlanMapdCount"),
          mealPlanApCount: num("mealPlanApCount"),
          mealPlanOthersCount: num("mealPlanOthersCount"),
          othersBreakfastPax: num("othersBreakfastPax"),
          othersLunchPax: num("othersLunchPax"),
          othersDinnerPax: num("othersDinnerPax"),
          negotiatedRoomRate: num("negotiatedRoomRate"),
          negotiatedExtraBedRate: num("negotiatedExtraBedRate"),
          negotiatedBreakfastRate: num("negotiatedBreakfastRate"),
          negotiatedLunchRate: num("negotiatedLunchRate"),
          negotiatedDinnerRate: num("negotiatedDinnerRate"),
          serviceChargeApplies: t.sc,
          gstApplies: t.gst,
          isFoc: t.foc,
        };
      });
    onChange(out);
    // Intentionally exclude onChange from deps to avoid an infinite loop when the parent
    // recreates the callback each render. Parent's onChange is expected to be stable enough
    // for our use (setState of an array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, toggles, sealedRoomIds, entryCheckIn, entryCheckOut]);

  const setField = (roomId: string, key: string, value: string) =>
    setState((prev) => ({ ...prev, [roomId]: { ...prev[roomId], [key]: value } }));
  const setToggle = (roomId: string, key: "sc" | "gst" | "foc", value: boolean) =>
    setToggles((prev) => ({ ...prev, [roomId]: { ...prev[roomId], [key]: value } }));

  if (sealedRoomIds.length === 0) {
    return (
      <div style={{ padding: 10, fontSize: 11.5, color: "var(--ink-3, #7a6a52)" }}>
        Seal a room selection in Inquiry first — per-room composition unlocks after that.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {sealedRoomIds.map((id) => {
        const roomNumber = roomNumberById.get(id) ?? id.slice(0, 6);
        const f = state[id] ?? {};
        const t = toggles[id] ?? { sc: true, gst: true, foc: false };
        const showOthersAlaCarte = Number(f.mealPlanOthersCount || 0) > 0;
        const advanced = advancedOpen[id] ?? false;
        return (
          <div key={id} style={{
            border: "1px solid var(--line, #e6e0d4)", borderRadius: 8, padding: 12,
            background: t.foc ? "rgba(200, 200, 200, 0.15)" : "var(--surface, #fff)",
            opacity: t.foc ? 0.75 : 1,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Room {roomNumber}</div>
              <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={t.sc} onChange={(e) => setToggle(id, "sc", e.target.checked)} style={{ margin: 0 }} />
                  Service charge
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={t.gst} onChange={(e) => setToggle(id, "gst", e.target.checked)} style={{ margin: 0 }} />
                  GST
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={t.foc} onChange={(e) => setToggle(id, "foc", e.target.checked)} style={{ margin: 0 }} />
                  <b>FOC</b>
                </label>
              </div>
            </div>

            {/* Occupants + CNB row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6, marginBottom: 8 }}>
              <NumField label="Occupants" value={f.occupantCount} onChange={(v) => setField(id, "occupantCount", v)} />
              <NumField label="Adults" value={f.adultCount} onChange={(v) => setField(id, "adultCount", v)} />
              <NumField label="CNB 11+" value={f.cnb11PlusCount} onChange={(v) => setField(id, "cnb11PlusCount", v)} />
              <NumField label="CNB 6-10" value={f.cnb6To10Count} onChange={(v) => setField(id, "cnb6To10Count", v)} />
              <NumField label="CNB <6" value={f.cnbUnder6Count} onChange={(v) => setField(id, "cnbUnder6Count", v)} />
              <NumField label="Extra beds" value={f.extraBedCount} onChange={(v) => setField(id, "extraBedCount", v)} />
            </div>

            {/* Meal plan distribution row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 8 }}>
              <NumField label="CP" value={f.mealPlanCpCount} onChange={(v) => setField(id, "mealPlanCpCount", v)} />
              <NumField label="MAPL" value={f.mealPlanMaplCount} onChange={(v) => setField(id, "mealPlanMaplCount", v)} />
              <NumField label="MAPD" value={f.mealPlanMapdCount} onChange={(v) => setField(id, "mealPlanMapdCount", v)} />
              <NumField label="AP" value={f.mealPlanApCount} onChange={(v) => setField(id, "mealPlanApCount", v)} />
              <NumField label="Others" value={f.mealPlanOthersCount} onChange={(v) => setField(id, "mealPlanOthersCount", v)} />
            </div>

            {/* Others à-la-carte — only when Others > 0 */}
            {showOthersAlaCarte && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 8, padding: 6, background: "var(--surface-2, #fafaf5)", borderRadius: 4 }}>
                <NumField label="Others breakfast pax" value={f.othersBreakfastPax} onChange={(v) => setField(id, "othersBreakfastPax", v)} />
                <NumField label="Others lunch pax" value={f.othersLunchPax} onChange={(v) => setField(id, "othersLunchPax", v)} />
                <NumField label="Others dinner pax" value={f.othersDinnerPax} onChange={(v) => setField(id, "othersDinnerPax", v)} />
              </div>
            )}

            {/* Negotiated rates — collapsible */}
            <button
              type="button"
              onClick={() => setAdvancedOpen((prev) => ({ ...prev, [id]: !advanced }))}
              style={{
                fontSize: 11, background: "transparent", border: 0, cursor: "pointer",
                color: "var(--accent, #a44f2b)", padding: 0, marginBottom: advanced ? 6 : 0,
              }}
            >
              {advanced ? "− Hide" : "+ Negotiated rates (optional)"}
            </button>
            {advanced && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
                <NumField label="Room rate" value={f.negotiatedRoomRate} onChange={(v) => setField(id, "negotiatedRoomRate", v)} />
                <NumField label="Extra bed" value={f.negotiatedExtraBedRate} onChange={(v) => setField(id, "negotiatedExtraBedRate", v)} />
                <NumField label="Breakfast" value={f.negotiatedBreakfastRate} onChange={(v) => setField(id, "negotiatedBreakfastRate", v)} />
                <NumField label="Lunch" value={f.negotiatedLunchRate} onChange={(v) => setField(id, "negotiatedLunchRate", v)} />
                <NumField label="Dinner" value={f.negotiatedDinnerRate} onChange={(v) => setField(id, "negotiatedDinnerRate", v)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label style={{ fontSize: 10, color: "var(--ink-3, #7a6a52)" }}>{label}</label>
      <input
        type="number"
        min={0}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%", padding: "4px 6px", fontSize: 12,
          border: "1px solid var(--line, #e6e0d4)", borderRadius: 4,
          background: "var(--surface, #fff)",
        }}
      />
    </div>
  );
}
