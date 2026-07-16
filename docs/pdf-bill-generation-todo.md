# PDF bill generation — build plan and open questions

Started **2026-07-14**. Boss's ask: generate the actual bills at each stage in the exact format the hotel has been using, replacing the current stub `document-generation-service.ts` which returns fake string references.

## Reference materials

Four sample PDFs plus one email screenshot in [images/](../images/):

| Stage | Reference file | Purpose |
|---|---|---|
| S2 | `quotation.pdf` | Quotation layout (empty table body — data rows use Proforma structure) |
| S3 | `Proforma_Invoice.pdf` | Proforma invoice layout with data rows |
| S4 | `Reservation_Confirmation_for email.pdf` | Confirmation voucher (attached to email); email body itself in `email_template.png` |
| S8 | `Commercial invoice.pdf` | Room-only settlement invoice with subtotal / service / GST / total breakdown |

Logo files: `legphel_logo without background.png`, `legphel logo with background.jpg`.

## Confirmed answers from the boss (2026-07-14)

1. **Meal plan codes**: `CP` = Continental Plan, `EP` = European Plan, `MAPL` = Modified American Plan with Lunch, `MAPD` = Modified American Plan with Dinner, `AP` = American Plan, plus `OTHERS`. Format `"2 CP"` = 2 guests on CP (count-of-guests + code).
2. **"Prepared by:"** on Commercial Invoice pulls the logged-in staff's `fullName` from the session actor.
3. **Service Charge % + GST %** are pulled from admin console configs (`billing.serviceChargeRate`, `billing.salesTaxRate` — already seeded).
4. **No rounding** — keep 2 decimals as-is (3,400.02 stays 3,400.02; no round-to-whole-Nu).
5. **"Confirmation by:"** on the voucher = travel agent name (blank / "Walk-In" if no agent). **"To:"** = guest full name. **"Guest Name:"** = contact person's name (not the primary guest — different field).
6. **Build order** = infrastructure first, then all four documents on top.

## Two rate conventions in play

- **Quotation / Proforma** — the row `Amount (Nu.)` is tax-INCLUSIVE. Guest-facing summary.
- **Commercial Invoice** — the `Rate (Nu.)` is tax-EXCLUSIVE, with Subtotal / Service Charge / GST as separate lines.

