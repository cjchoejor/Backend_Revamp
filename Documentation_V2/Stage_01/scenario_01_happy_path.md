# Stage 01 scenario — scenario_01_happy_path

- Base URL: `http://localhost:4000/api`
- Passed: **5/5**

## Steps

### Create inquiry
- **Pass**: YES
- **API**: POST `/inquiries` → 201
- **Request JSON**:

```json
{
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "sourceChannel": "DIRECT"
}
```
- **Response JSON**:

```json
{
  "id": "30a5b69b-8488-4c9a-a97a-ba53dc766011",
  "referenceNumber": "INQ-1778071023348-428412",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "agentProfileId": null,
  "sourceChannel": "DIRECT",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": null,
  "corporateClientRef": null,
  "corporateCoordinator": null,
  "corporateContextCapturedAt": null,
  "corporateContextCapturedBy": null,
  "createdAt": "2026-05-06T12:37:03.350Z",
  "updatedAt": "2026-05-06T12:37:03.350Z",
  "createdBy": "stage01-fd-1",
  "parkedAt": null,
  "parkedBy": null
}
```

### Create entry
- **Pass**: YES
- **API**: POST `/entries` → 201
- **Response JSON**:

```json
{
  "id": "787c4215-aaed-45aa-b4b9-7a9ea6fe1eac",
  "inquiryId": "30a5b69b-8488-4c9a-a97a-ba53dc766011",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S1",
  "walkInCompressed": false,
  "checkInDate": "2026-05-07T12:37:03.373Z",
  "checkOutDate": "2026-05-08T12:37:03.374Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-06T12:37:03.386Z",
  "updatedAt": "2026-05-06T12:37:03.386Z",
  "createdBy": "stage01-fd-1",
  "version": 1,
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

### Availability query
- **Pass**: YES
- **API**: POST `/entries/787c4215-aaed-45aa-b4b9-7a9ea6fe1eac/availability/query` → 200
- **Response JSON**:

```json
{
  "configuration": {
    "id": "8add11e6-e21e-4028-b362-8f4fbd55f27d",
    "entryId": "787c4215-aaed-45aa-b4b9-7a9ea6fe1eac",
    "segmentId": null,
    "searchCriteria": {
      "checkInDate": "2026-05-07T12:37:03.399Z",
      "checkOutDate": "2026-05-08T12:37:03.399Z"
    },
    "resultSet": {
      "availableRooms": [
        {
          "claimState": "FREE",
          "roomNumber": "403",
          "inventoryId": "5bae8ea2-a4ab-4638-aee3-47560dd2e0f3"
        }
      ],
      "deficientRooms": [
        {
          "claimState": "FREE",
          "roomNumber": "402-DEF",
          "inventoryId": "6f0fc7e0-69ff-4575-8df7-7f809ffb47a8",
          "deficientCategory": "HOUSEKEEPING",
          "deficientDescription": null
        }
      ],
      "searchTimestamp": "2026-05-06T12:37:03.412Z",
      "unavailableRooms": [
        {
          "roomNumber": "501",
          "inventoryId": "9f695605-2ac5-4463-9da0-c7a1b3f2f8e4",
          "unavailabilityReason": "PHYSICAL_NOT_READY"
        },
        {
          "roomNumber": "502-DEF",
          "inventoryId": "74df8357-1853-4f44-b0ec-2214956873a6",
          "unavailabilityReason": "PHYSICAL_NOT_READY"
        },
        {
          "roomNumber": "503",
          "inventoryId": "2373f88c-c2fd-4bef-9aab-25693374df91",
          "unavailabilityReason": "PHYSICAL_NOT_READY"
        }
      ],
      "maintenanceConflicts": [],
      "isRevalidationRequired": false
    },
    "optionSelected": null,
    "isStale": false,
    "stalenessAt": null,
    "deficientAcknowledgements": null,
    "sealedAt": null,
    "createdAt": "2026-05-06T12:37:03.413Z",
    "createdBy": "stage01-fd-1"
  },
  "result": {
    "availableRooms": [
      {
        "inventoryId": "5bae8ea2-a4ab-4638-aee3-47560dd2e0f3",
        "roomNumber": "403",
        "claimState": "FREE",
        "roomId": "5bae8ea2-a4ab-4638-aee3-47560dd2e0f3"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "9f695605-2ac5-4463-9da0-c7a1b3f2f8e4",
        "roomNumber": "501",
        "unavailabilityReason": "PHYSICAL_NOT_READY",
        "roomId": "9f695605-2ac5-4463-9da0-c7a1b3f2f8e4"
      },
      {
        "inventoryId": "74df8357-1853-4f44-b0ec-2214956873a6",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "PHYSICAL_NOT_READY",
        "roomId": "74df8357-1853-4f44-b0ec-2214956873a6"
      },
      {
        "inventoryId": "2373f88c-c2fd-4bef-9aab-25693374df91",
        "roomNumber": "503",
        "unavailabilityReason": "PHYSICAL_NOT_READY",
        "roomId": "2373f88c-c2fd-4bef-9aab-25693374df91"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "6f0fc7e0-69ff-4575-8df7-7f809ffb47a8",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "6f0fc7e0-69ff-4575-8df7-7f809ffb47a8"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-05-06T12:37:03.412Z",
    "isRevalidationRequired": false
  }
}
```

### Select preferred
- **Pass**: YES
- **API**: PATCH `/availability/configurations/8add11e6-e21e-4028-b362-8f4fbd55f27d/select` → 200
- **Response JSON**:

```json
{
  "id": "8add11e6-e21e-4028-b362-8f4fbd55f27d",
  "entryId": "787c4215-aaed-45aa-b4b9-7a9ea6fe1eac",
  "segmentId": null,
  "searchCriteria": {
    "checkInDate": "2026-05-07T12:37:03.399Z",
    "checkOutDate": "2026-05-08T12:37:03.399Z"
  },
  "resultSet": {
    "availableRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "403",
        "inventoryId": "5bae8ea2-a4ab-4638-aee3-47560dd2e0f3"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "6f0fc7e0-69ff-4575-8df7-7f809ffb47a8",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-05-06T12:37:03.412Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "9f695605-2ac5-4463-9da0-c7a1b3f2f8e4",
        "unavailabilityReason": "PHYSICAL_NOT_READY"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "74df8357-1853-4f44-b0ec-2214956873a6",
        "unavailabilityReason": "PHYSICAL_NOT_READY"
      },
      {
        "roomNumber": "503",
        "inventoryId": "2373f88c-c2fd-4bef-9aab-25693374df91",
        "unavailabilityReason": "PHYSICAL_NOT_READY"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "5bae8ea2-a4ab-4638-aee3-47560dd2e0f3",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-05-06T12:37:03.413Z",
  "createdBy": "stage01-fd-1"
}
```

### Progress S1→S2
- **Pass**: YES
- **API**: POST `/entries/787c4215-aaed-45aa-b4b9-7a9ea6fe1eac/progress-stage` → 200
- **Response JSON**:

```json
{
  "id": "787c4215-aaed-45aa-b4b9-7a9ea6fe1eac",
  "inquiryId": "30a5b69b-8488-4c9a-a97a-ba53dc766011",
  "guestProfileId": "5cfce76a-056a-494d-98e7-ec6af414363b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-05-07T12:37:03.373Z",
  "checkOutDate": "2026-05-08T12:37:03.374Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-06T12:37:03.386Z",
  "updatedAt": "2026-05-06T12:37:03.451Z",
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