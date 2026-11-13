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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { guestFullName, type GuestProfileSummary } from "@/lib/api/guest-profiles";
import {
  addPartyContact,
  createTravelAgentLookup,
  searchCorporateAccountsLookup,
  searchTravelAgentsLookup,
  type CallerMatch,
  type CoordinatorContact,
  type LookupPartyMatch,
  type LookupRatePackage,
} from "@/lib/api/inquiries";
import type { AllowedRoomCountsResponse } from "@/lib/api/child-policy";
import { fmtDay, fmtInstantDate, plural } from "@/lib/ds/format";
import { toastRefusal } from "./kit";
import { Help, HelpHere } from "@/components/ds/help";
import { PhoneField } from "@/components/ds/phone-field";
import { TitleSelect } from "@/components/ds/person-name";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { problemOfPhone, type PhoneRules } from "@/lib/ds/phone";
import { titled } from "@/lib/ds/person";

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
  { key: "CORPORATE", label: "Corporate", channel: "CORPORATE", cameInAs: "CORPORATE", party: "CORPORATE", useType: "CORPORATE" },
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

/** The ticks, in the prototype's order. None ticked is Direct voice. */
const TICKED: ReadonlyArray<ChannelKey> = ["WALK_IN", "DIRECT_ONLINE", "OTA", "AGENT", "CORPORATE", "GROUP"];

/**
 * How they came in, as ticks at the head of The caller (2026-11-05, operator: "incorporate the came
 * in as options there, if none of the boxes are clicked, default it to direct voice"). One at a time:
 * a tick takes the place of the last one, and taking it off goes back to Direct voice.
 */
export function CameInTicks({ value, onChange, disabled }: { value: ChannelKey | null; onChange: (k: ChannelKey | null) => void; disabled?: boolean }) {
  const none = !value || value === "DIRECT_VOICE";
  return (
    <div className="field">
      <div className="camein-ticks" role="group" aria-label="How they came in">
        {TICKED.map((k) => {
          const on = value === k;
          return (
            <label key={k} className={`camein-tick${on ? " on" : ""}${disabled ? " off" : ""}`}>
              <input type="checkbox" checked={on} disabled={disabled} onChange={() => onChange(on ? null : k)} />
              {channelDef(k)?.label}
            </label>
          );
        })}
      </div>
      <span className="hint camein-word">{none ? "None ticked — Direct voice: they rang the hotel" : null}</span>
    </div>
  );
}

export const USE_TYPES = [
  ["LEISURE", "Leisure"],
  ["CORPORATE", "Corporate"],
  ["GROUP", "Group"],
  ["CONFERENCE", "Conference"],
  ["APARTMENT", "Apartment"],
] as const;
export type UseTypeKey = (typeof USE_TYPES)[number][0];

export const NATIONALITIES = ["Bhutanese", "Indian"];

export const BED_ORDER = ["KING", "QUEEN", "TWIN", "SINGLE"];
export const bedWord = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

/* ------------------------------------------------------------------ small helpers */

/**
 * The room counts just past what the party allows, for a Rooms dropdown to list shut with what each
 * needs (2026-10-28, operator: a second room could not be chosen and the list said nothing). Every
 * room needs a guest of `adultFrom` or over in it — younger children share a room. Never past the
 * hotel's own rooms.
 */
export function moreRoomsNeedGuests(max: number, hotelRooms: number | null, adultFrom: number, extra = 2): Array<{ n: number; label: string }> {
  const out: Array<{ n: number; label: string }> = [];
  for (let n = max + 1; n <= max + extra; n++) {
    if (hotelRooms != null && n > hotelRooms) break;
    const more = n - max;
    out.push({ n, label: `${plural(n, "room")} · needs ${more} more ${more === 1 ? "guest" : "guests"} aged ${adultFrom}+` });
  }
  return out;
}

/**
 * Rooms on a booking: the counts the party allows, the booking's own count kept on the list even
 * when it falls outside (a stored figure is never silently changed), and the next counts shut,
 * saying what they need. The Inquiry step and Change the dates, rooms or guests both ask it here.
 */
