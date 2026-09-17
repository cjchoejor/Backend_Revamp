"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, Wand2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listRooms } from "@/lib/api/rooms";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import type { RoomCompositionInput } from "@/lib/api/quotations";

/**
 * Per-room composition editor (per-room track, 2026-07-27; desk-side rebuild same day).
 *
 * One card per sealed room:
 *   - Occupants + adult / CNB age-band counts, extra beds
 *   - Meal plans — TWO modes per room:
 *       "By guest": every occupant gets their own plan picker (Adult 1 → AP, Child 6–10 → CP…);
 *                   the mealPlan*Count distribution is TALLIED from the picks on emit.
 *       "By counts": type the distribution directly (the legacy-grid way).
 *   - À-la-carte pax when Others > 0, collapsible negotiated rates, SC / GST / FOC toggles
 *   - "Auto-assign guests" spreads the booking's party across the rooms (7 guests / 3 rooms →
 *     3+2+2), children grouped into the first room so a family stays together. Runs once on
 *     first open when the form is pristine; the button re-runs it after edits.
 *
 * Age-band cutoffs come from GET /api/lookups/child-policy (admin-editable), not hardcoded.
 * NO MONEY IS COMPUTED HERE — pricing happens in the backend when the draft is created
 * (live preview pending a backend preview endpoint; see CLAUDE.md per-room track notes).
 *
 * Emits via `onChange(compositions)`; parent submits as `roomCompositions` on createQuotation.
 */

type PlanPick = "NONE" | "CP" | "MAPL" | "MAPD" | "AP" | "OTHERS";

const PLAN_LABEL: Record<PlanPick, string> = {
  NONE: "None (EP)",
  CP: "CP · breakfast",
  MAPL: "MAP · +lunch",
  MAPD: "MAP · +dinner",
  AP: "AP · all meals",
  OTHERS: "Others",
};

/**
 * Normalise an entry date to a midnight-UTC ISO string. The entry's check-in/out arrive as
 * FULL ISO timestamps ("2026-07-27T00:00:00.000Z"), not bare days — naively appending
 * "T00:00:00.000Z" made an invalid date and toISOString() threw. Slice the day out first;
 * return undefined for anything unparseable so the field is simply omitted.
 */
