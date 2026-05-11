# Stage 03 scenario — scenario_07_foc_requires_gm

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### FOC hold blocked without GM approval
- **Pass**: YES
- **API**: POST `/entries/d68aa162-590a-4677-829e-342c3d46fa04/holds/committed` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "GM approval required for FOC inclusion",
  "blockingCondition": "FOC_GM_APPROVAL_REQUIRED"
}
```

### GM approves FOC
- **Pass**: YES
- **API**: POST `/entries/d68aa162-590a-4677-829e-342c3d46fa04/foc/gm-approve` → 200
- **Response JSON**:

```json
{
  "ok": true,
  "entryId": "d68aa162-590a-4677-829e-342c3d46fa04"
}
```

### FOC hold succeeds after GM approval
- **Pass**: YES
- **API**: POST `/entries/d68aa162-590a-4677-829e-342c3d46fa04/holds/committed` → 201
- **Response JSON**:

```json
{
  "id": "0a9a6ea3-222c-4ac8-a6ae-04bb54a5e562",
  "entryId": "d68aa162-590a-4677-829e-342c3d46fa04",
  "segmentId": "5c91938a-a1d2-460c-869f-9060cc225563",
  "roomId": "918edeac-ab2f-46ad-8fcf-13a153f3631a",
  "spaceId": null,
  "roomTypeId": "aebac64a-ef69-4ff6-8e47-b2527411e9c9",
  "state": "PLACED",
  "placedAt": "2026-05-07T09:51:03.075Z",
  "placedBy": "stage03-fd-1",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "FOC hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-05-07T10:51:03.075Z"
}
```