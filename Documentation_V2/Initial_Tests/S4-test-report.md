# S4 acceptance test report (slice)

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### AC-S4-001-ish — Confirm reservation creates snapshot, confirms hold, creates H1 + ownership trace
- **Pass**: YES
- **HTTP**: 200
- **What is happening**: S4 confirm creates Reservation snapshot from S2/S3 evidence, confirms committed hold, creates H1, and records ownership assignment trace event.
- **Database (PostgreSQL)**: Creates Reservation; updates CommittedHold to CONFIRMED; inserts CommunicationRecord + TimerRecord(ACK window); inserts HandoffRecord(H1); inserts TraceEvent(OWNERSHIP_ASSIGNED).
- **Response (truncated)**: `{"reservation":{"id":"a616f658-76f9-4138-8170-7dd49cfd0a79","entryId":"c502ae24-18e4-4114-a418-5c26d2a0cddd","segmentId":"fc71efc3-d372-4be5-b097-cb840021d5ad","frozenRate":"500","frozenRatePlanId":"rp-dlx-default","frozenInclusions":[],"frozenCancellationTerms":{"noShow":true},"frozenBillingModel":"GUEST_PAY","frozenCheckInDate":"2026-04-24T10:31:53.099Z","frozenCheckOutDate":"2026-04-25T10:31:53.099Z","frozenGuestCount":1,"creditCeilingIfExtended":null,"confirmedAt":"2026-04-24T10:31:53.099Z","confirmedBy":"s4-fd-1","confirmationVoucherSent":true,"sealedAt":null,"createdAt":"2026-04-24T10:31:53.101Z"},"entry":{"id":"c502ae24-18e4-4114-a418-5c26d2a0cddd","inquiryId":"4429676c-ec2e-4466-a551-2ff2f9168150","guestProfileId":"58254106-e6a0-4fa9-ba11-0095aba01211","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S4","checkInDate":null,"checkOutDate":null,"guestCount":n`