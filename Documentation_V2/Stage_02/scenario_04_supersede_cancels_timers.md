# Stage 02 scenario — scenario_04_supersede_cancels_timers

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Send v1
- **Pass**: YES
- **API**: POST `/quotations/bc376901-d4b0-4cc8-8eb4-118ba0810357/send` → 200
- **Response JSON**:

```json
{
  "id": "bc376901-d4b0-4cc8-8eb4-118ba0810357",
  "entryId": "3742a0bc-3914-4740-831b-5a6ab872dbcb",
  "segmentId": "c8a34e47-94e0-4684-89de-a9017c4577c6",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "notes": "v1",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "cbe6d1a6-6cc6-444c-82c0-7d28d0b6d9b8",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-05-09T08:54:32.159Z",
  "sentAt": "2026-05-07T08:54:32.159Z",
  "sentTo": "guest@example.com",
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-05-07T08:54:32.153Z",
  "createdBy": "stage02-fd-1"
}
```

### Supersede creates v2 DRAFT
- **Pass**: YES
- **API**: POST `/quotations/bc376901-d4b0-4cc8-8eb4-118ba0810357/supersede` → 201
- **Response JSON**:

```json
{
  "id": "ee42ce0d-8bb1-403e-a9e3-e3f224632f33",
  "entryId": "3742a0bc-3914-4740-831b-5a6ab872dbcb",
  "segmentId": "c8a34e47-94e0-4684-89de-a9017c4577c6",
  "versionNumber": 2,
  "referenceNumber": "Q-002",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "v2 changes",
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
  "createdAt": "2026-05-07T08:54:32.197Z",
  "createdBy": "stage02-fd-1"
}
```

### Prior quotation is SUPERSEDED and timers cancelled
- **Pass**: YES
- **Notes**: oldState=SUPERSEDED; timers=QUOTATION_VALIDITY_W15:CANCELLED, QUOTATION_ACK_TRACKER:CANCELLED