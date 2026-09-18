"use client";

/**
 * New inquiry — `/bookings/new` (SS03 step 1, "looking is recording"; prototype `screens.new`,
 * `V16.intakeCanvas`, `V16.intakeGate`).
 *
 * The same four cards the Inquiry step shows, empty and editable: who is asking, the guest, the
 * stay, rate and notes — and beside them the house, which can only answer once the lead exists
 * (the availability search runs against a booking). So "Ask the house" keeps the lead first,
 * asks, and opens the booking where the answer is; "Start the inquiry · keep the lead" keeps it
 * without asking.
 *
 * Every rule of the old intake form (components/desk/inquiry/new-inquiry-form.tsx) is kept here:
 * the phone match, the channel mapping, the agency / company pick with its contact persons and
 * packages, the company context, the child bands, the room-count envelope and the hotel's
 * capacity, the bed stock, the hotel's day, the early guest save and `?edit=<entryId>`.
 * The figures that decide anything come from the backend; nothing here adds money up.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { usePageTitle } from "@/hooks/use-page-title";
import { queryAvailabilityByEntry } from "@/lib/api/availability";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import { createEntry, getEntry, updateEntryIntake } from "@/lib/api/entries";
import { createGuestProfile, guestFullName, searchGuestProfiles, type GuestProfileSummary } from "@/lib/api/guest-profiles";
import {
  captureCorporateContext,
  createInquiry,
  getInquiry,
  listRatePackagesLookup,
  type CoordinatorContact,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";
import { listRooms } from "@/lib/api/rooms";
import { bookingHref } from "@/components/ds/ui";
import { fmtRange, money, plural } from "@/lib/ds/format";
import { BOUNDARY_STEPS, PHASES, STEP_NAMES, STEP_NEEDS } from "@/lib/ds/steps";
import type { EntryDetail } from "@/types/api";
import { Choice, StepCanvas, StepCard, atLeast, toastRefusal } from "./kit";
import { ApiError } from "@/lib/api/client";
import {
  BED_ORDER,
  CHANNEL_OPTIONS,
  ChildChargeNote,
  GateList,
  GuestLine,
  NATIONALITIES,
  PHONE_CODES,
  PartyContacts,
  PartySearch,
  PhoneInput,
  PickList,
  PresetOrCustom,
  SystemLine,
  USE_TYPES,
  addNightsIso,
  bedWord,
  cameInAsOf,
  channelDef,
  defaultContactFor,
  diffNightsIso,
  digits,
  splitStoredPhone,
  type ChannelKey,
  type GateLine,
  type UseTypeKey,
} from "./new-inquiry-parts";

/**
 * The prototype's final pass draws this screen without the journey rail (`ws-body norail`, and
 * the generated stylesheet names "the no-rail new inquiry"). The rail below is kept for the day
 * that changes: step 1 current, the rest unreachable.
 */
const WITH_RAIL = false;

const GUEST_CARD_ID = "new-inquiry-guest";

type InquiryScalars = {
  notes?: string | null;
  sourceChannel?: string | null;
  cameInAs?: string | null;
  corporateClientRef?: string | null;
  corporateCoordinator?: string | null;
};
type InquiryRecord = {
  travelAgent?: { displayName?: string | null } | null;
  corporateAccount?: { displayName?: string | null } | null;
};
type EntryContact = { contactPersonName?: string | null; contactPersonPhone?: string | null };

type Outcome = { entry: EntryDetail; asked: boolean; askError: unknown };

