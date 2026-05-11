# Stage 04 scenario — scenario_04_multi_booking_ack

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Blocked for multi-booking
- **Pass**: YES
- **API**: POST `/entries/8fd695cf-7716-427b-b7a2-674b883c59cd/confirm` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Multi-booking overlap detected; FOM acknowledgement required",
  "blockingCondition": "MULTI_BOOKING_ACK_REQUIRED"
}
```

### FOM ack recorded
- **Pass**: YES
- **API**: POST `/entries/8fd695cf-7716-427b-b7a2-674b883c59cd/multi-booking/ack` → 201
- **Response JSON**:

```json
{
  "ok": true
}
```

### Confirm succeeds after ack
- **Pass**: YES
- **API**: POST `/entries/8fd695cf-7716-427b-b7a2-674b883c59cd/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "cb63ba15-3ca7-4bc0-a42c-7bf141cc191b",
    "entryId": "8fd695cf-7716-427b-b7a2-674b883c59cd",
    "segmentId": "8a445921-3d83-4f8e-b8e1-1dabf55947dc",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:10.953Z",
    "frozenCheckOutDate": "2026-06-07T12:05:10.953Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:11.304Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:11.305Z"
  },
  "entry": {
    "id": "8fd695cf-7716-427b-b7a2-674b883c59cd",
    "inquiryId": "40db416b-4556-4dc4-91ee-5628c4386384",
    "guestProfileId": "f2a765cc-97b2-49c0-9bf2-4d123479d382",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:10.953Z",
    "checkOutDate": "2026-06-07T12:05:10.953Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:11.150Z",
    "updatedAt": "2026-05-07T12:05:11.317Z",
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