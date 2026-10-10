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
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  updateInquiryNotes,
} from "@/lib/api/inquiries";
import { addGuestContact } from "@/lib/api/guest-profiles";
import { checkBedRequest, listRooms, releaseRoomBlock } from "@/lib/api/rooms";
import { releaseCommittedHold } from "@/lib/api/reservation-setup";
import { releaseSpeculativeHold } from "@/lib/api/quotations";
import {
  RoomStatusTable,
  roomStatusRows,
  type RoomStatusRow,
} from "@/components/desk/workspace/room-status-table";
import { RoomSelectBoard } from "@/components/desk/workspace/room-select-board";
import { fmtRange, money, plural } from "@/lib/ds/format";
import { currentPassConfigs, hasAnyContact } from "@/lib/desk/workspace";
import {
  optionSelectedRoomIds,
  type AvailabilityOptionSelected,
  type EntryDetail,
} from "@/types/api";
import {
  Choice,
  Live,
  OtherWays,
  ReasonDialog,
  RequestsCard,
  SeeRow,
  StepCanvas,
  StepCard,
  Tool,
  atLeast,
  toastRefusal,
  useRefreshEntry,
  useStepFlow,
  words,
} from "./kit";
import { AddReturnStay, TripStays } from "@/components/ds/workspace/return-stay";
import { enumerateNights, useRoomSelection } from "./use-room-selection";
import { PHONE_CODES, PhoneInput, cameInAsOf } from "./new-inquiry-parts";
import { PickBill, PickTotalLine, usePickPricing, type BillNight } from "./s1-bill";
import type { PickPricing } from "@/lib/api/availability";

/* ------------------------------------------------------------------ vocabulary */

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

type EntryContact = {
  contactPersonName?: string | null;
  contactPersonPhone?: string | null;
  contactPersonEmail?: string | null;
};

/* ------------------------------------------------------------------ the step */

