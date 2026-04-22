# S9 acceptance test report

- Base URL: `http://localhost:4000/api`
- Passed: **16/16**

## Results

| ID | Title | Request | Expected | Actual | Pass |
|---|---|---|---:|---:|---|
| S9-setup-get-entry | Get entry snapshot (ids for folio/invoices/handoffs) | GET /entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a | 200 | 200 | YES |
| S9-setup-night-audit | Run night audit (required for S7→S8 gate) | POST /night-audit/run | 200 | 200 | YES |
| S9-setup-progress-to-s8 | Progress stage to S8 | POST /entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/progress-stage | 200 | 200 | YES |
| S9-setup-key-return | Record key return (S8 prerequisite for S9) | POST /entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/key-return | 200 | 200 | YES |
| S9-setup-inspection | Record room inspection complete (S8 prerequisite for S9) | POST /entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/room-inspection | 200 | 200 | YES |
| S9-setup-settle-outstanding | Settle folio to OUTSTANDING via DIRECT_BILL (S8) to create invoice + H5 | POST /folios/3769cc04-915e-47af-b626-dd9d68c2becc/settle | 200 | 200 | YES |
| S9-setup-fulfil-h4 | Fulfil H4 (required for S8→S9) | POST /handoffs/07a0a86c-c086-4398-8322-50542c70edf8/fulfil | 200 | 200 | YES |
| AC-S9-045 | Progress stage to S9 with required version field | POST /entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/progress-stage | 200 | 200 | YES |
| S9-list-invoices | List invoices for folio | GET /folios/3769cc04-915e-47af-b626-dd9d68c2becc/invoices | 200 | 200 | YES |
| AC-S9-010 | Closing blocks when Loop Closure invariant unsatisfied (invoice not dispatched / H5 open / outstanding without W8) | POST /entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/close | 409 | 409 | YES |
| AC-S9-032-1 | Record invoice payment event: DISPATCHED → PAYMENT_TRACKED | POST /invoices/a549de6e-7a9d-43e5-bd5a-691ce94eb533/record-payment-event | 200 | 200 | YES |
| AC-S9-032-2 | Record invoice payment event: PAYMENT_TRACKED → RECONCILED | POST /invoices/a549de6e-7a9d-43e5-bd5a-691ce94eb533/record-payment-event | 200 | 200 | YES |
| AC-S9-039 | Write-off blocks if reason missing | POST /folios/3769cc04-915e-47af-b626-dd9d68c2becc/write-off | 409 | 409 | YES |
| AC-S9-041 | Write-off OUTSTANDING balance (GM authority) transitions folio to WRITTEN_OFF | POST /folios/3769cc04-915e-47af-b626-dd9d68c2becc/write-off | 200 | 200 | YES |
| AC-S9-046-setup | Fulfil H5 residual-obligation handoff | POST /handoffs/44f2e722-96c1-453f-bcd9-1a00c648d928/fulfil | 200 | 200 | YES |
| AC-S9-011 | Close entry at S9 (terminal close) | POST /entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/close | 200 | 200 | YES |

## Step details

### S9-setup-get-entry — Get entry snapshot (ids for folio/invoices/handoffs)

- **What is happening**: We need the folioId and current stage before executing S9 actions.
- **Database (PostgreSQL)**: Read-only (Entry/Folio/Handoff related joins).
- **Request**: `GET http://localhost:4000/api/entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","inquiryId":"f143f930-7db2-4f43-8c44-c577e5ace588","guestProfileId":"d46f6614-73dc-45ef-9495-e4116693e989","segmentNumber":1,"useType":"GROUP","status":"ACTIVE","currentStage":"S7","checkInDate":"2026-04-20T09:00:00.000Z","checkOutDate":"2026-04-22T09:00:00.000Z","guestCount":10,"otaSource":false,"createdAt":"2026-04-22T09:43:27.560Z","updatedAt":"2026-04-22T09:43:27.560Z","createdBy":"actor-seed-system","version":1,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy"`

