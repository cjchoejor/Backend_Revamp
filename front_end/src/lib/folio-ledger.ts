import type {
  FolioDetail,
  FolioLineSummary,
  PaymentRecordSummary,
  WriteOffRecordSummary,
} from "@/types/api";

function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

export type FolioLedgerSummary = {
  lineTotal: number;
  paymentsIn: number;
  paymentsOut: number;
  writeOffTotal: number;
  computedOutstanding: number;
  storedOutstanding: number | null;
  currency: string;
};

/** Matches backend `recomputeFolioOutstandingBalance` (folio lines − IN payments + OUT − write-offs). */
export function computeFolioLedger(
  folio: FolioDetail | null | undefined,
  lines: FolioLineSummary[],
  payments: PaymentRecordSummary[] = folio?.payments ?? [],
  writeOffs: WriteOffRecordSummary[] = folio?.writeOffRecords ?? [],
): FolioLedgerSummary {
  const lineTotal = lines.reduce((sum, l) => sum + toNum(l.amount), 0);
  let paymentsIn = 0;
  let paymentsOut = 0;
  for (const p of payments) {
    const amt = toNum(p.amount);
    if (p.paymentDirection === "OUT") paymentsOut += amt;
    else paymentsIn += amt;
  }
  const writeOffTotal = writeOffs.reduce((sum, w) => sum + toNum(w.writtenOffAmount), 0);
  const computedOutstanding = Math.max(0, lineTotal - paymentsIn + paymentsOut - writeOffTotal);
  const stored = folio?.outstandingBalance != null ? toNum(folio.outstandingBalance) : null;
  const currency =
    lines[0]?.currency ?? payments[0]?.currency ?? writeOffs[0]?.currency ?? "BTN";
  return {
    lineTotal,
    paymentsIn,
    paymentsOut,
    writeOffTotal,
    computedOutstanding,
    storedOutstanding: stored,
    currency,
  };
}

/** Prefer ledger math when line/payment rows are loaded; otherwise fall back to stored folio balance. */
export function folioOutstandingForDisplay(
  ledger: FolioLedgerSummary,
  hasLedgerRows: boolean,
): number {
  if (hasLedgerRows) {
    if (
      ledger.storedOutstanding != null &&
      Math.abs(ledger.storedOutstanding - ledger.computedOutstanding) > 0.01
    ) {
      return ledger.storedOutstanding;
    }
    return ledger.computedOutstanding;
  }
  if (ledger.storedOutstanding != null) return ledger.storedOutstanding;
  return ledger.computedOutstanding;
}
