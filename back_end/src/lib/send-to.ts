import type { Prisma, PrismaClient } from "@prisma/client";
import { guestDisplayName } from "./guest-display-name.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * WHO A PAPER GOES TO BY DEFAULT — the email and the WhatsApp number a send box starts with
 * (2026-11-07, operator: "it should be auto pulling the travel agent's (also corporate) number and
 * email if contact person's isn't given or else, it should auto pull the email and contact number
 * of the contact person. if walk in, then their email or number").
 *
 *   - Through a travel agent or a company: the booking's contact person (the first on the enquiry,
 *     `Inquiry.partyContact*`) when they have one; otherwise the party's own email and first number.
 *     Each is looked for on its own, so a contact person with a number and no email gets the
 *     party's email.
 *   - Anyone else: the guest's own email and number; then who is arriving; then the caller.
 *
 * One rule for every paper and every send box: the quotation, the proforma, the voucher, the
 * mid-stay bill and the tax invoice (`resolveInvoiceRecipient` reads it), so the box on the desk
 * and the address the server uses when nothing is typed are always the same.
 */
export type SendTo = {
  /** The agency or company the booking came through — null on a direct booking. */
  party: string | null;
  email: string | null;
  /** Whose email it is, in words. */
  emailWhose: string | null;
  phone: string | null;
  phoneWhose: string | null;
  /** The party's own email on file, and the guest's — for the words under a send box. */
  partyEmail: string | null;
  guestEmail: string | null;
};

const clean = (v: string | null | undefined) => (v ?? "").trim() || null;

export async function resolveSendTo(db: DbClient, entryId: string): Promise<SendTo> {
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      contactPersonName: true,
      contactPersonPhone: true,
      contactPersonEmail: true,
      guestProfile: { select: { title: true, firstName: true, lastName: true, email: true, phone: true } },
      inquiry: {
        select: {
          callerPhone: true,
          callerEmail: true,
          partyContactName: true,
          partyContactPhone: true,
          partyContactEmail: true,
          travelAgent: { select: { displayName: true, contactEmail: true, contactNumbers: true } },
          corporateAccount: { select: { displayName: true, contactEmail: true, contactNumbers: true } },
        },
      },
    },
  });
  const inquiry = entry?.inquiry ?? null;
  const partyRow = inquiry?.travelAgent ?? inquiry?.corporateAccount ?? null;
  const party = clean(partyRow?.displayName);
  const partyEmail = clean(partyRow?.contactEmail);
  const partyPhone = clean(partyRow?.contactNumbers?.find((n) => clean(n)));
  const guestEmail = clean(entry?.guestProfile?.email);
  const guestPhone = clean(entry?.guestProfile?.phone);

  if (party) {
    const person = clean(inquiry?.partyContactName);
    const personEmail = clean(inquiry?.partyContactEmail);
    const personPhone = clean(inquiry?.partyContactPhone);
    const personWords = person ? `${person} · ${party}'s contact person` : `${party}'s contact person`;
    return {
      party,
      email: personEmail ?? partyEmail,
      emailWhose: personEmail ? personWords : partyEmail ? `${party}'s email on file` : null,
      phone: personPhone ?? partyPhone,
      phoneWhose: personPhone ? personWords : partyPhone ? `${party}'s number on file` : null,
      partyEmail,
      guestEmail,
    };
  }

  const guest = guestDisplayName(entry?.guestProfile) || null;
  const guestWords = guest ? `${guest} · the guest` : "the guest";
  const arriving = clean(entry?.contactPersonName);
  const arrivingWords = arriving ? `${arriving} · who is arriving` : "who is arriving";
  const pick = (
    options: Array<[string | null, string]>,
  ): [string | null, string | null] => {
    for (const [value, whose] of options) if (value) return [value, whose];
    return [null, null];
  };
  const [email, emailWhose] = pick([
    [guestEmail, guestWords],
    [clean(entry?.contactPersonEmail), arrivingWords],
    [clean(inquiry?.callerEmail), "the caller"],
  ]);
  const [phone, phoneWhose] = pick([
    [guestPhone, guestWords],
    [clean(entry?.contactPersonPhone), arrivingWords],
    [clean(inquiry?.callerPhone), "the caller"],
  ]);
  return { party: null, email, emailWhose, phone, phoneWhose, partyEmail: null, guestEmail };
}
