# S2 acceptance test report (slice)

- Base URL: `http://localhost:4000/api`
- Passed: **6/6**

## Steps

### AC-S2-setup — Entry progressed to S2
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Bring a fresh entry into S2 with preferred configuration selected.
- **Database (PostgreSQL)**: Entry.currentStage updated to S2; preferred AvailabilityConfiguration sealedAt set; TraceEvent written.
- **Response (truncated)**: `{"id":"077f61b8-4308-4984-8687-781e0f8f3cd2","inquiryId":"c593febb-b639-4131-a539-3d4f4a10ff71","guestProfileId":"024e4213-b759-4888-9400-e3e19a76ffcb","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S2","checkInDate":null,"checkOutDate":null,"guestCount":null,"otaSource":false,"otaReference":null,"groupBillingMode":null,"parkedAt":null,"parkedBy":null,"parkedIndividually":false,"createdAt":"2026-04-24T09:16:35.567Z","updatedAt":"2026-04-24T09:16:35.624Z","createdBy":"s2-fd-1","version":2,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":false,"keysIssuedAt":null,"keysIssuedCount":null,"keysIssuedBy":null,"registrationCompletedAt":null,"regi`

### AC-S2-001 — Create quotation in DRAFT
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: QuotationService.createQuotation creates a DRAFT quotation version for the current segment.
- **Database (PostgreSQL)**: Inserts quotations row (state=DRAFT, versionNumber=1).
- **Response (truncated)**: `{"id":"075babbe-c30a-46f3-ac37-3cac63da191a","entryId":"077f61b8-4308-4984-8687-781e0f8f3cd2","segmentId":"0a749f55-34b8-4764-9652-61585a4564d0","versionNumber":1,"referenceNumber":"Q-001","state":"DRAFT","commercialTerms":{"notes":"SIG-S2 acceptance: draft quotation","useType":"LEISURE","currency":"BTN","inclusions":[],"roomTypeId":"179ba9a7-79bc-43b6-8c2c-e9b5398a0a7d","resolvedRateAmount":500,"resolvedRatePlanId":"rp-dlx-default"},"totalAmount":"500","currency":"BTN","validUntil":null,"sentAt":null,"sentTo":null,"communicationRecordId":null,"supersededById":null,"supersededAt":null,"expiredAt":null,"acceptedAt":null,"acceptedBy":null,"folioId":null,"sealedAt":null,"createdAt":"2026-04-24T09:16:35.647Z","createdBy":"s2-fd-1"}`

### AC-S2-002 — Send quotation transitions DRAFT→SENT and registers timers
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Sending seals the quotation and schedules validity + ack tracking timers (TimerRecord in this slice).
- **Database (PostgreSQL)**: Updates quotation state; inserts TimerRecord(QUOTATION_VALIDITY_W15, QUOTATION_ACK_TRACKER).
- **Response (truncated)**: `{"id":"075babbe-c30a-46f3-ac37-3cac63da191a","entryId":"077f61b8-4308-4984-8687-781e0f8f3cd2","segmentId":"0a749f55-34b8-4764-9652-61585a4564d0","versionNumber":1,"referenceNumber":"Q-001","state":"SENT","commercialTerms":{"notes":"SIG-S2 acceptance: draft quotation","useType":"LEISURE","currency":"BTN","inclusions":[],"roomTypeId":"179ba9a7-79bc-43b6-8c2c-e9b5398a0a7d","resolvedRateAmount":500,"resolvedRatePlanId":"rp-dlx-default"},"totalAmount":"500","currency":"BTN","validUntil":"2026-04-26T09:16:35.654Z","sentAt":"2026-04-24T09:16:35.654Z","sentTo":"guest@example.com","communicationRecordId":null,"supersededById":null,"supersededAt":null,"expiredAt":null,"acceptedAt":null,"acceptedBy":null,"folioId":null,"sealedAt":null,"createdAt":"2026-04-24T09:16:35.647Z","createdBy":"s2-fd-1"}`

### AC-S2-003 — Accept quotation transitions SENT→ACCEPTED and cancels timers
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Acceptance records acceptedAt/acceptedBy and cancels timers for that quotation.
- **Database (PostgreSQL)**: Updates quotation; cancels timer records matching quotationId payload.
- **Response (truncated)**: `{"id":"075babbe-c30a-46f3-ac37-3cac63da191a","entryId":"077f61b8-4308-4984-8687-781e0f8f3cd2","segmentId":"0a749f55-34b8-4764-9652-61585a4564d0","versionNumber":1,"referenceNumber":"Q-001","state":"ACCEPTED","commercialTerms":{"notes":"SIG-S2 acceptance: draft quotation","useType":"LEISURE","currency":"BTN","inclusions":[],"roomTypeId":"179ba9a7-79bc-43b6-8c2c-e9b5398a0a7d","resolvedRateAmount":500,"resolvedRatePlanId":"rp-dlx-default"},"totalAmount":"500","currency":"BTN","validUntil":"2026-04-26T09:16:35.654Z","sentAt":"2026-04-24T09:16:35.654Z","sentTo":"guest@example.com","communicationRecordId":"142d69e4-3876-419b-8ca3-9cc99ef440ae","supersededById":null,"supersededAt":null,"expiredAt":null,"acceptedAt":"2026-04-24T09:16:35.781Z","acceptedBy":"s2-fd-1","folioId":null,"sealedAt":null,"`

### AC-S2-004 — Place speculative hold creates hold + updates room claim state
- **Pass**: YES
- **HTTP**: 201
- **What is happening**: HoldService.placeSpeculativeHold places a PLACED hold and marks inventory SPECULATIVELY_HELD.
- **Database (PostgreSQL)**: Inserts speculative_holds; updates room.currentClaimState; inserts RoomClaimStateEvent; registers SPECULATIVE_HOLD_EXPIRY timer.
- **Response (truncated)**: `{"id":"8661dbe4-b069-4e95-9333-911c02010ce0","entryId":"077f61b8-4308-4984-8687-781e0f8f3cd2","segmentId":"0a749f55-34b8-4764-9652-61585a4564d0","roomId":"c011e624-3c28-4f4a-b484-57a6f0c9530a","spaceId":null,"state":"PLACED","placedAt":"2026-04-24T09:16:35.821Z","placedBy":"s2-fd-1","ttlSeconds":120,"expiresAt":"2026-04-24T09:18:35.821Z","releasedAt":null,"releasedBy":null,"releaseReason":null,"upgradedToId":null,"notes":"SIG-S2 acceptance: speculative hold","createdAt":"2026-04-24T09:16:35.834Z"}`

### AC-S2-005 — Release speculative hold requires L2+
- **Pass**: YES
- **HTTP**: 403
- **What is happening**: Release route is gated at L2+; L1 must be blocked.
- **Database (PostgreSQL)**: No state change.
- **Response (truncated)**: `{"error":"AuthorizationError","message":"Insufficient authority"}`