"use client";

/**
 * The rooms of a booking, as the S2 table — Arrival · Check-in · Stay (2026-10-06, operator:
 * "instead of these cards, can it maybe show like the table we have in s2, where we list how many
 * people are there in each room and meal plans and stuffs").
 *
 * **One surface, three steps.** The same table the price was negotiated on now shows what the
 * booking actually holds: each room with its nights, its guests by age band, its meal plans, its
 * extra beds and — where authority allows it to be read — its rates. Arrival's bins and
 * free-room cards are gone; Check-in and Stay reach it from a tab of their own rather than a
 * button buried on a room row.
 *
 * **A room is chosen by clicking it**, and its own acts appear above the table (operator:
 * "changing can be just clicking on one room in the table and showing an option"). Assign stays
 * a button of its own, because assigning is about the booking's plan rather than about one row.
 *
 * **Nothing here writes directly.** "Change room" opens the governed composite — a new pass, a
 * silently re-made quotation, the hold replaced, the reservation re-frozen, the guests re-seated
 * — which is what makes the change audited. The table itself is read-first; editing it is its own
 * act with its own walk.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system/components/primitives";
import { changeBookingRoom } from "@/lib/api/entries";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
import { RoomChangeControl } from "@/components/desk/workspace/room-change-control";
import { operativeRoomCompositions, roomStayRangesByRoom, roomsInUseFor } from "@/lib/desk/party-rooms";
import { optionSelectedRoomIds, type EntryDetail } from "@/types/api";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { listRooms } from "@/lib/api/rooms";
import { DsDialog, StepCard, Tool, toastRefusal, useBedPlan, useRefreshEntry, useStepMode } from "./kit";

/**
 * The room registry. Deliberately NOT imported from s5-rooms: Arrival imports this module, so
 * reaching back would make the two circular — fragile under the bundler even though ES modules
 * tolerate it. Same query key, so a bed changed by the old room tools refreshes this too.
 */
function useRoomsCatalog() {
  const { session } = useSession();
  return useQuery({ queryKey: ["rooms-catalog"], queryFn: () => listRooms(session!), enabled: !!session });
}

/**
 * The rooms the PLAN names, in the order the guest sleeps in them — a room the guest has already
 * moved out of is not one of them (see `roomsInUseFor`, which only applies that in-house).
 */
export function planRoomIds(entry: EntryDetail, hotelToday: string | null = null): string[] {
  const rows = entry.roomAssignments ?? [];
  const assigned = Array.from(new Set(roomsInUseFor(entry, hotelToday).map((a) => a.roomId)));
  const sealed = optionSelectedRoomIds(
    ((entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected) ?? null)?.optionSelected,
  );
  const hold = entry.committedHold?.roomId ?? null;
  const base = rows.length ? assigned : sealed.length ? sealed : hold ? [hold] : [];
  const ranges = roomStayRangesByRoom(entry);
  return [...base].sort((a, b) => {
    const A = ranges.get(a);
    const B = ranges.get(b);
    return (A?.firstNight ?? "9999").localeCompare(B?.firstNight ?? "9999") || (B?.nightCount ?? 0) - (A?.nightCount ?? 0);
  });
}