### S9-setup-night-audit — Run night audit (required for S7→S8 gate)

- **What is happening**: S7→S8 progression blocks unless night audit is complete for the last operating date.
- **Database (PostgreSQL)**: Creates NightAuditRecord + FolioLines (room charge) idempotently for the operating date.
- **Request**: `POST http://localhost:4000/api/night-audit/run`
- **Body**: `{"operatingDate":"2026-04-21"}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"fe47160a-f8ae-4bf0-9971-ccc24892a1b7","operatingDate":"2026-04-21T00:00:00.000Z","runStatus":"COMPLETE","entriesProcessedCount":2,"entriesNotProcessed":[],"createdAt":"2026-04-22T09:43:28.849Z","createdBy":"fom-1"}`

### S9-setup-progress-to-s8 — Progress stage to S8

- **What is happening**: Moves entry into S8 so key return, inspection, and settlement can be recorded.
- **Database (PostgreSQL)**: Updates Entry.currentStage to S8 and creates/updates required handoffs/gates.
- **Request**: `POST http://localhost:4000/api/entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/progress-stage`
- **Body**: `{"targetStage":"S8","version":1}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","inquiryId":"f143f930-7db2-4f43-8c44-c577e5ace588","guestProfileId":"d46f6614-73dc-45ef-9495-e4116693e989","segmentNumber":1,"useType":"GROUP","status":"ACTIVE","currentStage":"S8","checkInDate":"2026-04-20T09:00:00.000Z","checkOutDate":"2026-04-22T09:00:00.000Z","guestCount":10,"otaSource":false,"createdAt":"2026-04-22T09:43:27.560Z","updatedAt":"2026-04-22T09:43:28.869Z","createdBy":"actor-seed-system","version":2,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy"`

### S9-setup-key-return — Record key return (S8 prerequisite for S9)

- **What is happening**: S8→S9 requires key-return record and reconciliation.
- **Database (PostgreSQL)**: Creates KeyReturnRecord linked to entry/room.
- **Request**: `POST http://localhost:4000/api/entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/key-return`
- **Body**: `{"keyCountReturned":2}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"86e49ca2-59c1-4251-80e1-6185375d8f2d","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","roomId":"ddb4de9c-5579-48df-8be3-75219fb3c0cc","receivedBy":"frontdesk-1","returnedAt":"2026-04-22T09:43:28.882Z","keyCountIssued":2,"keyCountReturned":2,"countReconciled":true,"reconciliationNote":null,"createdAt":"2026-04-22T09:43:28.884Z"}`

### S9-setup-inspection — Record room inspection complete (S8 prerequisite for S9)

- **What is happening**: S8→S9 requires inspection completed or deferred+governed.
- **Database (PostgreSQL)**: Creates RoomInspectionRecord linked to entry/room.
- **Request**: `POST http://localhost:4000/api/entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/room-inspection`
- **Body**: `{"isDeferred":false,"deficientFlagStatus":"NOT_APPLICABLE","damageFound":false,"notes":"ok"}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"5bc7db9f-d536-4bab-858e-af2663267f6f","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","roomId":"ddb4de9c-5579-48df-8be3-75219fb3c0cc","segmentId":"cf8b7e62-d959-46c1-86e3-1bf8dfbd2079","inspectedBy":"frontdesk-1","inspectedAt":"2026-04-22T09:43:28.898Z","isDeferred":false,"deficientFlagStatus":"NOT_APPLICABLE","deficientConditionId":null,"inspectorAssessment":null,"damageFound":false,"damageNotes":null,"createdAt":"2026-04-22T09:43:28.900Z"}`

### S9-setup-settle-outstanding — Settle folio to OUTSTANDING via DIRECT_BILL (S8) to create invoice + H5

