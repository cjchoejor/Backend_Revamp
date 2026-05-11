# Stage 01 scenario — scenario_11_corporate_context_required

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Exit blocked without corporate context
- **Pass**: YES
- **API**: POST `/entries/07d658ec-9e16-4994-9e65-13df277036e5/progress-stage` → 409
- **Response JSON**:

```json
{
  "error": "StageGateBlockedError",
  "message": "Corporate/Government client reference required",
  "blockingCondition": "MISSING_CORP_CLIENT_REF"
}
```

### Capture corporate context
- **Pass**: YES
- **API**: PATCH `/inquiries/ffcc7350-f580-4ab8-b38b-452c58c4bd44/corporate-context` → 200
- **Response JSON**:

```json
{
  "id": "ffcc7350-f580-4ab8-b38b-452c58c4bd44",
  "referenceNumber": "INQ-1778071030566-201685",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "agentProfileId": null,
  "sourceChannel": "CORPORATE",
  "defaultCustodianId": "staff-fom-1",
  "notes": null,
  "corporateClientRef": "ACME-001",
  "corporateCoordinator": "Coordinator A",
  "corporateContextCapturedAt": "2026-05-06T12:37:10.601Z",
  "corporateContextCapturedBy": "stage01-fd-1",
  "createdAt": "2026-05-06T12:37:10.567Z",
  "updatedAt": "2026-05-06T12:37:10.602Z",
  "createdBy": "stage01-fd-1",
  "parkedAt": null,
  "parkedBy": null
}
```

### Exit succeeds after corporate context
- **Pass**: YES
- **API**: POST `/entries/07d658ec-9e16-4994-9e65-13df277036e5/progress-stage` → 200
- **Response JSON**:

```json
{
  "id": "07d658ec-9e16-4994-9e65-13df277036e5",
  "inquiryId": "ffcc7350-f580-4ab8-b38b-452c58c4bd44",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-05-07T12:37:10.569Z",
  "checkOutDate": "2026-05-08T12:37:10.569Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-06T12:37:10.573Z",
  "updatedAt": "2026-05-06T12:37:10.614Z",
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
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```