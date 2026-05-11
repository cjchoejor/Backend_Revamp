# Stage 04 scenario — scenario_03_overbooking_requires_gm_record

- Base URL: `http://localhost:4000/api`
- Passed: **2/2**

## Steps

### Blocked due to overbooking
- **Pass**: YES
- **API**: POST `/entries/d0d3a344-94a8-4554-9e20-0b60c75db9c5/confirm` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Overbooking detected (DELIBERATE): GM approval + mitigation required before confirmation",
  "blockingCondition": "OVERBOOKING_REQUIRES_GM"
}
```

### Confirm succeeds after GM approval record
- **Pass**: YES
- **API**: POST `/entries/d0d3a344-94a8-4554-9e20-0b60c75db9c5/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "80adf607-ece2-455f-b30e-65a50f67be4c",
    "entryId": "d0d3a344-94a8-4554-9e20-0b60c75db9c5",
    "segmentId": "b7fcc5fb-f5a8-4dd1-bb34-a3a36da044e5",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:10.730Z",
    "frozenCheckOutDate": "2026-06-07T12:05:10.730Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:10.910Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:10.911Z"
  },
  "entry": {
    "id": "d0d3a344-94a8-4554-9e20-0b60c75db9c5",
    "inquiryId": "c3fe6145-e902-4630-82e9-3320bb4d0d56",
    "guestProfileId": "d264b815-5fde-492c-8596-4d7548626aad",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:10.730Z",
    "checkOutDate": "2026-06-07T12:05:10.730Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:10.733Z",
    "updatedAt": "2026-05-07T12:05:10.930Z",
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