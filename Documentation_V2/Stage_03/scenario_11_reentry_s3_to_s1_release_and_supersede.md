# Stage 03 scenario — scenario_11_reentry_s3_to_s1_release_and_supersede

- Base URL: `http://localhost:4000/api`
- Passed: **5/5**

## Steps

### Re-entry to S1 succeeds
- **Pass**: YES
- **API**: POST `/entries/6813b3ce-6750-40cf-988f-f57036ca7344/re-entry/s1` → 200
- **Response JSON**:

```json
{
  "id": "6813b3ce-6750-40cf-988f-f57036ca7344",
  "inquiryId": "93c6c3ed-6846-4b66-afba-c888214767d8",
  "guestProfileId": "5e5fafd2-9969-481c-80ed-6f17c3e1af59",
  "segmentNumber": 2,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S1",
  "walkInCompressed": false,
  "checkInDate": "2026-06-06T09:51:05.092Z",
  "checkOutDate": "2026-06-07T09:51:05.092Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-07T09:51:05.097Z",
  "updatedAt": "2026-05-07T09:51:05.273Z",
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

### Hold released
- **Pass**: YES
- **Notes**: holdState=RELEASED

### Invoice superseded
- **Pass**: YES
- **Notes**: invoiceState=SUPERSEDED

### No active W22/W34 timers after re-entry
- **Pass**: YES
- **Notes**: w22=none w34=none