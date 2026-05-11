# Stage 04 scenario — scenario_05_w22_ack_timeout

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Confirm reservation
- **Pass**: YES
- **API**: POST `/entries/43c3393f-3400-470b-bc80-0b12fc143811/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "65c21023-400c-4fa4-976a-42cadc1db1eb",
    "entryId": "43c3393f-3400-470b-bc80-0b12fc143811",
    "segmentId": "0ed7ed42-5e3b-4170-8de2-72c4679c8246",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:11.328Z",
    "frozenCheckOutDate": "2026-06-07T12:05:11.328Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:11.453Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:11.454Z"
  },
  "entry": {
    "id": "43c3393f-3400-470b-bc80-0b12fc143811",
    "inquiryId": "f3c5ce12-becd-4d6e-a919-55b615c65b6e",
    "guestProfileId": "9765de8d-bac9-4213-b9cd-8e974212dcc5",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:11.328Z",
    "checkOutDate": "2026-06-07T12:05:11.328Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:11.332Z",
    "updatedAt": "2026-05-07T12:05:11.466Z",
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

### Voucher communication exists
- **Pass**: YES
- **Notes**: commId=31d26b64-16ce-4b9e-b1b9-0d8feb5503b3

### Enqueue W22
- **Pass**: YES
- **API**: POST `/admin/enqueue` → 201
- **Response JSON**:

```json
{
  "jobId": "1145b92a-178b-4f16-b38d-78ec66468b21",
  "jobName": "ACKNOWLEDGEMENT_WINDOW_W22",
  "startAfter": "2026-05-07T12:05:12.980Z"
}
```

### Communication TIMED_OUT
- **Pass**: YES
- **Notes**: status=TIMED_OUT