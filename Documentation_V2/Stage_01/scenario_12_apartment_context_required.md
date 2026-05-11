# Stage 01 scenario — scenario_12_apartment_context_required

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Exit blocked without apartment context
- **Pass**: YES
- **API**: POST `/entries/4db47f25-bd60-4c7e-9a8c-bfd2d6974dd1/progress-stage` → 409
- **Response JSON**:

```json
{
  "error": "StageGateBlockedError",
  "message": "Apartment duration (nights) required",
  "blockingCondition": "MISSING_APARTMENT_DURATION"
}
```

### Set apartment context
- **Pass**: YES
- **API**: PATCH `/entries/4db47f25-bd60-4c7e-9a8c-bfd2d6974dd1/apartment-context` → 200
- **Response JSON**:

```json
{
  "id": "4db47f25-bd60-4c7e-9a8c-bfd2d6974dd1",
  "inquiryId": "4ce175b4-4425-4406-946f-d321537e1d1b",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "segmentNumber": 1,
  "useType": "APARTMENT",
  "status": "ACTIVE",
  "currentStage": "S1",
  "walkInCompressed": false,
  "checkInDate": "2026-05-07T12:37:10.625Z",
  "checkOutDate": "2026-05-14T12:37:10.625Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-06T12:37:10.629Z",
  "updatedAt": "2026-05-06T12:37:10.658Z",
  "createdBy": "stage01-fd-1",
  "version": 2,
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
  "apartmentDurationNights": 7,
  "apartmentRateTierCode": "TIER_7D"
}
```

### Exit succeeds after apartment context
- **Pass**: YES
- **API**: POST `/entries/4db47f25-bd60-4c7e-9a8c-bfd2d6974dd1/progress-stage` → 200
- **Response JSON**:

```json
{
  "id": "4db47f25-bd60-4c7e-9a8c-bfd2d6974dd1",
  "inquiryId": "4ce175b4-4425-4406-946f-d321537e1d1b",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "segmentNumber": 1,
  "useType": "APARTMENT",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-05-07T12:37:10.625Z",
  "checkOutDate": "2026-05-14T12:37:10.625Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-06T12:37:10.629Z",
  "updatedAt": "2026-05-06T12:37:10.668Z",
  "createdBy": "stage01-fd-1",
  "version": 3,
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
  "apartmentDurationNights": 7,
  "apartmentRateTierCode": "TIER_7D"
}
```