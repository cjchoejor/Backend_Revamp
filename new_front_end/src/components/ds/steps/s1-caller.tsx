"use client";

/**
 * The caller and the guest staying, on the booking's Inquiry step (2026-10-12, operator, after the
 * boss's journey mockup: "the guest section is actually the details asked for the guest staying
 * in the hotel, not the caller's detail … a travel agent will call for a guest, or a corporate or
 * the assistant of a VIP may call").
 *
 * 1 · The caller — how they came in (ticks; none is Direct voice), then whoever rang: a phone or an
 *     email (an OTA booking needs neither), "on WhatsApp?" whenever there is a phone, a title and a
 *     name that may wait. Through an agency or a company, the party found by name and its contact
 *     persons instead, with nothing more asked of the caller (2026-11-05). The rates and the kind of
 *     stay are here too.
 * 4 · Wrap up — once the rooms are chosen: the guest who is STAYING (the caller, or someone else
 *     — one form, which finds them on file by their phone or email; an agency or a company books for
 *     someone else, so it goes straight to that form), the caller's name if it was
 *     not taken at the start, who is arriving (not asked when someone else is named — they are). The booking leaves Inquiry only with the guest staying named. The guest's
 *     preference and the desk's notes live in the booking's Guest requests and Notes tabs
 *     (2026-10-12) — not repeated here.
 *
 * Every rule here is the backend's (`POST /entries/:id/caller`, `POST /entries/:id/guest`); the
 * desk mirrors it only to say before the click what the click would be refused for.
 */
import Link from "next/link";
import { Help, HelpHere } from "@/components/ds/help";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { BookingEmailField } from "@/components/ds/guest-email";
import { useSession } from "@/hooks/use-session";
import { updateEntryIntake } from "@/lib/api/entries";
import { ApiError } from "@/lib/api/client";
import { findGuestsOnFile, guestFullName, sameGuestName, type GuestOnFile, type GuestProfileSummary } from "@/lib/api/guest-profiles";
import {
  listRatePackagesLookup,
  lookupCallers,
  setEntryGuest,
  updateEntryCaller,
  updateEntrySource,
  type CoordinatorContact,
  type LookupPartyMatch,
  type SetGuestBody,
} from "@/lib/api/inquiries";
import { PhoneField } from "@/components/ds/phone-field";
import { PersonName } from "@/components/ds/person-name";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { nationalDigits, problemOfPhone } from "@/lib/ds/phone";
import { fullNameOf, splitTitle, titled } from "@/lib/ds/person";
import { callerNameOf } from "@/lib/ds/status";
import { fmtDay, plural } from "@/lib/ds/format";
import { hasAnyContact } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, StepCard, toastRefusal, useFlowUnsaved, useOpenFileTab, useRefreshEntry } from "./kit";
import { useTripAtInquiry } from "./s1-trip-shared";
import { usePublishRateChoice } from "@/components/ds/rate-sheet";
import {
  CameInTicks,
  GuestLine,
  NATIONALITIES,
  PartyContacts,
  PartySearch,
  PickList,
  PresetOrCustom,
  RatePackageField,
  ReqMark,
  USE_TYPES,
  cameInAsOf,
  channelDef,
  contactsProblem,
  defaultContactFor,
  type ChannelKey,
  type PartyKind,
} from "./new-inquiry-parts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Inq = NonNullable<EntryDetail["inquiry"]>;

/** Whether this enquiry was recorded before callers were kept — its guest was the caller then. */
function legacy(inq: Inq | null | undefined) {
  return !!inq && !(inq.callerPhone || inq.callerEmail || inq.callerFirstName || inq.callerLastName || inq.callerTitle || inq.callerOnWhatsApp != null);
}

/**
 * A travel agent or a company rings for someone else, whoever at the agency it was (2026-11-04,
 * operator: "because it's a travel agent, of course they'd book for someone else"): Wrap up asks for
 * the guest directly, and neither offers the caller as the guest nor asks for the caller's name.
 */
function bookedByParty(inq: Inq) {
  if (inq.travelAgentId || inq.corporateAccountId || inq.travelAgent || inq.corporateAccount) return true;
  return !!channelDef(cameInAsOf(inq.sourceChannel, inq.notes, null, inq.cameInAs))?.party;
}

/* ------------------------------------------------------------------ 1 · the caller */

/** The contact persons on record, first one first. From before the list: the one person kept. */
function contactsOnRecord(entry: EntryDetail): CoordinatorContact[] {
  const inq = (entry.inquiry ?? {}) as Inq;
  if (!inq.travelAgentId && !inq.corporateAccountId) return [];
  if (inq.partyContacts?.length) return inq.partyContacts;
  const e = entry as EntryDetail & { contactPersonName?: string | null; contactPersonPhone?: string | null; contactPersonEmail?: string | null };
  const kept = inq.partyContactName ? { name: inq.partyContactName, phone: inq.partyContactPhone, email: inq.partyContactEmail } : null;
  const arriving = !entry.guestProfile && e.contactPersonName ? { name: e.contactPersonName, phone: e.contactPersonPhone, email: e.contactPersonEmail } : null;
  const one = kept ?? arriving;
  if (!one) return [];
  const t = splitTitle(one.name);
  return [{ title: t.title || null, name: t.name, phone: one.phone ?? null, email: one.email ?? null }];
}

