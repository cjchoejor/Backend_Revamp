"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getSendTo } from "@/lib/api/documents";
import { guestName } from "@/lib/desk/model";
import type { EntryDetail } from "@/types/api";

export type InvoiceRecipient = {
  /** The agency or company the paper is made out to — null when the guest is. */
  party: string | null;
  /** The party's own email on file, when it has one. */
  partyEmail: string | null;
  /** The guest's email on file, when there is one. */
  guestEmail: string | null;
  /** What the "Send to" box starts with — the backend's own default, stated before the send. */
  defaultTo: string;
  /** Whose that address is, in words ("Mr Dorji · Bhutan INC's contact person"). */
  defaultWhose: string | null;
  /** The WhatsApp number a send starts with, and whose it is. */
  phone: string;
  phoneWhose: string | null;
  /** Still reading who booked — the default is not known yet. */
  loading: boolean;
};

/**
 * Where a paper goes unless the desk types something else — the backend's own rule
 * (`resolveSendTo`, lib/send-to.ts, read through `GET /entries/:id/send-to`) so the box and the
 * server never disagree (2026-11-07, operator: "auto pull the email and contact number of the
 * contact person"): through an agency or a company, the booking's contact person there, else the
 * party's own email and number; on a direct booking the guest, then who is arriving, then the
 * caller. A party-addressed paper is never mailed to the traveller by default — it carries the
 * party's own rates.
 */
export function useInvoiceRecipient(entry: EntryDetail): InvoiceRecipient {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["send-to", entry.id],
    queryFn: () => getSendTo(session!, entry.id),
    enabled: !!session && !!entry.id,
    staleTime: 10_000,
  });
  const d = q.data;
  return {
    party: d?.party ?? null,
    partyEmail: d?.partyEmail ?? null,
    guestEmail: d?.guestEmail ?? null,
    defaultTo: d?.email ?? "",
    defaultWhose: d?.emailWhose ?? null,
    phone: d?.phone ?? "",
    phoneWhose: d?.phoneWhose ?? null,
    loading: q.isLoading,
  };
}

/** The line under a "Send to" box — whose address it is, or what happens with none. */
export function recipientHint(r: InvoiceRecipient, typed: string): string {
  const to = typed.trim();
  const isDefault = !!r.defaultTo && to === r.defaultTo && !!r.defaultWhose;
  if (r.party) {
    if (!to) return `No email for ${r.party} or its contact person — type the address, or leave it empty and hand the paper over`;
    if (isDefault) return r.defaultWhose!;
    if (r.guestEmail && to === r.guestEmail) return `this is the guest's email — the paper is made out to ${r.party} and shows its rates`;
    return `made out to ${r.party}`;
  }
  if (!to) return "no email on file — type one, or leave it empty and hand the paper over";
  return isDefault ? r.defaultWhose! : "";
}

/** Where a dispatched invoice went, in words — from the invoice's own recorded address. */
export function sentWords(dispatchedTo: string | null | undefined, entry: EntryDetail, party: string | null): string {
  if (dispatchedTo) return `emailed to ${dispatchedTo}`;
  const who = party ?? guestName(entry.guestProfile ?? entry.inquiry?.guestProfile ?? null);
  return `not emailed — no address for ${who === "Guest" ? "the guest" : who}; hand it over`;
}
