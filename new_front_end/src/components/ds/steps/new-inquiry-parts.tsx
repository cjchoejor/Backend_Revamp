"use client";

/**
 * The pieces the New inquiry screen is built from: the channel vocabulary, the dialling-code and
 * nationality presets, the pick lists, the agency / company search with its contact persons, the
 * child charge note and the gate list.
 *
 * Every rule here was carried over from the old intake form (components/desk/inquiry/
 * new-inquiry-form.tsx) — only the dress changed.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { guestFullName, type GuestProfileSummary } from "@/lib/api/guest-profiles";
import {
  addPartyContact,
  searchCorporateAccountsLookup,
  searchTravelAgentsLookup,
  type CoordinatorContact,
  type LookupPartyMatch,
} from "@/lib/api/inquiries";
import { plural } from "@/lib/ds/format";
import { toastRefusal } from "./kit";

/* ------------------------------------------------------------------ vocabulary */

export type PartyKind = "TRAVEL_AGENT" | "CORPORATE";

export type ChannelKey = "WALK_IN" | "DIRECT_VOICE" | "DIRECT_ONLINE" | "OTA" | "AGENT" | "CORPORATE" | "GROUP";

export type ChannelDef = {
  key: ChannelKey;
  label: string;
  /** One of the five sourceChannel values the backend accepts (custodian Policy 3 refuses others). */
  channel: "WALK_IN" | "DIRECT" | "OTA" | "AGENT" | "CORPORATE";
  /** How the guest came in, as stored in Inquiry.cameInAs (2026-09-18 — it used to ride in the notes). */
  cameInAs: "WALK_IN" | "DIRECT_VOICE" | "DIRECT_ONLINE" | "OTA" | "TRAVEL_AGENT" | "CORPORATE" | "GROUP_MICE";
  party: PartyKind | null;
  /** The kind of stay the channel starts with. */
  useType: string;
};

/** "Came in as", in the prototype's order. */
export const CHANNELS: ReadonlyArray<ChannelDef> = [
  { key: "WALK_IN", label: "Walk-in", channel: "WALK_IN", cameInAs: "WALK_IN", party: null, useType: "LEISURE" },
  { key: "DIRECT_VOICE", label: "Direct voice", channel: "DIRECT", cameInAs: "DIRECT_VOICE", party: null, useType: "LEISURE" },
  { key: "DIRECT_ONLINE", label: "Direct online", channel: "DIRECT", cameInAs: "DIRECT_ONLINE", party: null, useType: "LEISURE" },
  { key: "OTA", label: "OTA", channel: "OTA", cameInAs: "OTA", party: null, useType: "LEISURE" },
  { key: "AGENT", label: "Travel agent", channel: "AGENT", cameInAs: "TRAVEL_AGENT", party: "TRAVEL_AGENT", useType: "LEISURE" },
  // A company's booking is a corporate stay unless the desk says otherwise (2026-09-18) — it
  // defaulted to leisure, which hid the payment milestones a company booking is scheduled on.
  { key: "CORPORATE", label: "Corporation", channel: "CORPORATE", cameInAs: "CORPORATE", party: "CORPORATE", useType: "CORPORATE" },
  { key: "GROUP", label: "Group / MICE", channel: "DIRECT", cameInAs: "GROUP_MICE", party: null, useType: "GROUP" },
];

export const CHANNEL_OPTIONS = CHANNELS.map((c) => [c.key, c.label] as const);

export function channelDef(key: ChannelKey | null | undefined): ChannelDef | null {
  return CHANNELS.find((c) => c.key === key) ?? null;
}

/**
 * How a saved inquiry came in, as the operator chose it. The stored column decides (2026-09-18);
 * the old reading — the channel plus the words the desk used to add to the notes — is kept only
 * for an inquiry the column could not be filled for (a plain DIRECT from an API caller).
 */
export function cameInAsOf(
  channel?: string | null,
  notes?: string | null,
  useType?: string | null,
  stored?: string | null,
): ChannelKey | null {
  const byColumn = stored ? CHANNELS.find((c) => c.cameInAs === stored) : null;
  if (byColumn) return byColumn.key;
  if (!channel) return null;
  if (channel === "WALK_IN") return "WALK_IN";
  if (channel === "OTA") return "OTA";
  if (channel === "AGENT" || channel === "TRAVEL_AGENT") return "AGENT";
  if (channel === "CORPORATE") return "CORPORATE";
  if (channel === "DIRECT") {
    if (useType === "GROUP" || /group \/ mice/i.test(notes ?? "")) return "GROUP";
    if (/direct \(online\)/i.test(notes ?? "")) return "DIRECT_ONLINE";
    return "DIRECT_VOICE";
  }
  return null;
}

