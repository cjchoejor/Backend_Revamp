"use client";

/**
 * "Change configuration" — the dates, the rooms and the party, changed at Negotiation
 * (2026-09-30, operator ruling; the dates since 2026-10-12). Before this, dropping two rooms and
 * two guests after the quote was priced meant a re-entry to Inquiry, which reads to the desk like
 * starting the enquiry again.
 *
 * The screen runs in the order the operator described it: edit the stay, ask the house, then
 * tick and untick the rooms already chosen.
 *
 *   1. The stay — check-in, nights and check-out, adults, children and their ages, the rooms
 *      asked for. EDITABLE (operator: "this shouldn't be read only, the user can edit the
 *      adults, number of room, children and ages here and then click ask the house"; and
 *      2026-10-12: "make it so that the dates can be changed as well ... do it here, but it
 *      should be well audited").
 *   2. Ask the house — the same search the Inquiry step runs, over the dates in step 1. A search
 *      for other dates no longer counts once the dates are edited: it is asked again.
 *   3. The rooms — the same table, already ticked with what the booking holds today, so the
 *      change is a tick or an untick rather than a fresh pick. On new dates, a held room that is
 *      not free on the new nights is unticked and named.
 *
 * Everything is sent as ONE governed act — `POST /entries/:id/negotiation-amendment` — so the
 * backend can own the consequences the desk must not invent: retiring the quotations this
 * change makes untrue, and moving the provisional block to the new rooms with its original
 * deadline. Nothing here writes to the booking on its own.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import {
  queryAvailabilityByEntry,
  roomsFromResultSet,
  type AvailabilityQueryResponse,
} from "@/lib/api/availability";
import {
  changeStayInPlace,
  amendNegotiationConfiguration,
  decideNegotiationAmendment,
  withdrawNegotiationAmendment,
} from "@/lib/api/entries";
import { getAllowedRoomCounts } from "@/lib/api/child-policy";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { listRooms } from "@/lib/api/rooms";
import { RoomStatusTable, roomStatusRows } from "@/components/desk/workspace/room-status-table";
import { currentPassConfigs } from "@/lib/desk/workspace";
import { fmtDateTime, fmtRange, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, type AvailabilityOptionSelected, type EntryDetail } from "@/types/api";
import { Tool, atLeast, toastRefusal, useRefreshEntry } from "./kit";
import { Help } from "@/components/ds/help";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
import { foldNightsToRangesLabel, operativeRoomCompositions } from "@/lib/desk/party-rooms";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import { enumerateNights, useRoomSelection } from "./use-room-selection";
import { DateInput } from "@/components/ds/date-input";
import { RoomsByType, type TypePicks } from "./s1-by-type";

/**
 * A count field that may be emptied while typing — "0" and "" are different answers. A keystroke
 * the field refuses SAYS so ("UIappeal"): a number that silently fails to appear reads as a
 * broken input. The real ceiling for a party is the house's own, which the backend answers with;
 * these caps are only there to stop a typo becoming a 900-guest lookup.
 */
