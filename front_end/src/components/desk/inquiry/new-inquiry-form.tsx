"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Briefcase,
  Building2,
  ChevronLeft,
  DoorOpen,
  Globe,
  PhoneCall,
  Plane,
  Plus,
  RotateCcw,
  Search,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  createGuestProfile,
  guestFullName,
  searchGuestProfiles,
  type GuestProfileSummary,
} from "@/lib/api/guest-profiles";
import {
  captureCorporateContext,
  createInquiry,
  getInquiry,
  searchCorporateAccountsLookup,
  searchTravelAgentsLookup,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";
import { createEntry, getEntry, updateEntryIntake } from "@/lib/api/entries";
import { getChildPolicy, getAllowedRoomCounts } from "@/lib/api/child-policy";
import { BackendRail, type RailGroup } from "@/components/desk/workspace/backend-inline";
import { DateField, nextDayIso } from "@/components/desk/date-field";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";

const BK = STAGE_ACTIONS.INTAKE;

type IntakeMode = "new" | "returning";
type PartyKind = "TRAVEL_AGENT" | "CORPORATE";

/** "Came in as" — UI options in the requested order, each mapped to a backend-valid sourceChannel. */
const CHANNELS = [
  { key: "WALKIN", label: "Walk-in", channel: "WALK_IN", note: "" },
  { key: "DIRECT_ONLINE", label: "Direct online", channel: "DIRECT", note: "Direct (online)" },
  { key: "DIRECT_VOICE", label: "Direct voice", channel: "DIRECT", note: "Direct (voice)" },
  { key: "OTA", label: "OTA", channel: "OTA", note: "" },
  { key: "CORPORATE", label: "Corporation", channel: "CORPORATE", note: "", party: "CORPORATE" as PartyKind },
  { key: "AGENT", label: "Travel agent", channel: "AGENT", note: "", party: "TRAVEL_AGENT" as PartyKind },
  { key: "GROUP_MICE", label: "Group / MICE", channel: "DIRECT", note: "Group / MICE", useType: "GROUP" },
] as const;

type ChannelKey = (typeof CHANNELS)[number]["key"];

/**
 * Presentation metadata for the "Came in as" first step — one icon + one-line blurb per channel,
 * grouped so the receptionist reads the whole list at a glance. The channel behaviour itself
 * (sourceChannel / party / useType) still lives on CHANNELS above; this only decorates it.
 */
const CHANNEL_META: Record<ChannelKey, { icon: React.ComponentType<{ size?: number; className?: string }>; blurb: string }> = {
  WALKIN: { icon: DoorOpen, blurb: "Guest arrived at the desk" },
  DIRECT_ONLINE: { icon: Globe, blurb: "Booked through our own site or email" },
  DIRECT_VOICE: { icon: PhoneCall, blurb: "Phoned or messaged us directly" },
  OTA: { icon: Plane, blurb: "Booking.com, Agoda and other OTAs" },
  CORPORATE: { icon: Building2, blurb: "Billed to a company account" },
  AGENT: { icon: Briefcase, blurb: "Booked via a travel agent" },
  GROUP_MICE: { icon: Users, blurb: "Group block, meeting or event" },
};

/** The three buckets the type cards are grouped under on the first step. */
const CHANNEL_GROUPS: { label: string; keys: ChannelKey[] }[] = [
  { label: "Individual guest", keys: ["WALKIN", "DIRECT_ONLINE", "DIRECT_VOICE", "OTA"] },
  { label: "Partner / account", keys: ["CORPORATE", "AGENT"] },
  { label: "Group", keys: ["GROUP_MICE"] },
];

const PHONE_CODES = ["+975", "+91", "+61"];
const NATIONALITIES = ["Bhutanese", "Indian"];

function isoDate(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
}

/**
 * One guest in a pick list. The phone always shows next to the name — a receptionist keying a
 * number needs to see the number they matched on, and two guests can share a name where they
 * can't share a handset. Email trails behind as the secondary detail.
 */
function GuestLine({ guest }: { guest: GuestProfileSummary }) {
  return (
    <span>
      <b>{guestFullName(guest)}</b>
      {guest.phone && (
        <span className="mono" style={{ marginLeft: 8, color: "var(--ink-2)" }}>
          {guest.phone}
        </span>
      )}
      {guest.email && <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>· {guest.email}</span>}
    </span>
  );
}

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}

