# Stage 02 scenario — scenario_02_discount_requires_approval

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Create DRAFT quotation with discount request
- **Pass**: YES
- **API**: POST `/entries/f9b58a96-0298-47ff-ba39-cd201e514b42/quotations` → 201
- **Response JSON**:

```json
{
  "id": "b381901b-cf35-4926-b24b-55d2d9b8dcc4",
  "entryId": "f9b58a96-0298-47ff-ba39-cd201e514b42",
  "segmentId": "b5e8b466-028b-44b2-8a7d-3a76d6b25f07",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "cbe6d1a6-6cc6-444c-82c0-7d28d0b6d9b8",
    "requestedDiscount": {
      "discountBasis": "promo",
      "discountPercent": 15
    },
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
  "createdAt": "2026-05-07T08:54:30.937Z",
  "createdBy": "stage02-fd-1"
}
```

### Send blocked without approval
- **Pass**: YES
- **API**: POST `/quotations/b381901b-cf35-4926-b24b-55d2d9b8dcc4/send` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Quotation has a discount without recorded approval",
  "blockingCondition": "DISCOUNT_UNAPPROVED"
}
```

### FOM approves discount
- **Pass**: YES
- **API**: POST `/quotations/b381901b-cf35-4926-b24b-55d2d9b8dcc4/discount/approve` → 200
- **Response JSON**:

```json
{
  "ok": true
}
```

### Send succeeds after approval
- **Pass**: YES
- **API**: POST `/quotations/b381901b-cf35-4926-b24b-55d2d9b8dcc4/send` → 200
- **Response JSON**:

```json
{
  "id": "b381901b-cf35-4926-b24b-55d2d9b8dcc4",
  "entryId": "f9b58a96-0298-47ff-ba39-cd201e514b42",
  "segmentId": "b5e8b466-028b-44b2-8a7d-3a76d6b25f07",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "cbe6d1a6-6cc6-444c-82c0-7d28d0b6d9b8",
    "requestedDiscount": {
      "discountBasis": "promo",
      "discountPercent": 15
    },
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-05-09T08:54:30.955Z",
  "sentAt": "2026-05-07T08:54:30.955Z",
  "sentTo": "guest@example.com",
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-05-07T08:54:30.937Z",
  "createdBy": "stage02-fd-1"
}
```