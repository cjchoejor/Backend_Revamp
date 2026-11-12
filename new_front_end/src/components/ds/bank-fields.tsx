"use client";

/**
 * The bank and the journal number (2026-11-12, operator: "when user chooses card, pos, scan or
 * mobile payments, we need to next ask for the type of bank … and then record journal number"; card,
 * QR / mobile and bank transfers alike). Shown under "How it was paid" in every form that records
 * money in or out, once the method goes through a bank; the save waits for both. The banks and the
 * methods that ask are the server's (`GET /api/lookups/payment-banks`; the list is the admin's).
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "@/hooks/use-session";
import { apiRequest } from "@/lib/api/client";
import { ReqMark } from "./steps/new-inquiry-parts";

const FALLBACK_METHODS = ["CARD", "MOBILE_PAYMENT", "BANK_TRANSFER", "INWARD_REMITTANCE"];

export function usePaymentBanks() {
  const { session } = useSession();
  return useQuery({
    queryKey: ["payment-banks"],
    queryFn: () => apiRequest<{ banks: string[]; methods: string[] }>("/api/lookups/payment-banks", { method: "GET", session }),
    enabled: !!session,
    staleTime: 60_000,
  });
}

export type BankEntry = {
  bank: string;
  journal: string;
  setBank: (v: string) => void;
  setJournal: (v: string) => void;
  banks: string[];
  /** Does this method go through a bank? */
  needs: (method: string | null | undefined) => boolean;
  /** What the save still waits for, in words, or null. */
  missing: (method: string | null | undefined) => string | null;
  /** The two fields for the request, only for a method through a bank. */
  body: (method: string | null | undefined) => { bankName?: string; journalNumber?: string };
  reset: () => void;
};

export function useBankEntry(): BankEntry {
  const q = usePaymentBanks();
  const [bank, setBank] = useState("");
  const [journal, setJournal] = useState("");
  const methods = q.data?.methods ?? FALLBACK_METHODS;
  const needs = (m: string | null | undefined) => !!m && methods.includes(m);
  return {
    bank,
    journal,
    setBank,
    setJournal,
    banks: q.data?.banks ?? [],
    needs,
    missing: (m) => (!needs(m) ? null : !bank ? "pick the bank" : !journal.trim() ? "type the journal number" : null),
    body: (m) => (needs(m) ? { bankName: bank, journalNumber: journal.trim() } : {}),
    reset: () => {
      setBank("");
      setJournal("");
    },
  };
}

/** The Bank and Journal number fields, for a method through a bank; nothing otherwise. */
export function BankFields({ entry, method, what = "payment" }: { entry: BankEntry; method: string | null | undefined; what?: "payment" | "refund" }) {
  if (!entry.needs(method)) return null;
  return (
    <div className="form2 bank-fields" data-bank-fields>
      <div className="field">
        <label>
          Bank {entry.bank ? null : <ReqMark title="Pick the bank" />}
        </label>
        <select className={`input${entry.bank ? "" : " missing"}`} value={entry.bank} onChange={(e) => entry.setBank(e.target.value)} aria-label="Bank" data-bank-select>
          <option value="">Pick the bank</option>
          {entry.banks.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>
          Journal number {entry.journal.trim() ? null : <ReqMark title="Type the journal number" />}
        </label>
        <input
          className={`input${entry.journal.trim() ? "" : " missing"}`}
          value={entry.journal}
          maxLength={60}
          onChange={(e) => entry.setJournal(e.target.value)}
          placeholder={what === "refund" ? "on the refund slip" : "on the slip or the screen"}
          aria-label="Journal number"
          data-journal-input
        />
      </div>
    </div>
  );
}