- **What is happening**: We want an OUTSTANDING folio at S9 to exercise write-off and invoice payment matching.
- **Database (PostgreSQL)**: Transitions Folio state LIVE→OUTSTANDING, creates Invoice (FINAL) and PaymentRecord as needed, ensures H5 exists.
- **Request**: `POST http://localhost:4000/api/folios/3769cc04-915e-47af-b626-dd9d68c2becc/settle`
- **Body**: `{"settlementMethod":"DIRECT_BILL","billingModelConfirmation":"DIRECT_BILL"}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"3769cc04-915e-47af-b626-dd9d68c2becc","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","state":"OUTSTANDING","billingModel":"DIRECT_BILL","createdAt":"2026-04-22T09:43:27.573Z","createdBy":"actor-seed-system","convertedToLiveAt":"2026-04-22T09:43:27.572Z","convertedBy":"actor-seed-system","closedAt":"2026-04-22T09:43:28.911Z","closedBy":"frontdesk-1","noShowPenaltyAmount":null,"noShowAdvancePaymentAmount":null,"noShowNetPosition":null,"noShowFomDetermination":null,"outstandingBalance":"1700","advancePaymentReconciliationComplete":true}`

### S9-setup-fulfil-h4 — Fulfil H4 (required for S8→S9)

- **What is happening**: S8→S9 progression is blocked until H4 is fulfilled in this slice.
- **Database (PostgreSQL)**: Updates HandoffRecord(H4).state → FULFILLED and writes fulfilmentEvidence.
- **Request**: `POST http://localhost:4000/api/handoffs/07a0a86c-c086-4398-8322-50542c70edf8/fulfil`
- **Body**: `{"fulfilmentEvidence":{"chargesPostedConfirmation":true,"roomInspectionStatus":"COMPLETE","damageAssessmentStatus":"NONE","deficientFlagFinalStatus":"NOT_APPLICABLE"}}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"07a0a86c-c086-4398-8322-50542c70edf8","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","handoffType":"H4","state":"FULFILLED","fromRole":"FRONT_DESK","fromActorId":"actor-seed-system","toRole":"HOUSEKEEPING","toActorId":null,"checklistContent":{"roomNumber":"503","expectedCheckoutDate":"2026-04-22T09:00:00.000Z"},"deficientConditionStatus":null,"fulfilmentEvidence":{"roomInspectionStatus":"COMPLETE","damageAssessmentStatus":"NONE","deficientFlagFinalStatus":"NOT_APPLICABLE","chargesPostedConfirmation":true},"assignedAt":null,"acceptedAt":null,"acceptedBy":null,"fulfilledAt":"2026-04-22T`

### AC-S9-045 — Progress stage to S9 with required version field

- **What is happening**: Moves the entry into S9 so terminal closure can be executed.
- **Database (PostgreSQL)**: Updates Entry.currentStage to S9; ensures H5 exists/auto-fulfilled per S8 logic.
- **Request**: `POST http://localhost:4000/api/entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/progress-stage`
- **Body**: `{"targetStage":"S9","version":2}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","inquiryId":"f143f930-7db2-4f43-8c44-c577e5ace588","guestProfileId":"d46f6614-73dc-45ef-9495-e4116693e989","segmentNumber":1,"useType":"GROUP","status":"ACTIVE","currentStage":"S9","checkInDate":"2026-04-20T09:00:00.000Z","checkOutDate":"2026-04-22T09:00:00.000Z","guestCount":10,"otaSource":false,"createdAt":"2026-04-22T09:43:27.560Z","updatedAt":"2026-04-22T09:43:28.985Z","createdBy":"actor-seed-system","version":3,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy"`

### S9-list-invoices — List invoices for folio

