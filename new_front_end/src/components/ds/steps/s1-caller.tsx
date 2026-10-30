"use client";

/**
 * The caller and the guest staying, on the booking's Inquiry step (2026-10-12, operator, after the
 * boss's journey mockup: "the guest section is actually the details asked for the guest staying
 * in the hotel, not the caller's detail … a travel agent will call for a guest, or a corporate or
 * the assistant of a VIP may call").
 *
 * 1 · The caller — whoever rang: a phone or an email (an OTA booking needs neither), "on WhatsApp?"
 *     whenever there is a phone, and a title and name that may wait.
 * 5 · Wrap up — once the rooms are chosen: the guest who is STAYING (the caller, or someone else
 *     — one form, which finds them on file by their phone or email), the caller's name if it was
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
import { useSession } from "@/hooks/use-session";
import { updateEntryIntake } from "@/lib/api/entries";
import { ApiError } from "@/lib/api/client";
import { findGuestsOnFile, guestFullName, sameGuestName, type GuestOnFile, type GuestProfileSummary } from "@/lib/api/guest-profiles";
import { lookupCallers, setEntryGuest, updateEntryCaller, type SetGuestBody } from "@/lib/api/inquiries";
import { callerNameOf } from "@/lib/ds/status";
import { fmtDay } from "@/lib/ds/format";
import { hasAnyContact } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, StepCard, toastRefusal, useFlowUnsaved, useRefreshEntry } from "./kit";
import { GuestLine, NATIONALITIES, PHONE_CODES, PhoneInput, PickList, PresetOrCustom, ReqMark, callerIsTheParty, joinPhone, splitStoredPhone } from "./new-inquiry-parts";

export const CALLER_TITLES = ["", "Mr", "Ms", "Mrs", "Dr", "Dasho", "Lyonpo", "Aum"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Inq = NonNullable<EntryDetail["inquiry"]>;

/** Whether this enquiry was recorded before callers were kept — its guest was the caller then. */
function legacy(inq: Inq | null | undefined) {
  return !!inq && !(inq.callerPhone || inq.callerEmail || inq.callerFirstName || inq.callerLastName || inq.callerTitle || inq.callerOnWhatsApp != null);
}

/* ------------------------------------------------------------------ 1 · the caller */

