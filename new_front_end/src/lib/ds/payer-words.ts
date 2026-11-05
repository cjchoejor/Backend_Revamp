/**
 * Who pays, in the desk's words, wherever the choice is named (2026-11-05, operator: "if there's a
 * shorter way to say this"). The choices themselves are the server's: `GET /entries/:id/payer-choices`.
 */
export type PayerParty = "TRAVEL_AGENT" | "CORPORATE" | null;

const WHO: Record<NonNullable<PayerParty>, string> = {
  TRAVEL_AGENT: "travel agent",
  CORPORATE: "corporate",
};

/** Whether the booking came through a travel agent or a company. Keep in step with `lib/payer-choices.ts`. */
export function payerPartyOf(entry: {
  inquiry?: { travelAgentId?: string | null; corporateAccountId?: string | null; sourceChannel?: string | null } | null;
}): PayerParty {
  const inq = entry.inquiry;
  const channel = (inq?.sourceChannel ?? "").toUpperCase();
  if (inq?.travelAgentId || channel === "TRAVEL_AGENT" || channel === "AGENT") return "TRAVEL_AGENT";
  if (inq?.corporateAccountId || channel === "CORPORATE") return "CORPORATE";
  return null;
}

export function payerChoiceWord(model: string | null | undefined, party: PayerParty): string {
  if (!model) return "";
  const who = party ? WHO[party] : "the account";
  switch (model) {
    case "TOUR_OPERATOR_VOUCHER":
      return `Package to ${who} · extras to guest`;
    case "DIRECT_BILL":
      return `Everything to ${who}`;
    case "GUEST_PAY":
      return "Everything to guest";
    case "GOVERNMENT":
      return "Everything to the government account";
    default:
      return model.replace(/_/g, " ").toLowerCase();
  }
}
