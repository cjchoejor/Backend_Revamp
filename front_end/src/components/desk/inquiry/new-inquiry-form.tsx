"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronLeft, Plus, RotateCcw, Search, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  createGuestProfile,
  guestDisplayName,
  searchGuestProfiles,
  type GuestProfileSummary,
} from "@/lib/api/guest-profiles";
import {
  createInquiry,
  searchCorporateAccountsLookup,
  searchTravelAgentsLookup,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";
import { createEntry } from "@/lib/api/entries";

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

const PHONE_CODES = ["+975", "+91", "+61"];
const NATIONALITIES = ["Bhutanese", "Indian"];

function isoDate(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
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
  const { session } = useSession();
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
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [today, setToday] = useState("");
  const [notes, setNotes] = useState("");

  const channel = useMemo(() => CHANNELS.find((c) => c.key === channelKey)!, [channelKey]);
  const partyKind = "party" in channel ? (channel.party as PartyKind) : null;

  // Default dates client-side (today / tomorrow) to avoid SSR hydration mismatch.
  useEffect(() => {
    const t = new Date();
    setToday(isoDate(t));
    setCheckIn(isoDate(t));
    setCheckOut(isoDate(new Date(t.getTime() + 86_400_000)));
  }, []);

  // Reset party selection when channel changes away from agent/corporate.
  useEffect(() => {
    if (!partyKind) setParty(null);
  }, [partyKind]);

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
  const canSubmit = mode === "new" ? canSubmitNew : !!selectedGuest;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");

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
      const composedNotes = [
        notes.trim() || null,
        channel.note || null,
        `Guests: ${a} adult${a === 1 ? "" : "s"}${c ? `, ${c} child${c === 1 ? "" : "ren"}` : ""}`,
      ]
        .filter(Boolean)
        .join(" · ");

      const inquiry = await createInquiry(session, {
        guestProfileId,
        sourceChannel: channel.channel,
        notes: composedNotes || undefined,
        proposedCheckIn: checkIn || undefined,
        proposedCheckOut: checkOut || undefined,
        travelAgentId: partyKind === "TRAVEL_AGENT" ? party?.id ?? null : null,
        corporateAccountId: partyKind === "CORPORATE" ? party?.id ?? null : null,
      });

      return createEntry(session, {
        inquiryId: inquiry.id,
        useType: "useType" in channel ? (channel.useType as string) : "LEISURE",
        guestProfileId,
        checkInDate: checkIn || undefined,
        checkOutDate: checkOut || undefined,
        guestCount: a + c,
        otaSource: channel.channel === "OTA",
      });
    },
    onSuccess: (entry) => {
      toast.success("Inquiry started");
      router.push(`/desk/bookings/${entry.id}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't start the inquiry"),
  });

  return (
    <section className="view">
      <Link className="ws-back" href="/desk/bookings" style={{ marginBottom: 12, display: "inline-flex" }}>
        <ChevronLeft />
        Bookings
      </Link>
      <div className="eyebrow">New inquiry</div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        Start a booking
      </h1>
      <p className="lead">
        Capture who&rsquo;s asking and the stay they want. This opens the booking at the Inquiry step, where you
        explore availability.
      </p>

      <div className="formwrap" style={{ marginTop: 18 }}>
        <div className="block">
          <BlockH>Who is this for</BlockH>
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
                <b>{guestDisplayName(selectedGuest)}</b>
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
                        <span>
                          <b>{guestDisplayName(g)}</b>
                        </span>
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
                        <b>{guestDisplayName(g)}</b>
                        {g.clientTier && <span className="tag" style={{ marginLeft: 8 }}>{g.clientTier}</span>}
                      </span>
                      <span className="brow-open">Use →</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <div className="block">
          <BlockH>Inquiry &amp; stay</BlockH>
          <div className="field">
            <label>Came in as</label>
            <select value={channelKey} onChange={(e) => setChannelKey(e.target.value as ChannelKey)}>
              {CHANNELS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {partyKind && <PartySearch kind={partyKind} party={party} setParty={setParty} />}

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
          {Number(children) > 0 && (
            <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "-4px 0 11px", lineHeight: 1.5 }}>
              Children are priced under the child-no-bed (CNB) policy at quotation, per the applicable rate card.
            </p>
          )}

          <div className="frow">
            <div className="field">
              <label>Check-in</label>
              <input type="date" min={today} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div className="field">
              <label>Check-out</label>
              <input type="date" min={checkIn || today} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "12px 16px" }}
          disabled={!canSubmit || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Starting…" : "Start inquiry & open booking"}
        </button>
      </div>
    </section>
  );
}
