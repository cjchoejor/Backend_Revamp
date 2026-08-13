"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
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
import { usePageTitle } from "@/hooks/use-page-title";
import { ApiError } from "@/lib/api/client";
import {
  createGuestProfile,
  guestFullName,
  searchGuestProfiles,
  type GuestProfileSummary,
} from "@/lib/api/guest-profiles";
import {
  addPartyContact,
  captureCorporateContext,
  createInquiry,
  getInquiry,
  searchCorporateAccountsLookup,
  searchTravelAgentsLookup,
  type CoordinatorContact,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";
import { createEntry, getEntry, updateEntryIntake } from "@/lib/api/entries";
import { listRooms } from "@/lib/api/rooms";
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

/**
 * Split a stored phone back into the country-code + number pair the form edits.
 *
 * Needed when adopting an existing guest: the operator usually types only the first few digits
 * before picking the match, so the form's own phone fields hold a fragment. Splitting the guest's
 * stored number back into them makes every downstream read (`fullPhone`, and through it the
 * booking's contact person) agree with the guest that was actually chosen.
 */
function splitStoredPhone(full: string | null | undefined): { code: string; number: string } {
  const v = (full ?? "").trim();
  if (!v) return { code: PHONE_CODES[0], number: "" };
  // Stored numbers carry separators inconsistently ("+975-17-100-204", "+97577491134"), so strip
  // any leading ones off the remainder rather than leaving the field starting with a hyphen.
  const strip = (s: string) => s.replace(/^[\s-]+/, "").trim();
  const preset = PHONE_CODES.find((c) => v.startsWith(c));
  if (preset) return { code: preset, number: strip(v.slice(preset.length)) };
  const m = v.match(/^(\+\d{1,4})[\s-]*(.*)$/);
  if (m) return { code: m[1], number: strip(m[2]) };
  // No dialling code at all — the majority of the imported legacy numbers. Leave the code blank
  // rather than assuming one; the guest's stored number is what gets used downstream either way.
  return { code: "", number: v };
}

function isoDate(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
}

/** ISO date `n` nights after `iso` (UTC-safe). */
function addNightsIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole nights between two ISO dates (checkOut exclusive); 0 when invalid. */
function diffNightsIso(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
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

const OTHER_OPTION = "__other__";

/**
 * A preset dropdown that swaps in a free-text input for other values.
 *
 * Two ways in, because the two uses differ: `otherLabel` puts a named option in the list itself
 * (right for nationality, where "Other" is a real answer an operator looks for), while the compact
 * "+" button is used where the control is too narrow to spell it out (the phone dialling code).
 */
function PresetOrCustom({
  presets,
  value,
  onChange,
  customPlaceholder,
  selectStyle,
  otherLabel,
}: {
  presets: string[];
  value: string;
  onChange: (v: string) => void;
  customPlaceholder: string;
  selectStyle?: React.CSSProperties;
  /** When set, the select carries this as a final option instead of showing the "+" button. */
  otherLabel?: string;
}) {
  const [custom, setCustom] = useState(!presets.includes(value) && value !== "");

  // A value can also arrive from outside the control — adopting a guest whose stored nationality or
  // dialling code isn't a preset. Flip to the free-text form so the value stays visible and
  // editable, rather than a select silently rendering an option it doesn't have.
  useEffect(() => {
    if (value !== "" && !presets.includes(value)) setCustom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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
  const toCustom = () => {
    setCustom(true);
    onChange("");
  };

  return (
    <div style={{ display: "flex", gap: 6 }}>
      <select
        value={value}
        onChange={(e) => (e.target.value === OTHER_OPTION ? toCustom() : onChange(e.target.value))}
        style={selectStyle}
      >
        {/* A stored value can be blank — e.g. adopting a guest whose number has no dialling code.
            Without a matching option the select would silently display the first preset while
            holding "", which reads as a country code that was never chosen. */}
        {value === "" && (
          <option value="" disabled>
            —
          </option>
        )}
        {presets.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        {otherLabel && <option value={OTHER_OPTION}>{otherLabel}</option>}
      </select>
      {!otherLabel && (
        <button type="button" className="btn btn-ghost btn-sm" title="Other" onClick={toCustom}>
          <Plus style={{ width: 14, height: 14 }} />
        </button>
      )}
    </div>
  );
}

/**
 * The contact persons on the picked agency / corporate account.
 *
 * An agency rarely has one voice — several people ring in bookings, and a new one turns up mid-call.
 * So this behaves like the guest phone auto-match one field up: the numbers already known for THIS
 * party are offered, and anything new is captured and appended to the party (L1, append-only) so the
 * next booking through them already has it. The pick fills the booking's contact person — the number
 * the hotel rings about this stay — not the guest, who is captured separately below.
 */
function PartyContacts({
  kind,
  party,
  setParty,
  contact,
  setContact,
}: {
  kind: PartyKind;
  party: LookupPartyMatch;
  setParty: (p: LookupPartyMatch | null) => void;
  contact: CoordinatorContact | null;
  setContact: (c: CoordinatorContact | null) => void;
}) {
  const { session } = useSession();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState(PHONE_CODES[0]);
  const [newPhone, setNewPhone] = useState("");

  const contacts = party.coordinators ?? [];
  const noun = kind === "TRAVEL_AGENT" ? "agency" : "account";

  const addMutation = useMutation({
    mutationFn: () =>
      addPartyContact(session!, kind, party.id, {
        name: newName.trim(),
        phone: newPhone.trim() ? `${newCode}${newPhone.trim()}` : null,
      }),
    onSuccess: (res) => {
      // Reflect the append locally so the list shows it without re-running the party search.
      setParty({ ...party, coordinators: res.coordinators });
      // Adding while nothing is picked IS the picking action; adding once a contact is picked
      // just files another person on the party — it must not silently steal the booking's contact.
      if (!contact) setContact(res.contact);
      setAdding(false);
      setNewName("");
      setNewPhone("");
      toast.success(
        !res.added
          ? `${res.contact.name} was already on file`
          : contact
            ? `Added ${res.contact.name} to ${party.displayName} — ${contact.name} stays the contact for this booking`
            : `Added ${res.contact.name} to ${party.displayName}`,
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not add the contact"),
  });

  // Shared between both views (contact picked / not yet picked), so more people can be filed
  // on the agency mid-call even after the booking's contact person is settled.
  const addBlock = adding ? (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <input
        className="dinput"
        placeholder="Contact person's name"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        autoFocus
      />
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ flex: "0 0 auto" }}>
          <PresetOrCustom
            presets={PHONE_CODES}
            value={newCode}
            onChange={setNewCode}
            customPlaceholder="+__"
            selectStyle={{ width: 92 }}
          />
        </div>
        <input
          className="dinput"
          style={{ flex: 1 }}
          inputMode="tel"
          placeholder="17 88 21 04"
          value={newPhone}
          onChange={(e) => setNewPhone(e.target.value)}
        />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!newName.trim() || addMutation.isPending}
          onClick={() => addMutation.mutate()}
        >
          {addMutation.isPending ? "Saving…" : `Save to ${noun}`}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
          Cancel
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0 }}>
        Saved onto {party.displayName}, so it&rsquo;s already here next time they book.
      </p>
    </div>
  ) : (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      style={{ marginTop: 7 }}
      onClick={() => setAdding(true)}
    >
      <Plus style={{ width: 14, height: 14 }} />
      {contact ? "Add another contact person" : "New contact person"}
    </button>
  );

  if (contact) {
    return (
      <div className="field">
        <label>Contact person</label>
        <div className="pickrow sel" style={{ borderRadius: "var(--r-md)", border: "1.5px solid var(--terra)" }}>
          <span>
            <b>{contact.name}</b>
            {contact.phone && <span style={{ color: "var(--ink-3)" }}> · {contact.phone}</span>}
          </span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setContact(null)}>
            Change
          </button>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "5px 0 0" }}>
          The hotel rings this person about the booking. The guest travelling is captured below.
          {(party.coordinators?.length ?? 0) > 1 && " “Change” lists everyone on file."}
        </p>
        {addBlock}
      </div>
    );
  }

  return (
    <div className="field">
      <label>Contact person</label>
      {contacts.length > 0 ? (
        <div className="picklist">
          <div className="pickempty" style={{ padding: "7px 12px", textAlign: "left", color: "var(--ink-3)" }}>
            Contacts on file for {party.displayName}:
          </div>
          {contacts.map((c, i) => (
            <button key={`${c.name}-${i}`} type="button" className="pickrow" onClick={() => setContact(c)}>
              <span>
                <b>{c.name}</b>
                {c.phone && <span style={{ color: "var(--ink-3)" }}> · {c.phone}</span>}
              </span>
              <span className="brow-open">Use →</span>
            </button>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 6px" }}>
          No contacts on file for this {noun} yet — add the person you&rsquo;re speaking to.
        </p>
      )}

      {addBlock}
    </div>
  );
}

/** Debounced search + pick for a single party kind (travel agent or corporate). */
function PartySearch({
  kind,
  party,
  setParty,
  contact,
  setContact,
}: {
  kind: PartyKind;
  party: LookupPartyMatch | null;
  setParty: (p: LookupPartyMatch | null) => void;
  contact: CoordinatorContact | null;
  setContact: (c: CoordinatorContact | null) => void;
}) {
  const { session } = useSession();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  // The list is a dropdown, not a permanent block: it opens on focus and closes on click-away,
  // so it can show the whole roster without pushing the rest of the intake form down the page.
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const term = debounced.trim();
  // No minimum term: an empty query is a real request meaning "list them all", which is what
  // makes this browsable for an operator who knows the agency by sight but not by spelling.
  const results = useQuery({
    queryKey: ["desk-party-lookup", kind, term],
    queryFn: () =>
      kind === "TRAVEL_AGENT"
        ? searchTravelAgentsLookup(session!, term)
        : searchCorporateAccountsLookup(session!, term),
    enabled: !!session && open,
  });

  const noun = kind === "TRAVEL_AGENT" ? "travel agent" : "corporate account";
  const matches = results.data?.matches ?? [];
  // The cap is the server's, reported on the response — landing exactly on it means the roster
  // was cut, so the count line says so instead of implying a complete list. Not mirrored here:
  // a copy would silently go stale the day the backend raises it.
  const cap = results.data?.limit;
  const atCap = cap !== undefined && matches.length >= cap;

  if (party) {
    return (
      <>
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
        <PartyContacts kind={kind} party={party} setParty={setParty} contact={contact} setContact={setContact} />
      </>
    );
  }

  return (
    <div className="field" ref={wrapRef}>
      <label>Select {noun}</label>
      <div style={{ position: "relative" }}>
        <Search style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--ink-3)" }} />
        <input
          className="dinput"
          style={{ paddingLeft: 32 }}
          placeholder={`Search ${noun}s by name…`}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && (
        <>
          <div className="picklist" style={{ marginTop: 7 }}>
            {results.isLoading ? (
              <div className="pickempty">Loading…</div>
            ) : matches.length === 0 ? (
              <div className="pickempty">{term ? `No ${noun} matches “${term}”` : `No ${noun}s on file`}</div>
            ) : (
              matches.map((m) => (
                <button key={m.id} type="button" className="pickrow" onClick={() => setParty(m)}>
                  <span>
                    <b>{m.displayName}</b>
                    {m.contactEmail && <span style={{ color: "var(--ink-3)" }}> · {m.contactEmail}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
          {matches.length > 0 && (
            <div style={{ marginTop: 5, fontSize: 11.5, color: "var(--ink-3)" }}>
              {atCap
                ? `First ${matches.length} shown — keep typing to narrow`
                : term
                  ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
                  : `${matches.length} on file — type to narrow`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The child-age charge bands, stated on the page permanently rather than in a toast.
 *
 * An age over `childMaxAge` is charged at the full adult rate — own bed, full room share, full
 * meals — while the guest is still a minor for supervision. That used to surface as a one-shot
 * toast when an age crossed the line, which an operator who looked away never saw; by the time
 * the charge appeared on the quote there was nothing on screen explaining it.
 *
 * So the note is always visible while taking a booking, including before any child is entered —
 * the rule is most useful *before* the operator types an age, not after. When an entered age is
 * in the adult band the note turns amber and names the children concerned, and it stays that way
 * for as long as the age does.
 *
 * Every boundary is the backend's: they come from `GET /api/lookups/child-policy`, so an L4 edit
 * to `registry.child.ageBands` or `registry.child.mealPricing` moves this text with it. Nothing
 * here is hardcoded — and until that lookup resolves the note states no numbers at all rather
 * than printing a built-in guess, because a confidently wrong charge band is the exact mistake
 * this note exists to prevent. Which children are in the adult band is likewise decided by the
 * caller's `adultBandIndexes` (already gated on the policy having loaded), not recomputed here,
 * so the note and the highlighted age inputs can never disagree.
 */
function ChildAgeChargeNote({
  childAges,
  adultBandIndexes,
  overAgeIndexes,
  policyLoaded,
  youngMaxAge,
  childMaxAge,
  maxChildAge,
  minAdultAge,
  adultMealPercent,
  childMealPercent,
}: {
  childAges: string[];
  adultBandIndexes: Set<number>;
  overAgeIndexes: Set<number>;
  policyLoaded: boolean;
  youngMaxAge: number;
  childMaxAge: number;
  maxChildAge: number;
  minAdultAge: number;
  adultMealPercent: number | null;
  childMealPercent: number | null;
}) {
  const inAdultBand = childAges
    .map((raw, i) => ({ n: parseInt(raw || "", 10), i }))
    .filter(({ n, i }) => adultBandIndexes.has(i) && !overAgeIndexes.has(i) && Number.isFinite(n));
  // An 18+ age is not a warning about price — it is a refusal: the guest is an adult and does
  // not fall under the child section at all. Red trumps the amber charge note, and the same
  // condition is what keeps the submit button disabled (via `agesComplete`), so the box always
  // explains WHY saving is off rather than leaving a silently grey button.
  const overAge = childAges
    .map((raw, i) => ({ n: parseInt(raw || "", 10), i }))
    .filter(({ n, i }) => overAgeIndexes.has(i) && Number.isFinite(n));
  const blocked = overAge.length > 0;
  const active = inAdultBand.length > 0;

  return (
    <div
      className="field"
      style={{
        marginTop: 2,
        padding: "9px 11px",
        borderRadius: "var(--r-md)",
        border: `1px solid ${blocked ? "var(--stop)" : active ? "var(--warn)" : "var(--line-2)"}`,
        background: blocked ? "var(--stop-t)" : active ? "var(--warn-t)" : "transparent",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <AlertTriangle
          style={{
            width: 14,
            height: 14,
            flexShrink: 0,
            marginTop: 2,
            color: blocked ? "var(--stop)" : active ? "var(--warn)" : "var(--ink-3)",
          }}
        />
        <div style={{ fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          {blocked && (
            <p style={{ margin: "0 0 4px", color: "var(--stop)", fontWeight: 700 }}>
              {overAge.map(({ n, i }) => `Child ${i + 1} is ${n}`).join(" · ")} — that&rsquo;s an
              adult and doesn&rsquo;t fall under the child section. Count them in the Adults field;
              the booking can&rsquo;t be saved until this age is fixed.
            </p>
          )}
          {active && (
            <p style={{ margin: "0 0 4px", color: "var(--warn)", fontWeight: 700 }}>
              {inAdultBand
                .map(({ n, i }) => `Child ${i + 1} is ${n}`)
                .join(" · ")}{" "}
              — charged at the adult rate.
            </p>
          )}
          {policyLoaded ? (
            <p style={{ margin: 0 }}>
              List everyone under {minAdultAge} as a child — the age sets the charge: under{" "}
              {youngMaxAge + 1} stay and eat free · {youngMaxAge + 1}–{childMaxAge} pay child rates
              {childMealPercent !== null ? ` (${childMealPercent}% of meals)` : ""} ·{" "}
              <b>
                {childMaxAge + 1}–{maxChildAge} are charged as adults
              </b>{" "}
              (own bed, full room share
              {adultMealPercent !== null ? ` and ${adultMealPercent}% meal charges` : " and full meals"}) while
              still counting as minors for supervision. Anyone {minAdultAge}+ goes under Adults.
            </p>
          ) : (
            <p style={{ margin: 0, color: "var(--ink-3)" }}>
              Loading the child charge bands from the hotel&rsquo;s policy…
            </p>
          )}
        </div>
      </div>
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
  // The agency/account contact person handling this booking — becomes Entry.contactPerson* below.
  const [partyContact, setPartyContact] = useState<CoordinatorContact | null>(null);
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
  // Bed-setup breakdown of the room request ("5 King + 2 Twin", 2026-08-13) — string drafts
  // per setup, parsed on submit into Entry.bedTypeRequest. Optional and possibly partial
  // ("at least 2 King" on a 5-room booking is legal).
  const [bedTypeCounts, setBedTypeCounts] = useState<Record<string, string>>({});
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  // Number of nights — the primary stay-length input. Check-out derives from check-in + nights;
  // picking a check-out date manually recomputes nights (two-way sync).
  const [nightsStr, setNightsStr] = useState("1");
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
    setBedTypeCounts(
      Object.fromEntries(
        Object.entries((editEntry.bedTypeRequest as Record<string, number> | null | undefined) ?? {}).map(([t, n]) => [
          t,
          String(n),
        ]),
      ),
    );
    const ci = editEntry.checkInDate?.slice(0, 10) ?? "";
    const co = editEntry.checkOutDate?.slice(0, 10) ?? "";
    setCheckIn(ci);
    setCheckOut(co);
    // Seed nights from the loaded stay so the derive-checkout effect reproduces the same dates.
    if (ci && co) setNightsStr(String(Math.max(1, diffNightsIso(ci, co))));
    editInited.current = true;
  }, [isEdit, editEntry]);

  const channel = useMemo(() => CHANNELS.find((c) => c.key === channelKey)!, [channelKey]);
  const partyKind = "party" in channel ? (channel.party as PartyKind) : null;
  // Corporate bookings require the client-ref / coordinator context (Policy 17).
  const needsCorporateContext = channel.channel === "CORPORATE";

  // Land the cursor on the first field when the details screen opens, so the operator can start
  // typing straight out of the booking-type screen. Which field that is depends on the channel —
  // an agent booking leads with the agency search, everything else with the guest's phone — so
  // rather than each branch owning a ref, the first enabled control in the form is found and
  // focused. Re-runs on the New/Returning toggle, which also swaps the first field.
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (wizardStep !== "details") return;
    const first = formRef.current?.querySelector<HTMLElement>(
      "input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])",
    );
    first?.focus();
  }, [wizardStep, mode]);

  // Default check-in to TODAY client-side (avoids SSR hydration mismatch). In edit mode the
  // loaded booking's own dates win — only `today` (the date-field floor) is still set.
  useEffect(() => {
    const t = new Date();
    setToday(isoDate(t));
    if (isEdit) return;
    setCheckIn(isoDate(t));
  }, [isEdit]);

  // Check-out derives from check-in + nights, so setting the check-in date and typing a night
  // count auto-selects the check-out date.
  useEffect(() => {
    if (!checkIn) return;
    const n = Math.max(1, parseInt(nightsStr || "1", 10) || 1);
    setCheckOut(addNightsIso(checkIn, n));
  }, [checkIn, nightsStr]);

  // Manual check-out pick — keep, and recompute nights from the chosen date.
  const onCheckOutChange = (v: string) => {
    setCheckOut(v);
    if (checkIn && v) {
      const d = diffNightsIso(checkIn, v);
      if (d >= 1) setNightsStr(String(d));
    }
  };

  // Reset party selection when channel changes away from agent/corporate.
  useEffect(() => {
    if (!partyKind) {
      setParty(null);
      setPartyContact(null);
    }
  }, [partyKind]);

  // A contact belongs to one party — dropping or swapping the party drops the contact with it.
  useEffect(() => {
    setPartyContact(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.id]);

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

  // For a corporate booking the contact person IS the Policy 17 coordinator — picking one above
  // fills the required field below rather than making the operator name the same person twice.
  useEffect(() => {
    if (needsCorporateContext && partyContact) setCorpCoordinator(partyContact.name);
  }, [needsCorporateContext, partyContact]);

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
  // Pricing bands are a SEPARATE cut from the legal/supervision age above (Legphel child
  // policy §2): under 6 free · 6–10 child rates · 11+ charged as an adult even though they
  // are a minor. The hint under the age inputs spells this out — it used to say "under
  // {minAdultAge} counts as a child", which read as child PRICING up to 17.
  const youngMaxAge = childPolicyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const childMaxAge = childPolicyQuery.data?.ageBands.childMaxAge ?? 10;
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
  /**
   * Which of the entered child ages land in the ADULT pricing band.
   *
   * The boundary is the backend's, not a number chosen here: `classifyAge` treats
   * `age > ageBands.childMaxAge` as ADULT, so with the configured childMaxAge of 10 that is 11 and
   * above — and it moves the moment an L4 edits `registry.child.ageBands`. Everything below reads
   * `childMaxAge` so nothing has to be re-hardcoded when it does.
   */
  const adultBandIndexes = useMemo(() => {
    if (!childPolicyQuery.data) return new Set<number>();
    const out = new Set<number>();
    childAges.forEach((raw, i) => {
      const n = parseInt(raw || "", 10);
      if (Number.isFinite(n) && n > childMaxAge && n <= maxChildAge) out.add(i);
    });
    return out;
  }, [childAges, childMaxAge, maxChildAge, childPolicyQuery.data]);

  /**
   * Ages at/above the legal adult threshold, which are a different thing from the amber band
   * above: 11–17 is a real child entry with an adult PRICE; 18+ is not a child entry at all —
   * the backend refuses it outright (CHILD_AGE_ABOVE_LEGAL_MINOR, BLOCK) and the person belongs
   * in the Adults field. Shown red, and it is what keeps `agesComplete` false. Deliberately NOT
   * gated on the policy having loaded (unlike the amber band): this is the refusal that disables
   * submit, and enforcement can't wait on a lookup — the 18 fallback matches `agesComplete`'s.
   */
  const overAgeIndexes = useMemo(() => {
    const out = new Set<number>();
    childAges.forEach((raw, i) => {
      const n = parseInt(raw || "", 10);
      if (Number.isFinite(n) && n >= minAdultAge) out.add(i);
    });
    return out;
  }, [childAges, minAdultAge]);

  // The adult-band charge used to be announced by a one-shot `toast.warning` as each age crossed
  // the ceiling. A toast is gone in nine seconds and the charge is not, so it is now stated
  // permanently on the page by <ChildAgeChargeNote> below, which turns amber for as long as any
  // entered age sits above `childMaxAge`.

  const parsedChildAges = childAges.map((a) => parseInt(a || "", 10)).filter((n) => Number.isFinite(n));
  const roomCountsQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", adultsNum, parsedChildAges.join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: adultsNum, childAges: parsedChildAges }),
    enabled: !!session && adultsNum > 0 && agesComplete,
  });
  const chargeableOccupants = roomCountsQuery.data?.chargeableOccupants ?? adultsNum;
  const largestMaxCapacity = roomCountsQuery.data?.maxCapacityUsed ?? 3;
  const roomRange = roomCountsQuery.data?.allowedRoomCounts ?? { min: adultsNum > 0 ? 1 : 0, max: adultsNum };
  // Hotel-wide ceiling from the backend's live room registry — a party the hotel can't sleep
  // is refused here (message + disabled submit) exactly as the create-entry check would refuse
  // it server-side (OVER_HOTEL_CAPACITY BLOCK). Nothing hardcoded: add a room in admin and
  // these numbers move on the next lookup.
  const hotelRoomCount = roomCountsQuery.data?.hotelRoomCount;
  const hotelMaxOccupants = roomCountsQuery.data?.hotelMaxOccupants;
  const exceedsHotelCapacity = roomCountsQuery.data?.exceedsHotelCapacity ?? false;
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

  // --- Bed-setup breakdown ("5 King + 2 Twin", 2026-08-13) -----------------------------------
  // Vocabulary + achievable stock come from the live rooms registry (each room's
  // `allowedBedTypes` — King⇄Twin are the same convertible stock), never hardcoded: add a room
  // in admin and the options and ceilings move on the next fetch.
  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
  });
  const BED_ORDER = ["KING", "QUEEN", "TWIN", "SINGLE"];
  const bedLabelOf = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();
  const bedTypeOptions = useMemo(() => {
    const achievable = new Map<string, number>();
    for (const r of roomsCatalogQuery.data?.items ?? []) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsCatalogQuery.data]);
  const parsedBedRequest = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [t, v] of Object.entries(bedTypeCounts)) {
      const n = parseInt(v || "", 10);
      if (Number.isFinite(n) && n > 0) out[t] = n;
    }
    return out;
  }, [bedTypeCounts]);
  const bedRequestSum = Object.values(parsedBedRequest).reduce((a, b) => a + b, 0);
  // Pooled stock check mirroring the backend rule: setups sharing convertible stock (identical
  // `allowedBedTypes` signature — King/Twin) are judged together, Queen/Single stand alone.
  const bedStockShortfall = useMemo(() => {
    if (bedRequestSum === 0) return null;
    const stockByGroup = new Map<string, number>();
    const groupOfType = new Map<string, string>();
    for (const r of roomsCatalogQuery.data?.items ?? []) {
      const setups = (r.allowedBedTypes?.length ? r.allowedBedTypes : r.bedType ? [r.bedType] : []).slice().sort();
      if (setups.length === 0) continue;
      const g = setups.join("/");
      stockByGroup.set(g, (stockByGroup.get(g) ?? 0) + 1);
      for (const t of setups) groupOfType.set(t, g);
    }
    const askByGroup = new Map<string, { count: number; types: string[] }>();
    for (const [t, n] of Object.entries(parsedBedRequest)) {
      const g = groupOfType.get(t) ?? t;
      const cur = askByGroup.get(g) ?? { count: 0, types: [] };
      cur.count += n;
      cur.types.push(t);
      askByGroup.set(g, cur);
    }
    for (const [g, ask] of askByGroup) {
      const stock = stockByGroup.get(g) ?? 0;
      if (ask.count > stock) {
        return { asked: ask.count, stock, types: ask.types.map(bedLabelOf).join(" + "), pooled: g.includes("/") };
      }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedBedRequest, bedRequestSum, roomsCatalogQuery.data]);
  const roomsNum = parseInt(numberOfRooms || "0", 10) || 0;
  const bedSetupOverRooms = bedRequestSum > 0 && bedRequestSum > roomsNum;
  const bedSetupOk = bedRequestSum === 0 || (!bedSetupOverRooms && !bedStockShortfall);
  // The bed setup can only RAISE the room count — a smaller sum is a partial preference
  // ("at least 2 King on a 5-room booking") and must never lower what the operator picked.
  useEffect(() => {
    if (bedRequestSum <= 0) return;
    const current = parseInt(numberOfRooms || "0", 10) || 0;
    if (bedRequestSum > current && allowedRoomCounts.includes(bedRequestSum)) {
      setNumberOfRooms(String(bedRequestSum));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bedRequestSum, allowedRoomCounts]);

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
    // Adopt the guest's STORED number over whatever fragment was typed to find them. Without this
    // the half-typed draft stayed in the phone fields and flowed into the booking's contact person.
    if (g.phone) {
      const { code, number } = splitStoredPhone(g.phone);
      setPhoneCode(code);
      setPhoneNumber(number);
    }
    toast.success(`Using existing guest: ${g.firstName} ${g.lastName}`);
  };

  const fullPhone = phoneCode && phoneNumber.trim() ? `${phoneCode}${phoneNumber.trim()}` : "";

  // Name the tab after the guest as soon as there's a name to show, so an intake started in one tab
  // is distinguishable from bookings open in others.
  const tabGuestName = isEdit
    ? guestFullName({ firstName: editGuest?.firstName ?? "", lastName: editGuest?.lastName ?? "" })
    : selectedGuest
      ? guestFullName(selectedGuest)
      : `${firstName.trim()} ${lastName.trim()}`.trim();
  usePageTitle(tabGuestName || null, isEdit ? "Edit booking" : "New booking");

  const newGuestComplete = !!(firstName.trim() && lastName.trim() && phoneNumber.trim() && nationality.trim());

  // Save the guest before the rest of the booking is filled in. Submitting the form would create
  // the profile anyway, so this only moves that write earlier — useful when the caller gives their
  // details first and the stay is still being discussed. The saved profile is adopted straight
  // away, so the submit path reuses its id rather than creating a second one.
  const saveGuestMutation = useMutation({
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
      toast.success(`Guest saved: ${created.firstName} ${created.lastName}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not save the guest"),
  });

  const canSubmitNew = !!(selectedGuest || newGuestComplete);
  const corporateContextComplete = !needsCorporateContext || (corpClientRef.trim() !== "" && corpCoordinator.trim() !== "");
  const canSubmit = isEdit
    ? // Editing an existing booking: guest + channel are fixed, so only the stay fields gate the save.
      !!editEntry && agesComplete && !!checkIn && !!checkOut && !exceedsHotelCapacity && bedSetupOk
    : (mode === "new" ? canSubmitNew : !!selectedGuest) &&
      agesComplete &&
      corporateContextComplete &&
      !exceedsHotelCapacity &&
      bedSetupOk;

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
          // Explicit null clears a previously-stored bed setup when the operator empties it.
          bedTypeRequest: bedRequestSum > 0 ? parsedBedRequest : null,
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

      // On-site contact person (required at S4→S5 pre-arrival activation / W4). When the booking
      // came through an agency or corporate account and the operator picked one of its contact
      // persons, that person is who the hotel rings about this stay — so they win. Otherwise it
      // defaults to the guest: for a walk-in / individual the guest IS the contact. Only set at
      // intake (Entry.contactPerson* is S1-editable only). Falls back to the guest profile's phone
      // for a returning guest whose number wasn't re-typed into the form.
      // An adopted guest's stored number beats the form draft: the draft is often just the fragment
      // typed to find them, and their profile holds the real number.
      const contactPersonName = partyContact?.name?.trim() || `${firstName.trim()} ${lastName.trim()}`.trim();
      const contactPersonPhone = partyContact?.phone?.trim() || selectedGuest?.phone || fullPhone || "";

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
        bedTypeRequest: bedRequestSum > 0 ? parsedBedRequest : undefined,
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

  // Rail highlight — "✓ Ran" only when the backend actually did something. The lookups group
  // lights once real fetches ran (child policy / phone match / party search). The create group
  // NEVER pre-lights on form validity — it only pulses while the create actually fires.
  const lookupsUsed = !!childPolicyQuery.data || phoneMatches.length > 0 || !!party;
  const railActiveKeys = [lookupsUsed ? "lookups" : null].filter(Boolean) as string[];
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
        <div className="bx-main formwrap" ref={formRef} style={{ margin: 0, maxWidth: "none" }}>
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

          {/* Agent / corporate bookings also name WHO is booking: the account carries the
              negotiated rate card and (for corporates) the contract ref + coordinator that
              pre-fill below. Shown under the New/Returning tabs (operator request 2026-07-31 —
              it used to sit above them) so the guest-identity choice stays the block's lead. */}
          {partyKind && (
            <PartySearch
              kind={partyKind}
              party={party}
              setParty={setParty}
              contact={partyContact}
              setContact={setPartyContact}
            />
          )}

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
                    customPlaceholder="Type the nationality"
                    otherLabel="Other…"
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
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 9 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!newGuestComplete || saveGuestMutation.isPending}
                  onClick={() => saveGuestMutation.mutate()}
                >
                  {saveGuestMutation.isPending ? "Saving…" : "Save guest"}
                </button>
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  Optional — saves the guest to the system now. Otherwise they&rsquo;re saved when you
                  open the booking.
                </span>
              </div>
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
            {/* Fixed once chosen. The channel was picked on the previous screen and it decides what
                the rest of this form asks for — the agent/corporate picker, the Policy 17 corporate
                context, the useType on the entry. Changing it here would strand fields already
                filled in against a different channel, so it's shown read-only and changed by going
                back to the booking-type screen, which resets those fields cleanly. */}
            <select value={isEdit ? editChannelKey : channelKey} disabled>
              {CHANNELS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            {!isEdit && (
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "5px 0 0" }}>
                Set when you picked the booking type.{" "}
                <button
                  type="button"
                  onClick={() => setWizardStep("type")}
                  style={{
                    background: "none",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--terra-d)",
                    textDecoration: "underline",
                    font: "inherit",
                  }}
                >
                  Change it
                </button>
              </p>
            )}
          </div>

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
                {childAges.map((age, i) => {
                  // Mark the field itself, and keep it marked for as long as the age stays above
                  // the ceiling, so the operator can see at review time which child is being
                  // charged as an adult — not just at the moment they typed it. An age at/above
                  // the adult threshold is a different, harder state: not a priced-as-adult
                  // child but an adult in the wrong field, shown red and blocking submit.
                  const isOverAge = overAgeIndexes.has(i);
                  const isAdultBand = !isOverAge && adultBandIndexes.has(i);
                  return (
                    <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <input
                        type="number"
                        min={0}
                        max={maxChildAge}
                        className="dinput"
                        style={{
                          width: 80,
                          borderColor: isOverAge ? "var(--stop)" : isAdultBand ? "var(--warn)" : undefined,
                          background: isOverAge ? "var(--stop-t)" : isAdultBand ? "var(--warn-t)" : undefined,
                          fontWeight: isOverAge || isAdultBand ? 700 : undefined,
                        }}
                        placeholder={`#${i + 1}`}
                        value={age}
                        aria-invalid={isOverAge || undefined}
                        aria-describedby={isOverAge || isAdultBand ? `child-adult-${i}` : undefined}
                        onChange={(e) =>
                          setChildAges((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                        }
                      />
                      {isOverAge ? (
                        <span
                          id={`child-adult-${i}`}
                          style={{ fontSize: 10, color: "var(--stop)", fontWeight: 700, textAlign: "center" }}
                          title={`${minAdultAge}+ is an adult — count this guest in the Adults field, not here`}
                        >
                          adult — not a child
                        </span>
                      ) : isAdultBand ? (
                        <span
                          id={`child-adult-${i}`}
                          style={{ fontSize: 10, color: "var(--warn)", fontWeight: 600, textAlign: "center" }}
                          title={`Over ${childMaxAge} — charged at the adult rate (own bed, full room share and meals)`}
                        >
                          adult rate
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <ChildAgeChargeNote
            childAges={childCountNum > 0 ? childAges : []}
            adultBandIndexes={childCountNum > 0 ? adultBandIndexes : new Set()}
            overAgeIndexes={childCountNum > 0 ? overAgeIndexes : new Set()}
            policyLoaded={!!childPolicyQuery.data}
            youngMaxAge={youngMaxAge}
            childMaxAge={childMaxAge}
            maxChildAge={maxChildAge}
            minAdultAge={minAdultAge}
            adultMealPercent={childPolicyQuery.data?.mealPricing.adultPercent ?? null}
            childMealPercent={childPolicyQuery.data?.mealPricing.childPercent ?? null}
          />

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
            {exceedsHotelCapacity ? (
              <p style={{ fontSize: 11.5, color: "var(--stop)", fontWeight: 600, margin: "6px 0 0", lineHeight: 1.5 }}>
                This party can’t be accommodated: {chargeableOccupants} chargeable guest
                {chargeableOccupants === 1 ? "" : "s"}, but the hotel’s {hotelRoomCount} registered room
                {hotelRoomCount === 1 ? "" : "s"} sleep at most {hotelMaxOccupants}. Reduce the party or split the
                booking.
              </p>
            ) : (
              <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "6px 0 0", lineHeight: 1.5 }}>
                {chargeableOccupants} chargeable guest{chargeableOccupants === 1 ? "" : "s"} (adults + children aged{" "}
                {maxChildAge + 1}+). Up to {largestMaxCapacity} per room, so {roomRange.min}–{roomRange.max} room
                {roomRange.max === 1 ? "" : "s"} allowed. This is driven by party size only — not how the guest booked.
              </p>
            )}
          </div>

          {/* Bed setup asked for (2026-08-13, operator request: "5 King and 2 Twin"). Options and
              ceilings come from the live rooms registry — King⇄Twin share convertible stock, so
              both show the same pool. Optional; a partial spec ("at least 2 King") is legal, and
              typing counts raises the room count to match (never lowers it). */}
          {bedTypeOptions.length > 0 && (
            <div className="field">
              <label>Bed setup asked for (optional)</label>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                {bedTypeOptions.map(({ type, count }) => (
                  <div key={type} style={{ display: "grid", gap: 3 }}>
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {bedLabelOf(type)}
                      <span title={`The hotel can set up at most ${count} ${bedLabelOf(type)} room${count === 1 ? "" : "s"}`}>
                        {" "}(up to {count})
                      </span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={count}
                      placeholder="0"
                      value={bedTypeCounts[type] ?? ""}
                      onChange={(e) => setBedTypeCounts((prev) => ({ ...prev, [type]: e.target.value }))}
                      style={{ width: 86 }}
                    />
                  </div>
                ))}
              </div>
              {bedStockShortfall ? (
                <p style={{ fontSize: 11.5, color: "var(--stop)", fontWeight: 600, margin: "6px 0 0", lineHeight: 1.5 }}>
                  The hotel can’t set up {bedStockShortfall.asked} {bedStockShortfall.types} room
                  {bedStockShortfall.asked === 1 ? "" : "s"} — its bed stock supports at most {bedStockShortfall.stock}
                  {bedStockShortfall.pooled ? " (King and Twin rooms share the same convertible stock)" : ""}.
                </p>
              ) : bedSetupOverRooms ? (
                <p style={{ fontSize: 11.5, color: "var(--stop)", fontWeight: 600, margin: "6px 0 0", lineHeight: 1.5 }}>
                  The bed setup adds up to {bedRequestSum} rooms but the party size allows at most {roomRange.max} — trim
                  the setup or grow the party.
                </p>
              ) : bedRequestSum > 0 ? (
                <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "6px 0 0", lineHeight: 1.5 }}>
                  {bedRequestSum === roomsNum
                    ? `Adds up to ${bedRequestSum} room${bedRequestSum === 1 ? "" : "s"} — matches the room count.`
                    : `${bedRequestSum} of the ${roomsNum} rooms have a stated bed setup — the rest are flexible.`}{" "}
                  Recorded on the booking; the Inquiry step tallies picked rooms against it.
                </p>
              ) : null}
            </div>
          )}

          <div className="frow" style={{ gridTemplateColumns: "1fr 90px 1fr" }}>
            <div className="field">
              <label>Check-in</label>
              <DateField min={today} value={checkIn} onChange={setCheckIn} />
            </div>
            <div className="field">
              <label>Nights</label>
              <input
                type="number"
                min={1}
                value={nightsStr}
                onChange={(e) => setNightsStr(e.target.value)}
                title="Check-out auto-selects from check-in + nights"
              />
            </div>
            <div className="field">
              <label>Check-out</label>
              <DateField min={nextDayIso(checkIn) || today} value={checkOut} onChange={onCheckOutChange} />
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
