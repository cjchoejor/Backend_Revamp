"use client";

/**
 * The price set out as the quotation sets it out (2026-10-27, operator: "make the table adopt how
 * prices are shown in quotation, like how the meals and extra beds and all come under one column,
 * that way the user can just scroll down to look at it instead of scrolling horizontally").
 *
 * Each room is a row, its extra beds and its meals indented beneath it; then the net value, the
 * service charge, the GST, any discount and the total. Every row and figure is the server's —
 * built by the same code that writes the quotation (`lib/quotation-price-lines.ts`), so the tab
 * and the paper cannot disagree. Nothing is added up here.
 *
 * In the narrow booking file the Qty and Rate columns fold into the description's own line
 * ("Extra bed · 1 × 2 nights × 900.00"), so the table never scrolls sideways and each item takes
 * one line where it fits (2026-10-28, operator: "can this part be shown in a way that it takes less
 * space"); a meal plan's spelled-out meals go to the hover there (frame.css, `.plines`).
 */
import type { QuotationPriceLine } from "@/lib/api/quotations";
import { money } from "@/lib/ds/format";

export type PriceLinesFigures = {
  lines: QuotationPriceLine[];
  datesShown: boolean;
  net: number;
  serviceChargeLabel: string;
  serviceCharge: number;
  gstLabel: string;
  gst: number;
  discountLabel: string | null;
  discountAmount: number | null;
  discountNote: string | null;
  total: number;
};

const plain = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The name without a trailing "(…)" — "Meals · MAP+D (breakfast, dinner)" reads "Meals · MAP+D" in the
// narrow file, the whole name on hover.
const shortWhat = (d: string) => d.replace(/\s*\([^()]*\)\s*$/, "") || d;

export function PriceLinesTable({ f, currency, totalLabel = "Total" }: { f: PriceLinesFigures; currency: string; totalLabel?: string }) {
  return (
    <div className="plines-wrap">
    <table className={`table compact plines${f.datesShown ? " dated" : ""}`}>
      <thead>
        <tr>
          {f.datesShown ? <th className="pl-dates">Nights</th> : null}
          <th>Description</th>
          <th className="pl-qty">Qty</th>
          <th className="num pl-rate">Rate</th>
          <th className="num">Amount ({currency === "BTN" ? "Nu." : currency})</th>
        </tr>
      </thead>
      <tbody>
        {f.lines.map((l, i) => (
          <tr key={i} className={l.indent ? "pl-sub" : "pl-room"}>
            {f.datesShown ? <td className="pl-dates">{l.indent ? "" : l.dates ?? ""}</td> : null}
            <td className="pl-desc" title={shortWhat(l.description) !== l.description ? l.description : undefined}>
              <span className="pl-what">{l.description}</span>
              <span className="pl-what-short">{shortWhat(l.description)}</span>
              {/* Shown only when the Qty and Rate columns are folded away — on the name's own line. */}
              <span className="pl-fold">
                {!l.indent && f.datesShown && l.dates ? `${l.dates} · ` : ""}
                {l.qty}
                {l.rate != null ? ` × ${plain(l.rate)}` : ""}
              </span>
            </td>
            <td className="pl-qty">{l.qty}</td>
            <td className="num pl-rate">{l.rate != null ? plain(l.rate) : "—"}</td>
            <td className="num">{plain(l.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {/* The foot sits outside the table, so folding the Qty and Rate columns cannot misalign it. */}
    <div className="pl-foot">
      <span>Net value</span>
      <b>{plain(f.net)}</b>
      <span>{f.serviceChargeLabel}</span>
      <b>{plain(f.serviceCharge)}</b>
      <span>{f.gstLabel}</span>
      <b>{plain(f.gst)}</b>
      {f.discountLabel ? (
        <>
          <span>{f.discountLabel}</span>
          <b>{f.discountAmount != null ? `− ${plain(f.discountAmount)}` : f.discountNote ?? ""}</b>
        </>
      ) : null}
      <span className="total">{totalLabel}</span>
      <b className="total">{money(f.total, currency)}</b>
    </div>
    </div>
  );
}
