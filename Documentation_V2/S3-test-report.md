# S3 acceptance test report (slice)

- Base URL: `http://127.0.0.1:4044/api`
- Passed: **7/7**

## Steps

### AC-S3-setup — Progress S2→S3 requires accepted quotation
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: S3 entry requires accepted quotation from S2.
- **Database (PostgreSQL)**: Updates Entry.currentStage to S3.
- **Response (truncated)**: `{"id":"62a6f0a2-13be-4296-9ed5-7e4d34b8fe74","inquiryId":"dec0c5c0-397c-4f8c-8f6b-bc0db5d26cd8","guestProfileId":"d84954c4-e78f-4623-8e96-c279bbbd94dc","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S3","walkInCompressed":false,"checkInDate":"2026-05-14T11:35:03.452Z","checkOutDate":"2026-05-15T11:35:03.452Z","guestCount":1,"otaSource":false,"otaReference":null,"groupBillingMode":null,"parkedAt":null,"parkedBy":null,"parkedIndividually":false,"createdAt":"2026-05-13T11:35:03.462Z","updatedAt":"2026-05-13T11:35:03.728Z","createdBy":"s3-fd-1","version":3,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":false,"keysIssuedAt":null,"keysIssuedCo`

### AC-S3-002-ish — Create provisional folio + billing model transition + proforma invoice
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: S3 setup creates/retrieves PROVISIONAL folio, fixes billing model, writes BillingModelTransitionRecord, and issues a PROFORMA invoice.
- **Database (PostgreSQL)**: Creates Folio (if absent), BillingModelTransitionRecord, and Invoice(invoiceType=PROFORMA).
- **Response (truncated)**: `{"id":"5da7831b-08ad-45a1-9060-ea62e37c834a","entryId":"62a6f0a2-13be-4296-9ed5-7e4d34b8fe74","state":"PROVISIONAL","billingModel":"GUEST_PAY","createdAt":"2026-05-13T11:35:03.733Z","createdBy":"s3-fd-1","convertedToLiveAt":null,"convertedBy":null,"closedAt":null,"closedBy":null,"noShowPenaltyAmount":null,"noShowAdvancePaymentAmount":null,"noShowNetPosition":null,"noShowFomDetermination":null,"outstandingBalance":"0","advancePaymentReconciliationComplete":false,"invoices":[{"id":"a9e4f48f-bc62-49e3-84aa-b28b5823c47a","folioId":"5da7831b-08ad-45a1-9060-ea62e37c834a","entryId":"62a6f0a2-13be-4296-9ed5-7e4d34b8fe74","invoiceType":"PROFORMA","state":"DRAFT","invoiceNumber":null,"totalAmount":null,"templateKey":"proforma-v1","issuedAt":"2026-05-13T11:35:03.749Z","issuedBy":"s3-fd-1","dispatched`

### AC-S3-003 — Record folio payment at S3 (Policy 27 inbound slice)
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: Advance payment recorded against provisional folio while entry remains at S3.
- **Database (PostgreSQL)**: Inserts PaymentRecord; may schedule advance-payment follow-up timers per config.
- **Response (truncated)**: `{"id":"ed0f5871-89b9-41be-94e5-d21b9d90b511","folioId":"5da7831b-08ad-45a1-9060-ea62e37c834a","invoiceId":null,"entryId":"62a6f0a2-13be-4296-9ed5-7e4d34b8fe74","amount":"100","currency":"BTN","foreignCurrencyAmount":null,"btnEquivalent":null,"exchangeRate":null,"paymentMethod":"CASH","paymentDirection":"IN","createdAt":"2026-05-13T11:35:03.772Z","receivedAt":"2026-05-13T11:35:03.772Z","recordedBy":"s3-fd-1","stage":"S3","notes":"S3 inbound advance slice"}`

### AC-S3-004 — Place committed hold at S3 (disclosure + folio + advance satisfied)
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: Committed hold placement requires cancellation disclosure, folio, and advance/credit gate per hold-service.
- **Database (PostgreSQL)**: Inserts committed_holds; room COMMITTED_HELD; schedules COMMITTED_HOLD_EXPIRY_W3 when configured.
- **Response (truncated)**: `{"id":"52049805-041b-4b6d-b85e-ff59f5efb6c6","entryId":"62a6f0a2-13be-4296-9ed5-7e4d34b8fe74","segmentId":"aeb8c7ca-2a2e-4952-a572-1e3eb5c9c94c","roomId":"2d76523d-cfe4-4933-bf08-042f00fe6b18","spaceId":null,"roomTypeId":"0279d845-2bd2-4f6a-8bf2-74af10e86e1b","state":"PLACED","placedAt":"2026-05-13T11:35:03.825Z","placedBy":"s3-fd-1","confirmedAt":null,"confirmedBy":null,"releasedAt":null,"releasedBy":null,"releaseReason":null,"commercialJustification":"SIG-S3 acceptance: committed hold at S3","ttlSeconds":3600,"expiresAt":"2026-05-13T12:35:03.825Z"}`

### AC-S3-005 — GET payment-status reflects folio advance evaluation
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Payment status endpoint exposes evaluateAdvancePaymentCondition for UI / downstream gates.
- **Database (PostgreSQL)**: Read-only evaluation; no row writes.
- **Response (truncated)**: `{"satisfied":true,"totalReceived":100,"requiredAmount":1,"shortfall":0,"creditExtensionActive":false,"ceilingAmount":null}`

### AC-S3-006 — S3→S2 re-entry requires L2+ (L1 blocked)
- **Pass**: YES
- **HTTP**: 403
- **What is happening**: SIG-S3 back-flow is FOM-gated; route may return 403 (middleware) or 409 AUTH_REQUIRED_L2 (policy) depending on wiring.
- **Database (PostgreSQL)**: No transition; no segment seal.
- **Response (truncated)**: `{"error":"AuthorizationError","message":"Insufficient authority"}`

### AC-S3-007 — S3→S2 re-entry succeeds for L2 with renegotiation context
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: FOM initiates S3→S2: segment sealed, new S2 segment, dwell sealed, committed hold retained per state machine.
- **Database (PostgreSQL)**: Seals S3 segment; creates S2 segment; updates Entry.currentStage; trace ENTRY.REENTRY_S3_TO_S2.
- **Response (truncated)**: `{"entry":{"id":"62a6f0a2-13be-4296-9ed5-7e4d34b8fe74","inquiryId":"dec0c5c0-397c-4f8c-8f6b-bc0db5d26cd8","guestProfileId":"d84954c4-e78f-4623-8e96-c279bbbd94dc","segmentNumber":2,"useType":"LEISURE","status":"ACTIVE","currentStage":"S2","walkInCompressed":false,"checkInDate":"2026-05-14T11:35:03.452Z","checkOutDate":"2026-05-15T11:35:03.452Z","guestCount":1,"otaSource":false,"otaReference":null,"groupBillingMode":null,"parkedAt":null,"parkedBy":null,"parkedIndividually":false,"createdAt":"2026-05-13T11:35:03.462Z","updatedAt":"2026-05-13T11:35:03.848Z","createdBy":"s3-fd-1","version":4,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":false,"keysIssuedAt":null,"key`