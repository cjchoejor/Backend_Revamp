# S3 acceptance test report (slice)

- Base URL: `http://localhost:4000/api`
- Passed: **2/2**

## Steps

### AC-S3-setup — Progress S2→S3 requires accepted quotation
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: S3 entry requires accepted quotation from S2.
- **Database (PostgreSQL)**: Updates Entry.currentStage to S3.
- **Response (truncated)**: `{"id":"6608a5bf-ff77-4bed-8577-29bd8dc09af7","inquiryId":"453689a7-83c5-4143-bd6b-e114ff33bddd","guestProfileId":"e91a7484-23cb-45f5-b994-aecef95a63a6","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S3","checkInDate":null,"checkOutDate":null,"guestCount":null,"otaSource":false,"otaReference":null,"groupBillingMode":null,"parkedAt":null,"parkedBy":null,"parkedIndividually":false,"createdAt":"2026-04-24T10:24:23.793Z","updatedAt":"2026-04-24T10:24:23.881Z","createdBy":"s3-fd-1","version":3,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":false,"keysIssuedAt":null,"keysIssuedCount":null,"keysIssuedBy":null,"registrationCompletedAt":null,"regi`

### AC-S3-002-ish — Create provisional folio + billing model transition + proforma invoice
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: S3 setup creates/retrieves PROVISIONAL folio, fixes billing model, writes BillingModelTransitionRecord, and issues a PROFORMA invoice.
- **Database (PostgreSQL)**: Creates Folio (if absent), BillingModelTransitionRecord, and Invoice(invoiceType=PROFORMA).
- **Response (truncated)**: `{"id":"f27e1661-fe7e-4c1c-9387-a01792d3e3f9","entryId":"6608a5bf-ff77-4bed-8577-29bd8dc09af7","state":"PROVISIONAL","billingModel":"GUEST_PAY","createdAt":"2026-04-24T10:24:23.893Z","createdBy":"s3-fd-1","convertedToLiveAt":null,"convertedBy":null,"closedAt":null,"closedBy":null,"noShowPenaltyAmount":null,"noShowAdvancePaymentAmount":null,"noShowNetPosition":null,"noShowFomDetermination":null,"outstandingBalance":"0","advancePaymentReconciliationComplete":false,"invoices":[{"id":"86b91426-7474-45f2-a7b5-ee3c4e178be4","folioId":"f27e1661-fe7e-4c1c-9387-a01792d3e3f9","entryId":"6608a5bf-ff77-4bed-8577-29bd8dc09af7","invoiceType":"PROFORMA","state":"DRAFT","invoiceNumber":null,"totalAmount":null,"templateKey":"proforma-v1","issuedAt":"2026-04-24T10:24:23.896Z","issuedBy":"s3-fd-1","dispatched`