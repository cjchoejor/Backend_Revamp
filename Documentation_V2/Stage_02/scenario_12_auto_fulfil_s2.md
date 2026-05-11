# Stage 02 scenario — scenario_12_auto_fulfil_s2

- Base URL: `http://localhost:4000/api`
- Passed: **2/2**

## Steps

### Auto-fulfil route transitions to S3
- **Pass**: YES
- **API**: POST `/entries/938b5831-9306-4c32-a5ad-7de475fa5cd0/s2/auto-fulfil-to-s3` → 200
- **Response JSON**:

```json
{
  "id": "938b5831-9306-4c32-a5ad-7de475fa5cd0",
  "inquiryId": "67fc7db3-d15c-4af0-b6f1-4e3672fbe55a",
  "guestProfileId": "4737c121-916b-484c-a71c-dc3e34f2dbe8",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S3",
  "walkInCompressed": false,
  "checkInDate": "2026-05-08T08:54:38.484Z",
  "checkOutDate": "2026-05-09T08:54:38.484Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-07T08:54:38.488Z",
  "updatedAt": "2026-05-07T08:54:38.511Z",
  "createdBy": "stage02-fd-1",
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
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```

### TraceEvent evidence recorded
- **Pass**: YES
- **Notes**: traceId=3a7ae449-2f7c-4a6a-90ea-44f3364a022b