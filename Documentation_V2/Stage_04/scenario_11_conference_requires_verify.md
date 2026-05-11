# Stage 04 scenario — scenario_11_conference_requires_verify

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Blocked without conference verification
- **Pass**: YES
- **API**: POST `/entries/20c99b2e-33ad-4751-9ecd-a39672fcab78/confirm` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Conference verification must be completed by FOM before confirmation",
  "blockingCondition": "CONFERENCE_VERIFICATION_REQUIRED"
}
```

### FOM verification recorded
- **Pass**: YES
- **API**: POST `/entries/20c99b2e-33ad-4751-9ecd-a39672fcab78/conference/verify` → 201
- **Response JSON**:

```json
{
  "ok": true
}
```

### Confirm succeeds after verification
- **Pass**: YES
- **API**: POST `/entries/20c99b2e-33ad-4751-9ecd-a39672fcab78/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "2ce82dd4-f264-4fa2-aa87-08b8e7d4ff93",
    "entryId": "20c99b2e-33ad-4751-9ecd-a39672fcab78",
    "segmentId": "82854da3-6bfe-4a49-bb7f-2b73ff3a356c",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:16.439Z",
    "frozenCheckOutDate": "2026-06-07T12:05:16.439Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:16.591Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:16.592Z"
  },
  "entry": {
    "id": "20c99b2e-33ad-4751-9ecd-a39672fcab78",
    "inquiryId": "619a1f29-da86-4dfb-beb5-ef0e8634ec89",
    "guestProfileId": "d843a56f-1e93-4bf1-914d-e9a90690b7cb",
    "segmentNumber": 1,
    "useType": "CONFERENCE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:16.439Z",
    "checkOutDate": "2026-06-07T12:05:16.439Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:16.443Z",
    "updatedAt": "2026-05-07T12:05:16.604Z",
    "createdBy": "staff-frontdesk-1",
    "version": 4,
    "closedAt": null,
    "closedBy": null,
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": null,
    "keysIssuedCount": null,
    "keysIssuedBy": null,
    "registrationCompletedAt": null,
    "registrationCompletedBy": null,
    "apartmentDurationNights": null,
    "apartmentRateTierCode": null
  }
}
```