function dayToIso(v?: string | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v.slice(0, 10) + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Guest slots a room's counts imply, in a stable order so plan picks survive count edits. */
function slotsFor(f: Record<string, string>): Array<{ key: string; label: string }> {
  const n = (k: string) => Math.max(0, parseInt(f[k] || "0", 10) || 0);
  const out: Array<{ key: string; label: string }> = [];
  for (let i = 0; i < n("adultCount"); i++) out.push({ key: `A${i}`, label: `Adult ${i + 1}` });
  for (let i = 0; i < n("cnb6To10Count"); i++) out.push({ key: `C${i}`, label: `Child 6–10 · ${i + 1}` });
  for (let i = 0; i < n("cnbUnder6Count"); i++) out.push({ key: `U${i}`, label: `Under-6 · ${i + 1}` });
  return out;
}

export function RoomCompositionsEditor({
  sealedRoomIds,
  entryCheckIn,
  entryCheckOut,
  entryAdults,
  entryChildAges,
  onChange,
}: {
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  /** Booking party, for auto-assign. Optional — the button hides without them. */
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  onChange: (compositions: RoomCompositionInput[]) => void;
}) {
  const { session } = useSession();
  const roomsQuery = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const roomNumberById = new Map((roomsQuery.data?.items ?? []).map((r) => [r.id, r.roomNumber]));

  // Age-band cutoffs for classifying entry.childAges during auto-assign. Admin-editable —
  // same source the intake form uses. Falls back to the documented defaults if the lookup
  // hasn't answered yet.
  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const youngMax = policyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policyQuery.data?.ageBands.childMaxAge ?? 10;

  // Minimum rooms this party needs — same backend envelope the S1 rooms inputs use
  // (POST /api/lookups/allowed-room-counts; chargeable occupants vs per-room capacity).
  // Surfaces here because the sealed room COUNT is fixed by the time the operator is
  // splitting the party: if S1 sealed fewer rooms than the party needs, no allocation
  // can be valid and the fix is back in Inquiry, not in this form.
  const envAdults = Math.max(0, entryAdults ?? 0);
  const roomEnvelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", envAdults, (entryChildAges ?? []).join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: envAdults, childAges: entryChildAges ?? [] }),
    enabled: !!session && envAdults > 0,
  });
  const roomMin = roomEnvelopeQuery.data?.allowedRoomCounts.min ?? null;

  // Composition state, keyed by roomId. Strings so the operator can backspace-empty without
  // the value snapping to 0.
  type FieldMap = Record<string, string>;
  const [state, setState] = useState<Record<string, FieldMap>>({});
  const [toggles, setToggles] = useState<Record<string, { sc: boolean; gst: boolean; foc: boolean }>>({});
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({});
  // Meal-plan entry mode per room. "guests" = per-guest pickers (default); "counts" = raw grid.
  const [mealMode, setMealMode] = useState<Record<string, "guests" | "counts">>({});
  // Per-guest plan picks, keyed by roomId then slot key (A0, C1, …) so picks survive resizes.
  const [guestPlans, setGuestPlans] = useState<Record<string, Record<string, PlanPick>>>({});
  // Transient per-room notice shown when a typed increase hits the Occupants cap and the
  // field was clamped — the silent clamp confused operators. Cleared after a few seconds.
  const [capMsg, setCapMsg] = useState<Record<string, string | null>>({});
  // Bumped on every clamp so the message's key changes and the glow animation restarts —
  // repeated clicks past the limit visibly re-flash instead of looking ignored.
  const [capPulse, setCapPulse] = useState(0);
  const capTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const flashCapMsg = (roomId: string, msg: string) => {
    setCapMsg((prev) => ({ ...prev, [roomId]: msg }));
    setCapPulse((n) => n + 1);
    clearTimeout(capTimerRef.current[roomId]);
    capTimerRef.current[roomId] = setTimeout(() => {
      setCapMsg((prev) => ({ ...prev, [roomId]: null }));
    }, 4000);
  };

  const EMPTY_FIELDS: FieldMap = {
    occupantCount: "",
    adultCount: "",
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

  // Initialise rows for new roomIds. Returns `prev` UNCHANGED when every id already has a
  // row — an updater that always returns a fresh object re-renders unconditionally, and with
  // an array-identity dep that made an infinite render loop (max update depth).
  useEffect(() => {
    setState((prev) => {
      if (sealedRoomIds.every((id) => prev[id])) return prev;
      const next = { ...prev };
      for (const id of sealedRoomIds) if (!next[id]) next[id] = { ...EMPTY_FIELDS };
      return next;
    });
    setToggles((prev) => {
      if (sealedRoomIds.every((id) => prev[id])) return prev;
      const next = { ...prev };
      for (const id of sealedRoomIds) if (!next[id]) next[id] = { sc: true, gst: true, foc: false };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sealedRoomIds]);

  /**
   * Spread the booking party across the sealed rooms.
   *
   * Adults as evenly as possible with the remainder on the FIRST room (7 / 3 → 3+2+2);
   * children all in the first room — a family shares a room, and it means the room with
   * children is also the room guaranteed the most adults. A starting point, not a commitment:
   * every field stays editable.
   */
  const autoAssign = () => {
    const n = sealedRoomIds.length;
    if (n === 0) return;
    const ages = entryChildAges ?? [];
    const under6 = ages.filter((a) => a <= youngMax).length;
    const c6to10 = ages.filter((a) => a > youngMax && a <= childMax).length;
    // CNB 11+ retired (2026-07-28): anyone above the child band counts as an adult, so
    // declared children aged 11+ join the adult pool and spread with it.
    const adults = Math.max(0, entryAdults ?? 0) + ages.filter((a) => a > childMax).length;
    const base = Math.floor(adults / n);
    const rem = adults % n;

    setState((prev) => {
      const next = { ...prev };
      sealedRoomIds.forEach((id, i) => {
        const a = base + (i < rem ? 1 : 0);
        const kidsHere = i === 0 ? { u: under6, c: c6to10 } : { u: 0, c: 0 };
        next[id] = {
          ...(next[id] ?? { ...EMPTY_FIELDS }),
          adultCount: String(a),
          cnbUnder6Count: String(kidsHere.u),
          cnb6To10Count: String(kidsHere.c),
          occupantCount: String(a + kidsHere.u + kidsHere.c),
        };
      });
      return next;
    });
  };

  // Run the auto-assign once, on first open, while every room is still pristine — the operator
  // lands on a sensible split instead of a wall of empty boxes. Ref-guarded so later edits are
  // never overwritten by a re-render.
  const autoRanRef = useRef(false);
  const stateReady = sealedRoomIds.length > 0 && sealedRoomIds.every((id) => state[id]);
  useEffect(() => {
    if (autoRanRef.current || !stateReady) return;
    const pristine = sealedRoomIds.every((id) => (state[id]?.adultCount ?? "") === "" && (state[id]?.occupantCount ?? "") === "");
    if (!pristine) {
      autoRanRef.current = true; // operator already typed — never auto-overwrite
      return;
    }
    if ((entryAdults ?? 0) > 0) {
      autoRanRef.current = true;
      autoAssign();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateReady, entryAdults]);

  // Emit whenever anything changes. In "guests" mode the meal distribution is tallied from the
  // per-guest picks; in "counts" mode the typed fields are used as-is. Empty strings are
  // omitted (backend treats missing as "use default", not 0).
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

        let meal: Record<string, number | undefined>;
        if ((mealMode[id] ?? "guests") === "guests") {
          const picks = guestPlans[id] ?? {};
          const tally: Record<PlanPick, number> = { NONE: 0, CP: 0, MAPL: 0, MAPD: 0, AP: 0, OTHERS: 0 };
          for (const slot of slotsFor(f)) tally[picks[slot.key] ?? "NONE"] += 1;
          meal = {
            mealPlanCpCount: tally.CP,
            mealPlanMaplCount: tally.MAPL,
            mealPlanMapdCount: tally.MAPD,
            mealPlanApCount: tally.AP,
            mealPlanOthersCount: tally.OTHERS,
          };
        } else {
          meal = {
            mealPlanCpCount: num("mealPlanCpCount"),
            mealPlanMaplCount: num("mealPlanMaplCount"),
            mealPlanMapdCount: num("mealPlanMapdCount"),
            mealPlanApCount: num("mealPlanApCount"),
            mealPlanOthersCount: num("mealPlanOthersCount"),
          };
        }

        return {
          roomId: id,
          startDate: dayToIso(entryCheckIn),
          endDate: dayToIso(entryCheckOut),
          occupantCount: num("occupantCount"),
          adultCount: num("adultCount"),
          cnb6To10Count: num("cnb6To10Count"),
          cnbUnder6Count: num("cnbUnder6Count"),
          extraBedCount: num("extraBedCount"),
          ...meal,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, toggles, mealMode, guestPlans, sealedRoomIds, entryCheckIn, entryCheckOut]);

  const setField = (roomId: string, key: string, value: string) =>
    setState((prev) => ({ ...prev, [roomId]: { ...prev[roomId], [key]: value } }));
  const setToggle = (roomId: string, key: "sc" | "gst" | "foc", value: boolean) =>
    setToggles((prev) => ({ ...prev, [roomId]: { ...prev[roomId], [key]: value } }));
  const setGuestPlan = (roomId: string, slotKey: string, plan: PlanPick) =>
    setGuestPlans((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? {}), [slotKey]: plan } }));
  /** Set every guest in the room to one plan — the common "everyone on CP" case in one click. */
  const setAllGuestPlans = (roomId: string, plan: PlanPick) =>
    setGuestPlans((prev) => ({
      ...prev,
      [roomId]: Object.fromEntries(slotsFor(state[roomId] ?? {}).map((s) => [s.key, plan])),
    }));

  // Party bookkeeping so the operator can see over/under-allocation at a glance.
  const totalAssigned = useMemo(
    () =>
      sealedRoomIds.reduce((sum, id) => {
        const f = state[id];
        if (!f) return sum;
        const n = (k: string) => Math.max(0, parseInt(f[k] || "0", 10) || 0);
        return sum + n("adultCount") + n("cnb6To10Count") + n("cnbUnder6Count");
      }, 0),
    [state, sealedRoomIds],
  );
  const partySize = (entryAdults ?? 0) + (entryChildAges?.length ?? 0);

  if (sealedRoomIds.length === 0) {
    return (
      <div style={{ padding: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
        Seal a room selection in Inquiry first — per-room composition unlocks after that.
      </div>
    );
  }

  return (
    <div className="rce">
      <div className="rce-bar">
        {partySize > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={autoAssign} title="Spread the booking's party evenly across the rooms (children stay together in the first room)">
            <Wand2 style={{ width: 13, height: 13 }} /> Auto-assign guests
          </button>
        )}
        <span className="ln" />
        {roomMin != null && (
          <span className={`rce-tally${sealedRoomIds.length < roomMin ? " off" : ""}`} title="Backend capacity envelope: chargeable guests vs the largest room capacity">
            needs ≥ {roomMin} room{roomMin === 1 ? "" : "s"} · {sealedRoomIds.length} sealed
          </span>
        )}
        {partySize > 0 && (
          <span className={`rce-tally${totalAssigned !== partySize ? " off" : ""}`}>
            {totalAssigned} of {partySize} guests placed
          </span>
        )}
      </div>
      {roomMin != null && sealedRoomIds.length < roomMin && (
        <p className="rce-block">
          {roomEnvelopeQuery.data?.chargeableOccupants} chargeable guest
          {(roomEnvelopeQuery.data?.chargeableOccupants ?? 0) === 1 ? "" : "s"} won&rsquo;t fit in{" "}
          {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"} — go back to Inquiry and seal at
          least {roomMin}.
        </p>
      )}

      {sealedRoomIds.map((id) => {
        const roomNumber = roomNumberById.get(id) ?? id.slice(0, 6);
        const f = state[id] ?? {};
        const t = toggles[id] ?? { sc: true, gst: true, foc: false };
        const mode = mealMode[id] ?? "guests";
        const slots = slotsFor(f);
        const picks = guestPlans[id] ?? {};
        const othersCount =
          mode === "guests"
            ? slots.filter((s) => (picks[s.key] ?? "NONE") === "OTHERS").length
            : Number(f.mealPlanOthersCount || 0);
        const advanced = advancedOpen[id] ?? false;

        // Mirror backend Policy 79 as live feedback (the backend still enforces on draft):
        //  (1) adults + CNB bands must equal Occupants; (2) meal-plan pax can't exceed Occupants.
        // Per-guest mode can't violate (2) by construction — one plan per guest.
        const cnt = (k: string) => Math.max(0, parseInt(f[k] || "0", 10) || 0);
        const occupants = f.occupantCount === "" ? null : cnt("occupantCount");
        const peopleAssigned = cnt("adultCount") + cnt("cnb6To10Count") + cnt("cnbUnder6Count");
        const planTotal =
          mode === "guests"
            ? slots.filter((sl) => (picks[sl.key] ?? "NONE") !== "NONE").length
            : cnt("mealPlanCpCount") + cnt("mealPlanMaplCount") + cnt("mealPlanMapdCount") + cnt("mealPlanApCount") + cnt("mealPlanOthersCount");
        const breakdownOff = occupants != null && peopleAssigned !== occupants;
        const plansOver = occupants != null && planTotal > occupants;

        // Hard cap on INCREASES (decreases always allowed): a band or meal-plan count that
        // would push its group past Occupants clamps to whatever still fits. Raising Occupants
        // first unlocks more, so the operator is never boxed in. With the cap in place the
        // over-count warnings can only appear via lowering Occupants afterwards.
        const bandKeys = ["adultCount", "cnb6To10Count", "cnbUnder6Count"];
        const mealKeys = ["mealPlanCpCount", "mealPlanMaplCount", "mealPlanMapdCount", "mealPlanApCount", "mealPlanOthersCount"];
        const cappedChange = (key: string, group: "band" | "meal") => (v: string) => {
          if (occupants != null && v !== "") {
            const newVal = Math.max(0, parseInt(v, 10) || 0);
            if (newVal > cnt(key)) {
              const keys = group === "band" ? bandKeys : mealKeys;
              const others = keys.filter((k) => k !== key).reduce((sum, k) => sum + cnt(k), 0);
              if (others + newVal > occupants) {
                setField(id, key, String(Math.max(0, occupants - others)));
                flashCapMsg(
                  id,
                  group === "band"
                    ? `Can't go above ${occupants} — this room has ${occupants} occupant${occupants === 1 ? "" : "s"}. Raise Occupants first.`
                    : `Can't go above ${occupants} meal-plan pax — one plan per occupant (${occupants} in this room).`,
                );
                return;
              }
            }
          }
          setField(id, key, v);
        };
        return (
          <div key={id} className={`rce-room${t.foc ? " foc" : ""}`}>
            <div className="rce-head">
              <span className="rce-roomno">Room {roomNumber}</span>
              <span className="ln" />
              <label className="rce-tog">
                <input type="checkbox" checked={t.sc} onChange={(e) => setToggle(id, "sc", e.target.checked)} />
                Service charge
              </label>
              <label className="rce-tog">
                <input type="checkbox" checked={t.gst} onChange={(e) => setToggle(id, "gst", e.target.checked)} />
                GST
              </label>
              <label className="rce-tog">
                <input type="checkbox" checked={t.foc} onChange={(e) => setToggle(id, "foc", e.target.checked)} />
                <b>FOC</b>
              </label>
            </div>

            {/* Occupants + CNB counts */}
            <div className="rce-grid five">
              <NumField label="Occupants" value={f.occupantCount} onChange={(v) => setField(id, "occupantCount", v)} />
              <NumField label="Adults" value={f.adultCount} onChange={cappedChange("adultCount", "band")} />
              <NumField label="CNB 6–10" value={f.cnb6To10Count} onChange={cappedChange("cnb6To10Count", "band")} />
              <NumField label="CNB <6" value={f.cnbUnder6Count} onChange={cappedChange("cnbUnder6Count", "band")} />
              <NumField label="Extra beds" value={f.extraBedCount} onChange={(v) => setField(id, "extraBedCount", v)} />
            </div>

            {(breakdownOff || plansOver || capMsg[id]) && (
              <div className="rce-warns">
                {capMsg[id] && <span key={capPulse} className="cap-note">{capMsg[id]}</span>}
                {breakdownOff && (
                  <span>
                    Adults + children = {peopleAssigned}, but Occupants says {occupants} — they must match.
                  </span>
                )}
                {plansOver && (
                  <span>
                    {planTotal} meal-plan pax for {occupants} occupant{occupants === 1 ? "" : "s"} — a guest has
                    one plan; drop {planTotal - (occupants ?? 0)}.
                  </span>
                )}
              </div>
            )}

            {/* Meal plans — per guest or raw counts */}
            <div className="rce-meals">
              <div className="rce-meals-head">
                <span className="rce-lbl">
                  <Users style={{ width: 11, height: 11, verticalAlign: "-1.5px" }} /> Meal plans
                </span>
                <div className="seg rce-seg">
                  <button type="button" className={mode === "guests" ? "on" : ""} onClick={() => setMealMode((p) => ({ ...p, [id]: "guests" }))}>
                    Per guest
                  </button>
                  <button type="button" className={mode === "counts" ? "on" : ""} onClick={() => setMealMode((p) => ({ ...p, [id]: "counts" }))}>
                    Counts
                  </button>
                </div>
                {mode === "guests" && slots.length > 1 && (
                  <select
                    className="rce-allsel"
                    value=""
                    onChange={(e) => e.target.value && setAllGuestPlans(id, e.target.value as PlanPick)}
                    title="Set every guest in this room to one plan"
                  >
                    <option value="">Everyone…</option>
                    {(Object.keys(PLAN_LABEL) as PlanPick[]).map((p) => (
                      <option key={p} value={p}>
                        {PLAN_LABEL[p]}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {mode === "guests" ? (
                slots.length === 0 ? (
                  <p className="rce-hint">Set adults / children above — each guest then gets their own plan.</p>
                ) : (
                  <div className="rce-guests">
                    {slots.map((s) => (
                      <label key={s.key} className="rce-guest">
                        <span>{s.label}</span>
                        <select value={picks[s.key] ?? "NONE"} onChange={(e) => setGuestPlan(id, s.key, e.target.value as PlanPick)}>
                          {(Object.keys(PLAN_LABEL) as PlanPick[]).map((p) => (
                            <option key={p} value={p}>
                              {PLAN_LABEL[p]}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )
              ) : (
                <div className="rce-grid five">
                  <NumField label="CP" value={f.mealPlanCpCount} onChange={cappedChange("mealPlanCpCount", "meal")} />
                  <NumField label="MAPL" value={f.mealPlanMaplCount} onChange={cappedChange("mealPlanMaplCount", "meal")} />
                  <NumField label="MAPD" value={f.mealPlanMapdCount} onChange={cappedChange("mealPlanMapdCount", "meal")} />
                  <NumField label="AP" value={f.mealPlanApCount} onChange={cappedChange("mealPlanApCount", "meal")} />
                  <NumField label="Others" value={f.mealPlanOthersCount} onChange={cappedChange("mealPlanOthersCount", "meal")} />
                </div>
              )}
            </div>

            {/* Others à-la-carte — only when someone is on Others */}
            {othersCount > 0 && (
              <div className="rce-grid three rce-others">
                <NumField label="Others breakfast pax" value={f.othersBreakfastPax} onChange={(v) => setField(id, "othersBreakfastPax", v)} />
                <NumField label="Others lunch pax" value={f.othersLunchPax} onChange={(v) => setField(id, "othersLunchPax", v)} />
                <NumField label="Others dinner pax" value={f.othersDinnerPax} onChange={(v) => setField(id, "othersDinnerPax", v)} />
              </div>
            )}

            {/* Negotiated rates — collapsible */}
            <button type="button" className="rce-adv" onClick={() => setAdvancedOpen((prev) => ({ ...prev, [id]: !advanced }))}>
              {advanced ? "− Hide" : "+ Negotiated rates (optional)"}
            </button>
            {advanced && (
              <div className="rce-grid five">
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
      <p className="rce-hint">
        Totals are priced by the backend when you create the draft — figures appear on the quote below.
        Child meal discounts on per-room plans are pending a backend update; until then every counted
        guest is charged the full plan rate (pick <i>None</i> for infants who eat free).
      </p>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <div className="rce-f">
      <label>{label}</label>
      <input type="number" min={0} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