export function S1Inquiry({
  entry,
  past,
  onPark,
  onDecline,
}: {
  entry: EntryDetail;
  past: boolean;
  onPark?: () => void;
  /** The guest said no (2026-10-01) — offered while the booking can still be turned down. */
  onDecline?: () => void;
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
        <TheGuest entry={entry} />
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
          inq={inq}
          editable={editable}
          onSaved={() => refresh([["inquiry", entry.inquiryId]])}
        />
      </div>
      <RequestsCard />
      <OtherWays>
        {onPark && entry.status === "ACTIVE" ? (
          <SeeRow
            key="park"
            label="Park…"
            note="a reason; the booking waits where it is, its expiry paused, until it is resumed — a long park lapses on its own"
            onClick={onPark}
          />
        ) : null}
        {/* The answer the house had no way to write down (2026-10-01): until this, a lead that
            said no could only be parked or left to lapse as "Expired", which reads the same as
            an enquiry nobody ever answered. */}
        {onDecline ? (
          <SeeRow
            key="decline"
            label="The guest said no…"
            note="ends the booking and records why; the rooms go back on the board and nothing is charged"
            onClick={onDecline}
          />
        ) : null}
      </OtherWays>
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
  const isAcct = came === "AGENT" || came === "CORPORATE" || came === "OTA";
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
  // Which of the party's rates was agreed sits with the party (moved here from "Rate and notes",
  // as on the intake since 2026-09-29).
  const owner = inq.travelAgentId
    ? { travelAgentId: inq.travelAgentId }
    : inq.corporateAccountId
      ? { corporateAccountId: inq.corporateAccountId }
      : null;
  const packages = useQuery({
    queryKey: ["lookup", "rate-packages", owner],
    queryFn: () => listRatePackagesLookup(session!, owner!),
    enabled: !!session && !!owner,
  });
  const pkg =
    (packages.data?.items ?? []).find((p) => p.id === inq.ratePackageId) ??
    (inq.ratePackageId
      ? null
      : ((packages.data?.items ?? []).find((p) => p.isDefault) ?? null));
  const pkgWord = !owner
    ? "Published rates"
    : pkg
      ? `${pkg.name}${inq.ratePackageId ? "" : " · their default"}`
      : inq.ratePackageId
        ? "a package no longer listed"
        : "the hotel's common package";
  const plans = pkg
    ? [
        pkg.cpRate ? "CP" : null,
        pkg.mapLunchRate ? "MAP + lunch" : null,
        pkg.mapDinnerRate ? "MAP + dinner" : null,
        pkg.apRate ? "AP" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const cameWord = CAME_IN_AS.find(([k]) => k === came)?.[1] ?? "—";
  const kindWord = KINDS_OF_STAY.find(([k]) => k === entry.useType)?.[1] ?? null;
  return (
    <StepCard
      title="Who is asking"
      flow="asking"
      flowAfter="guest"
      summary={
        <>
          <b>{cameWord}</b>
          {isAcct && partyName ? <> — {partyName}</> : null} · {pkgWord}
          {kindWord ? <> · {kindWord}</> : <span className="warn-ink"> · the kind of stay is not set</span>}
        </>
      }
      right={
        editable ? (
          <Link
            className="btn btn-quiet compact"
            href={`/bookings/new?edit=${entry.id}`}
          >
            <Icon name="pen" /> Edit the intake
          </Link>
        ) : null
      }
    >
      <div className="form2">
        <div className="wide field">
          <label>Came in as</label>
          <Choice options={CAME_IN_AS} value={came} disabled />
          <span className="hint">set when the inquiry was recorded</span>
        </div>
        {isAcct ? (
          <>
            <div className="field">
              <label>
                {came === "CORPORATE"
                  ? "Company"
                  : came === "OTA"
                    ? "OTA"
                    : "Travel agent"}
              </label>
              <input
                className="input"
                readOnly
                value={partyName ?? ""}
                placeholder="none on file"
              />
            </div>
            <div className="field">
              <label>
                {came === "CORPORATE"
                  ? "Their PO or authorisation"
                  : "Their reference"}
              </label>
              <input
                className="input"
                readOnly
                value={inq.corporateClientRef ?? ""}
                placeholder="none given"
              />
            </div>
            {came === "CORPORATE" ? (
              <div className="field">
                <label>Their coordinator</label>
                <input
                  className="input"
                  readOnly
                  value={inq.corporateCoordinator ?? ""}
                  placeholder="none given"
                />
              </div>
            ) : null}
          </>
        ) : null}
        <div className="field">
          <label>Rate package</label>
          <input className="input" readOnly value={pkgWord} />
          <span className="hint">carries the meal plan and the rate</span>
        </div>
        <div className="field">
          <label>Meal plans priced</label>
          <input
            className="input"
            readOnly
            value={
              plans || (owner ? "none in the package" : "from the house tariff")
            }
          />
          <span className="hint">
            each room&rsquo;s plan is chosen at Negotiation
          </span>
        </div>
        <div className="wide field">
          <label>What kind of stay</label>
          <Choice
            options={KINDS_OF_STAY}
            value={entry.useType as (typeof KINDS_OF_STAY)[number][0] | null}
            disabled={!editable || setUse.isPending}
            onChange={(v) => v !== entry.useType && setUse.mutate(v)}
          />
        </div>
      </div>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the guest */

function TheGuest({ entry }: { entry: EntryDetail }) {
  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const name = `${g?.firstName ?? ""} ${g?.lastName ?? ""}`.trim();
  const reach = [g?.phone, g?.email].filter(Boolean).join(" · ");
  return (
    <StepCard
      flow="guest"
      title="The guest"
      summary={
        <>
          <b>{name || "—"}</b>
          {g?.nationality ? <> · {g.nationality}</> : null} ·{" "}
          {reach || <span className="meta">no phone or email yet — asked at Wrap up</span>}
        </>
      }
    >
      <div className="form2">
        <div className="field">
          <label>Phone</label>
          <input
            className="input"
            readOnly
            value={g?.phone ?? ""}
            placeholder="not given — asked at Wrap up"
          />
        </div>
        <div className="field">
          <label>Email</label>
          <input
            className="input"
            readOnly
            value={g?.email ?? ""}
            placeholder="not given — asked at Wrap up"
          />
        </div>
        <div className="field">
          <label>First name</label>
          <input className="input" readOnly value={g?.firstName ?? ""} />
        </div>
        <div className="field">
          <label>Last name</label>
          <input className="input" readOnly value={g?.lastName ?? ""} />
        </div>
        <div className="field">
          <label>Nationality</label>
          <input className="input" readOnly value={g?.nationality ?? ""} />
        </div>
        <div className="field">
          <label>Guest record</label>
          <span className="sm" style={{ paddingTop: 8 }}>
            {g?.id ? (
              <Link href={`/guests/${g.id}`}>
                Open the guest&rsquo;s record
              </Link>
            ) : (
              <span className="dash">—</span>
            )}
          </span>
        </div>
      </div>
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
  const dirty =
    f.checkIn !== saved.checkIn ||
    f.nights !== saved.nights ||
    f.rooms !== saved.rooms ||
    f.adults !== saved.adults ||
    String(childN) !== saved.children ||
    ages.join(",") !== saved.ages.join(",") ||
    JSON.stringify(bedMap) !== JSON.stringify(savedBedMap);

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
      toast.success(
        "The stay is updated — ask the house again for these dates",
      );
      refresh();
    },
    onError: (e) => toastRefusal(e, "The stay could not be updated"),
  });

  const cp = policy.data;
  const young = cp?.ageBands.youngChildMaxAge ?? 5;
  const childMax = cp?.ageBands.childMaxAge ?? 10;
  const minAdult = cp?.unaccompaniedMinor.minimumAge ?? 18;
  const ro = !editable;
  const group = entry.groupBillingMode === "GROUP_MASTER";

  return (
    <StepCard
      flow="stay"
      flowAfter="guest"
      title="The stay"
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
          <input
            className="input"
            type="date"
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
          <input
            className="input"
            type="date"
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
          <label>Rooms</label>
          <input
            className="input"
            inputMode="numeric"
            value={f.rooms}
            readOnly={ro}
            onChange={(e) => set({ rooms: e.target.value.replace(/\D/g, "") })}
          />
          <span
            className={`hint${env && roomsN < env.allowedRoomCounts.min ? " warn-ink" : ""}`}
          >
            {env
              ? env.exceedsHotelCapacity
                ? `${plural(env.chargeableOccupants, "chargeable guest")} — more than the hotel can sleep`
                : `a count · at least ${env.allowedRoomCounts.min}, at most ${env.allowedRoomCounts.max} for ${plural(env.chargeableOccupants, "chargeable guest")}`
              : "a count · the category is ours to pick"}
          </span>
        </div>
        {childN > 0 ? (
          <div className="wide field">
            <label>Their age{childN === 1 ? "" : "s"}</label>
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
            <span
              className={`hint${agesNum.some((n) => n > childMax) ? " warn-ink" : ""}`}
            >
              the age decides the bed and the rate · under {young + 1} free ·{" "}
              {young + 1}–{childMax} at the child rate · {childMax + 1}–
              {minAdult - 1} charged as adults
              {agesNum.some((n) => n > childMax)
                ? ` — ${ages
                    .map((x, i) =>
                      Number(x) > childMax ? `child ${i + 1}` : null,
                    )
                    .filter(Boolean)
                    .join(", ")} at the adult rate`
                : ""}
            </span>
          </div>
        ) : null}
        {bedTypes.length ? (
          <div className="wide field">
            <label>Beds asked for · optional</label>
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
            <span className="hint">
              a tally — which room is which is settled on the table at Negotiation; here the house
              secures enough rooms that can take them
            </span>
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
            title="Separate bills for each guest are not in the backend yet"
          >
            One bill each
          </Button>
          <AddReturnStay entry={entry} />
        </Live>
      </div>
      {editable && dirty ? (
        <div className="row-acts" style={{ marginTop: 12 }}>
          <Button
            state={
              save.isPending
                ? "working"
                : !f.checkIn || (childN > 0 && !agesOk)
                  ? "inert"
                  : "default"
            }
            title={
              !f.checkIn
                ? "put in the check-in date"
                : childN > 0 && !agesOk
                  ? "put in every child's age"
                  : undefined
            }
            workingLabel="Saving…"
            onClick={() => save.mutate()}
          >
            Save the stay
          </Button>
          <Button kind="quiet" onClick={() => setF(seed())}>
            Undo
          </Button>
          <span className="meta">the house is asked again after a change</span>
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ wrap up */

/**
 * Wrap up (2026-10-10, operator, after the boss's journey mockup: "while inquiring the guest
 * doesn't always give our number or emails, but if they're booking and rooms are selected we
 * have to ask them"). Once the rooms are chosen the desk asks for what was not given at the
 * start — the guest's phone or email (filled on the guest's record, never replacing one there),
 * who is arriving and their phone, and any notes. The section is done when the booking has a
 * way to reach someone, the same test the move to Negotiation runs (Policy 16).
 */
function WrapUp({
  entry,
  inq,
  editable,
  onSaved,
}: {
  entry: EntryDetail;
  inq: InquiryScalars;
  editable: boolean;
  onSaved: () => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const contact = entry as EntryDetail & EntryContact;
  const hasPhone = !!g?.phone?.trim();
  const hasEmail = !!g?.email?.trim();

  const [phoneCode, setPhoneCode] = useState(PHONE_CODES[0]);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState(contact.contactPersonName ?? "");
  const [phone, setPhone] = useState(contact.contactPersonPhone ?? "");
  const [notes, setNotes] = useState(inq.notes ?? "");
  useEffect(() => {
    setName(contact.contactPersonName ?? "");
    setPhone(contact.contactPersonPhone ?? "");
  }, [contact.contactPersonName, contact.contactPersonPhone]);
  useEffect(() => setNotes(inq.notes ?? ""), [inq.notes]);

  const guestPhone = !hasPhone && phoneNumber.trim() ? `${phoneCode}${phoneNumber.trim()}` : "";
  const guestEmail = !hasEmail ? email.trim() : "";
  const emailBad = guestEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail);
  const arrivingDirty =
    name.trim() !== (contact.contactPersonName ?? "") ||
    phone.trim() !== (contact.contactPersonPhone ?? "");
  const notesDirty = notes.trim() !== (inq.notes ?? "").trim();
  const dirty = !!guestPhone || !!guestEmail || arrivingDirty || notesDirty;

  const save = useMutation({
    mutationFn: async () => {
      const done: string[] = [];
      if ((guestPhone || guestEmail) && g?.id) {
        const r = await addGuestContact(session!, g.id, {
          phone: guestPhone || undefined,
          email: guestEmail || undefined,
          entryId: entry.id,
        });
        if (r.added.includes("phone")) done.push("the guest's phone");
        if (r.added.includes("email")) done.push("the guest's email");
      }
      if (arrivingDirty) {
        await updateEntryIntake(session!, entry.id, {
          contactPersonName: name.trim(),
          contactPersonPhone: phone.trim(),
          expectedVersion: entry.version,
        });
        done.push("who is arriving");
      }
      if (notesDirty) {
        await updateInquiryNotes(session!, entry.inquiryId, notes.trim());
        done.push("the notes");
      }
      return done;
    },
    onSuccess: (done) => {
      toast.success(done.length ? `On record: ${done.join(", ")}` : "Nothing to save");
      setPhoneNumber("");
      setEmail("");
      refresh();
      onSaved();
    },
    onError: (e) => {
      toastRefusal(e, "Wrap up could not be saved");
      refresh();
      onSaved();
    },
  });

  // the same test the move to Negotiation runs (Policy 16): the guest's email or phone, or the arriving person's phone
  const reachable = hasAnyContact(entry);
  return (
    <StepCard
      flow="wrap"
      flowAfter="house"
      flowAfterOnly
      title="Wrap up"
      meta="Before the quote goes out — ask for what was not given at the start."
    >
      <div className="form2">
        <div className="field">
          <label>Guest&rsquo;s phone</label>
          {hasPhone ? (
            <input className="input" readOnly value={g?.phone ?? ""} />
          ) : (
            <PhoneInput
              code={phoneCode}
              setCode={setPhoneCode}
              number={phoneNumber}
              setNumber={setPhoneNumber}
              ariaLabel="Guest's phone"
            />
          )}
          <span className="hint">
            {hasPhone ? "on the guest's record" : "not given at the start — ask for it now"}
          </span>
        </div>
        <div className="field">
          <label>Guest&rsquo;s email</label>
          <input
            className={`input${emailBad ? " invalid" : ""}`}
            type="email"
            readOnly={hasEmail || !editable}
            value={hasEmail ? (g?.email ?? "") : email}
            placeholder="name@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
          <span className={`hint${emailBad ? " stop-ink" : ""}`}>
            {hasEmail
              ? "on the guest's record — the quote can go here"
              : emailBad
                ? "that does not read as an email address"
                : "where the quote and the confirmation go"}
          </span>
        </div>
        <div className="field">
          <label>Who is arriving · name</label>
          <input
            className="input"
            value={name}
            readOnly={!editable}
            placeholder="who leads the party on the day"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Their phone</label>
          <input
            className="input"
            value={phone}
            readOnly={!editable}
            placeholder="+975 …"
            onChange={(e) => setPhone(e.target.value)}
          />
          <span className="hint">needed before arrival</span>
        </div>
        <div className="wide field">
          <label>Notes</label>
          <textarea
            className="input"
            rows={2}
            value={notes}
            readOnly={!editable}
            placeholder="anything the guest asked for"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>
      <div className={`sm ${reachable ? "ok-ink" : "stop-ink"}`} style={{ marginTop: 8, fontWeight: 600 }}>
        {reachable
          ? "The booking has a way to reach someone."
          : "Nobody can be reached yet — the guest's phone or email, or the arriving person's phone, before Negotiation."}
      </div>
      {editable && dirty ? (
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button
            compact
            state={save.isPending ? "working" : emailBad ? "inert" : "default"}
            title={emailBad ? "the email does not read as one" : undefined}
            workingLabel="Saving…"
            onClick={() => save.mutate()}
          >
            Save wrap up
          </Button>
          <Button
            kind="quiet"
            compact
            onClick={() => {
              setPhoneNumber("");
              setEmail("");
              setName(contact.contactPersonName ?? "");
              setPhone(contact.contactPersonPhone ?? "");
              setNotes(inq.notes ?? "");
            }}
          >
            Undo
          </Button>
        </div>
      ) : null}
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

  const savedIds = optionSelectedRoomIds(savedOption);
  const savedTypes = [
    ...new Set(
      savedIds
        .map((id) => rows.find((r) => r.roomId === id)?.roomTypeName)
        .filter(Boolean),
    ),
  ];
  const [pickedType, setPickedType] = useState<string | null>(null);
  const chosenType =
    pickedType ??
    (savedTypes.length === 1
      ? savedTypes[0]!
      : (byType.find((t) => t.full.length >= numberOfRooms)?.name ?? null));
  const chosenRow = byType.find((t) => t.name === chosenType) ?? null;
  // The MARKED type's own indicative figure (2026-09-19): every room carries its type's chip, while
  // the search-wide one is a single plan's rate — it read the same for a Suite and a Standard Single.
  const chosenPricing = useMemo(() => {
    if (!chosenType) return pricing;
    const room = [...available, ...deficient].find((r) => r.roomTypeName === chosenType);
    return readPricing(room?.pricingIndicative) ?? pricing;
  }, [chosenType, available, deficient, pricing]);

  const ask = useMutation({
    mutationFn: async () => {
      const ci = entry.checkInDate?.slice(0, 10);
      const co = entry.checkOutDate?.slice(0, 10);
      if (!ci || !co)
        throw new Error("Put in the check-in and check-out first");
      return queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: ci,
        checkOutDate: co,
        guestCount: entry.guestCount ?? undefined,
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
    onSuccess: () => {
      toast.success("The rooms are chosen and on record");
      refresh();
      // The rooms are chosen: the work moves on to Wrap up, the bill staying in view.
      if (flow.on) flow.done("house", { reveal: false });
    },
    onError: (e) => toastRefusal(e, "The rooms could not be recorded"),
  });

  // The bill (2026-10-10): what the rooms on the table cost, night by night and for the stay —
  // the picks as they stand, saved or not; with none, what Take it would hold.
  const stayNightSet = useMemo(() => new Set(stayNights), [stayNights]);
  const picked: BillNight[] = sel.allPicked.length
    ? displayNights
        .filter((d) => stayNightSet.has(d))
        .map((date) => ({ date, roomIds: sel.effectiveByNight[date] ?? [] }))
    : [];
  const candidate: BillNight[] =
    !picked.length && chosenRow && chosenRow.full.length >= numberOfRooms
      ? stayNights.map((date) => ({ date, roomIds: chosenRow.full.slice(0, numberOfRooms) }))
      : [];
  const billFor = picked.length ? picked : candidate;
  const bill = usePickPricing(entry.id, billFor, hasResults);
  const pickedSaved = sel.savedCanon != null && sel.savedCanon === sel.currentCanon;
  const billTitle = picked.length
    ? pickedSaved
      ? "The rooms chosen"
      : "The rooms picked · not saved yet"
    : `If you take it · ${plural(numberOfRooms, "room")} of ${chosenType ?? "the marked type"}`;

  const takeIt = () => {
    if (!chosenRow) return;
    const ids = chosenRow.full.slice(0, numberOfRooms);
    sel.setWholeStay(ids);
    const perNight = stayNights.length
      ? stayNights.map((date) => ({ date, roomIds: ids }))
      : undefined;
    sel.submittedRef.current = null;
    seal.mutate({ perNight, roomIds: ids, allIds: ids });
  };

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
        ? "the answer is old — ask again first"
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
          hasResults || entry.checkInDate ? `The house · ${range}` : "The house"
        }
        acts={
          editable ? (
            hasResults ? (
              <>
                <Button
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
                  title="Recording an offer of what we have is not in the backend yet (BE-36)"
                >
                  Offer what we have
                </Button>
                <Button
                  kind="quiet"
                  compact
                  state="inert"
                  title="Recording a decline with its reason is not in the backend yet (BE-36)"
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
          <span className="meta">
            {entry.checkInDate
              ? "Ask the house — the free rooms for these dates appear here while you are still on the phone."
              : "Put in the dates and the rooms — the answer appears here."}
          </span>
        ) : (
          <>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Free</th>
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
                      {t.full.length > 0 ? (
                        <Chip tone="success">{t.full.length} free</Chip>
                      ) : t.partial > 0 ? (
                        <Chip tone="warning">{t.partial} on some nights</Chip>
                      ) : (
                        <Chip tone="quiet">none</Chip>
                      )}
                      {t.deficient > 0 ? (
                        <span className="meta">
                          {" "}
                          · {t.deficient} with a fault
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {bill.pricing ? (
              <PickBill
                pricing={bill.pricing}
                loading={bill.loading}
                title={billTitle}
                caption={
                  picked.length && !pickedSaved
                    ? "Save the rooms to keep this choice — the figures follow every pick."
                    : "Indicative, not a quote · meals, extra beds and any agreed rate are set at Negotiation."
                }
              />
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
            {stale ? (
              <div className="sm warn-ink" style={{ marginTop: 8 }}>
                This answer is old — ask the house again before choosing.
              </div>
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
                <Chip tone="success" icon="check">
                  chosen
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
                No rooms chosen yet · Take it chooses{" "}
                {plural(numberOfRooms, "room")} of the marked type, free on
                every night
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
                <Button
                  kind="quiet"
                  compact
                  state={ask.isPending ? "working" : "default"}
                  workingLabel="Asking…"
                  onClick={() => ask.mutate()}
                >
                  Ask again
                </Button>
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
            <div ref={toolRef}>
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
                billLoading={bill.loading}
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
  billLoading,
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
  /** What the picks cost — the house card's bill, in one line beside the save. */
  bill: PickPricing | null;
  billLoading: boolean;
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
      ? "Ask again to save"
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
      <div className="row-acts" style={{ marginBottom: 10 }}>
        <span className={`sm ${sel.ready ? "ok-ink" : "stop-ink"}`}>{counter}</span>
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
            (operator, 2026-09-29): the eye reads the counts left to right and lands on the act —
            and since 2026-10-10 the stay's total sits beside it, so the price is read as it moves. */}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: 12 }}>
          <PickTotalLine pricing={bill} loading={billLoading} />
          <Button
            compact
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
          <span className="meta">
            {isGm
              ? "Double-click a held or blocked night to release it."
              : "A GM can release a held or blocked room."}
          </span>
        </div>
      ) : null}
      {!full ? (
        <p className="meta" style={{ marginTop: 10 }}>
          Click a room&rsquo;s number to use it for the whole stay
          {displayNights.length > 1
            ? "; click one night to change only that night"
            : ""}
          . Nothing is recorded until you save. A room with a fault can be
          chosen — the acknowledgement is recorded with the save.
        </p>
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