/** A preset dropdown with a "+" button that swaps in a free-text input for other values. */
function PresetOrCustom({
  presets,
  value,
  onChange,
  customPlaceholder,
  selectStyle,
}: {
  presets: string[];
  value: string;
  onChange: (v: string) => void;
  customPlaceholder: string;
  selectStyle?: React.CSSProperties;
}) {
  const [custom, setCustom] = useState(!presets.includes(value) && value !== "");
  if (custom) {
    return (
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="dinput"
          placeholder={customPlaceholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={selectStyle}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="Back to list"
          onClick={() => {
            setCustom(false);
            onChange(presets[0]);
          }}
        >
          <RotateCcw style={{ width: 13, height: 13 }} />
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        {presets.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        title="Other"
        onClick={() => {
          setCustom(true);
          onChange("");
        }}
      >
        <Plus style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
}

/** Debounced search + pick for a single party kind (travel agent or corporate). */
function PartySearch({
  kind,
  party,
  setParty,
}: {
  kind: PartyKind;
  party: LookupPartyMatch | null;
  setParty: (p: LookupPartyMatch | null) => void;
}) {
  const { session } = useSession();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const results = useQuery({
    queryKey: ["desk-party-lookup", kind, debounced],
    queryFn: () =>
      kind === "TRAVEL_AGENT"
        ? searchTravelAgentsLookup(session!, debounced)
        : searchCorporateAccountsLookup(session!, debounced),
    enabled: !!session && debounced.trim().length >= 2,
  });

  const noun = kind === "TRAVEL_AGENT" ? "travel agent" : "corporate account";

  if (party) {
    return (
      <div className="field">
        <label>{kind === "TRAVEL_AGENT" ? "Travel agent" : "Corporate account"}</label>
        <div className="pickrow sel" style={{ borderRadius: "var(--r-md)", border: "1.5px solid var(--terra)" }}>
          <span>
            <b>{party.displayName}</b>
            {party.contactEmail && <span style={{ color: "var(--ink-3)" }}> · {party.contactEmail}</span>}
          </span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setParty(null)}>
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label>Select {noun}</label>
      <div style={{ position: "relative" }}>
        <Search style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--ink-3)" }} />
        <input className="dinput" style={{ paddingLeft: 32 }} placeholder={`Search ${noun}s by name…`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {debounced.trim().length >= 2 && (
        <div className="picklist" style={{ marginTop: 7 }}>
          {results.isLoading ? (
            <div className="pickempty">Searching…</div>
          ) : (results.data?.matches ?? []).length === 0 ? (
            <div className="pickempty">No matches</div>
          ) : (
            results.data!.matches.map((m) => (
              <button key={m.id} type="button" className="pickrow" onClick={() => setParty(m)}>
                <span>
                  <b>{m.displayName}</b>
                  {m.contactEmail && <span style={{ color: "var(--ink-3)" }}> · {m.contactEmail}</span>}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function DeskNewInquiryForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session } = useSession();
  // Edit mode: `?edit=<entryId>` opens this same "Start a booking" page pre-filled with an existing
  // booking. Only the stay fields (dates / composition / rooms) are editable — the guest identity
  // and "Came in as" live on the inquiry/guest and have no update endpoint, so they show read-only.
  // Saving PATCHes the entry (S1-only server-side) rather than creating a new one.
  const searchParams = useSearchParams();
  const editEntryId = searchParams.get("edit");
  const isEdit = !!editEntryId;

  // Two-step intake: pick "Came in as" first, then fill the tailored details form. The channel
  // still lives in `channelKey` below — this only gates which screen renders. Editing skips the
  // type picker (the channel can't change) and lands straight on the details form.
  const [wizardStep, setWizardStep] = useState<"type" | "details">(isEdit ? "details" : "type");
  const [mode, setMode] = useState<IntakeMode>("new");

  // New-guest fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneCode, setPhoneCode] = useState(PHONE_CODES[0]);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [nationality, setNationality] = useState(NATIONALITIES[0]);

  // Returning / adopted existing guest
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedGuest, setSelectedGuest] = useState<GuestProfileSummary | null>(null);

  // Inquiry & stay
  const [channelKey, setChannelKey] = useState<ChannelKey>("WALKIN");
  const [party, setParty] = useState<LookupPartyMatch | null>(null);
  // Policy 17 / SIG-S1 §100.6 — CORPORATE bookings must record a client reference + coordinator
  // on the inquiry, else the entry can't exit S1. Captured here at intake.
  const [corpClientRef, setCorpClientRef] = useState("");
  const [corpCoordinator, setCorpCoordinator] = useState("");
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  // One age per child, synced to the children count. Drives the child policy + CNB pricing.
  const [childAges, setChildAges] = useState<string[]>([]);
  // How many rooms the party needs. Driven purely by chargeable-occupant count (adults +
  // children old enough to need their own bed) vs the hotel's largest room capacity — NOT
  // by the source channel. A walk-in family of 5 gets the same multi-room option a travel
  // agent would. Kept in-range by the effect below.
  const [numberOfRooms, setNumberOfRooms] = useState("1");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [today, setToday] = useState("");
  const [notes, setNotes] = useState("");

  // --- Edit-mode data load + one-time pre-fill ---
  const editEntryQuery = useQuery({
    queryKey: ["entry", editEntryId],
    queryFn: () => getEntry(session!, editEntryId!),
    enabled: !!session && isEdit,
  });
  const editEntry = editEntryQuery.data ?? null;
  const editInquiryQuery = useQuery({
    queryKey: ["inquiry", editEntry?.inquiryId],
    queryFn: () => getInquiry(session!, editEntry!.inquiryId),
    enabled: !!session && isEdit && !!editEntry?.inquiryId,
  });
  const editGuest =
    editEntry?.guestProfile ?? editEntry?.inquiry?.guestProfile ?? editInquiryQuery.data?.guestProfile ?? null;
  const editChannel = editInquiryQuery.data?.sourceChannel ?? null;
  // Best-effort reverse map of the stored sourceChannel back to a "Came in as" option, so the
  // (read-only) select shows the original choice. DIRECT maps to several UI options; the first
  // match is close enough for a disabled display.
  const editChannelKey = CHANNELS.find((c) => c.channel === editChannel)?.key ?? "WALKIN";
  const editInited = useRef(false);
  useEffect(() => {
    if (!isEdit || !editEntry || editInited.current) return;
    setAdults(String(editEntry.adultCount ?? editEntry.guestCount ?? 1));
    setChildren(String(editEntry.childCount ?? 0));
    setChildAges((editEntry.childAges ?? []).map(String));
    setNumberOfRooms(String(editEntry.numberOfRooms ?? 1));
    setCheckIn(editEntry.checkInDate?.slice(0, 10) ?? "");
    setCheckOut(editEntry.checkOutDate?.slice(0, 10) ?? "");
    editInited.current = true;
  }, [isEdit, editEntry]);

  const channel = useMemo(() => CHANNELS.find((c) => c.key === channelKey)!, [channelKey]);
  const partyKind = "party" in channel ? (channel.party as PartyKind) : null;
  // Corporate bookings require the client-ref / coordinator context (Policy 17).
  const needsCorporateContext = channel.channel === "CORPORATE";

  // Default dates client-side (today / tomorrow) to avoid SSR hydration mismatch. In edit mode we
  // keep the loaded booking's own dates — only `today` (the date-field floor) is still set.
  useEffect(() => {
    const t = new Date();
    setToday(isoDate(t));
    if (isEdit) return;
    setCheckIn(isoDate(t));
    setCheckOut(isoDate(new Date(t.getTime() + 86_400_000)));
  }, [isEdit]);

  // Check-out follows check-in: picking a check-in date moves check-out to the next day, since the
  // shortest stay is one night. A check-out the operator has already pushed further out survives —
  // only a date that would now be on or before the new check-in gets pulled forward.
  useEffect(() => {
    if (!checkIn) return;
    const earliest = nextDayIso(checkIn);
    if (!earliest) return;
    setCheckOut((prev) => (!prev || prev < earliest ? earliest : prev));
  }, [checkIn]);

  // Reset party selection when channel changes away from agent/corporate.
  useEffect(() => {
    if (!partyKind) setParty(null);
  }, [partyKind]);

  // Clear the corporate context when the channel no longer needs it.
  useEffect(() => {
    if (!needsCorporateContext) {
      setCorpClientRef("");
      setCorpCoordinator("");
    }
  }, [needsCorporateContext]);

  // Inherit the client reference + coordinator from the picked corporate account (spec §2.6.2):
  // when the account carries contractRefs / coordinators, default to the first of each. Accounts
  // with none fall through to manual free-text entry.
  useEffect(() => {
    if (partyKind !== "CORPORATE" || !party) return;
    const refs = party.contractRefs ?? [];
    const coords = party.coordinators ?? [];
    if (refs.length > 0) setCorpClientRef(refs[0]);
    if (coords.length > 0) setCorpCoordinator(coords[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.id]);

  // Keep the child-ages list length in step with the children count.
  const childCountNum = Math.max(0, parseInt(children || "0", 10) || 0);
  useEffect(() => {
    setChildAges((prev) => {
      const next = prev.slice(0, childCountNum);
      while (next.length < childCountNum) next.push("");
      return next;
    });
  }, [childCountNum]);

  // Live child-policy snapshot — caps the child-age inputs at the configured
  // unaccompanied-minor age (a guest at/above it is an adult). Follows L4 admin edits.
  const childPolicyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
  });
  const minAdultAge = childPolicyQuery.data?.unaccompaniedMinor.minimumAge ?? 18;
  const maxChildAge = Math.max(0, minAdultAge - 1);
  const agesComplete =
    childCountNum === 0 ||
    (childAges.length === childCountNum &&
      childAges.every((a) => a.trim() !== "" && Number(a) >= 0 && Number(a) <= maxChildAge));

  // Chargeable occupants + the allowed room-count envelope, computed by the backend so intake
  // offers exactly the values the S1/S2 validation will accept (replaces the removed frontend
  // `chargeable-occupants` mirror — the backend now owns this math for every UI). maxCapacity
  // is omitted, so the endpoint uses its default divisor of 3; that's ≤ the hotel's largest
  // room capacity, so the dropdown never offers a room count the create-entry check would reject.
  const adultsNum = Math.max(0, parseInt(adults || "0", 10) || 0);
  const parsedChildAges = childAges.map((a) => parseInt(a || "", 10)).filter((n) => Number.isFinite(n));
  const roomCountsQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", adultsNum, parsedChildAges.join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: adultsNum, childAges: parsedChildAges }),
    enabled: !!session && adultsNum > 0 && agesComplete,
  });
  const chargeableOccupants = roomCountsQuery.data?.chargeableOccupants ?? adultsNum;
  const largestMaxCapacity = roomCountsQuery.data?.maxCapacityUsed ?? 3;
  const roomRange = roomCountsQuery.data?.allowedRoomCounts ?? { min: adultsNum > 0 ? 1 : 0, max: adultsNum };
  const allowedRoomCounts = useMemo(
    () =>
      roomRange.min > 0 && roomRange.max >= roomRange.min
        ? Array.from({ length: roomRange.max - roomRange.min + 1 }, (_, i) => roomRange.min + i)
        : [],
    [roomRange.min, roomRange.max],
  );

  // Keep numberOfRooms valid when the composition changes upstream (e.g. adults drop 3 → 1,
  // so the allowed max drops to 1 and a stale "2" must snap back to the first valid value).
  useEffect(() => {
    if (allowedRoomCounts.length === 0) return;
    const n = parseInt(numberOfRooms || "0", 10) || 0;
    if (!allowedRoomCounts.includes(n)) setNumberOfRooms(String(allowedRoomCounts[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedRoomCounts]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // --- Returning-guest search (explicit) ---
  const returningSearch = useQuery({
    queryKey: ["desk-guest-profiles", debouncedSearch],
    queryFn: () => searchGuestProfiles(session!, debouncedSearch, 20),
    enabled: !!session && mode === "returning" && (debouncedSearch.length === 0 || debouncedSearch.length >= 2),
  });

  // --- New-mode phone auto-match: typing a known number surfaces the existing guest ---
  const phoneDigits = phoneNumber.replace(/\D/g, "");
  const [debouncedPhone, setDebouncedPhone] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPhone(phoneDigits), 350);
    return () => clearTimeout(t);
  }, [phoneDigits]);
  const phoneMatch = useQuery({
    queryKey: ["desk-guest-phone", debouncedPhone],
    queryFn: () => searchGuestProfiles(session!, debouncedPhone, 5),
    enabled: !!session && mode === "new" && !selectedGuest && debouncedPhone.length >= 4,
  });
  const phoneMatches = phoneMatch.data?.items ?? [];

  const adoptGuest = (g: GuestProfileSummary) => {
    setSelectedGuest(g);
    setFirstName(g.firstName);
    setLastName(g.lastName);
    setEmail(g.email ?? "");
    if (g.nationality) setNationality(g.nationality);
    toast.success(`Using existing guest: ${g.firstName} ${g.lastName}`);
  };

  const fullPhone = phoneCode && phoneNumber.trim() ? `${phoneCode}${phoneNumber.trim()}` : "";

  const canSubmitNew = !!(
    selectedGuest ||
    (firstName.trim() && lastName.trim() && phoneNumber.trim() && nationality.trim())
  );
  const corporateContextComplete = !needsCorporateContext || (corpClientRef.trim() !== "" && corpCoordinator.trim() !== "");
  const canSubmit = isEdit
    ? // Editing an existing booking: guest + channel are fixed, so only the stay fields gate the save.
      !!editEntry && agesComplete && !!checkIn && !!checkOut
    : (mode === "new" ? canSubmitNew : !!selectedGuest) && agesComplete && corporateContextComplete;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");

      // Edit mode: PATCH the existing entry's stay fields only. Guest + channel are unchanged.
      if (isEdit && editEntryId) {
        const a = Math.max(1, Number(adults) || 1);
        const c = Math.max(0, Number(children) || 0);
        const parsedAges = childAges.map((x) => parseInt(x || "", 10)).filter((n) => Number.isFinite(n));
        return updateEntryIntake(session, editEntryId, {
          checkInDate: checkIn || undefined,
          checkOutDate: checkOut || undefined,
          adultCount: a,
          childCount: c,
          childAges: c > 0 ? (parsedAges.length === c ? parsedAges : undefined) : [],
          guestCount: a + c,
          numberOfRooms: Math.max(1, parseInt(numberOfRooms || "1", 10) || 1),
          expectedVersion: editEntry?.version,
        });
      }

      let guestProfileId: string;
      if (selectedGuest) {
        guestProfileId = selectedGuest.id;
      } else {
        const profile = await createGuestProfile(session, {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim() || undefined,
          phone: fullPhone || undefined,
          nationality: nationality.trim() || undefined,
        });
        guestProfileId = profile.id;
      }

      const a = Math.max(1, Number(adults) || 1);
      const c = Math.max(0, Number(children) || 0);
      const parsedAges = childAges.map((x) => parseInt(x || "", 10)).filter((n) => Number.isFinite(n));
      // The "Came in as" distinction is still kept in notes; the head count is now
      // structured on the entry (adultCount/childCount/childAges), not parsed from notes.
      const composedNotes = [notes.trim() || null, channel.note || null].filter(Boolean).join(" · ");

      const inquiry = await createInquiry(session, {
        guestProfileId,
        sourceChannel: channel.channel,
        notes: composedNotes || undefined,
        proposedCheckIn: checkIn || undefined,
        proposedCheckOut: checkOut || undefined,
        travelAgentId: partyKind === "TRAVEL_AGENT" ? party?.id ?? null : null,
        corporateAccountId: partyKind === "CORPORATE" ? party?.id ?? null : null,
      });

      // Corporate/government context (Policy 17) — required before the entry can exit S1.
      if (needsCorporateContext) {
        await captureCorporateContext(session, inquiry.id, {
          corporateClientRef: corpClientRef.trim(),
          corporateCoordinator: corpCoordinator.trim(),
        });
      }

      // On-site contact person (required at S4→S5 pre-arrival activation / W4). Default it to the
      // guest — for a walk-in / individual the guest IS the on-site contact. A corporate/group
      // coordinator can differ, but the guest is a sensible default and this is only set at intake
      // (Entry.contactPerson* is S1-editable only). Falls back to the guest profile's phone for a
      // returning guest whose number wasn't re-typed into the form.
      const contactPersonName = `${firstName.trim()} ${lastName.trim()}`.trim();
      const contactPersonPhone = fullPhone || selectedGuest?.phone || "";

      return createEntry(session, {
        inquiryId: inquiry.id,
        useType: "useType" in channel ? (channel.useType as string) : "LEISURE",
        guestProfileId,
        checkInDate: checkIn || undefined,
        checkOutDate: checkOut || undefined,
        guestCount: a + c,
        adultCount: a,
        childCount: c,
        childAges: c > 0 && parsedAges.length === c ? parsedAges : undefined,
        numberOfRooms: Math.max(1, parseInt(numberOfRooms || "1", 10) || 1),
        otaSource: channel.channel === "OTA",
        contactPersonName: contactPersonName || undefined,
        contactPersonPhone: contactPersonPhone || undefined,
      });
    },
    onSuccess: (entry) => {
      toast.success(isEdit ? "Booking updated" : "Inquiry started");
      // After an edit, the entry's version bumped — drop the cached copy so a second trip to this
      // page (or the workspace) reads the fresh version, otherwise the next save sends a stale
      // expectedVersion and the server rejects it with "version mismatch".
      if (isEdit && editEntryId) {
        void queryClient.invalidateQueries({ queryKey: ["entry", editEntryId] });
        void queryClient.invalidateQueries({ queryKey: ["entry-trace", editEntryId] });
        void queryClient.invalidateQueries({ queryKey: ["entry-timers", editEntryId] });
        void queryClient.invalidateQueries({ queryKey: ["entries"] });
      }
      router.push(`/desk/bookings/${entry.id}`);
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : isEdit ? "Couldn't update the booking" : "Couldn't start the inquiry"),
  });

  // Rail highlight — no entry exists yet, so highlight is derived from form activity.
  const lookupsUsed = !!childPolicyQuery.data || phoneMatches.length > 0 || !!party;
  const railActiveKeys = [lookupsUsed ? "lookups" : null, canSubmit ? "create" : null].filter(Boolean) as string[];
  const railFiringKey = mutation.isPending
    ? "create"
    : phoneMatch.isFetching || returningSearch.isFetching || childPolicyQuery.isFetching
      ? "lookups"
      : null;
  const railGroups: RailGroup[] = [
    { key: "lookups", label: "Lookups this page uses", items: BK.lookups },
    { key: "create", label: "On 'Start inquiry & open booking'", items: BK.create },
  ];

  // --- Step 0: "Came in as" ------------------------------------------------------------------
  // The first thing the receptionist chooses. Picking a card sets the channel and advances to the
  // tailored details form. Nothing is created yet — this is a pure selection screen.
  if (wizardStep === "type") {
    return (
      <section className="view">
        <Link className="ws-back" href="/desk/bookings" style={{ marginBottom: 12, display: "inline-flex" }}>
          <ChevronLeft />
          Bookings
        </Link>
        <div className="eyebrow">New booking</div>
        <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
          How did they come in?
        </h1>
        <p className="lead">
          Pick how this booking reached us. It shapes the intake form on the next step — and travels
          with the entry from S1 all the way through.
        </p>

        <div style={{ maxWidth: 760, margin: "18px auto 0" }}>
          {CHANNEL_GROUPS.map((group) => (
            <div className="block" key={group.label}>
              <BlockH>{group.label}</BlockH>
              <div className="eng-grid" style={{ marginTop: 0 }}>
                {group.keys.map((key) => {
                  const c = CHANNELS.find((x) => x.key === key)!;
                  const Icon = CHANNEL_META[key].icon;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="eng-card"
                      onClick={() => {
                        setChannelKey(key);
                        setWizardStep("details");
                      }}
                    >
                      <div className="ec-top">
                        <div
                          className="ec-av"
                          style={{ background: "var(--terra-t)", color: "var(--terra-d)", display: "flex", alignItems: "center", justifyContent: "center" }}
                        >
                          <Icon size={19} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="ec-name">{c.label}</div>
                          <div className="ec-sub" style={{ color: "var(--ink-3)" }}>
                            {CHANNEL_META[key].blurb}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // --- Step 1: details ------------------------------------------------------------------------
  return (
    <section className="view">
      {isEdit ? (
        <Link className="ws-back" href={`/desk/bookings/${editEntryId}`} style={{ marginBottom: 12, display: "inline-flex" }}>
          <ChevronLeft />
          Booking
        </Link>
      ) : (
        <button
          type="button"
          className="ws-back"
          onClick={() => setWizardStep("type")}
          style={{ marginBottom: 12, display: "inline-flex", background: "none", border: 0, cursor: "pointer" }}
        >
          <ChevronLeft />
          Booking type
        </button>
      )}
      <div className="eyebrow">
        {isEdit ? "Edit booking" : "New inquiry"} ·{" "}
        <span style={{ color: "var(--terra-d)" }}>
          {isEdit ? (editChannel ? editChannel.replace(/_/g, " ") : "—") : channel.label}
        </span>
      </div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        {isEdit ? "Edit the stay" : "Start a booking"}
      </h1>
      <p className="lead">
        {isEdit
          ? "Update the stay this booking asked for — dates, party size and rooms. The guest and how they came in stay as they were; changes save straight to the booking."
          : "Capture who’s asking and the stay they want. This opens the booking at the Inquiry step, where you explore availability. No entry exists yet — the live backend timeline begins once the booking opens."}
      </p>

      <div className="bx-split" style={{ maxWidth: 1020, margin: "18px auto 0" }}>
        <div className="bx-main formwrap" style={{ margin: 0, maxWidth: "none" }}>
        <div className="block">
          <BlockH>Who is this for</BlockH>
          {isEdit ? (
            <>
              <div className="field">
                <label>Phone</label>
                <input className="dinput" value={editGuest?.phone ?? ""} disabled readOnly />
              </div>
              <div className="frow">
                <div className="field">
                  <label>First name</label>
                  <input value={editGuest?.firstName ?? ""} disabled readOnly />
                </div>
                <div className="field">
                  <label>Last name</label>
                  <input value={editGuest?.lastName ?? ""} disabled readOnly />
                </div>
              </div>
              <div className="frow">
                <div className="field">
                  <label>Nationality</label>
                  <input value={editGuest?.nationality ?? ""} disabled readOnly />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input value={editGuest?.email ?? ""} disabled readOnly />
                </div>
              </div>
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0 }}>
                Guest details stay as captured — they can&rsquo;t change on an existing booking. Edit the stay below.
              </p>
            </>
          ) : (
          <>
          <div className="seg" style={{ marginBottom: 13 }}>
            <button
              type="button"
              className={mode === "new" ? "on" : ""}
              onClick={() => {
                setMode("new");
                setSelectedGuest(null);
              }}
            >
              <UserPlus />
              New guest
            </button>
            <button
              type="button"
              className={mode === "returning" ? "on" : ""}
              onClick={() => {
                setMode("returning");
                setSelectedGuest(null);
              }}
            >
              <Users />
              Returning guest
            </button>
          </div>

          {/* Adopted existing guest (from phone match or returning search) */}
          {selectedGuest ? (
            <div className="pickrow sel" style={{ borderRadius: "var(--r-md)", border: "1.5px solid var(--terra)" }}>
              <span>
                <GuestLine guest={selectedGuest} />
                {selectedGuest.nationality && <span className="tag" style={{ marginLeft: 8 }}>{selectedGuest.nationality}</span>}
              </span>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelectedGuest(null)}>
                Change
              </button>
            </div>
          ) : mode === "new" ? (
            <>
              <div className="field">
                <label>Phone</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <div style={{ flex: "0 0 auto" }}>
                    <PresetOrCustom
                      presets={PHONE_CODES}
                      value={phoneCode}
                      onChange={setPhoneCode}
                      customPlaceholder="+__"
                      selectStyle={{ width: 92 }}
                    />
                  </div>
                  <input
                    className="dinput"
                    style={{ flex: 1 }}
                    inputMode="tel"
                    placeholder="17 88 21 04"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    autoFocus
                  />
                </div>
                {phoneMatches.length > 0 && (
                  <div className="picklist" style={{ marginTop: 7 }}>
                    <div className="pickempty" style={{ padding: "7px 12px", textAlign: "left", color: "var(--ink-3)" }}>
                      Existing guest{phoneMatches.length === 1 ? "" : "s"} with this number:
                    </div>
                    {phoneMatches.map((g) => (
                      <button key={g.id} type="button" className="pickrow" onClick={() => adoptGuest(g)}>
                        <GuestLine guest={g} />
                        <span className="brow-open">Use →</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="frow">
                <div className="field">
                  <label>First name</label>
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                </div>
                <div className="field">
                  <label>Last name</label>
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
                </div>
              </div>
              <div className="frow">
                <div className="field">
                  <label>Nationality</label>
                  <PresetOrCustom
                    presets={NATIONALITIES}
                    value={nationality}
                    onChange={setNationality}
                    customPlaceholder="Nationality"
                  />
                </div>
                <div className="field">
                  <label>Email (optional)</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </div>
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0 }}>
                Phone and nationality are required. Type a known number to reuse an existing guest.
              </p>
            </>
          ) : (
            <>
              <div className="field" style={{ marginBottom: 9 }}>
                <label>Find guest</label>
                <div style={{ position: "relative" }}>
                  <Search style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--ink-3)" }} />
                  <input
                    className="dinput"
                    style={{ paddingLeft: 32 }}
                    placeholder="Name, phone or email — at least 2 characters…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              <div className="picklist">
                {returningSearch.isLoading ? (
                  <div className="pickempty">Searching…</div>
                ) : (returningSearch.data?.items ?? []).length === 0 ? (
                  <div className="pickempty">No guests found</div>
                ) : (
                  returningSearch.data!.items.map((g) => (
                    <button key={g.id} type="button" className="pickrow" onClick={() => adoptGuest(g)}>
                      <span>
                        <GuestLine guest={g} />
                        {g.clientTier && <span className="tag" style={{ marginLeft: 8 }}>{g.clientTier}</span>}
                      </span>
                      <span className="brow-open">Use →</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
          </>
          )}
        </div>

        <div className="block">
          <BlockH>Inquiry &amp; stay</BlockH>
          <div className="field">
            <label>Came in as</label>
            {isEdit ? (
              <select value={editChannelKey} disabled>
                {CHANNELS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <select value={channelKey} onChange={(e) => setChannelKey(e.target.value as ChannelKey)}>
                {CHANNELS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {!isEdit && partyKind && <PartySearch kind={partyKind} party={party} setParty={setParty} />}

          {needsCorporateContext &&
            (() => {
              const accountRefs = party?.contractRefs ?? [];
              const accountCoords = party?.coordinators ?? [];
              const inheritedRefs = accountRefs.length > 0;
              const inheritedCoords = accountCoords.length > 0;
              return (
                <>
                  {party && (inheritedRefs || inheritedCoords) && (
                    <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 6px" }}>
                      Inherited from <b>{party.displayName}</b>&rsquo;s account.{" "}
                      {!inheritedRefs || !inheritedCoords ? "Fill the rest below. " : ""}
                      Manage these on the corporate account in Admin.
                    </p>
                  )}
                  <div className="frow">
                    <div className="field">
                      <label>
                        Corporate client reference <span style={{ color: "var(--warn)" }}>*</span>
                      </label>
                      {inheritedRefs ? (
                        <select value={corpClientRef} onChange={(e) => setCorpClientRef(e.target.value)}>
                          <option value="">— select a contract reference —</option>
                          {accountRefs.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="dinput"
                          value={corpClientRef}
                          onChange={(e) => setCorpClientRef(e.target.value)}
                          placeholder="PO / account / authorisation ref"
                        />
                      )}
                    </div>
                    <div className="field">
                      <label>
                        Coordinator <span style={{ color: "var(--warn)" }}>*</span>
                      </label>
                      {inheritedCoords ? (
                        <select value={corpCoordinator} onChange={(e) => setCorpCoordinator(e.target.value)}>
                          <option value="">— select a coordinator —</option>
                          {accountCoords.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                              {c.phone ? ` · ${c.phone}` : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="dinput"
                          value={corpCoordinator}
                          onChange={(e) => setCorpCoordinator(e.target.value)}
                          placeholder="Their contact person"
                        />
                      )}
                    </div>
                  </div>
                </>
              );
            })()}

          <div className="frow">
            <div className="field">
              <label>Adults</label>
              <input type="number" min={1} value={adults} onChange={(e) => setAdults(e.target.value)} />
            </div>
            <div className="field">
              <label>Children</label>
              <input type="number" min={0} value={children} onChange={(e) => setChildren(e.target.value)} />
            </div>
          </div>
          {childCountNum > 0 && (
            <div className="field">
              <label>Child age{childCountNum === 1 ? "" : "s"} (years)</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {childAges.map((age, i) => (
                  <input
                    key={i}
                    type="number"
                    min={0}
                    max={maxChildAge}
                    className="dinput"
                    style={{ width: 80 }}
                    placeholder={`#${i + 1}`}
                    value={age}
                    onChange={(e) =>
                      setChildAges((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                    }
                  />
                ))}
              </div>
              <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "6px 0 0", lineHeight: 1.5 }}>
                Ages drive the child policy (under {minAdultAge} counts as a child) and CNB pricing at
                quotation. Anyone aged {minAdultAge}+ should be counted under Adults.
              </p>
            </div>
          )}

          <div className="field">
            <label>Number of rooms</label>
            <select
              value={numberOfRooms}
              onChange={(e) => setNumberOfRooms(e.target.value)}
              disabled={allowedRoomCounts.length === 0}
            >
              {allowedRoomCounts.length === 0 ? (
                <option value="">—</option>
              ) : (
                allowedRoomCounts.map((n) => (
                  <option key={n} value={String(n)}>
                    {n} {n === 1 ? "room" : "rooms"}
                  </option>
                ))
              )}
            </select>
            <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "6px 0 0", lineHeight: 1.5 }}>
              {chargeableOccupants} chargeable guest{chargeableOccupants === 1 ? "" : "s"} (adults + children aged{" "}
              {maxChildAge + 1}+). Up to {largestMaxCapacity} per room, so {roomRange.min}–{roomRange.max} room
              {roomRange.max === 1 ? "" : "s"} allowed. This is driven by party size only — not how the guest booked.
            </p>
          </div>

          <div className="frow">
            <div className="field">
              <label>Check-in</label>
              <DateField min={today} value={checkIn} onChange={setCheckIn} />
            </div>
            <div className="field">
              <label>Check-out</label>
              <DateField min={nextDayIso(checkIn) || today} value={checkOut} onChange={setCheckOut} />
            </div>
          </div>

          {!isEdit && (
            <div className="field">
              <label>Notes (optional)</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          )}
        </div>

        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "12px 16px" }}
          disabled={!canSubmit || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending
            ? isEdit
              ? "Saving…"
              : "Starting…"
            : isEdit
              ? "Save changes"
              : "Start inquiry & open booking"}
        </button>
        </div>

        <BackendRail groups={railGroups} activeKeys={railActiveKeys} firingKey={railFiringKey} />
      </div>
    </section>
  );
}
