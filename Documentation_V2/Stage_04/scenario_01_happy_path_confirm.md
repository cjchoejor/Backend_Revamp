# Stage 04 scenario — scenario_01_happy_path_confirm

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Confirm reservation
- **Pass**: YES
- **API**: POST `/entries/242c9b65-75c4-4a35-910d-2c137c444b82/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "2bb69140-fef5-4aef-accd-4464aa5a497a",
    "entryId": "242c9b65-75c4-4a35-910d-2c137c444b82",
    "segmentId": "3ad19657-b340-491b-8730-ac3e259fe012",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:09.907Z",
    "frozenCheckOutDate": "2026-06-07T12:05:09.908Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:10.396Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:10.396Z"
  },
  "entry": {
    "id": "242c9b65-75c4-4a35-910d-2c137c444b82",
    "inquiryId": "3209cba5-7b9c-4b1d-94ae-f36146efe9ad",
    "guestProfileId": "f1d2cb52-b3c0-4d91-adbe-5fc709dcfddc",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:09.907Z",
    "checkOutDate": "2026-06-07T12:05:09.908Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:09.922Z",
    "updatedAt": "2026-05-07T12:05:10.411Z",
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

### CommittedHold is CONFIRMED
- **Pass**: YES
- **Notes**: state=CONFIRMED

### W4 + W22 timers scheduled
- **Pass**: YES
- **Notes**: w4=4877377a-1c3c-4ef2-ac37-52fe5c090d38 w22=a25bc654-0df9-4df2-ae3d-dbdf6ad41fd1