- **What is happening**: S9 needs invoice payment matching, so we retrieve the invoiceId.
- **Database (PostgreSQL)**: Read-only (Invoice table).
- **Request**: `GET http://localhost:4000/api/folios/3769cc04-915e-47af-b626-dd9d68c2becc/invoices`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `[{"id":"a549de6e-7a9d-43e5-bd5a-691ce94eb533","folioId":"3769cc04-915e-47af-b626-dd9d68c2becc","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","invoiceType":"FINAL","state":"DISPATCHED","templateKey":"final-v1","issuedAt":"2026-04-22T09:43:28.908Z","issuedBy":"frontdesk-1","dispatchedAt":"2026-04-22T09:43:28.908Z","dispatchedBy":"frontdesk-1","metadata":{"billingModel":"DIRECT_BILL","settlementMethod":"DIRECT_BILL","outstandingBalance":"1700"},"createdAt":"2026-04-22T09:43:28.910Z"}]`

### AC-S9-010 — Closing blocks when Loop Closure invariant unsatisfied (invoice not dispatched / H5 open / outstanding without W8)

- **What is happening**: S9 closure should fail with StageGateBlockedError until invariants are met.
- **Database (PostgreSQL)**: No writes when blocked.
- **Request**: `POST http://localhost:4000/api/entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/close`
- **Body**: `{}`
- **Expected status**: 409
- **Actual status**: 409
- **Response (truncated)**: `{"error":"StageGateBlockedError","message":"H5 must be fulfilled/closed before entry closure","blockingCondition":"H5_NOT_FULFILLED"}`

### AC-S9-032-1 — Record invoice payment event: DISPATCHED → PAYMENT_TRACKED

- **What is happening**: Matches a received payment against an invoice (S9 payment matching).
- **Database (PostgreSQL)**: Updates Invoice.state to PAYMENT_TRACKED; stores paymentRef in metadata.
- **Request**: `POST http://localhost:4000/api/invoices/a549de6e-7a9d-43e5-bd5a-691ce94eb533/record-payment-event`
- **Body**: `{"nextState":"PAYMENT_TRACKED","paymentRef":"bank-slip-001"}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"a549de6e-7a9d-43e5-bd5a-691ce94eb533","folioId":"3769cc04-915e-47af-b626-dd9d68c2becc","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","invoiceType":"FINAL","state":"PAYMENT_TRACKED","templateKey":"final-v1","issuedAt":"2026-04-22T09:43:28.908Z","issuedBy":"frontdesk-1","dispatchedAt":"2026-04-22T09:43:28.908Z","dispatchedBy":"frontdesk-1","metadata":{"updatedAt":"2026-04-22T09:43:29.008Z","updatedBy":"fom-1","paymentRef":"bank-slip-001","billingModel":"DIRECT_BILL","settlementMethod":"DIRECT_BILL","outstandingBalance":"1700"},"createdAt":"2026-04-22T09:43:28.910Z"}`

### AC-S9-032-2 — Record invoice payment event: PAYMENT_TRACKED → RECONCILED

- **What is happening**: Post-closure accounting action; should not reopen entry.
- **Database (PostgreSQL)**: Updates Invoice.state to RECONCILED; stores reconciliation reference in metadata.
- **Request**: `POST http://localhost:4000/api/invoices/a549de6e-7a9d-43e5-bd5a-691ce94eb533/record-payment-event`
- **Body**: `{"nextState":"RECONCILED","paymentRef":"statement-2026-04-22"}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"a549de6e-7a9d-43e5-bd5a-691ce94eb533","folioId":"3769cc04-915e-47af-b626-dd9d68c2becc","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","invoiceType":"FINAL","state":"RECONCILED","templateKey":"final-v1","issuedAt":"2026-04-22T09:43:28.908Z","issuedBy":"frontdesk-1","dispatchedAt":"2026-04-22T09:43:28.908Z","dispatchedBy":"frontdesk-1","metadata":{"updatedAt":"2026-04-22T09:43:29.014Z","updatedBy":"fom-1","paymentRef":"statement-2026-04-22","billingModel":"DIRECT_BILL","settlementMethod":"DIRECT_BILL","outstandingBalance":"1700"},"createdAt":"2026-04-22T09:43:28.910Z"}`

### AC-S9-039 — Write-off blocks if reason missing

