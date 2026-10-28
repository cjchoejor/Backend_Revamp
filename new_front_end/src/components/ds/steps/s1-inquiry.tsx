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
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
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
  type RoomStatusRow,
} from "@/components/desk/workspace/room-status-table";
import { RoomSelectBoard } from "@/components/desk/workspace/room-select-board";
import { fmtDay, fmtRange, money, plural } from "@/lib/ds/format";
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
} from "./kit";
import { AddReturnStay, TripStays } from "@/components/ds/workspace/return-stay";
import { enumerateNights, useRoomSelection } from "./use-room-selection";
import { CHANNEL_OPTIONS, PartySearch, cameInAsOf, channelDef, moreRoomsNeedGuests, type ChannelKey } from "./new-inquiry-parts";
import { TheCaller, WrapUp } from "./s1-caller";
import { cleanPicks, usePickPricing, type BillNight } from "./s1-bill";
import { usePublishPriceDraft } from "@/lib/ds/stay-price";
import { Help, HelpHere } from "@/components/ds/help";
import type { PickPricing } from "@/lib/api/availability";
import { DateInput } from "@/components/ds/date-input";

/* ------------------------------------------------------------------ vocabulary */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CAME_IN_AS = [
  ["WALK_IN", "Walk-in"],
  ["DIRECT_VOICE", "Direct voice"],
  ["DIRECT_ONLINE", "Direct online"],
  ["OTA", "OTA"],
  ["AGENT", "Travel agent"],
  ["CORPORATE", "Corporation"],
  ["GROUP", "Group / MICE"],
] as const;

const KINDS_OF_STAY = [
  ["LEISURE", "Leisure"],
  ["CORPORATE", "Corporate"],
  ["GROUP", "Group"],
  ["CONFERENCE", "Conference"],
  ["APARTMENT", "Apartment"],
] as const;

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

type InquiryScalars = {
  notes?: string | null;
  sourceChannel?: string | null;
  cameInAs?: string | null;
  travelAgentId?: string | null;
  corporateAccountId?: string | null;
  ratePackageId?: string | null;
  corporateClientRef?: string | null;
  corporateCoordinator?: string | null;
};

