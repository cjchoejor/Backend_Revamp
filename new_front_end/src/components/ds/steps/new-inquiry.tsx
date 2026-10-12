"use client";

/**
 * New inquiry — `/bookings/new` (SS03 step 1, "looking is recording"; prototype `screens.new`,
 * `V16.intakeCanvas`, `V16.intakeGate`).
 *
 * The five sections of the boss's journey mockup (2026-10-10), one after another: 1 the guest ·
 * 2 who is asking · 3 the stay — empty and editable here, each folding to a line as the desk
 * moves on to the next — then 4 the house and 5 wrap up, which wait: the house can only answer
 * once the lead exists (the search runs against a booking), and wrap up asks for what is still
 * missing once rooms are chosen there. "Start the inquiry · keep the lead" keeps it and opens
 * the booking, where the house is asked.
 *
 * Every rule of the old intake form (components/desk/inquiry/new-inquiry-form.tsx) is kept here:
 * the phone match, the channel mapping, the agency / company pick with its contact persons and
 * packages, the company context, the child bands, the room-count envelope and the hotel's
 * capacity, the bed stock, the hotel's day and the early guest save. A saved inquiry is changed
 * on the booking itself, section by section (2026-10-12 — the separate edit screen is gone, so
 * the step rail never leaves the desk). The figures that decide anything come from the backend;
 * nothing here adds money up.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { usePageTitle } from "@/hooks/use-page-title";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import { createEntry, getEntry } from "@/lib/api/entries";
import { guestFullName, searchGuestProfiles, type GuestProfileSummary } from "@/lib/api/guest-profiles";
import {
  captureCorporateContext,
  createInquiry,
  listRatePackagesLookup,
  type CoordinatorContact,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";
import { checkBedRequest, listRooms } from "@/lib/api/rooms";
import { bookingHref } from "@/components/ds/ui";
import { fmtRange, money, plural } from "@/lib/ds/format";
import { BOUNDARY_STEPS, PHASES, STEP_NAMES, STEP_NEEDS } from "@/lib/ds/steps";
import type { EntryDetail } from "@/types/api";
import { Choice, FlowTodo, StepCanvas, StepCard, StepFlow, anchorFor, atLeast, numberFlow, revealCard, toastRefusal } from "./kit";
import { ApiError } from "@/lib/api/client";
import {
  BED_ORDER,
  CHANNEL_OPTIONS,
  ChildChargeNote,
  GuestLine,
  PHONE_CODES,
  PartyContacts,
  PartySearch,
  PhoneInput,
  PickList,
  USE_TYPES,
  addNightsIso,
  bedWord,
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

// The guest card is a flow card, so its anchor is the flow's (the focus helper below reads it).
const GUEST_CARD_ID = anchorFor("caller");

const CALLER_TITLES = ["", "Mr", "Ms", "Mrs", "Dr", "Dasho", "Lyonpo", "Aum"];


export function NewInquiryCanvas() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session } = useSession();
  // The hotel's day, from the server — never the machine's. Null until it answers.
  const today = useHotelDay()?.today ?? null;

  /* ---------------------------------------------------------------- who is asking */
  // No default: the operator says how the booking reached us (the old form made it the first pick).
  const [channelKey, setChannelKey] = useState<ChannelKey | null>(null);
  // No default (2026-09-25, operator): the kind of stay is the desk's to pick, like how the
  // booking came in. It used to open on Leisure and a channel then re-filled it, so the field
  // read as answered before anyone had answered it. The intake gate already holds the submit.
  const [useType, setUseType] = useState<string>("");
  const [party, setParty] = useState<LookupPartyMatch | null>(null);
  // The agency / company person handling this booking — the booking's contact unless overridden.
  const [partyContact, setPartyContact] = useState<CoordinatorContact | null>(null);
  // Which negotiated package; null resolves the party's default, then the hotel's common one.
  const [ratePackageId, setRatePackageId] = useState<string | null>(null);
  // Policy 17 — a company booking records their reference and coordinator before it leaves Inquiry.
  const [corpRef, setCorpRef] = useState("");
  const [corpCoordinator, setCorpCoordinator] = useState("");

  /* ---------------------------------------------------------------- the guest */
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneCode, setPhoneCode] = useState(PHONE_CODES[0]);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  // The caller (2026-10-12): who rang, which is not always the guest. Title and name can wait for
  // Wrap up; a phone or an email cannot (an OTA booking needs neither).
  const [callerTitle, setCallerTitle] = useState("");
  const [onWhatsApp, setOnWhatsApp] = useState<boolean | null>(null);
  const [selectedGuest, setSelectedGuest] = useState<GuestProfileSummary | null>(null);
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

  /* ---------------------------------------------------------------- channel and party */
  const channel = channelDef(channelKey);
  const partyKind = channel?.party ?? null;
  const needsCorp = channel?.channel === "CORPORATE";

  // Land the cursor on the first field a pick opened: the agency search after "Came in as".
  const focusNext = useRef<"who" | "guest" | null>(null);
  useEffect(() => {
    const where = focusNext.current;
    if (!where) return;
    focusNext.current = null;
    const root = document.getElementById(where === "guest" ? GUEST_CARD_ID : anchorFor("asking"));
    root?.querySelector<HTMLElement>("input.input:not([disabled]):not([readonly]):not([type=date])")?.focus();
  }, [channelKey]);

  const pickChannel = (k: ChannelKey) => {
    if (k === channelKey) return;
    setChannelKey(k);
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
    if (needsCorp) return;
    setCorpRef("");
    setCorpCoordinator("");
  }, [needsCorp]);
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
    // Nothing is carried over from another party's list; while this one loads, wait.
    if (!party?.id) {
      setRatePackageId(null);
      return;
    }
    if (!packages) return;
    if (packages.length === 0) {
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
    if (!today || checkInDefaulted.current) return;
    checkInDefaulted.current = true;
    setCheckIn((cur) => cur || today);
  }, [today]);
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
  // The setups and their ceilings come from the live room registry: how many rooms can be made
  // up in each setup (any room can take any setup unless the admin console narrows it).
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
  // Whether the hotel can give every asked setup its own room is the SERVER's check — the same
  // one the booking is refused by on save — so the form never re-derives the rule.
  const bedRequestKey = JSON.stringify(bedRequest);
  const bedCheck = useQuery({
    queryKey: ["bed-request-check", bedRequestKey],
    queryFn: () => checkBedRequest(session!, bedRequest),
    enabled: !!session && bedSum > 0,
    placeholderData: (prev) => prev,
  });
  const bedShortfall =
    bedSum > 0 && bedCheck.data && !bedCheck.data.satisfiable ? { message: bedCheck.data.message ?? "" } : null;
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
  // Typing a known number surfaces the guest already on file.
  const phoneDigits = phoneNumber.replace(/\D/g, "");
  const [phoneTerm, setPhoneTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setPhoneTerm(phoneDigits), 350);
    return () => clearTimeout(t);
  }, [phoneDigits]);
  const phoneLookupOn = !selectedGuest && phoneTerm.length >= 4;
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
    // The stored number replaces the fragment typed to find them.
    if (g.phone) {
      const { code, number } = splitStoredPhone(g.phone);
      setPhoneCode(code);
      setPhoneNumber(number);
    }
    toast.success(`${guestFullName(g)} is on file — taken as the guest staying; Wrap up can change that`);
  };

  const fullPhone = phoneCode && phoneNumber.trim() ? `${phoneCode}${phoneNumber.trim()}` : "";
  // The caller's name (title left off — it reads as a salutation, not a name).
  const typedGuestName = `${firstName.trim()} ${lastName.trim()}`.trim();
  // A typed email the backend would refuse is a blocker here, not a "bad request" after the click.
  const emailBad = email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const isOta = channelKey === "OTA";
  // Someone must be reachable from the first call: a phone or an email (not on an OTA booking),
  // and "on WhatsApp?" answered whenever there is a phone.
  const callerReachable = !!fullPhone || !!email.trim() || isOta;
  const whatsAppAnswered = !fullPhone || onWhatsApp !== null;
  const guestOk = callerReachable && whatsAppAnswered && !emailBad;

  usePageTitle(typedGuestName || null, "New inquiry");

  /* ---------------------------------------------------------------- who is arriving */
  const arrivingFallbackName = partyContact?.name?.trim() || typedGuestName;
  const arrivingFallbackPhone = partyContact?.phone?.trim() || fullPhone || "";
  const arrivingFallbackWord = partyContact?.name?.trim()
    ? `${partyContact.name.trim()}${party ? ` at ${party.displayName}` : ""}`
    : typedGuestName
      ? `${typedGuestName}, the caller`
      : "the caller";

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
  if (!channel) saveBlockers.push("how they came in");
  // "What kind of stay" opens unanswered, and the backend refuses a booking without one — so the
  // button waits for it rather than sending a request that comes back "invalid".
  if (!useType) saveBlockers.push("what kind of stay it is");
  if (!callerReachable) saveBlockers.push("the caller's phone or email");
  else if (!whatsAppAnswered) saveBlockers.push("whether the caller's number is on WhatsApp");
  if (emailBad) saveBlockers.push("an email address that reads as one — or leave it empty");
  if (!corpComplete) saveBlockers.push("the company's reference and their coordinator");
  if (!partyOk && partyHow) saveBlockers.push(partyHow);
  if (dateProblem) saveBlockers.push(dateProblem);

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
    mutationFn: async (): Promise<EntryDetail> => {
      if (!session) throw new Error("Not signed in");
      const a = Math.max(1, adultsN);
      const c = Math.max(0, childN);
      const agesOut = c > 0 && parsedAges.length === c ? parsedAges : undefined;

      if (!channel) throw new Error("Say how they came in first");
      // The guest staying is named at Wrap up (2026-10-12) — unless the caller's number found a
      // guest already on file, who is taken as the guest until Wrap up says otherwise.
      const guestProfileId = selectedGuest?.id ?? null;
      const inquiryBody = {
        guestProfileId,
        caller: {
          title: callerTitle || null,
          firstName: firstName.trim() || null,
          lastName: lastName.trim() || null,
          phone: fullPhone || null,
          email: email.trim() || null,
          onWhatsApp: fullPhone ? onWhatsApp : null,
        },
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
      const entry = await createEntry(session, {
        inquiryId,
        useType,
        guestProfileId: guestProfileId ?? undefined,
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
      return entry;
    },
    onSuccess: (entry) => {
      const id = entry.id;
      for (const k of [["entry", id], ["entries"], ["desk-bookings"], ["entry-trace", id], ["entry-timers", id], ["inquiry", entry.inquiryId]]) {
        void queryClient.invalidateQueries({ queryKey: k });
      }
      // Warm the booking while the route loads, with the house's answer already in it.
      if (session) void queryClient.prefetchQuery({ queryKey: ["entry", id], queryFn: () => getEntry(session, id) });
      toast.success(`${id} kept · the lead is on record`);
      setNavigating(true);
      router.push(bookingHref(id));
    },
    onError: (e) => {
      const body = e instanceof ApiError ? e.body : undefined;
      if (body?.blockingCondition === "DUPLICATE_INQUIRY_CONFIRMED") {
        const det = (body.details ?? {}) as { conflictingEntryId?: string };
        setDupe({ entryId: det.conflictingEntryId ?? null });
        dupeResolution.current = null;
        return;
      }
      toastRefusal(e, "The inquiry could not be started");
    },
  });
  const busy = run.isPending || navigating;

  /* ---------------------------------------------------------------- the gate */
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
  const guestLineLabel = "The caller · a phone or an email";
  // The checklist, in the order the page is worked; the side panel numbers it onto the cards
  // (2026-09-25 — it sat at the foot of the page as a bare list). The house is asked on the
  // booking, once the lead is kept, so that item belongs to the booking's own list.
  // In the order of the boss's journey mockup (2026-10-10): the guest first, then who is asking,
  // then the stay.
  const flowItems = numberFlow([
    { label: guestLineLabel, met: guestOk, card: "caller" },
    { label: "Source channel", met: !!channelKey, card: "asking" },
    { label: "Use type", met: !!useType, card: "asking" },
    ...(needsCorp ? [{ label: "The company's reference and coordinator", met: corpComplete, card: "asking" }] : []),
    { label: "Dates set", met: datesSet && !dateProblem, card: "stay" },
    { label: "Rooms and guests set", met: roomsGuestsSet, card: "stay" },
  ], { bySection: true });
  // What the system does on save — no card to go to, so listed apart.
  const flowAlso = [
    { label: useTypeReq.label, met: useTypeReq.met },
    { label: "Custodian assigned · on save", met: true },
    { label: "No duplicate found · runs on save", met: true },
  ];
  const nextUp = flowItems.find((i) => !i.met) ?? null;
  const goToCard = (card?: string) => {
    if (!card) return;
    const el = document.getElementById(anchorFor(card));
    if (el) revealCard(el);
  };

  const primaryLabel = "Done · Start the inquiry";
  const saveReason = saveBlockers.length ? `first: ${saveBlockers.join(" · ")}` : null;

  /* ---------------------------------------------------------------- render */
  return (
    <div className="ws">
      <div className="ws-head">
        <div>
          <Link href="/bookings" className="backlink">
            <Icon name="chev" /> Back to Bookings
          </Link>
          <div className="who">
            <h2 className="ink-2">New inquiry</h2>
          </div>
          <div className="facts">
            <span className="meta">There is no other way to see whether rooms are free: looking is recording. The lead is kept — taken or not.</span>
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
          <StepCanvas past={false}>
            <StepFlow items={flowItems} on fold="on-move">
              <div className="stack">
                {/* ------------------------------------------------ the caller */}
                {/* Who rang (2026-10-12, operator, after the journey mockup): the guest, or an
                    agency's person, a company's assistant, a VIP's secretary. The guest STAYING is
                    named at Wrap up — the caller by default, or someone else. */}
                <StepCard
                  flow="caller"
                  title="The caller"
                  summary={
                    (
                      <>
                        <b>{[callerTitle, firstName.trim(), lastName.trim()].filter(Boolean).join(" ") || "name to come"}</b>
                        {fullPhone ? <> · {fullPhone}{onWhatsApp === true ? " · on WhatsApp" : onWhatsApp === false ? " · not on WhatsApp" : ""}</> : null}
                        {email.trim() ? <> · {email.trim()}</> : null}
                        {isOta && !fullPhone && !email.trim() ? <> · OTA booking</> : null}
                        {selectedGuest ? <> · on file as {guestFullName(selectedGuest)}</> : null}
                      </>
                    )
                  }
                >
                  {(
                    <div className="form2">
                      <label className="wide sm ink-2" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          type="checkbox"
                          checked={isOta}
                          onChange={(e) => {
                            if (e.target.checked) setChannelKey("OTA");
                            else if (channelKey === "OTA") setChannelKey(null);
                          }}
                        />
                        <b>OTA booking</b>
                        <span className="meta">— it comes through the OTA, so the phone and email can wait</span>
                      </label>
                      <div className="field">
                        <label>Phone</label>
                        <PhoneInput code={phoneCode} setCode={setPhoneCode} number={phoneNumber} setNumber={setPhoneNumber} />
                        <span className={`hint${!callerReachable ? " warn-ink" : ""}`}>
                          {callerReachable ? "typing it finds a guest already on file" : "a phone or an email is needed to start"}
                        </span>
                      </div>
                      <div className="field">
                        <label>Email</label>
                        <input className="input" type="email" value={email} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} />
                        <span className={`hint${emailBad ? " stop-ink" : !callerReachable ? " warn-ink" : ""}`}>
                          {emailBad ? "that does not read as an email address" : callerReachable ? "optional when there is a phone" : "or the email"}
                        </span>
                      </div>
                      {fullPhone ? (
                        <div className="wide field">
                          <label>On WhatsApp?</label>
                          <Choice
                            options={[
                              ["YES", "Yes"],
                              ["NO", "No"],
                            ]}
                            value={onWhatsApp === null ? null : onWhatsApp ? "YES" : "NO"}
                            onChange={(v) => setOnWhatsApp(v === "YES")}
                          />
                          <span className={`hint${onWhatsApp === null ? " warn-ink" : ""}`}>
                            {onWhatsApp === null ? "ask — the quote and the confirmation can go there" : "the quote and the confirmation can go there"}
                          </span>
                        </div>
                      ) : null}
                      {phoneMatches.length > 0 ? (
                        <div className="wide">
                          <PickList
                            head={`${phoneMatches.length === 1 ? "A guest" : "Guests"} on file with this number`}
                            rows={phoneMatches.map((g) => ({ key: g.id, main: <GuestLine guest={g} />, onPick: () => adoptGuest(g) }))}
                          />
                        </div>
                      ) : null}
                      {selectedGuest ? (
                        <div className="wide bind bound" style={{ display: "grid", gap: 6 }}>
                          <span className="sm">
                            <Icon name="check" /> <GuestLine guest={selectedGuest} />
                          </span>
                          <div className="row-acts">
                            <span className="meta">on file — taken as the guest staying; Wrap up can name someone else</span>
                            <Button kind="quiet" compact onClick={() => setSelectedGuest(null)}>
                              Not this guest
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      <div className="wide" style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3) var(--s4)" }}>
                        <div className="field">
                          <label>Title</label>
                          <select className="input" value={callerTitle} onChange={(e) => setCallerTitle(e.target.value)}>
                            {CALLER_TITLES.map((t) => (
                              <option key={t} value={t}>
                                {t || "—"}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label>First name</label>
                          <input className="input" value={firstName} placeholder="can wait for Wrap up" onChange={(e) => setFirstName(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>Last name</label>
                          <input className="input" value={lastName} placeholder="can wait for Wrap up" onChange={(e) => setLastName(e.target.value)} />
                        </div>
                      </div>
                    </div>
                  )}
                </StepCard>

                {/* ------------------------------------------------ who is asking */}
                <StepCard
                  title="Who is asking"
                  flow="asking"
                  flowAfter="caller"
                  summary={
                    <>
                      <b>{channel?.label ?? "—"}</b>
                      {party ? <> — {party.displayName}</> : null}
                      {chosenPackage ? <> · {chosenPackage.name}</> : party ? null : <> · published rates</>}
                      {useType ? <> · {USE_TYPES.find(([k]) => k === useType)?.[1] ?? useType}</> : null}
                      {needsCorp && corpRef.trim() ? <> · {corpRef.trim()}</> : null}
                    </>
                  }
                >
                  <div className="form2">
                    <div className="wide field">
                      <label>Came in as</label>
                      <Choice options={CHANNEL_OPTIONS} value={channelKey} onChange={pickChannel} />
                      <span className={`hint${!channelKey ? " warn-ink" : ""}`}>
                        {channelKey
                            ? "it decides what the rest of this form asks for"
                            : "pick one — it decides what the rest of this form asks for"}
                      </span>
                    </div>

                    {partyKind ? (
                      <>
                        <PartySearch kind={partyKind} party={party} setParty={setParty} />
                        {party ? (
                          <PartyContacts kind={partyKind} party={party} setParty={setParty} contact={partyContact} setContact={setPartyContact} />
                        ) : null}
                      </>
                    ) : null}

                    {/* Which of their rates was agreed belongs WITH the party, not four cards down
                        (2026-09-29, operator: the packages "never show" — they were at the foot of
                        the page, in Rate and notes, long after the agency was picked). An agency
                        like Bhutan INC carries Season · Off season · Premium, and the rate differs
                        between them, so the choice is made where the eye already is. */}
                    {true ? (
                      <>
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
                      </>
                    ) : null}

                    {needsCorp ? (
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
                        onChange={(v) => setUseType(v)}
                      />
                      {useType === "APARTMENT" ? (
                        <span className="hint warn-ink">an apartment needs its nights and rate tier before Negotiation — those are not on the desk yet</span>
                      ) : useType === "CONFERENCE" ? (
                        <span className="hint">the hall and its seating are added on the booking</span>
                      ) : null}
                    </div>
                  </div>
                </StepCard>

                {/* ------------------------------------------------ the stay */}
                <StepCard
                  title="The stay"
                  flow="stay"
                  flowAfter="caller"
                  doneAction={{
                    label: primaryLabel,
                    onClick: () => run.mutate(),
                    state: busy ? "working" : saveReason ? "inert" : "default",
                    title: saveReason ?? undefined,
                    workingLabel: navigating ? "Opening the booking…" : "Keeping the lead…",
                  }}
                  summary={
                    <>
                      <b>{datesSet ? fmtRange(checkIn, checkOut) : "no dates"}</b>
                      {datesSet ? <> · {plural(stayNights, "night")}</> : null} · {plural(adultsN, "adult")}
                      {childN > 0 ? <>, {plural(childN, "child", "children")}{agesComplete ? ` (${ages.join(", ")})` : ""}</> : null} ·{" "}
                      {plural(roomsN, "room")}
                      {bedSum > 0 ? <> · {Object.entries(bedRequest).map(([t, n]) => `${n} ${bedWord(t)}`).join(" + ")} asked</> : null}
                    </>
                  }
                >
                  <div className="form3">
                    <div className="field">
                      <label>Check-in</label>
                      <input
                        className={`input${checkInPast ? " invalid" : ""}`}
                        type="date"
                        value={checkIn}
                        min={today ?? undefined}
                        onChange={(e) => setCheckIn(e.target.value)}
                        onBlur={() => {
                          if (today && checkIn && checkIn < today) setCheckIn(today);
                        }}
                      />
                      <span className={`hint${dateProblem ? " warn-ink" : ""}`}>
                        {dateProblem ?? (today ? "from today at the hotel" : "checking today's date at the hotel…")}
                      </span>
                    </div>
                    {/* The nights sit between the two dates, as on the boss's mockup (2026-10-10). */}
                    <div className="field">
                      <label>Nights</label>
                      <input
                        className="input"
                        inputMode="numeric"
                        value={nights}
                        placeholder="1"
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
                        onChange={(e) => onCheckOut(e.target.value)}
                        onBlur={() => {
                          if (checkIn && checkOut && diffNightsIso(checkIn, checkOut) < 1) onCheckOut(addNightsIso(checkIn, 1));
                        }}
                      />
                      {datesSet ? <span className="hint">{`${fmtRange(checkIn, checkOut)} · ${plural(stayNights, "night")}`}</span> : null}
                    </div>
                    <div className="field">
                      <label>Adults</label>
                      <input
                        className={`input${adultsN < 1 ? " invalid" : ""}`}
                        inputMode="numeric"
                        value={adults}
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
                        onChange={(e) => setChildren(digits(e.target.value, 2))}
                      />
                      <span className="hint">under {policy ? minAdult : "the adult age"}</span>
                    </div>
                    <div className="field">
                      <label>Rooms</label>
                      <select
                        className="input"
                        value={rooms}
                        disabled={allowedRooms.length === 0}
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
                            The hotel cannot set up these beds — {bedShortfall.message}.
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
                            a tally — which room is which is settled on the table at Negotiation, where it is shared out from this ask
                          </span>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="field" style={{ marginTop: 12 }}>
                    <label>The guest&rsquo;s preference · optional</label>
                    <textarea
                      className="input"
                      rows={2}
                      maxLength={2000}
                      value={notes}
                      placeholder="e.g. high floor, quiet room, honeymoon — allergic to nuts"
                      onChange={(e) => setNotes(e.target.value)}
                    />
                    <span className="hint">kept on the booking, under Guest requests — notes and to-dos go in its Notes tab</span>
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
                    <Button
                      kind="quiet"
                      compact
                      state="inert"
                      title="Keep this stay first, then add the return stay from the booking — it goes on the same enquiry"
                    >
                      Add a return stay
                    </Button>
                  </div>
                </StepCard>

              {/* ------------------------------------------------ the house */}
                <StepCard
                  flow="house"
                  title={datesSet ? `The house · ${fmtRange(checkIn, checkOut)}` : "The house"}
                  heldFor={
                    <>
                      <b>{primaryLabel}</b> — the house is asked on the booking, where the free rooms for these dates and what they cost,
                      night by night and for the stay, appear while you are still on the phone.
                      {nextUp ? (
                        <span className="warn-ink"> Still to fill: {flowItems.filter((i) => !i.met).map((i) => `${i.n} ${i.label}`).join(" · ")}.</span>
                      ) : null}
                    </>
                  }
                />

                {/* ------------------------------------------------ wrap up */}
                <StepCard
                  title="Wrap up"
                  heldFor={
                    <>
                      the rooms are chosen on the booking — then it names the guest who is staying (the caller, or someone else), takes the
                      caller&rsquo;s name if it was not given here, and who is arriving. A booking moves on to Negotiation only once the guest
                      staying is named.
                    </>
                  }
                >
                  <div className="form2 rule-above">
                    <div className="field">
                      <label>Who is arriving · name</label>
                      <input
                        className="input"
                        value={arrivingName}
                        placeholder={`blank — ${arrivingFallbackWord}`}
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
                        placeholder={arrivingFallbackPhone ? `blank — ${arrivingFallbackPhone}` : "+975 …"}
                        onChange={(e) => setArrivingPhone(e.target.value)}
                      />
                      <span className="hint">needed before arrival</span>
                    </div>
                  </div>
                </StepCard>
              </div>
            </StepFlow>
          </StepCanvas>
        </div>

        <aside className="side">
          <div>
            <h4>Timers</h4>
            <div className="list">
              <span className="meta">nothing running</span>
            </div>
          </div>
          <FlowTodo items={flowItems} also={flowAlso} onGo={goToCard} />
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
                run.mutate();
              }}
            >
              Go ahead with this booking
            </Button>
          </div>
        </section>
      ) : null}

      <div className="gatebar">
        {/* The list is in the side panel, numbered; the bar says what is next and takes you to it. */}
        <div className="gate">
          {nextUp ? (
            <button type="button" className="item unmet" onClick={() => goToCard(nextUp.card)}>
              <Icon name="circle" />
              <span>
                Next · <b>{nextUp.n}</b> {nextUp.label}
              </span>
            </button>
          ) : flowAlso.some((p) => !p.met) ? (
            <div className="item unmet">
              <Icon name="circle" />
              <span>{flowAlso.find((p) => !p.met)?.label}</span>
            </div>
          ) : (
            <button type="button" className="item met" onClick={() => goToCard("stay")}>
              <Icon name="check" />
              <span>everything the inquiry needs is here — start it from The stay</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