export function RoomCountField({
  env,
  rooms,
  onChange,
  adultFrom,
  disabled,
  children,
}: {
  env: AllowedRoomCountsResponse | null | undefined;
  rooms: number;
  onChange: (rooms: number) => void;
  /** The age a guest counts as an adult from. */
  adultFrom: number;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const range = env?.allowedRoomCounts ?? null;
  const options = range && range.min > 0 && range.max >= range.min ? Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i) : [];
  if (!options.includes(rooms)) options.push(rooms);
  options.sort((a, b) => a - b);
  const shut = range ? moreRoomsNeedGuests(range.max, env?.hotelRoomCount ?? null, adultFrom).filter((o) => !options.includes(o.n)) : [];
  return (
    <div className="field">
      <label>
        Rooms
        <Help label="About the room count">
          {env
            ? `Starts at two guests to a room. At least ${env.allowedRoomCounts.min}, at most ${env.allowedRoomCounts.max} for ${plural(env.chargeableOccupants, "chargeable guest")}. The room type is ours to pick.`
            : "A count — the room type is ours to pick."}
        </Help>
      </label>
      <select className="input" value={String(rooms)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((n) => (
          <option key={n} value={String(n)}>
            {plural(n, "room")}
            {range && n < range.min ? " · too few" : range && n > range.max ? " · more than the guests" : ""}
          </option>
        ))}
        {shut.map((o) => (
          <option key={o.n} value={String(o.n)} disabled>
            {o.label}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
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

/** A red asterisk on a label — the field (or, with its partner, one of the two) is needed. */
export function ReqMark({ title = "needed" }: { title?: string }) {
  return (
    <span className="stop-ink" aria-hidden title={title} style={{ fontWeight: 700, marginLeft: 2 }}>
      *
    </span>
  );
}

/**
 * One caller in the caller list (2026-10-27): the name, who they ring for (an agency, a company, or
 * themselves), the number and email, how often they have rung, and under it the guests they
 * brought before — shown, not picked; the guest staying is named at Wrap up.
 */
const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").toLowerCase().replace(/\s+/g, " ").trim() === (b ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The person at the party a caller-list row names, or null when the row is the party's own line
 * (or a caller recorded as the party itself).
 */
export function partyPersonOf(caller: CallerMatch): CoordinatorContact | null {
  if (!caller.party || caller.foundAs === "PARTY_NUMBER") return null;
  const c = caller.partyContact;
  return c && c.name && !sameName(c.name, caller.party.displayName) ? c : null;
}

/** Whether a booking's caller is the agency or company itself — never a guest of the hotel. */
export function callerIsTheParty(
  inq: { callerFirstName?: string | null; callerLastName?: string | null } | null | undefined,
  partyName: string | null | undefined,
): boolean {
  if (!inq || !partyName) return false;
  return sameName(`${inq.callerFirstName ?? ""} ${inq.callerLastName ?? ""}`, partyName);
}

export function CallerLine({ caller }: { caller: CallerMatch }) {
  // An agency's or a company's caller IS the party (2026-10-27, operator): the row leads with the
  // party; the person at it, when known, is its contact.
  const person = partyPersonOf(caller);
  const name = caller.party ? caller.party.displayName : [caller.title, caller.firstName, caller.lastName].filter(Boolean).join(" ");
  const tag = caller.party ? (caller.kind === "TRAVEL_AGENT" ? "Travel agent" : "Company") : "Direct";
  const where =
    caller.foundAs === "PARTY_NUMBER"
      ? "the office line"
      : caller.foundAs === "PARTY_CONTACT" && caller.calls === 0
        ? "on their contact list"
        : caller.calls > 0
          ? `rang ${caller.calls === 1 ? "once" : `${caller.calls} times`}${caller.lastCalledAt ? ` · last ${fmtInstantDate(caller.lastCalledAt)}` : ""}`
          : null;
  return (
    <span style={{ display: "grid", gap: 2 }}>
      <span>
        <b>{name || (caller.party ? caller.party.displayName : "No name on record")}</b>{" "}
        <span className={`chip${caller.party ? " accent" : ""}`} style={{ marginLeft: 4 }}>
          {tag}
        </span>
        {caller.phone ? <span className="money ink-2"> · {caller.phone}</span> : null}
        {caller.email ? <span className="meta"> · {caller.email}</span> : null}
        {where ? <span className="meta"> · {where}</span> : null}
      </span>
      {person ? <span className="meta">Contact person: {person.name}</span> : null}
      {caller.guests.length > 0 ? (
        <span className="meta">
          Brought before:{" "}
          {caller.guests
            .map((g) => `${guestFullName(g)}${g.lastStay ? ` (${fmtDay(g.lastStay)})` : ""}`)
            .join(" · ")}
        </span>
      ) : null}
    </span>
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
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  // A new agency rang in (2026-09-29): file it from here — name and contact, no rates — instead
  // of starting the lead unlinked, which could never be attached to the agency afterwards.
  const [filing, setFiling] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
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
  const phoneRules = usePhoneRules();
  const newPhoneBad = !!problemOfPhone(phoneRules, newPhone);

  const file = useMutation({
    mutationFn: () =>
      createTravelAgentLookup(session!, {
        displayName: newName.trim(),
        phone: newPhone || null,
        email: newEmail.trim() || null,
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ["desk-party-lookup"] });
      setParty(created);
      setFiling(false);
      setOpen(false);
      setQ("");
      setTerm("");
      setNewName("");
      setNewPhone("");
      setNewEmail("");
      toast.success(`${created.displayName} is on file and picked for this booking`, {
        description: "No rates of its own yet — until the admin sets its rate package the booking prices on the hotel's common package, and the desk can still negotiate at Negotiation.",
      });
    },
    onError: (e) => toastRefusal(e, "The agency could not be filed"),
  });
  const startFiling = () => {
    setNewName(q.trim());
    setFiling(true);
  };
  const filingBlock = filing ? (
    <div className="bind provisional" style={{ display: "grid", gap: 8, marginTop: 6 }}>
      <span className="sm">
        <b>New agency</b> · filed active with no rates of its own — it prices on the hotel's common package until the admin sets its rate package
      </span>
      <div className="form2">
        <div className="field">
          <label>Agency name</label>
          <input className="input" autoFocus value={newName} placeholder="as they gave it" onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div className="field">
          <label>Agency phone · optional</label>
          <PhoneField value={newPhone} onChange={setNewPhone} ariaLabel="Agency phone" />
        </div>
        <div className="field">
          <label>Agency email · optional</label>
          <input className="input" type="email" value={newEmail} placeholder="bookings@…" onChange={(e) => setNewEmail(e.target.value)} />
        </div>
      </div>
      <div className="row-acts">
        <Button compact state={file.isPending ? "working" : newName.trim() && !newPhoneBad ? "default" : "inert"} reason={!newName.trim() ? "the agency's name first" : newPhoneBad ? "put the phone right first" : undefined} workingLabel="Filing…" onClick={() => file.mutate()}>
          File the agency
        </Button>
        <Button kind="quiet" compact onClick={() => setFiling(false)}>
          Cancel
        </Button>
      </div>
    </div>
  ) : null;

  if (party) {
    return (
      <div className="wide field">
        <label>
          {label}
          <Help label={`About ${label}`}>The record carries the rates and the terms.</Help>
        </label>
        <span style={{ display: "flex", gap: 6 }}>
          <input className="input" readOnly style={{ flex: 1, minWidth: 0 }} value={party.contactEmail ? `${party.displayName} · ${party.contactEmail}` : party.displayName} />
          <Button kind="secondary" compact onClick={() => setParty(null)}>
            Change
          </Button>
        </span>
      </div>
    );
  }

  const matches = results.data?.matches ?? [];
  // The cap is the server's — landing exactly on it means the roster was cut.
  const cap = results.data?.limit;
  const atCap = cap !== undefined && matches.length >= cap;
  return (
    <div className="wide field" ref={wrap}>
      <label>
        {label}
        <Help label={`About ${label}`}>Pick the {noun} and its rates and its people follow.</Help>
      </label>
      <input
        className="input"
        placeholder={`search the ${noun} by name`}
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
                  setQ("");
                  setTerm("");
                },
              }))}
              empty={
                term
                  ? kind === "CORPORATE"
                    ? `No company matches “${term}” — the admin adds a company; meanwhile take the tick off and take the caller's details`
                    : `No agency matches “${term}”`
                  : `No ${noun} on file`
              }
              action="Pick"
            />
          )}
          <span className="hint" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {matches.length > 0
              ? atCap
                ? `the first ${matches.length} shown — keep typing to narrow`
                : term
                  ? plural(matches.length, "match", "matches")
                  : `${matches.length} on file — type to narrow`
              : null}
            {kind === "TRAVEL_AGENT" && !filing ? (
              <Button kind="quiet" compact onClick={startFiling}>
                {term ? `New agency “${term}”` : "New agency"}
              </Button>
            ) : null}
          </span>
          {filingBlock}
        </>
      ) : null}
    </div>
  );
}