type InquiryRecord = {
  travelAgent?: { displayName?: string | null } | null;
  corporateAccount?: { displayName?: string | null } | null;
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
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const inq = (entry.inquiry ?? {}) as InquiryScalars;
  const editable =
    !past && entry.currentStage === "S1" && entry.status === "ACTIVE";

  const inquiryQuery = useQuery({
    queryKey: ["inquiry", entry.inquiryId],
    queryFn: () => getInquiry(session!, entry.inquiryId),
    enabled: !!session && !!entry.inquiryId,
  });
  const inquiryRec = (inquiryQuery.data ?? null) as InquiryRecord | null;
  const partyName =
    inquiryRec?.travelAgent?.displayName ??
    inquiryRec?.corporateAccount?.displayName ??
    null;

  const rooms = useQuery({
    queryKey: ["rooms"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });
  // The room tool spans the canvas under the form; the house card (right column) renders into it.
  const [toolSlot, setToolSlot] = useState<HTMLElement | null>(null);

  return (
    <StepCanvas past={past}>
      {/* One column, in the order the call goes (2026-10-10): who the guest is, who is asking
          for them, what they want, what the house has and what it costs, then what is left. */}
      <div className="stack">
        <TheCaller entry={entry} editable={editable} />
        <WhoIsAsking
          entry={entry}
          inq={inq}
          partyName={partyName}
          editable={editable}
        />
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
          toolSlot={toolSlot}
        />
        {/* The room table lands here, right under the house that opens it. */}
        <div ref={setToolSlot} style={{ display: "contents" }} />
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
      <OtherWaysTabs tabs={[parkTab(parkNow, parking), declineTab(declineNow, declining, { label: "Cancel inquiry", act: "Cancel the inquiry" })]} />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ who is asking */

function WhoIsAsking({
  entry,
  inq,
  partyName,
  editable,
}: {
  entry: EntryDetail;
  inq: InquiryScalars;
  partyName: string | null;
  editable: boolean;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const came = cameInAsOf(inq.sourceChannel, inq.notes, entry.useType, inq.cameInAs);
  const setUse = useMutation({
    mutationFn: (useType: string) =>
      updateEntryIntake(session!, entry.id, {
        useType,
        expectedVersion: entry.version,
      }),
    onSuccess: () => {
      toast.success("Kind of stay recorded");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The kind of stay could not be changed"),
  });

  /* ---- what is on record ---- */
  const recParty = (entry.inquiry?.travelAgent ?? entry.inquiry?.corporateAccount ?? null) as LookupPartyMatch | null;
  const recPkg = inq.ratePackageId ?? null;
  const recRef = inq.corporateClientRef ?? "";
  const recCoord = inq.corporateCoordinator ?? "";

  /* ---- the draft (2026-10-12: edited here, in the booking — the separate edit screen is gone) ---- */
  const seed = () => ({ came, party: recParty, pkg: recPkg, ref: recRef, coord: recCoord });
  const [d, setD] = useState(seed);
  const stamp = [inq.cameInAs, inq.sourceChannel, inq.travelAgentId, inq.corporateAccountId, recPkg, recRef, recCoord].join("|");
  useEffect(() => setD(seed()), [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const def = channelDef(d.came);
  const partyKind = def?.party ?? null;
  const owner = d.party && partyKind ? (partyKind === "TRAVEL_AGENT" ? { travelAgentId: d.party.id } : { corporateAccountId: d.party.id }) : null;
  const packages = useQuery({
    queryKey: ["lookup", "rate-packages", owner],
    queryFn: () => listRatePackagesLookup(session!, owner!),
    enabled: !!session && !!owner,
  });
  // A new party starts on its own default package; the party on record keeps the package it was
  // quoted on, even one since superseded.
  useEffect(() => {
    if (!owner) return;
    if (d.party?.id === recParty?.id) return;
    const items = packages.data?.items;
    if (!items) return;
    if (d.pkg && items.some((x) => x.id === d.pkg)) return;
    setD((x) => ({ ...x, pkg: items.find((pp) => pp.isDefault)?.id ?? null }));
  }, [packages.data, owner?.travelAgentId, owner?.corporateAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickCame = (k: ChannelKey) => {
    if (k === d.came) return;
    const nextKind = channelDef(k)?.party ?? null;
    // A party belongs to one kind — a travel agent must never ride into a company booking.
    setD((x) => ({ ...x, came: k, party: nextKind && nextKind === partyKind ? x.party : null, pkg: nextKind && nextKind === partyKind ? x.pkg : null }));
  };
  const setParty = (pp: LookupPartyMatch | null) => {
    setD((x) => {
      const next = { ...x, party: pp, pkg: pp && pp.id === recParty?.id ? recPkg : null };
      // A company's contract and coordinator come with it, unless the desk has typed its own.
      if (pp && partyKind === "CORPORATE") {
        if (!x.ref.trim()) next.ref = pp.contractRefs?.[0] ?? "";
        if (!x.coord.trim()) next.coord = pp.coordinators?.[0]?.name ?? "";
      }
      return next;
    });
  };

  const isCorp = partyKind === "CORPORATE";
  const dirty =
    d.came !== came ||
    (d.party?.id ?? null) !== (recParty?.id ?? null) ||
    (d.party ? d.pkg : null) !== (recParty ? recPkg : null) ||
    (isCorp && (d.ref.trim() !== recRef || d.coord.trim() !== recCoord));
  useFlowUnsaved("asking", editable && dirty, "Changes to who is asking saved");
  const save = useMutation({
    mutationFn: () =>
      updateEntrySource(session!, entry.id, {
        cameInAs: def!.cameInAs,
        sourceChannel: def!.channel,
        travelAgentId: partyKind === "TRAVEL_AGENT" ? d.party?.id ?? null : null,
        corporateAccountId: partyKind === "CORPORATE" ? d.party?.id ?? null : null,
        ratePackageId: d.party ? d.pkg : null,
        corporateClientRef: isCorp ? d.ref.trim() || null : null,
        corporateCoordinator: isCorp ? d.coord.trim() || null : null,
      }),
    onSuccess: () => {
      toast.success("Who is asking saved");
      refresh([["inquiry", entry.inquiryId]]);
    },
    onError: (e) => toastRefusal(e, "Who is asking could not be changed"),
  });

  const pkgItems = packages.data?.items ?? [];
  const pkgOnRecordListed = !d.pkg || pkgItems.some((x) => x.id === d.pkg);
  const pkg = pkgItems.find((x) => x.id === d.pkg) ?? null;
  const pkgWord = !d.party
    ? "Published rates"
    : pkg
      ? pkg.name
      : d.pkg
        ? "a package no longer listed"
        : "the hotel's common package";
  const plans = pkg
    ? [pkg.cpRate ? "CP" : null, pkg.mapLunchRate ? "MAP + lunch" : null, pkg.mapDinnerRate ? "MAP + dinner" : null, pkg.apRate ? "AP" : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  const cameWord = CAME_IN_AS.find(([k]) => k === came)?.[1] ?? "—";
  const kindWord = KINDS_OF_STAY.find(([k]) => k === entry.useType)?.[1] ?? null;
  const recPkgWord = recParty ? (recPkg ? (pkgItems.find((x) => x.id === recPkg)?.name ?? "their package") : "their default package") : "Published rates";
  const saveBlock = !def ? "say how the booking came in" : !dirty ? "nothing changed" : null;

  return (
    <StepCard
      title="Who is asking"
      flow="asking"
      flowAfter="caller"
      summary={
        <>
          <b>{cameWord}</b>
          {partyName ? <> — {partyName}</> : null} · {recPkgWord}
          {kindWord ? <> · {kindWord}</> : <span className="warn-ink"> · the kind of stay is not set</span>}
        </>
      }
    >
      <div className="form2">
        <div className="wide field">
          <label>
            Came in as
            <Help label="About Came in as">It decides what the rest of this section asks for.</Help>
          </label>
          <Choice options={CHANNEL_OPTIONS} value={d.came} disabled={!editable || save.isPending} onChange={pickCame} />
        </div>
        {partyKind ? (
          editable ? (
            <PartySearch kind={partyKind} party={d.party} setParty={setParty} />
          ) : (
            <div className="wide field">
              <label>{partyKind === "CORPORATE" ? "Company" : "Travel agent"}</label>
              <input className="input" readOnly value={partyName ?? ""} placeholder="none on file" />
            </div>
          )
        ) : null}
        {isCorp ? (
          <>
            <div className="field">
              <label>Their PO or authorisation</label>
              <input
                className="input"
                readOnly={!editable}
                value={d.ref}
                maxLength={200}
                placeholder="none given"
                onChange={(e) => setD((x) => ({ ...x, ref: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Their coordinator</label>
              <input
                className="input"
                readOnly={!editable}
                value={d.coord}
                maxLength={200}
                placeholder="none given"
                onChange={(e) => setD((x) => ({ ...x, coord: e.target.value }))}
              />
            </div>
          </>
        ) : null}
        <div className="field">
          <label>
            Rate package
            <Help label="About the rate package">
              {d.party ? "The party's own rates — the room and the meal plans." : "A walk-in is priced from the house's published rates."}
            </Help>
          </label>
          {editable && d.party && pkgItems.length ? (
            <select className="input" value={d.pkg ?? ""} onChange={(e) => setD((x) => ({ ...x, pkg: e.target.value || null }))}>
              {pkgOnRecordListed ? null : <option value={d.pkg ?? ""}>a package no longer listed (on record)</option>}
              <option value="">the hotel&rsquo;s common package</option>
              {pkgItems.map((pp) => (
                <option key={pp.id} value={pp.id}>
                  {pp.name}
                  {pp.isDefault ? " · their default" : ""}
                </option>
              ))}
            </select>
          ) : (
            <input className="input" readOnly value={pkgWord} />
          )}
        </div>
        <div className="field">
          <label>
            Meal plans priced
            <Help label="About meal plans">Each room&rsquo;s plan is chosen at Negotiation.</Help>
          </label>
          <input className="input" readOnly value={plans || (d.party ? "none in the package" : "from the house tariff")} />
        </div>
        <div className="wide field">
          <label>
            What kind of stay
            {editable ? <Help label="About the kind of stay">Saved as soon as it is picked.</Help> : null}
          </label>
          <Choice
            options={KINDS_OF_STAY}
            value={entry.useType as (typeof KINDS_OF_STAY)[number][0] | null}
            disabled={!editable || setUse.isPending}
            onChange={(v) => v !== entry.useType && setUse.mutate(v)}
          />
        </div>
      </div>
      {editable ? (
        <div className="row-acts" style={{ marginTop: 10, alignItems: "center" }}>
          {dirty ? (
            <span className="warn-ink sm">
              <b>Changed — save it, or the booking keeps what was recorded</b>
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {dirty ? (
            <Button kind="quiet" compact onClick={() => setD(seed())}>
              Put it back
            </Button>
          ) : null}
          <Button className="go" state={save.isPending ? "working" : saveBlock ? "inert" : "default"} reason={saveBlock ?? undefined} workingLabel="Saving…" onClick={() => save.mutate()}>
            Save who is asking
          </Button>
        </div>
      ) : null}
    </StepCard>
  );
}


/* ------------------------------------------------------------------ the stay */

type Catalog = Awaited<ReturnType<typeof listRooms>>["items"];

function TheStay({
  entry,
  editable,
  catalog,
}: {
  entry: EntryDetail;
  editable: boolean;
  catalog: Catalog;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
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
  // The room counts the party allows, as the new inquiry offers them (2026-10-27, operator: "the
  // rooms no longer give a dropdown like before"). The booking's own count stays on the list even
  // when it falls outside, so a stored figure is never silently changed.
  const range = env?.allowedRoomCounts ?? null;
  const roomOptions = useMemo(() => {
    const out = range && range.min > 0 && range.max >= range.min ? Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i) : [];
    if (!out.includes(roomsN)) out.push(roomsN);
    return out.sort((a, b) => a - b);
  }, [range?.min, range?.max, roomsN]); // eslint-disable-line react-hooks/exhaustive-deps
  // The next counts are listed shut, saying what they need (2026-10-28, operator: "I changed to 2
  // rooms, but I can only select one room" — one adult allows one room, and the list said nothing).
  const shutRoomOptions = range
    ? moreRoomsNeedGuests(range.max, env?.hotelRoomCount ?? null, (policy.data?.ageBands.childMaxAge ?? 10) + 1).filter((o) => !roomOptions.includes(o.n))
    : [];

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
  // A party changed here can make the room count impossible — snap it to the first count allowed,
  // as the new inquiry does. Only after the desk changed the party: a stored count is left alone.
  const partyEdited = f.adults !== saved.adults || String(childN) !== saved.children || ages.join(",") !== saved.ages.join(",");
  useEffect(() => {
    if (!range || !partyEdited) return;
    if (roomsN < range.min || roomsN > range.max) set({ rooms: String(range.min) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.min, range?.max, partyEdited]);
  const dirty =
    f.checkIn !== saved.checkIn ||
    f.nights !== saved.nights ||
    f.rooms !== saved.rooms ||
    f.adults !== saved.adults ||
    String(childN) !== saved.children ||
    ages.join(",") !== saved.ages.join(",") ||
    JSON.stringify(bedMap) !== JSON.stringify(savedBedMap);
  useFlowUnsaved("stay", editable && dirty, "Changes to the stay saved");

  const save = useMutation({
    mutationFn: () =>
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
      }),
    onSuccess: () => {
      toast.success("The stay is updated — the house is asked again for these dates");
      refresh();
      // The house is asked again by itself (2026-10-27, operator: "when I make edits to the stay
      // and click Done, can it ask the house directly, so we can remove the Ask again button").
      // The saved figures ride on the event, since the entry on screen is still the old one.
      if (f.checkIn && checkOut)
        window.dispatchEvent(
          new CustomEvent(STAY_SAVED_EVENT, {
            detail: { entryId: entry.id, checkInDate: f.checkIn, checkOutDate: checkOut, guestCount: adultsN + childN },
          }),
        );
      // Done saved it; the work moves on to the house, which is being asked again for the stay as
      // it is now (2026-10-27, operator: "it took me to Wrap up, when it should ask the house again
      // and take me to the house section").
      flowDone("stay", { next: "house" });
    },
    onError: (e) => toastRefusal(e, "The stay could not be updated"),
  });

  const { done: flowDone } = useStepFlow();
  const invalid = !f.checkIn ? "put in the check-in date" : childN > 0 && !agesOk ? "put in every child's age" : null;
  const cp = policy.data;
  const young = cp?.ageBands.youngChildMaxAge ?? 5;
  const childMax = cp?.ageBands.childMaxAge ?? 10;
  const minAdult = cp?.unaccompaniedMinor.minimumAge ?? 18;
  const ro = !editable;
  const group = entry.groupBillingMode === "GROUP_MASTER";

  return (
    <StepCard
      flow="stay"
      flowAfter="caller"
      title="The stay"
      // One Done (2026-10-27, operator: "remove Save the stay and merge it with Done, and bring
      // Undo beside Done"): with a change on the stay, Done saves it and moves on; Undo puts the
      // fields back. Without a change, the card's own Done simply folds it.
      doneAction={
        editable && dirty
          ? {
              label: "Done",
              state: save.isPending ? "working" : invalid ? "inert" : "default",
              title: invalid ?? undefined,
              workingLabel: "Saving…",
              note: <span className="warn-ink">Changed — Done saves it</span>,
              extra: (
                <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={() => setF(seed())}>
                  Undo
                </Button>
              ),
              onClick: () => save.mutate(),
            }
          : undefined
      }
      summary={
        <>
          <b>{entry.checkInDate ? fmtRange(entry.checkInDate, entry.checkOutDate) : "no dates"}</b>
          {saved.checkIn ? <> · {plural(parseInt(saved.nights, 10) || 1, "night")}</> : null} ·{" "}
          {plural(parseInt(saved.adults, 10) || 0, "adult")}
          {(parseInt(saved.children, 10) || 0) > 0
            ? <>, {plural(parseInt(saved.children, 10) || 0, "child", "children")}{saved.ages.length ? ` (${saved.ages.join(", ")})` : ""}</>
            : null}{" "}
          · {plural(parseInt(saved.rooms, 10) || 1, "room")}
          {Object.keys(savedBedMap).length
            ? <> · {Object.entries(savedBedMap).map(([t, n]) => `${n} ${BED_WORD[t] ?? words(t)}`).join(" + ")} asked</>
            : null}
        </>
      }
    >
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
        <div className="field">
          <label>
            Rooms
            <Help label="About the room count">
              {env
                ? `A count — at least ${env.allowedRoomCounts.min}, at most ${env.allowedRoomCounts.max} for ${plural(env.chargeableOccupants, "chargeable guest")}. The room type is ours to pick.`
                : "A count — the room type is ours to pick."}
            </Help>
          </label>
          <select className="input" value={String(roomsN)} disabled={ro} onChange={(e) => set({ rooms: e.target.value })}>
            {roomOptions.map((n) => (
              <option key={n} value={String(n)}>
                {plural(n, "room")}
                {range && n < range.min ? " · too few" : range && n > range.max ? " · more than the guests" : ""}
              </option>
            ))}
            {shutRoomOptions.map((o) => (
              <option key={o.n} value={String(o.n)} disabled>
                {o.label}
              </option>
            ))}
          </select>
          {env && (env.exceedsHotelCapacity || roomsN < env.allowedRoomCounts.min) ? (
            <span className="hint warn-ink">
              {env.exceedsHotelCapacity
                ? `${plural(env.chargeableOccupants, "chargeable guest")} — more than the hotel can sleep`
                : `at least ${plural(env.allowedRoomCounts.min, "room")} for ${plural(env.chargeableOccupants, "chargeable guest")}`}
            </span>
          ) : null}
        </div>
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
          <AddReturnStay entry={entry} />
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
  toolSlot,
}: {
  entry: EntryDetail;
  past: boolean;
  editable: boolean;
  duplicates: number;
  catalog: Catalog;
  toolSlot: HTMLElement | null;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const flow = useStepFlow();
  const openWay = useOpenOtherWay();
  const isGm = atLeast(session?.actorLevel, "L3");

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
    mutationFn: (body: {
      perNight?: Array<{ date: string; roomIds: string[] }>;
      roomIds?: string[];
      allIds: string[];
    }) => {
      if (!configId) throw new Error("Ask the house first");
      const deficientIds = body.allIds.filter(
        (id) => rows.find((r) => r.roomId === id)?.bucket === "deficient",
      );
      return selectAvailabilityOption(session!, configId, {
        roomIds: body.perNight ? undefined : body.roomIds,
        perNight: body.perNight,
        deficientAcknowledgements: deficientIds.length
          ? deficientIds.map((roomId) => ({
              roomId,
              acknowledgedAt: new Date().toISOString(),
              note: "Acknowledged when the rooms were chosen at Inquiry",
            }))
          : undefined,
      });
    },
    onSuccess: async () => {
      toast.success("The rooms are chosen and on record");
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
  const picked: BillNight[] = sel.allPicked.length
    ? displayNights
        .filter((d) => stayNightSet.has(d))
        .map((date) => ({ date, roomIds: sel.effectiveByNight[date] ?? [] }))
    : [];
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
  const pickedSaved = sel.savedCanon != null && sel.savedCanon === sel.currentCanon;
  // Picks changed and not saved: the house does not read as done (2026-10-27).
  useFlowUnsaved("house", editable && !past && sel.currentCanon !== sel.savedCanon, "The rooms picked saved");
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
  usePublishPriceDraft(entry.id, editable ? { kind: "PICKS", perNight: picked, saved: pickedSaved } : null);
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
    if (hasResults || savedOption || !entry.checkInDate || !entry.checkOutDate) {
      arrivalRead.current = true;
      clearAddress();
      return;
    }
    // Started once the effect has settled — see the chart's ask above.
    const t = setTimeout(() => {
      arrivalRead.current = true;
      ask.mutate();
      clearAddress();
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

  const [toolOpen, setToolOpen] = useState(false);
  const toolRef = useRef<HTMLDivElement | null>(null);
  const openTool = () => {
    setToolOpen(true);
    requestAnimationFrame(() =>
      toolRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  const variedSaved =
    !!savedOption && "perNight" in savedOption && sel.nightsDiffer;
  const showTool = hasResults && !past && (toolOpen || variedSaved);

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

  const range = fmtRange(
    searched.checkIn ?? entry.checkInDate,
    searched.checkOut ?? entry.checkOutDate,
  );
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
        title={
          <>
            {hasResults || entry.checkInDate ? `The house · ${range}` : "The house"}
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
                <Button
                  kind="secondary"
                  compact
                  state="inert"
                  title="Not possible yet — to offer other dates or rooms, change the stay above and ask the house again"
                >
                  Offer what we have
                </Button>
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
          <>
            {chartNote ? (
              <p className={`chart-from${chartNote.ok ? "" : " warn"}`} role="status">
                {chartNote.text}
              </p>
            ) : null}
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
            {bill.pricing ? (
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
                Room{savedNumbers.length === 1 ? "" : "s"}{" "}
                {savedNumbers.join(", ")}
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
                <Button kind="quiet" compact onClick={openTool}>
                  Choose the rooms…
                </Button>
              </div>
            ) : null}
          </>
        )}
      </StepCard>

      {showTool && toolSlot
        ? createPortal(
            <div ref={toolRef} onPointerDownCapture={markHandPick} onClickCapture={markHandPick} onKeyDownCapture={markHandPick}>
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
                onClose={() => setToolOpen(false)}
                onReleased={() => ask.mutate()}
              />
            </div>,
            toolSlot,
          )
        : null}
    </>
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
}) {
  const [view, setView] = useState<"table" | "board">("table");
  const [names, setNames] = useState(false);
  const [full, setFull] = useState(false);
  const [release, setRelease] = useState<ReleaseTarget | null>(null);
  const canBoard =
    (entry.adultCount ?? 0) > 0 || (entry.childAges ?? []).length > 0;
  const board = view === "board" && canBoard;
  const boardBase = useRef<string[]>([]);
  const boardEcho = useRef(false);
  useEffect(() => {
    if (board) boardEcho.current = true;
  }, [board]);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [full]);

  const capacity = useMemo(
    () =>
      new Map(
        catalog
          .map((r) => [
            r.id,
            r.roomType?.maxCapacity ?? r.roomType?.standardCapacity ?? 0,
          ])
          .filter(([, c]) => (c as number) > 0) as Array<[string, number]>,
      ),
    [catalog],
  );
  const maxChildren = useMemo(
    () =>
      new Map(
        catalog
          .filter((r) => typeof r.roomType?.maxChildren === "number")
          .map((r) => [r.id, r.roomType!.maxChildren!]),
      ),
    [catalog],
  );

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

  const body = (
    <StepCard
      title={`Which rooms · ${plural(numberOfRooms, "room")} for ${plural(displayNights.length, "night")}`}
      right={
        <>
          {canBoard ? (
            <Choice
              options={[
                ["table", "Rooms by night"],
                ["board", "Place the guests"],
              ]}
              value={board ? "board" : "table"}
              onChange={setView}
            />
          ) : null}
          {!board ? (
            <Button
              kind="quiet"
              compact
              icon="person"
              aria-pressed={names}
              onClick={() => setNames((v) => !v)}
            >
              {names ? "Names shown" : "Show names"}
            </Button>
          ) : null}
          <Button kind="quiet" compact onClick={() => setFull((v) => !v)}>
            {full ? "Close the full view" : "Full screen"}
          </Button>
          {!full ? (
            <Button kind="quiet" compact icon="x" onClick={onClose}>
              Hide
            </Button>
          ) : null}
        </>
      }
    >
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
        {board ? (
          <RoomSelectBoard
            rows={rows}
            nights={displayNights}
            perDate={perDate}
            entryAdults={entry.adultCount}
            entryChildAges={entry.childAges}
            maxRooms={numberOfRooms}
            selectedRoomIds={sel.base}
            initialPerNight={sel.effectiveByNight}
            onSelectionChange={(ids) => {
              boardBase.current = ids;
              sel.setBase(ids);
            }}
            onPerNightChange={(pn, diffs) => {
              const b = boardBase.current;
              if (diffs) {
                boardEcho.current = false;
                sel.setOverrides(
                  Object.fromEntries(
                    pn
                      .filter((p) => !sel.sameSet(p.roomIds, b))
                      .map((p) => [p.date, p.roomIds]),
                  ),
                );
              } else if (boardEcho.current) {
                boardEcho.current = false;
              } else sel.setOverrides({});
            }}
            capacityByRoomId={capacity}
            maxChildrenByRoomId={maxChildren}
            capacitiesReady={catalog.length > 0}
            disabled={saving}
          />
        ) : (
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
        )}
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
const STAY_SAVED_EVENT = "desk:stay-saved";
type StaySaved = { checkInDate: string; checkOutDate: string; guestCount?: number | null };
