# S2 acceptance test report (slice)

- Base URL: `http://127.0.0.1:4022/api`
- Passed: **6/6**

## Steps

### AC-S2-setup — Entry progressed to S2
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Bring a fresh entry into S2 with preferred configuration selected.
- **Database (PostgreSQL)**: Entry.currentStage updated to S2; preferred AvailabilityConfiguration sealedAt set; TraceEvent written.
- **Response (truncated)**: `{"id":"da55c9ab-ca2f-407a-98b0-6dc1305681cd","inquiryId":"ddc0cdc9-694c-460a-8682-ff81d297b08b","guestProfileId":"86cc2248-dc42-446f-9d11-db729ec5fd1c","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S2","walkInCompressed":false,"checkInDate":"2026-05-14T11:04:33.845Z","checkOutDate":"2026-05-15T11:04:33.846Z","guestCount":1,"otaSource":false,"otaReference":null,"groupBillingMode":null,"parkedAt":null,"parkedBy":null,"parkedIndividually":false,"createdAt":"2026-05-13T11:04:33.856Z","updatedAt":"2026-05-13T11:04:34.042Z","createdBy":"s2-fd-1","version":2,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":false,"keysIssuedAt":null,"keysIssuedCo`

### AC-S2-001 — Create quotation in DRAFT
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: QuotationService.createQuotation creates a DRAFT quotation version for the current segment.
- **Database (PostgreSQL)**: Inserts quotations row (state=DRAFT, versionNumber=1).
- **Response (truncated)**: `{"id":"ec5f2cfe-5357-4c10-ad22-162fd73bb238","entryId":"da55c9ab-ca2f-407a-98b0-6dc1305681cd","segmentId":"07ceb685-370a-4823-98b7-d1e6ad85502d","versionNumber":1,"referenceNumber":"Q-001","state":"DRAFT","commercialTerms":{"notes":"SIG-S2 acceptance: draft quotation","useType":"LEISURE","belowMsr":false,"currency":"BTN","msrValue":200,"inclusions":[],"roomTypeId":"177ccd78-97b7-4efa-b72e-66ba3d11945d","effectiveRate":500,"resolutionPath":[{"step":"RATE_PLAN_PRIORITY","detail":"selected=rp-dlx-default type=INDIVIDUAL"}],"resolvedRatePlanId":"rp-dlx-default","resolvedNightlyRate":500,"resolvedRatePlanType":"INDIVIDUAL","isDeterrentRateApplied":false},"totalAmount":"500","currency":"BTN","validUntil":null,"sentAt":null,"sentTo":null,"communicationRecordId":null,"supersededById":null,"superse`

### AC-S2-002 — Send quotation transitions DRAFT→SENT and registers timers
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Sending seals the quotation and schedules validity + ack tracking timers (TimerRecord in this slice).
- **Database (PostgreSQL)**: Updates quotation state; inserts TimerRecord(QUOTATION_VALIDITY_W15, QUOTATION_ACK_TRACKER).
- **Response (truncated)**: `{"id":"ec5f2cfe-5357-4c10-ad22-162fd73bb238","entryId":"da55c9ab-ca2f-407a-98b0-6dc1305681cd","segmentId":"07ceb685-370a-4823-98b7-d1e6ad85502d","versionNumber":1,"referenceNumber":"Q-001","state":"SENT","commercialTerms":{"notes":"SIG-S2 acceptance: draft quotation","useType":"LEISURE","belowMsr":false,"currency":"BTN","msrValue":200,"inclusions":[],"roomTypeId":"177ccd78-97b7-4efa-b72e-66ba3d11945d","effectiveRate":500,"resolutionPath":[{"step":"RATE_PLAN_PRIORITY","detail":"selected=rp-dlx-default type=INDIVIDUAL"}],"resolvedRatePlanId":"rp-dlx-default","resolvedNightlyRate":500,"resolvedRatePlanType":"INDIVIDUAL","isDeterrentRateApplied":false},"totalAmount":"500","currency":"BTN","validUntil":"2026-05-15T11:04:34.073Z","sentAt":"2026-05-13T11:04:34.073Z","sentTo":"guest@example.com","`

### AC-S2-003 — Accept quotation transitions SENT→ACCEPTED and cancels timers
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Acceptance records acceptedAt/acceptedBy and cancels timers for that quotation.
- **Database (PostgreSQL)**: Updates quotation; cancels timer records matching quotationId payload.
- **Response (truncated)**: `{"id":"ec5f2cfe-5357-4c10-ad22-162fd73bb238","entryId":"da55c9ab-ca2f-407a-98b0-6dc1305681cd","segmentId":"07ceb685-370a-4823-98b7-d1e6ad85502d","versionNumber":1,"referenceNumber":"Q-001","state":"ACCEPTED","commercialTerms":{"notes":"SIG-S2 acceptance: draft quotation","useType":"LEISURE","belowMsr":false,"currency":"BTN","msrValue":200,"inclusions":[],"roomTypeId":"177ccd78-97b7-4efa-b72e-66ba3d11945d","effectiveRate":500,"resolutionPath":[{"step":"RATE_PLAN_PRIORITY","detail":"selected=rp-dlx-default type=INDIVIDUAL"}],"resolvedRatePlanId":"rp-dlx-default","resolvedNightlyRate":500,"resolvedRatePlanType":"INDIVIDUAL","isDeterrentRateApplied":false},"totalAmount":"500","currency":"BTN","validUntil":"2026-05-15T11:04:34.073Z","sentAt":"2026-05-13T11:04:34.073Z","sentTo":"guest@example.co`

### AC-S2-004 — Place speculative hold creates hold + updates room claim state
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: HoldService.placeSpeculativeHold places a PLACED hold and marks inventory SPECULATIVELY_HELD.
- **Database (PostgreSQL)**: Inserts speculative_holds; updates room.currentClaimState; inserts RoomClaimStateEvent; registers SPECULATIVE_HOLD_EXPIRY timer.
- **Response (truncated)**: `{"id":"c92d7999-b48f-4842-99bc-cc0c797f0002","entryId":"da55c9ab-ca2f-407a-98b0-6dc1305681cd","segmentId":"07ceb685-370a-4823-98b7-d1e6ad85502d","roomId":"8b38f698-3951-4fea-83ff-45ff36d595e1","spaceId":null,"state":"PLACED","placedAt":"2026-05-13T11:04:34.126Z","placedBy":"s2-fd-1","ttlSeconds":120,"expiresAt":"2026-05-13T11:06:34.126Z","releasedAt":null,"releasedBy":null,"releaseReason":null,"upgradedToId":null,"notes":"SIG-S2 acceptance: speculative hold","createdAt":"2026-05-13T11:04:34.131Z"}`

### AC-S2-005 — Release speculative hold requires L2+
- **Pass**: YES
- **HTTP**: 403
- **What is happening**: Release route is gated at L2+; L1 must be blocked.
- **Database (PostgreSQL)**: No state change.
- **Response (truncated)**: `{"error":"AuthorizationError","message":"Insufficient authority"}`