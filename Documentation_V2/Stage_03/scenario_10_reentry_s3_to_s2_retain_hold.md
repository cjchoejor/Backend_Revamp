# Stage 03 scenario — scenario_10_reentry_s3_to_s2_retain_hold

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Re-entry to S2 succeeds
- **Pass**: YES
- **API**: POST `/entries/da3f1ae2-046b-433b-929d-96703afe3739/re-entry/s2` → 200
- **Response JSON**:

```json
{
  "id": "da3f1ae2-046b-433b-929d-96703afe3739",
  "inquiryId": "5db123ae-6a01-409b-bafd-9cf34f1055e7",
  "guestProfileId": "5e5fafd2-9969-481c-80ed-6f17c3e1af59",
  "segmentNumber": 2,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-06-06T09:51:04.898Z",
  "checkOutDate": "2026-06-07T09:51:04.898Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-07T09:51:04.903Z",
  "updatedAt": "2026-05-07T09:51:05.072Z",
  "createdBy": "stage03-fd-1",
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
```

### New segment created
- **Pass**: YES
- **Notes**: before=1 after=2

### Hold retained in PLACED
- **Pass**: YES
- **Notes**: holdState=PLACED