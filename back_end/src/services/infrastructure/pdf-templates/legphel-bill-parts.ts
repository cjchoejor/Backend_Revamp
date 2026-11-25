/**
 * The pieces the three folio bills share (2026-11-25, operator: "master bill needs proper formatting,
 * use the same format, but see what info and how to show info … for good well known hotels; do the
 * same for invoice as well").
 *
 * What a well-known hotel's folio carries, and the house format now prints on the Master Bill, the
 * Tax Invoice and the Tentative invoice (Interim Folio Statement):
 *   - a GUEST block and a STAY block side by side at the top — who the bill is to (and the guest
 *     when an agency or a company pays), the guests; the booking and folio numbers, check-in,
 *     check-out and nights, when the bill was made — instead of one long column of rows;
 *   - the ROOMS on a line of their own that wraps (a long list used to run off the page);
 *   - every CHARGE on its own line — date, description, nights × rate, amount — a room's nights at
 *     one figure set out on one row, as the quotation does, and the amounts net, with the service
 *     charge and GST added beneath (the quotation's ladder);
 *   - the PAYMENTS as a small table — date, receipt, how paid (bank, journal number), amount;
 *   - the BALANCE as its own ruled line, then the notes and, at check-out, the guest's signature.
 *
 * The house look is kept: the card, the masthead, the family colour, the fonts, the footline.
 */
import { htmlEscape } from "../../../lib/pdf-render-context.js";

export type InfoRow = { k: string; v: string; strong?: boolean; red?: boolean; mono?: boolean };
export type InfoBlock = { heading: string; rows: Array<InfoRow | null | false | undefined> };

export const BILL_PARTS_CSS = `
  .dinfo { display:grid;grid-template-columns:1fr 1fr;gap:0 18px;margin:6px 0 2px }
  .dinfo .ih { font-size:6.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--slate);font-weight:600;
    border-bottom:1px solid var(--ink);padding-bottom:2px;margin-bottom:3px }
  .dinfo .ir { display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:1.5px 0;font-size:9px;line-height:1.35 }
  .dinfo .ir .k { color:var(--slate);white-space:nowrap }
  .dinfo .ir .v { text-align:right;color:#2E3238;overflow-wrap:anywhere }
  .dinfo .ir .v.b { font-weight:600;color:var(--ink) }
  .dinfo .ir .v.m { font-family:var(--mono);font-size:8.5px }
  .dinfo .ir .v.red { font-family:var(--mono);font-size:8.5px;color:var(--crimson);font-weight:600 }
  .drooms { display:flex;gap:10px;font-size:9px;padding:4px 0 2px;border-bottom:1px solid var(--hair);line-height:1.45 }
  .drooms .k { color:var(--slate);white-space:nowrap }
  .drooms .v { color:#2E3238;overflow-wrap:anywhere }
  table.mini.bill td:first-child { white-space:nowrap;color:var(--slate) }
  table.mini.bill td.desc { width:100% }
  table.mini.bill tr.neg td { color:var(--crimson) }
  table.mini.pay td:first-child { white-space:nowrap;color:var(--slate) }
  table.mini.pay td:nth-child(2) { white-space:nowrap;font-family:var(--mono);font-size:8px }
  table.mini.pay td.how { width:100% }
  table.mini.pay td.how small { display:block;color:var(--mute);font-size:7.5px }
  .dempty { font-size:8.5px;color:var(--mute);padding:3px 0 4px }
  .dl.bal { border-top:1px solid var(--ink);border-bottom:2px solid var(--ink);margin-top:4px;padding:5px 0 4px }
  .dl.bal .k { font-size:8px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:var(--ink) }
  .dl.bal .v { font-weight:700;font-size:11.5px;color:var(--brand) }
  .dl.bal.clear .v { color:var(--ink) }
  .dwords { font-size:8px;color:var(--slate);margin:3px 0 0;line-height:1.5 }
  .dwords b { color:var(--ink);font-weight:600 }
  .dliab { margin-top:10px;font-size:7.5px;line-height:1.55;color:var(--slate) }
`;

function infoRow(r: InfoRow): string {
  const cls = ["v", r.strong ? "b" : "", r.mono ? "m" : "", r.red ? "red" : ""].filter(Boolean).join(" ");
  return `<div class="ir"><span class="k">${htmlEscape(r.k)}</span><span class="${cls}">${htmlEscape(r.v)}</span></div>`;
}

/** Two blocks side by side — who the bill is to, and the stay. */
export function infoBlocks(left: InfoBlock, right: InfoBlock): string {
  const col = (b: InfoBlock) =>
    `<div><div class="ih">${htmlEscape(b.heading)}</div>${b.rows.filter((r): r is InfoRow => !!r).map(infoRow).join("")}</div>`;
  return `<div class="dinfo">${col(left)}${col(right)}</div>`;
}

/** The rooms on a line of their own, wrapping. */
export function roomsLine(label: string, value: string | null): string {
  if (!value) return "";
  return `<div class="drooms"><span class="k">${htmlEscape(label)}</span><span class="v">${htmlEscape(value)}</span></div>`;
}

export type PaperBillRow = { when: string; description: string; qty: string; rate: string; amount: string; negative?: boolean };

