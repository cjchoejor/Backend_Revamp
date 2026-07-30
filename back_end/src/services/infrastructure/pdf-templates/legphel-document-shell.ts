/**
 * Shared document shell for the Legphel house document format.
 *
 * The CSS here is ported VERBATIM from the design reference at
 * `docs/bills/legphel-document-formats-complete-30 (1).html` — same custom properties, same
 * class names (`.doc`, `.dmast`, `.dl`, `.dsec`, `.mini`, `.dnote`, `.dfoot`, `.dbank`), same
 * sizes. Every document in Families A–E is one `.doc` card built from the same primitives, so
 * the CSS lives here once and each template only composes rows.
 *
 * Family accents (the 3px top border) come from the reference's `.doc.f/.c/.i/.n` modifiers:
 *   f = Fiscal (crimson) · c = Commercial (bronze) · i = Informational (steel) · n = Internal (dashed)
 *
 * FONTS — the reference loads Spectral + IBM Plex from Google Fonts, and so does this shell (the
 * same @import). When the rendering host is offline the stacks degrade to the reference's own
 * declared fallbacks (Georgia / system-ui / platform mono) instead of failing the render.
 *
 * PRINT — the reference shows these cards as small gallery previews (~10.5px base). Printed
 * unscaled on A4 that leaves the card floating small on a mostly-empty page, so the print rules
 * at the bottom of the CSS scale the card up uniformly (CSS zoom keeps every proportion of the
 * reference intact) and stretch the card's frame to the full printable height, with the footer
 * pinned to the bottom edge — the card IS the page, exactly like a real bill.
 */
import { htmlEscape } from "../../../lib/pdf-render-context.js";

export type DocumentFamily = "fiscal" | "commercial" | "informational" | "internal";

const FAMILY_CLASS: Record<DocumentFamily, string> = {
  fiscal: "f",
  commercial: "c",
  informational: "i",
  internal: "n",
};

/** Watermark overlays from the reference (`.doc.void` / `.doc.copyw`). */
export type DocumentWatermark = "void" | "copy" | null;