Both need to be supported. The `rateIsTaxInclusive` flag on RateCard (see friend's #6) drives the back-solve when an agent's negotiated rate is all-in.

## Discuss later — held items

### #1 · Re Check-In / Re Check-Out fields on the Confirmation Voucher
The reference voucher shows a two-row booking table with `Check-In 26-06-2026 / Check-Out 27-06-2026` and `Re Check-In 04-07-2026 / Re Check-Out 05-07-2026`. Boss said we'll discuss this later.

**Related to**: double entry / multi entry. This appears to be a multi-segment booking where the same guest checks in twice within the same reservation (e.g. arrives, leaves for a side trip, returns). Currently the PMS uses `Segment` records for re-entry via backflow, and separately supports multi-room per-night selection — neither is quite the same as "same guest, same booking, two non-contiguous stay windows on the voucher header". Needs a design conversation.

**Open questions when we revisit**:
- Is this always exactly two check-in windows, or could it be N?
- Should the voucher show ALL windows, or just the next two?
- Where does the schema store the second window? On `Entry`, on a new `EntryLeg` model, or on `Reservation`?
- Does each leg have its own room number / meal plan?
- The booking-details table already shows one row per date — is that keyed to leg, to segment, or just to per-night selection?

Deferred to a follow-up design pass. For the initial voucher build, we'll render only the primary Check-In / Check-Out and leave the Re Check-In / Re Check-Out rows blank (or hidden) — we can fill them in once the data model is agreed.

## Build plan — phase list

### Status snapshot (2026-07-14)

- ✅ Phase 1 — Infrastructure (Puppeteer, storage, immutability, render service)
- ✅ Phase 2 — S2 Quotation PDF (rendered, attached to email, download route live)
- ✅ Phase 3 — S3 Proforma Invoice PDF (same template, title swap; wired into `dispatchInvoice` PROFORMA branch)
- ✅ Phase 4 — S4 Confirmation Voucher PDF + email body matches `email_template.png` (attached to email)
- ✅ Phase 5 — S8/S9 Room Invoice PDF (room-only lines, tax breakdown, "Prepared by:" from session)
- ⚠️ Quotation.id + Invoice.id + Reservation.confirmationVoucher* use readable IDs / write-once — done during Phase 2/3
- ⏸ Phase 1.6 — monthly integrity verification worker (schema table `InvoiceIntegrityCheck` exists; cron not yet wired)
- ⏸ HotelProfile admin UI form for `accountNumber` / `tpnNumber` / `gstTpnNumber` / `logoStorageKey` (columns exist; edit page not yet built)
- ⏸ Pricing-engine consumer for `RateCard.rateIsTaxInclusive` (column exists; back-solve on read not yet wired)

### Phase 1 · Infrastructure (foundation — everything downstream depends on this)

**1.1 · Install PDF engine + storage libs**
- [ ] Install `puppeteer` (headless Chromium — needed for HTML/CSS → PDF that matches the visual references)
- [ ] Install `@types/node` update if needed for stream/buffer types

**1.2 · Storage layer**
- [ ] Create [`back_end/src/lib/document-storage.ts`](../back_end/src/lib/document-storage.ts) with a small abstract interface: `writeDocument(key, bytes)`, `readDocument(key)`, `existsDocument(key)`. Local-disk implementation for dev, S3-shape ready for prod swap.
- [ ] Dev files land under `storage/documents/YYYY/MM/<KIND>-<READABLE_ID>.pdf`.
- [ ] Add `STORAGE_ROOT_DIR` env var (default `./storage`).

**1.3 · Schema changes (single migration)**
- [ ] `Invoice` add: `pdfStorageKey String?`, `pdfChecksum String?`, `pdfChecksumAlgo String @default("SHA-256")`, `pdfRenderedAt DateTime?`, `pdfRenderedBy String?`, `renderInputSnapshot Json?`.
- [ ] `Quotation` add same six fields (the quotation PDF is also a persisted artifact).
- [ ] New `InvoiceLine` table: `(id, invoiceId, lineNumber, particular, roomNo?, nights?, rate, amount, discountAmount, serviceChargeAmount, gstAmount, currency, folioLineId?, createdAt)`. Snapshot of what's on the bill.
- [ ] New `QuotationLine` table: `(id, quotationId, lineNumber, date, occupants, mealPlan, extraBeds, amount, currency, createdAt)`. Snapshot for quotation/proforma rows.
- [ ] `HotelProfile` add: `accountNumber String?`, `tpnNumber String?`, `gstTpnNumber String?`, `logoStorageKey String?`. Also admin edit fields.
- [ ] `Reservation` add: `confirmationVoucherStorageKey String?`, `confirmationVoucherChecksum String?`, `confirmationVoucherRenderedAt DateTime?`.
- [ ] `RateCard` add: `rateIsTaxInclusive Boolean @default(false)` — the friend's #6 concern. Back-solve the base rate when true.

**1.4 · Invoice / Quotation immutability policy**
- [ ] [`back_end/src/policies/28-invoice-integrity/p68-invoice-immutability.ts`](../back_end/src/policies/28-invoice-integrity/p68-invoice-immutability.ts) — throws on any update to an issued invoice's row except `dispatchedAt` / `dispatchedBy` / `dispatchedTo` / `supersededById`.
- [ ] Wrapper `updateIssuedInvoice(tx, id, allowedFields)` used by dispatch code.

**1.5 · Render pipeline scaffolding**
- [ ] [`back_end/src/services/infrastructure/pdf-render-service.ts`](../back_end/src/services/infrastructure/pdf-render-service.ts) — wraps Puppeteer, handles browser lifecycle, exposes `renderHtmlToPdf(html: string) -> Buffer`.
- [ ] Templates directory: `back_end/src/services/infrastructure/pdf-templates/` with one file per document (shared header/footer partials).
- [ ] `getHotelProfileForRender(prisma)` — reads active HotelProfile including new tax/logo fields.
- [ ] `getStaffPreparedByName(prisma, actorId)` — helper for "Prepared by:" field.

**1.6 · Integrity verification**
- [ ] `POST /api/admin/invoices/:id/verify-integrity` — recomputes SHA-256 of stored PDF, compares to recorded checksum.
- [ ] `InvoiceIntegrityCheck` table (append-only, cron writes).
- [ ] Monthly worker W-INTEGRITY that iterates all issued invoices and reports.

### Phase 2 · Quotation PDF (S2)

- [ ] Template `pdf-templates/quotation.html` matching `images/quotation.pdf` — LEGPHEL header, red hairline, "QUOTATION" title, To/From + Invoice No/Date blocks, In/Out summary box, BOOKING DETAILS table with columns Date | Occupants | Meal Plan | Extra Beds | Amount (Nu.), right-aligned totals (Total Amount / Advance / FOC / Total Payable), italic footer.
- [ ] Amount per row is **tax-inclusive**. Total Amount = sum of row amounts.
- [ ] `renderQuotationPdf(quotationId)` gathers snapshot, writes QuotationLines, calls Puppeteer, stores PDF, writes checksum + trace `QUOTATION.PDF_GENERATED`.
- [ ] Wire into `sendQuotation` — generate BEFORE email dispatch so the PDF can be attached.
- [ ] Update `renderQuotationEmail` (or use a new attachment helper) to attach the stored PDF via Nodemailer's `attachments` array.
- [ ] `GET /api/quotations/:id/pdf` — streams the stored file.

### Phase 3 · Proforma Invoice PDF (S3)

- [ ] Template `pdf-templates/proforma-invoice.html` — REUSE quotation.html with a different `title` ("PROFORMA INVOICE") and data rows populated (matches `images/Proforma_Invoice.pdf`).
- [ ] Actually — implement as ONE template file with a `documentTitle` prop; both S2 and S3 render through it.
- [ ] `renderProformaInvoicePdf(invoiceId)` writes InvoiceLines snapshot, renders, stores, hooks into `dispatchInvoice` for `InvoiceType.PROFORMA`.
- [ ] Attach to `PROFORMA_INVOICE_EMAIL`.
- [ ] `GET /api/invoices/:id/pdf`.

### Phase 4 · Confirmation Voucher PDF (S4)

- [ ] Template `pdf-templates/confirmation-voucher.html` — bigger doc matching `images/Reservation_Confirmation_for email.pdf`. Two-column upper block (In/Out with Re-Check In/Out placeholders on left, Hotel Information on right), booking details table Date | Room No. | Occupants | Meal Plan | Extra Beds, "Please Note" strip, "OUR AMENITIES" (6 icons + text), "HOTEL POLICIES" (Cancellation red / Extra Guest green / Pet blue / Child Age purple), Reservation and Front Office address block, "WALK THE EXTRA MILE!" footer.
- [ ] Re Check-In / Re Check-Out — see "Discuss later #1". Leave blank / hidden for now.
- [ ] Amenities icons: use inline SVG (WiFi, car, cutlery, headset, laundry, presentation) — Lucide icon SVGs work.
- [ ] Policy text — pulled from admin-editable ConfigurationEntry keys? Or hardcoded for now? Check what exists; if not, seed defaults + expose in `/admin/policies` or new `/admin/hotel-policies` page.
- [ ] `renderConfirmationVoucherPdf(reservationId)` — writes storage key + checksum onto `Reservation`.
- [ ] Wire into `confirmReservation` post-tx.
- [ ] Update `RESERVATION_CONFIRMATION_EMAIL` template to match `images/email_template.png` layout AND attach the voucher PDF via Nodemailer `attachments`.
- [ ] `GET /api/reservations/:id/confirmation-voucher-pdf`.

### Phase 5 · Commercial Room Invoice PDF (S8)

- [ ] Template `pdf-templates/room-invoice.html` matching `images/Commercial invoice.pdf` — centered logo + hotel address block (5 lines: hotel name / place / contact / Account No / TPN & GST TPN), "ROOM INVOICE" title in blue, Date top-right, left column (Invoice No / Travel Agent / Guest Name / Contact No / Email), right column (Total No. of Guests / Check In / Check Out), table with columns PARTICULAR | ROOM NO. | NIGHT(S) | RATE (NU.) | AMOUNT (NU.), right-aligned totals block (Subtotal / Discount % / Service Charge 10% / G.S.T 5% / Total / Advance / FoC / **Total Payable** in blue). Signature block at bottom, "Thank you" tagline. No QR (per instruction).
- [ ] "Prepared by:" pulls session actor's `fullName`.
- [ ] **Room lines only** — filter folio lines by lineType so F&B / SERVICE (non-room) / OTHER are excluded from the PARTICULAR table. Service Charge / GST show as computed totals not folio lines.
- [ ] Rate is base (tax-exclusive). Amount = Rate × Nights. Service Charge / GST computed from configs.
- [ ] Attach to `FINAL_INVOICE_EMAIL`.
- [ ] `GET /api/invoices/:id/pdf` (same route as Phase 3 — dispatches per InvoiceType).

## Cross-cutting build tasks

- [ ] **HotelProfile admin UI updates** — add the 4 new fields (accountNumber, tpnNumber, gstTpnNumber, logoStorageKey) to `/admin/hotel-profile`. Logo upload endpoint.
- [ ] **RateCard admin UI** — add `rateIsTaxInclusive` checkbox to the rate-card editor.
- [ ] **Pricing engine wiring** — when rate card has `rateIsTaxInclusive=true`, back-solve base rate before feeding into pipeline: `base = allInRate / (1 + svcRate + svcRate*gstRate + gstRate)`.
- [ ] **Meal plan codes seed** — where's the source of truth? Add enum or ConfigurationEntry.
- [ ] **CLAUDE.md updates** — new PDF infrastructure section, storage location, admin/hotel-profile field changes.

## Verification checklist (before shipping each phase)

- [ ] Rendered PDF matches the reference visually (side-by-side check).
- [ ] Rendered PDF matches the reference numerically (rates, totals, tax breakdown).
- [ ] Stored file path + checksum recorded on the entity row.
- [ ] Verification endpoint round-trips (upload → checksum → verify → OK).
- [ ] Immutability policy blocks direct edits.
- [ ] Email attachment lands in guest inbox.
- [ ] Reprint from admin page returns the SAME stored file (not re-rendered).
- [ ] Supersede flow: correction produces new invoice, prior stays queryable.