function Count({
  label,
  value,
  onChange,
  min = 0,
  max = 200,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  const [capped, setCapped] = useState(false);
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "");
          if (v === "") {
            setCapped(false);
            return onChange("");
          }
          const n = Number(v);
          if (n > max) {
            setCapped(true);
            window.setTimeout(() => setCapped(false), 4000);
            return;
          }
          setCapped(false);
          onChange(String(Math.max(min, n)));
        }}
      />
      {capped ? (
        <span className="hint stop-ink" role="alert">
          at most {max} here
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function ChangeConfiguration({
  entry,
  onClose,
  onDone,
  inPlace = false,
}: {
  entry: EntryDetail;
  onClose: () => void;
  onDone: () => void;
  /**
   * Set up, Reserve and Arrival (2026-10-29, operator: "the backend goes back but the user stays on
   * the current page"): the same editor, plus who sleeps where, saved through the in-place walk —
   * the booking goes back through Negotiation and returns to this step with its papers made again.
   */
  inPlace?: boolean;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);

  /* ---- 1. the stay, as the operator may now retype it -------------------------- */
  const hotelDay = useHotelDay();
  const oldIn = entry.checkInDate?.slice(0, 10) ?? "";
  const oldOut = entry.checkOutDate?.slice(0, 10) ?? "";
  const [checkIn, setCheckIn] = useState(oldIn);
  const [nights, setNights] = useState(String(enumerateNights(entry.checkInDate, entry.checkOutDate).length || 1));
  const nightsN = Math.max(1, Number(nights || "1"));
  /** The check-out follows the check-in and the nights — the same rule as the Inquiry step. */
  const checkOut = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) return "";
    const d = new Date(`${checkIn}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + nightsN);
    return d.toISOString().slice(0, 10);
  }, [checkIn, nightsN]);
  const datesMoved = !!checkIn && !!checkOut && (checkIn !== oldIn || checkOut !== oldOut);
  /** The hotel's today only — never the machine's clock; unknown means not judged yet. */
  const startsBeforeToday = !!hotelDay && !!checkIn && checkIn < hotelDay.today;
  const [adults, setAdults] = useState(String(entry.adultCount ?? entry.guestCount ?? 1));
  const [children, setChildren] = useState(String(entry.childCount ?? 0));
  const [ages, setAges] = useState<string[]>(() => (entry.childAges ?? []).map(String));
  const [rooms, setRooms] = useState(String(entry.numberOfRooms ?? 1));
  const [reason, setReason] = useState("");
  /**
   * The rooms by TYPE, the way the Inquiry step picks them (2026-10-29, operator: "it doesn't show
   * the availability chart like shown in S1 when I ask the house — adopt the same style for this
   * section in all stages"): how many of each type each night, the system choosing the rooms. Every
   * room by number stays one press away.
   */
  const [byNumber, setByNumber] = useState(false);
  const typeMode = !byNumber;
  const [typePicks, setTypePicks] = useState<TypePicks | null>(null);

  const childCount = Number(children || "0");
  const adultCount = Number(adults || "0");
  const roomCount = Math.max(1, Number(rooms || "1"));
  const agesReady = ages.slice(0, childCount).every((a) => a !== "" && Number(a) >= 0);
  /** Every age the party needs — the grid grows and shrinks with the count. */
  const ageInputs = useMemo(
    () => Array.from({ length: childCount }, (_, i) => ages[i] ?? ""),
    [childCount, ages],
  );

  /** The house's own envelope for this party — the same lookup the intake screen asks. */
  const envelope = useQuery({
    queryKey: ["allowed-room-counts", adultCount, ageInputs.join(",")],
    queryFn: () =>
      getAllowedRoomCounts(session!, {
        adults: adultCount,
        childAges: ageInputs.filter((a) => a !== "").map(Number),
      }),
    enabled: !!session && adultCount > 0 && agesReady,
    staleTime: 30_000,
  });
  const env = envelope.data;
  /** The house's room-count envelope for this party — `allowedRoomCounts` on the response. */
  const envMin = env?.allowedRoomCounts?.min ?? null;
  const envMax = env?.allowedRoomCounts?.max ?? null;

  /* ---- 2. the house's answer ---------------------------------------------------- */
  const [answer, setAnswer] = useState<{ data: AvailabilityQueryResponse; dates: string } | null>(null);
  const datesKey = `${checkIn}|${checkOut}`;
  /** An answer counts only for the dates it was asked about — edit them and it is asked again. */
  const result = answer && answer.dates === datesKey ? answer.data : null;
  const answerOutdated = !!answer && answer.dates !== datesKey;
  const ask = useMutation({
    mutationFn: async () => {
      if (!checkIn || !checkOut) throw new Error("Give the check-in and the nights first");
      const data = await queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guestCount: adultCount + childCount,
        useType: entry.useType ?? undefined,
      });
      return { data, dates: `${checkIn}|${checkOut}` };
    },
    onSuccess: (a) => {
      setAnswer(a);
      toast.success(typeMode ? "The house has answered — set the room types below" : "The house has answered — tick or untick the rooms below");
      /**
       * On new dates, a carried room that is not free on every new night is unticked — and named,
       * never silently (2026-10-12). Done here, where the answer lands, rather than in an effect:
       * a toast raised from an effect never reached the screen.
       */
      const pd = Array.isArray(a.data.results?.perDate) ? a.data.results.perDate : null;
      if (!datesMoved || !pd?.length) return;
      const freeEveryNight = (id: string) => pd.every((d) => d.availableRoomIds.includes(id) || d.deficientRoomIds.includes(id));
      const gone = sel.base.filter((id) => !freeEveryNight(id));
      if (gone.length === 0) return;
      sel.setBase(sel.base.filter(freeEveryNight));
      toast.warning(
        `${gone.length === 1 ? "Room" : "Rooms"} ${gone.map(roomNo).join(", ")} ${gone.length === 1 ? "is" : "are"} not free on the new nights — unticked. Pick ${gone.length === 1 ? "another" : "others"} below.`,
        { duration: 9000 },
      );
    },
    onError: (e) => toastRefusal(e, "The house could not be asked"),
  });

  const catalog =
    useQuery({
      queryKey: ["rooms"],
      queryFn: () => listRooms(session!),
      enabled: !!session,
      staleTime: 60_000,
    }).data?.items ?? [];

  const configId = result?.configurationId ?? null;
  const { available, deficient, unavailable, perDate } = useMemo(() => {
    const src = result?.results ?? null;
    const r = src ? roomsFromResultSet(src) : { availableRooms: [], deficientRooms: [], unavailableRooms: [] };
    return {
      available: r.availableRooms,
      deficient: r.deficientRooms,
      unavailable: r.unavailableRooms,
      perDate: Array.isArray(src?.perDate) ? src.perDate : undefined,
    };
  }, [result]);

  const extBeds = useMemo(
    () => new Map(catalog.filter((r) => typeof r.roomType?.maxExtraBeds === "number").map((r) => [r.id, r.roomType!.maxExtraBeds!])),
    [catalog],
  );
  const bedOf = useMemo(() => new Map(catalog.filter((r) => r.bedType).map((r) => [r.id, r.bedType!])), [catalog]);
  const rows = useMemo(
    () => roomStatusRows(available, deficient, unavailable, extBeds, bedOf),
    [available, deficient, unavailable, extBeds, bedOf],
  );

  const stayNights = useMemo(() => enumerateNights(checkIn, checkOut), [checkIn, checkOut]);
  const displayNights = useMemo(() => (perDate?.length ? perDate.map((p) => p.date) : stayNights), [perDate, stayNights]);

  /* ---- 3. the rooms, seeded from what the booking holds TODAY -------------------- */
  const sealed = currentPassConfigs(entry).find((c) => c.sealedAt && c.optionSelected) ?? null;
  const savedOption = (sealed?.optionSelected ?? null) as AvailabilityOptionSelected | null;
  const priorRoomIds = useMemo(() => optionSelectedRoomIds(savedOption), [savedOption]);
  const sel = useRoomSelection({
    // A key of its own: these picks are the amendment's, and must not overwrite the Inquiry
    // step's in-progress selection stored under the booking's own key.
    entryId: `${entry.id}:amend`,
    numberOfRooms: roomCount,
    savedOption,
    displayNights,
    stayNights,
  });

  /**
   * Lowering the room count leaves more rooms ticked than the booking now asks for. The extra
   * ones are dropped from the END of the pick rather than left over the cap, so the table can
   * never show three ticks under a heading that says one — the operator re-ticks whichever they
   * meant to keep.
   */
  useEffect(() => {
    if (sel.base.length > roomCount) sel.setBase(sel.base.slice(0, roomCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCount]);

  const roomNo = (id: string) => catalog.find((r) => r.id === id)?.roomNumber ?? id.slice(0, 6);

  /**
   * New dates, new nights (2026-10-12). A night the stay no longer has can hold no pick, so its
   * row is dropped; the rooms held on EVERY night carry over to the new nights as the first
   * guess, and the house's answer then says which of them are still free.
   */
  const nightsKey = stayNights.join(",");
  useEffect(() => {
    const keep = new Set(stayNights);
    if (Object.keys(sel.overrides).some((n) => !keep.has(n))) {
      sel.setOverrides((prev) => Object.fromEntries(Object.entries(prev).filter(([n]) => keep.has(n))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nightsKey]);
  const picked = sel.allPicked;
  const dropped = priorRoomIds.filter((id) => !picked.includes(id));
  const added = picked.filter((id) => !priorRoomIds.includes(id));
  /**
   * Whether the rooms moved is read NIGHT BY NIGHT (2026-10-22): the same rooms arranged over the
   * nights differently is a change too, and comparing only which rooms the booking uses said
   * "nothing has changed" for it. A pick never sealed reads as moved whenever anything is ticked.
   */
  const roomsMovedByNumber = sel.currentCanon !== sel.savedCanon && (sel.currentCanon != null || sel.savedCanon != null);
  // By type the grid knows whether its counts differ from what is saved; a fitting plan is ready.
  const roomsMoved = typeMode ? !!typePicks && !typePicks.saved : roomsMovedByNumber;
  const roomsReady = typeMode ? !!typePicks : sel.ready;
  const partyMoved =
    adultCount !== (entry.adultCount ?? 0) ||
    childCount !== (entry.childCount ?? 0) ||
    roomCount !== (entry.numberOfRooms ?? 0) ||
    ageInputs.join(",") !== (entry.childAges ?? []).join(",");

  /**
   * Changing the room COUNT without re-picking would leave the booking asking for one room while
   * two are still sealed — the count is the ask, the seal is the pick, and the composition table
   * below prices the seal. So a changed count must be answered with a fresh pick of exactly that
   * many rooms; the save says so rather than writing the two into disagreement.
   */
  /**
   * The count is the rooms the booking asks for ON EACH NIGHT, and the pick is complete when every
   * night holds exactly that many (2026-10-22, operator: "8 of 5 rooms chosen" and a Save that
   * never opened). On a stay that changes rooms the booking uses more rooms in all than it holds
   * on any one night, so the old test — every room it uses against the count — could never pass.
   */
  const countMoved = roomCount !== (entry.numberOfRooms ?? priorRoomIds.length);
  const pickComplete = roomsReady;
  const needsRepick = (countMoved || roomsMoved) && !datesMoved && (!configId || !pickComplete);
  /** New dates are only saved with rooms picked for every new night, from a search for them. */
  const needsNightPick = datesMoved && (!configId || !roomsReady);

  /* ---- 4. who sleeps where (in place): the table over the rooms picked ---------- */
  const pickPayload = sel.payload();
  const pickedPerNight = useMemo(
    () =>
      typeMode
        ? (typePicks?.perNight ?? [])
        : (pickPayload.perNight ?? stayNights.map((date) => ({ date, roomIds: [...(pickPayload.roomIds ?? [])] }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typeMode, JSON.stringify(typePicks?.perNight ?? null), JSON.stringify(pickPayload.perNight ?? pickPayload.roomIds ?? []), stayNights.join(",")],
  );
  const pickedRoomIds = useMemo(() => [...new Set(pickedPerNight.flatMap((n) => n.roomIds))], [pickedPerNight]);
  const pickedRoomDates = useMemo(() => {
    const out: Record<string, { label: string; nights: number; dates: string[] }> = {};
    for (const id of pickedRoomIds) {
      const dates = pickedPerNight.filter((n) => n.roomIds.includes(id)).map((n) => n.date);
      out[id] = { label: foldNightsToRangesLabel(dates), nights: dates.length, dates };
    }
    return out;
  }, [pickedRoomIds, pickedPerNight]);
  /**
   * A room kept from today brings its row along (meals, beds, rates); a new room starts empty. By
   * type, a room the system put elsewhere within its type is the same booking room — its row follows
   * it to the new room of that type.
   */
  const seedComps = useMemo(() => {
    const now = operativeRoomCompositions(entry) ?? [];
    const kept = now.filter((c) => pickedRoomIds.includes(c.roomId)).map((c) => ({ ...c, nightMealOverrides: undefined }));
    if (!typeMode) return kept;
    const typeOf = (id: string) => catalog.find((r) => r.id === id)?.roomTypeId ?? null;
    const left = now.filter((c) => !pickedRoomIds.includes(c.roomId));
    const out = [...kept];
    for (const id of pickedRoomIds) {
      if (out.some((c) => c.roomId === id)) continue;
      const i = left.findIndex((c) => typeOf(c.roomId) != null && typeOf(c.roomId) === typeOf(id));
      if (i < 0) continue;
      out.push({ ...left[i], roomId: id, nightMealOverrides: undefined });
      left.splice(i, 1);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedRoomIds.join(","), typeMode, catalog.length]);
  const [comps, setComps] = useState<RoomCompositionInput[]>([]);
  /** The rooms or the party changed: the table seats the party itself, keeping each room's meals and rates. */
  const autoSeat = partyMoved || pickedRoomIds.some((id) => !seedComps.some((c) => c.roomId === id));
  const [tableFaults, setTableFaults] = useState<string[]>([]);
  const tableReady = inPlace && !!configId && roomsReady;

  const overCapacity = !!env && env.exceedsHotelCapacity;
  const roomsOutOfRange = !!env && envMin != null && envMax != null && (roomCount < envMin || roomCount > envMax);

  /** In place: the walk — back through Negotiation, priced again, back to this step. */
  const change = useMutation({
    mutationFn: () =>
      changeStayInPlace(session!, entry.id, {
        dates: { checkInDate: checkIn, checkOutDate: checkOut },
        party: {
          adultCount,
          childCount,
          childAges: ageInputs.filter((a) => a !== "").map(Number),
          numberOfRooms: roomCount,
        },
        rooms: typeMode && typePicks
          ? { configurationId: configId!, perNight: typePicks.perNight, byType: typePicks.byType }
          : { configurationId: configId!, perNight: pickedPerNight },
        roomCompositions: comps,
        reason: reason.trim(),
        expectedVersion: entry.version,
      }),
    onSuccess: (o) => {
      refresh([["held-documents", entry.id], ["entry-communications", entry.id], ["booking-rooms", entry.id], ["rooms"], ["rooms-catalog"], ["billing-summary", entry.id]]);
      if (o.blocked) {
        toast.warning(`The stay changed, but the booking stopped on the way back: ${o.blocked.message}`, { duration: 12000 });
      } else {
        toast.success(`The stay is changed — ${o.summary}`);
      }
      if (o.heldDocuments.some((h) => h.kind === "CONFIRMATION_VOUCHER")) toast.info("A new confirmation voucher is made — send it to the guest, or not, on the voucher.", { duration: 9000 });
      if (o.heldDocuments.some((h) => h.kind === "PROFORMA")) toast.info("A new proforma is made — send it to the guest, or not.", { duration: 9000 });
      for (const n of o.notes) toast.info(n, { duration: 9000 });
      try {
        localStorage.removeItem(`desk:rst-sel:${entry.id}:amend`);
      } catch {
        /* a blocked store must not break the save */
      }
      onDone();
    },
    onError: (e) => toastRefusal(e, "The stay could not be changed"),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof amendNegotiationConfiguration>[2] = {
        reason: reason.trim(),
        expectedVersion: entry.version,
      };
      if (datesMoved) body.dates = { checkInDate: checkIn, checkOutDate: checkOut };
      if (partyMoved) {
        body.party = {
          adultCount,
          childCount,
          childAges: ageInputs.filter((a) => a !== "").map(Number),
          numberOfRooms: roomCount,
        };
      }
      if ((roomsMoved || datesMoved) && configId) {
        if (typeMode && typePicks) {
          body.rooms = { configurationId: configId, byType: typePicks.byType };
        } else {
          const p = sel.payload();
          body.rooms = {
            configurationId: configId,
            roomIds: p.perNight ? undefined : p.roomIds,
            perNight: p.perNight,
          };
        }
      }
      return amendNegotiationConfiguration(session!, entry.id, body);
    },
    onSuccess: (o) => {
      if (!o.applied) {
        // The operator prepared it; nothing on the booking has moved (2026-09-30 ruling).
        toast.success(`Sent for approval — ${o.summary}`);
        toast.info("The FOM sees it on this step. Nothing has changed on the booking yet.");
        onDone();
        return;
      }
      toast.success(`The configuration is changed — ${o.summary}`);
      if (o.holdTimeCleared) {
        toast.info("The hold time set for this booking ran past the new arrival day — it is back to the house window.");
      }
      if (o.requestsOutsideStay.length > 0) {
        toast.warning(
          `${plural(o.requestsOutsideStay.length, "guest request")} now ${o.requestsOutsideStay.length === 1 ? "falls" : "fall"} outside the stay — check ${o.requestsOutsideStay.length === 1 ? "it" : "them"} under Guest requests.`,
          { description: o.requestsOutsideStay.map((r) => `${r.kind} · ${r.forDate}`).join(" · "), duration: 9000 },
        );
      }
      if (o.guestOverlap) {
        toast.warning(`This guest also holds ${o.guestOverlap} over the new nights — the FOM confirms both at Reserve.`, { duration: 9000 });
      }
      if (o.quotationsInvalidated.length > 0) {
        toast.info(
          `${plural(o.quotationsInvalidated.length, "quotation")} retired — price it again before moving to Set up.`,
        );
      }
      if (o.hold?.action === "REPLACED") {
        toast.info(`The provisional block moved to the new ${o.datesChanged ? "nights" : "rooms"}, keeping its deadline.`);
      }
      if (o.hold?.action === "RELEASED") toast.warning(o.hold.note);
      try {
        localStorage.removeItem(`desk:rst-sel:${entry.id}:amend`);
      } catch {
        /* a blocked store must not break the save */
      }
      onDone();
    },
    onError: (e) => toastRefusal(e, "The configuration could not be changed"),
  });

  /**
   * Once a quotation has gone to the guest or been accepted, the change is the FOM's call — so
   * the desk says so on the button rather than letting the operator press Save and be told
   * afterwards. The backend decides for real; this only names what the press will do.
   */
  const liveQuote = (entry.quotations ?? []).some((q) => q.state === "SENT" || q.state === "ACCEPTED");
  const needsApproval = !inPlace && liveQuote && !atLeast(session?.actorLevel, "L2");
  const pending = save.isPending || change.isPending;

  const nothingMoved = !partyMoved && !roomsMoved && !datesMoved;
  const blocked =
    !reason.trim() ||
    nothingMoved ||
    !checkIn ||
    startsBeforeToday ||
    overCapacity ||
    roomsOutOfRange ||
    needsRepick ||
    needsNightPick ||
    !agesReady ||
    adultCount < 1 ||
    (roomsMoved && !configId) ||
    (inPlace && (!configId || !roomsReady || comps.length === 0 || tableFaults.length > 0)) ||
    pending;

  return (
    <div className="cfg-change">
      <div className="cfg-head">
        <div>
          <b>Change the dates, the rooms and the party</b>
          <Help label="About changing the configuration">
            <p>
              Change the stay, ask the house, then tick the rooms. The rooms this booking holds today come back ticked, so a change is a tick
              or an untick.
            </p>
            <p>New dates need the house asked again for them, and the rooms picked for every new night.</p>
            {inPlace ? (
              <p>
                The booking stays on this step. Behind it, it goes back through Negotiation: the price is made again, the rooms are blocked
                again and, from Reserve on, it is reserved again with a new voucher held for you to send — then it comes back here.
              </p>
            ) : null}
          </Help>
        </div>
        <Button kind="quiet" compact onClick={onClose}>
          Cancel
        </Button>
      </div>

      {/* 1 ---------------------------------------------------------------- the stay */}
      <section>
        <b className="cfg-n">1 · The stay</b>
        <div className="form3" style={{ marginTop: 8 }}>
          <div className="field">
            <label>Check-in</label>
            <DateInput
              className="input"
              value={checkIn}
              min={hotelDay?.today}
              onChange={(e) => setCheckIn(e.target.value)}
            />
            {startsBeforeToday ? (
              <span className="hint stop-ink" role="alert">
                the stay can start today or later
              </span>
            ) : null}
          </div>
          <Count label="Nights" value={nights} onChange={setNights} min={1} max={90} />
          <div className="field">
            <label>Check-out</label>
            <DateInput
              className="input"
              value={checkOut}
              min={checkIn || undefined}
              onChange={(e) => {
                const n = enumerateNights(checkIn, e.target.value).length;
                if (n >= 1) setNights(String(n));
              }}
            />
          </div>
        </div>
        {datesMoved ? (
          <p className="cfg-move" role="status">
            Moving the stay from <b>{fmtRange(oldIn, oldOut)}</b> ({plural(enumerateNights(oldIn, oldOut).length, "night")}) to{" "}
            <b>{fmtRange(checkIn, checkOut)}</b> ({plural(nightsN, "night")}).
          </p>
        ) : null}
        <div className="form2" style={{ marginTop: 8 }}>
          <Count label="Adults" value={adults} onChange={setAdults} min={1} />
          <Count
            label="Children"
            value={children}
            onChange={(v) => {
              setChildren(v);
              const n = Number(v || "0");
              setAges((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? ""));
            }}
          />
          <Count
            label="Rooms"
            value={rooms}
            onChange={setRooms}
            min={1}
            hint={
              envMin != null && envMax != null
                ? envMin === envMax
                  ? `${plural(envMin, "room")} for this party`
                  : `${envMin}–${envMax} rooms fit this party`
                : undefined
            }
          />
          <div className="field">
            <label>Their ages</label>
            {childCount === 0 ? (
              <input className="input" readOnly value="no children" />
            ) : (
              <div className="row-acts" style={{ flexWrap: "wrap" }}>
                {ageInputs.map((a, i) => (
                  <span key={i} className="count-in sm">
                    <input
                      className="input"
                      inputMode="numeric"
                      aria-label={`Child ${i + 1}'s age`}
                      value={a}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                        setAges((prev) => {
                          const next = [...prev];
                          next[i] = v;
                          return next;
                        });
                      }}
                    />
                    {`child ${i + 1}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {overCapacity && (
          <p className="cfg-stop" role="alert">
            This party cannot be accommodated — the house sleeps {env?.hotelMaxOccupants} across its {env?.hotelRoomCount} rooms.
          </p>
        )}
        {!overCapacity && roomsOutOfRange && env && (
          <p className="cfg-stop" role="alert">
            {roomCount < envMin
              ? `${plural(env.chargeableOccupants, "chargeable guest")} will not fit in ${plural(roomCount, "room")} — ask for at least ${envMin}.`
              : `${plural(roomCount, "room")} is more than this party needs — at most ${envMax}.`}
          </p>
        )}
      </section>

      {/* 2 ---------------------------------------------------------------- the house */}
      <section>
        <b className="cfg-n">2 · Ask the house</b>
        <div className="row-acts" style={{ marginTop: 8 }}>
          <Button kind="secondary" compact onClick={() => ask.mutate()} state={ask.isPending ? "inert" : "default"}>
            {result ? "Ask again" : "Ask the house"}
          </Button>
          {result ? (
            <span className="sm">
              {plural(available.length, "room")} free over {fmtRange(checkIn, checkOut)}
            </span>
          ) : answerOutdated ? (
            <span className="warn-ink sm" style={{ fontWeight: 600 }}>
              The dates changed — ask the house again for {fmtRange(checkIn, checkOut)}.
            </span>
          ) : null}
        </div>
      </section>

      {/* 3 ---------------------------------------------------------------- the rooms */}
      <section>
        <b className="cfg-n">3 · The rooms</b>
        {!result ? (
          <p className="sm" style={{ marginTop: 6 }}>
            Ask the house {answerOutdated ? "for the new dates" : "first"}. Holding today:{" "}
            {priorRoomIds.length ? priorRoomIds.map(roomNo).join(", ") : "none"}.
          </p>
        ) : typeMode ? (
          <div style={{ marginTop: 8 }}>
            <RoomsByType
              key={`${checkIn}|${checkOut}|${roomCount}`}
              entry={entry}
              configId={configId}
              stale={false}
              nights={stayNights}
              numberOfRooms={roomCount}
              catalog={catalog}
              editable={!pending}
              onPicks={setTypePicks}
              onSaved={() => {}}
              onParticular={() => {
                setTypePicks(null);
                setByNumber(true);
              }}
              stay={{ checkIn, checkOut }}
              noSave
              flowKey={null}
            />
          </div>
        ) : (
          <>
            <div className="row-acts" style={{ margin: "8px 0" }}>
              <Button kind="quiet" compact onClick={() => setByNumber(false)}>
                Back to room types
              </Button>
              <span className={pickComplete ? "ok-ink" : "stop-ink"} style={{ fontWeight: 700 }}>
                {sel.nightsDiffer
                  ? `${sel.nightsReady} of ${plural(displayNights.length, "night")} ${sel.nightsReady === 1 ? "has" : "have"} ${plural(roomCount, "room")}`
                  : `${sel.commonPlan.length} of ${plural(roomCount, "room")} chosen`}
              </span>
              {roomsMoved ? (
                <span className="sm">
                  {dropped.length ? `dropping ${dropped.map(roomNo).join(", ")}` : ""}
                  {dropped.length && added.length ? " · " : ""}
                  {added.length ? `adding ${added.map(roomNo).join(", ")}` : ""}
                  {!dropped.length && !added.length ? "the same rooms, on different nights" : ""}
                </span>
              ) : (
                <span className="sm">the same rooms as now</span>
              )}
            </div>
            <Tool>
              <RoomStatusTable
                rows={rows}
                nights={displayNights}
                perDate={perDate}
                selectedIds={sel.base}
                perNightSel={sel.effectiveByNight}
                referenceIds={sel.commonPlan}
                maxSelect={roomCount}
                onToggle={sel.toggleRow}
                onToggleCell={sel.toggleCell}
                onSelectAllNights={sel.reportSelectAll}
                onCappedClick={() =>
                  toast.info(`All ${plural(roomCount, "room")} are chosen — untick one first to swap it.`)
                }
                disabled={pending}
              />
            </Tool>
          </>
        )}
      </section>

      {/* 4 ---------------------------------------------------------------- who sleeps where (in place) */}
      {inPlace ? (
        <section>
          <b className="cfg-n">4 · Who sleeps where</b>
          {!tableReady ? (
            <p className="sm" style={{ marginTop: 6 }}>
              Pick the rooms for every night first — then who sleeps in each, on what plan.
            </p>
          ) : (
            <div style={{ marginTop: 8 }}>
              <Tool>
                <RoomCompositionPlanner
                  key={`${pickedRoomIds.join(",")}|${checkIn}|${checkOut}|${adultCount}|${ageInputs.join(",")}`}
                  tableOnly
                  sealedRoomIds={pickedRoomIds}
                  entryCheckIn={checkIn}
                  entryCheckOut={checkOut}
                  entryAdults={adultCount}
                  entryChildAges={ageInputs.filter((a) => a !== "").map(Number)}
                  roomDates={pickedRoomDates}
                  {...(typeMode && typePicks ? { roomLabels: typePicks.labels } : {})}
                  entryId={entry.id}
                  initialCompositions={seedComps}
                  autoSeat={autoSeat}
                  previewStay={{ checkInDate: checkIn, checkOutDate: checkOut }}
                  onFaultsChange={setTableFaults}
                  onChange={setComps}
                />
              </Tool>
              {tableFaults.length ? (
                <p className="cfg-stop" role="alert" style={{ marginTop: 6 }}>
                  {tableFaults[0]}
                  {tableFaults.length > 1 ? ` · and ${plural(tableFaults.length - 1, "more thing")}` : ""}
                </p>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ the save */}
      <section>
        <div className="field">
          <label>Why the change</label>
          <input
            className="input"
            value={reason}
            placeholder="the guest's party shrank — two rooms no longer needed"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button
            kind="primary"
            className={inPlace && !blocked ? "go" : undefined}
            onClick={() => (inPlace ? change.mutate() : save.mutate())}
            state={blocked ? "inert" : "default"}
            reason={
              nothingMoved
                ? "Nothing has changed yet"
                : startsBeforeToday
                  ? "The stay can start today or later"
                  : needsNightPick
                    ? !configId
                      ? "The dates changed — ask the house for them, then pick the rooms"
                      : typeMode
                        ? "Set the room types for every new night — the grid says what is short"
                        : `Pick the rooms for every new night — ${sel.nightsReady} of ${plural(stayNights.length, "night")} ready`
                    : needsRepick
                  ? !configId
                    ? countMoved
                      ? `The rooms asked for changed to ${roomCount} — ask the house and pick them`
                      : "Ask the house before saving rooms"
                    : typeMode
                      ? `Set ${plural(roomCount, "room")} for every night in the grid`
                      : sel.nightsDiffer
                        ? `Every night needs ${plural(roomCount, "room")} — ${sel.nightsReady} of ${plural(displayNights.length, "night")} ${sel.nightsReady === 1 ? "has" : "have"} them`
                        : `Pick ${plural(roomCount, "room")} below — ${sel.commonPlan.length} ${sel.commonPlan.length === 1 ? "is" : "are"} ticked`
                  : inPlace && !configId
                    ? "Ask the house for the stay first"
                    : inPlace && !roomsReady
                      ? typeMode
                        ? "Set the room types for every night"
                        : "Pick the rooms for every night"
                      : inPlace && tableFaults.length > 0
                        ? "Put right what the table lists first"
                        : !reason.trim()
                    ? "Type why the configuration is changing"
                    : !agesReady
                      ? "Every child needs an age"
                      : roomsMoved && !configId
                        ? "Ask the house before saving rooms"
                        : undefined
            }
          >
            {inPlace
              ? change.isPending
                ? "Changing the stay…"
                : "Change the stay"
              : save.isPending
                ? needsApproval
                  ? "Sending…"
                  : "Saving…"
                : needsApproval
                  ? "Send for the FOM's approval"
                  : "Save the configuration"}
          </Button>
          <Help label="About saving the change">
            <p>The reason goes on the booking&rsquo;s record with your name.</p>
            {inPlace ? (
              <p>
                The booking comes back to this step with a new pass: the quotation priced from the table, the rooms blocked again and — from
                Reserve on — reserved again, the new voucher held for you to send. The money already received stays on the bill.
              </p>
            ) : (
              <p>
                Saving retires any quotation priced on the old configuration — price it again before moving to Set up. A provisional block moves
                to the new rooms and nights and keeps its deadline.
              </p>
            )}
            <p>A date change is kept on its own line in the booking&rsquo;s history: the old dates, the new ones, who moved them and why.</p>
            <p>When the guest is already holding a quotation, the change goes to the FOM, and nothing changes until they approve it.</p>
          </Help>
        </div>
        {needsApproval ? (
          <p className="warn-ink sm" style={{ marginTop: 8, fontWeight: 600 }}>
            This goes to the FOM — nothing changes on the booking until they approve it.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * A configuration change PREPARED at the desk, waiting for the FOM (2026-09-30). It sits with
 * the table it would change, because that is where both people look: the operator who raised it
 * and the FOM who decides. Approving APPLIES it — the whole governed act runs again as the
 * approver, so a room taken in the meantime is refused then, in words, rather than the approval
 * being a promise the booking cannot keep.
 */
export function WaitingConfigurationChange({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const elevated = atLeast(session?.actorLevel, "L2");

  const requests = entry.negotiationAmendmentRequests ?? [];
  const waiting = requests.find((r) => r.state === "REQUESTED") ?? null;
  const decide = useMutation({
    mutationFn: (decision: "APPROVE" | "REJECT") =>
      decideNegotiationAmendment(session!, entry.id, waiting!.id, { decision, note: note.trim() || undefined }),
    onSuccess: (r) => {
      if (r.state === "APPROVED") {
        toast.success(`Approved — ${r.outcome?.summary ?? "the configuration is changed"}`);
        if ((r.outcome?.quotationsInvalidated ?? []).length > 0) {
          toast.info("The quotation it was priced on is retired — price it again before Set up.");
        }
      } else {
        toast.success("Turned down — the desk sees your note");
      }
      setNote("");
      setRejecting(false);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The change could not be decided"),
  });
  const takeBack = useMutation({
    mutationFn: () => withdrawNegotiationAmendment(session!, entry.id, waiting!.id, { note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success("Taken back — nothing was changed");
      setNote("");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The change could not be taken back"),
  });

  if (!waiting) return null;
  return (
    <div className="cfg-wait" role="status">
      <div className="cfg-wait-h">
        <b>A configuration change is waiting</b>
        <span className="sm">raised {fmtDateTime(waiting.requestedAt)}</span>
        <Help label="About this waiting change">
          <p>The guest is holding a quotation, so the change is the FOM&rsquo;s call. Nothing on the booking has changed yet.</p>
          <p>Approving changes the booking at once and retires the quotation it was priced on.</p>
        </Help>
      </div>
      <div className="cfg-wait-b">
        <b className="cfg-wait-s">{waiting.summary}</b>
        <span className="sm">&ldquo;{waiting.reason}&rdquo;</span>
      </div>
      {elevated ? (
        <>
          <div className="row-acts">
            <Button kind="primary" compact onClick={() => decide.mutate("APPROVE")} state={decide.isPending ? "inert" : "default"}>
              Approve &amp; apply
            </Button>
            <Button kind="quiet" compact onClick={() => setRejecting((v) => !v)}>
              {rejecting ? "Keep it waiting" : "Turn it down"}
            </Button>
          </div>
          {rejecting && (
            <div className="field" style={{ marginTop: 8 }}>
              <label>Why it is turned down</label>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="the rate was agreed with the agent for these rooms" />
              <div className="row-acts" style={{ marginTop: 8 }}>
                <Button
                  kind="danger"
                  compact
                  onClick={() => decide.mutate("REJECT")}
                  state={!note.trim() || decide.isPending ? "inert" : "default"}
                  reason={!note.trim() ? "Say why — the desk sees the note" : undefined}
                >
                  Turn it down
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="row-acts">
          <Button kind="quiet" compact onClick={() => takeBack.mutate()} state={takeBack.isPending ? "inert" : "default"}>
            Take it back
          </Button>
          <span className="sm">Waiting for the FOM — nothing on the booking has changed</span>
        </div>
      )}
    </div>
  );
}

/** The last few decided ones, so the desk can see what happened to what it asked for. */
export function DecidedConfigurationChanges({ entry }: { entry: EntryDetail }) {
  const decided = (entry.negotiationAmendmentRequests ?? []).filter((r) => r.state !== "REQUESTED").slice(0, 3);
  if (decided.length === 0) return null;
  return (
    <div style={{ marginTop: 10, display: "grid", gap: 3 }}>
      {decided.map((r) => (
        <span key={r.id} className="sm">
          {r.state === "APPROVED" ? "Approved" : r.state === "REJECTED" ? "Turned down" : r.state === "WITHDRAWN" ? "Taken back" : "Overtaken"} ·{" "}
          {r.summary}
          {r.decisionNote ? ` — “${r.decisionNote}”` : ""}
          {r.decidedAt ? ` · ${fmtDateTime(r.decidedAt)}` : ""}
        </span>
      ))}
    </div>
  );
}