export const USE_TYPES = [
  ["LEISURE", "Leisure"],
  ["CORPORATE", "Corporate"],
  ["GROUP", "Group"],
  ["CONFERENCE", "Conference"],
  ["APARTMENT", "Apartment"],
] as const;
export type UseTypeKey = (typeof USE_TYPES)[number][0];

export const PHONE_CODES = ["+975", "+91", "+61"];
export const NATIONALITIES = ["Bhutanese", "Indian"];

export const BED_ORDER = ["KING", "QUEEN", "TWIN", "SINGLE"];
export const bedWord = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

/* ------------------------------------------------------------------ small helpers */

/**
 * A stored phone split back into the code + number pair the form edits. Adopting a guest found
 * from a few typed digits must replace that fragment with the guest's real number, or the
 * fragment flows into the booking's contact person.
 */
export function splitStoredPhone(full: string | null | undefined): { code: string; number: string } {
  const v = (full ?? "").trim();
  if (!v) return { code: PHONE_CODES[0], number: "" };
  const strip = (s: string) => s.replace(/^[\s-]+/, "").trim();
  const preset = PHONE_CODES.find((c) => v.startsWith(c));
  if (preset) return { code: preset, number: strip(v.slice(preset.length)) };
  const m = v.match(/^(\+\d{1,4})[\s-]*(.*)$/);
  if (m) return { code: m[1], number: strip(m[2]) };
  // Most imported numbers carry no dialling code; leave it blank rather than assume one.
  return { code: "", number: v };
}

/** The calendar day `n` nights after `iso` (a stay date, UTC-safe). */
export function addNightsIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole nights between two stay dates (check-out exclusive); 0 when either is not a date. */
export function diffNightsIso(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
}

export const digits = (v: string, max = 3) => v.replace(/\D/g, "").slice(0, max);

/**
 * The contact a booking starts with when a party is picked: its first contact person, or — none
 * on file — the party's own name, first number and email. Every field stays editable.
 */
export function defaultContactFor(party: LookupPartyMatch): CoordinatorContact {
  const first = (party.coordinators ?? [])[0];
  if (first) return first;
  return { name: party.displayName, phone: party.contactNumbers?.[0] ?? null, email: party.contactEmail ?? null };
}

/* ------------------------------------------------------------------ controls */

const OTHER = "__other__";

/**
 * A preset list that turns into free text for any other value. `otherLabel` puts "Other…" in the
 * list (nationality); without it a small button does the same (the dialling code).
 */
