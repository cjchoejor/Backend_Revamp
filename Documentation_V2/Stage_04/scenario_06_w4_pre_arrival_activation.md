# Stage 04 scenario — scenario_06_w4_pre_arrival_activation

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Confirm reservation
- **Pass**: YES
- **API**: POST `/entries/7100f279-bac0-4620-b8fd-1ae39c5dc448/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "ed2f6e96-b23e-4d3c-9442-2048c0bae6bb",
    "entryId": "7100f279-bac0-4620-b8fd-1ae39c5dc448",
    "segmentId": "2d7a486c-4df7-441f-80b5-8688586facb8",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:14.025Z",
    "frozenCheckOutDate": "2026-06-07T12:05:14.025Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:14.155Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:14.156Z"
  },
  "entry": {
    "id": "7100f279-bac0-4620-b8fd-1ae39c5dc448",
    "inquiryId": "d660de6a-d8f7-4174-b0c7-9d17002e1420",
    "guestProfileId": "7e2cdc09-bb59-49c8-b24c-fe123a316723",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:14.025Z",
    "checkOutDate": "2026-06-07T12:05:14.025Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:14.030Z",
    "updatedAt": "2026-05-07T12:05:14.169Z",
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

### Enqueue W4
- **Pass**: YES
- **API**: POST `/admin/enqueue` → 201
- **Response JSON**:

```json
{
  "jobId": "8c681d0e-3821-408e-b0e3-da0cd3687e6d",
  "jobName": "PRE_ARRIVAL_COUNTDOWN_W4",
  "startAfter": "2026-05-07T12:05:14.175Z"
}
```

### Entry at S5
- **Pass**: YES
- **Notes**: stage=S5