import type { PrismaClient } from "@prisma/client";
import { normalizeCoordinators, type CoordinatorContact } from "../../lib/admin/contact-list.js";

/**
 * Who has rung before with this number or email (2026-10-27, operator: "in the caller section it
 * should be storing the caller — the caller may be the guest or not — but it seems to be pulling
 * the guest's details when I type a number, instead of the caller's"; "travel agent and corporate
 * numbers fall on the caller list … so next time they know it's a travel agent or corporate
 * caller; the guest they bring will be shown below").
 *
 * The intake's phone used to search GUEST records, so an agency's person typed in found a guest and
 * the desk took that guest as the caller. This lists CALLERS instead, from three places:
 *
 *  - **earlier enquiries' callers** (Inquiry.caller*) — an enquiry recorded before callers were
 *    kept (every caller field empty) counts its guest as the caller, the same reading the desk's
 *    caller card makes — but only on a direct booking: on an agency's or a company's, the party rang;
 *  - **an agency's or a company's contact persons** (coordinators[]) — filed on the admin console or
 *    from the desk;
 *  - **an agency's or a company's own numbers** (contactNumbers / contactEmail) — the office line.
 *
 * One row per person: the same number (its last eight digits — a number kept with and without its
 * dialling code is one number) or the same email, the same name, ringing for the same party. A
 * person on a party's contact list comes first. A caller who rang for an agency or
 * a company carries that party, so the desk can fill "Who is asking". Under each, the guests that
 * caller brought before — shown, never picked for the desk (the guest staying is named at Wrap
 * up, which offers them first). Read-only.
 */

export type CallerPartyMatch = {
  kind: "TRAVEL_AGENT" | "CORPORATE";
  id: string;
  displayName: string;
  contactNumbers: string[];
  contactEmail: string | null;
  modeOfContact: string;
  gstNumber?: string | null;
  contractRefs?: string[];
  coordinators: CoordinatorContact[];
};

export type CallerGuest = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  /** The latest check-in of a stay this caller booked for them. */
  lastStay: string | null;
};

export type CallerMatch = {
  key: string;
  kind: "DIRECT" | "TRAVEL_AGENT" | "CORPORATE";
  /** Where the caller was found: an earlier enquiry, a party's contact person, a party's own line. */
  foundAs: "EARLIER_CALLER" | "PARTY_CONTACT" | "PARTY_NUMBER";
  title: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  onWhatsApp: boolean | null;
  party: CallerPartyMatch | null;
  /** The party's contact person this caller is (or the party's own details for its office line). */
  partyContact: CoordinatorContact | null;
  calls: number;
  lastCalledAt: string | null;
  lastInquiryId: string | null;
  guests: CallerGuest[];
};

const ROW_LIMIT = 8;
const GUEST_LIMIT = 6;

const digitsOf = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
/** One number kept as "+97517429030" and as "17429030" is the same person. */
const phoneKey = (v: string | null | undefined) => {
  const d = digitsOf(v);
  return d.length >= 6 ? d.slice(-8) : null;
};

function splitName(name: string): { firstName: string | null; lastName: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || null };
}

