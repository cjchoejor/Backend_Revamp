# Stage 01 scenario — scenario_07_w16_reconfirm_delta

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Place processing lock
- **Pass**: YES
- **API**: POST `/processing-locks` → 201
- **Response JSON**:

```json
{
  "lock": {
    "id": "9900efb1-6977-4f71-a87b-efc01a31a577",
    "actorId": "stage01-fd-1",
    "channel": "FRONT_DESK",
    "inventoryReference": "INV",
    "entryId": "20a9b349-ff03-4d72-8393-a671d8bae409",
    "segmentId": null,
    "placedAt": "2026-05-06T12:37:06.240Z",
    "ttlSeconds": 600,
    "expiresAt": "2026-05-06T12:47:06.240Z",
    "status": "ACTIVE",
    "expiredAt": null,
    "releasedAt": null,
    "revalidationCount": 0,
    "pgBossJobId": "2032dbe2-fa8e-41ae-a1f6-b3777299502b",
    "createdAt": "2026-05-06T12:37:06.245Z"
  },
  "meta": {}
}
```

### Lock became EXPIRED
- **Pass**: YES
- **Notes**: Observed status=EXPIRED

### Reconfirm created new lock + delta
- **Pass**: YES
- **API**: POST `/processing-locks/9900efb1-6977-4f71-a87b-efc01a31a577/reconfirm` → 200
- **Response JSON**:

```json
{
  "newLock": {
    "id": "54dbee13-05bf-4c10-982f-f7c5cf83eeb0",
    "actorId": "stage01-fd-1",
    "channel": "FRONT_DESK",
    "inventoryReference": "INV",
    "entryId": "20a9b349-ff03-4d72-8393-a671d8bae409",
    "segmentId": null,
    "placedAt": "2026-05-06T12:37:08.394Z",
    "ttlSeconds": 600,
    "expiresAt": "2026-05-06T12:47:08.394Z",
    "status": "ACTIVE",
    "expiredAt": null,
    "releasedAt": null,
    "revalidationCount": 1,
    "pgBossJobId": null,
    "createdAt": "2026-05-06T12:37:08.396Z"
  },
  "previousLockId": "9900efb1-6977-4f71-a87b-efc01a31a577",
  "revalidationDelta": {
    "id": "ee19a69e-7060-4996-9686-b91b7efcc451",
    "processingLockId": "54dbee13-05bf-4c10-982f-f7c5cf83eeb0",
    "availabilityChanged": false,
    "deficientStatusChanged": false,
    "pricingChanged": false,
    "availabilityDelta": null,
    "deficientDelta": null,
    "pricingDelta": null,
    "createdAt": "2026-05-06T12:37:08.401Z",
    "createdBy": "stage01-fd-1"
  }
}
```