export function PresetOrCustom({
  presets,
  value,
  onChange,
  placeholder,
  otherLabel,
  width,
  ariaLabel,
  disabled,
}: {
  presets: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  otherLabel?: string;
  width?: number;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState(value !== "" && !presets.includes(value));
  // A value can arrive from outside (an adopted guest's stored nationality or code) — show it as
  // typed text rather than a select that silently displays an option it doesn't hold.
  useEffect(() => {
    if (value !== "" && !presets.includes(value)) setCustom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const style = width ? { width, flex: "0 0 auto" } : { flex: 1, minWidth: 0 };
  if (custom) {
    return (
      <span style={{ display: "flex", gap: 4, ...style }}>
        <input
          className="input"
          aria-label={ariaLabel}
          style={{ flex: 1, minWidth: 0 }}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          kind="quiet"
          compact
          iconOnly
          icon="retry"
          aria-label="Back to the list"
          title="Back to the list"
          state={disabled ? "inert" : "default"}
          onClick={() => {
            setCustom(false);
            onChange(presets[0]);
          }}
        />
      </span>
    );
  }
  const toCustom = () => {
    setCustom(true);
    onChange("");
  };
  return (
    <span style={{ display: "flex", gap: 4, ...style }}>
      <select
        className="input"
        aria-label={ariaLabel}
        style={{ flex: 1, minWidth: 0 }}
        value={value}
        disabled={disabled}
        onChange={(e) => (e.target.value === OTHER ? toCustom() : onChange(e.target.value))}
      >
        {/* A stored number can come without a code; without this option the select would show the
            first preset while holding nothing. */}
        {value === "" ? (
          <option value="" disabled>
            —
          </option>
        ) : null}
        {presets.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        {otherLabel ? <option value={OTHER}>{otherLabel}</option> : null}
      </select>
      {!otherLabel ? (
        <Button kind="quiet" compact title="Another code" aria-label="Another code" state={disabled ? "inert" : "default"} onClick={toCustom}>
          +
        </Button>
      ) : null}
    </span>
  );
}

/** A dialling code and a number, side by side. */
export function PhoneInput({
  code,
  setCode,
  number,
  setNumber,
  placeholder = "17 88 21 04",
  ariaLabel = "Phone",
}: {
  code: string;
  setCode: (v: string) => void;
  number: string;
  setNumber: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <span style={{ display: "flex", gap: 6 }}>
      <PresetOrCustom presets={PHONE_CODES} value={code} onChange={setCode} placeholder="+__" width={118} ariaLabel="Dialling code" />
      <input
        className="input"
        style={{ flex: 1, minWidth: 0 }}
        inputMode="tel"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={number}
        onChange={(e) => setNumber(e.target.value)}
      />
    </span>
  );
}

export type PickRow = { key: string; main: ReactNode; sub?: ReactNode; onPick: () => void };

/** A short list to pick one from — each row is the target. */
export function PickList({ head, rows, empty, action = "Use" }: { head?: ReactNode; rows: PickRow[]; empty?: ReactNode; action?: string }) {
  return (
    <div style={{ maxHeight: 264, overflowY: "auto", borderRadius: "var(--r-card)" }}>
      <table className="table compact">
        {head ? (
          <thead>
            <tr>
              <th colSpan={2}>{head}</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.length === 0 ? (
            <tr className="static">
              <td colSpan={2} className="meta">
                {empty ?? "Nothing to pick"}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.key}
                className="pickable"
                tabIndex={0}
                onClick={r.onPick}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    r.onPick();
                  }
                }}
              >
                <td>
                  {r.main}
                  {r.sub ? <span className="meta"> · {r.sub}</span> : null}
                </td>
                <td className="num nowrap">
                  <span className="meta">{action} →</span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** One guest in a pick list: the name, the number it matched on, the email behind. */
export function GuestLine({ guest }: { guest: GuestProfileSummary }) {
  return (
    <span>
      <b>{guestFullName(guest)}</b>
      {guest.phone ? <span className="money ink-2"> · {guest.phone}</span> : null}
      {guest.email ? <span className="meta"> · {guest.email}</span> : null}
      {guest.nationality ? <span className="meta"> · {guest.nationality}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ the agency or company */

/**
 * Search and pick a travel agent or a company. An empty search lists them all, so an operator
 * who knows the agency by sight but not by spelling can browse; the list opens on focus and
 * closes on click-away or Escape.
 */
export function PartySearch({
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
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const results = useQuery({
    queryKey: ["desk-party-lookup", kind, term],
    queryFn: () => (kind === "TRAVEL_AGENT" ? searchTravelAgentsLookup(session!, term) : searchCorporateAccountsLookup(session!, term)),
    enabled: !!session && open && !party,
  });
  const noun = kind === "TRAVEL_AGENT" ? "agency" : "company";
  const label = kind === "TRAVEL_AGENT" ? "Travel agent" : "Company";

  if (party) {
    return (
      <div className="wide field">
        <label>{label}</label>
        <span style={{ display: "flex", gap: 6 }}>
          <input className="input" readOnly style={{ flex: 1, minWidth: 0 }} value={party.contactEmail ? `${party.displayName} · ${party.contactEmail}` : party.displayName} />
          <Button kind="secondary" compact onClick={() => setParty(null)}>
            Change
          </Button>
        </span>
        <span className="hint">the record carries the rates and the terms</span>
      </div>
    );
  }

  const matches = results.data?.matches ?? [];
  // The cap is the server's — landing exactly on it means the roster was cut.
  const cap = results.data?.limit;
  const atCap = cap !== undefined && matches.length >= cap;
  return (
    <div className="wide field" ref={wrap}>
      <label>{label}</label>
      <input
        className="input"
        placeholder="start typing — the record carries the rates and the terms"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
      />
      {open ? (
        <>
          {results.isLoading ? (
            <span className="meta">Looking…</span>
          ) : (
            <PickList
              rows={matches.map((m) => ({
                key: m.id,
                main: <b>{m.displayName}</b>,
                sub: m.contactEmail ?? undefined,
                onPick: () => {
                  setParty(m);
                  setOpen(false);
                },
              }))}
              empty={term ? `No ${noun} matches “${term}”` : `No ${noun} on file`}
              action="Pick"
            />
          )}
          {matches.length > 0 ? (
            <span className="hint">
              {atCap
                ? `the first ${matches.length} shown — keep typing to narrow`
                : term
                  ? plural(matches.length, "match", "matches")
                  : `${matches.length} on file — type to narrow`}
            </span>
          ) : null}
        </>
      ) : (
        <span className="hint">optional · pick the {noun} and its rates follow</span>
      )}
    </div>
  );
}

/**
 * The contact persons on the picked agency or company. An agency rarely has one voice: the ones
 * on file are offered, and a new one is filed on the party (append-only, L1) so the next booking
 * through them already has them. The pick is who the hotel rings about this stay.
 */
export function PartyContacts({
  kind,
  party,
  setParty,
  contact,
  setContact,
}: {
  kind: PartyKind;
  party: LookupPartyMatch;
  setParty: (p: LookupPartyMatch) => void;
  contact: CoordinatorContact | null;
  setContact: (c: CoordinatorContact | null) => void;
}) {
  const { session } = useSession();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState(PHONE_CODES[0]);
  const [phone, setPhone] = useState("");
  const contacts = party.coordinators ?? [];
  const noun = kind === "TRAVEL_AGENT" ? "agency" : "company";

  const add = useMutation({
    mutationFn: () =>
      addPartyContact(session!, kind, party.id, {
        name: name.trim(),
        phone: phone.trim() ? `${code}${phone.trim()}` : null,
      }),
    onSuccess: (res) => {
      setParty({ ...party, coordinators: res.coordinators });
      // Adding with nobody picked IS the pick; with someone picked it only files another person.
      if (!contact) setContact(res.contact);
      setAdding(false);
      setName("");
      setPhone("");
      toast.success(
        !res.added
          ? `${res.contact.name} was already on file`
          : contact
            ? `${res.contact.name} is filed on ${party.displayName} — ${contact.name} stays the contact for this booking`
            : `${res.contact.name} is filed on ${party.displayName}`,
      );
    },
    onError: (e) => toastRefusal(e, "The contact person could not be filed"),
  });

  const addBlock = adding ? (
    <div className="bind provisional" style={{ display: "grid", gap: 8 }}>
      <div className="form2">
        <div className="field">
          <label>Their name</label>
          <input className="input" autoFocus value={name} placeholder="the person on the phone" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Their phone · optional</label>
          <PhoneInput code={code} setCode={setCode} number={phone} setNumber={setPhone} ariaLabel="Their phone" />
        </div>
      </div>
      <div className="row-acts">
        <Button
          compact
          state={add.isPending ? "working" : name.trim() ? "default" : "inert"}
          title={name.trim() ? undefined : "write their name first"}
          workingLabel="Filing…"
          onClick={() => add.mutate()}
        >
          File on the {noun}
        </Button>
        <Button kind="quiet" compact onClick={() => setAdding(false)}>
          Not now
        </Button>
        <span className="meta">kept on {party.displayName}, so it is here the next time they book</span>
      </div>
    </div>
  ) : (
    <div className="row-acts">
      <Button kind="quiet" compact icon="person" onClick={() => setAdding(true)}>
        {contact ? "File another contact person" : "A new contact person"}
      </Button>
    </div>
  );

  if (contact) {
    return (
      <div className="wide" style={{ display: "grid", gap: 8 }}>
        <div className="form2">
          <div className="field">
            <label>Contact person</label>
            <input className="input" placeholder="their name" value={contact.name ?? ""} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Their phone</label>
            <input
              className="input"
              inputMode="tel"
              placeholder="+975 …"
              value={contact.phone ?? ""}
              onChange={(e) => setContact({ ...contact, phone: e.target.value })}
            />
          </div>
          <div className="wide field">
            <label>Their email</label>
            <input
              className="input"
              type="email"
              placeholder="optional"
              value={contact.email ?? ""}
              onChange={(e) => setContact({ ...contact, email: e.target.value })}
            />
            <span className="hint">
              {contacts.length === 0
                ? `No contact person on file — these are ${party.displayName}'s own details; type over them if someone else is calling.`
                : contacts.length > 1
                  ? `Taken from ${party.displayName} — ${contacts.length} people are on file, so check it is the right one.`
                  : `Taken from ${party.displayName} — change it if someone else is calling.`}
            </span>
          </div>
        </div>
        {contacts.length > 1 ? (
          <div className="row-acts">
            <Button kind="quiet" compact onClick={() => setContact(null)}>
              Pick another from the {noun}
            </Button>
          </div>
        ) : null}
        {addBlock}
      </div>
    );
  }

  return (
    <div className="wide field">
      <label>Contact person</label>
      {contacts.length > 0 ? (
        <PickList
          head={`On file for ${party.displayName}`}
          rows={contacts.map((c, i) => ({
            key: `${c.name}-${i}`,
            main: <b>{c.name}</b>,
            sub: [c.phone, c.email].filter(Boolean).join(" · ") || undefined,
            onPick: () => setContact(c),
          }))}
        />
      ) : (
        <span className="hint">No contact person on file for this {noun} yet — file the person you are speaking to.</span>
      )}
      {addBlock}
    </div>
  );
}

/* ------------------------------------------------------------------ children */

/**
 * The child charge bands, stated on the page all the time rather than in a toast: the rule is most
 * useful before an age is typed. Amber names the children charged as adults; red names an age
 * that is an adult and keeps the inquiry from being saved. Every number is the hotel's policy —
 * until it loads, no number is printed at all.
 */
export function ChildChargeNote({
  ages,
  adultBand,
  overAge,
  loaded,
  youngMax,
  childMax,
  minAdult,
  adultMealPercent,
  childMealPercent,
}: {
  ages: string[];
  adultBand: Set<number>;
  overAge: Set<number>;
  loaded: boolean;
  youngMax: number;
  childMax: number;
  minAdult: number;
  adultMealPercent: number | null;
  childMealPercent: number | null;
}) {
  const named = (set: Set<number>) =>
    ages
      .map((raw, i) => ({ n: parseInt(raw || "", 10), i }))
      .filter(({ n, i }) => set.has(i) && Number.isFinite(n))
      .map(({ n, i }) => `child ${i + 1} is ${n}`)
      .join(" · ");
  const red = named(overAge);
  const amber = named(new Set([...adultBand].filter((i) => !overAge.has(i))));
  return (
    <div className={red ? "refusal rule" : "notice inert"} style={{ display: "grid", gap: 4 }}>
      {red ? (
        <span className="sm">
          <Icon name="alert" /> <b>{red.charAt(0).toUpperCase() + red.slice(1)}</b> — an adult, not a child. Count them under Adults; the inquiry
          cannot be saved until the age is fixed.
        </span>
      ) : null}
      {amber ? (
        <span className="sm warn-ink">
          <b>{amber.charAt(0).toUpperCase() + amber.slice(1)}</b> — charged at the adult rate.
        </span>
      ) : null}
      {loaded ? (
        <span className="sm ink-2">
          Everyone under {minAdult} is a child, and the age sets the charge: under {youngMax + 1} stay and eat free · {youngMax + 1}–{childMax} at child
          rates{childMealPercent !== null ? ` (${childMealPercent}% of meals)` : ""} ·{" "}
          <b>
            {childMax + 1}–{minAdult - 1} charged as adults
          </b>{" "}
          (own bed, full room share, {adultMealPercent !== null ? `${adultMealPercent}% of meals` : "full meals"}) while still minors for supervision. {minAdult}{" "}
          and over go under Adults.
        </span>
      ) : (
        <span className="meta">Reading the hotel&rsquo;s child charge bands…</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the gate */

export type GateLine = { label: string; whose: "desk" | "system"; met: boolean; how?: string };

export function GateList({ items }: { items: GateLine[] }) {
  return (
    <div className="gate">
      {items.map((i) => (
        <div key={i.label} className={`item ${i.met ? "met" : "unmet"}`}>
          <Icon name={i.met ? "check" : "circle"} />
          <span>
            {i.label}
            <span className="whose">· {i.whose}</span>
            {!i.met && i.how ? <span className="how">{i.how}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A line the system acts on, marked as the system's. */
export function SystemLine({ children }: { children: ReactNode }) {
  return (
    <span className="src system meta">
      <Icon name="auto" className="g" />
      <span>{children}</span>
    </span>
  );
}