export function TheCaller({ entry, editable }: { entry: EntryDetail; editable: boolean }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const inq = (entry.inquiry ?? {}) as Inq;
  const g = entry.guestProfile ?? null;
  const old = legacy(inq);
  const isOta = inq.sourceChannel === "OTA";

  const seed = () => {
    const phone = (old ? g?.phone : inq.callerPhone) ?? "";
    const split = phone ? splitStoredPhone(phone) : { code: PHONE_CODES[0], number: "" };
    return {
      title: inq.callerTitle ?? "",
      firstName: (old ? g?.firstName : inq.callerFirstName) ?? "",
      lastName: (old ? g?.lastName : inq.callerLastName) ?? "",
      code: split.code,
      number: split.number,
      email: (old ? g?.email : inq.callerEmail) ?? "",
      onWhatsApp: inq.callerOnWhatsApp ?? null,
    };
  };
  const [f, setF] = useState(seed);
  // Re-read only when the CALLER on record changes (2026-10-27): keyed on the booking's version, it
  // threw away an unsaved edit here — the dialling code with it — whenever a section below saved.
  // An edit in progress is kept even then; only an untouched form follows the record.
  const stamp = `${inq.callerPhone}|${inq.callerEmail}|${inq.callerFirstName}|${inq.callerLastName}|${inq.callerTitle}|${inq.callerOnWhatsApp}|${old}`;
  const lastSeed = useRef(JSON.stringify(f));
  useEffect(() => {
    const next = seed();
    setF((cur) => (JSON.stringify(cur) === lastSeed.current ? next : cur));
    lastSeed.current = JSON.stringify(next);
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<ReturnType<typeof seed>>) => setF((p) => ({ ...p, ...patch }));

  const saved = seed();
  const fullPhone = joinPhone(f.code, f.number);
  const emailBad = f.email.trim() !== "" && !EMAIL_RE.test(f.email.trim());
  const reachable = !!fullPhone || !!f.email.trim() || isOta;
  const waAnswered = !fullPhone || f.onWhatsApp !== null;
  const dirty = JSON.stringify(f) !== JSON.stringify(saved);
  useFlowUnsaved("caller", editable && dirty, "Changes to the caller saved");
  const reason = emailBad
    ? "the email does not read as one"
    : !reachable
      ? "the caller's phone or email"
      : !waAnswered
        ? "whether the number is on WhatsApp"
        : null;

  const save = useMutation({
    mutationFn: () =>
      updateEntryCaller(session!, entry.id, {
        title: f.title || null,
        firstName: f.firstName.trim() || null,
        lastName: f.lastName.trim() || null,
        phone: fullPhone || null,
        email: f.email.trim() || null,
        onWhatsApp: fullPhone ? f.onWhatsApp : null,
      }),
    onSuccess: () => {
      toast.success("The caller is on record");
      refresh([["inquiry", entry.inquiryId]]);
    },
    onError: (e) => toastRefusal(e, "The caller could not be saved"),
  });

  const name = callerNameOf(old ? { callerFirstName: g?.firstName, callerLastName: g?.lastName } : inq);
  const phone = old ? g?.phone : inq.callerPhone;
  const email = old ? g?.email : inq.callerEmail;
  return (
    <StepCard
      flow="caller"
      title="The caller"
      summary={
        <>
          <b>{name ?? "name to come"}</b>
          {phone ? <> · {phone}</> : null}
          {inq.callerOnWhatsApp === true ? " · on WhatsApp" : inq.callerOnWhatsApp === false ? " · not on WhatsApp" : null}
          {email ? <> · {email}</> : null}
          {!phone && !email && isOta ? <> · OTA booking</> : null}
          {name ? null : <span className="meta"> · no name yet</span>}
        </>
      }
    >
      {old ? (
        <HelpHere label="About this caller">
          Recorded before callers were kept — the guest&rsquo;s own details are shown; saving records them as the caller.
        </HelpHere>
      ) : null}
      <div className="form2">
        <div className="field">
          <label>
            Phone
            {!isOta && editable ? <ReqMark /> : null}
            {reachable ? (
              <Help label="About the phone">{isOta && !fullPhone ? "An OTA booking — the phone is optional." : "Where the caller can be rung back."}</Help>
            ) : null}
          </label>
          {editable ? (
            <PhoneInput code={f.code} setCode={(v) => set({ code: v })} number={f.number} setNumber={(v) => set({ number: v })} />
          ) : (
            <input className="input" readOnly value={phone ?? ""} placeholder="none given" />
          )}
          {!reachable ? <span className="hint stop-ink">a phone or an email is needed</span> : null}
        </div>
        <div className="field">
          <label>
            Email
            {!isOta && editable ? <ReqMark /> : null}
            <Help label="About the email">Optional when there is a phone.</Help>
          </label>
          <input
            className={`input${emailBad ? " invalid" : ""}`}
            type="email"
            value={f.email}
            readOnly={!editable}
            placeholder="name@example.com"
            onChange={(e) => set({ email: e.target.value })}
          />
          {emailBad ? <span className="hint stop-ink">that does not read as an email address</span> : null}
        </div>
        {fullPhone ? (
          <div className="wide field">
            <label>On WhatsApp?</label>
            <Choice
              options={[
                ["YES", "Yes"],
                ["NO", "No"],
              ]}
              value={f.onWhatsApp === null ? null : f.onWhatsApp ? "YES" : "NO"}
              disabled={!editable}
              onChange={(v) => set({ onWhatsApp: v === "YES" })}
            />
            {f.onWhatsApp === null ? <span className="hint warn-ink">ask — the quote and the confirmation can go there</span> : null}
          </div>
        ) : null}
        <div className="wide" style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3) var(--s4)" }}>
          <div className="field">
            <label>Title</label>
            <select className="input" value={f.title} disabled={!editable} onChange={(e) => set({ title: e.target.value })}>
              {CALLER_TITLES.map((t) => (
                <option key={t} value={t}>
                  {t || "—"}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>First name</label>
            <input className="input" value={f.firstName} readOnly={!editable} placeholder="can wait for Wrap up" onChange={(e) => set({ firstName: e.target.value })} />
          </div>
          <div className="field">
            <label>Last name</label>
            <input className="input" value={f.lastName} readOnly={!editable} placeholder="can wait for Wrap up" onChange={(e) => set({ lastName: e.target.value })} />
          </div>
        </div>
      </div>
      {editable && dirty ? (
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button className="go" compact state={save.isPending ? "working" : reason ? "inert" : "default"} title={reason ?? undefined} workingLabel="Saving…" onClick={() => save.mutate()}>
            Save the caller
          </Button>
          <Button kind="quiet" compact onClick={() => setF(seed())}>
            Undo
          </Button>
          {reason ? <span className="meta warn-ink">first: {reason}</span> : null}
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ 5 · wrap up */

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
  const inq = (entry.inquiry ?? {}) as Inq;
  const named = entry.guestProfile ?? null;
  const contact = entry as EntryDetail & { contactPersonName?: string | null; contactPersonPhone?: string | null };
  // A caller who is the agency or the company itself (2026-10-27) has a name already, and is never
  // the guest staying: Wrap up neither asks for a caller's name nor offers "The caller".
  const partyName = inq.travelAgent?.displayName ?? inq.corporateAccount?.displayName ?? null;
  const callerIsParty = callerIsTheParty(inq, partyName);
  const callerHasName = callerIsParty || !!(inq.callerFirstName?.trim() && inq.callerLastName?.trim());

  // The guest staying: the caller by default; once named, shown as named until "Change".
  const [changing, setChanging] = useState(false);
  const choosing = editable && (!named || changing);
  const [choice, setChoice] = useState<GuestChoice>(callerIsParty ? "OTHER" : "CALLER");
  const [nationality, setNationality] = useState(NATIONALITIES[0]);
  // The caller's name, when it was not taken at the start.
  const [cTitle, setCTitle] = useState("");
  const [cFirst, setCFirst] = useState("");
  const [cLast, setCLast] = useState("");
  // Someone else: typed, or a guest on file picked (`linked`), or kept as new despite one on file.
  const [nTitle, setNTitle] = useState("");
  const [nFirst, setNFirst] = useState("");
  const [nLast, setNLast] = useState("");
  const [nCode, setNCode] = useState(PHONE_CODES[0]);
  const [nNumber, setNNumber] = useState("");
  const [nEmail, setNEmail] = useState("");
  const [linked, setLinked] = useState<GuestOnFile | null>(null);
  const [keepNew, setKeepNew] = useState(false);
  const [nameAsk, setNameAsk] = useState<NameAsk | null>(null);

  // The guests on file with the phone or email typed so far, read while the desk types.
  const typedDigits = nNumber.replace(/\D/g, "");
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

  const [arrName, setArrName] = useState(contact.contactPersonName ?? "");
  const [arrPhone, setArrPhone] = useState(contact.contactPersonPhone ?? "");
  useEffect(() => {
    setArrName(contact.contactPersonName ?? "");
    setArrPhone(contact.contactPersonPhone ?? "");
  }, [contact.contactPersonName, contact.contactPersonPhone]);

  /** Name a guest on file: their record fills the form. */
  const linkGuest = (g: GuestOnFile) => {
    const ph = splitStoredPhone(g.phone);
    setLinked(g);
    setKeepNew(false);
    setNTitle(g.title ?? "");
    setNFirst(g.firstName);
    setNLast(g.lastName);
    if (g.phone) {
      setNCode(ph.code);
      setNNumber(ph.number);
    }
    if (g.email) setNEmail(g.email);
    if (g.nationality) setNationality(g.nationality);
  };
  /** A row picked from the dropdown: a different name already typed is asked about first. */
  const pickOnFile = (g: GuestOnFile) => {
    const typed = { firstName: nFirst.trim(), lastName: nLast.trim() };
    if (typed.firstName && typed.lastName && !sameGuestName(typed, g)) {
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

  const callerNameTyped = !!(cFirst.trim() && cLast.trim());
  const callerNameDirty = !callerHasName && !!(cFirst.trim() || cLast.trim() || cTitle);
  const nEmailBad = nEmail.trim() !== "" && !EMAIL_RE.test(nEmail.trim());
  const guestReason = !choosing
    ? null
    : choice === "CALLER"
      ? callerHasName || callerNameTyped
        ? null
        : "the caller's first and last name — the guest record is made from them"
      : !nFirst.trim() || !nLast.trim()
        ? "the guest's first and last name"
        : nEmailBad
          ? "an email that reads as one"
          : null;
  // Someone else is the one arriving — the backend fills "who is arriving" from them.
  const askArriving = !(choosing && choice === "OTHER");
  const arrivingDirty =
    askArriving && (arrName.trim() !== (contact.contactPersonName ?? "") || arrPhone.trim() !== (contact.contactPersonPhone ?? ""));
  const dirty = choosing || callerNameDirty || arrivingDirty;
  useFlowUnsaved("wrap", editable && dirty, "Changes to wrap up saved");

  const guestBody = (over?: { useOnFile?: string; keepNewName?: boolean }): SetGuestBody => {
    const phone = joinPhone(nCode, nNumber) || null;
    const email = nEmail.trim() || null;
    if (choice === "CALLER") {
      return over?.useOnFile
        ? { mode: "EXISTING", guestProfileId: over.useOnFile }
        : { mode: "CALLER", nationality, keepNewName: over?.keepNewName };
    }
    const typed = { firstName: nFirst.trim(), lastName: nLast.trim() };
    const onFileId = over?.useOnFile ?? (linked && sameGuestName(typed, linked) ? linked.id : null);
    if (onFileId) return { mode: "EXISTING", guestProfileId: onFileId, phone, email, arrivingIsGuest: true };
    return {
      mode: "NEW",
      title: nTitle || null,
      ...typed,
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
        await updateEntryCaller(session!, entry.id, { title: cTitle || null, firstName: cFirst.trim() || null, lastName: cLast.trim() || null });
        done.push("the caller's name");
      }
      if (choosing) {
        const r = await setEntryGuest(session!, entry.id, guestBody(over));
        done.push("the guest staying");
        if (r.reusedOnFile) notes.push("the guest was already on file — their record is used");
        if (r.contactKept?.length) {
          notes.push(`the ${r.contactKept.join(" and ")} on file is kept — a different one was typed`);
        }
        if (r.duplicate) toast.warning(`This guest already holds a stay over these nights — ${r.duplicate.conflictingEntryId}. It is flagged for the FOM.`);
      }
      if (arrivingDirty) {
        // The version moved if the guest was just named; read it fresh rather than refuse on a stale one.
        await updateEntryIntake(session!, entry.id, { contactPersonName: arrName.trim(), contactPersonPhone: arrPhone.trim() });
        done.push("who is arriving");
      }
      return { done, notes };
    },
    onSuccess: ({ done, notes }) => {
      toast.success(done.length ? `On record: ${done.join(", ")}` : "Nothing to save", notes.length ? { description: notes.join(" · ") } : undefined);
      setChanging(false);
      setCTitle("");
      setCFirst("");
      setCLast("");
      setLinked(null);
      setKeepNew(false);
      refresh([["inquiry", entry.inquiryId]]);
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

  const reachable = hasAnyContact(entry);
  const callerWord = callerNameOf(inq) ?? (callerNameTyped ? `${cFirst.trim()} ${cLast.trim()}` : null);
  const typedNameNow = titledName({ title: nameAsk?.typed.title ?? null, firstName: nameAsk?.typed.firstName ?? "", lastName: nameAsk?.typed.lastName ?? "" });
  return (
    <StepCard
      flow="wrap"
      flowAfter="house"
      flowAfterOnly
      title="Wrap up"
      meta="The rooms are chosen — now who is staying, and what was not taken at the start."
    >
      {/* the caller's name, when it was not taken at the start */}
      {!callerHasName && editable ? (
        <div className="form2" style={{ marginBottom: 12 }}>
          <div className="wide" style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3) var(--s4)" }}>
            <div className="field">
              <label>Caller · title</label>
              <select className="input" value={cTitle} onChange={(e) => setCTitle(e.target.value)}>
                {CALLER_TITLES.map((t) => (
                  <option key={t} value={t}>
                    {t || "—"}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Caller · first name</label>
              <input className="input" value={cFirst} onChange={(e) => setCFirst(e.target.value)} />
            </div>
            <div className="field">
              <label>Caller · last name</label>
              <input className="input" value={cLast} onChange={(e) => setCLast(e.target.value)} />
            </div>
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
                <b>{guestFullName({ firstName: named.firstName ?? "", lastName: named.lastName ?? "" })}</b>
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
            {callerIsParty ? null : (
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
                <div className="wide" style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) minmax(0,1fr)", gap: "var(--s3) var(--s4)" }}>
                  <div className="field">
                    <label>Title</label>
                    <select className="input" value={nTitle} onChange={(e) => setNTitle(e.target.value)}>
                      {CALLER_TITLES.map((t) => (
                        <option key={t} value={t}>
                          {t || "—"}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>First name</label>
                    <input className="input" aria-label="Guest's first name" value={nFirst} onChange={(e) => setNFirst(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Last name</label>
                    <input className="input" aria-label="Guest's last name" value={nLast} onChange={(e) => setNLast(e.target.value)} />
                  </div>
                </div>
                <div className="field">
                  <label>
                    Their phone · optional
                    <Help label="About the phone and email">Typing a phone or an email lists the guests already on file with it — pick one to name them.</Help>
                  </label>
                  <PhoneInput code={nCode} setCode={setNCode} number={nNumber} setNumber={setNNumber} ariaLabel="Guest's phone" />
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
                Keep {guestFullName({ firstName: named?.firstName ?? "", lastName: named?.lastName ?? "" })}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {askArriving ? (
        <div className="form2">
          <div className="field">
            <label>Who is arriving · name</label>
            <input className="input" value={arrName} readOnly={!editable} placeholder="who leads the party on the day" onChange={(e) => setArrName(e.target.value)} />
          </div>
          <div className="field">
            <label>
              Their phone
              <Help label="About their phone">Needed before arrival.</Help>
            </label>
            <input className="input" value={arrPhone} readOnly={!editable} placeholder="+975 …" onChange={(e) => setArrPhone(e.target.value)} />
          </div>
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
            state={save.isPending ? "working" : guestReason ? "inert" : "default"}
            title={guestReason ?? undefined}
            workingLabel="Saving…"
            onClick={() => save.mutate(undefined)}
          >
            Save wrap up
          </Button>
          {guestReason ? <span className="meta warn-ink">first: {guestReason}</span> : null}
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