export const LEGPHEL_DOCUMENT_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
  :root {
    --paper:#FDFDFB; --ink:#14161A; --slate:#5A6068; --mute:#8A8F96;
    --rule:#D9D7D1; --hair:#EAE8E3; --wash:#F2F1ED;
    --crimson:#A81E2D; --bronze:#8A6532; --steel:#3F4A57; --slgrey:#6E7278;
    --brand:#C0242E;
    --serif:'Spectral',Georgia,serif;
    --sans:'IBM Plex Sans',system-ui,sans-serif;
    --mono:'IBM Plex Mono',ui-monospace,monospace;
  }
  * { box-sizing:border-box }
  html, body { margin:0; padding:0; background:var(--paper); color:var(--ink); font-family:var(--sans) }
  /* The reference renders these cards in a gallery; on paper one card fills the page. */
  .sheet { padding:14mm 13mm }
  .doc { border:1px solid var(--rule);background:#fff;padding:16px 18px;font-size:10.5px;
    box-shadow:4px 4px 0 var(--rule) }
  .doc.f { border-top:3px solid var(--crimson) }
  .doc.c { border-top:3px solid var(--bronze) }
  .doc.i { border-top:3px solid var(--steel) }
  .doc.n { border:1.5px dashed var(--slgrey);box-shadow:none }
  .dmast { text-align:center;padding-bottom:9px;border-bottom:2px solid var(--brand);margin-bottom:9px }
  .doc.n .dmast { border-bottom-color:var(--slgrey) }
  .dlogo { width:30px;height:30px;border:1.5px solid var(--brand);border-radius:50%;
    display:inline-flex;align-items:center;justify-content:center;
    font-family:var(--serif);font-weight:700;font-size:12px;color:var(--brand);margin-bottom:4px }
  .dlogo img { width:100%;height:100%;object-fit:contain;border-radius:50% }
  .dname { font-family:var(--serif);font-size:14.5px;font-weight:700;letter-spacing:.12em;margin:0 }
  .daddr { font-size:8px;color:var(--slate);margin:3px 0 0;line-height:1.55 }
  .daddr b { font-family:var(--mono);font-size:8px;color:var(--ink);font-weight:500 }
  .dtitle { text-align:center;margin:8px 0 }
  .dtitle h5 { display:inline-block;font-size:9.5px;font-weight:600;letter-spacing:.2em;
    text-transform:uppercase;margin:0;padding-bottom:3px;border-bottom:1.2px solid var(--ink) }
  .doc.f .dtitle h5 { color:var(--crimson);border-color:var(--crimson) }
  .doc.c .dtitle h5 { color:var(--bronze);border-color:var(--bronze) }
  .doc.i .dtitle h5 { color:var(--steel);border-color:var(--steel) }
  .doc.n .dtitle h5 { color:var(--slgrey);border-color:var(--slgrey) }
  .dtitle .strip { display:block;font-size:7.5px;letter-spacing:.09em;text-transform:uppercase;
    color:var(--crimson);font-weight:600;margin-top:3px }
  .dtitle .strip.mut { color:var(--slgrey) }
  .dl { display:flex;justify-content:space-between;gap:10px;padding:2px 0;color:#2E3238;font-size:9.5px }
  .dl .k { color:var(--slate) }
  .dl .k b { color:var(--ink);font-weight:600 }
  .dl .v { font-family:var(--mono);font-size:9px;text-align:right;white-space:nowrap }
  .dl .v.b { font-weight:600 }
  .dl .v.red { color:var(--crimson);font-weight:600 }
  .dl.tot { border-top:1px solid var(--ink);margin-top:3px;padding-top:4px }
  .dl.tot .k { font-size:7.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:var(--ink) }
  .dl.tot .v { font-weight:700;font-size:10.5px;color:var(--brand) }
  .dsec { border-top:1px solid var(--hair);margin-top:7px;padding-top:6px }
  table.mini { width:100%;border-collapse:collapse;font-size:8.5px;margin:4px 0 }
  table.mini th { font-size:6.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--slate);
    font-weight:600;text-align:left;padding:3px 6px;border-bottom:1px solid var(--ink);background:none }
  table.mini td { padding:3px 6px;border-bottom:1px solid var(--hair);color:#2E3238;line-height:1.4;vertical-align:top }
  table.mini td.r, table.mini th.r { text-align:right;font-family:var(--mono);font-size:8px;white-space:nowrap }
  table.mini tr:last-child td { border-bottom:0 }
  .dnote { margin-top:6px;padding:4px 8px;font-size:8px;line-height:1.55;color:var(--ink);
    border-left:2px solid var(--crimson) }
  .dnote.q { border-left-color:var(--rule);color:var(--slate) }
  .dnote.g { border-left-color:var(--slgrey);color:var(--slate) }
  .dfoot { font-family:var(--mono);font-size:7px;color:var(--mute);margin-top:8px;
    display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap }
  .dbank { display:flex;flex-wrap:wrap;gap:2px 12px;font-size:8px;color:var(--slate);margin-top:5px }
  .dbank b { font-family:var(--mono);font-size:7.5px;color:var(--ink);font-weight:500 }
  .doc.void { position:relative }
  .doc.void::after { content:"VOID";position:absolute;inset:0;display:flex;align-items:center;
    justify-content:center;font-family:var(--serif);font-size:46px;font-weight:700;
    color:rgba(168,30,45,.13);letter-spacing:.22em;pointer-events:none }
  .doc.copyw { position:relative }
  .doc.copyw::after { content:"COPY";position:absolute;inset:0;display:flex;align-items:center;
    justify-content:center;font-family:var(--serif);font-size:46px;font-weight:700;
    color:rgba(63,74,87,.13);letter-spacing:.22em;pointer-events:none }

  /* ---- Print: the card fills the A4 page ------------------------------------------------
     renderHtmlToPdf already applies 12/14mm page margins, so the screen-preview .sheet padding
     is dropped and the whole layout is scaled up uniformly (zoom keeps the reference's exact
     proportions). The mm values are in POST-zoom units: printable area is ~186×271mm, so
     min-height is 271/1.25 ≈ 216mm in layout coordinates. The card frame stretches to the full
     page and .dfoot rides the bottom edge via margin-top:auto. The drop shadow is a gallery
     affordance, not part of the bill, so it goes. */
  @media print {
    body { zoom: 1.25 }
    .sheet { padding: 0 }
    .doc { display:flex; flex-direction:column; min-height:215mm; box-shadow:none }
    .dfoot { margin-top:auto; padding-top:8px }
  }
`;

/** The masthead — logo disc, name, address + TPN line. Matches `.dmast` in the reference. */
export type DocumentMasthead = {
  hotelName: string;
  /** One line: "3 Kilo, Phuentsholing, Chukha, Bhutan · +975 17 772 393" */
  addressLine: string;
  /** The bolded mono line under it: "TPN LAC00091 · GST TPN C10082014" */
  taxLine: string | null;
  /** Optional real logo; falls back to the reference's "ལེ" glyph disc. */
  logoDataUri?: string | null;
};

export function renderMasthead(m: DocumentMasthead): string {
  const logo = m.logoDataUri
    ? `<div class="dlogo"><img src="${m.logoDataUri}" alt="" /></div>`
    : `<div class="dlogo">ལེ</div>`;
  return `<div class="dmast">${logo}<div class="dname">${htmlEscape(m.hotelName)}</div>
        <p class="daddr">${htmlEscape(m.addressLine)}${m.taxLine ? `<br><b>${htmlEscape(m.taxLine)}</b>` : ""}</p></div>`;
}

/**
 * Build the masthead from the stored HotelProfile so every document in the family reads the same.
 *
 * The reference's address line is "<address> · <phone>" and its tax line is
 * "TPN <tpn> · GST TPN <gstTpn>". Missing parts are dropped rather than rendered as empty
 * separators, and the tax line becomes null when the profile carries neither number — the
 * masthead then matches the reference minus that row instead of printing a bare "TPN".
 */
export function mastheadFromHotelProfile(hotel: {
  hotelName: string;
  registeredAddress: string;
  tradingAddress: string | null;
  contactNumbers: unknown;
  tpnNumber: string | null;
  gstTpnNumber: string | null;
  logoDataUri: string | null;
}): DocumentMasthead {
  const phone = primaryContactNumber(hotel.contactNumbers);
  const address = hotel.tradingAddress?.trim() || hotel.registeredAddress;
  const addressLine = [address?.trim(), phone].filter((p) => !!p && p !== "").join(" · ");
  const taxParts = [
    hotel.tpnNumber?.trim() ? `TPN ${hotel.tpnNumber.trim()}` : null,
    hotel.gstTpnNumber?.trim() ? `GST TPN ${hotel.gstTpnNumber.trim()}` : null,
  ].filter(Boolean);
  return {
    hotelName: hotel.hotelName,
    addressLine,
    taxLine: taxParts.length > 0 ? taxParts.join(" · ") : null,
    // Deliberately NOT the HotelProfile PNG: the house format's mark is the "ལེ" glyph disc
    // (operator ruling 2026-07-30 — "keep it like in the html, same to same"). The shell still
    // supports an image for any future document that opts in explicitly.
    logoDataUri: null,
  };
}

/** `HotelProfile.contactNumbers` is loose JSON — pull a usable primary without assuming a shape. */
export function primaryContactNumber(contactNumbers: unknown): string {
  if (typeof contactNumbers === "string") return contactNumbers.trim();
  if (Array.isArray(contactNumbers)) {
    const first = contactNumbers.find((v) => typeof v === "string" && v.trim() !== "");
    return typeof first === "string" ? first.trim() : "";
  }
  if (contactNumbers && typeof contactNumbers === "object") {
    const o = contactNumbers as Record<string, unknown>;
    for (const k of ["primary", "phone", "mobile", "reception", "secondary"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    const anyStr = Object.values(o).find((v) => typeof v === "string" && v.trim() !== "");
    return typeof anyStr === "string" ? anyStr.trim() : "";
  }
  return "";
}

/** Centred document title + the uppercase strip beneath it. `mutedStrip` uses `.strip.mut`. */
export function renderTitle(title: string, strip: string | null, mutedStrip = false): string {
  return `<div class="dtitle"><h5>${htmlEscape(title)}</h5>${
    strip ? `<span class="strip${mutedStrip ? " mut" : ""}">${htmlEscape(strip)}</span>` : ""
  }</div>`;
}

export type RowOpts = {
  /** Bold the key (renders `<b>` inside `.k`, as the reference does for emphasised labels). */
  boldKey?: boolean;
  /** `.v.b` — bold mono value. */
  boldValue?: boolean;
  /** `.v.red` — crimson value, used for booking refs and deadlines. */
  redValue?: boolean;
  /** `.dl.tot` — the ruled grand-total row. */
  total?: boolean;
  /** Pass pre-escaped HTML as the key (for the reference's inline `<i>` annotations). */
  rawKey?: boolean;
};

/** One `.dl` key/value row. */
export function row(key: string, value: string | null, opts: RowOpts = {}): string {
  const vClass = ["v", opts.boldValue ? "b" : "", opts.redValue ? "red" : ""].filter(Boolean).join(" ");
  const k = opts.rawKey ? key : htmlEscape(key);
  const inner = opts.boldKey ? `<b>${k}</b>` : k;
  return `<div class="dl${opts.total ? " tot" : ""}"><span class="k">${inner}</span><span class="${vClass}">${
    value == null ? "" : htmlEscape(value)
  }</span></div>`;
}

/** `.dsec` — the hairline section divider. */
export const section = `<div class="dsec"></div>`;

/** `.dnote` — the note block. `tone: "quiet"` is the reference's `.dnote.q`. */
export function note(text: string, tone: "loud" | "quiet" | "grey" = "quiet"): string {
  const cls = tone === "quiet" ? "dnote q" : tone === "grey" ? "dnote g" : "dnote";
  return `<div class="${cls}">${htmlEscape(text)}</div>`;
}

/** `.dbank` — the payment-details strip on the proforma. */
export function bankStrip(pairs: Array<{ label: string; value: string }>): string {
  if (pairs.length === 0) return "";
  return `<div class="dbank">${pairs
    .map((p) => `<span>${htmlEscape(p.label)} <b>${htmlEscape(p.value)}</b></span>`)
    .join("")}</div>`;
}

/** `table.mini` — the compact line-item table. `align: "r"` puts a column in right-aligned mono. */
export type MiniColumn = { header: string; align?: "l" | "r" };

export function miniTable(columns: MiniColumn[], rows: Array<Array<string | null>>): string {
  const head = columns
    .map((c) => `<th${c.align === "r" ? ' class="r"' : ""}>${htmlEscape(c.header)}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((cell, i) => `<td${columns[i]?.align === "r" ? ' class="r"' : ""}>${htmlEscape(cell ?? "")}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table class="mini"><tr>${head}</tr>${body}</table>`;
}

/**
 * `.dfoot` — the mono footer. The reference's left slot is
 * "<doc no> · <booking ref> · E&OE · T<tariff version>" and the right is "Page 1 of 1".
 */
export function footer(parts: Array<string | null>, pageLabel = "Page 1 of 1"): string {
  const left = parts.filter((p) => !!p && p.trim() !== "").join(" · ");
  return `<div class="dfoot"><span>${htmlEscape(left)}</span><span>${htmlEscape(pageLabel)}</span></div>`;
}

/**
 * Wrap composed rows into the full printable page. `family` picks the accent border; `watermark`
 * applies the VOID / COPY overlay for reprints and voided issues.
 */
export function renderDocumentPage(input: {
  /** Browser/PDF metadata title. */
  documentTitle: string;
  family: DocumentFamily;
  watermark?: DocumentWatermark;
  /** Already-composed inner HTML (masthead, title, rows, table, note, footer). */
  body: string;
}): string {
  const cls = [
    "doc",
    FAMILY_CLASS[input.family],
    input.watermark === "void" ? "void" : "",
    input.watermark === "copy" ? "copyw" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${htmlEscape(input.documentTitle)}</title>
<style>${LEGPHEL_DOCUMENT_CSS}</style>
</head>
<body>
  <div class="sheet">
    <div class="${cls}">
${input.body}
    </div>
  </div>
</body>
</html>`;
}
