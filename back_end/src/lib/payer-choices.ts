import { BILLING_MODEL_DIRECT_BILL, BILLING_MODEL_GUEST_PAY } from "./billing-model-defaults.js";

export const BILLING_MODEL_VOUCHER = "TOUR_OPERATOR_VOUCHER";

export type PayerParty = "TRAVEL_AGENT" | "CORPORATE" | null;

export type PayerChoices = {
  /** Who the account is, when the booking has one. */
  party: PayerParty;
  /** What Set up offers, in the order it offers them. */
  choices: string[];
  /** What Set up starts on. */
  defaultChoice: string;
};

/**
 * Who a booking's bill may go to at Set up (2026-11-05, operator: "if its travel agent or corporate,
 * can the system by default first keep [the package to the account, anything beyond it to the guest]
 * ... show everything to travel agent ... show everything to corporate ... if its walk in, i think it
 * should only show everything to guest").
 *
 *  - Through a travel agent or a company: the package to them with extras to the guest, first; or
 *    everything to them.
 *  - With no account to bill (a walk-in, a direct caller): everything to the guest, and nothing else.
 *  - A group with no agent or company, and an OTA, keep all three as before. A group's bill is held to
 *    the account or the voucher unless the GM says otherwise, so "guest only" would stop the desk dead
 *    there; and an OTA may take the package or leave it all to the guest, by arrangement.
 */
export function payerChoicesFor(input: {
  travelAgentId?: string | null;
  corporateAccountId?: string | null;
  sourceChannel?: string | null;
  groupBillingMode?: string | null;
  useType?: string | null;
}): PayerChoices {
  const channel = (input.sourceChannel ?? "").trim().toUpperCase();
  const agent = !!input.travelAgentId || channel === "TRAVEL_AGENT" || channel === "AGENT";
  const company = !agent && (!!input.corporateAccountId || channel === "CORPORATE");
  if (agent || company) {
    return {
      party: agent ? "TRAVEL_AGENT" : "CORPORATE",
      choices: [BILLING_MODEL_VOUCHER, BILLING_MODEL_DIRECT_BILL],
      defaultChoice: BILLING_MODEL_VOUCHER,
    };
  }
  const all = [BILLING_MODEL_VOUCHER, BILLING_MODEL_DIRECT_BILL, BILLING_MODEL_GUEST_PAY];
  const group = input.groupBillingMode === "GROUP_MASTER" || input.useType === "GROUP" || input.useType === "CONFERENCE";
  if (group) return { party: null, choices: all, defaultChoice: BILLING_MODEL_DIRECT_BILL };
  if (channel === "OTA") return { party: null, choices: all, defaultChoice: BILLING_MODEL_GUEST_PAY };
  return { party: null, choices: [BILLING_MODEL_GUEST_PAY], defaultChoice: BILLING_MODEL_GUEST_PAY };
}
