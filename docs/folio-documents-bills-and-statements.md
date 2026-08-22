# Bills & statements — tentative invoice · master bill · tax invoice (2026-08-22)

Operator ask: *"build Tentative invoice and tax invoice, master invoice (all indicative in S7). Final in S8."*
Source formats: `docs/bills/legphel-document-formats-complete-30 (1).html` (the thirty documents) and
`docs/bills/DFG-001-Developer-Handbook-v0_2.html` (the rules behind them). Where this note and DFG-001
differ, the guideline wins.

## 1. What each name maps to

| Operator's name | Reference document | Character | Face says |
|---|---|---|---|
| **Tentative invoice** | **C5 Interim Folio Statement** | Informational (steel) | "Position to date — not a bill for settlement" |
| **Master invoice** | **C1 Master Bill** — the rollup | Informational (steel) | "Statement — not a tax invoice" |
| **Tax invoice** | **B1 Tax Invoice — Final** | Fiscal (crimson) | "Tax Invoice"; a DRAFT watermark + "not issued" strip until issued |

The "tentative invoice" is titled *Interim Folio Statement* on its face, not "invoice": DFG-001 reserves the
word *invoice* for documents that demand money (PI, TI, the interim-payment invoice); a statement that is
"not a bill for settlement" must not invite treatment as one (r.264(4) / s.265(6) exposure). The desk row is
still labelled **Tentative invoice** so the operator finds it.

## 2. Where and when — and the reason for each

DFG-001 §G1 gives three gates, and they decide everything:

```
Folio LIVE ──────────────► Gate 1: folio seal ──────────► Gate 2: fiscal issue
(S7, S8 before money)      (settlement → SETTLED /        (FINAL Invoice row minted,
                            OUTSTANDING, closedAt)          issueInvoiceAtS8 / S9)
 views regenerate on        Master Bill content             Tax invoice immutable;
 demand; nothing exists     freezes; prints are             served only from its
 to contradict them         REPRINTS with an ordinal        write-once PDF
```

### S7 — Stay step · block **"Bills & statements"**, directly under the Live folio
All three are **views of the live folio** (the block sits under it for that reason). Nothing is numbered,
nothing is stored; every render is a snapshot "as at" now.

- **Tentative invoice** — the guest's mid-stay handout. Job: prevent checkout surprise (§10A.7). Charges to
  date by component, money received, the position. Any number may issue during a stay.
- **Master bill (indicative)** — the rollup by component + ladder + settlement position, the same document
  that is signed at check-out, rendered "as at printing" with the strip *"indicative, charges still posting"*.
  In-stay it carries no signature row (nothing is acknowledged yet — unused zones collapse).
- **Tax invoice (draft)** — the fiscal document exactly as it would issue now: DRAFT watermark, **no serial**
  ("Allocated at issue"), loud strip *"Draft — not issued · indicative position as at …"*. The handbook's
  lifecycle sanctions exactly this render ("DRAFT renders a watermark and no serial"). Its job is to let the
  desk check the billed-to party, TPN / your-ref, descriptions and the GST ladder **before** the one original
  is issued — "catch errors at the desk, not at audit". It is **not a handout**; the block says so.

### S8 — Check-out step · block **"Bills for check-out"**, after "The bill", before Settlement
- Before money is taken (folio still LIVE): **Master bill** — printed for the guest's signature (signature row
  present; "raise queries before settlement"), and the **Tax invoice draft** for a last check of the
  particulars. The tentative invoice retires — its job ended with the stay (the index says why).
- After settlement (Gate 1): **Master bill — frozen** ("Content frozen at folio seal · <time>"); each print is a
  Class-3 reprint carrying `reprint N` in the footline. **Tax invoice** — the **Issue tax invoice** button
  (→ the existing FINAL Invoice row via `issueInvoiceAtS8`), then **Send to guest** (dispatch), then View/PDF of
  the stored original. The issue/dispatch controls moved here from the Settlement block.

### S9 — Closed step · block **"Bills & statements"** (read-only)
Reprints of the frozen Master Bill and the issued tax invoice; the Closed step's own invoice controls stay
where they were.

## 3. One ledger view, three documents