/** Two contacts are the same person: by their number, else by their name. */
function sameContact(a: CoordinatorContact, b: CoordinatorContact) {
  const key = (c: CoordinatorContact) => (c.phone ?? "").replace(/\D/g, "").slice(-8);
  return key(a) && key(b) ? key(a) === key(b) : sameName(a.name, b.name);
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What stops the contact persons being saved, in words, or null. Every one needs a name. */
export function contactsProblem(contacts: CoordinatorContact[], rules: PhoneRules): string | null {
  for (const c of contacts) {
    if (!c.name?.trim()) return "a name on every contact person";
    const bad = problemOfPhone(rules, c.phone);
    if (bad) return `${c.name.trim()}'s phone: ${bad}`;
    if (c.email?.trim() && !EMAIL_SHAPE.test(c.email.trim())) return `${c.name.trim()}'s email does not read as one`;
  }
  return null;
}

/**
 * The contact persons on this booking, one line each (2026-11-05, operator: "show the contact person
 * in a small continuous field … and the add another contact below it, when user clicks on that button
 * it can show what is shown currently and then there should be a save button, that adds the contact
 * below it, beside each name there can be a small red x button to remove it").
 *
 * The first is who is rung first. The × takes someone off this booking, not off the agency: their
 * record stays on file and the list offers them again. Someone new is filed on the party (L1,
 * append-only), so the next booking through them already has them. A click on a line opens it to be
 * put right, which stays this booking's: a number that no longer reads has to be fixable here.
 */
const NO_CONTACT = { title: "", name: "", phone: "", email: "" };

export function PartyContacts({
  kind,
  party,
  setParty,
  contacts,
  setContacts,
  readOnly,
}: {
  kind: PartyKind;
  party: LookupPartyMatch;
  setParty: (p: LookupPartyMatch) => void;
  contacts: CoordinatorContact[];
  setContacts: (c: CoordinatorContact[]) => void;
  readOnly?: boolean;
}) {
  const { session } = useSession();
  const rules = usePhoneRules();
  const noun = kind === "TRAVEL_AGENT" ? "agency" : "company";
  const onFile = party.coordinators ?? [];
  const notOnBooking = onFile.filter((c) => !contacts.some((x) => sameContact(x, c)));
  // What the form is for: nothing, someone to add, or the line at this place.
  const [open, setOpen] = useState<"new" | number | null>(null);
  const [n, setN] = useState(NO_CONTACT);
  // Picked from the list and not touched since: already on file, so nothing to file.
  const [picked, setPicked] = useState<CoordinatorContact | null>(null);
  const newBad = !n.name.trim() ? "write their name first" : problemOfPhone(rules, n.phone) ?? (n.email.trim() && !EMAIL_SHAPE.test(n.email.trim()) ? "the email does not read as one" : null);

  const close = () => {
    setOpen(null);
    setN(NO_CONTACT);
    setPicked(null);
  };
  const edit = (patch: Partial<typeof NO_CONTACT>) => {
    setN((cur) => ({ ...cur, ...patch }));
    setPicked(null);
  };
  const pick = (c: CoordinatorContact) => {
    setN({ title: c.title ?? "", name: c.name ?? "", phone: c.phone ?? "", email: c.email ?? "" });
    setPicked(c);
  };
  const openLine = (i: number) => {
    const c = contacts[i];
    setN({ title: c.title ?? "", name: c.name ?? "", phone: c.phone ?? "", email: c.email ?? "" });
    setPicked(null);
    setOpen(i);
  };
  const removeAt = (i: number) => {
    setContacts(contacts.filter((_, j) => j !== i));
    // The form must not go on holding a line that has just moved up, or gone.
    if (typeof open === "number") close();
  };

  const add = useMutation({
    mutationFn: () =>
      addPartyContact(session!, kind, party.id, {
        title: n.title || null,
        name: n.name.trim(),
        phone: n.phone || null,
        email: n.email.trim() || null,
      }),
    onSuccess: (res) => {
      setParty({ ...party, coordinators: res.coordinators });
      setContacts([...contacts, res.contact]);
      close();
      toast.success(res.added ? `${res.contact.name} is filed on ${party.displayName} and added to this booking` : `${res.contact.name} was already on file — added to this booking`);
    },
    onError: (e) => toastRefusal(e, "The contact person could not be filed"),
  });

  const save = () => {
    if (typeof open === "number") {
      const line = { title: n.title || null, name: n.name.trim(), phone: n.phone || null, email: n.email.trim() || null };
      setContacts(contacts.map((c, j) => (j === open ? { ...c, ...line } : c)));
      close();
      return;
    }
    if (picked) {
      setContacts([...contacts, picked]);
      close();
      return;
    }
    add.mutate();
  };

  return (
    <div className="contact-block">
      <span className="contact-head">
        {contacts.length > 1 ? "Contact persons" : "Contact person"}
        {readOnly ? null : (
          <Help label="About contact persons">
            The first is rung first. The × takes someone off this booking only: they stay on file with the {noun}. Click a line to put it right.
          </Help>
        )}
      </span>
      {contacts.length ? (
        <ul className="contact-lines">
          {contacts.map((c, i) => {
            const bad = problemOfPhone(rules, c.phone);
            const words = (
              <>
                <b>{titled(c.title, c.name) || "no name"}</b>
                {c.phone ? <span className="contact-num">{c.phone}</span> : null}
                {c.email ? <span className="contact-mail">{c.email}</span> : null}
              </>
            );
            return (
              <li key={i} className={`contact-line${bad ? " bad" : ""}${open === i ? " open" : ""}`}>
                {readOnly ? (
                  <span className="contact-words">{words}</span>
                ) : (
                  <button type="button" className="contact-words" title="Put this contact right" onClick={() => openLine(i)}>
                    {words}
                  </button>
                )}
                {readOnly ? null : (
                  <button type="button" className="contact-x" aria-label={`Take ${titled(c.title, c.name) || "this contact"} off this booking`} title="Take off this booking" onClick={() => removeAt(i)}>
                    ×
                  </button>
                )}
                {bad ? <span className="contact-bad">the number: {bad}. Click it to put it right</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="hint warn-ink">No contact person on this booking yet — add who to ring.</span>
      )}

      {readOnly ? null : open === null ? (
        <div className="row-acts">
          <Button kind="secondary" compact icon="person" onClick={() => setOpen("new")}>
            {contacts.length ? "Add another contact" : "Add a contact person"}
          </Button>
        </div>
      ) : (
        <div className="contact-add">
          {open === "new" && notOnBooking.length ? (
            <div className="field">
              <label>On file for {party.displayName}</label>
              <select
                className="input"
                autoFocus
                value=""
                onChange={(e) => {
                  const c = notOnBooking[Number(e.target.value)];
                  if (c) pick(c);
                }}
              >
                <option value="" disabled>
                  {notOnBooking.length} on file — pick one, or write someone new below
                </option>
                {notOnBooking.map((c, i) => (
                  <option key={i} value={i}>
                    {[titled(c.title, c.name), c.phone, c.email].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="contact-add-row">
            <div className="person-name">
              <div className="field">
                <label>Title</label>
                <TitleSelect value={n.title} onChange={(title) => edit({ title })} />
              </div>
              <div className="field">
                <label>Contact person</label>
                <input className="input" autoFocus={open !== "new" || !notOnBooking.length} value={n.name} placeholder="the person on the phone" onChange={(e) => edit({ name: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Their phone</label>
              <PhoneField value={n.phone} ariaLabel="Their phone" onChange={(phone) => edit({ phone })} />
            </div>
            <div className="field">
              <label>Their email</label>
              <input className="input" type="email" value={n.email} placeholder="optional" onChange={(e) => edit({ email: e.target.value })} />
            </div>
          </div>
          <div className="row-acts">
            <Button compact className={newBad ? undefined : "go"} state={add.isPending ? "working" : newBad ? "inert" : "default"} title={newBad ?? undefined} workingLabel="Saving…" onClick={save}>
              Save
            </Button>
            <Button kind="quiet" compact onClick={close}>
              Not now
            </Button>
            {open === "new" && !picked ? <Help label="About saving a contact">Filed on {party.displayName} as well, so they are here the next time it books.</Help> : null}
            {newBad && n.name.trim() ? <span className="hint stop-ink">{newBad}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Which of the party's rate packages this booking is on (2026-09-29: it belongs WITH the party; an
 * agency like Bhutan INC carries Season · Off season · Premium). The figures are in the booking file's
 * Package tab. With nothing chosen, pricing takes the party's default, else its newest.
 */
/**
 * The rate packages chosen for the booking (2026-11-13, operator: "is there a way we can select
 * multiple package"). One or several of the party's packages; they are kept in the party's own order
 * (its default first), and the first ticked prices any room type not given a package of its own in
 * The house. None ticked: pricing takes the party's default, as before.
 */
export function packageWord(items: LookupRatePackage[], ids: readonly string[], none: string): string {
  if (ids.length === 0) return none;
  const names = ids.map((id) => items.find((p) => p.id === id)?.name ?? "a package no longer listed");
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
}

export function RatePackageField({
  packages,
  loading,
  values,
  onChange,
  readOnly,
  word,
}: {
  packages: LookupRatePackage[] | null;
  loading?: boolean;
  values: readonly string[];
  onChange: (ids: string[]) => void;
  readOnly?: boolean;
  /** What to show when there is nothing to choose from, or it may not be changed. */
  word: string;
}) {
  const items = packages ?? [];
  const usual = items.find((p) => p.isDefault) ?? null;
  const notListed = values.filter((id) => !items.some((p) => p.id === id));
  const toggle = (id: string) => {
    const on = values.includes(id);
    const next = on ? values.filter((x) => x !== id) : [...values, id];
    // The party's own order, its default first; one no longer listed (on record) stays in front.
    onChange([...next.filter((x) => !items.some((p) => p.id === x)), ...items.filter((p) => next.includes(p.id)).map((p) => p.id)]);
  };
  const primary = values.length > 1 ? (items.find((p) => p.id === values[0])?.name ?? null) : null;
  return (
    <div className="field">
      <label>
        Rate packages
        <Help label="About the rate packages">
          Tick every package agreed for this booking. With more than one, each room type is put on its package in The house; a room type left alone is
          priced on the first ticked. Their rates are set out in the booking file, under Charges › Package.
        </Help>
      </label>
      {readOnly || loading || items.length === 0 ? (
        <input className="input" readOnly value={loading ? "Reading their packages…" : word} />
      ) : (
        <div className="filters choice multi" role="group" aria-label="Rate packages">
          {notListed.map((id) => (
            <Button key={id} kind="secondary" compact aria-pressed onClick={() => toggle(id)}>
              a package no longer listed
            </Button>
          ))}
          {items.map((p) => {
            const on = values.includes(p.id);
            return (
              <Button key={p.id} kind={on ? "secondary" : "quiet"} compact aria-pressed={on} onClick={() => toggle(p.id)}>
                {p.name}
                {p.isDefault ? " · default" : ""}
              </Button>
            );
          })}
        </div>
      )}
      {!readOnly && !loading && items.length > 0 && values.length === 0 ? (
        <span className="hint">none ticked · pricing takes {usual ? usual.name : "their newest"}</span>
      ) : null}
      {primary ? <span className="hint">{primary} prices any room type not given its own in The house</span> : null}
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
  // The bands are an explanation — behind a "?" (2026-10-20); a child charged as an adult or
  // entered too old is a message, and stays on screen.
  const bands = loaded ? (
    <>
      Everyone under {minAdult} is a child, and the age sets the charge: under {youngMax + 1} stay and eat free · {youngMax + 1}–{childMax} at child
      rates{childMealPercent !== null ? ` (${childMealPercent}% of meals)` : ""} · {childMax + 1}–{minAdult - 1} charged as adults (own bed, full room
      share, {adultMealPercent !== null ? `${adultMealPercent}% of meals` : "full meals"}) while still minors for supervision. {minAdult} and over go under
      Adults.
    </>
  ) : null;
  if (!red && !amber) return bands ? <HelpHere label="How children are charged">{bands}</HelpHere> : null;
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
      {bands ? <Help label="How children are charged">{bands}</Help> : null}
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