/** Date · Description · Qty · Rate · Amount — one row per charge, a room's nights on one row. */
export function billLinesTable(rows: PaperBillRow[]): string {
  if (rows.length === 0) return `<div class="dempty">Nothing charged yet.</div>`;
  const head = `<tr><th>Date</th><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr>`;
  const body = rows
    .map(
      (r) =>
        `<tr${r.negative ? ' class="neg"' : ""}><td>${htmlEscape(r.when)}</td><td class="desc">${htmlEscape(r.description)}</td><td class="r">${htmlEscape(
          r.qty,
        )}</td><td class="r">${htmlEscape(r.rate)}</td><td class="r">${htmlEscape(r.amount)}</td></tr>`,
    )
    .join("");
  return `<table class="mini bill">${head}${body}</table>`;
}

export type PaperPaymentRow = { when: string; receipt: string; how: string; detail?: string | null; amount: string };

/** Date · Receipt · How paid · Amount. */
export function paymentsTable(rows: PaperPaymentRow[], emptyText: string): string {
  if (rows.length === 0) return `<div class="dempty">${htmlEscape(emptyText)}</div>`;
  const head = `<tr><th>Date</th><th>Receipt</th><th>How paid</th><th class="r">Amount</th></tr>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td>${htmlEscape(r.when)}</td><td>${htmlEscape(r.receipt)}</td><td class="how">${htmlEscape(r.how)}${
          r.detail ? `<small>${htmlEscape(r.detail)}</small>` : ""
        }</td><td class="r">${htmlEscape(r.amount)}</td></tr>`,
    )
    .join("");
  return `<table class="mini pay">${head}${body}</table>`;
}

/** The balance line: ruled above and below, the figure in the brand colour while money is owed. */
export function balanceRow(label: string, value: string, owed: boolean): string {
  return `<div class="dl bal${owed ? "" : " clear"}"><span class="k">${htmlEscape(label)}</span><span class="v">${htmlEscape(value)}</span></div>`;
}

export function amountInWordsLine(words: string): string {
  return `<p class="dwords">Amount in words: <b>${htmlEscape(words)}</b></p>`;
}

export function liabilityStatement(text: string): string {
  return `<p class="dliab">${htmlEscape(text)}</p>`;
}

// ---------------------------------------------------------------------------------------------
// Words for the bills
// ---------------------------------------------------------------------------------------------

const METHOD_WORDS: Record<string, string> = {
  CASH: "Cash",
  CARD: "Card",
  MOBILE_PAYMENT: "QR payment",
  BANK_TRANSFER: "Bank transfer",
  INWARD_REMITTANCE: "Inward remittance",
  VOUCHER: "Agency voucher",
  CREDIT: "On account",
  DIRECT_BILL: "On account",
};

/** "Bank transfer · Bank of Bhutan" and, under it, "Journal 321321321". */
export function paymentWords(p: {
  method: string | null;
  bankName: string | null;
  journalNumber: string | null;
  reference: string | null;
  direction: string;
  tripMove: boolean;
}): { how: string; detail: string | null } {
  const method = p.method ? (METHOD_WORDS[p.method] ?? p.method.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())) : "Payment";
  if (p.tripMove) return { how: p.direction === "OUT" ? "Moved to another stay of the trip" : "Moved from another stay of the trip", detail: null };
  const how = [p.direction === "OUT" ? `Refund · ${method.toLowerCase()}` : method, p.bankName].filter(Boolean).join(" · ");
  // A cash receipt's reference is stored as "CASH:123"; print the number alone.
  const ref = p.reference ? p.reference.replace(/^[A-Z_]+:/, "") : null;
  const detail = p.journalNumber ? `Journal ${p.journalNumber}` : ref ? `Ref ${ref}` : null;
  return { how, detail };
}

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowThousand(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (r > 0) parts.push(r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ""}`);
  return parts.join(" ");
}

function wholeInWords(n: number): string {
  if (n === 0) return "Zero";
  const scales: Array<[number, string]> = [
    [1_000_000_000, "Billion"],
    [1_000_000, "Million"],
    [1_000, "Thousand"],
  ];
  const parts: string[] = [];
  let rest = n;
  for (const [size, word] of scales) {
    if (rest >= size) {
      parts.push(`${belowThousand(Math.floor(rest / size))} ${word}`);
      rest %= size;
    }
  }
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(" ");
}

const CURRENCY_WORDS: Record<string, [string, string]> = {
  BTN: ["Ngultrum", "Chhertum"],
  INR: ["Rupees", "Paise"],
  USD: ["US Dollars", "Cents"],
};

/** "Ngultrum Thirteen Thousand Eight Hundred Sixty Only" — from the figure printed above it, as a string. */
export function amountInWords(amountText: string, currency: string): string {
  const [major, minor] = CURRENCY_WORDS[currency] ?? [currency, "hundredths"];
  const clean = amountText.replace(/[^0-9.]/g, "");
  const [whole = "0", frac = "0"] = clean.split(".");
  const w = Number(whole);
  const c = Number(frac.padEnd(2, "0").slice(0, 2));
  return `${major} ${wholeInWords(w)}${c > 0 ? ` and ${minor} ${wholeInWords(c)}` : ""} Only`;
}
