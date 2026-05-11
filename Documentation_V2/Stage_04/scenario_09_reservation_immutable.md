# Stage 04 scenario — scenario_09_reservation_immutable

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Confirm reservation
- **Pass**: YES
- **API**: POST `/entries/a577a7c3-7f48-496c-a2a0-4bdfae7a19da/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "b803c56c-e7ee-4acd-827b-4d9f4e20cfb3",
    "entryId": "a577a7c3-7f48-496c-a2a0-4bdfae7a19da",
    "segmentId": "e3fad9b5-0f8b-4eb0-9104-20e23eb261f0",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:16.088Z",
    "frozenCheckOutDate": "2026-06-07T12:05:16.088Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:16.227Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:16.228Z"
  },
  "entry": {
    "id": "a577a7c3-7f48-496c-a2a0-4bdfae7a19da",
    "inquiryId": "d8e51405-ceef-436f-bc79-617247cf3991",
    "guestProfileId": "344c3b25-9a5e-4ca7-9fbc-d9494828176d",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:16.088Z",
    "checkOutDate": "2026-06-07T12:05:16.088Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:16.093Z",
    "updatedAt": "2026-05-07T12:05:16.241Z",
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

### Reservation id captured
- **Pass**: YES
- **Notes**: id=b803c56c-e7ee-4acd-827b-4d9f4e20cfb3

### Reservation.update rejected
- **Pass**: YES
- **Response JSON**:

```json
{
  "name": "Error",
  "message": "Reservation is immutable after creation; create a new segment + reservation for amendments"
}
```

### Reservation.delete rejected
- **Pass**: YES
- **Response JSON**:

```json
{
  "name": "Error",
  "message": "Reservation is immutable after creation; create a new segment + reservation for amendments"
}
```