/** The table and the chosen room's acts, for a step that already has a card of its own. */
export function RoomsTable({
  entry,
  roomActions,
  lead,
}: {
  entry: EntryDetail;
  /** Acts for the chosen room that belong to this step — Arrival's Assign, say. */
  roomActions?: (roomId: string, roomNumber: string) => ReactNode;
  /** Shown above the table before any room is chosen. */
  lead?: ReactNode;
}) {
  const { past } = useStepMode();
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const catalogQ = useRoomsCatalog();
  const byId = useMemo(() => new Map((catalogQ.data?.items ?? []).map((r) => [r.id, r])), [catalogQ.data]);

  const hotelToday = useHotelDay()?.today ?? null;
  const beds = useBedPlan(entry.id);
  const ids = useMemo(() => planRoomIds(entry, hotelToday), [entry, hotelToday]);
  const seed = useMemo(() => operativeRoomCompositions(entry) ?? [], [entry]);
  const ranges = useMemo(() => roomStayRangesByRoom(entry), [entry]);
  const roomDates = useMemo(() => {
    const out: Record<string, { label: string; nights: number }> = {};
    for (const id of ids) {
      const r = ranges.get(id);
      if (r) out[id] = { label: r.label, nights: r.nightCount };
    }
    return out;
  }, [ids, ranges]);

  const [picked, setPicked] = useState<string | null>(null);
  const chosen = picked && ids.includes(picked) ? picked : null;

  /**
   * Changing the setup in place (2026-10-06, operator: "it should be editable in that as well,
   * meal and all, maybe have another option like change configurations ... in the front it looks
   * like we're doing it in that stage but behind the back it ... went to s2 to negotiate").
   *
   * That is exactly what happens: the table's own emission is posted as `roomCompositions` with
   * no room named, so the booking walks back through Negotiation, is re-quoted, re-held and
   * re-frozen, and comes back to this step. Nobody moves rooms. The quotation it mints is saved
   * and superseded like any other; it goes to the guest only if the desk sends it.
   */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RoomCompositionInput[] | null>(null);
  const [faults, setFaults] = useState<string[]>([]);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const numberOf = (id: string) =>
    (entry.roomAssignments ?? []).find((a) => a.roomId === id)?.room?.roomNumber ?? byId.get(id)?.roomNumber ?? id.slice(0, 6);

  /**
   * In-house the rates, the waivers and the discount are read-only — changing a rate mid-stay is
   * the GM's rate revision, and a night the folio has already posted must not silently re-price.
   * The figures still show: the operator has to be able to read what the booking is priced at.
   */
  const inHouse = entry.currentStage === "S7";

  const canon = (list: readonly RoomCompositionInput[] | undefined) => {
    const n = (v: unknown) => (v == null || v === "" ? "" : String(Number(v)));
    return [...(list ?? [])]
      .map((c) =>
        [
          c.roomId, n(c.adultCount ?? 0), n(c.cnb6To10Count ?? 0), n(c.cnbUnder6Count ?? 0), n(c.extraBedCount ?? 0),
          n(c.mealPlanCpCount ?? 0), n(c.mealPlanMaplCount ?? 0), n(c.mealPlanMapdCount ?? 0), n(c.mealPlanApCount ?? 0),
          n(c.negotiatedRoomRate), n(c.negotiatedExtraBedRate),
          c.serviceChargeApplies === false ? "0" : "1", c.gstApplies === false ? "0" : "1", c.isFoc === true ? "1" : "0",
        ].join("~"),
      )
      .sort()
      .join("//");
  };
  const unsaved = editing && draft != null && canon(draft) !== canon(seed);

  /**
   * The planner seeds itself ONCE, at mount (a lazy ref, so the grid is never yanked out from
   * under the operator mid-edit). So leaving edit mode has to REMOUNT it, or "Leave it as it was"
   * only stops the desk reading the edits while the grid, its live total and the Σ row all still
   * show them — and pressing Change configuration again then read "Saved" over a table that did
   * not match the quotation (2026-10-06, operator: "it looks like it saved the previous one, from
   * behind it didn't but UI looks like that").
   *
   * While editing the key is fixed, so a background refresh of the booking cannot discard typing;
   * otherwise it follows the seed, so a change made elsewhere shows here without a reload.
   */
  const plannerKey = editing ? "edit" : `seed:${canon(seed)}`;

  const changed = () =>
    refresh([
      ["rooms"],
      ["rooms-catalog"],
      ["room-plan-history", entry.id],
      ["room-change-candidates", entry.id],
      ["identity-proofs", entry.id],
      ["billing-summary", entry.id],
      ["entry-timers", entry.id],
    ]);

  const saveM = useMutation({
    mutationFn: (reason: string) =>
      changeBookingRoom(session!, entry.id, {
        // No room moves: the from-room only anchors the walk. The table IS the new basis.
        fromRoomId: chosen ?? ids[0],
        reason,
        roomCompositions: draft ?? seed,
      }),
    onSuccess: (res) => {
      setReasonOpen(false);
      setEditing(false);
      setDraft(null);
      changed();
      const d = res?.pricing?.delta;
      toast.success(
        d != null && d !== 0
          ? `Set up again — the total moved by ${d > 0 ? "+" : ""}${d.toLocaleString()} ${res.pricing?.currency ?? ""}`.trim()
          : "Set up again — the booking is re-priced on this table.",
      );
      if (res?.walk && !res.walk.returnedToOrigin)
        toast.warning(`The booking stopped at ${res.walk.reachedStage}: ${res.walk.blocked?.message ?? "a later step refused"}`);
    },
    onError: (e) => toastRefusal(e, "The setup could not be changed"),
  });

  if (ids.length === 0) return <span className="meta">No rooms on the plan yet — they are chosen at Inquiry.</span>;

  return (
    <>
      {lead ? <p className="sm" style={{ marginTop: 0 }}>{lead}</p> : null}

      {/* The chosen room's own acts, above the table they belong to. */}
      {!past ? (
        <div className="roomacts">
          <div className="line">
            {chosen ? (
              <>
                <span className="who">
                  Room <b>{numberOf(chosen)}</b>
                  {roomDates[chosen] ? <span className="meta"> · {roomDates[chosen].label}</span> : null}
                </span>
                {roomActions?.(chosen, numberOf(chosen))}
                <Button kind="quiet" compact onClick={() => setPicked(null)}>
                  Done with this room
                </Button>
              </>
            ) : (
              <span className="meta">Click a room in the table to see what can be done with it.</span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: "var(--s2)", alignItems: "center" }}>
              {editing ? (
                <>
                  <span className="meta">Editing — meals, beds and guests. Save prices it again.</span>
                  <Button
                    kind="quiet"
                    compact
                    onClick={() => {
                      setEditing(false);
                      setDraft(null);
                    }}
                  >
                    Leave it as it was
                  </Button>
                </>
              ) : (
                <Button kind="quiet" compact onClick={() => setEditing(true)}>
                  Change configuration…
                </Button>
              )}
            </span>
          </div>

          {/* Its own row, and its own `.desk-root`: the change panel opens a rooms-by-night table
              and the whole S2 planner inside itself, so as a flex ITEM in the line above it was
              squeezed to a column, and outside `.desk-root` none of its CSS applied at all
              (2026-10-06, operator: "after selecting a room from change rooms, the UI breaks"). */}
          {chosen ? (
            <Tool>
              <RoomChangeControl entry={entry} fromRoomId={chosen} fromRoomNumber={numberOf(chosen)} onChanged={changed} compact />
            </Tool>
          ) : null}
        </div>
      ) : null}

      {/* The planner is one of the old tools: every rule that lays its grid out is scoped under
          `.desk-root` in desk-theme.css, and `legacy-bridge.css` re-colours it there. Rendered
          bare it had no styling at all (2026-10-06, operator: "this looks very broken in s7"). */}
      <Tool inert={past}>
      <RoomCompositionPlanner
        key={plannerKey}
        bedPlan={beds.byRoom}
        onBedChange={beds.set}
        tableOnly
        sealedRoomIds={ids}
        entryCheckIn={entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null}
        entryCheckOut={entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? null}
        entryAdults={entry.adultCount ?? entry.guestCount ?? null}
        entryChildAges={entry.childAges ?? null}
        entryId={entry.id}
        roomDates={roomDates}
        initialCompositions={seed}
        lockCommercial={inHouse}
        onPickRoom={past ? undefined : (id) => setPicked((cur) => (cur === id ? null : id))}
        pickedRoomId={chosen}
        onChange={editing ? setDraft : () => { /* read-first until "Change configuration" is pressed */ }}
        onFaultsChange={editing ? setFaults : undefined}
        onSave={editing ? () => setReasonOpen(true) : undefined}
        saveLabel="Save & price it again"
        saving={saveM.isPending}
        unsaved={unsaved}
      />
      </Tool>

      <DsDialog
        open={reasonOpen}
        onClose={() => setReasonOpen(false)}
        register="commit"
        title="Set the booking up again"
        caseLines={[entry.id]}
        busy={saveM.isPending}
        footer={
          <>
            <Button kind="quiet" state={saveM.isPending ? "inert" : "default"} onClick={() => setReasonOpen(false)}>
              Not now
            </Button>
            <Button
              state={saveM.isPending ? "working" : reason.trim() ? "default" : "inert"}
              workingLabel="Pricing…"
              title={reason.trim() ? undefined : "type the reason to continue"}
              onClick={() => saveM.mutate(reason.trim())}
            >
              Price it again
            </Button>
          </>
        }
      >
        <p className="sm">
          The booking goes back through Negotiation and forward again on this table — re-quoted, re-held and re-frozen —
          and lands back on this step. <b>Nobody moves rooms.</b> The quotation is saved against the booking; it reaches
          the guest only if you send it.
          {inHouse ? " The nights already slept keep the setup they were billed on." : ""}
        </p>
        <div className="field">
          <label>Why</label>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="what the guest asked for" autoFocus />
        </div>
      </DsDialog>

      <div className="meta" style={{ marginTop: 8 }}>
        {inHouse
          ? "In-house the rates and waivers are read-only — a mid-stay rate revision is the GM's call, and nights already posted are corrected on the folio."
          : "What the booking is priced on today. A change here runs the full journey behind the scenes and is recorded against the booking."}
      </div>
    </>
  );
}

/**
 * The same thing as a card of its own — Check-in and Stay reach it from a tab, where there is no
 * surrounding card to sit inside.
 */
export function RoomsTableCard({
  entry,
  title = "The rooms",
  roomActions,
  lead,
  flow,
  flowAfter,
}: {
  entry: EntryDetail;
  title?: string;
  roomActions?: (roomId: string, roomNumber: string) => ReactNode;
  lead?: ReactNode;
  flow?: string;
  flowAfter?: string;
}) {
  const n = planRoomIds(entry, useHotelDay()?.today ?? null).length;
  return (
    <StepCard title={title} flow={flow} flowAfter={flowAfter} right={n ? <Chip tone="quiet">{n === 1 ? "1 room" : `${n} rooms`}</Chip> : null}>
      <RoomsTable entry={entry} roomActions={roomActions} lead={lead} />
    </StepCard>
  );
}
