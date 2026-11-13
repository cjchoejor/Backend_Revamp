"use client";

/**
 * Step 1 · Inquiry — "understand the stay" (SS03 §S1, prototype `V16.intakeCanvas`).
 *
 * Five sections, one after another, in the order of the boss's journey mockup (2026-10-10):
 * 1 the guest · 2 who is asking · 3 the stay · 4 the house (rooms and rate) · 5 wrap up. The
 * first three were settled when the lead was kept, so they fold to one line each with an Edit;
 * the house is the work — free rooms by type, Take it, the room table for a room per night, and
 * the bill for the rooms picked, night by night and for the stay. Wrap up opens once the rooms
 * are chosen and asks what the guest did not give at the start: their phone or email, who is
 * arriving, and any notes.
 */
import { StayDates } from "@/components/ds/stay-dates";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import {
  queryAvailabilityByEntry,
  roomsFromResultSet,
  selectAvailabilityOption,
  type AvailabilityQueryResponse,
  type PerDateAvailabilityResult,
} from "@/lib/api/availability";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import { useRoomsFollowParty } from "@/hooks/use-rooms-follow-party";
import { updateEntryIntake } from "@/lib/api/entries";
import {
  getInquiry,
  listRatePackagesLookup,
  updateEntrySource,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";
import { checkBedRequest, listRooms, releaseRoomBlock } from "@/lib/api/rooms";
import { releaseCommittedHold } from "@/lib/api/reservation-setup";
import { releaseSpeculativeHold } from "@/lib/api/quotations";
import {
  RoomStatusTable,
  roomStatusRows,
  type NightGroup,
  type RoomStatusRow,
  type SelectAllOutcome,
} from "@/components/desk/workspace/room-status-table";
import { fmtDay, money, plural } from "@/lib/ds/format";
import { currentPassConfigs, pickFitsStay } from "@/lib/desk/workspace";
import {
  optionSelectedRoomIds,
  type AvailabilityOptionSelected,
  type EntryDetail,
} from "@/types/api";
import {
  Choice,
  Live,
  ReasonDialog,
  StepCanvas,
  StepCard,
  Tool,
  atLeast,
  toastRefusal,
  useRefreshEntry,
  useStepFlow,
  words,
  OtherWaysTabs,
  parkTab,
  declineTab,
  useOpenOtherWay,
  useOpenFileTab,
  useFlowUnsaved,
  WorkPopup,
  Overlay,
  anchorFor,
  revealCard,
} from "./kit";
import { TypePackagesLine } from "@/components/ds/type-package-pick";
import { AddReturnStay, TripStays } from "@/components/ds/workspace/return-stay";
import { enumerateNights, useRoomSelection } from "./use-room-selection";
import { STAY_SAVED_EVENT, useTripAtInquiry, type StaySaved } from "./s1-trip-shared";
import { TripCancelWay } from "./s3-trip-cancel";
import { RoomCountField } from "./new-inquiry-parts";
import { TheCaller, WrapUp } from "./s1-caller";
import { TripPickLine, cleanPicks, usePickPricing, useTripPickPricing, type BillNight } from "./s1-bill";
import { RoomsByType, TripHouse, savedBookingRooms, type TypeDraft } from "./s1-by-type";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { savedPickNights, usePublishPriceDraft } from "@/lib/ds/stay-price";
import { Help, HelpHere } from "@/components/ds/help";
import type { PickPricing } from "@/lib/api/availability";
import { DateInput } from "@/components/ds/date-input";

/* ------------------------------------------------------------------ vocabulary */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const BED_WORD: Record<string, string> = {
  KING: "King",
  TWIN: "Twin",
  QUEEN: "Queen",
  SINGLE: "Single",
};


type IndicativePricing = {
  rateAmount?: number;
  currency?: string;
  stayNights?: number;
  lineTotalIndicative?: number;
};
function readPricing(p: unknown): IndicativePricing | null {
  if (!p || typeof p !== "object") return null;
  const o = p as IndicativePricing;
  return typeof o.rateAmount === "number" ||
    typeof o.lineTotalIndicative === "number"
    ? o
    : null;
}

type InquiryRecord = {
  duplicateFlags?: unknown[];
};

/* ------------------------------------------------------------------ the step */

export function S1Inquiry({
  entry,
  past,
  parkNow,
  parking,
  declineNow,
  declining,
}: {
  entry: EntryDetail;
  past: boolean;
  /** Park with the reason typed in Other ways' own tab (2026-10-17). */
  parkNow?: (reason: string) => void;
  parking?: boolean;
  /** The guest said no (2026-10-01) — offered while the booking can still be turned down. */
  declineNow?: (reason: string) => void;
  declining?: boolean;
}) {
  // A trip's stays at Inquiry are worked on one page (2026-11-07); Cancel inquiry asks which (2026-11-09).
  const tripAtInquiry = useTripAtInquiry(past ? null : entry);
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const editable =
    !past && entry.currentStage === "S1" && entry.status === "ACTIVE";

  const inquiryQuery = useQuery({
    queryKey: ["inquiry", entry.inquiryId],
    queryFn: () => getInquiry(session!, entry.inquiryId),
    enabled: !!session && !!entry.inquiryId,
  });
  const inquiryRec = (inquiryQuery.data ?? null) as InquiryRecord | null;

  const rooms = useQuery({
    queryKey: ["rooms"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });

  return (
    <StepCanvas past={past}>
      {/* One column, in the order the call goes (2026-10-10): who rang or who booked, what they want,
          what the house has and what it costs, then what is left. */}
      <div className="stack">
        <TheCaller entry={entry} editable={editable} />
        <TheStay
          entry={entry}
          editable={editable}
          catalog={rooms.data?.items ?? []}
        />
        <TheHouse
          entry={entry}
          past={past}
          editable={editable}
          duplicates={(inquiryRec?.duplicateFlags ?? []).length}
          catalog={rooms.data?.items ?? []}
        />
        <WrapUp
          entry={entry}
          editable={editable}
          onSaved={() => refresh([["inquiry", entry.inquiryId]])}
        />
      </div>
      {/* Other ways as sub-tabs (2026-10-17), each panel the form its button used to open. "The
          guest said no" is the answer the house had no way to write down (2026-10-01): until it,
          a lead that said no could only be parked or left to lapse as "Expired". */}
      {/* On the step line's right, beside each other (2026-10-28, operator: "the guest said no, which
          is cancel") — the same form as Negotiation's Cancel booking, named for what it is here: "in
          inquiry it isn't a booking yet, so name it cancel inquiry, just for here". */}
      <OtherWaysTabs
        tabs={[
          parkTab(parkNow, parking),
          tripAtInquiry.combined
            ? { key: "decline", label: "Cancel inquiry", content: <TripCancelWay entry={entry} stays={[entry, ...tripAtInquiry.others]} stayNoOf={tripAtInquiry.stayNoOf} word="inquiry" /> }
            : declineTab(declineNow, declining, { label: "Cancel inquiry", act: "Cancel the inquiry" }),
        ]}
      />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ the stay */

type Catalog = Awaited<ReturnType<typeof listRooms>>["items"];

/**
 * The stay's fields and their state, for any stay — this booking's and, on a trip at Inquiry, each
 * other stay's own row (2026-11-07, operator: a row per stay in The stay).
 */
function useStayForm(entry: EntryDetail, catalog: Catalog) {
  const { session } = useSession();
  const policy = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 600_000,
  });

  const seed = () => ({
    checkIn: entry.checkInDate?.slice(0, 10) ?? "",
    nights: String(
      Math.max(
        1,
        enumerateNights(entry.checkInDate, entry.checkOutDate).length || 1,
      ),
    ),
    rooms: String(entry.numberOfRooms ?? 1),
    adults: String(entry.adultCount ?? entry.guestCount ?? 1),
    children: String(entry.childCount ?? 0),
    ages: (entry.childAges ?? []).map(String),
    beds: Object.fromEntries(
      Object.entries(
        (entry.bedTypeRequest as Record<string, number> | null) ?? {},
      ).map(([k, v]) => [k, String(v)]),
    ) as Record<string, string>,
  });
  const [f, setF] = useState(seed);
  const stamp = `${entry.version}`;
  useEffect(() => setF(seed()), [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<ReturnType<typeof seed>>) =>
    setF((p) => ({ ...p, ...patch }));

  const nightsN = Math.max(1, parseInt(f.nights || "1", 10) || 1);
  const checkOut = useMemo(() => {
    if (!f.checkIn) return "";
    const d = new Date(`${f.checkIn}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + nightsN);
    return d.toISOString().slice(0, 10);
  }, [f.checkIn, nightsN]);
  const childN = Math.max(
    0,
    Math.min(12, parseInt(f.children || "0", 10) || 0),
  );
  const ages = Array.from({ length: childN }, (_, i) => f.ages[i] ?? "");
  const agesOk = ages.every((a) => a.trim() !== "" && Number(a) >= 0);
  const adultsN = Math.max(1, parseInt(f.adults || "1", 10) || 1);
  const agesNum = ages
    .map((a) => parseInt(a, 10))
    .filter((n) => Number.isFinite(n));

  const envelope = useQuery({
    queryKey: ["lookup", "allowed-room-counts", adultsN, agesNum.join(",")],
    queryFn: () =>
      getAllowedRoomCounts(session!, { adults: adultsN, childAges: agesNum }),
    enabled: !!session,
  });
  const env = envelope.data ?? null;
  const roomsN = Math.max(1, parseInt(f.rooms || "1", 10) || 1);

  const bedTypes = useMemo(() => {
    const s = new Set<string>();
    for (const r of catalog)
      for (const t of r.allowedBedTypes?.length
        ? r.allowedBedTypes
        : r.bedType
          ? [r.bedType]
          : [])
        s.add(t);
    return ["KING", "TWIN", "QUEEN", "SINGLE"].filter((t) => s.has(t));
  }, [catalog]);
  const bedMap = Object.fromEntries(
    Object.entries(f.beds)
      .map(([k, v]) => [k, parseInt(v || "0", 10) || 0])
      .filter(([, v]) => (v as number) > 0),
  );

  const saved = seed();
  const savedBedMap = Object.fromEntries(
    Object.entries(saved.beds)
      .map(([k, v]) => [k, parseInt(v, 10) || 0])
      .filter(([, v]) => (v as number) > 0),
  ) as Record<string, number>;
  const partyEdited = f.adults !== saved.adults || String(childN) !== saved.children || ages.join(",") !== saved.ages.join(",");
  useRoomsFollowParty({
    env,
    partyEdited,
    rooms: roomsN,
    savedRooms: Number(saved.rooms),
    bedAsk: Object.values(bedMap).reduce<number>((a, b) => a + (b as number), 0),
    apply: (n) => set({ rooms: String(n) }),
  });
  const dirty =
    f.checkIn !== saved.checkIn ||
    f.nights !== saved.nights ||
    f.rooms !== saved.rooms ||
    f.adults !== saved.adults ||
    String(childN) !== saved.children ||
    ages.join(",") !== saved.ages.join(",") ||
    JSON.stringify(bedMap) !== JSON.stringify(savedBedMap);

  const writeStay = () =>
    updateEntryIntake(session!, entry.id, {
      checkInDate: f.checkIn || undefined,
      checkOutDate: checkOut || undefined,
      adultCount: adultsN,
      childCount: childN,
      childAges: childN > 0 ? agesNum : [],
      guestCount: adultsN + childN,
      numberOfRooms: roomsN,
      bedTypeRequest: Object.keys(bedMap).length
        ? (bedMap as Record<string, number>)
        : null,
      expectedVersion: entry.version,
    });
  const invalid = !f.checkIn ? "put in the check-in date" : childN > 0 && !agesOk ? "put in every child's age" : null;
  /** The house is asked again by itself for the figures just saved — the entry on screen is still the old one. */
  const announceSaved = () => {
    if (f.checkIn && checkOut)
      window.dispatchEvent(
        new CustomEvent(STAY_SAVED_EVENT, {
          detail: { entryId: entry.id, checkInDate: f.checkIn, checkOutDate: checkOut, guestCount: adultsN + childN },
        }),
      );
  };
  return {
    f,
    set,
    reset: () => setF(seed()),
    checkOut,
    childN,
    ages,
    agesNum,
    adultsN,
    env,
    roomsN,
    bedTypes,
    saved,
    savedBedMap,
    dirty,
    writeStay,
    announceSaved,
    invalid,
    cp: policy.data ?? null,
  };
}
type StayForm = ReturnType<typeof useStayForm>;

/** The stay's fields: Check-in | Nights | Check-out, Adults | Children | Rooms, ages, beds asked. */
function StayFields({ form, ro }: { form: StayForm; ro: boolean }) {
  const { f, set, checkOut, childN, ages, agesNum, env, roomsN, bedTypes, cp } = form;
  const young = cp?.ageBands.youngChildMaxAge ?? 5;
  const childMax = cp?.ageBands.childMaxAge ?? 10;
  const minAdult = cp?.unaccompaniedMinor.minimumAge ?? 18;
  return (
    <div className="form3">
      <div className="field">
        <label>Check-in</label>
        <DateInput
          className="input"
          value={f.checkIn}
          readOnly={ro}
          onChange={(e) => set({ checkIn: e.target.value })}
        />
      </div>
      {/* The nights sit between the two dates, as on the boss's mockup (2026-10-10): the
          check-out follows the check-in and the nights, and a picked check-out sets the nights. */}
      <div className="field">
        <label>Nights</label>
        <input
          className="input"
          inputMode="numeric"
          value={f.nights}
          readOnly={ro}
          onChange={(e) => set({ nights: e.target.value.replace(/\D/g, "") })}
        />
      </div>
      <div className="field">
        <label>Check-out</label>
        <DateInput
          className="input"
          value={checkOut}
          min={f.checkIn || undefined}
          readOnly={ro}
          onChange={(e) => {
            const n = enumerateNights(f.checkIn, e.target.value).length;
            if (n >= 1) set({ nights: String(n) });
          }}
        />
      </div>
      <div className="field">
        <label>Adults</label>
        <input
          className="input"
          inputMode="numeric"
          value={f.adults}
          readOnly={ro}
          onChange={(e) => set({ adults: e.target.value.replace(/\D/g, "") })}
        />
      </div>
      <div className="field">
        <label>Children</label>
        <input
          className="input"
          inputMode="numeric"
          value={f.children}
          readOnly={ro}
          onChange={(e) =>
            set({ children: e.target.value.replace(/\D/g, "") })
          }
        />
      </div>
      <RoomCountField
        env={env}
        rooms={roomsN}
        disabled={ro}
        adultFrom={childMax + 1}
        onChange={(n) => set({ rooms: String(n) })}
      >
        {env && (env.exceedsHotelCapacity || roomsN < env.allowedRoomCounts.min) ? (
          <span className="hint warn-ink">
            {env.exceedsHotelCapacity
              ? `${plural(env.chargeableOccupants, "chargeable guest")} — more than the hotel can sleep`
              : `at least ${plural(env.allowedRoomCounts.min, "room")} for ${plural(env.chargeableOccupants, "chargeable guest")}`}
          </span>
        ) : null}
      </RoomCountField>
      {childN > 0 ? (
        <div className="wide field">
          <label>
            Their age{childN === 1 ? "" : "s"}
            <Help label="About children's ages">
              The age decides the bed and the rate: under {young + 1} free, {young + 1}–{childMax} at the child rate,{" "}
              {childMax + 1}–{minAdult - 1} charged as adults.
            </Help>
          </label>
          <div className="row-acts">
            {ages.map((a, i) => (
              <input
                key={i}
                className="input narrow"
                inputMode="numeric"
                placeholder={`#${i + 1}`}
                value={a}
                readOnly={ro}
                onChange={(e) => {
                  const next = [...ages];
                  next[i] = e.target.value.replace(/\D/g, "");
                  set({ ages: next });
                }}
              />
            ))}
          </div>
          {agesNum.some((n) => n > childMax) ? (
            <span className="hint warn-ink">
              {ages
                .map((x, i) => (Number(x) > childMax ? `Child ${i + 1}` : null))
                .filter(Boolean)
                .join(", ")}{" "}
              at the adult rate
            </span>
          ) : null}
        </div>
      ) : null}
      {bedTypes.length ? (
        <div className="wide field">
          <label>
            Beds asked for · optional
            <Help label="About the beds asked for">
              A tally — which room is which is settled on the table at Negotiation. Here the house secures enough rooms that can take them.
            </Help>
          </label>
          <div className="row-acts">
            {bedTypes.map((t) => (
              <span key={t} className="chip count-in">
                {BED_WORD[t] ?? words(t)}
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="0"
                  value={f.beds[t] ?? ""}
                  readOnly={ro}
                  onChange={(e) =>
                    set({
                      beds: {
                        ...f.beds,
                        [t]: e.target.value.replace(/\D/g, ""),
                      },
                    })
                  }
                />
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Another stay of the trip at Inquiry, as its own row in The stay (2026-11-07, operator: "a row per
 * stay in The stay"): the same fields, saved on that stay with its own Save; the house is asked again
 * for it, so its columns in The house follow.
 */
function OtherStayRow({
  entry,
  stayNo,
  editable,
  catalog,
  onForm,
}: {
  entry: EntryDetail;
  stayNo: number;
  editable: boolean;
  catalog: Catalog;
  /** Its form, handed to The stay, whose one Done saves every stay changed (2026-11-13). */
  onForm: (entryId: string, form: StayForm | null) => void;
}) {
  const form = useStayForm(entry, catalog);
  useEffect(() => {
    onForm(entry.id, form);
  });
  useEffect(() => () => onForm(entry.id, null), [entry.id, onForm]);
  return (
    <div className="trip-stay-row" data-stay={entry.id}>
      <div className="trip-stay-head">
        <b>Stay {stayNo}</b>
        <span className="meta">{entry.id}</span>
        {editable && form.dirty ? <span className="warn-ink trip-stay-changed">changed</span> : null}
      </div>
      <StayFields form={form} ro={!editable} />
    </div>
  );
}

function TheStay({
  entry,
  editable,
  catalog,
}: {
  entry: EntryDetail;
  editable: boolean;
  catalog: Catalog;
}) {
  const refresh = useRefreshEntry(entry.id);
  const qc = useQueryClient();
  const form = useStayForm(entry, catalog);
  const { checkOut, saved, savedBedMap, dirty, writeStay, invalid } = form;
  // A trip at Inquiry: each other stay as its own row here (2026-11-07, operator ruling).
  const trip = useTripAtInquiry(entry);
  /**
   * One Done for every stay (2026-11-13, operator: "there is a button showing save stay 2, for both
   * stay 1 and 2, it should be done with the done button"): each other stay's row hands its form up,
   * and Done saves every stay changed, then asks the house again for each.
   */
  const otherForms = useRef<Record<string, StayForm>>({});
  const [otherDirty, setOtherDirty] = useState<Record<string, boolean>>({});
  const onOtherForm = useCallback((id: string, f: StayForm | null) => {
    if (f) otherForms.current[id] = f;
    else delete otherForms.current[id];
    const d = !!f?.dirty;
    setOtherDirty((p) => (p[id] === d ? p : { ...p, [id]: d }));
  }, []);
  const anyOtherDirty = Object.values(otherDirty).some(Boolean);
  useFlowUnsaved("stay", editable && (dirty || anyOtherDirty), dirty ? "Changes to the stay saved" : "Changes to the other stay saved");
  const otherInvalid = Object.entries(otherForms.current).find(([id, f]) => otherDirty[id] && f.invalid);

  // The house is asked again by itself (2026-10-27, operator: "when I make edits to the stay
  // and click Done, can it ask the house directly, so we can remove the Ask again button").
  // The saved figures ride on the event, since the entry on screen is still the old one.
  const stayWasSaved = () => {
    refresh();
    form.announceSaved();
  };
  // A return stay can be added as soon as the stay's fields are in (2026-11-03, operator: "after
  // the user fills in check in, nights, check out, adults, children and room, the add a return stay
  // can be enabled"). What is typed is saved first; the page stays where it is.
  const saveForReturn = useMutation({
    mutationFn: writeStay,
    onSuccess: stayWasSaved,
    onError: (e) => toastRefusal(e, "The stay could not be saved"),
  });
  const save = useMutation({
    mutationFn: async () => {
      const saved: string[] = [];
      if (dirty) {
        await writeStay();
        saved.push("this");
      }
      for (const [id, f] of Object.entries(otherForms.current)) {
        if (!f.dirty) continue;
        try {
          await f.writeStay();
        } catch (e) {
          throw new Error(`Stay ${trip.stayNoOf(id)}: ${e instanceof Error ? e.message : String(e)}`);
        }
        saved.push(id);
      }
      return saved;
    },
    onSuccess: (saved) => {
      toast.success(
        saved.length > 1
          ? `${plural(saved.length, "stay")} updated — the house is asked again for their dates`
          : "The stay is updated — the house is asked again for these dates",
      );
      for (const id of saved) {
        if (id === "this") continue;
        otherForms.current[id]?.announceSaved();
        void qc.invalidateQueries({ queryKey: ["entry", id] });
      }
      if (saved.includes("this")) stayWasSaved();
      else refresh();
      // Done saved it; the work moves on to the house, which is being asked again for the stay as
      // it is now (2026-10-27, operator: "it took me to Wrap up, when it should ask the house again
      // and take me to the house section").
      flowDone("stay", { next: "house" });
    },
    onError: (e) => toastRefusal(e, "The stay could not be updated"),
  });

  const { done: flowDone } = useStepFlow();
  const ro = !editable;
  const group = entry.groupBillingMode === "GROUP_MASTER";

  return (
    <StepCard
      flow="stay"
      flowAfter="caller"
      title="The stay"
      keepRight
      right={
        <Live>
          <AddReturnStay
            entry={entry}
            kind="secondary"
            shutReason={invalid}
            fromAfter={checkOut || null}
            prepare={
              dirty && editable
                ? () =>
                    saveForReturn
                      .mutateAsync()
                      .then(() => true)
                      .catch(() => false)
                : undefined
            }
          />
        </Live>
      }
      // One Done (2026-10-27, operator: "remove Save the stay and merge it with Done, and bring
      // Undo beside Done"): with a change on the stay, Done saves it and moves on; Undo puts the
      // fields back. Without a change, the card's own Done simply folds it.
      // Shut while nothing changed (2026-11-13, operator: "if there are no changes done button should be
      // disabled"); Hide closes the section then.
      doneAction={
        !editable
          ? undefined
          : dirty || anyOtherDirty
            ? {
                label: "Done",
                state: save.isPending
                  ? "working"
                  : (dirty && invalid) || otherInvalid
                    ? "inert"
                    : "default",
                title: dirty && invalid ? invalid : otherInvalid ? `stay ${trip.stayNoOf(otherInvalid[0])}: ${otherInvalid[1].invalid}` : undefined,
                workingLabel: "Saving…",
                note: <span className="warn-ink">Changed — Done saves {trip.others.length && anyOtherDirty && dirty ? "every stay changed" : anyOtherDirty && !dirty ? `stay ${trip.others.filter((o) => otherDirty[o.id]).map((o) => trip.stayNoOf(o.id)).join(" and ")}` : "it"}</span>,
                extra: (
                  <Button
                    kind="quiet"
                    state={save.isPending ? "inert" : "default"}
                    onClick={() => {
                      form.reset();
                      for (const f of Object.values(otherForms.current)) f.reset();
                    }}
                  >
                    Undo
                  </Button>
                ),
                onClick: () => save.mutate(),
              }
            : { label: "Done", state: "inert", idle: true, title: "Nothing has changed", onClick: () => {} }
      }
      summary={
        <>
          {trip.combined ? <b>Stay {trip.stayNoOf(entry.id)} </b> : null}
          {entry.checkInDate ? <StayDates checkIn={entry.checkInDate} checkOut={entry.checkOutDate} /> : <b>no dates</b>}
          {saved.checkIn ? <> · {plural(parseInt(saved.nights, 10) || 1, "night")}</> : null} ·{" "}
          {plural(parseInt(saved.adults, 10) || 0, "adult")}
          {(parseInt(saved.children, 10) || 0) > 0
            ? <>, {plural(parseInt(saved.children, 10) || 0, "child", "children")}{saved.ages.length ? ` (${saved.ages.join(", ")})` : ""}</>
            : null}{" "}
          · {plural(parseInt(saved.rooms, 10) || 1, "room")}
          {Object.keys(savedBedMap).length
            ? <> · {Object.entries(savedBedMap).map(([t, n]) => `${n} ${BED_WORD[t] ?? words(t)}`).join(" + ")} asked</>
            : null}
          {/* A trip at Inquiry: every stay on the folded line, so the others are seen without opening it. */}
          {trip.others.map((o) => (
            <span key={o.id} className="trip-fold-stay">
              <b>Stay {trip.stayNoOf(o.id)} </b>
              {o.checkInDate ? <StayDates checkIn={o.checkInDate} checkOut={o.checkOutDate} /> : <b>no dates</b>} · {plural(o.adultCount ?? 0, "adult")}
              {(o.childCount ?? 0) > 0 ? <>, {plural(o.childCount ?? 0, "child", "children")}</> : null} · {plural(o.numberOfRooms ?? 1, "room")}
            </span>
          ))}
        </>
      }
    >
      {trip.combined ? (
        <div className="trip-stay-head">
          <b>Stay {trip.stayNoOf(entry.id)}</b>
          <span className="meta">{entry.id}</span>
        </div>
      ) : null}
      <StayFields form={form} ro={ro} />
      {trip.others.map((o) => (
        <OtherStayRow
          key={o.id}
          entry={o}
          stayNo={trip.stayNoOf(o.id)}
          editable={editable}
          catalog={catalog}
          onForm={onOtherForm}
        />
      ))}
      {(entry.inquiry?.entries ?? []).length > 1 ? (
        <div className="rule-above">
          <span className="meta">
            The guest comes back — {(entry.inquiry?.entries ?? []).length} stays on enquiry{" "}
            {entry.inquiry?.id ?? "—"}, each with its own rooms and its own bill.
          </span>
          <div style={{ marginTop: 8 }}>
            <TripStays entry={entry} />
          </div>
        </div>
      ) : null}
      <div className="row-acts" style={{ marginTop: 10 }}>
        <Chip
          tone={group ? "accent" : "default"}
          icon={group ? "check" : undefined}
        >
          Travelling as a party{group ? "" : " · no"}
        </Chip>
        <Live>
          <Button
            kind="quiet"
            compact
            state="inert"
            title="Not possible yet — a booking has one bill. At check-out it can be paid room by room."
          >
            One bill each
          </Button>
        </Live>
      </div>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the house */

type TypeRow = {
  name: string;
  full: string[];
  partial: number;
  deficient: number;
};

type ReleaseTarget =
  | {
      kind: "HOLD";
      entryId: string;
      holdKind: "COMMITTED" | "SPECULATIVE";
      holdId?: string;
      roomId: string;
      roomLabel: string;
      holder: string;
      siblings: string[];
    }
  | {
      kind: "BLOCK";
      roomId: string;
      roomLabel: string;
      blockedReason: string | null;
    };

function TheHouse({
  entry,
  past,
  editable,
  duplicates,
  catalog,
}: {
  entry: EntryDetail;
  past: boolean;
  editable: boolean;
  duplicates: number;
  catalog: Catalog;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const flow = useStepFlow();
  const openWay = useOpenOtherWay();
  const isGm = atLeast(session?.actorLevel, "L3");
  // A trip at Inquiry: every stay's rooms in this one house (2026-11-07, operator ruling).
  const trip = useTripAtInquiry(entry);

  // This pass's searches only — a new pass searches its dates again (2026-09-18).
  const configs = currentPassConfigs(entry);
  const latest = configs[0] ?? null;
  const preferred = configs.find((c) => c.optionSelected != null) ?? null;
  const [result, setResult] = useState<AvailabilityQueryResponse | null>(null);
  const configId = result?.configurationId ?? latest?.id ?? null;
  const stale = result ? result.isStale : !!latest?.isStale;

  const searched = (() => {
    const sc = (latest?.searchCriteria ?? null) as {
      checkInDate?: unknown;
      checkOutDate?: unknown;
    } | null;
    const iso = (v: unknown) =>
      typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : undefined;
    return { checkIn: iso(sc?.checkInDate), checkOut: iso(sc?.checkOutDate) };
  })();

  const { available, deficient, unavailable, pricing, perDate } =
    useMemo(() => {
      const src =
        result?.results ?? latest?.resultSet ?? preferred?.resultSet ?? null;
      const rooms = src
        ? roomsFromResultSet(src)
        : { availableRooms: [], deficientRooms: [], unavailableRooms: [] };
      const pd = (src as { perDate?: unknown } | null)?.perDate;
      const ind = (src as { indicativePricing?: unknown } | null)
        ?.indicativePricing;
      return {
        available: rooms.availableRooms,
        deficient: rooms.deficientRooms,
        unavailable: rooms.unavailableRooms,
        pricing:
          readPricing(ind) ??
          readPricing(rooms.availableRooms[0]?.pricingIndicative),
        perDate: Array.isArray(pd)
          ? (pd as PerDateAvailabilityResult[])
          : undefined,
      };
    }, [result, latest, preferred]);
  const hasResults =
    available.length + deficient.length + unavailable.length > 0;

  const extBeds = useMemo(
    () =>
      new Map(
        catalog
          .filter((r) => typeof r.roomType?.maxExtraBeds === "number")
          .map((r) => [r.id, r.roomType!.maxExtraBeds!]),
      ),
    [catalog],
  );
  const bedOf = useMemo(
    () =>
      new Map(catalog.filter((r) => r.bedType).map((r) => [r.id, r.bedType!])),
    [catalog],
  );
  const rows = useMemo(
    () => roomStatusRows(available, deficient, unavailable, extBeds, bedOf),
    [available, deficient, unavailable, extBeds, bedOf],
  );

  const stayNights = useMemo(
    () =>
      enumerateNights(
        entry.checkInDate ?? searched.checkIn,
        entry.checkOutDate ?? searched.checkOut,
      ),
    [
      entry.checkInDate,
      entry.checkOutDate,
      searched.checkIn,
      searched.checkOut,
    ],
  );
  const displayNights = useMemo(
    () => (perDate?.length ? perDate.map((p) => p.date) : stayNights),
    [perDate, stayNights],
  );
  const numberOfRooms = entry.numberOfRooms ?? 1;
  const savedOption = preferred?.optionSelected as
    AvailabilityOptionSelected | null | undefined;
  // The rooms saved may no longer fit the stay — its dates or room count changed after they were
  // chosen. The move to Negotiation refuses it on the same rule (2026-10-27).
  const pickMisfit = savedOption ? pickFitsStay(savedOption, entry, preferred?.searchCriteria) : null;
  const sel = useRoomSelection({
    entryId: entry.id,
    numberOfRooms,
    savedOption,
    displayNights,
    stayNights,
  });

  // Rooms by type (2026-10-28, docs/room-types-until-arrival.md): the desk says how many of each
  // type each night and the system chooses the rooms. Particular rooms by number stay one press
  // away, and a pick already saved by number opens as it was.
  const savedByType = !!savedBookingRooms(entry);
  const savedByNumber = !!savedOption && !savedByType;
  const [mode, setMode] = useState<"TYPE" | "NUMBER">(savedByNumber ? "NUMBER" : "TYPE");
  const byTypeMode = mode === "TYPE";
  const [typePicks, setTypePicks] = useState<{ perNight: BillNight[]; labels: Map<string, string>; saved: boolean } | null>(null);
  const bookingRoomsView = useBookingRooms(entry);

  /* free rooms by type, over every night of the answer */
  const byType = useMemo<TypeRow[]>(() => {
    const freeOn = (roomId: string, night: string) =>
      perDate
        ?.find((p) => p.date === night)
        ?.availableRoomIds.includes(roomId) ?? false;
    const m = new Map<string, TypeRow>();
    for (const r of rows) {
      const t = m.get(r.roomTypeName) ?? {
        name: r.roomTypeName,
        full: [],
        partial: 0,
        deficient: 0,
      };
      if (r.bucket === "available") t.full.push(r.roomId);
      else if (r.bucket === "deficient") t.deficient += 1;
      else if (
        perDate?.length &&
        !r.blockedReason &&
        displayNights.some((n) => freeOn(r.roomId, n))
      )
        t.partial += 1;
      m.set(r.roomTypeName, t);
    }
    return [...m.values()].sort(
      (a, b) => b.full.length - a.full.length || a.name.localeCompare(b.name),
    );
  }, [rows, perDate, displayNights]);

  // Each type's free rooms night by night (2026-10-27, operator: "how does it handle a room free on
  // the first night, not on the second, and free on the third?"). The Free column counts only the
  // rooms free on EVERY night; these columns show each night on its own, from the house's own
  // answer, so a night a type runs short on is plain to see. Up to two weeks of nights.
  const typeOfRoom = useMemo(() => new Map(rows.map((r) => [r.roomId, r.roomTypeName])), [rows]);
  const nightCols = perDate?.length && displayNights.length > 1 && displayNights.length <= 14 ? displayNights : [];
  const freeByTypeNight = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const p of perDate ?? []) {
      const night = String(p.date).slice(0, 10);
      for (const id of p.availableRoomIds) {
        const t = typeOfRoom.get(id);
        if (!t) continue;
        const tm = m.get(t) ?? new Map<string, number>();
        tm.set(night, (tm.get(night) ?? 0) + 1);
        m.set(t, tm);
      }
    }
    return m;
  }, [perDate, typeOfRoom]);

  // Too few rooms for the ask (2026-10-27, operator: "the guest asked for 3 rooms and the house has
  // only 2 — show it on top, in red"). Counted night by night off the house's own answer: the
  // tightest night decides. With enough rooms every night but no one type holding them all, the
  // rooms have to be mixed across types — said in amber, since it can still be done.
  const houseShort = useMemo(() => {
    if (!hasResults) return null;
    const nights = stayNights.length ? stayNights : displayNights;
    let free = byType.reduce((s, t) => s + t.full.length + t.deficient, 0);
    let night: string | null = null;
    if (perDate?.length && nights.length) {
      free = Infinity;
      for (const n of nights) {
        const count = perDate.find((p) => p.date === n)?.availableRoomIds.length ?? 0;
        if (count < free) {
          free = count;
          night = n;
        }
      }
    }
    if (free < numberOfRooms) return { kind: "SHORT" as const, free, night };
    if (!byType.some((t) => t.full.length >= numberOfRooms)) return { kind: "MIX" as const, free, night: null };
    return null;
  }, [hasResults, stayNights, displayNights, perDate, byType, numberOfRooms]);

  const savedIds = optionSelectedRoomIds(savedOption);
  const savedTypes = [
    ...new Set(
      savedIds
        .map((id) => rows.find((r) => r.roomId === id)?.roomTypeName)
        .filter(Boolean),
    ),
  ];
  const [pickedType, setPickedType] = useState<string | null>(null);
  // Nothing is marked until the desk marks it (2026-10-23, operator: a type chosen by itself, and
  // rooms already ticked, confused the user). Rooms already saved on the booking still mark their type.
  const chosenType = pickedType ?? (savedTypes.length === 1 ? savedTypes[0]! : null);
  const chosenRow = byType.find((t) => t.name === chosenType) ?? null;
  // The MARKED type's own indicative figure (2026-09-19): every room carries its type's chip, while
  // the search-wide one is a single plan's rate — it read the same for a Suite and a Standard Single.
  const chosenPricing = useMemo(() => {
    if (!chosenType) return null;
    const room = [...available, ...deficient].find((r) => r.roomTypeName === chosenType);
    return readPricing(room?.pricingIndicative) ?? pricing;
  }, [chosenType, available, deficient, pricing]);

  // A room suggested by the house chart (2026-10-12): "Start an inquiry" on a free night opens the
  // new booking with `?room=305`. The house is asked once on arrival and the card says whether the
  // room is free on every night — it is not picked for the desk (2026-10-23). The address loses
  // `room=` once it is read, so a reload does not do it again.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const chartRoom = searchParams.get("room")?.trim() || null;
  const [chartPick, setChartPick] = useState<string | null>(null);
  const [chartNote, setChartNote] = useState<{ ok: boolean; text: string } | null>(null);
  const chartAsked = useRef(false);
  const chartRead = useRef(false);

  const ask = useMutation({
    // `over` carries the stay just saved — the entry on screen is re-read a moment later.
    mutationFn: async (over: StaySaved | void) => {
      const ci = over ? over.checkInDate : entry.checkInDate?.slice(0, 10);
      const co = over ? over.checkOutDate : entry.checkOutDate?.slice(0, 10);
      if (!ci || !co)
        throw new Error("Put in the check-in and check-out first");
      return queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: ci,
        checkOutDate: co,
        guestCount: (over ? over.guestCount : entry.guestCount) ?? undefined,
        useType: entry.useType ?? undefined,
      });
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success("The house has answered for these dates");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The house could not be asked"),
  });

  const seal = useMutation({
    mutationFn: (body: PickBody) => {
      if (!configId) throw new Error("Ask the house first");
      return sealRoomsByNumber(session!, configId, rows, body);
    },
    onSuccess: async () => {
      toast.success("The rooms are chosen and on record");
      setToolOpen(false);
      refresh();
      await goToWrap();
    },
    onError: (e) => toastRefusal(e, "The rooms could not be recorded"),
  });
  // Saving the rooms (the table's Save, or Take it) goes straight to Wrap up (2026-10-28, operator:
  // "when I click Save the room in the choose room table, can it directly take me to the wrap
  // section"). The bill lives in the booking file now, so nothing here has to stay in view. Wrap up
  // waits for the rooms until the booking is read again, so the page moves once it has opened.
  const qc = useQueryClient();
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const goToWrap = async () => {
    await qc.invalidateQueries({ queryKey: ["entry", entry.id] });
    const opened = () => !!document.querySelector('[data-flow="wrap"]:not(.flow-waiting)');
    const end = Date.now() + 3000;
    while (!opened() && Date.now() < end) await new Promise((r) => window.setTimeout(r, 40));
    if (flowRef.current.on) flowRef.current.done("house", { next: "wrap" });
  };

  // The bill (2026-10-10): what the rooms on the table cost, night by night and for the stay —
  // the picks as they stand, saved or not; with none, what Take it would hold.
  const stayNightSet = useMemo(() => new Set(stayNights), [stayNights]);
  const numberPicked: BillNight[] = sel.allPicked.length
    ? displayNights
        .filter((d) => stayNightSet.has(d))
        .map((date) => ({ date, roomIds: sel.effectiveByNight[date] ?? [] }))
    : [];
  const picked: BillNight[] = byTypeMode ? (typePicks?.perNight ?? []).filter((n) => stayNightSet.has(n.date)) : numberPicked;
  // Take it takes the marked type's rooms free on every night — the chart's room first, when it is one.
  const takeIds = chosenRow
    ? (chartPick && chosenRow.full.includes(chartPick) ? [chartPick, ...chosenRow.full.filter((id) => id !== chartPick)] : chosenRow.full).slice(0, numberOfRooms)
    : [];
  const candidate: BillNight[] =
    !picked.length && chosenRow && chosenRow.full.length >= numberOfRooms
      ? stayNights.map((date) => ({ date, roomIds: takeIds }))
      : [];
  const billFor = picked.length ? picked : candidate;
  const bill = usePickPricing(entry.id, billFor, hasResults);
  const pickedSaved = byTypeMode ? !!typePicks?.saved : sel.savedCanon != null && sel.savedCanon === sel.currentCanon;
  // A trip at Inquiry: every stay's rooms priced together (2026-11-07, operator: "the charges show
  // for only first stay, show for both"). Another stay's rooms are its grid's as they stand, else
  // its saved pick; null from its grid means they do not fit yet.
  const [otherPicks, setOtherPicks] = useState<Record<string, { perNight: BillNight[]; labels: Record<string, string>; saved: boolean } | null>>({});
  const onOtherPicks = useCallback(
    (id: string, p: { perNight: BillNight[]; labels: Map<string, string>; saved: boolean } | null) =>
      setOtherPicks((prev) => {
        const next = p ? { perNight: p.perNight, labels: Object.fromEntries(p.labels), saved: p.saved } : null;
        return JSON.stringify(prev[id]) === JSON.stringify(next) ? prev : { ...prev, [id]: next };
      }),
    [],
  );
  const otherNights = (o: EntryDetail): BillNight[] => {
    const got = byTypeMode ? otherPicks[o.id] : undefined;
    return got === undefined ? savedPickNights(o) : (got?.perNight ?? []);
  };
  const tripStays =
    trip.combined && trip.loaded ? [{ entryId: entry.id, picks: billFor }, ...trip.others.map((o) => ({ entryId: o.id, picks: otherNights(o) }))] : [];
  const tripBill = useTripPickPricing(entry.id, tripStays, hasResults && tripStays.length > 1);
  const othersSaved = trip.others.every((o) => {
    const got = byTypeMode ? otherPicks[o.id] : undefined;
    return got === undefined ? savedPickNights(o).length > 0 : !!got?.saved;
  });
  // Picks changed and not saved: the house does not read as done (2026-10-27).
  // A trip's other stays picked by number in the pop-up count too (2026-11-07).
  const [othersByNumberDirty, setOthersByNumberDirty] = useState(false);
  useFlowUnsaved(
    "house",
    editable && !past && !byTypeMode && (sel.currentCanon !== sel.savedCanon || othersByNumberDirty),
    "The rooms picked saved",
  );
  // The bill lives in the booking file (2026-10-27, operator: "when rooms are picked, show this on
  // the right, in Charges & payments › The price, with the nights and the rooms"). A pick made by
  // hand opens it there; picks restored on arrival or a background re-read do not, and the page
  // never moves — only the file's tab changes.
  const openFile = useOpenFileTab();
  const handPickedAt = useRef(0);
  const markHandPick = () => {
    handPickedAt.current = Date.now();
  };
  const pickKey = picked.length ? JSON.stringify(cleanPicks(picked)) : "";
  const lastPickKey = useRef(pickKey);
  useEffect(() => {
    if (pickKey === lastPickKey.current) return;
    lastPickKey.current = pickKey;
    if (!pickKey || !editable || past || Date.now() - handPickedAt.current > 2000) return;
    openFile("money", "price");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickKey]);
  // What is picked, saved or not, for the Charges & payments tab and the header total.
  const pickLabels = byTypeMode ? (typePicks?.labels ?? bookingRoomsView.labels) : bookingRoomsView.labels;
  usePublishPriceDraft(
    entry.id,
    editable
      ? {
          kind: "PICKS",
          perNight: picked,
          saved: pickedSaved,
          labels: Object.fromEntries(pickLabels),
          // The trip's other stays, as this page has them (2026-11-07).
          trip: trip.combined
            ? trip.others.map((o) => ({
                entryId: o.id,
                perNight: otherNights(o),
                saved: byTypeMode && otherPicks[o.id] !== undefined ? !!otherPicks[o.id]?.saved : true,
                labels: otherPicks[o.id]?.labels,
              }))
            : undefined,
        }
      : null,
  );
  const billTitle = picked.length
    ? pickedSaved
      ? "The rooms chosen"
      : "The rooms picked · not saved yet"
    : `If you take it · ${plural(numberOfRooms, "room")} of ${chosenType ?? "the marked type"}`;

  const takeIt = () => {
    if (!chosenRow) return;
    markHandPick();
    const ids = takeIds;
    sel.setWholeStay(ids);
    const perNight = stayNights.length
      ? stayNights.map((date) => ({ date, roomIds: ids }))
      : undefined;
    sel.submittedRef.current = null;
    seal.mutate({ perNight, roomIds: ids, allIds: ids });
  };

  useEffect(() => {
    if (!chartRoom || chartRead.current || !editable || past || !session) return;
    const clearAddress = () => {
      const p = new URLSearchParams(searchParams.toString());
      p.delete("room");
      const qs = p.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    };
    if (savedOption) {
      // Rooms already chosen on this booking — the chart's suggestion does not override them.
      chartRead.current = true;
      clearAddress();
      return;
    }
    if (!hasResults) {
      if (chartAsked.current || !entry.checkInDate || !entry.checkOutDate) return;
      // Started once the effect has settled, never inside it (2026-10-23): in development React runs
      // an effect twice, and a search started on the first run left the button cut off from it —
      // "Asking…" for ever, though the house had answered.
      const t = setTimeout(() => {
        chartAsked.current = true;
        ask.mutate();
      }, 0);
      return () => clearTimeout(t);
    }
    chartRead.current = true;
    const row = rows.find((r) => r.roomNumber === chartRoom);
    if (row && row.bucket === "available") {
      // Named, not picked: the desk picks it (or another) itself. Take it puts it first when its
      // type is the one marked.
      setChartPick(row.roomId);
      setChartNote({
        ok: true,
        text: `Room ${chartRoom} (${row.roomTypeName}) from the house chart is free on every night — not picked yet.`,
      });
    } else {
      setChartNote({
        ok: false,
        text: row
          ? `Room ${chartRoom} from the house chart is not free on every night of this stay — choose the rooms from the answer.`
          : `Room ${chartRoom} from the house chart is not in the house's answer — choose the rooms from the answer.`,
      });
    }
    clearAddress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartRoom, editable, past, session, savedOption, hasResults, rows]);

  // Started from the intake (2026-10-27, operator: "ask the house directly as soon as I click
  // Start the inquiry"): the new booking opens with `?ask=1` and the house is asked once on
  // arrival, the same way the chart's room is. A booking already asked, or with rooms chosen, is
  // left as it is; the flag leaves the address once read.
  const askOnArrival = searchParams.get("ask") === "1";
  const arrivalRead = useRef(false);
  useEffect(() => {
    if (!askOnArrival || arrivalRead.current || chartRoom || !editable || past || !session) return;
    const clearAddress = () => {
      const p = new URLSearchParams(searchParams.toString());
      p.delete("ask");
      const qs = p.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    };
    // The stay's "Done · Start the inquiry" goes on to the house (2026-10-28, operator: "after the
    // stay is done it should scroll to the house section, but it's still showing the stay on top"):
    // the booking opens with the house's top just under the head, kept there while its answer
    // arrives. This finishes the move the desk pressed for; it does not happen on any other visit.
    const goToHouse = () =>
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() =>
          window.setTimeout(() => {
            const el = document.getElementById(anchorFor("house"));
            if (el) revealCard(el);
          }, 150),
        ),
      );
    if (hasResults || savedOption || !entry.checkInDate || !entry.checkOutDate) {
      arrivalRead.current = true;
      clearAddress();
      goToHouse();
      return;
    }
    // Started once the effect has settled — see the chart's ask above.
    const t = setTimeout(() => {
      arrivalRead.current = true;
      ask.mutate();
      clearAddress();
      goToHouse();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askOnArrival, chartRoom, editable, past, session, savedOption, hasResults]);

  // The stay's Done asks the house again (2026-10-27) — with the dates it just saved.
  const askRef = useRef(ask);
  askRef.current = ask;
  const autoAsked = useRef<string | null>(null);
  useEffect(() => {
    if (!editable || past) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<StaySaved & { entryId: string }>).detail;
      if (!d || d.entryId !== entry.id || !d.checkInDate || !d.checkOutDate) return;
      autoAsked.current = `${d.checkInDate}|${d.checkOutDate}|${d.guestCount ?? ""}`;
      askRef.current.mutate({ checkInDate: d.checkInDate, checkOutDate: d.checkOutDate, guestCount: d.guestCount });
    };
    window.addEventListener(STAY_SAVED_EVENT, on);
    return () => window.removeEventListener(STAY_SAVED_EVENT, on);
  }, [entry.id, editable, past]);
  // With no Ask again button, an answer gone old (the house's clock marks it so) or one for dates
  // the booking no longer has — the stay changed on another screen — is asked again, once.
  const bookingKey = `${entry.checkInDate?.slice(0, 10) ?? ""}|${entry.checkOutDate?.slice(0, 10) ?? ""}|${entry.guestCount ?? ""}`;
  const otherDates =
    !!searched.checkIn &&
    !!entry.checkInDate &&
    (searched.checkIn !== entry.checkInDate.slice(0, 10) || (!!searched.checkOut && !!entry.checkOutDate && searched.checkOut !== entry.checkOutDate.slice(0, 10)));
  const reask = !hasResults || !editable || past ? null : stale ? `stale:${configId}` : otherDates ? bookingKey : null;
  useEffect(() => {
    if (!reask || autoAsked.current === reask || ask.isPending || !session || !entry.checkInDate || !entry.checkOutDate) return;
    // Started once the effect has settled — see the chart's ask above.
    const t = setTimeout(() => {
      autoAsked.current = reask;
      ask.mutate();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reask, ask.isPending, session]);

  // The room-number table opens as a pop-up over the work column, the booking file left clear
  // (2026-10-28, operator: "a pop up which blurs the screen on the left and not the right side, show
  // the page there") — a room picked by hand opens its bill in the file beside it.
  const [toolOpen, setToolOpen] = useState(false);
  /** The house on the whole screen: Escape or Close full screen leaves it; the page behind holds still. */
  const [houseFull, setHouseFull] = useState(false);
  // Where the page was when Full screen was pressed: the house leaves the page while it is lifted, so the
  // page is shorter and the browser loses its place; it is put back on leaving (the page never moves on its own).
  const fullFromY = useRef(0);
  const openFull = () => {
    fullFromY.current = window.scrollY;
    setHouseFull(true);
  };
  useEffect(() => {
    if (!houseFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHouseFull(false);
    };
    const html = document.documentElement;
    const was = html.style.overflow;
    const y = fullFromY.current;
    html.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      html.style.overflow = was;
      window.scrollTo(0, y);
      requestAnimationFrame(() => {
        if (window.scrollY !== y) window.scrollTo(0, y);
      });
    };
  }, [houseFull]);
  const openTool = () => setToolOpen(true);
  // The by-type grid is off the page while rooms are picked by number; what it held unsaved is
  // kept here and given back when it returns.
  const typeDraft = useRef<TypeDraft | null>(null);
  // A trip's other stays: their counts not saved yet survive the by-number pop-up too.
  const otherDrafts = useRef<Record<string, TypeDraft>>({});
  // Closing it without a pick saved by number goes back to picking by type, where it came from.
  const closeTool = () => {
    setToolOpen(false);
    if (!savedByNumber) setMode("TYPE");
  };
  const showTool = hasResults && !past && !byTypeMode && toolOpen;
  // This booking's stay, as the trip's one table sees it.
  const currentByNumber: StayByNumber = {
    entry,
    stayNo: trip.stayNoOf(entry.id),
    mine: true,
    rows,
    perDate,
    displayNights,
    numberOfRooms,
    sel,
    configId,
    stale,
    nightTotals: picked.length && bill.pricing ? Object.fromEntries(bill.pricing.nights.map((n) => [n.date, money(n.total, bill.pricing!.currency)])) : undefined,
  };

  const takeReason = !editable
    ? null
    : !configId
      ? "ask the house first"
      : stale
        ? "the house is being asked again"
        : !chosenRow
          ? "choose a type in the table"
          : chosenRow.full.length < numberOfRooms
            ? `only ${chosenRow.full.length} ${chosenRow.name} free on every night — choose the rooms by night instead`
            : null;

  const savedNumbers = savedIds
    .map(
      (id) =>
        rows.find((r) => r.roomId === id)?.roomNumber ??
        catalog.find((r) => r.id === id)?.roomNumber,
    )
    .filter(Boolean);

  return (
    <>
      <StepCard
        flow="house"
        flowAfter="stay"
        flowAfterOnly
        revealAtTop
        // Full screen beside the title, not on a row of its own over the grid (2026-11-13, operator: "too
        // much space above the type").
        right={
          hasResults && !houseFull ? (
            <Button kind="quiet" compact onClick={openFull}>
              Full screen
            </Button>
          ) : undefined
        }
        title={
          <>
            {trip.combined ? (
              `The house · ${plural(trip.otherIds.length + 1, "stay")}`
            ) : hasResults || entry.checkInDate ? (
              <>
                The house · <StayDates checkIn={searched.checkIn ?? entry.checkInDate} checkOut={searched.checkOut ?? entry.checkOutDate} />
              </>
            ) : (
              "The house"
            )}
            {houseShort?.kind === "SHORT" ? (
              <span className="house-short" role="alert">
                Not enough rooms · {numberOfRooms} asked,{" "}
                {houseShort.free === 0 ? "none" : `only ${houseShort.free}`} free
                {houseShort.night && stayNights.length > 1 ? ` on ${fmtDay(houseShort.night)}` : ""}
              </span>
            ) : houseShort?.kind === "MIX" ? (
              <span className="house-short mix" role="status">
                No one type has {numberOfRooms} free — mix types
              </span>
            ) : null}
          </>
        }
        meta="Ask the house — the free rooms for these dates, and what they cost, appear here while you are still on the phone."
        acts={
          editable ? (
            hasResults ? (
              <>
                {byTypeMode ? null : (
                <Button
                  className="go"
                  state={
                    seal.isPending
                      ? "working"
                      : takeReason
                        ? "inert"
                        : "default"
                  }
                  title={takeReason ?? undefined}
                  workingLabel="Taking…"
                  onClick={takeIt}
                >
                  Take it
                </Button>
                )}
                <Button
                  kind="quiet"
                  compact
                  title="Record it under Other ways › The guest said no — say that nothing was free"
                  onClick={() => openWay("decline")}
                >
                  Nothing available
                </Button>
              </>
            ) : (
              <Button
                state={
                  ask.isPending
                    ? "working"
                    : entry.checkInDate && entry.checkOutDate
                      ? "default"
                      : "inert"
                }
                title={entry.checkInDate ? undefined : "put in the dates first"}
                workingLabel="Asking…"
                onClick={() => ask.mutate()}
              >
                Ask the house
              </Button>
            )
          ) : null
        }
      >
        {!hasResults ? (
          entry.checkInDate ? null : <span className="meta">Put in the dates and the rooms first.</span>
        ) : (
          <div className={`house-fullwrap${houseFull ? " on" : ""}`} role={houseFull ? "dialog" : undefined} aria-label={houseFull ? "The house, full screen" : undefined}>
            {/* The house on the whole screen (2026-11-13, operator: "i think we need a full screen option for
                that section as well"). The same grid, lifted: nothing is drawn again, nothing typed is lost. */}
            {houseFull ? (
              <div className="house-fullbar">
                <b>The house</b>
                {entry.checkInDate ? <StayDates checkIn={entry.checkInDate} checkOut={entry.checkOutDate} /> : null}
                {trip.combined ? <span className="meta">· {plural(trip.others.length + 1, "stay")}</span> : null}
                <span className="meta" style={{ marginLeft: "auto" }}>
                  Esc to leave
                </span>
                <Button kind="secondary" compact onClick={() => setHouseFull(false)}>
                  Close full screen
                </Button>
              </div>
            ) : null}
            {chartNote ? (
              <p className={`chart-from${chartNote.ok ? "" : " warn"}`} role="status">
                {chartNote.text}
              </p>
            ) : null}
            {byTypeMode && trip.combined ? (
              trip.loaded ? (
                <TripHouse
                  entry={entry}
                  others={trip.others}
                  stayNoOf={trip.stayNoOf}
                  catalog={catalog}
                  editable={editable && !past}
                  renderCurrent={(combined) => (
                    <RoomsByType
                      entry={entry}
                      configId={configId}
                      stale={stale}
                      nights={stayNights}
                      numberOfRooms={numberOfRooms}
                      catalog={catalog}
                      editable={editable && !past}
                      onPicks={setTypePicks}
                      onSaved={() => {}}
                      onParticular={() => {}}
                      draft={typeDraft.current}
                      onDraft={(d) => {
                        typeDraft.current = d;
                      }}
                      flowKey={null}
                      combined={combined}
                    />
                  )}
                  drafts={otherDrafts.current}
                  onOtherPicks={onOtherPicks}
                  onParticular={() => {
                    setMode("NUMBER");
                    openTool();
                  }}
                  onAllSaved={() => {
                    refresh();
                    for (const id of trip.otherIds) void qc.invalidateQueries({ queryKey: ["entry", id] });
                    void goToWrap();
                  }}
                />
              ) : (
                <p className="meta">Reading the trip&rsquo;s other stays…</p>
              )
            ) : byTypeMode ? (
              <RoomsByType
                entry={entry}
                configId={configId}
                stale={stale}
                nights={stayNights}
                numberOfRooms={numberOfRooms}
                catalog={catalog}
                editable={editable && !past}
                onPicks={setTypePicks}
                onSaved={() => {
                  refresh();
                  void goToWrap();
                }}
                onParticular={() => {
                  setMode("NUMBER");
                  openTool();
                }}
                draft={typeDraft.current}
                onDraft={(d) => {
                  typeDraft.current = d;
                }}
              />
            ) : (
            <table className="table compact house-types">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>
                    Free every night
                    {nightCols.length ? (
                      <Help label="About the nights">
                        A room counts as free only when it is free on every night of the stay. Each night&rsquo;s column says how many of
                        that type are free that night — a room free on some nights only can still be chosen for those nights in
                        Choose the rooms.
                      </Help>
                    ) : null}
                  </th>
                  {nightCols.map((n) => (
                    <th key={n} className="hn">
                      {WEEKDAY[new Date(`${n}T00:00:00Z`).getUTCDay()]}
                      <small>{fmtDay(n)}</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byType.map((t) => (
                  <tr
                    key={t.name}
                    className={`${editable ? "pickable" : "static"}${t.name === chosenType ? " selected" : ""}`}
                    onClick={editable ? () => setPickedType(t.name) : undefined}
                  >
                    <td>{t.name}</td>
                    <td>
                      {t.full.length >= numberOfRooms ? (
                        <Chip tone="success">{t.full.length} free</Chip>
                      ) : t.full.length > 0 ? (
                        <Chip tone="warning" title={`fewer than the ${numberOfRooms} rooms asked`}>
                          {t.full.length} free · fewer than {numberOfRooms}
                        </Chip>
                      ) : t.partial > 0 ? (
                        <Chip tone="warning">{t.partial} on some nights</Chip>
                      ) : (
                        <Chip tone="quiet">none</Chip>
                      )}
                      {t.full.length > 0 && t.partial > 0 ? <span className="meta"> · {t.partial} more on some nights</span> : null}
                      {t.deficient > 0 ? (
                        <span className="meta">
                          {" "}
                          · {t.deficient} with a fault
                        </span>
                      ) : null}
                    </td>
                    {nightCols.map((n) => {
                      const free = freeByTypeNight.get(t.name)?.get(n) ?? 0;
                      return (
                        <td
                          key={n}
                          className={`hn${free === 0 ? " none" : free < numberOfRooms ? " low" : ""}`}
                          title={`${plural(free, "room")} of this type free on ${fmtDay(n)}`}
                        >
                          {free}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            )}
            {tripBill.pricing ? (
              <TripPickLine
                trip={tripBill.pricing}
                stayNoOf={trip.stayNoOf}
                loading={tripBill.loading}
                title={pickedSaved && othersSaved ? "The rooms chosen" : "The rooms picked · not all saved yet"}
                help="Indicative, not a quote. Meals, extra beds and any agreed rate are set at Negotiation. The bill for every stay — together, or stay by stay — is in the booking file, under Charges & payments."
              />
            ) : bill.pricing ? (
              <div className={`pb-line${bill.loading ? " loading" : ""}`}>
                <span className="pb-line-k">{billTitle}</span>
                <b className="money">{money(bill.pricing.totals.total, bill.pricing.currency)}</b>
                <span className="meta">
                  {plural(bill.pricing.totals.roomNights, "room-night")} · room only, taxes included
                </span>
                <Help label="About this figure">
                  Indicative, not a quote. Meals, extra beds and any agreed rate are set at Negotiation.
                  {picked.length ? " The bill for the rooms picked — each night, its rooms and the taxes — is in the booking file, under Charges & payments." : ""}
                </Help>
              </div>
            ) : chosenPricing ? (
              <div style={{ marginTop: 10 }}>
                <b className="money">
                  {money(
                    chosenPricing.lineTotalIndicative ?? chosenPricing.rateAmount ?? null,
                    chosenPricing.currency,
                  )}
                </b>{" "}
                <span className="meta">
                  indicative · {chosenType ? `${/^[aeiou]/i.test(chosenType) ? "an" : "a"} ${chosenType}` : "a room"}
                  {chosenPricing.stayNights
                    ? ` for ${plural(chosenPricing.stayNights, "night")}`
                    : ""}
                  {chosenPricing.rateAmount != null
                    ? ` at ${money(chosenPricing.rateAmount, chosenPricing.currency)} a night`
                    : ""}{" "}
                  · not a quote
                </span>
              </div>
            ) : null}
            {ask.isPending ? (
              <div className="sm meta" style={{ marginTop: 8 }} role="status">
                Asking the house for these dates…
              </div>
            ) : stale ? (
              <div className="sm warn-ink" style={{ marginTop: 8 }}>
                This answer is old — the house is asked again.
              </div>
            ) : null}
            {pickMisfit ? (
              <p className="pick-misfit" role="alert">
                <span className="mark" aria-hidden>!</span>
                The rooms chosen no longer fit the stay — {pickMisfit}. Choose the rooms again.
              </p>
            ) : null}
            {savedIds.length ? (
              <div
                className="sm"
                style={{
                  marginTop: 10,
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <Chip tone={pickMisfit ? "warning" : "success"} icon={pickMisfit ? undefined : "check"}>
                  {pickMisfit ? "chosen for the stay before" : "chosen"}
                </Chip>
                {savedByType
                  ? savedIds.map((id) => bookingRoomsView.labels.get(id) ?? `Room ${rows.find((r) => r.roomId === id)?.roomNumber ?? catalog.find((r) => r.id === id)?.roomNumber ?? "?"}`).join(", ")
                  : `Room${savedNumbers.length === 1 ? "" : "s"} ${savedNumbers.join(", ")}`}
                {savedTypes.length ? (
                  <span className="meta"> · {savedTypes.join(", ")}</span>
                ) : null}
                {"perNight" in (savedOption ?? {}) && sel.nightsDiffer ? (
                  <span className="meta"> · differs by night</span>
                ) : null}
              </div>
            ) : (
              <div className="meta" style={{ marginTop: 8 }}>
                No rooms chosen yet
                <Help label="About Take it">
                  Take it chooses {plural(numberOfRooms, "room")} of the marked type, free on every night.
                </Help>
              </div>
            )}
            {!byTypeMode && savedIds.length ? (
              <TypePackagesLine
                entry={entry}
                editable={editable}
                types={[
                  ...new Map(
                    savedIds
                      .map((id) => catalog.find((r) => r.id === id))
                      .filter((r): r is NonNullable<typeof r> => !!r?.roomTypeId)
                      .map((r) => [r.roomTypeId!, { roomTypeId: r.roomTypeId!, name: r.roomType?.name ?? "Room" }] as const),
                  ).values(),
                ]}
              />
            ) : null}
            {duplicates > 0 ? (
              <div className="sm warn-ink" style={{ marginTop: 8 }}>
                <Icon name="alert" /> A possible duplicate of another inquiry is
                open
              </div>
            ) : null}
            {editable ? (
              <div className="row-acts" style={{ marginTop: 10 }}>
                {/* No Ask again (2026-10-27): the house is asked by itself after the stay's
                    Done, and when its answer goes old. Only a failed ask offers it once more. */}
                {ask.isError && !ask.isPending ? (
                  <Button kind="quiet" compact onClick={() => ask.mutate()}>
                    Try asking the house again
                  </Button>
                ) : null}
                {byTypeMode ? null : (
                  <>
                    <Button kind="quiet" compact onClick={openTool}>
                      Choose the rooms
                    </Button>
                    <Button kind="quiet" compact onClick={() => { setMode("TYPE"); setToolOpen(false); }}>
                      Pick by room type instead
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        )}
      </StepCard>

      <WorkPopup
        open={showTool}
        title={
          trip.combined
            ? `Pick every room by number · ${plural(trip.otherIds.length + 1, "stay")}`
            : `Pick every room by number · ${plural(numberOfRooms, "room")} for ${plural(displayNights.length, "night")}`
        }
        onClose={closeTool}
      >
        <div onPointerDownCapture={markHandPick} onClickCapture={markHandPick} onKeyDownCapture={markHandPick}>
          {trip.combined ? (
            // Every stay of the trip in ONE table, its nights side by side (2026-11-07, operator: "keep
            // the first reserved dates for both stays in one table like how its done in room type").
            <StayModels entries={trip.others} stayNoOf={trip.stayNoOf} catalog={catalog} acc={[currentByNumber]}>
              {(all) => (
                <TripByNumber
                  stays={[...all].sort((a, b) => a.stayNo - b.stayNo)}
                  isGm={isGm}
                  onOthersDirty={setOthersByNumberDirty}
                  onAllSaved={async (savedCurrent) => {
                    setToolOpen(false);
                    if (!savedCurrent && !savedByNumber) setMode("TYPE");
                    refresh();
                    for (const id of trip.otherIds) void qc.invalidateQueries({ queryKey: ["entry", id] });
                    if (savedCurrent) await goToWrap();
                  }}
                  onReleased={() => {
                    ask.mutate();
                    for (const id of trip.otherIds) void qc.invalidateQueries({ queryKey: ["entry", id] });
                  }}
                />
              )}
            </StayModels>
          ) : (
          <WhichRooms
            entry={entry}
            rows={rows}
            perDate={perDate}
            displayNights={displayNights}
            numberOfRooms={numberOfRooms}
            sel={sel}
            catalog={catalog}
            stale={stale}
            saving={seal.isPending}
            onSave={() => {
              const p = sel.payload();
              sel.submittedRef.current = sel.currentCanon;
              seal.mutate(p);
            }}
            justSaved={seal.isSuccess}
            bill={picked.length ? bill.pricing : null}
            isGm={isGm}
            onClose={closeTool}
            popup
            onReleased={() => ask.mutate()}
          />
          )}
        </div>
      </WorkPopup>
    </>
  );
}

/* ------------------------------------------------------------------ a trip's stays by number */

type PickBody = { perNight?: Array<{ date: string; roomIds: string[] }>; roomIds?: string[]; allIds: string[] };

/** Record a stay's rooms by number — the one call the house card and the trip's table share. */
function sealRoomsByNumber(session: NonNullable<ReturnType<typeof useSession>["session"]>, configId: string, rows: RoomStatusRow[], body: PickBody) {
  const deficientIds = body.allIds.filter((id) => rows.find((r) => r.roomId === id)?.bucket === "deficient");
  return selectAvailabilityOption(session, configId, {
    roomIds: body.perNight ? undefined : body.roomIds,
    perNight: body.perNight,
    deficientAcknowledgements: deficientIds.length
      ? deficientIds.map((roomId) => ({ roomId, acknowledgedAt: new Date().toISOString(), note: "Acknowledged when the rooms were chosen at Inquiry" }))
      : undefined,
  });
}

/** One stay of a trip as the rooms-by-number table sees it: its house answer, its nights, its picks. */
type StayByNumber = {
  entry: EntryDetail;
  stayNo: number;
  mine: boolean;
  rows: RoomStatusRow[];
  perDate?: PerDateAvailabilityResult[];
  displayNights: string[];
  numberOfRooms: number;
  sel: ReturnType<typeof useRoomSelection>;
  configId: string | null;
  stale: boolean;
  /** Each night's figure for the rooms picked, already in money (this booking's stay only). */
  nightTotals?: Record<string, string>;
};

/** Another stay of the trip, read for the table: its own house answer and its own picks. */
function useStayByNumber(entry: EntryDetail, stayNo: number, catalog: Catalog): StayByNumber {
  const configs = currentPassConfigs(entry);
  const latest = configs[0] ?? null;
  const preferred = configs.find((c) => c.optionSelected != null) ?? null;
  const { available, deficient, unavailable, perDate } = useMemo(() => {
    const src = latest?.resultSet ?? preferred?.resultSet ?? null;
    const rooms = src ? roomsFromResultSet(src) : { availableRooms: [], deficientRooms: [], unavailableRooms: [] };
    const pd = (src as { perDate?: unknown } | null)?.perDate;
    return {
      available: rooms.availableRooms,
      deficient: rooms.deficientRooms,
      unavailable: rooms.unavailableRooms,
      perDate: Array.isArray(pd) ? (pd as PerDateAvailabilityResult[]) : undefined,
    };
  }, [latest, preferred]);
  const extBeds = useMemo(
    () => new Map(catalog.filter((r) => typeof r.roomType?.maxExtraBeds === "number").map((r) => [r.id, r.roomType!.maxExtraBeds!])),
    [catalog],
  );
  const bedOf = useMemo(() => new Map(catalog.filter((r) => r.bedType).map((r) => [r.id, r.bedType!])), [catalog]);
  const rows = useMemo(() => roomStatusRows(available, deficient, unavailable, extBeds, bedOf), [available, deficient, unavailable, extBeds, bedOf]);
  const stayNights = useMemo(() => enumerateNights(entry.checkInDate, entry.checkOutDate), [entry.checkInDate, entry.checkOutDate]);
  const displayNights = useMemo(() => (perDate?.length ? perDate.map((p) => p.date) : stayNights), [perDate, stayNights]);
  const numberOfRooms = entry.numberOfRooms ?? 1;
  const savedOption = preferred?.optionSelected as AvailabilityOptionSelected | null | undefined;
  const sel = useRoomSelection({ entryId: entry.id, numberOfRooms, savedOption, displayNights, stayNights });
  return { entry, stayNo, mine: false, rows, perDate, displayNights, numberOfRooms, sel, configId: latest?.id ?? null, stale: !!latest?.isStale };
}

/** Read every other stay in turn (a fixed set of hooks on each level), then hand them all over. */
function StayModels({
  entries,
  stayNoOf,
  catalog,
  acc,
  children,
}: {
  entries: EntryDetail[];
  stayNoOf: (id: string) => number;
  catalog: Catalog;
  acc: StayByNumber[];
  children: (all: StayByNumber[]) => ReactNode;
}) {
  if (!entries.length) return <>{children(acc)}</>;
  return (
    <StayModelStep key={entries[0].id} entry={entries[0]} rest={entries.slice(1)} stayNoOf={stayNoOf} catalog={catalog} acc={acc}>
      {children}
    </StayModelStep>
  );
}
function StayModelStep({
  entry,
  rest,
  stayNoOf,
  catalog,
  acc,
  children,
}: {
  entry: EntryDetail;
  rest: EntryDetail[];
  stayNoOf: (id: string) => number;
  catalog: Catalog;
  acc: StayByNumber[];
  children: (all: StayByNumber[]) => ReactNode;
}) {
  const m = useStayByNumber(entry, stayNoOf(entry.id), catalog);
  return (
    <StayModels entries={rest} stayNoOf={stayNoOf} catalog={catalog} acc={[...acc, m]}>
      {children}
    </StayModels>
  );
}

/** A stay's bed ask against the rooms picked for it — the server's own check. */
function StayBedTally({ stay }: { stay: StayByNumber }) {
  const { session } = useSession();
  const bedAsk = (stay.entry.bedTypeRequest as Record<string, number> | null) ?? null;
  const hasBedAsk = !!bedAsk && Object.values(bedAsk).some((n) => n > 0);
  const q = useQuery({
    queryKey: ["bed-request-check", stay.entry.id, JSON.stringify(bedAsk), [...stay.sel.allPicked].sort().join(",")],
    queryFn: () => checkBedRequest(session!, bedAsk ?? {}, [...stay.sel.allPicked]),
    enabled: !!session && hasBedAsk,
    placeholderData: (prev) => prev,
  });
  if (!hasBedAsk) return null;
  return (
    <>
      {(q.data?.perType ?? []).map((t) => (
        <Chip key={t.bedType} tone={t.covered >= t.asked ? "success" : "warning"}>
          Stay {stay.stayNo} asked {t.asked} {BED_WORD[t.bedType] ?? words(t.bedType)} · {t.covered}/{t.asked}
        </Chip>
      ))}
    </>
  );
}

/**
 * A trip's stays at Inquiry picked by number in ONE table (2026-11-07, operator: "keep the first
 * reserved dates for both stays in one table like how its done in room type and also a full screen
 * option, if there are more days"): the rooms down the side, each stay's nights under its own band,
 * each stay counted against its own rooms, one Save for every stay that changed, and the full view.
 */
function TripByNumber({
  stays,
  isGm,
  onOthersDirty,
  onAllSaved,
  onReleased,
}: {
  stays: StayByNumber[];
  isGm: boolean;
  onOthersDirty: (dirty: boolean) => void;
  onAllSaved: (savedCurrent: boolean) => void | Promise<void>;
  onReleased: () => void;
}) {
  const { session } = useSession();
  const [names, setNames] = useState(false);
  const [full, setFull] = useState(false);
  const [release, setRelease] = useState<ReleaseTarget | null>(null);
  // Escape leaves the full view first — caught before the pop-up's own Escape, which then stands down.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".scrim.open")) return;
      e.preventDefault();
      setFull(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

  const dirtyOf = (x: StayByNumber) => x.sel.currentCanon != null && x.sel.currentCanon !== x.sel.savedCanon;
  const othersDirty = stays.some((x) => !x.mine && dirtyOf(x));
  useEffect(() => {
    onOthersDirty(othersDirty);
  }, [othersDirty, onOthersDirty]);
  useEffect(() => () => onOthersDirty(false), [onOthersDirty]);

  const nights = stays.flatMap((x) => x.displayNights);
  const perDate = stays.flatMap((x) => x.perDate ?? []);
  const rows = useMemo(() => {
    const seen = new Map<string, RoomStatusRow>();
    for (const x of stays) for (const r of x.rows) if (!seen.has(r.roomId)) seen.set(r.roomId, r);
    return [...seen.values()];
  }, [stays]);
  const perNightSel = Object.assign({}, ...stays.map((x) => x.sel.effectiveByNight)) as Record<string, string[]>;
  const nightTotals = Object.assign({}, ...stays.map((x) => x.nightTotals ?? {})) as Record<string, string>;
  const stayOf = (n: string) => stays.find((x) => x.displayNights.includes(n));
  const groups: NightGroup[] = stays.map((x) => ({
    key: x.entry.id,
    label: (
      <>
        <span>
          Stay {x.stayNo} · {plural(x.numberOfRooms, "room")}
        </span>
        <StayDates checkIn={x.entry.checkInDate} checkOut={x.entry.checkOutDate} />
      </>
    ),
    nights: x.displayNights,
    maxSelect: x.numberOfRooms,
    referenceIds: x.sel.commonPlan,
    rows: x.rows,
  }));

  const onEveryNight = (x: StayByNumber, id: string) => x.displayNights.every((n) => (x.sel.effectiveByNight[n] ?? x.sel.base).includes(id));
  const toggleRow = (row: RoomStatusRow) => {
    // On every night of every stay: off them all. Otherwise onto each stay that lacks it.
    if (stays.every((x) => onEveryNight(x, row.roomId))) stays.forEach((x) => x.sel.toggleRow(row));
    else stays.filter((x) => !onEveryNight(x, row.roomId)).forEach((x) => x.sel.toggleRow(row));
  };
  const reportSelectAll = (row: RoomStatusRow, outcome: SelectAllOutcome) => {
    const tag = (d: string) => `Stay ${stayOf(d)?.stayNo ?? "?"} · ${fmtDay(d)}`;
    const gaps = [
      ...outcome.blocked.map((b) => `${tag(b.date)} — ${b.status === "held" ? "held" : b.status === "blocked" ? "out of service" : "reserved"}${b.holder ? ` (${b.holder})` : ""}`),
      ...outcome.full.map((d) => `${tag(d)} — that night already has its rooms`),
    ];
    if (!gaps.length) {
      toast.success(`Room ${row.roomNumber} taken on all ${plural(outcome.picked.length, "night")} of the trip.`);
      return;
    }
    toast.warning(
      outcome.picked.length
        ? `Room ${row.roomNumber} taken on ${outcome.picked.length} of ${plural(nights.length, "night")}.`
        : `Room ${row.roomNumber} is not free on any night of the trip.`,
      { description: `Not taken: ${gaps.join(" · ")}`, duration: 10000 },
    );
  };

  const held = useMemo(() => {
    const m = new Map<string, { roomId: string; roomNumber: string; entryId: string; holdKind: "COMMITTED" | "SPECULATIVE"; holdId?: string; holder: string; nights: number }>();
    const nameOf = new Map(rows.map((r) => [r.roomId, r.roomNumber]));
    for (const d of perDate) {
      for (const o of d.occupiedRoomIds) {
        if (o.source !== "HOLD" || !o.entryId) continue;
        const key = `${o.entryId}:${o.roomId}`;
        const cur = m.get(key);
        if (cur) cur.nights += 1;
        else
          m.set(key, {
            roomId: o.roomId,
            roomNumber: nameOf.get(o.roomId) ?? o.roomId,
            entryId: o.entryId,
            holdKind: ((o as { holdKind?: string }).holdKind as "COMMITTED" | "SPECULATIVE") ?? "COMMITTED",
            holdId: (o as { holdId?: string }).holdId,
            holder: o.guestName ?? "a guest",
            nights: 1,
          });
      }
    }
    return [...m.values()].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [perDate, rows]);
  const blocked = rows.filter((r) => r.blockedReason);
  const openRelease = (row: RoomStatusRow, occ: { entryId?: string; guestName?: string | null } | undefined, status: string) => {
    if (!isGm) {
      toast.info("A GM can release a held or blocked room — ask them to open this booking.");
      return;
    }
    if (status === "blocked") setRelease({ kind: "BLOCK", roomId: row.roomId, roomLabel: row.roomNumber, blockedReason: row.blockedReason ?? null });
    else if (occ?.entryId) {
      const h = held.find((x) => x.entryId === occ.entryId && x.roomId === row.roomId);
      setRelease({
        kind: "HOLD",
        entryId: occ.entryId,
        holdKind: h?.holdKind ?? "COMMITTED",
        holdId: h?.holdId,
        roomId: row.roomId,
        roomLabel: row.roomNumber,
        holder: occ.guestName ?? "a guest",
        siblings: held.filter((x) => x.entryId === occ.entryId).map((x) => x.roomNumber),
      });
    }
  };

  const saveAll = useMutation({
    mutationFn: async () => {
      const changed = stays.filter(dirtyOf);
      // The other stays first, this booking's last — its save is the one that moves on to Wrap up.
      for (const x of [...changed.filter((c) => !c.mine), ...changed.filter((c) => c.mine)]) {
        if (!x.configId) throw new Error(`Ask the house for stay ${x.stayNo} first`);
        const body = x.sel.payload();
        x.sel.submittedRef.current = x.sel.currentCanon;
        try {
          await sealRoomsByNumber(session!, x.configId, x.rows, body);
        } catch (e) {
          throw new Error(`Stay ${x.stayNo}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return changed;
    },
    onSuccess: async (changed) => {
      toast.success(`The rooms are chosen for ${plural(changed.length, "stay")} and on record`);
      await onAllSaved(changed.some((x) => x.mine));
    },
    onError: (e) => toastRefusal(e, "The rooms could not be recorded"),
  });
  const anyDirty = stays.some(dirtyOf);
  const notReady = stays.find((x) => !x.sel.ready);
  const staleStay = stays.find((x) => x.stale);
  const reason = staleStay
    ? `the house is being asked again for stay ${staleStay.stayNo} — your picks are kept`
    : notReady
      ? `stay ${notReady.stayNo}: every night needs its ${plural(notReady.numberOfRooms, "room")}`
      : !anyDirty
        ? "this choice is on record — change a room to edit it"
        : null;

  const band = (
    <div className="row-acts rooms-saverow">
      <span className="trip-bynum-state">
        {stays.map((x) => {
          const counter = x.sel.nightsDiffer
            ? `${x.sel.nightsReady} of ${plural(x.displayNights.length, "night")} ready`
            : `${x.sel.commonPlan.length} of ${x.numberOfRooms} chosen`;
          return (
            <span key={x.entry.id} className={x.sel.ready ? "ok-ink" : "stop-ink"}>
              Stay {x.stayNo} · {counter}
              {x.sel.ready && !dirtyOf(x) && x.sel.savedCanon ? " · saved" : ""}
            </span>
          );
        })}
      </span>
      {stays.map((x) => (
        <StayBedTally key={x.entry.id} stay={x} />
      ))}
      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 12 }}>
        <Button kind="quiet" compact icon="person" aria-pressed={names} onClick={() => setNames((v) => !v)}>
          {names ? "Names shown" : "Show names"}
        </Button>
        <Button kind="quiet" compact aria-pressed={full} onClick={() => setFull((v) => !v)}>
          {full ? "Close the full view" : "Full screen"}
        </Button>
        <Button
          className="go"
          state={saveAll.isPending ? "working" : reason ? "inert" : "default"}
          title={reason ?? undefined}
          workingLabel="Saving…"
          onClick={() => saveAll.mutate()}
        >
          Save the rooms
        </Button>
      </span>
    </div>
  );
  const table = (
    <Tool>
      <RoomStatusTable
        rows={rows}
        nights={nights}
        perDate={perDate}
        selectedIds={[]}
        perNightSel={perNightSel}
        maxSelect={Math.max(...stays.map((x) => x.numberOfRooms))}
        nightGroups={groups}
        onToggle={toggleRow}
        onToggleCell={(row, n) => stayOf(n)?.sel.toggleCell(row, n)}
        onSelectAllNights={reportSelectAll}
        onBlockedCellOpen={(row, _n, occ, status) => openRelease(row, occ, status)}
        onCappedClick={() => toast.info("Every night of the trip already has its rooms — take one off first, or click this room under a single night.")}
        disabled={saveAll.isPending}
        showNames={names}
        large={full}
        nightTotals={Object.keys(nightTotals).length ? nightTotals : undefined}
      />
    </Tool>
  );
  const notes = (
    <>
      {held.length || blocked.length ? (
        <div className="sm" style={{ marginTop: 10, display: "grid", gap: 4 }}>
          <span className="meta">Not available on these dates</span>
          {held.map((h) => (
            <span key={`${h.entryId}:${h.roomId}`}>
              Room {h.roomNumber} · {h.holdKind === "SPECULATIVE" ? "marked" : "held"} for {h.holder} · {plural(h.nights, "night")}
            </span>
          ))}
          {blocked.map((r) => (
            <span key={r.roomId}>
              Room {r.roomNumber} · out of service{r.blockedReason ? ` — ${r.blockedReason}` : ""}
            </span>
          ))}
          <HelpHere label="About releasing a room">
            {isGm ? "Double-click a held or blocked night to release it." : "A GM can release a held or blocked room."}
          </HelpHere>
        </div>
      ) : null}
      <HelpHere label="How to pick rooms in this table">
        Each stay&rsquo;s nights sit under its own band. Click a room&rsquo;s number to use it on every night of the trip; click one night to
        change only that night. Each stay is counted against its own rooms. Nothing is recorded until you save.
      </HelpHere>
    </>
  );
  return (
    <div className="which-rooms-pop">
      {full ? (
        <Overlay>
          <div className="fullscreen-layer over-pop">
            <StepCard title={`Pick every room by number · ${plural(stays.length, "stay")}`}>
              {band}
              {table}
            </StepCard>
          </div>
        </Overlay>
      ) : (
        <>
          {band}
          {table}
          {notes}
        </>
      )}
      <ReleaseDialog target={release} onClose={() => setRelease(null)} onDone={onReleased} />
    </div>
  );
}

/* ------------------------------------------------------------------ which rooms (the tool) */

function WhichRooms({
  entry,
  rows,
  perDate,
  displayNights,
  numberOfRooms,
  sel,
  catalog,
  stale,
  saving,
  onSave,
  justSaved,
  bill,
  isGm,
  onClose,
  onReleased,
  popup = false,
}: {
  entry: EntryDetail;
  rows: RoomStatusRow[];
  perDate?: PerDateAvailabilityResult[];
  displayNights: string[];
  numberOfRooms: number;
  sel: ReturnType<typeof useRoomSelection>;
  catalog: Catalog;
  stale: boolean;
  saving: boolean;
  onSave: () => void;
  justSaved: boolean;
  /** What the picks cost — each night's figure goes under its date in the room table. */
  bill: PickPricing | null;
  isGm: boolean;
  onClose: () => void;
  onReleased: () => void;
  /** Drawn inside the work-column pop-up: no card of its own, no full screen, the pop-up closes it. */
  popup?: boolean;
}) {
  const [names, setNames] = useState(false);
  const [full, setFull] = useState(false);
  const [release, setRelease] = useState<ReleaseTarget | null>(null);
  useEffect(() => {
    if (!full) return;
    // Caught first, so Escape leaves the full view and the pop-up behind it stays open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".scrim.open")) return;
      e.preventDefault();
      setFull(false);
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [full]);

  const showSaved =
    !saving &&
    sel.currentCanon != null &&
    (sel.savedCanon === sel.currentCanon ||
      (justSaved && sel.submittedRef.current === sel.currentCanon));

  // How much of the guest's bed request the picked rooms can cover, one setup per room — the
  // server's own check (2026-09-19; any room can take any setup the admin console allows it).
  const { session: tallySession } = useSession();
  const bedAsk = (entry.bedTypeRequest as Record<string, number> | null) ?? null;
  const hasBedAsk = !!bedAsk && Object.values(bedAsk).some((n) => n > 0);
  const tallyQuery = useQuery({
    queryKey: ["bed-request-check", entry.id, JSON.stringify(bedAsk), [...sel.allPicked].sort().join(",")],
    queryFn: () => checkBedRequest(tallySession!, bedAsk ?? {}, [...sel.allPicked]),
    enabled: !!tallySession && hasBedAsk,
    placeholderData: (prev) => prev,
  });
  const tally = hasBedAsk
    ? (tallyQuery.data?.perType ?? []).map((t) => ({
        parts: [`${t.asked} ${BED_WORD[t.bedType] ?? words(t.bedType)}`],
        asked: t.asked,
        picked: t.covered,
      }))
    : [];

  const held = useMemo(() => {
    const m = new Map<
      string,
      {
        roomId: string;
        roomNumber: string;
        entryId: string;
        holdKind: "COMMITTED" | "SPECULATIVE";
        holdId?: string;
        holder: string;
        nights: number;
      }
    >();
    const nameOf = new Map(rows.map((r) => [r.roomId, r.roomNumber]));
    for (const d of perDate ?? []) {
      for (const o of d.occupiedRoomIds) {
        if (o.source !== "HOLD" || !o.entryId) continue;
        const key = `${o.entryId}:${o.roomId}`;
        const cur = m.get(key);
        if (cur) cur.nights += 1;
        else
          m.set(key, {
            roomId: o.roomId,
            roomNumber: nameOf.get(o.roomId) ?? o.roomId,
            entryId: o.entryId,
            holdKind:
              ((o as { holdKind?: string }).holdKind as
                "COMMITTED" | "SPECULATIVE") ?? "COMMITTED",
            holdId: (o as { holdId?: string }).holdId,
            holder: o.guestName ?? "a guest",
            nights: 1,
          });
      }
    }
    return [...m.values()].sort((a, b) =>
      a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
    );
  }, [perDate, rows]);
  const blocked = rows.filter((r) => r.blockedReason);

  const openRelease = (
    row: RoomStatusRow,
    occ: { entryId?: string; guestName?: string | null } | undefined,
    status: string,
  ) => {
    if (!isGm) {
      toast.info(
        "A GM can release a held or blocked room — ask them to open this booking.",
      );
      return;
    }
    if (status === "blocked")
      setRelease({
        kind: "BLOCK",
        roomId: row.roomId,
        roomLabel: row.roomNumber,
        blockedReason: row.blockedReason ?? null,
      });
    else if (occ?.entryId) {
      const h = held.find(
        (x) => x.entryId === occ.entryId && x.roomId === row.roomId,
      );
      setRelease({
        kind: "HOLD",
        entryId: occ.entryId,
        holdKind: h?.holdKind ?? "COMMITTED",
        holdId: h?.holdId,
        roomId: row.roomId,
        roomLabel: row.roomNumber,
        holder: occ.guestName ?? "a guest",
        siblings: held
          .filter((x) => x.entryId === occ.entryId)
          .map((x) => x.roomNumber),
      });
    }
  };

  const counter = sel.nightsDiffer
    ? `${sel.nightsReady} of ${plural(displayNights.length, "night")} ready`
    : `${sel.commonPlan.length} of ${numberOfRooms} chosen`;
  const saveWord = showSaved
    ? "Saved"
    : stale
      ? "Waiting for the house"
      : sel.nightsDiffer
        ? "Save the rooms by night"
        : numberOfRooms === 1
          ? "Save the room"
          : `Save ${numberOfRooms} rooms`;

  // The rooms by night only (2026-10-28, operator: "remove place the guests option, that way rooms
  // by night option is also not needed") — the guests are placed at Negotiation, room by room.
  const namesButton = (
    <Button kind="quiet" compact icon="person" aria-pressed={names} onClick={() => setNames((v) => !v)}>
      {names ? "Names shown" : "Show names"}
    </Button>
  );
  const right = (
        <>
          {popup ? null : namesButton}
          {popup ? null : (
            <Button kind="quiet" compact onClick={() => setFull((v) => !v)}>
              {full ? "Close the full view" : "Full screen"}
            </Button>
          )}
          {!full && !popup ? (
            <Button kind="quiet" compact icon="x" onClick={onClose}>
              Hide
            </Button>
          ) : null}
        </>
  );
  const inner = (
    <>
      {/* The count and the save on a band of their own under the card's buttons (2026-10-27,
          operator: "make Save the room prominent — it looks misaligned, too close to the button on top"). */}
      <div className="row-acts rooms-saverow">
        <span className={`rooms-count ${sel.ready ? "ok-ink" : "stop-ink"}`}>{counter}</span>
        {tally.map((t) => (
          <Chip
            key={t.parts.join("+")}
            tone={t.picked >= t.asked ? "success" : "warning"}
          >
            Asked {t.parts.join(" + ")} · {t.picked}/{t.asked}
          </Chip>
        ))}
        {displayNights.length > 1 ? (
          sel.nightsDiffer ? (
            <Chip
              tone="warning"
              qualifier={
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    sel.resetNights();
                  }}
                >
                  make them the same
                </a>
              }
            >
              {plural(sel.differingNights.length, "night")} {sel.differingNights.length === 1 ? "differs" : "differ"}
            </Chip>
          ) : (
            <Chip tone="quiet">the same rooms every night</Chip>
          )
        ) : null}
        {/* The save sits at the right end of the row, apart from the tallies it acts on
            (operator, 2026-09-29): the eye reads the counts left to right and lands on the act. */}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 12 }}>
          {/* In the pop-up, Show names and Full screen sit beside the save (2026-10-28; full screen 2026-11-07,
              operator: "a full screen option, if there are more days"). */}
          {popup ? namesButton : null}
          {popup ? (
            <Button kind="quiet" compact aria-pressed={full} onClick={() => setFull((v) => !v)}>
              {full ? "Close the full view" : "Full screen"}
            </Button>
          ) : null}
          <Button
            className="go"
            kind={showSaved ? "secondary" : "primary"}
            icon={showSaved ? "check" : undefined}
            state={
              saving
                ? "working"
                : showSaved || !sel.ready || stale
                  ? "inert"
                  : "default"
            }
            title={
              showSaved
                ? "this choice is on record — change a room to edit it"
                : stale
                  ? "the answer is old — ask the house again; your picks are kept"
                  : !sel.ready
                    ? "every night needs its rooms"
                    : undefined
            }
            workingLabel="Saving…"
            onClick={onSave}
          >
            {saveWord}
          </Button>
        </span>
      </div>
      {/* No total band here (2026-10-19, operator: "there is already a table on top to do that") —
          the house card's bill above carries the stay's total and each room type's. */}
      <Tool>
          <RoomStatusTable
            rows={rows}
            nights={displayNights}
            perDate={perDate}
            selectedIds={sel.base}
            perNightSel={sel.effectiveByNight}
            referenceIds={sel.commonPlan}
            maxSelect={numberOfRooms}
            onToggle={sel.toggleRow}
            onToggleCell={sel.toggleCell}
            onSelectAllNights={sel.reportSelectAll}
            onBlockedCellOpen={(row, _n, occ, status) =>
              openRelease(row, occ, status)
            }
            onCappedClick={() =>
              toast.info(
                sel.nightsDiffer
                  ? `Every night already has its ${plural(numberOfRooms, "room")} — free one first, or click this room under a single night.`
                  : `All ${plural(numberOfRooms, "room")} are chosen — take one off first to swap it.`,
              )
            }
            disabled={saving}
            showNames={names}
            large={full}
            nightTotals={bill ? Object.fromEntries(bill.nights.map((n) => [n.date, money(n.total, bill.currency)])) : undefined}
          />
      </Tool>
      {!full && (held.length || blocked.length) ? (
        <div className="sm" style={{ marginTop: 10, display: "grid", gap: 4 }}>
          <span className="meta">Not available on these dates</span>
          {held.map((h) => (
            <span key={`${h.entryId}:${h.roomId}`}>
              Room {h.roomNumber} ·{" "}
              {h.holdKind === "SPECULATIVE" ? "marked" : "held"} for {h.holder}{" "}
              · {plural(h.nights, "night")}
            </span>
          ))}
          {blocked.map((r) => (
            <span key={r.roomId}>
              Room {r.roomNumber} · out of service
              {r.blockedReason ? ` — ${r.blockedReason}` : ""}
            </span>
          ))}
          <HelpHere label="About releasing a room">
            {isGm ? "Double-click a held or blocked night to release it." : "A GM can release a held or blocked room."}
          </HelpHere>
        </div>
      ) : null}
      {!full ? (
        <HelpHere label="How to pick rooms in this table">
          Click a room&rsquo;s number to use it for the whole stay
          {displayNights.length > 1 ? "; click one night to change only that night" : ""}. Nothing is recorded until you save. A room
          with a fault can be chosen — the acknowledgement is recorded with the save.
        </HelpHere>
      ) : null}
      <ReleaseDialog
        target={release}
        onClose={() => setRelease(null)}
        onDone={onReleased}
      />
    </>
  );
  if (popup)
    // The full view is drawn at the desk's root: the pop-up's blurred scrim would hold it inside itself.
    return full ? (
      <Overlay>
        <div className="fullscreen-layer over-pop">
          <StepCard title={`Which rooms · ${plural(numberOfRooms, "room")} for ${plural(displayNights.length, "night")}`}>{inner}</StepCard>
        </div>
      </Overlay>
    ) : (
      <div className="which-rooms-pop">{inner}</div>
    );
  const body = (
    <StepCard title={`Which rooms · ${plural(numberOfRooms, "room")} for ${plural(displayNights.length, "night")}`} right={right}>
      {inner}
    </StepCard>
  );
  return full ? <div className="fullscreen-layer">{body}</div> : body;
}

function ReleaseDialog({
  target,
  onClose,
  onDone,
}: {
  target: ReleaseTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { session } = useSession();
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [target]);
  const canScope =
    target?.kind === "HOLD" &&
    target.holdKind === "COMMITTED" &&
    target.siblings.length > 1;
  const run = useMutation({
    mutationFn: async (reason: string) => {
      if (!target) return;
      if (target.kind === "BLOCK")
        await releaseRoomBlock(session!, target.roomId, {
          releaseReason: reason,
        });
      else if (target.holdKind === "SPECULATIVE")
        await releaseSpeculativeHold(session!, target.entryId, target.holdId!, {
          releaseReason: reason,
        });
      else
        await releaseCommittedHold(session!, target.entryId, {
          releaseReason: reason,
          ...(canScope && !all ? { roomIds: [target.roomId] } : {}),
        } as { releaseReason: string });
    },
    onSuccess: () => {
      toast.success(
        target?.kind === "BLOCK"
          ? `Room ${target.roomLabel} is back in service`
          : `Released — the house is asked again`,
      );
      onClose();
      onDone();
    },
    onError: (e) => toastRefusal(e, "The room could not be released"),
  });
  if (!target) return null;
  return (
    <ReasonDialog
      open
      danger
      onClose={onClose}
      busy={run.isPending}
      minLength={3}
      title={
        target.kind === "BLOCK"
          ? `Put room ${target.roomLabel} back in service`
          : `Release room ${target.roomLabel}`
      }
      caseLines={[
        target.kind === "BLOCK"
          ? `Out of service${target.blockedReason ? ` — ${target.blockedReason}` : ""}`
          : `Held for ${target.holder}`,
      ]}
      lead={
        target.kind === "BLOCK"
          ? "This says the room is fit to sell again. If it is not, the next guest walks into the problem the block was there to prevent."
          : "Their booking loses the room and nothing tells them automatically — someone has to. Holds also lapse on their own."
      }
      confirmLabel={target.kind === "BLOCK" ? "Put back in service" : "Release"}
      onConfirm={(r) => run.mutate(r)}
      placeholder={
        target.kind === "BLOCK"
          ? "why it is fit to sell again"
          : "why it is released — recorded on their booking"
      }
    >
      {canScope ? (
        <Choice
          options={[
            ["one", `Just room ${target.roomLabel}`],
            [
              "all",
              `All ${target.kind === "HOLD" ? target.siblings.length : 0} rooms — ${target.kind === "HOLD" ? target.siblings.join(", ") : ""}`,
            ],
          ]}
          value={all ? "all" : "one"}
          onChange={(v) => setAll(v === "all")}
        />
      ) : null}
    </ReasonDialog>
  );
}

/** The stay saved on the Inquiry step — the house card asks the house again with these figures. */