export async function lookupCallers(
  prisma: PrismaClient,
  input: { q: string; excludeInquiryId?: string | null },
): Promise<{ mode: "PHONE" | "EMAIL" | "NONE"; matches: CallerMatch[] }> {
  const q = input.q.trim();
  const isEmail = q.includes("@");
  const digits = digitsOf(q);
  const email = isEmail ? q.toLowerCase() : null;
  if (!isEmail && digits.length < 4) return { mode: "NONE", matches: [] };
  if (isEmail && q.length < 4) return { mode: "NONE", matches: [] };
  const exclude = input.excludeInquiryId?.trim() || "";

  /* ---------------------------------------------------------------- earlier enquiries' callers */
  // An enquiry with no caller field at all was recorded before callers were kept: its guest rang.
  const legacy = `i."callerPhone" IS NULL AND i."callerEmail" IS NULL AND i."callerFirstName" IS NULL
    AND i."callerLastName" IS NULL AND i."callerTitle" IS NULL AND i."callerOnWhatsApp" IS NULL`;
  const idRows = isEmail
    ? await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT i.id FROM inquiries i LEFT JOIN guest_profiles g ON g.id = i."guestProfileId"
          WHERE i.id <> $2 AND (lower(coalesce(i."callerEmail", '')) LIKE '%' || $1 || '%'
             OR (${legacy} AND lower(coalesce(g.email, '')) LIKE '%' || $1 || '%')
             OR (${legacy} AND EXISTS (SELECT 1 FROM entries e WHERE e."inquiryId" = i.id
                  AND lower(coalesce(e."contactPersonEmail", '')) LIKE '%' || $1 || '%')))
          ORDER BY i."createdAt" DESC LIMIT 300`,
        email,
        exclude,
      )
    : await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT i.id FROM inquiries i LEFT JOIN guest_profiles g ON g.id = i."guestProfileId"
          WHERE i.id <> $2 AND (regexp_replace(coalesce(i."callerPhone", ''), '\\D', '', 'g') LIKE '%' || $1 || '%'
             OR (${legacy} AND regexp_replace(coalesce(g.phone, ''), '\\D', '', 'g') LIKE '%' || $1 || '%')
             OR (${legacy} AND EXISTS (SELECT 1 FROM entries e WHERE e."inquiryId" = i.id
                  AND regexp_replace(coalesce(e."contactPersonPhone", ''), '\\D', '', 'g') LIKE '%' || $1 || '%')))
          ORDER BY i."createdAt" DESC LIMIT 300`,
        digits,
        exclude,
      );

  const guestSelect = { id: true, firstName: true, lastName: true, phone: true, email: true, nationality: true } as const;
  const partySelect = {
    id: true,
    displayName: true,
    contactNumbers: true,
    contactEmail: true,
    modeOfContact: true,
    coordinators: true,
  } as const;
  const inquiries = idRows.length
    ? await prisma.inquiry.findMany({
        where: { id: { in: idRows.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          callerTitle: true,
          callerFirstName: true,
          callerLastName: true,
          callerPhone: true,
          callerEmail: true,
          callerOnWhatsApp: true,
          guestProfile: { select: guestSelect },
          travelAgent: { select: { ...partySelect, isActive: true } },
          corporateAccount: { select: { ...partySelect, gstNumber: true, contractRefs: true, isActive: true } },
          entries: {
            select: {
              checkInDate: true,
              contactPersonName: true,
              contactPersonPhone: true,
              contactPersonEmail: true,
              guestProfile: { select: guestSelect },
            },
          },
        },
      })
    : [];

  const matchesQuery = (phone: string | null | undefined, mail: string | null | undefined) =>
    isEmail ? !!mail && mail.toLowerCase().includes(email!) : digitsOf(phone).includes(digits);
  type Acc = CallerMatch & { guestMap: Map<string, CallerGuest>; onList: boolean };
  const rows = new Map<string, Acc>();
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  // The number (or the email) a person is reached on.
  const baseOf = (phone: string | null | undefined, mail: string | null | undefined) => {
    const pk = phoneKey(phone);
    if (pk) return `p:${pk}`;
    if (mail?.trim()) return `e:${mail.trim().toLowerCase()}`;
    return null;
  };
  // One person (2026-10-27, operator: Bhutan INC's contact's number listed a Gemini guest instead):
  // the number, the NAME and who they ring for. A number alone lumped together different people
  // who shared it — the old system's imports carry one number on many guests.
  const keyOf = (base: string, first: string | null | undefined, last: string | null | undefined, partyId: string | null) =>
    `${base}|${norm(`${first ?? ""} ${last ?? ""}`)}|${partyId ?? "direct"}`;
  const partyOf = (inq: (typeof inquiries)[number]): CallerPartyMatch | null => {
    if (inq.travelAgent?.isActive) {
      const { isActive: _a, ...p } = inq.travelAgent;
      return { kind: "TRAVEL_AGENT", ...p, coordinators: normalizeCoordinators(p.coordinators) };
    }
    if (inq.corporateAccount?.isActive) {
      const { isActive: _a, ...p } = inq.corporateAccount;
      return { kind: "CORPORATE", ...p, coordinators: normalizeCoordinators(p.coordinators) };
    }
    return null;
  };

  for (const inq of inquiries) {
    const isLegacy =
      inq.callerPhone == null &&
      inq.callerEmail == null &&
      inq.callerFirstName == null &&
      inq.callerLastName == null &&
      inq.callerTitle == null &&
      inq.callerOnWhatsApp == null;
    const g = inq.guestProfile;
    // An enquiry from before callers were kept: on a direct booking its guest rang; on an
    // agency's or a company's, the party's person did — the booking's contact person, which the
    // intake filled from the party's list.
    const viaParty = isLegacy && !!(inq.travelAgent || inq.corporateAccount);
    const cp = viaParty
      ? (inq.entries.find((e) => matchesQuery(e.contactPersonPhone, e.contactPersonEmail)) ??
        inq.entries.find((e) => e.contactPersonPhone || e.contactPersonEmail))
      : undefined;
    if (viaParty && !cp) continue;
    const cpName = cp?.contactPersonName ? splitName(cp.contactPersonName) : { firstName: null, lastName: null };
    const phone = viaParty ? (cp!.contactPersonPhone ?? null) : isLegacy ? (g?.phone ?? null) : inq.callerPhone;
    const mail = viaParty ? (cp!.contactPersonEmail ?? null) : isLegacy ? (g?.email ?? null) : inq.callerEmail;
    if (!matchesQuery(phone, mail)) continue;
    const base = baseOf(phone, mail);
    if (!base) continue;
    const first = viaParty ? cpName.firstName : isLegacy ? (g?.firstName ?? null) : inq.callerFirstName;
    const last = viaParty ? cpName.lastName : isLegacy ? (g?.lastName ?? null) : inq.callerLastName;
    const party = partyOf(inq);
    const key = keyOf(base, first, last, party?.id ?? null);
    let row = rows.get(key);
    if (!row) {
      // Inquiries come newest first: the first one seen gives the caller's details.
      row = {
        key,
        kind: party?.kind ?? "DIRECT",
        foundAs: "EARLIER_CALLER",
        title: isLegacy ? null : inq.callerTitle,
        firstName: first,
        lastName: last,
        phone,
        email: mail,
        onWhatsApp: isLegacy ? null : inq.callerOnWhatsApp,
        party,
        partyContact: null,
        calls: 0,
        lastCalledAt: inq.createdAt.toISOString(),
        lastInquiryId: inq.id,
        guests: [],
        guestMap: new Map(),
        onList: false,
      };
      rows.set(key, row);
    }
    row.calls += 1;
    // The guests they brought: the enquiry's guest and each stay's.
    const brought: Array<{ g: typeof g; stay: Date | null }> = [{ g, stay: null }];
    for (const e of inq.entries) brought.push({ g: e.guestProfile, stay: e.checkInDate });
    for (const b of brought) {
      if (!b.g) continue;
      const prev = row.guestMap.get(b.g.id);
      const stay = b.stay ? b.stay.toISOString().slice(0, 10) : null;
      if (!prev) row.guestMap.set(b.g.id, { ...b.g, lastStay: stay });
      else if (stay && (!prev.lastStay || stay > prev.lastStay)) prev.lastStay = stay;
    }
  }

  /* ---------------------------------------------------------------- agencies' and companies' people */
  const [agencies, companies] = await Promise.all([
    prisma.travelAgent.findMany({ where: { isActive: true }, select: partySelect }),
    prisma.corporateAccount.findMany({ where: { isActive: true }, select: { ...partySelect, gstNumber: true, contractRefs: true } }),
  ]);
  const matches = matchesQuery;

  const parties: CallerPartyMatch[] = [
    ...agencies.map((a) => ({ kind: "TRAVEL_AGENT" as const, ...a, coordinators: normalizeCoordinators(a.coordinators) })),
    ...companies.map((c) => ({ kind: "CORPORATE" as const, ...c, coordinators: normalizeCoordinators(c.coordinators) })),
  ];
  for (const party of parties) {
    const found: Array<{ contact: CoordinatorContact; foundAs: CallerMatch["foundAs"] }> = [];
    for (const c of party.coordinators) if (matches(c.phone, c.email)) found.push({ contact: c, foundAs: "PARTY_CONTACT" });
    // The party's own line, unless a person on its list already answers on that number.
    const personBases = new Set(found.map((f) => baseOf(f.contact.phone, f.contact.email)));
    for (const n of party.contactNumbers ?? []) {
      if (!isEmail && matches(n, null) && !personBases.has(baseOf(n, null))) {
        found.push({ contact: { name: party.displayName, phone: n, email: party.contactEmail }, foundAs: "PARTY_NUMBER" });
      }
    }
    if (isEmail && matches(null, party.contactEmail)) {
      found.push({ contact: { name: party.displayName, phone: party.contactNumbers?.[0] ?? null, email: party.contactEmail }, foundAs: "PARTY_NUMBER" });
    }
    for (const f of found) {
      const base = baseOf(f.contact.phone, f.contact.email) ?? `party:${party.id}`;
      const person = f.foundAs === "PARTY_CONTACT" ? splitName(f.contact.name) : { firstName: null, lastName: null };
      const key = keyOf(base, person.firstName, person.lastName, party.id);
      // The same person who rang for this party before — or rang for it without giving a name —
      // is one row, now known to be on its list.
      const unnamed = keyOf(base, null, null, party.id);
      const existing = rows.get(key) ?? (key !== unnamed ? rows.get(unnamed) : undefined);
      if (existing) {
        existing.onList = existing.onList || f.foundAs === "PARTY_CONTACT";
        existing.partyContact = existing.partyContact ?? f.contact;
        if (!existing.firstName && !existing.lastName) {
          existing.firstName = person.firstName;
          existing.lastName = person.lastName;
        }
        continue;
      }
      rows.set(key, {
        key,
        kind: party.kind,
        foundAs: f.foundAs,
        title: null,
        firstName: person.firstName,
        lastName: person.lastName,
        phone: f.contact.phone ?? null,
        email: f.contact.email ?? null,
        onWhatsApp: null,
        party,
        partyContact: f.contact,
        calls: 0,
        lastCalledAt: null,
        lastInquiryId: null,
        guests: [],
        guestMap: new Map(),
        onList: f.foundAs === "PARTY_CONTACT",
      });
    }
  }

  // An earlier caller of a party who is not yet on its list still names the party's contact.
  for (const row of rows.values()) {
    if (row.party && !row.partyContact) {
      const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || row.party.displayName;
      row.partyContact = { name, phone: row.phone, email: row.email };
    }
  }

  const exactness = (r: Acc) => {
    if (isEmail) return r.email?.toLowerCase() === email ? 2 : 0;
    const d = digitsOf(r.phone);
    return d && (d.endsWith(digits) || digits.endsWith(d)) && digits.length >= 8 ? 2 : 0;
  };
  const out = [...rows.values()]
    .sort((a, b) => {
      const e = exactness(b) - exactness(a);
      if (e) return e;
      // Someone on an agency's or a company's contact list is a known caller: first.
      const l = Number(b.onList) - Number(a.onList);
      if (l) return l;
      const t = (b.lastCalledAt ?? "").localeCompare(a.lastCalledAt ?? "");
      if (t) return t;
      return `${a.firstName ?? ""}${a.lastName ?? ""}`.localeCompare(`${b.firstName ?? ""}${b.lastName ?? ""}`);
    })
    .slice(0, ROW_LIMIT)
    .map(({ guestMap, onList: _l, ...r }) => ({
      ...r,
      guests: [...guestMap.values()]
        .sort((a, b) => (b.lastStay ?? "").localeCompare(a.lastStay ?? ""))
        .slice(0, GUEST_LIMIT),
    }));
  return { mode: isEmail ? "EMAIL" : "PHONE", matches: out };
}
