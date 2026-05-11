# Stage 02 scenario — scenario_01_happy_path

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Create DRAFT quotation
- **Pass**: YES
- **API**: POST `/entries/8a3aa8c7-c8bf-4502-aa4f-90c743af2b90/quotations` → 201
- **Response JSON**:

```json
{
  "id": "a7774b36-8989-43ec-8ff4-10123ddeb067",
  "entryId": "8a3aa8c7-c8bf-4502-aa4f-90c743af2b90",
  "segmentId": "0ef16f09-be71-41f9-b559-e74d17631280",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "stage02 happy path",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "cbe6d1a6-6cc6-444c-82c0-7d28d0b6d9b8",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": null,
  "sentAt": null,
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-05-07T08:54:30.682Z",
  "createdBy": "stage02-fd-1"
}
```

### Send quotation
- **Pass**: YES
- **API**: POST `/quotations/a7774b36-8989-43ec-8ff4-10123ddeb067/send` → 200
- **Response JSON**:

```json
{
  "id": "a7774b36-8989-43ec-8ff4-10123ddeb067",
  "entryId": "8a3aa8c7-c8bf-4502-aa4f-90c743af2b90",
  "segmentId": "0ef16f09-be71-41f9-b559-e74d17631280",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "stage02 happy path",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "cbe6d1a6-6cc6-444c-82c0-7d28d0b6d9b8",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-05-09T08:54:30.687Z",
  "sentAt": "2026-05-07T08:54:30.687Z",
  "sentTo": "guest@example.com",
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-05-07T08:54:30.682Z",
  "createdBy": "stage02-fd-1"
}
```

### Accept quotation
- **Pass**: YES
- **API**: POST `/quotations/a7774b36-8989-43ec-8ff4-10123ddeb067/accept` → 200
- **Response JSON**:

```json
{
  "id": "a7774b36-8989-43ec-8ff4-10123ddeb067",
  "entryId": "8a3aa8c7-c8bf-4502-aa4f-90c743af2b90",
  "segmentId": "0ef16f09-be71-41f9-b559-e74d17631280",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "notes": "stage02 happy path",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "cbe6d1a6-6cc6-444c-82c0-7d28d0b6d9b8",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-05-09T08:54:30.687Z",
  "sentAt": "2026-05-07T08:54:30.687Z",
  "sentTo": "guest@example.com",
  "communicationRecordId": "62ad88c1-05aa-4034-ba39-1ba44735518f",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-05-07T08:54:30.810Z",
  "acceptedBy": "stage02-fd-1",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-05-07T08:54:30.682Z",
  "createdBy": "stage02-fd-1"
}
```

### Progress S2→S3
- **Pass**: YES
- **API**: POST `/entries/8a3aa8c7-c8bf-4502-aa4f-90c743af2b90/progress-stage` → 200
- **Response JSON**:

```json
{
  "id": "8a3aa8c7-c8bf-4502-aa4f-90c743af2b90",
  "inquiryId": "27195235-73d0-404b-a521-a573fc4dd421",
  "guestProfileId": "4737c121-916b-484c-a71c-dc3e34f2dbe8",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S3",
  "walkInCompressed": false,
  "checkInDate": "2026-05-08T08:54:30.573Z",
  "checkOutDate": "2026-05-09T08:54:30.573Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-07T08:54:30.586Z",
  "updatedAt": "2026-05-07T08:54:30.870Z",
  "createdBy": "stage02-fd-1",
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
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```