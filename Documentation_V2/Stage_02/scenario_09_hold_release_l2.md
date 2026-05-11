# Stage 02 scenario — scenario_09_hold_release_l2

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Hold placed by L2
- **Pass**: YES
- **API**: POST `/entries/7080c13e-2624-4121-b78e-51986c64e912/holds/speculative` → 201
- **Response JSON**:

```json
{
  "id": "79ba5eda-7fed-4793-906e-0a2cf3b0918f",
  "entryId": "7080c13e-2624-4121-b78e-51986c64e912",
  "segmentId": "f1ead52e-7875-433e-ba92-9a973a183f19",
  "roomId": "bf4735e9-5082-4dae-bb36-2b5d0f680066",
  "spaceId": null,
  "state": "PLACED",
  "placedAt": "2026-05-07T08:54:38.277Z",
  "placedBy": "stage02-fom-1",
  "ttlSeconds": 120,
  "expiresAt": "2026-05-07T08:56:38.277Z",
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "upgradedToId": null,
  "notes": "release test",
  "createdAt": "2026-05-07T08:54:38.284Z"
}
```

### Hold released by L2
- **Pass**: YES
- **API**: POST `/entries/7080c13e-2624-4121-b78e-51986c64e912/holds/speculative/79ba5eda-7fed-4793-906e-0a2cf3b0918f/release` → 200
- **Response JSON**:

```json
{
  "id": "79ba5eda-7fed-4793-906e-0a2cf3b0918f",
  "entryId": "7080c13e-2624-4121-b78e-51986c64e912",
  "segmentId": "f1ead52e-7875-433e-ba92-9a973a183f19",
  "roomId": "bf4735e9-5082-4dae-bb36-2b5d0f680066",
  "spaceId": null,
  "state": "RELEASED",
  "placedAt": "2026-05-07T08:54:38.277Z",
  "placedBy": "stage02-fom-1",
  "ttlSeconds": 120,
  "expiresAt": "2026-05-07T08:56:38.277Z",
  "releasedAt": "2026-05-07T08:54:38.294Z",
  "releasedBy": "stage02-fom-1",
  "releaseReason": "Guest changed mind",
  "upgradedToId": null,
  "notes": "release test",
  "createdAt": "2026-05-07T08:54:38.284Z"
}
```

### Room is FREE after release
- **Pass**: YES
- **Notes**: roomState=FREE