- **What is happening**: Policy requires recorded reason for write-off.
- **Database (PostgreSQL)**: No writes when blocked.
- **Request**: `POST http://localhost:4000/api/folios/3769cc04-915e-47af-b626-dd9d68c2becc/write-off`
- **Body**: `{"amount":100,"reason":""}`
- **Expected status**: 409
- **Actual status**: 409
- **Response (truncated)**: `{"error":"PolicyGateBlockedError","message":"reason is required","blockingCondition":"WRITE_OFF_REASON_REQUIRED"}`

### AC-S9-041 — Write-off OUTSTANDING balance (GM authority) transitions folio to WRITTEN_OFF

- **What is happening**: Creates WriteOffRecord and transitions FolioState OUTSTANDING → WRITTEN_OFF.
- **Database (PostgreSQL)**: Creates WriteOffRecord; updates Folio.state.
- **Request**: `POST http://localhost:4000/api/folios/3769cc04-915e-47af-b626-dd9d68c2becc/write-off`
- **Body**: `{"amount":100,"reason":"uncollectable small balance"}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"8989c0b1-d166-47cc-b991-a5676afd9af3","folioId":"3769cc04-915e-47af-b626-dd9d68c2becc","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","writtenOffAmount":"100","currency":"BTN","reason":"uncollectable small balance","createdAt":"2026-04-22T09:43:29.024Z","createdBy":"gm-1"}`

### AC-S9-046-setup — Fulfil H5 residual-obligation handoff

- **What is happening**: S9 closure requires no open H5 handoff.
- **Database (PostgreSQL)**: Transitions HandoffRecord.state to FULFILLED/CLOSED per service implementation.
- **Request**: `POST http://localhost:4000/api/handoffs/44f2e722-96c1-453f-bcd9-1a00c648d928/fulfil`
- **Body**: `{"fulfilmentEvidence":{"resolutionBasis":"write-off completed"}}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"44f2e722-96c1-453f-bcd9-1a00c648d928","entryId":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","handoffType":"H5","state":"FULFILLED","fromRole":"FRONT_DESK","fromActorId":"frontdesk-1","toRole":"FINANCE","toActorId":null,"checklistContent":{"basis":"Checkout governed outstanding","outstandingBalance":"1700"},"deficientConditionStatus":null,"fulfilmentEvidence":{"resolutionBasis":"write-off completed"},"assignedAt":null,"acceptedAt":null,"acceptedBy":null,"fulfilledAt":"2026-04-22T09:43:29.033Z","fulfilledBy":"fom-1","closedAt":null,"rejectedAt":null,"rejectedBy":null,"rejectionReason":null,"es`

### AC-S9-011 — Close entry at S9 (terminal close)

- **What is happening**: Once loop closure invariant is satisfied, entry transitions to EntryStatus.CLOSED, room claim released, and timers registered.
- **Database (PostgreSQL)**: Updates Entry.status=CLOSED + closedAt; sets Room.currentClaimState=FREE; creates TimerRecord W28 + retention timer; creates FollowUpTaskRecord for conference/group entries.
- **Request**: `POST http://localhost:4000/api/entries/9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a/close`
- **Body**: `{}`
- **Expected status**: 200
- **Actual status**: 200
- **Response (truncated)**: `{"id":"9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a","inquiryId":"f143f930-7db2-4f43-8c44-c577e5ace588","guestProfileId":"d46f6614-73dc-45ef-9495-e4116693e989","segmentNumber":1,"useType":"GROUP","status":"CLOSED","currentStage":"S9","checkInDate":"2026-04-20T09:00:00.000Z","checkOutDate":"2026-04-22T09:00:00.000Z","guestCount":10,"otaSource":false,"createdAt":"2026-04-22T09:43:27.560Z","updatedAt":"2026-04-22T09:43:29.048Z","createdBy":"actor-seed-system","version":4,"closedAt":"2026-04-22T09:43:29.047Z","closedBy":"fom-1","noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCe`