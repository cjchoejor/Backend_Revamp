# S4 acceptance test report (slice)

- Base URL: `http://127.0.0.1:4055/api`
- Passed: **4/4**

## Steps

### AC-S4-002 — Confirm rejected without committed hold (readiness gate)
- **Pass**: YES
- **HTTP**: 409
- **What is happening**: p40-s4-confirmation-readiness-gates: enforceCommittedHoldReadyForS4Confirmation before transaction.
- **Database (PostgreSQL)**: No reservation row; entry remains S3.
- **Response (truncated)**: `{"error":"StageGateBlockedError","message":"CommittedHold required before confirmation","blockingCondition":"MISSING_COMMITTED_HOLD"}`

### AC-S4-003 — GET payment-status at S3 (advance evaluation)
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: Folio advance threshold evaluation exposed for S3 confirmation readiness (Policy 42 slice).
- **Database (PostgreSQL)**: Read-only; no writes.
- **Response (truncated)**: `{"satisfied":true,"totalReceived":100,"requiredAmount":1,"shortfall":0,"creditExtensionActive":false,"ceilingAmount":null}`

### AC-S4-001-ish — POST progress-stage target S4 confirms reservation (delegated confirm path)
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: reservationsRouter: targetStage S4 calls reservationService.confirmReservation — primary happy-path confirm for this slice.
- **Database (PostgreSQL)**: Creates Reservation; confirms hold; H1 + comms slice per s4-confirmation-service.
- **Response (truncated)**: `{"reservation":{"id":"8e700b22-02c4-4109-8faa-fd29bf9a4049","entryId":"7fa92e92-09ed-455c-8588-fc6d651e9116","segmentId":"7a033086-ffd6-4029-88fc-27dbd3a37878","frozenRate":"500","frozenRatePlanId":"rp-dlx-default","frozenInclusions":[],"frozenCancellationTerms":{"noShow":true},"frozenBillingModel":"GUEST_PAY","frozenCheckInDate":"2026-05-14T11:37:19.476Z","frozenCheckOutDate":"2026-05-15T11:37:19.477Z","frozenGuestCount":1,"creditCeilingIfExtended":null,"confirmedAt":"2026-05-13T11:37:19.914Z","confirmedBy":"s4-fd-1","confirmationVoucherSent":true,"sealedAt":null,"createdAt":"2026-05-13T11:37:19.915Z"},"entry":{"id":"7fa92e92-09ed-455c-8588-fc6d651e9116","inquiryId":"1a169f6b-0207-4b1c-8252-029c20cb7027","guestProfileId":"8ca7103b-12ee-4e95-a139-1543e34efb2b","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S4","walkInCompressed":false,"checkInDate":"2026-05-14T11`

### AC-S4-004 — Second confirm when already at S4 is rejected
- **Pass**: YES
- **HTTP**: 409
- **What is happening**: Idempotency / stage guard: confirmReservation requires entry at S3.
- **Database (PostgreSQL)**: No second reservation.
- **Response (truncated)**: `{"error":"StageGateBlockedError","message":"Entry must be at S3 to confirm","blockingCondition":"NOT_AT_S3"}`