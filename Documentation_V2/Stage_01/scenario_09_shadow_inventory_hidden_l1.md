# Stage 01 scenario — scenario_09_shadow_inventory_hidden_l1

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### L1 does not see shadow room 401
- **Pass**: YES
- **API**: POST `/entries/d9f4a6a5-e03d-408a-aac6-235512a57d09/availability/query` → 200
- **Response JSON**:

```json
{
  "configuration": {
    "id": "5e572864-4b28-4424-b539-51e9222ea4d5",
    "entryId": "d9f4a6a5-e03d-408a-aac6-235512a57d09",
    "segmentId": null,
    "searchCriteria": {
      "checkInDate": "2026-05-07T12:37:10.485Z",
      "checkOutDate": "2026-05-08T12:37:10.485Z"
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
      "searchTimestamp": "2026-05-06T12:37:10.491Z",
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
    "createdAt": "2026-05-06T12:37:10.492Z",
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
    "searchTimestamp": "2026-05-06T12:37:10.491Z",
    "isRevalidationRequired": false
  }
}
```