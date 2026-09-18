"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getInquiry } from "@/lib/api/inquiries";
import { guestName } from "@/lib/desk/model";
import type { EntryDetail } from "@/types/api";

type PartyRow = { displayName?: string | null; contactEmail?: string | null } | null | undefined;
type InquiryWithParty = { travelAgent?: PartyRow; corporateAccount?: PartyRow };

export type InvoiceRecipient = {
  /** The agency or company the invoice is made out to — null when the guest is. */
  party: string | null;
  /** The party's email on file, when it has one. */
  partyEmail: string | null;
  /** The guest's email on file, when there is one. */
  guestEmail: string | null;
  /** What the "Send to" box starts with — the backend's own default, stated before the send. */
  defaultTo: string;
  /** Still reading who booked — the default is not known yet. */
  loading: boolean;
};

/**
 * Where an invoice email goes unless the desk types an address (2026-09-18). It mirrors the
 * backend's rule (`resolveInvoiceRecipient` in s9-service) so the operator sees it before the
 * send: every invoice — the proforma, the interim bill, the tax invoice — is made out to the
 * agency or company whenever one booked, so it goes to that party's email; the guest's email
 * only when no party is linked. A party with no email on file leaves the box empty: sending then
 * dispatches the invoice without an email, for the desk to hand over. It is never sent to the
 * traveller by default — it carries the party's own rates.
 */
export function useInvoiceRecipient(entry: EntryDetail): InvoiceRecipient {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["inquiry", entry.inquiryId],
    queryFn: () => getInquiry(session!, entry.inquiryId),
    enabled: !!session && !!entry.inquiryId,
  });
  const rec = (q.data ?? null) as InquiryWithParty | null;
  const partyRow = rec?.travelAgent ?? rec?.corporateAccount ?? null;
  const party = partyRow?.displayName?.trim() || null;
  const partyEmail = partyRow?.contactEmail?.trim() || null;
  const guestEmail = (entry.guestProfile?.email ?? entry.inquiry?.guestProfile?.email ?? "").trim() || null;
  const defaultTo = party ? partyEmail ?? "" : guestEmail ?? "";
  return { party, partyEmail, guestEmail, defaultTo, loading: q.isLoading };
}

/** The line under a "Send to" box — whose address it is, or what happens with none. */
export function recipientHint(r: InvoiceRecipient, typed: string): string {
  const to = typed.trim();
  if (r.party) {
    if (!to) return `${r.party} has no email on file — type the address, or leave it empty and hand the invoice over`;
    if (r.partyEmail && to === r.partyEmail) return `made out to ${r.party} — their email on file`;
    if (r.guestEmail && to === r.guestEmail) return `this is the guest's email — the invoice is made out to ${r.party} and shows its rates`;
    return `made out to ${r.party}`;
  }
  if (!to) return "no email on file — type one, or leave it empty and hand the invoice over";
  return r.guestEmail && to === r.guestEmail ? "the guest's email on file" : "";
}

/** Where a dispatched invoice went, in words — from the invoice's own recorded address. */
export function sentWords(dispatchedTo: string | null | undefined, entry: EntryDetail, party: string | null): string {
  if (dispatchedTo) return `emailed to ${dispatchedTo}`;
  const who = party ?? guestName(entry.guestProfile ?? entry.inquiry?.guestProfile ?? null);
  return `not emailed — no address for ${who === "Guest" ? "the guest" : who}; hand it over`;
}
