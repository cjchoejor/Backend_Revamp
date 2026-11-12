/**
 * The bank and the journal number of money that goes through a bank (2026-11-12, operator: "when
 * doing payments like advance or payments, or refund, when user chooses card, pos, scan or mobile
 * payments, we need to next ask for the type of bank … and then record journal number"; ruled the
 * same day: card, QR / mobile and bank transfers alike, the list of banks editable in the admin).
 *
 * One rule for every place money is recorded, in or out. A method that goes through a bank needs a
 * bank from the hotel's list and a journal number; any other method (cash, a voucher, a direct bill)
 * stores neither. Stored on the payment row itself (`PaymentRecord.bankName`, `.journalNumber`).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "./config-store.js";
import { ValidationError } from "./errors.js";

/** The methods that go through a bank. */
export const BANK_METHODS = ["CARD", "MOBILE_PAYMENT", "BANK_TRANSFER", "INWARD_REMITTANCE"] as const;

export function methodNeedsBank(method: string | null | undefined): boolean {
  return !!method && (BANK_METHODS as readonly string[]).includes(method.trim().toUpperCase());
}

/** The hotel's banks until an admin saves its own list (`payment.banks`). */
export const DEFAULT_PAYMENT_BANKS = ["Bank of Bhutan", "Bhutan National Bank", "BDBL", "Punjab National Bank", "DK Bank", "UPI"];

export const PAYMENT_BANKS_KEY = "payment.banks";

type Db = PrismaClient | Prisma.TransactionClient;

/** The banks the desk may pick from: the admin's list, else the hotel's six. */
export async function readPaymentBanks(db: Db): Promise<string[]> {
  const row = await getActiveConfigEntry(db as PrismaClient, PAYMENT_BANKS_KEY);
  const v = row?.configValue;
  const list = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];
  return list.length ? list : [...DEFAULT_PAYMENT_BANKS];
}

const METHOD_WORD: Record<string, string> = {
  CARD: "the card",
  MOBILE_PAYMENT: "the QR payment",
  BANK_TRANSFER: "the transfer",
  INWARD_REMITTANCE: "the remittance",
};

/**
 * The bank and journal number to store with a payment, checked. For a method through a bank both
 * are required, the bank one on the list (matched whatever its case, stored as the list writes it);
 * for any other method both are dropped. `what` says "payment" or "refund" in the refusal.
 */
export async function cleanPaymentBank(
  db: Db,
  input: { method: string | null | undefined; bankName?: string | null; journalNumber?: string | null },
  what: "payment" | "refund" = "payment",
): Promise<{ bankName: string | null; journalNumber: string | null }> {
  if (!methodNeedsBank(input.method)) return { bankName: null, journalNumber: null };
  const m = METHOD_WORD[input.method!.trim().toUpperCase()] ?? "the payment";
  const banks = await readPaymentBanks(db);
  const asked = input.bankName?.trim() ?? "";
  if (!asked) throw new ValidationError(what === "refund" ? "Pick the bank the refund goes back through" : `Pick the bank ${m} went through`);
  const bank = banks.find((b) => b.toLowerCase() === asked.toLowerCase());
  if (!bank) throw new ValidationError(`${asked} is not on the hotel's list of banks — pick one from the list`);
  const journal = input.journalNumber?.trim() ?? "";
  if (!journal) throw new ValidationError(`Type the journal number of the ${what}`);
  if (journal.length > 60) throw new ValidationError("A journal number is at most 60 characters");
  return { bankName: bank, journalNumber: journal };
}
