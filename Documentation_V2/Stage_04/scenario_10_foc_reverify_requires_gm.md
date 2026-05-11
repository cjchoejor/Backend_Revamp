# Stage 04 scenario — scenario_10_foc_reverify_requires_gm

- Base URL: `http://localhost:4000/api`
- Passed: **2/2**

## Steps

### Blocked without GM approval
- **Pass**: YES
- **API**: POST `/entries/e181ee1a-88d3-4477-9d6b-2c6e01b61b35/confirm` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "FOC requires GM approval before S4 confirmation",
  "blockingCondition": "FOC_GM_APPROVAL_REQUIRED"
}
```

### Confirm succeeds after GM approval
- **Pass**: YES
- **API**: POST `/entries/e181ee1a-88d3-4477-9d6b-2c6e01b61b35/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "d7244fcf-1f49-495c-b999-5564f22e75a7",
    "entryId": "e181ee1a-88d3-4477-9d6b-2c6e01b61b35",
    "segmentId": "f25f6535-3041-40dc-ba1a-6a23431b6eef",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:16.254Z",
    "frozenCheckOutDate": "2026-06-07T12:05:16.254Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:16.408Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:16.409Z"
  },
  "entry": {
    "id": "e181ee1a-88d3-4477-9d6b-2c6e01b61b35",
    "inquiryId": "8a819157-9e20-483b-997a-750f619e80e5",
    "guestProfileId": "e83953f8-627a-4938-9b68-503d1cd9bfb1",
    "segmentNumber": 1,
    "useType": "GROUP",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:16.254Z",
    "checkOutDate": "2026-06-07T12:05:16.254Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:16.257Z",
    "updatedAt": "2026-05-07T12:05:16.423Z",
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