# Stage 01 scenario — scenario_05_deficient_ack_required

- Base URL: `http://localhost:4000/api`
- Passed: **2/2**

## Steps

### Selecting DEFICIENT without acknowledgement rejected
- **Pass**: YES
- **API**: PATCH `/availability/configurations/26f1e0c1-eab8-42cb-9b80-74fd6519a0f3/select` → 400
- **Response JSON**:

```json
{
  "error": "ValidationError",
  "message": "deficientAcknowledgements is required when selecting a DEFICIENT room"
}
```

### Selecting DEFICIENT with acknowledgement succeeds
- **Pass**: YES
- **API**: PATCH `/availability/configurations/26f1e0c1-eab8-42cb-9b80-74fd6519a0f3/select` → 200
- **Response JSON**:

```json
{
  "id": "26f1e0c1-eab8-42cb-9b80-74fd6519a0f3",
  "entryId": "3f9b0ed1-1099-4918-8781-9d951520ab6a",
  "segmentId": null,
  "searchCriteria": {
    "checkInDate": "2026-05-07T12:37:03.595Z",
    "checkOutDate": "2026-05-08T12:37:03.595Z"
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
    "searchTimestamp": "2026-05-06T12:37:03.600Z",
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
    "roomId": "6f0fc7e0-69ff-4575-8df7-7f809ffb47a8",
    "isDeficient": true
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": [
    {
      "acknowledgedAt": "2026-05-06T12:37:03.605Z",
      "acknowledgedBy": "stage01-fd-1"
    }
  ],
  "sealedAt": null,
  "createdAt": "2026-05-06T12:37:03.601Z",
  "createdBy": "stage01-fd-1"
}
```