`back_end/src/lib/folio-ledger-view.ts` — `buildFolioLedgerView()` — is the single pure reading of a folio:
charges vs SC/GST companions (the one-home convention in `folio-tax-lines.ts`), the **component** of every line
(Room · Food & beverage · Services & other; a companion follows the charge it rides on, matched exactly as the
desk's folio fold matches it — same room, same date, the base description it names, nearest posting), the
**ladder** additive from the ledger's own lines (net → service → taxable → GST → total), and the legacy
read-time tax for room nights audited before 2026-08-18. `buildFinalInvoiceFigures` (the verified S8/S9 money
builder, also behind the FINAL-invoice email) now delegates to it — its nine original output fields were
regression-checked **identical across 180 live invoice/folio cases** before and after — and gained
`components`, `ladder` and `payments`. The Master Bill, the Interim Folio Statement and the tax invoice (draft
and issued) all print from that one result, so "the rollup governs on any divergence" has no divergence.

## 4. Code map

| Piece | Where |
|---|---|
| Ledger view (pure) | `back_end/src/lib/folio-ledger-view.ts`; helpers `companionBaseDescription` / `isCorrectionCompanionDescription` / `CORRECTION_LINE_PREFIX` in `lib/folio-tax-lines.ts` |
| B1 Tax Invoice template | `services/infrastructure/pdf-templates/legphel-tax-invoice-template.ts` |
| C1 Master Bill + C5 Interim Folio Statement templates | `services/infrastructure/pdf-templates/legphel-folio-statement-templates.ts` |
| Shell additions | `legphel-document-shell.ts`: DRAFT watermark, `.dsub` sub-heading, `.sig` signature row (both verbatim from the reference CSS); `legphel-document-format.ts`: `HOTEL_TIMEZONE`, `formatDocDateTimeLocal`, `localYmd` |
| Tax-invoice composition (draft + issued) | `services/domain/invoice-pdf-service.ts`: `composeTaxInvoiceHtml`, `taxInvoicePartiesFromEntry`, the FINAL branch of `generateOrLoadInvoicePdf` (now B1; storage kind `tax-invoice`) |
| The three statements + the index | `services/domain/folio-statement-service.ts` |
| Routes | `routes/documents/router.ts`: `GET /api/entries/:id/folio-documents` (index), `…/folio-documents/:kind/preview-html`, `…/folio-documents/:kind/pdf` — kinds `interim-statement` · `master-bill` · `tax-invoice`; L1+ |
| Desk | `front_end/src/components/desk/workspace/folio-documents.tsx` (`FolioDocumentsBlock`, `stage` S7/S8/S9), `FolioDocumentPreview` + `IssuedInvoicePreview` in `quotation-preview.tsx`, client fns in `lib/api/documents.ts`; mounted on `stay-step.tsx`, `checkout-step.tsx`, `closed-step.tsx` |

The index is what the desk (and the production frontend) renders — `available`, `state`
(`SNAPSHOT · INDICATIVE · FROZEN · DRAFT · ISSUED · NONE`), `unavailableReason`, `purpose`, `reprintCount`,
`frozenAt`, and the issued `invoice` — nothing about availability is derived client-side. PDFs of the three
statements are rendered fresh and **never stored** (a snapshot's identity is its as-at); the only side effect
is the sealed Master Bill's print, which writes a `FOLIO.MASTER_BILL_PRINTED` trace — the ordinal is counted
from those. The draft route answers **409 `TAX_INVOICE_ISSUED`** (with `invoiceId`) once a FINAL invoice
exists: a fiscal document is never recomposed from a ledger that can still take post-stay charges.

## 5. Verified live (2026-08-22)

- ENT-20260812-0001 (S7, 45 lines, 7 rooms): all three render; total 72,050.66 = `billedSoFar`; position =
  `outstandingBalance`; ladder Net 62,381.50 · Service 6,238.15 · GST 3,431.01 reconciles to the billing
  summary's `chargeBreakdown`; PDFs render with fit-to-page.
- ENT-20260821-0001 (S7, paid ahead of its extension nights): the draft prints "Paid ahead of charges still to
  post" rather than "Refund due".
- ENT-20260814-0001 (S9, OUTSTANDING, sealed 17 Aug 21:07): interim statement refused (400) with the reason;
  Master Bill FROZEN, two prints → `reprintCount` 0 → 2, each receipt listed (PMT-…), balance 12,242.00;
  tax-invoice draft 409 naming INV-20260817-0001; the desk's S9 block shows "Frozen at settlement · 2 prints"
  + the issued invoice from its stored PDF.
- Desk by Puppeteer as FOM: S7 block with the three rows and inline View; S9 block sealed/issued rows.
- Backend + frontend `tsc` clean (the repo has no ESLint config, so no lint pass was possible).

## 6. Deliberately not built (say so before anyone assumes otherwise)

- **Series numbers + issuance register** for the statements (LH/MB, LH/IF) and the fiscal serial (LH/TI) —
  handbook §08/§12 (row-locked allocator, `DocumentIssuanceRecord`, VOID/CANCELLED/SUPERSEDED dispositions).
  Statements print the booking ref + as-at as their identity; the tax invoice keeps its `INV-…` readable id.
- **Issue-time validation gates** (supplier TPN, customer TPN for registered payers, identity ref above
  Nu. 50,000, blank-label test) — the particulars print; nothing blocks issue yet.
- **COPY watermark on reprints of the issued tax invoice** (r.188) — the stored PDF is served byte-for-byte;
  watermarking needs a second render path.
- **Per-payer split tax invoices / component bills** (RB/FB/SB as numbered documents) — the Master Bill's
  rollup is by component; split billing itself stays orphaned (CLAUDE.md open item 1).
- **Adjustment notes** (B3) for post-issue corrections.
- The FINAL-invoice **email** body still prints the ROOM-INVOICE-era figure table (same figures, old wording).
- Stored PDFs of invoices issued before 2026-08-22 keep the old "ROOM INVOICE" layout — write-once.