export function TheCaller({ entry, editable }: { entry: EntryDetail; editable: boolean }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const phoneRules = usePhoneRules();
  const inq = (entry.inquiry ?? {}) as Inq;
  const g = entry.guestProfile ?? null;
  const old = legacy(inq);
  const came = cameInAsOf(inq.sourceChannel, inq.notes, entry.useType, inq.cameInAs);
  const recParty = (inq.travelAgent ?? inq.corporateAccount ?? null) as LookupPartyMatch | null;
  const recPkg = inq.ratePackageId ?? null;
  const recRef = inq.corporateClientRef ?? "";

  // Booked through a party the caller on record IS the party, not someone who rang, so the caller's
  // own fields start empty: they are for a tick that leaves the party.
  const seed = () => ({
    came: (came === "DIRECT_VOICE" ? null : came) as ChannelKey | null,
    party: recParty,
    pkg: recPkg,
    ref: recRef,
    contacts: contactsOnRecord(entry),
    title: recParty ? "" : (inq.callerTitle ?? ""),
    name: recParty ? "" : fullNameOf(old ? g?.firstName : inq.callerFirstName, old ? g?.lastName : inq.callerLastName),
    phone: recParty ? "" : ((old ? g?.phone : inq.callerPhone) ?? ""),
    email: recParty ? "" : ((old ? g?.email : inq.callerEmail) ?? ""),
    onWhatsApp: recParty ? null : (inq.callerOnWhatsApp ?? null),
    // What each kind of party holds while another tick is on (2026-11-05, operator).
    stash: {} as Partial<Record<PartyKind, { party: LookupPartyMatch | null; pkg: string | null; ref: string; contacts: CoordinatorContact[] }>>,
  });
  type Draft = ReturnType<typeof seed>;
  const [d, setD] = useState<Draft>(seed);
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const canon = (x: Draft) =>
    JSON.stringify({
      came: x.came ?? "DIRECT_VOICE",
      party: x.party?.id ?? null,
      pkg: x.party ? x.pkg : null,
      ref: x.party ? x.ref.trim() : "",
      contacts: x.party ? x.contacts.map((c) => [c.title ?? "", c.name?.trim() ?? "", c.phone ?? "", c.email?.trim() ?? ""]) : [],
      caller: x.party ? null : [x.title, x.name.trim(), x.phone, x.email.trim(), x.phone ? x.onWhatsApp : null],
    });
  // Re-read only when what is on record changes (2026-10-27): keyed on the booking's version it threw
  // away an unsaved edit whenever a section below saved. An edit in progress is kept even then; only
  // an untouched form follows the record.
  const stamp = canon(seed());
  const lastSeed = useRef(stamp);
  useEffect(() => {
    setD((cur) => (canon(cur) === lastSeed.current ? seed() : cur));
    lastSeed.current = stamp;
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const def = channelDef(d.came ?? "DIRECT_VOICE")!;
  const partyKind = def.party;
  const isOta = d.came === "OTA";
  const isCorp = partyKind === "CORPORATE";
  const dirty = canon(d) !== stamp;
  useFlowUnsaved("caller", editable && dirty, "Changes to the caller saved");

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
    set({ pkg: items.find((pp) => pp.isDefault)?.id ?? null });
  }, [packages.data, owner?.travelAgentId, owner?.corporateAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The file follows a person's act, never a re-read: a tick, a party or a package picked opens
  // Charges › Package on what is chosen (2026-11-05, operator), and the page stays where it is.
  const openFile = useOpenFileTab();
  const showPackage = () => {
    if (editable) openFile("money", "package");
  };
  // A party belongs to one kind — a travel agent must never ride into a company booking. Each kind
  // keeps what was input while another tick is on, and it comes back with its tick (2026-11-05,
  // operator): a box clicked by accident loses nothing. The caller's own fields stay as typed too.
  const pickCame = (k: ChannelKey | null) => {
    const nextKind = channelDef(k ?? "DIRECT_VOICE")?.party ?? null;
    setD((x) => {
      const fromKind = channelDef(x.came ?? "DIRECT_VOICE")?.party ?? null;
      if (nextKind === fromKind) return { ...x, came: k };
      const stash = fromKind ? { ...x.stash, [fromKind]: { party: x.party, pkg: x.pkg, ref: x.ref, contacts: x.contacts } } : x.stash;
      const back = nextKind ? stash[nextKind] : null;
      return { ...x, came: k, stash, party: back?.party ?? null, pkg: back?.pkg ?? null, ref: back?.ref ?? "", contacts: back?.contacts ?? [] };
    });
    showPackage();
  };
  const setParty = (pp: LookupPartyMatch | null) => {
    if (pp && pp.id !== d.party?.id) showPackage();
    setD((x) => {
      if (pp && pp.id === x.party?.id) return { ...x, party: pp };
      const next = { ...x, party: pp, pkg: pp && pp.id === recParty?.id ? recPkg : null, contacts: pp ? (pp.id === recParty?.id ? contactsOnRecord(entry) : [defaultContactFor(pp)]) : [] };
      if (pp && partyKind === "CORPORATE" && !x.ref.trim()) next.ref = pp.contractRefs?.[0] ?? "";
      return next;
    });
  };
  // Until it is saved the file's Package tab reads what is on this card.
  usePublishRateChoice(
    entry.id,
    editable && dirty
      ? {
          travelAgentId: partyKind === "TRAVEL_AGENT" ? (d.party?.id ?? null) : null,
          corporateAccountId: partyKind === "CORPORATE" ? (d.party?.id ?? null) : null,
          ratePackageId: d.party ? d.pkg : null,
        }
      : null,
  );

  const emailBad = d.email.trim() !== "" && !EMAIL_RE.test(d.email.trim());
  const phoneBad = problemOfPhone(phoneRules, d.phone);
  const contactsBad = partyKind ? contactsProblem(d.contacts, phoneRules) : null;
  const partyReached = !!d.party && (d.contacts.some((c) => c.phone || c.email?.trim()) || (d.party.contactNumbers?.length ?? 0) > 0 || !!d.party.contactEmail);
  const reachable = partyKind ? partyReached : !!d.phone || !!d.email.trim() || isOta;
  const waAnswered = !!partyKind || !d.phone || d.onWhatsApp !== null;
  const partyWord = partyKind === "CORPORATE" ? "the company" : "the travel agent";
  const reason = partyKind
    ? !d.party
      ? partyWord
      : contactsBad
        ? contactsBad
        : !partyReached
          ? `a contact person with a phone or an email — ${d.party.displayName} has none on file`
          : isCorp && !d.contacts[0]?.name?.trim()
            ? "a contact person"
            : null
    : phoneBad
      ? `the phone: ${phoneBad}`
      : emailBad
        ? "the email does not read as one"
        : !reachable
          ? "the caller's phone or email"
          : !waAnswered
            ? "whether the number is on WhatsApp"
            : null;

  const setUse = useMutation({
    mutationFn: (useType: string) => updateEntryIntake(session!, entry.id, { useType, expectedVersion: entry.version }),
    onSuccess: () => {
      toast.success("Kind of stay recorded");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The kind of stay could not be changed"),
  });
  const save = useMutation({
    mutationFn: () =>
      updateEntrySource(session!, entry.id, {
        cameInAs: def.cameInAs,
        sourceChannel: def.channel,
        travelAgentId: partyKind === "TRAVEL_AGENT" ? (d.party?.id ?? null) : null,
        corporateAccountId: partyKind === "CORPORATE" ? (d.party?.id ?? null) : null,
        ratePackageId: d.party ? d.pkg : null,
        corporateClientRef: isCorp ? d.ref.trim() || null : null,
        // For a company the contact person IS the coordinator — named once, not twice.
        corporateCoordinator: isCorp ? d.contacts[0]?.name?.trim() || null : null,
        caller: partyKind ? null : { title: d.title || null, name: d.name.trim() || null, phone: d.phone || null, email: d.email.trim() || null, onWhatsApp: d.phone ? d.onWhatsApp : null },
        partyContacts: partyKind ? d.contacts : null,
      }),
    onSuccess: () => {
      toast.success("The caller is on record");
      refresh([["inquiry", entry.inquiryId]]);
    },
    onError: (e) => toastRefusal(e, "The caller could not be saved"),
  });

  const pkgItems = packages.data?.items ?? [];
  const pkg = pkgItems.find((x) => x.id === d.pkg) ?? null;
  const pkgWord = pkg ? pkg.name : d.pkg ? "a package no longer listed" : pkgItems.length ? "not chosen" : "The hotel's common package";
  const hasRight = !!d.party || (isCorp && !!d.ref);
  const kindWord = USE_TYPES.find(([k]) => k === entry.useType)?.[1] ?? null;
  const recContacts = contactsOnRecord(entry);
  const name = callerNameOf(old ? { callerFirstName: g?.firstName, callerLastName: g?.lastName } : inq);
  const phone = old ? g?.phone : inq.callerPhone;
  const email = old ? g?.email : inq.callerEmail;
  return (
    <StepCard
      flow="caller"
      title="The caller"
      summary={
        <>
          <b>{recParty ? recParty.displayName : (name ?? "name to come")}</b>
          {recParty ? (
            recContacts.length ? <> · {recContacts.map((c) => titled(c.title, c.name)).join(", ")}</> : null
          ) : (
            <>
              {phone ? <> · {phone}</> : null}
              {inq.callerOnWhatsApp === true ? " · on WhatsApp" : inq.callerOnWhatsApp === false ? " · not on WhatsApp" : null}
              {email ? <> · {email}</> : null}
            </>
          )}
          <> · {channelDef(came ?? "DIRECT_VOICE")?.label}</>
          {entry.inquiry?.emailThreadMessageId ? <> · replying in their email</> : null}
          {recParty ? null : <> · published rates</>}
          {kindWord ? <> · {kindWord}</> : <span className="warn-ink"> · the kind of stay is not set</span>}
        </>
      }
    >
      {old && !partyKind ? (
        <HelpHere label="About this caller">
          Recorded before callers were kept — the guest&rsquo;s own details are shown; saving records them as the caller.
        </HelpHere>
      ) : null}
      <div className="form2">
        <div className="wide">
          <CameInTicks value={d.came} disabled={!editable || save.isPending} onChange={pickCame} />
        </div>
        <div className="wide">
          <BookingEmailField entry={entry} editable={editable} suggest={inq.callerEmail ?? d.party?.displayName ?? undefined} />
        </div>
        {partyKind ? (
          <div className={`wide caller-party${hasRight ? "" : " solo"}`}>
            <div className="caller-party-who">
              {editable ? (
                <PartySearch kind={partyKind} party={d.party} setParty={setParty} />
              ) : (
                <div className="field">
                  <label>{partyKind === "CORPORATE" ? "Company" : "Travel agent"}</label>
                  <input className="input" readOnly value={d.party?.displayName ?? ""} placeholder="none on file" />
                </div>
              )}
              {d.party ? (
                <PartyContacts kind={partyKind} party={d.party} setParty={(pp) => setParty(pp)} contacts={d.contacts} setContacts={(contacts) => set({ contacts })} readOnly={!editable} />
              ) : (
                <span className="hint warn-ink">search {partyWord} by name</span>
              )}
            </div>
            {hasRight ? (
              <div className="caller-party-rate">
                {d.party ? (
                  <RatePackageField
                    packages={packages.data?.items ?? null}
                    loading={packages.isLoading}
                    value={d.pkg}
                    readOnly={!editable}
                    word={pkgWord}
                    onChange={(id) => {
                      set({ pkg: id });
                      showPackage();
                    }}
                  />
                ) : null}
                {isCorp ? (
                  <div className="field">
                    <label>Their PO or authorisation</label>
                    <input className="input" readOnly={!editable} value={d.ref} maxLength={200} placeholder="none given" onChange={(e) => set({ ref: e.target.value })} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="field">
              <label>
                Phone
                {/* Either one will do, so the empty one stops asking once the other is in. */}
                {!isOta && editable && (d.phone || !d.email.trim()) ? <ReqMark /> : null}
                {reachable ? <Help label="About the phone">{isOta && !d.phone ? "An OTA booking — the phone is optional." : "Where the caller can be rung back."}</Help> : null}
              </label>
              <PhoneField value={d.phone} readOnly={!editable} onChange={(v) => set({ phone: v })} />
              {!reachable ? <span className="hint stop-ink">a phone or an email is needed</span> : null}
            </div>
            <div className="field">
              <label>
                Email
                {!isOta && editable && (d.email.trim() || !d.phone) ? <ReqMark /> : null}
                <Help label="About the email">Optional when there is a phone.</Help>
              </label>
              <input className={`input${emailBad ? " invalid" : ""}`} type="email" value={d.email} readOnly={!editable} placeholder="name@example.com" onChange={(e) => set({ email: e.target.value })} />
              {emailBad ? <span className="hint stop-ink">that does not read as an email address</span> : null}
            </div>
            {d.phone ? (
              <div className="wide field">
                <label>On WhatsApp?</label>
                <Choice
                  options={[
                    ["YES", "Yes"],
                    ["NO", "No"],
                  ]}
                  value={d.onWhatsApp === null ? null : d.onWhatsApp ? "YES" : "NO"}
                  disabled={!editable}
                  onChange={(v) => set({ onWhatsApp: v === "YES" })}
                />
                {d.onWhatsApp === null ? <span className="hint warn-ink">ask — the quote and the confirmation can go there</span> : null}
              </div>
            ) : null}
            <div className="wide">
              <PersonName title={d.title} name={d.name} readOnly={!editable} onTitle={(title) => set({ title })} onName={(v) => set({ name: v })} namePlaceholder={editable ? "can wait for Wrap up" : undefined} />
            </div>
          </>
        )}
        <div className="wide field">
          <label>
            What kind of stay
            {editable ? <Help label="About the kind of stay">Saved as soon as it is picked.</Help> : null}
          </label>
          <Choice
            options={USE_TYPES}
            value={entry.useType as (typeof USE_TYPES)[number][0] | null}
            disabled={!editable || setUse.isPending}
            onChange={(v) => v !== entry.useType && setUse.mutate(v)}
          />
        </div>
      </div>
      {editable && dirty ? (
        <div className="row-acts" style={{ marginTop: 10, alignItems: "center" }}>
          <span className="warn-ink sm">
            <b>Changed — save it, or the booking keeps what was recorded</b>
          </span>
          <span style={{ flex: 1 }} />
          {reason ? <span className="meta warn-ink">first: {reason}</span> : null}
          <Button kind="quiet" compact onClick={() => setD(seed())}>
            Put it back
          </Button>
          <Button className="go" state={save.isPending ? "working" : reason ? "inert" : "default"} title={reason ?? undefined} workingLabel="Saving…" onClick={() => save.mutate()}>
            Save the caller
          </Button>
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ wrap up */

/**
 * The guest staying is the caller, or someone else (2026-10-28, operator: "someone on file and
 * someone else new can be made into one … when writing the email and phone number it can show a
 * drop down if it's already on file"). One form for someone else: typing their phone or email lists
 * the guests already on file with it, and picking one names them. A name that differs from the one
 * on file for the same phone or email is asked about — keep the name typed (a new guest) or use the
 * guest on file — whether it is found here or by the backend when the guest is saved
 * (GUEST_ON_FILE_DIFFERENT_NAME). The same name, case aside, is the guest on file without asking.
 * Someone else is the one arriving, so "who is arriving" is not asked for them.
 */
type GuestChoice = "CALLER" | "OTHER";

type NameAsk = {
  /** Which form was being saved: the caller made a guest, or someone else typed. */
  mode: GuestChoice;
  typed: { title: string | null; firstName: string; lastName: string };
  matches: GuestOnFile[];
  /** Asked when the guest was being saved (save again on the answer), or when a row was picked. */
  onSave: boolean;
};

const matchWords = (m: GuestOnFile) =>
  m.matchedBy.length === 2 ? "phone and email" : m.matchedBy[0] === "PHONE" ? "phone" : "email";
/** The dialog's one fact line: which contact is on file, and for whom (or for how many). */
const askLine = (matches: GuestOnFile[]) => {
  const by = new Set(matches.flatMap((m) => m.matchedBy));
  const what = by.size === 2 ? "phone and email" : by.has("PHONE") ? "phone" : "email";
  const verb = by.size === 2 ? "are" : "is";
  return matches.length === 1
    ? `The ${matchWords(matches[0])} ${matches[0].matchedBy.length === 2 ? "are" : "is"} on file for ${titledName(matches[0])}`
    : `This ${what} ${verb} on file for ${matches.length} guests`;
};
const titledName = (g: { title?: string | null; firstName: string; lastName: string }) =>
  [g.title, g.firstName, g.lastName].filter((x) => x && String(x).trim()).join(" ");
const asSummary = (g: GuestOnFile): GuestProfileSummary => ({
  ...g,
  vipTier: null,
  clientTier: null,
  isActive: true,
  createdAt: "",
  updatedAt: "",
});

export function WrapUp({ entry, editable, onSaved }: { entry: EntryDetail; editable: boolean; onSaved: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  // A trip at Inquiry: the guest named here is named on every stay (2026-11-07, ruling "the same guest for both").
  const trip = useTripAtInquiry(entry);
  const phoneRules = usePhoneRules();
  const inq = (entry.inquiry ?? {}) as Inq;
  const named = entry.guestProfile ?? null;
  const contact = entry as EntryDetail & { contactPersonName?: string | null; contactPersonPhone?: string | null };
  const partyName = inq.travelAgent?.displayName ?? inq.corporateAccount?.displayName ?? null;
  const byParty = bookedByParty(inq);
  // One name is a name (2026-11-05, operator: "sometimes people just have one name").
  const callerHasName = byParty || !!inq.callerFirstName?.trim();

  // The guest staying: the caller by default; once named, shown as named until "Change".
  const [changing, setChanging] = useState(false);
  const choosing = editable && (!named || changing);
  const [picked, setChoice] = useState<GuestChoice>("CALLER");
  const choice: GuestChoice = byParty ? "OTHER" : picked;
  const [nationality, setNationality] = useState(NATIONALITIES[0]);
  // The caller's name, when it was not taken at the start.
  const [cTitle, setCTitle] = useState("");
  const [cName, setCName] = useState("");
  // Someone else: typed, or a guest on file picked (`linked`), or kept as new despite one on file.
  const [nTitle, setNTitle] = useState("");
  const [nName, setNName] = useState("");
  const [nPhone, setNPhone] = useState("");
  const [nEmail, setNEmail] = useState("");
  const [linked, setLinked] = useState<GuestOnFile | null>(null);
  const [keepNew, setKeepNew] = useState(false);
  const [nameAsk, setNameAsk] = useState<NameAsk | null>(null);

  // The guests on file with the phone or email typed so far, read while the desk types.
  const typedDigits = nationalDigits(phoneRules, nPhone);
  const typedEmail = nEmail.trim();
  const [onFileQ, setOnFileQ] = useState({ phone: "", email: "" });
  useEffect(() => {
    const t = setTimeout(
      () => setOnFileQ({ phone: typedDigits.length >= 4 ? typedDigits : "", email: typedEmail.length >= 3 ? typedEmail : "" }),
      300,
    );
    return () => clearTimeout(t);
  }, [typedDigits, typedEmail]);
  const onFile = useQuery({
    queryKey: ["guests-on-file", onFileQ.phone, onFileQ.email],
    queryFn: () => findGuestsOnFile(session!, onFileQ),
    enabled: !!session && choosing && choice === "OTHER" && !linked && !!(onFileQ.phone || onFileQ.email),
    staleTime: 0,
  });
  const onFileRows = (onFile.data?.guests ?? []).filter((g) => g.id !== named?.id);

  // The guests this caller brought before (2026-10-27): one click names one of them, rather than
  // making a second record of a guest already on file. Read from the caller list, this enquiry
  // left out; the caller's own row is the one with the same number (or email).
  const callerDigits = (inq.callerPhone ?? "").replace(/\D/g, "");
  const callerQ = callerDigits.length >= 4 ? callerDigits.slice(-8) : inq.callerEmail?.includes("@") ? inq.callerEmail.trim() : "";
  const history = useQuery({
    queryKey: ["desk-callers", callerQ, inq.id],
    queryFn: () => lookupCallers(session!, callerQ, inq.id),
    enabled: !!session && choosing && !!callerQ,
  });
  const ownRow = (history.data?.matches ?? []).find((m) =>
    callerDigits.length >= 4
      ? (m.phone ?? "").replace(/\D/g, "").slice(-8) === callerDigits.slice(-8)
      : (m.email ?? "").toLowerCase() === (inq.callerEmail ?? "").trim().toLowerCase(),
  );
  const broughtBefore: GuestProfileSummary[] = (ownRow?.guests ?? [])
    .filter((g) => g.id !== named?.id)
    .map((g) => ({ ...g, vipTier: null, clientTier: null, isActive: true, createdAt: "", updatedAt: "" }));
  const lastStayOf = new Map((ownRow?.guests ?? []).map((g) => [g.id, g.lastStay]));

  // Who is arriving follows the caller when the caller is the guest (2026-11-03, operator: "first i
  // added someone else, and then switched to the caller, the who is arriving still shows the someone
  // else's info"). It follows when nobody stands there yet or the guest named until now does; someone
  // the desk typed by hand stays.
  const sameWords = (a?: string | null, b?: string | null) => (a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === (b ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const onRecordName = contact.contactPersonName ?? "";
  const onRecordPhone = contact.contactPersonPhone ?? "";
  const arrivingWasTheGuest =
    !onRecordName.trim() ||
    (!!named && (sameWords(onRecordName, guestFullName({ title: named.title, firstName: named.firstName ?? "", lastName: named.lastName ?? "" })) || sameWords(onRecordName, `${named.firstName ?? ""} ${named.lastName ?? ""}`)));
  const callerNameNow = callerNameOf(inq) ?? titled(cTitle, cName);
  const arrivingFollowsCaller = choosing && choice === "CALLER" && arrivingWasTheGuest;
  const seedName = arrivingFollowsCaller ? callerNameNow || onRecordName : onRecordName;
  const seedPhone = arrivingFollowsCaller ? (inq.callerPhone ?? "") : onRecordPhone;
  const [arrTitle, setArrTitle] = useState(() => splitTitle(seedName).title);
  const [arrName, setArrName] = useState(() => splitTitle(seedName).name);
  const [arrPhone, setArrPhone] = useState(seedPhone);
  useEffect(() => {
    const t = splitTitle(seedName);
    setArrTitle(t.title);
    setArrName(t.name);
    setArrPhone(seedPhone);
  }, [seedName, seedPhone]);

  /** Name a guest on file: their record fills the form. */
  const linkGuest = (g: GuestOnFile) => {
    setLinked(g);
    setKeepNew(false);
    setNTitle(g.title ?? "");
    setNName(fullNameOf(g.firstName, g.lastName));
    if (g.phone) setNPhone(g.phone);
    if (g.email) setNEmail(g.email);
    if (g.nationality) setNationality(g.nationality);
  };
  /** A row picked from the dropdown: a different name already typed is asked about first. */
  const pickOnFile = (g: GuestOnFile) => {
    const typed = { firstName: nName.trim(), lastName: "" };
    if (typed.firstName && !sameGuestName(typed, g)) {
      setNameAsk({ mode: "OTHER", typed: { title: nTitle || null, ...typed }, matches: [g], onSave: false });
      return;
    }
    linkGuest(g);
  };
  const unlink = () => {
    setLinked(null);
    setKeepNew(false);
  };
  // A contact changed after "keep the new name" is a new question.
  useEffect(() => setKeepNew(false), [typedDigits, typedEmail]);

  const callerNameTyped = !!cName.trim();
  const callerNameDirty = !callerHasName && !!(cName.trim() || cTitle);
  const nEmailBad = nEmail.trim() !== "" && !EMAIL_RE.test(nEmail.trim());
  const nPhoneBad = problemOfPhone(phoneRules, nPhone);
  const guestReason = !choosing
    ? null
    : choice === "CALLER"
      ? callerHasName || callerNameTyped
        ? null
        : "the caller's name — the guest record is made from it"
      : !nName.trim()
        ? "the guest's name"
        : nPhoneBad
          ? `the guest's phone: ${nPhoneBad}`
          : nEmailBad
            ? "an email that reads as one"
            : null;
  // Someone else is the one arriving — the backend fills "who is arriving" from them.
  const askArriving = !(choosing && choice === "OTHER");
  const arrivingDirty = askArriving && (titled(arrTitle, arrName) !== seedName.trim() || arrPhone.trim() !== seedPhone.trim());
  const arrivingBad = askArriving ? problemOfPhone(phoneRules, arrPhone) : null;
  const saveReason = guestReason ?? (arrivingBad ? `who is arriving: ${arrivingBad}` : null);
  const dirty = choosing || callerNameDirty || arrivingDirty;
  useFlowUnsaved("wrap", editable && dirty, "Changes to wrap up saved");

  const guestBody = (over?: { useOnFile?: string; keepNewName?: boolean }): SetGuestBody => {
    const phone = nPhone || null;
    const email = nEmail.trim() || null;
    if (choice === "CALLER") {
      return over?.useOnFile
        ? { mode: "EXISTING", guestProfileId: over.useOnFile, arrivingIsGuest: arrivingFollowsCaller }
        : { mode: "CALLER", nationality, keepNewName: over?.keepNewName, arrivingIsGuest: arrivingFollowsCaller };
    }
    const typed = { firstName: nName.trim(), lastName: "" };
    const onFileId = over?.useOnFile ?? (linked && sameGuestName(typed, linked) ? linked.id : null);
    if (onFileId) return { mode: "EXISTING", guestProfileId: onFileId, phone, email, arrivingIsGuest: true };
    return {
      mode: "NEW",
      title: nTitle || null,
      name: nName.trim(),
      nationality,
      phone,
      email,
      keepNewName: over?.keepNewName ?? keepNew,
      arrivingIsGuest: true,
    };
  };

  const save = useMutation({
    mutationFn: async (over?: { useOnFile?: string; keepNewName?: boolean }) => {
      const done: string[] = [];
      const notes: string[] = [];
      if (callerNameDirty) {
        await updateEntryCaller(session!, entry.id, { title: cTitle || null, name: cName.trim() || null });
        done.push("the caller's name");
      }
      if (choosing) {
        const r = await setEntryGuest(session!, entry.id, { ...guestBody(over), ...(trip.combined ? { alsoTripStays: true } : {}) });
        done.push(trip.combined ? "the guest staying, on every stay" : "the guest staying");
        for (const t of r.tripStays ?? []) {
          if (t.message) notes.push(`stay ${trip.stayNoOf(t.entryId)}: ${t.message}`);
        }
        if (r.reusedOnFile) notes.push("the guest was already on file — their record is used");
        if (r.contactKept?.length) {
          notes.push(`the ${r.contactKept.join(" and ")} on file is kept — a different one was typed`);
        }
        if (r.duplicate) toast.warning(`This guest already holds a stay over these nights — ${r.duplicate.conflictingEntryId}. It is flagged for the FOM.`);
      }
      if (arrivingDirty) {
        // The version moved if the guest was just named; read it fresh rather than refuse on a stale one.
        await updateEntryIntake(session!, entry.id, { contactPersonName: titled(arrTitle, arrName), contactPersonPhone: arrPhone.trim() });
        // The same person arrives for every stay of a trip at Inquiry.
        for (const id of trip.otherIds) {
          await updateEntryIntake(session!, id, { contactPersonName: titled(arrTitle, arrName), contactPersonPhone: arrPhone.trim() });
        }
        done.push("who is arriving");
      }
      return { done, notes };
    },
    onSuccess: ({ done, notes }) => {
      toast.success(done.length ? `On record: ${done.join(", ")}` : "Nothing to save", notes.length ? { description: notes.join(" · ") } : undefined);
      setChanging(false);
      setCTitle("");
      setCName("");
      // The form starts empty next time: the next person named must not take this one's number.
      setNTitle("");
      setNName("");
      setNPhone("");
      setNEmail("");
      setLinked(null);
      setKeepNew(false);
      refresh([["inquiry", entry.inquiryId], ...trip.otherIds.map((id) => ["entry", id])]);
      onSaved();
    },
    onError: (e) => {
      const body = e instanceof ApiError ? e.body : undefined;
      if (body?.blockingCondition === "GUEST_ON_FILE_DIFFERENT_NAME") {
        const det = (body.details ?? {}) as { typed?: NameAsk["typed"]; matches?: GuestOnFile[] };
        if (det.matches?.length && det.typed) {
          setNameAsk({ mode: choice, typed: det.typed, matches: det.matches, onSave: true });
          if (callerNameDirty) refresh([["inquiry", entry.inquiryId]]);
          return;
        }
      }
      toastRefusal(e, "Wrap up could not be saved");
      refresh([["inquiry", entry.inquiryId]]);
      onSaved();
    },
  });

  /** The answer to "already on file under another name". */
  const answerNameAsk = (use: GuestOnFile | null) => {
    const ask = nameAsk;
    if (!ask) return;
    setNameAsk(null);
    if (!ask.onSave) {
      // A row picked over a different typed name.
      if (use) linkGuest(use);
      else {
        setLinked(null);
        setKeepNew(true);
      }
      return;
    }
    if (use) {
      if (ask.mode === "OTHER") linkGuest(use);
      save.mutate({ useOnFile: use.id });
    } else {
      if (ask.mode === "OTHER") setKeepNew(true);
      save.mutate({ keepNewName: true });
    }
  };

  // A guest with no number stands on someone else's until the desk has theirs: said, so it is not
  // taken for the guest's own.
  const digitsOf = (v?: string | null) => (v ?? "").replace(/\D/g, "");
  const arrivingPhoneIsOthers =
    named && !choosing && !named.phone && digitsOf(arrPhone)
      ? digitsOf(arrPhone) === digitsOf(inq.partyContactPhone)
        ? `This is ${partyName ?? "the agency"}'s number — put in the guest's own if you have it.`
        : digitsOf(arrPhone) === digitsOf(inq.callerPhone)
          ? "This is the caller's number — put in the guest's own if you have it."
          : null
      : null;
  const reachable = hasAnyContact(entry);
  const callerWord = callerNameOf(inq) ?? (callerNameTyped ? titled(cTitle, cName) : null);
  const typedNameNow = titledName({ title: nameAsk?.typed.title ?? null, firstName: nameAsk?.typed.firstName ?? "", lastName: nameAsk?.typed.lastName ?? "" });
  return (
    <StepCard
      flow="wrap"
      flowAfter="house"
      flowAfterOnly
      title="Wrap up"
      meta="The rooms are chosen — now who is staying, and what was not taken at the start."
      status={trip.combined ? `The guest named here is named on every stay of the trip (${plural(trip.otherIds.length + 1, "stay")})` : undefined}
    >
      {/* the caller's name, when it was not taken at the start */}
      {!callerHasName && editable ? (
        <div className="form2" style={{ marginBottom: 12 }}>
          <div className="wide">
            <PersonName title={cTitle} name={cName} onTitle={setCTitle} onName={setCName} nameLabel="The caller's name" />
          </div>
          <span className="wide hint warn-ink">not taken at the start — ask the caller&rsquo;s name now</span>
        </div>
      ) : null}

      {/* the guest staying */}
      <div className="field" style={{ marginBottom: 12 }}>
        <label>The guest staying</label>
        {!choosing ? (
          named ? (
            <div className="row-acts">
              <span className="sm">
                <b>{guestFullName({ title: named.title, firstName: named.firstName ?? "", lastName: named.lastName ?? "" })}</b>
                {named.nationality ? <> · {named.nationality}</> : null}
                {named.id ? (
                  <>
                    {" "}
                    · <Link href={`/guests/${named.id}`}>the guest&rsquo;s record</Link>
                  </>
                ) : null}
              </span>
              {editable ? (
                <Button kind="quiet" compact onClick={() => setChanging(true)}>
                  Change
                </Button>
              ) : null}
            </div>
          ) : (
            <span className="meta">not named yet</span>
          )
        ) : (
          <>
            {broughtBefore.length > 0 ? (
              <div style={{ marginBottom: 10 }}>
                <PickList
                  head={`${callerWord ?? "This caller"} brought before`}
                  action="Name them"
                  rows={broughtBefore.map((g) => {
                    const last = lastStayOf.get(g.id);
                    return {
                      key: g.id,
                      main: <GuestLine guest={g} />,
                      sub: last ? `stayed ${fmtDay(last)}` : undefined,
                      onPick: () => {
                        setChoice("OTHER");
                        linkGuest({
                          id: g.id,
                          title: g.title ?? null,
                          firstName: g.firstName,
                          lastName: g.lastName,
                          phone: g.phone,
                          email: g.email,
                          nationality: g.nationality,
                          matchedBy: [],
                        });
                      },
                    };
                  })}
                />
              </div>
            ) : null}
            {byParty ? null : (
              <Choice
                options={[
                  ["CALLER", callerWord ? `The caller — ${callerWord}` : "The caller"],
                  ["OTHER", "Someone else"],
                ]}
                value={choice}
                onChange={(v) => setChoice(v)}
              />
            )}
            {choice === "CALLER" ? (
              <div className="form2" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>
                    Nationality
                    <Help label="About the guest record">The guest record is made from the caller&rsquo;s name, phone and email.</Help>
                  </label>
                  <PresetOrCustom presets={NATIONALITIES} value={nationality} onChange={setNationality} placeholder="type the nationality" otherLabel="Other…" ariaLabel="Nationality" />
                </div>
              </div>
            ) : (
              <div className="form2" style={{ marginTop: 10 }}>
                <div className="wide">
                  <PersonName title={nTitle} name={nName} onTitle={setNTitle} onName={setNName} ariaLabel="Guest's name" required={!nName.trim()} />
                </div>
                <div className="field">
                  <label>
                    Their phone · optional
                    <Help label="About the phone and email">Typing a phone or an email lists the guests already on file with it — pick one to name them.</Help>
                  </label>
                  <PhoneField value={nPhone} onChange={setNPhone} ariaLabel="Guest's phone" />
                </div>
                <div className="field">
                  <label>Their email · optional</label>
                  <input className={`input${nEmailBad ? " invalid" : ""}`} aria-label="Guest's email" type="email" value={nEmail} onChange={(e) => setNEmail(e.target.value)} />
                  {nEmailBad ? <span className="hint stop-ink">that does not read as an email address</span> : null}
                </div>
                {linked ? (
                  <div className="wide row-acts onfile-linked">
                    <span className="sm ok-ink" style={{ fontWeight: 700 }}>
                      On file: {titledName(linked)}
                      {linked.phone ? <span className="money"> · {linked.phone}</span> : null}
                      {linked.email ? <span> · {linked.email}</span> : null}
                    </span>
                    <Button kind="quiet" compact onClick={unlink}>
                      Not this guest
                    </Button>
                  </div>
                ) : onFileRows.length > 0 ? (
                  <div className="wide onfile-list">
                    <PickList
                      head="Already on file with this phone or email"
                      action="Name them"
                      rows={onFileRows.map((g) => ({
                        key: g.id,
                        main: <GuestLine guest={asSummary(g)} />,
                        sub: `same ${matchWords(g)}`,
                        onPick: () => pickOnFile(g),
                      }))}
                    />
                  </div>
                ) : keepNew ? (
                  <span className="wide meta">a new guest, though this phone or email is on file under another name</span>
                ) : null}
                <div className="field">
                  <label>Nationality</label>
                  <PresetOrCustom presets={NATIONALITIES} value={nationality} onChange={setNationality} placeholder="type the nationality" otherLabel="Other…" ariaLabel="Guest nationality" />
                </div>
              </div>
            )}
            {changing ? (
              <Button kind="quiet" compact onClick={() => setChanging(false)}>
                Keep {guestFullName({ title: named?.title, firstName: named?.firstName ?? "", lastName: named?.lastName ?? "" })}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {askArriving ? (
        <div className="form2">
          <div className="field">
            <PersonName title={arrTitle} name={arrName} readOnly={!editable} onTitle={setArrTitle} onName={setArrName} nameLabel="Who is arriving" namePlaceholder="who leads the party on the day" />
          </div>
          <div className="field">
            <label>
              Their phone
              <Help label="About their phone">Needed before arrival.</Help>
            </label>
            <PhoneField value={arrPhone} readOnly={!editable} onChange={setArrPhone} ariaLabel="Who is arriving's phone" />
            {arrivingPhoneIsOthers ? <span className="hint warn-ink">{arrivingPhoneIsOthers}</span> : null}
          </div>
          {inq.partyContactName ? (
            <span className="wide meta">
              {partyName ?? "Their"}&rsquo;s contact person: <b>{inq.partyContactName}</b>
              {inq.partyContactPhone ? <> · {inq.partyContactPhone}</> : null}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={`sm ${named ? "ok-ink" : "stop-ink"}`} style={{ marginTop: 8, fontWeight: 700 }}>
        {named ? "The guest staying is named." : "Name the guest staying — the booking cannot move to Negotiation without one."}
      </div>
      {!reachable ? (
        <div className="sm stop-ink" style={{ fontWeight: 700 }}>
          Nobody can be reached yet — the caller&rsquo;s or the guest&rsquo;s phone or email, or the arriving person&rsquo;s phone.
        </div>
      ) : null}
      {editable && dirty ? (
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button
            className="go"
            state={save.isPending ? "working" : saveReason ? "inert" : "default"}
            title={saveReason ?? undefined}
            workingLabel="Saving…"
            onClick={() => save.mutate(undefined)}
          >
            Save wrap up
          </Button>
          {saveReason ? <span className="meta warn-ink">first: {saveReason}</span> : null}
        </div>
      ) : null}

      {nameAsk ? (
        <DsDialog
          open
          onClose={() => setNameAsk(null)}
          busy={save.isPending}
          title="Already on file under another name"
          width={nameAsk.matches.length > 1 ? 640 : undefined}
          caseLines={[askLine(nameAsk.matches)]}
          help="One person has one guest record, shared by every booking they make. Use the guest on file when it is the same person; keep the typed name when it is someone else who shares the phone or email."
          footer={
            <>
              <Button kind="quiet" onClick={() => setNameAsk(null)}>
                Not now
              </Button>
              <Button kind="secondary" onClick={() => answerNameAsk(null)}>
                Keep {typedNameNow} — a new guest
              </Button>
              {/* One guest on file: its own button. Several (an old number shared by many records): picked from the list above. */}
              {nameAsk.matches.length === 1 ? (
                <Button className="go" onClick={() => answerNameAsk(nameAsk.matches[0])}>
                  Use {titledName(nameAsk.matches[0])} — on file
                </Button>
              ) : null}
            </>
          }
        >
          <p className="sm" style={{ margin: 0 }}>
            You typed <b>{typedNameNow}</b>.{" "}
            {nameAsk.matches.length === 1 ? "Is this the guest on file, or someone else?" : "Is it one of these guests, or someone else?"}
          </p>
          {nameAsk.matches.length > 1 ? (
            <div className="onfile-ask" style={{ marginTop: 10 }}>
              <PickList
                action="Use them"
                rows={nameAsk.matches.map((m) => ({
                  key: m.id,
                  main: <GuestLine guest={asSummary(m)} />,
                  sub: `same ${matchWords(m)}`,
                  onPick: () => answerNameAsk(m),
                }))}
              />
            </div>
          ) : null}
        </DsDialog>
      ) : null}
    </StepCard>
  );
}