export function NewInquiryCanvas() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const params = useSearchParams();
  // `?edit=<entryId>` opens this screen on a saved inquiry: the stay, the kind of stay and who is
  // arriving can change; the guest and how they came in stay as recorded.
  const editId = params.get("edit");
  const isEdit = !!editId;
  // The hotel's day, from the server — never the machine's. Null until it answers.
  const today = useHotelDay()?.today ?? null;

  /* ---------------------------------------------------------------- who is asking */
  // No default: the operator says how the booking reached us (the old form made it the first pick).
  const [channelKey, setChannelKey] = useState<ChannelKey | null>(null);
  const [useType, setUseType] = useState<string>("LEISURE");
  const useTypeTouched = useRef(false);
  const [party, setParty] = useState<LookupPartyMatch | null>(null);
  // The agency / company person handling this booking — the booking's contact unless overridden.
  const [partyContact, setPartyContact] = useState<CoordinatorContact | null>(null);
  // Which negotiated package; null resolves the party's default, then the hotel's common one.
  const [ratePackageId, setRatePackageId] = useState<string | null>(null);
  // Policy 17 — a company booking records their reference and coordinator before it leaves Inquiry.
  const [corpRef, setCorpRef] = useState("");
  const [corpCoordinator, setCorpCoordinator] = useState("");

  /* ---------------------------------------------------------------- the guest */
  const [mode, setMode] = useState<"NEW" | "RETURNING">("NEW");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneCode, setPhoneCode] = useState(PHONE_CODES[0]);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [nationality, setNationality] = useState(NATIONALITIES[0]);
  const [selectedGuest, setSelectedGuest] = useState<GuestProfileSummary | null>(null);
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  // Who leads the party on the day. Blank → the agency's contact person, else the guest.
  const [arrivingName, setArrivingName] = useState("");
  const [arrivingPhone, setArrivingPhone] = useState("");

  /* ---------------------------------------------------------------- the stay */
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  // Nights lead; check-out follows check-in + nights, and a picked check-out sets the nights.
  const [nights, setNights] = useState("1");
  const [rooms, setRooms] = useState("1");
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  const [ages, setAges] = useState<string[]>([]);
  // "5 King + 2 Twin" — optional, may be partial.
  const [beds, setBeds] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const checkInDefaulted = useRef(false);

  /* ---------------------------------------------------------------- edit mode */
  const editQuery = useQuery({
    queryKey: ["entry", editId],
    queryFn: () => getEntry(session!, editId!),
    enabled: !!session && isEdit,
  });
  const editEntry = editQuery.data ?? null;
  const editInquiry = useQuery({
    queryKey: ["inquiry", editEntry?.inquiryId],
    queryFn: () => getInquiry(session!, editEntry!.inquiryId),
    enabled: !!session && !!editEntry?.inquiryId,
  });
  const editInq = (editEntry?.inquiry ?? null) as InquiryScalars | null;
  const editRec = (editInquiry.data ?? null) as InquiryRecord | null;
  const editPartyName = editRec?.travelAgent?.displayName ?? editRec?.corporateAccount?.displayName ?? null;
  const editGuest = editEntry?.guestProfile ?? editEntry?.inquiry?.guestProfile ?? null;
  const editContact = (editEntry ?? {}) as EntryContact;
  // The intake is changed only while the booking is an active inquiry (the server refuses later).
  const editable = !!editEntry && editEntry.currentStage === "S1" && editEntry.status === "ACTIVE";
  const editInited = useRef(false);
  useEffect(() => {
    if (!isEdit || !editEntry || editInited.current) return;
    editInited.current = true;
    const ci = editEntry.checkInDate?.slice(0, 10) ?? "";
    const co = editEntry.checkOutDate?.slice(0, 10) ?? "";
    setChannelKey(cameInAsOf(editInq?.sourceChannel, editInq?.notes, editEntry.useType, editInq?.cameInAs));
    setUseType(editEntry.useType ?? "LEISURE");
    setAdults(String(editEntry.adultCount ?? editEntry.guestCount ?? 1));
    setChildren(String(editEntry.childCount ?? 0));
    setAges((editEntry.childAges ?? []).map(String));
    setRooms(String(editEntry.numberOfRooms ?? 1));
    setBeds(Object.fromEntries(Object.entries(editEntry.bedTypeRequest ?? {}).map(([t, n]) => [t, String(n)])));
    setCheckIn(ci);
    setCheckOut(co);
    if (ci && co) setNights(String(Math.max(1, diffNightsIso(ci, co))));
    setArrivingName(editContact.contactPersonName ?? "");
    setArrivingPhone(editContact.contactPersonPhone ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editEntry]);

  /* ---------------------------------------------------------------- channel and party */
  const channel = channelDef(channelKey);
  const partyKind = channel?.party ?? null;
  const needsCorp = channel?.channel === "CORPORATE";

  // Land the cursor on the first field a pick opened: the agency search or the guest's phone after
  // "Came in as"; the guest's first field after New / Returning.
  const leftRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<"who" | "guest" | null>(null);
  useEffect(() => {
    const where = focusNext.current;
    if (!where) return;
    focusNext.current = null;
    const root = where === "guest" ? document.getElementById(GUEST_CARD_ID) : leftRef.current;
    root?.querySelector<HTMLElement>("input.input:not([disabled]):not([readonly]):not([type=date])")?.focus();
  }, [channelKey, mode]);

  const pickChannel = (k: ChannelKey) => {
    if (isEdit || k === channelKey) return;
    setChannelKey(k);
    if (!useTypeTouched.current) setUseType(channelDef(k)?.useType ?? "LEISURE");
    focusNext.current = "who";
  };

  // A party belongs to one kind — a travel agent must never ride into a company booking.
  useEffect(() => {
    setParty(null);
    setPartyContact(null);
  }, [partyKind]);

  // A new party brings its own contact: the first person on file, else the party's own details.
  useEffect(() => {
    setPartyContact(party ? defaultContactFor(party) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.id]);

  // The company context is cleared when the channel no longer needs it…
  useEffect(() => {
    if (isEdit || needsCorp) return;
    setCorpRef("");
    setCorpCoordinator("");
  }, [needsCorp, isEdit]);
  // …and inherited from the picked company's contract references and coordinators (spec §2.6.2).
  useEffect(() => {
    if (partyKind !== "CORPORATE" || !party) return;
    const refs = party.contractRefs ?? [];
    const coords = party.coordinators ?? [];
    if (refs.length > 0) setCorpRef(refs[0]);
    if (coords.length > 0) setCorpCoordinator(coords[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.id]);
  // For a company the contact person IS the coordinator — named once, not twice.
  useEffect(() => {
    if (needsCorp && partyContact) setCorpCoordinator(partyContact.name);
  }, [needsCorp, partyContact]);

  const packagesQuery = useQuery({
    queryKey: ["lookup-rate-packages", partyKind, party?.id],
    queryFn: () =>
      listRatePackagesLookup(session!, partyKind === "TRAVEL_AGENT" ? { travelAgentId: party!.id } : { corporateAccountId: party!.id }),
    enabled: !!session && !!party?.id && !!partyKind,
  });
  const packages = packagesQuery.data?.items ?? null;
  // Preselect the party's default so the choice shown is the one pricing would make anyway.
  useEffect(() => {
    // Nothing is carried over from another party's list while this one loads.
    if (!party?.id || !packages || packages.length === 0) {
      setRatePackageId(null);
      return;
    }
    setRatePackageId((cur) => (cur && packages.some((p) => p.id === cur) ? cur : (packages.find((p) => p.isDefault)?.id ?? null)));
  }, [party?.id, packages]);
  const chosenPackage = packages?.find((p) => p.id === ratePackageId) ?? null;

  /* ---------------------------------------------------------------- dates */
  // Check-in defaults to the hotel's today, once; a typed date is never replaced, and the
  // once-only latch keeps the minute poll from resetting it at midnight.
  useEffect(() => {
    if (!today || isEdit || checkInDefaulted.current) return;
    checkInDefaulted.current = true;
    setCheckIn((cur) => cur || today);
  }, [today, isEdit]);
  useEffect(() => {
    if (!checkIn) return;
    const n = Math.max(1, parseInt(nights || "1", 10) || 1);
    const next = addNightsIso(checkIn, n);
    if (next) setCheckOut(next);
  }, [checkIn, nights]);
  const onCheckOut = (v: string) => {
    setCheckOut(v);
    if (checkIn && v) {
      const d = diffNightsIso(checkIn, v);
      if (d >= 1) setNights(String(d));
    }
  };
  const checkOutMin = (checkIn && addNightsIso(checkIn, 1)) || today || undefined;
  const stayNights = checkIn && checkOut ? diffNightsIso(checkIn, checkOut) : 0;
  const datesSet = !!checkIn && !!checkOut && stayNights >= 1;
  const checkInPast = !!(today && checkIn && checkIn < today);
  const dateProblem =
    !checkIn && !checkOut
      ? null
      : !checkIn
        ? "put in the check-in as well"
        : !checkOut
          ? "put in the check-out, or the nights"
          : stayNights < 1
            ? "the check-out must be after the check-in"
            : !today
              ? "checking today's date at the hotel…"
              : checkInPast
                ? "the check-in is before today at the hotel"
                : null;

  /* ---------------------------------------------------------------- the party's ages */
  const adultsN = parseInt(adults || "0", 10) || 0;
  const childN = parseInt(children || "0", 10) || 0;
  useEffect(() => {
    setAges((prev) => {
      if (prev.length === childN) return prev;
      const next = prev.slice(0, childN);
      while (next.length < childN) next.push("");
      return next;
    });
  }, [childN]);

  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
  });
  const policy = policyQuery.data ?? null;
  // The fallbacks only enforce; the note prints no number until the policy has loaded.
  const minAdult = policy?.unaccompaniedMinor.minimumAge ?? 18;
  const maxChildAge = Math.max(0, minAdult - 1);
  const youngMax = policy?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policy?.ageBands.childMaxAge ?? 10;
  const agesComplete =
    childN === 0 || (ages.length === childN && ages.every((a) => a.trim() !== "" && Number(a) >= 0 && Number(a) <= maxChildAge));
  // 11–17 (as configured): a child charged at the adult rate. Gated on the policy having loaded.
  const adultBand = useMemo(() => {
    const out = new Set<number>();
    if (!policy) return out;
    ages.forEach((raw, i) => {
      const n = parseInt(raw || "", 10);
      if (Number.isFinite(n) && n > childMax && n <= maxChildAge) out.add(i);
    });
    return out;
  }, [ages, childMax, maxChildAge, policy]);
  // 18+ (as configured): not a child at all — refused here and by the server.
  const overAge = useMemo(() => {
    const out = new Set<number>();
    ages.forEach((raw, i) => {
      const n = parseInt(raw || "", 10);
      if (Number.isFinite(n) && n >= minAdult) out.add(i);
    });
    return out;
  }, [ages, minAdult]);

  /* ---------------------------------------------------------------- rooms */
  const parsedAges = ages.map((a) => parseInt(a || "", 10)).filter((n) => Number.isFinite(n));
  const envelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", adultsN, parsedAges.join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: adultsN, childAges: parsedAges }),
    enabled: !!session && adultsN > 0 && agesComplete,
  });
  const envelope = envelopeQuery.data ?? null;
  const roomRange = envelope?.allowedRoomCounts ?? { min: adultsN > 0 ? 1 : 0, max: adultsN };
  const exceedsHotel = envelope?.exceedsHotelCapacity ?? false;
  const allowedRooms = useMemo(
    () =>
      roomRange.min > 0 && roomRange.max >= roomRange.min ? Array.from({ length: roomRange.max - roomRange.min + 1 }, (_, i) => roomRange.min + i) : [],
    [roomRange.min, roomRange.max],
  );
  // A smaller party can make the chosen count illegal — snap it to the first one allowed.
  useEffect(() => {
    if (allowedRooms.length === 0) return;
    const n = parseInt(rooms || "0", 10) || 0;
    if (!allowedRooms.includes(n)) setRooms(String(allowedRooms[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedRooms]);
  const roomsN = parseInt(rooms || "0", 10) || 0;

  /* ---------------------------------------------------------------- beds */
  // The setups and their ceilings come from the live room registry (King ⇄ Twin share stock).
  const catalogQuery = useQuery({ queryKey: ["rooms"], queryFn: () => listRooms(session!), enabled: !!session });
  const catalog = catalogQuery.data?.items;
  const bedOptions = useMemo(() => {
    const achievable = new Map<string, number>();
    for (const r of catalog ?? []) {
      const setups = r.allowedBedTypes?.length ? r.allowedBedTypes : r.bedType ? [r.bedType] : [];
      for (const t of setups) achievable.set(t, (achievable.get(t) ?? 0) + 1);
    }
    return [...achievable.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => {
        const ia = BED_ORDER.indexOf(a.type);
        const ib = BED_ORDER.indexOf(b.type);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.type.localeCompare(b.type);
      });
  }, [catalog]);
  const bedRequest = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [t, v] of Object.entries(beds)) {
      const n = parseInt(v || "", 10);
      if (Number.isFinite(n) && n > 0) out[t] = n;
    }
    return out;
  }, [beds]);
  const bedSum = Object.values(bedRequest).reduce((a, b) => a + b, 0);
  // Setups that share convertible stock are judged together, the way the server judges them.
  const bedShortfall = useMemo(() => {
    if (bedSum === 0) return null;
    const stockByGroup = new Map<string, number>();
    const groupOf = new Map<string, string>();
    for (const r of catalog ?? []) {
      const setups = (r.allowedBedTypes?.length ? r.allowedBedTypes : r.bedType ? [r.bedType] : []).slice().sort();
      if (setups.length === 0) continue;
      const g = setups.join("/");
      stockByGroup.set(g, (stockByGroup.get(g) ?? 0) + 1);
      for (const t of setups) groupOf.set(t, g);
    }
    const askByGroup = new Map<string, { count: number; types: string[] }>();
    for (const [t, n] of Object.entries(bedRequest)) {
      const g = groupOf.get(t) ?? t;
      const cur = askByGroup.get(g) ?? { count: 0, types: [] };
      cur.count += n;
      cur.types.push(t);
      askByGroup.set(g, cur);
    }
    for (const [g, ask] of askByGroup) {
      const stock = stockByGroup.get(g) ?? 0;
      if (ask.count > stock) return { asked: ask.count, stock, types: ask.types.map(bedWord).join(" + "), pooled: g.includes("/") };
    }
    return null;
  }, [bedRequest, bedSum, catalog]);
  const bedsOverRooms = bedSum > 0 && bedSum > roomsN;
  const bedsOk = bedSum === 0 || (!bedsOverRooms && !bedShortfall);
  // The bed setup only ever RAISES the room count; a smaller sum is a partial preference.
  useEffect(() => {
    if (bedSum <= 0) return;
    const current = parseInt(rooms || "0", 10) || 0;
    if (bedSum > current && allowedRooms.includes(bedSum)) setRooms(String(bedSum));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bedSum, allowedRooms]);

  /* ---------------------------------------------------------------- guest lookups */
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const returning = useQuery({
    queryKey: ["desk-guest-profiles", searchTerm],
    queryFn: () => searchGuestProfiles(session!, searchTerm, 20),
    enabled: !!session && !isEdit && mode === "RETURNING" && !selectedGuest && (searchTerm.length === 0 || searchTerm.length >= 2),
  });
  // Typing a known number surfaces the guest already on file.
  const phoneDigits = phoneNumber.replace(/\D/g, "");
  const [phoneTerm, setPhoneTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setPhoneTerm(phoneDigits), 350);
    return () => clearTimeout(t);
  }, [phoneDigits]);
  const phoneLookupOn = !isEdit && mode === "NEW" && !selectedGuest && phoneTerm.length >= 4;
  const phoneMatch = useQuery({
    queryKey: ["desk-guest-phone", phoneTerm],
    queryFn: () => searchGuestProfiles(session!, phoneTerm, 5),
    enabled: !!session && phoneLookupOn,
  });
  const phoneMatches = phoneLookupOn ? (phoneMatch.data?.items ?? []) : [];

  const adoptGuest = (g: GuestProfileSummary) => {
    setSelectedGuest(g);
    setFirstName(g.firstName);
    setLastName(g.lastName);
    setEmail(g.email ?? "");
    if (g.nationality) setNationality(g.nationality);
    // The stored number replaces the fragment typed to find them.
    if (g.phone) {
      const { code, number } = splitStoredPhone(g.phone);
      setPhoneCode(code);
      setPhoneNumber(number);
    }
    toast.success(`Using the guest on file: ${guestFullName(g)}`);
  };

  const fullPhone = phoneCode && phoneNumber.trim() ? `${phoneCode}${phoneNumber.trim()}` : "";
  const typedGuestName = `${firstName.trim()} ${lastName.trim()}`.trim();
  const newGuestComplete = !!(firstName.trim() && lastName.trim() && phoneNumber.trim() && nationality.trim());
  const guestOk = isEdit || (mode === "NEW" ? !!selectedGuest || newGuestComplete : !!selectedGuest);

  // Saving the guest early only moves the write forward; the saved record is then reused.
  const saveGuest = useMutation({
    mutationFn: () =>
      createGuestProfile(session!, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || undefined,
        phone: fullPhone || undefined,
        nationality: nationality.trim() || undefined,
      }),
    onSuccess: (created) => {
      setSelectedGuest(created);
      toast.success(`${guestFullName(created)} is on file`);
    },
    onError: (e) => toastRefusal(e, "The guest could not be saved"),
  });

  usePageTitle(
    isEdit ? (editGuest ? guestFullName({ firstName: editGuest.firstName ?? "", lastName: editGuest.lastName ?? "" }) : null) : typedGuestName || null,
    isEdit ? "Edit the inquiry" : "New inquiry",
  );

  /* ---------------------------------------------------------------- who is arriving */
  const arrivingFallbackName = partyContact?.name?.trim() || typedGuestName;
  const arrivingFallbackPhone = partyContact?.phone?.trim() || selectedGuest?.phone || fullPhone || "";
  const arrivingFallbackWord = partyContact?.name?.trim()
    ? `${partyContact.name.trim()}${party ? ` at ${party.displayName}` : ""}`
    : typedGuestName
      ? `${typedGuestName}, the guest`
      : "the guest";

  /* ---------------------------------------------------------------- what stops the save */
  const corpComplete = !needsCorp || (corpRef.trim() !== "" && corpCoordinator.trim() !== "");
  const partyOk = adultsN >= 1 && agesComplete && !exceedsHotel && bedsOk && (allowedRooms.length === 0 || allowedRooms.includes(roomsN));
  const partyHow =
    adultsN < 1
      ? "at least one adult"
      : overAge.size > 0
        ? `an age of ${minAdult} or more goes under Adults`
        : !agesComplete
          ? "every child's age"
          : exceedsHotel
            ? "more guests than the hotel can sleep"
            : bedShortfall
              ? "more beds of one kind than the hotel has"
              : bedsOverRooms
                ? "the beds add up to more rooms than the party allows"
                : allowedRooms.length > 0 && !allowedRooms.includes(roomsN)
                  ? "a room count the party allows"
                  : undefined;
  const roomsGuestsSet = partyOk && roomsN >= 1;

  const saveBlockers: string[] = [];
  if (isEdit) {
    if (!editEntry) saveBlockers.push("the booking is still opening");
    else if (!editable) saveBlockers.push("the booking has moved past Inquiry");
  } else {
    if (!channel) saveBlockers.push("how they came in");
    if (!guestOk)
      saveBlockers.push(mode === "NEW" ? "the guest's first and last name, phone and nationality" : "the returning guest, picked from the list");
    if (!corpComplete) saveBlockers.push("the company's reference and their coordinator");
  }
  if (!partyOk && partyHow) saveBlockers.push(partyHow);
  if (dateProblem) saveBlockers.push(dateProblem);
  if (isEdit && !datesSet && !dateProblem) saveBlockers.push("the check-in and check-out");
  const askBlockers = [...saveBlockers];
  if (!datesSet && !dateProblem && !isEdit) askBlockers.push("the check-in and check-out, or the nights");

  /* ---------------------------------------------------------------- the save */
  const [navigating, setNavigating] = useState(false);
  // A retry after a refused entry reuses the inquiry already made, so a refusal never leaves
  // a second lead behind for the same guest and the same request.
  const madeInquiry = useRef<{ key: string; id: string } | null>(null);
  // A confirmed duplicate (Policy 12): the booking it clashes with, and the FOM's way through —
  // a deliberate second booking goes ahead with a reason on record (2026-09-18).
  const [dupe, setDupe] = useState<{ entryId: string | null } | null>(null);
  const [dupeKind, setDupeKind] = useState<"ACKNOWLEDGE" | "DISMISS">("ACKNOWLEDGE");
  const [dupeReason, setDupeReason] = useState("");
  const dupeResolution = useRef<{ resolution: "ACKNOWLEDGE" | "DISMISS"; reason: string } | null>(null);
  const fomHere = atLeast(session?.actorLevel, "L2");

  const run = useMutation({
    mutationFn: async (ask: boolean): Promise<Outcome> => {
      if (!session) throw new Error("Not signed in");
      const a = Math.max(1, adultsN);
      const c = Math.max(0, childN);
      const agesOut = c > 0 && parsedAges.length === c ? parsedAges : undefined;
      let entry: EntryDetail;

      if (isEdit && editEntry) {
        const nameChanged = arrivingName.trim() !== (editContact.contactPersonName ?? "") && arrivingName.trim() !== "";
        const phoneChanged = arrivingPhone.trim() !== (editContact.contactPersonPhone ?? "") && arrivingPhone.trim() !== "";
        entry = await updateEntryIntake(session, editEntry.id, {
          checkInDate: checkIn || undefined,
          checkOutDate: checkOut || undefined,
          adultCount: a,
          childCount: c,
          childAges: c > 0 ? agesOut : [],
          guestCount: a + c,
          numberOfRooms: Math.max(1, roomsN),
          // An emptied bed setup is cleared, not left as it was.
          bedTypeRequest: bedSum > 0 ? bedRequest : null,
          useType: useType !== (editEntry.useType ?? "") ? useType : undefined,
          contactPersonName: nameChanged ? arrivingName.trim() : undefined,
          contactPersonPhone: phoneChanged ? arrivingPhone.trim() : undefined,
          expectedVersion: editEntry.version,
        });
      } else {
        if (!channel) throw new Error("Say how they came in first");
        let guestProfileId: string;
        if (selectedGuest) guestProfileId = selectedGuest.id;
        else {
          const profile = await createGuestProfile(session, {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim() || undefined,
            phone: fullPhone || undefined,
            nationality: nationality.trim() || undefined,
          });
          guestProfileId = profile.id;
          // Adopted at once, so a retry after a later refusal reuses this record.
          setSelectedGuest(profile);
        }
        const inquiryBody = {
          guestProfileId,
          sourceChannel: channel.channel,
          cameInAs: channel.cameInAs,
          notes: notes.trim() || undefined,
          proposedCheckIn: checkIn || undefined,
          proposedCheckOut: checkOut || undefined,
          travelAgentId: partyKind === "TRAVEL_AGENT" ? (party?.id ?? null) : null,
          corporateAccountId: partyKind === "CORPORATE" ? (party?.id ?? null) : null,
          ratePackageId: party?.id ? ratePackageId : null,
          ...(dupeResolution.current ? { duplicateResolution: dupeResolution.current } : {}),
        };
        const key = JSON.stringify(inquiryBody);
        let inquiryId = madeInquiry.current?.key === key ? madeInquiry.current.id : null;
        if (!inquiryId) {
          const inquiry = await createInquiry(session, inquiryBody);
          inquiryId = inquiry.id;
          madeInquiry.current = { key, id: inquiryId };
        }
        if (needsCorp) {
          await captureCorporateContext(session, inquiryId, {
            corporateClientRef: corpRef.trim(),
            corporateCoordinator: corpCoordinator.trim(),
          });
        }
        // The booking's contact: who is arriving when named; else the agency's person; else the
        // guest. The party's email only rides along with the party's own person.
        const overridden = arrivingName.trim() !== "";
        entry = await createEntry(session, {
          inquiryId,
          useType,
          guestProfileId,
          checkInDate: checkIn || undefined,
          checkOutDate: checkOut || undefined,
          guestCount: a + c,
          adultCount: a,
          childCount: c,
          childAges: agesOut,
          numberOfRooms: Math.max(1, roomsN),
          bedTypeRequest: bedSum > 0 ? bedRequest : undefined,
          otaSource: channel.channel === "OTA",
          contactPersonName: (arrivingName.trim() || arrivingFallbackName) || undefined,
          contactPersonPhone: (arrivingPhone.trim() || arrivingFallbackPhone) || undefined,
          contactPersonEmail: (!overridden && partyContact?.email?.trim()) || undefined,
        });
        madeInquiry.current = null;
      }

      // Looking is recording: the house is asked against the booking just kept.
      let asked = false;
      let askError: unknown = null;
      if (ask) {
        try {
          await queryAvailabilityByEntry(session, entry.id, {
            checkInDate: entry.checkInDate?.slice(0, 10) ?? checkIn,
            checkOutDate: entry.checkOutDate?.slice(0, 10) ?? checkOut,
            guestCount: entry.guestCount ?? a + c,
            useType: entry.useType ?? useType,
          });
          asked = true;
        } catch (e) {
          askError = e;
        }
      }
      return { entry, asked, askError };
    },
    onSuccess: ({ entry, asked, askError }, ask) => {
      const id = entry.id;
      for (const k of [["entry", id], ["entries"], ["desk-bookings"], ["entry-trace", id], ["entry-timers", id], ["inquiry", entry.inquiryId]]) {
        void queryClient.invalidateQueries({ queryKey: k });
      }
      // Warm the booking while the route loads, with the house's answer already in it.
      if (session) void queryClient.prefetchQuery({ queryKey: ["entry", id], queryFn: () => getEntry(session, id) });
      if (isEdit) toast.success(asked ? "The intake is updated — the house has answered" : "The intake is updated");
      else toast.success(asked ? `${id} kept — the house has answered` : `${id} kept · the lead is on record`);
      if (askError) toastRefusal(askError, "The lead is kept, but the house could not be asked — ask again on the booking");
      setNavigating(true);
      router.push(ask || isEdit ? bookingHref(id, 1) : bookingHref(id));
    },
    onError: (e) => {
      const body = e instanceof ApiError ? e.body : undefined;
      if (!isEdit && body?.blockingCondition === "DUPLICATE_INQUIRY_CONFIRMED") {
        const det = (body.details ?? {}) as { conflictingEntryId?: string };
        setDupe({ entryId: det.conflictingEntryId ?? null });
        dupeResolution.current = null;
        return;
      }
      toastRefusal(e, isEdit ? "The changes could not be saved" : "The inquiry could not be started");
    },
  });
  const busy = run.isPending || navigating;
  const askingNow = busy && run.variables === true;
  const savingNow = busy && run.variables === false;

  /* ---------------------------------------------------------------- the gate */
  const configs = editEntry?.availabilityConfigs ?? [];
  const houseAsked = isEdit && configs.some((c) => c.optionSelected != null && !c.isStale);
  const useTypeReq: GateLine =
    useType === "APARTMENT"
      ? {
          label: "Apartment terms",
          whose: "desk",
          met: false,
          how: "an apartment needs its nights and rate tier before Negotiation — not on the desk yet",
        }
      : useType === "CONFERENCE"
        ? { label: "Use-type requirements · the hall is added on the booking", whose: "desk", met: true }
        : { label: "Use-type requirements · none", whose: "desk", met: true };
  const guestLineLabel = isEdit || selectedGuest ? "Guest on file" : "Guest, or the booker's contact standing in";
  const gate: GateLine[] = [
    { label: "Source channel", whose: "desk", met: !!channelKey, how: "say how they came in" },
    { label: "Dates set", whose: "desk", met: datesSet && !dateProblem, how: dateProblem ?? "check-in and check-out, or check-in and nights" },
    { label: "Rooms and guests set", whose: "desk", met: roomsGuestsSet, how: partyHow ?? "a room count for the party" },
    {
      label: guestLineLabel,
      whose: "desk",
      met: guestOk,
      how: mode === "NEW" ? "a first and last name with a phone and a nationality — or the guest the phone found" : "pick the returning guest",
    },
    { label: "Use type", whose: "desk", met: !!useType },
    {
      label: "The house asked · a configuration selected",
      whose: "system",
      met: houseAsked,
      how: datesSet ? "Ask the house keeps the lead and asks; the rooms are taken on the booking" : "enter the dates",
    },
    useTypeReq,
    { label: "Custodian assigned", whose: "system", met: true },
    { label: "No duplicate found · runs on save", whose: "system", met: true },
  ];

  const primaryLabel = isEdit ? "Save the changes" : "Start the inquiry · keep the lead";
  const saveReason = saveBlockers.length ? `first: ${saveBlockers.join(" · ")}` : null;
  const askReason = askBlockers.length ? `first: ${askBlockers.join(" · ")}` : null;

  /* ---------------------------------------------------------------- render */
  const nameToCome =
    !isEdit && (channelKey === "AGENT" || channelKey === "CORPORATE" || channelKey === "OTA")
      ? channelKey === "CORPORATE"
        ? "the company"
        : channelKey === "OTA"
          ? "the OTA"
          : "the agent"
      : null;

  return (
    <div className="ws">
      <div className="ws-head">
        <div>
          <Link href={isEdit ? bookingHref(editId!, 1) : "/bookings"} className="backlink">
            <Icon name="chev" /> {isEdit ? "Back to the booking" : "Back to Bookings"}
          </Link>
          <div className="who">
            <h2 className="ink-2">{isEdit ? "Edit the inquiry" : "New inquiry"}</h2>
          </div>
          <div className="facts">
            {isEdit ? (
              <>
                <span>{editId}</span>
                {editGuest ? (
                  <span>
                    <b>{guestFullName({ firstName: editGuest.firstName ?? "", lastName: editGuest.lastName ?? "" })}</b>
                  </span>
                ) : null}
                <span className="meta">the stay, the kind of stay and who is arriving can change · the guest and how they came in stay as recorded</span>
              </>
            ) : (
              <span className="meta">There is no other way to see whether rooms are free: looking is recording. The lead is kept — taken or not.</span>
            )}
          </div>
        </div>
        <div className="total">
          <div className="figure money" style={{ cursor: "default" }}>
            <span className="dash">—</span>
          </div>
          <div className="kind">{datesSet ? "no total until the house is asked" : "no dates, no total"}</div>
        </div>
      </div>

      <div className={`ws-body${WITH_RAIL ? "" : " norail"}`}>
        {WITH_RAIL ? (
          <nav className="rail" aria-label="Journey">
            {PHASES.map(([phase, steps]) => (
              <div key={phase} style={{ display: "contents" }}>
                <div className={`phase${steps.includes(1) ? " current" : ""}`}>{phase}</div>
                {steps.map((n) => (
                  <span key={n} className={["step", n === 1 ? "current" : "unreachable", BOUNDARY_STEPS.has(n) ? "boundary" : ""].filter(Boolean).join(" ")}>
                    <span className="n">{n}</span>
                    <span>{STEP_NAMES[n - 1]}</span>
                  </span>
                ))}
              </div>
            ))}
            <div className="legend">
              <span>
                <i />
                cannot be undone
              </span>
            </div>
          </nav>
        ) : null}

        <div className="canvas">
          <h3>
            {STEP_NAMES[0]} <span className="need">{STEP_NEEDS[1]}</span>
          </h3>
          {isEdit && editEntry && !editable ? (
            <div className="notice inert">
              <span className="sm">This booking has moved past Inquiry — its intake can no longer be changed here.</span>
            </div>
          ) : null}
          {isEdit && editQuery.isError ? (
            <div className="notice inert">
              <span className="sm">The booking could not be opened — go back and try again.</span>
            </div>
          ) : null}
          <StepCanvas past={false}>
            <div className="intake">
              <div className="stack" ref={leftRef}>
                {/* ------------------------------------------------ who is asking */}
                <StepCard title="Who is asking">
                  <div className="form2">
                    <div className="wide field">
                      <label>Came in as</label>
                      <Choice options={CHANNEL_OPTIONS} value={channelKey} disabled={isEdit} onChange={pickChannel} />
                      <span className={`hint${!isEdit && !channelKey ? " warn-ink" : ""}`}>
                        {isEdit
                          ? "set when the inquiry was recorded"
                          : channelKey
                            ? "it decides what the rest of this form asks for"
                            : "pick one — it decides what the rest of this form asks for"}
                      </span>
                    </div>

                    {isEdit ? (
                      editPartyName || editInq?.corporateClientRef ? (
                        <>
                          <div className="field">
                            <label>{channelKey === "CORPORATE" ? "Company" : "Travel agent"}</label>
                            <input className="input" readOnly value={editPartyName ?? ""} placeholder="none on file" />
                          </div>
                          {channelKey === "CORPORATE" ? (
                            <>
                              <div className="field">
                                <label>Their PO or authorisation</label>
                                <input className="input" readOnly value={editInq?.corporateClientRef ?? ""} placeholder="none given" />
                              </div>
                              <div className="field">
                                <label>Their coordinator</label>
                                <input className="input" readOnly value={editInq?.corporateCoordinator ?? ""} placeholder="none given" />
                              </div>
                            </>
                          ) : null}
                        </>
                      ) : null
                    ) : partyKind ? (
                      <>
                        <PartySearch kind={partyKind} party={party} setParty={setParty} />
                        {party ? (
                          <PartyContacts kind={partyKind} party={party} setParty={setParty} contact={partyContact} setContact={setPartyContact} />
                        ) : null}
                      </>
                    ) : null}

                    {!isEdit && needsCorp ? (
                      <>
                        <div className="field">
                          <label>Their PO or authorisation</label>
                          {party && (party.contractRefs ?? []).length > 0 ? (
                            <select className="input" value={corpRef} onChange={(e) => setCorpRef(e.target.value)}>
                              <option value="">— pick their reference —</option>
                              {(party.contractRefs ?? []).map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input className="input" value={corpRef} placeholder="PO, account or authorisation" onChange={(e) => setCorpRef(e.target.value)} />
                          )}
                          <span className={`hint${corpRef.trim() ? "" : " warn-ink"}`}>needed — the company is billed on it</span>
                        </div>
                        <div className="field">
                          <label>Their coordinator</label>
                          {party && (party.coordinators ?? []).length > 0 ? (
                            <select className="input" value={corpCoordinator} onChange={(e) => setCorpCoordinator(e.target.value)}>
                              <option value="">— pick their coordinator —</option>
                              {(party.coordinators ?? []).map((c) => (
                                <option key={c.name} value={c.name}>
                                  {c.name}
                                  {c.phone ? ` · ${c.phone}` : ""}
                                </option>
                              ))}
                              {corpCoordinator && !(party.coordinators ?? []).some((c) => c.name === corpCoordinator) ? (
                                <option value={corpCoordinator}>{corpCoordinator}</option>
                              ) : null}
                            </select>
                          ) : (
                            <input className="input" value={corpCoordinator} placeholder="who books for them" onChange={(e) => setCorpCoordinator(e.target.value)} />
                          )}
                          <span className={`hint${corpCoordinator.trim() ? "" : " warn-ink"}`}>
                            {party && ((party.contractRefs ?? []).length > 0 || (party.coordinators ?? []).length > 0)
                              ? `from ${party.displayName}'s account · kept there by Admin`
                              : "needed — who books for them"}
                          </span>
                        </div>
                      </>
                    ) : null}

                    <div className="wide field">
                      <label>What kind of stay</label>
                      <Choice
                        options={USE_TYPES}
                        value={useType as UseTypeKey}
                        disabled={isEdit && !editable}
                        onChange={(v) => {
                          useTypeTouched.current = true;
                          setUseType(v);
                        }}
                      />
                      {useType === "APARTMENT" ? (
                        <span className="hint warn-ink">an apartment needs its nights and rate tier before Negotiation — those are not on the desk yet</span>
                      ) : useType === "CONFERENCE" ? (
                        <span className="hint">the hall and its seating are added on the booking</span>
                      ) : null}
                    </div>
                  </div>
                </StepCard>

                {/* ------------------------------------------------ the guest */}
                <StepCard
                  id={GUEST_CARD_ID}
                  title="The guest"
                  right={
                    !isEdit && !selectedGuest ? (
                      <Choice
                        options={[
                          ["NEW", "New guest"],
                          ["RETURNING", "Returning guest"],
                        ]}
                        value={mode}
                        onChange={(v) => {
                          setMode(v);
                          setSelectedGuest(null);
                          focusNext.current = "guest";
                        }}
                      />
                    ) : null
                  }
                >
                  {nameToCome ? (
                    <label className="sm ink-2" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                      <input type="checkbox" disabled aria-describedby="name-to-come-why" />
                      Name to come from {nameToCome}
                      <span id="name-to-come-why" className="meta">
                        · not on the desk yet — an inquiry is kept on the guest&rsquo;s record, which needs a name with a phone or email (BE-62)
                      </span>
                    </label>
                  ) : null}

                  {isEdit ? (
                    <div className="form2">
                      <div className="field">
                        <label>Phone</label>
                        <input className="input" readOnly value={editGuest?.phone ?? ""} placeholder="none on file" />
                      </div>
                      <div className="field">
                        <label>Email</label>
                        <input className="input" readOnly value={editGuest?.email ?? ""} placeholder="none on file" />
                      </div>
                      <div className="field">
                        <label>First name</label>
                        <input className="input" readOnly value={editGuest?.firstName ?? ""} />
                      </div>
                      <div className="field">
                        <label>Last name</label>
                        <input className="input" readOnly value={editGuest?.lastName ?? ""} />
                      </div>
                      <div className="field">
                        <label>Nationality</label>
                        <input className="input" readOnly value={editGuest?.nationality ?? ""} />
                      </div>
                      <div className="field">
                        <label>Guest record</label>
                        <span className="sm" style={{ paddingTop: 8 }}>
                          {editGuest?.id ? <Link href={`/guests/${editGuest.id}`}>Open the guest&rsquo;s record</Link> : <span className="dash">—</span>}
                        </span>
                      </div>
                      <span className="wide meta">The guest stays as recorded — it cannot change on a saved booking.</span>
                    </div>
                  ) : selectedGuest ? (
                    <div className="bind bound" style={{ display: "grid", gap: 6 }}>
                      <span className="sm">
                        <Icon name="check" /> <GuestLine guest={selectedGuest} />
                      </span>
                      <div className="row-acts">
                        <Link className="btn btn-quiet compact" href={`/guests/${selectedGuest.id}`} target="_blank">
                          Open the guest&rsquo;s record
                        </Link>
                        <Button kind="secondary" compact onClick={() => setSelectedGuest(null)}>
                          Someone else
                        </Button>
                        <span className="meta">this booking is kept on the guest already on file</span>
                      </div>
                    </div>
                  ) : mode === "NEW" ? (
                    <>
                      <div className="form2">
                        <div className="field">
                          <label>Phone</label>
                          <PhoneInput code={phoneCode} setCode={setPhoneCode} number={phoneNumber} setNumber={setPhoneNumber} />
                          <span className="hint">finds an existing guest first · needed</span>
                        </div>
                        <div className="field">
                          <label>Email</label>
                          <input className="input" type="email" value={email} placeholder="optional" onChange={(e) => setEmail(e.target.value)} />
                          <span className="hint">optional</span>
                        </div>
                        {phoneMatches.length > 0 ? (
                          <div className="wide">
                            <PickList
                              head={`${phoneMatches.length === 1 ? "A guest" : "Guests"} on file with this number`}
                              rows={phoneMatches.map((g) => ({ key: g.id, main: <GuestLine guest={g} />, onPick: () => adoptGuest(g) }))}
                            />
                          </div>
                        ) : null}
                        <div className="field">
                          <label>First name</label>
                          <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>Last name</label>
                          <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>Nationality</label>
                          <PresetOrCustom
                            presets={NATIONALITIES}
                            value={nationality}
                            onChange={setNationality}
                            placeholder="type the nationality"
                            otherLabel="Other…"
                            ariaLabel="Nationality"
                          />
                          <span className="hint">needed</span>
                        </div>
                        <div className="field">
                          <label>Guest record</label>
                          <span className="row-acts" style={{ paddingTop: 2 }}>
                            <Button
                              kind="secondary"
                              compact
                              state={saveGuest.isPending ? "working" : newGuestComplete && !busy ? "default" : "inert"}
                              title={newGuestComplete ? undefined : "the name, phone and nationality first"}
                              workingLabel="Saving…"
                              onClick={() => saveGuest.mutate()}
                            >
                              Save the guest now
                            </Button>
                          </span>
                          <span className="hint">optional — otherwise the guest is saved with the inquiry</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      <div className="field">
                        <label>Find the guest</label>
                        <input className="input" value={search} placeholder="name, phone or email — at least 2 letters" onChange={(e) => setSearch(e.target.value)} />
                      </div>
                      {returning.isLoading ? (
                        <span className="meta">Looking…</span>
                      ) : (
                        <PickList
                          rows={(returning.data?.items ?? []).map((g) => ({
                            key: g.id,
                            main: <GuestLine guest={g} />,
                            sub: g.clientTier ?? undefined,
                            onPick: () => adoptGuest(g),
                          }))}
                          empty={searchTerm.length === 1 ? "type one more letter" : "no guest found"}
                        />
                      )}
                    </div>
                  )}

                  <div className="form2 rule-above">
                    <div className="field">
                      <label>Who is arriving · name</label>
                      <input
                        className="input"
                        value={arrivingName}
                        readOnly={isEdit && !editable}
                        placeholder={isEdit ? "who leads the party on the day" : `blank — ${arrivingFallbackWord}`}
                        onChange={(e) => setArrivingName(e.target.value)}
                      />
                      <span className="hint">who leads the party on the day</span>
                    </div>
                    <div className="field">
                      <label>Their phone</label>
                      <input
                        className="input"
                        inputMode="tel"
                        value={arrivingPhone}
                        readOnly={isEdit && !editable}
                        placeholder={isEdit ? "+975 …" : arrivingFallbackPhone ? `blank — ${arrivingFallbackPhone}` : "+975 …"}
                        onChange={(e) => setArrivingPhone(e.target.value)}
                      />
                      <span className="hint">needed before arrival</span>
                    </div>
                  </div>
                </StepCard>

                {/* ------------------------------------------------ the stay */}
                <StepCard title="The stay">
                  <div className="form2">
                    <div className="field">
                      <label>Check-in</label>
                      <input
                        className={`input${checkInPast ? " invalid" : ""}`}
                        type="date"
                        value={checkIn}
                        min={today ?? undefined}
                        readOnly={isEdit && !editable}
                        onChange={(e) => setCheckIn(e.target.value)}
                        onBlur={() => {
                          if (today && checkIn && checkIn < today) setCheckIn(today);
                        }}
                      />
                      <span className={`hint${dateProblem ? " warn-ink" : ""}`}>
                        {dateProblem ?? (today ? "from today at the hotel" : "checking today's date at the hotel…")}
                      </span>
                    </div>
                    <div className="field">
                      <label>Nights</label>
                      <input
                        className="input"
                        inputMode="numeric"
                        value={nights}
                        placeholder="1"
                        readOnly={isEdit && !editable}
                        onChange={(e) => setNights(digits(e.target.value))}
                      />
                      <span className="hint">the check-out follows</span>
                    </div>
                    <div className="field">
                      <label>Check-out</label>
                      <input
                        className="input"
                        type="date"
                        value={checkOut}
                        min={checkOutMin}
                        readOnly={isEdit && !editable}
                        onChange={(e) => onCheckOut(e.target.value)}
                        onBlur={() => {
                          if (checkIn && checkOut && diffNightsIso(checkIn, checkOut) < 1) onCheckOut(addNightsIso(checkIn, 1));
                        }}
                      />
                      {datesSet ? <span className="hint">{`${fmtRange(checkIn, checkOut)} · ${plural(stayNights, "night")}`}</span> : null}
                    </div>
                    <div className="field">
                      <label>Rooms</label>
                      <select
                        className="input"
                        value={rooms}
                        disabled={allowedRooms.length === 0 || (isEdit && !editable)}
                        onChange={(e) => setRooms(e.target.value)}
                      >
                        {allowedRooms.length === 0 ? (
                          <option value={rooms}>—</option>
                        ) : (
                          allowedRooms.map((n) => (
                            <option key={n} value={String(n)}>
                              {plural(n, "room")}
                            </option>
                          ))
                        )}
                      </select>
                      {exceedsHotel && envelope ? (
                        <span className="error">
                          <Icon name="alert" />
                          This party cannot be put up: {plural(envelope.chargeableOccupants, "chargeable guest")}, and the hotel&rsquo;s{" "}
                          {plural(envelope.hotelRoomCount, "room")} sleep at most {envelope.hotelMaxOccupants}. Make the party smaller or split the booking.
                        </span>
                      ) : (
                        <span className="hint">
                          {envelope
                            ? `a count · ${roomRange.min === roomRange.max ? roomRange.min : `${roomRange.min}–${roomRange.max}`} for ${plural(envelope.chargeableOccupants, "chargeable guest")}, up to ${envelope.maxCapacityUsed} a room · the category is ours to pick`
                            : adultsN < 1
                              ? "a count · put in the adults first"
                              : !agesComplete
                                ? "a count · put in every child's age first"
                                : "a count · the category is ours to pick"}
                        </span>
                      )}
                    </div>
                    <div className="field">
                      <label>Adults</label>
                      <input
                        className={`input${adultsN < 1 ? " invalid" : ""}`}
                        inputMode="numeric"
                        value={adults}
                        readOnly={isEdit && !editable}
                        onChange={(e) => setAdults(digits(e.target.value))}
                      />
                      {adultsN < 1 ? <span className="error">at least one adult</span> : null}
                    </div>
                    <div className="field">
                      <label>Children</label>
                      <input
                        className="input"
                        inputMode="numeric"
                        value={children}
                        readOnly={isEdit && !editable}
                        onChange={(e) => setChildren(digits(e.target.value, 2))}
                      />
                      <span className="hint">under {policy ? minAdult : "the adult age"}</span>
                    </div>
                    {childN > 0 ? (
                      <div className="wide field">
                        <label>Their age{childN === 1 ? "" : "s"}</label>
                        <div className="row-acts" style={{ alignItems: "flex-start" }}>
                          {ages.map((a, i) => {
                            const over = overAge.has(i);
                            const band = !over && adultBand.has(i);
                            return (
                              <span key={i} style={{ display: "grid", gap: 3, justifyItems: "start" }}>
                                <input
                                  className={`input narrow${over ? " invalid" : ""}`}
                                  style={band ? { borderColor: "var(--warning)" } : undefined}
                                  inputMode="numeric"
                                  aria-label={`Child ${i + 1}'s age`}
                                  aria-invalid={over || undefined}
                                  placeholder={`#${i + 1}`}
                                  value={a}
                                  readOnly={isEdit && !editable}
                                  onChange={(e) => {
                                    const v = digits(e.target.value);
                                    setAges((prev) => prev.map((x, j) => (j === i ? v : x)));
                                  }}
                                />
                                {over ? (
                                  <span className="meta" style={{ color: "var(--danger)" }}>
                                    an adult
                                  </span>
                                ) : band ? (
                                  <span className="meta warn-ink">adult rate</span>
                                ) : null}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                    <div className="wide">
                      <ChildChargeNote
                        ages={childN > 0 ? ages : []}
                        adultBand={childN > 0 ? adultBand : new Set()}
                        overAge={childN > 0 ? overAge : new Set()}
                        loaded={!!policy}
                        youngMax={youngMax}
                        childMax={childMax}
                        minAdult={minAdult}
                        adultMealPercent={policy?.mealPricing.adultPercent ?? null}
                        childMealPercent={policy?.mealPricing.childPercent ?? null}
                      />
                    </div>
                    {bedOptions.length ? (
                      <div className="wide field">
                        <label>Beds asked for · optional</label>
                        <div className="row-acts">
                          {bedOptions.map(({ type, count }) => (
                            <span
                              key={type}
                              className="chip count-in"
                              title={`The hotel can set up at most ${count} ${bedWord(type)} room${count === 1 ? "" : "s"}`}
                            >
                              {bedWord(type)}
                              <span className="qual">up to {count}</span>
                              <input
                                className="input"
                                inputMode="numeric"
                                placeholder="0"
                                aria-label={`${bedWord(type)} rooms asked for`}
                                value={beds[type] ?? ""}
                                readOnly={isEdit && !editable}
                                onChange={(e) => {
                                  const v = digits(e.target.value, 2);
                                  setBeds((prev) => ({ ...prev, [type]: v }));
                                }}
                              />
                            </span>
                          ))}
                        </div>
                        {bedShortfall ? (
                          <span className="error">
                            <Icon name="alert" />
                            The hotel cannot set up {plural(bedShortfall.asked, `${bedShortfall.types} room`)} — its beds allow at most {bedShortfall.stock}
                            {bedShortfall.pooled ? " (King and Twin rooms share the same beds)" : ""}.
                          </span>
                        ) : bedsOverRooms ? (
                          <span className="error">
                            <Icon name="alert" />
                            The beds add up to {plural(bedSum, "room")}, and the party allows at most {roomRange.max} — take some off or grow the party.
                          </span>
                        ) : (
                          <span className="hint">
                            {bedSum > 0
                              ? bedSum === roomsN
                                ? `adds up to ${plural(bedSum, "room")} — the room count · `
                                : `${bedSum} of the ${plural(roomsN, "room")} have a bed setup asked; the rest are ours to pick · `
                              : ""}
                            the exact King / Twin split is set at Arrival — here the house secures enough rooms of the right kind
                          </span>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="row-acts" style={{ marginTop: 10 }}>
                    <Button
                      kind="quiet"
                      compact
                      state="inert"
                      title="Whether the party is billed as a group is decided by its size when the lead is kept; a GM can change it on the booking"
                    >
                      Travelling as a party
                    </Button>
                    <Button kind="quiet" compact state="inert" title="Separate bills for each guest are not in the backend yet">
                      One bill each
                    </Button>
                    <Button kind="quiet" compact state="inert" title="A linked return stay is not in the backend yet">
                      Add a return stay
                    </Button>
                  </div>
                </StepCard>

                {/* ------------------------------------------------ rate and notes */}
                <StepCard title="Rate and notes">
                  {isEdit ? (
                    <span className="meta">The rate package and the notes are changed on the booking itself, under Rate and notes.</span>
                  ) : (
                    <div className="form2">
                      <div className="field">
                        <label>Rate package</label>
                        {!party ? (
                          <input className="input" readOnly value="Published rates" />
                        ) : packagesQuery.isLoading ? (
                          <input className="input" readOnly value="Reading their packages…" />
                        ) : !packages || packages.length === 0 ? (
                          <input className="input" readOnly value="The hotel's common package" />
                        ) : (
                          <select className="input" value={ratePackageId ?? ""} onChange={(e) => setRatePackageId(e.target.value || null)}>
                            {!packages.some((p) => p.isDefault) ? <option value="">— not chosen · pricing takes their newest —</option> : null}
                            {packages.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                                {p.isDefault ? " · their default" : ""} — {money(p.roomBaseRate, p.currency)} a night
                              </option>
                            ))}
                          </select>
                        )}
                        <span className="hint">
                          {!party
                            ? partyKind
                              ? "pick the agency or company and its packages follow"
                              : "carries the meal plan and the rate"
                            : !packages || packages.length === 0
                              ? `no package on file for ${party.displayName}`
                              : packages.length === 1
                                ? "the only package on file for them"
                                : `${packages.length} packages on file — the rate differs, so pick the one agreed`}
                        </span>
                      </div>
                      <div className="field">
                        <label>Meal plans priced</label>
                        <input
                          className="input"
                          readOnly
                          value={
                            chosenPackage
                              ? [
                                  chosenPackage.cpRate ? "CP" : null,
                                  chosenPackage.mapLunchRate ? "MAP + lunch" : null,
                                  chosenPackage.mapDinnerRate ? "MAP + dinner" : null,
                                  chosenPackage.apRate ? "AP" : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "none in the package"
                              : party
                                ? "from their package"
                                : "from the house tariff"
                          }
                        />
                        <span className="hint">each room&rsquo;s plan is chosen at Negotiation</span>
                      </div>
                      <div className="wide field">
                        <label>Notes</label>
                        <textarea
                          className="input"
                          rows={2}
                          maxLength={2000}
                          value={notes}
                          placeholder="anything the guest asked for"
                          onChange={(e) => setNotes(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                  {!isEdit ? (
                    <div style={{ marginTop: 8 }}>
                      <SystemLine>A duplicate check runs when you save — the same guest on overlapping dates</SystemLine>
                    </div>
                  ) : null}
                </StepCard>
              </div>

              {/* ------------------------------------------------ the house */}
              <div className="stack intake-right">
                <StepCard
                  title={datesSet ? `The house · ${fmtRange(checkIn, checkOut)}` : "The house"}
                  acts={
                    <Button
                      state={askingNow ? "working" : askReason || busy ? "inert" : "default"}
                      title={askReason ?? undefined}
                      workingLabel={navigating ? "Opening the booking…" : isEdit ? "Saving and asking…" : "Keeping the lead and asking…"}
                      onClick={() => run.mutate(true)}
                    >
                      {isEdit ? "Save and ask the house" : "Ask the house"}
                    </Button>
                  }
                >
                  <p className="meta">
                    {datesSet
                      ? "Ask the house — the free rooms for these dates appear on the booking while you are still on the phone."
                      : "Put in the dates and the rooms — the answer appears here while you are still on the phone."}
                  </p>
                  <p className="meta" style={{ marginTop: 6 }}>
                    {isEdit ? "The changes are saved first, then the house is asked again." : "Looking is recording: asking keeps the lead first — taken or not."}
                  </p>
                  {askReason && !busy ? (
                    <p className="meta warn-ink" style={{ marginTop: 6 }}>
                      {askReason}
                    </p>
                  ) : null}
                </StepCard>
              </div>
            </div>
          </StepCanvas>
        </div>

        <aside className="side">
          <div>
            <h4>Timers</h4>
            <div className="list">
              <span className="meta">nothing running</span>
            </div>
          </div>
          <div>
            <h4>What we told the guest, and what they said</h4>
            <div className="list">
              <span className="meta">nothing yet</span>
            </div>
          </div>
        </aside>
      </div>

      {dupe ? (
        <section className="card" style={{ margin: "0 20px 12px" }}>
          <h4>This guest already holds a booking over these nights</h4>
          <p className="sm" style={{ marginTop: 6 }}>
            {dupe.entryId ? <Link href={`/bookings/${dupe.entryId}`}>{dupe.entryId}</Link> : "Another booking"} overlaps these dates for the
            same guest. If it is the same stay, open that booking instead. If this is a deliberate second booking — another room for
            them, the tour leader&rsquo;s own night — the FOM goes ahead with a reason, kept on the record.
          </p>
          <div className="form2" style={{ marginTop: 8 }}>
            <div className="field">
              <label>What it is</label>
              <select className="input" value={dupeKind} onChange={(e) => setDupeKind(e.target.value as "ACKNOWLEDGE" | "DISMISS")}>
                <option value="ACKNOWLEDGE">A deliberate second booking</option>
                <option value="DISMISS">Not a duplicate — a different stay</option>
              </select>
            </div>
            <div className="field">
              <label>Why it goes ahead</label>
              <input className="input" value={dupeReason} placeholder="the tour leader's own room for the last night" onChange={(e) => setDupeReason(e.target.value)} />
            </div>
          </div>
          <div className="row-acts" style={{ marginTop: 8 }}>
            <Button
              state={busy ? "working" : fomHere && dupeReason.trim() ? "default" : "inert"}
              reason={!fomHere ? "Needs the FOM — a confirmed duplicate is theirs to resolve" : !dupeReason.trim() ? "say why it goes ahead" : undefined}
              workingLabel="Keeping the lead…"
              onClick={() => {
                dupeResolution.current = { resolution: dupeKind, reason: dupeReason.trim() };
                run.mutate(false);
              }}
            >
              Go ahead with this booking
            </Button>
          </div>
        </section>
      ) : null}

      <div className="gatebar">
        <GateList items={gate} />
        <div className="acts">
          <Button
            state={savingNow ? "working" : saveReason || busy ? "inert" : "default"}
            title={saveReason ?? undefined}
            workingLabel={navigating ? "Opening the booking…" : isEdit ? "Saving…" : "Keeping the lead…"}
            onClick={() => run.mutate(false)}
          >
            {primaryLabel}
          </Button>
          <span className={`control-note${saveReason ? " fault" : ""}`} style={{ margin: 0, textAlign: "right", maxWidth: 360 }}>
            {saveReason ?? (isEdit ? "saves the stay and returns to the booking" : "saves the lead and opens the booking; Take it then moves it on")}
          </span>
        </div>
      </div>
    </div>
  );
}
