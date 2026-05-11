# Stage 01 scenario — scenario_10_duplicate_blocks_exit_until_resolved

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Create inquiry with duplicate flag
- **Pass**: YES
- **API**: POST `/inquiries` → 201
- **Response JSON**:

```json
{
  "id": "332d0135-4a11-4a6f-8810-116d884a5ff0",
  "referenceNumber": "INQ-1778071030499-489465",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "agentProfileId": null,
  "sourceChannel": "DIRECT",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": null,
  "corporateClientRef": null,
  "corporateCoordinator": null,
  "corporateContextCapturedAt": null,
  "corporateContextCapturedBy": null,
  "createdAt": "2026-05-06T12:37:10.500Z",
  "updatedAt": "2026-05-06T12:37:10.500Z",
  "createdBy": "stage01-fd-1",
  "parkedAt": null,
  "parkedBy": null
}
```

### S1 exit blocked by open duplicate
- **Pass**: YES
- **API**: POST `/entries/734cd168-95dd-44ff-b2ec-7066f1faa30a/progress-stage` → 409
- **Response JSON**:

```json
{
  "error": "StageGateBlockedError",
  "message": "Unresolved duplicate flag blocks S1 exit",
  "blockingCondition": "DUPLICATE_UNRESOLVED"
}
```

### Resolve duplicate flag
- **Pass**: YES
- **API**: POST `/duplicate-flags/2a552d5a-5d66-4e2e-ad57-9a3475136212/resolve` → 200
- **Response JSON**:

```json
{
  "id": "2a552d5a-5d66-4e2e-ad57-9a3475136212",
  "inquiryId": "332d0135-4a11-4a6f-8810-116d884a5ff0",
  "status": "RESOLVED",
  "resolutionType": "DISMISS",
  "resolutionReason": "false positive",
  "mergedIntoInquiryId": "conflict-1",
  "createdAt": "2026-05-06T12:37:10.501Z",
  "createdBy": "stage01-fd-1",
  "resolvedAt": "2026-05-06T12:37:10.539Z",
  "resolvedBy": "stage01-fd-1"
}
```

### S1 exit succeeds after resolution
- **Pass**: YES
- **API**: POST `/entries/734cd168-95dd-44ff-b2ec-7066f1faa30a/progress-stage` → 200
- **Response JSON**:

```json
{
  "id": "734cd168-95dd-44ff-b2ec-7066f1faa30a",
  "inquiryId": "332d0135-4a11-4a6f-8810-116d884a5ff0",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-05-07T12:37:10.505Z",
  "checkOutDate": "2026-05-08T12:37:10.505Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-06T12:37:10.510Z",
  "updatedAt": "2026-05-06T12:37:10.556Z",
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