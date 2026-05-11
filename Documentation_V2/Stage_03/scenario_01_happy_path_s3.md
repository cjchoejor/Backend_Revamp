# Stage 03 scenario — scenario_01_happy_path_s3

- Base URL: `http://localhost:4000/api`
- Passed: **7/7**

## Steps

### Create provisional folio + fix billing model
- **Pass**: YES
- **API**: POST `/entries/9c3c4b3b-e1e5-4685-be1d-a7ce08898404/folio/provisional` → 201
- **Response JSON**:

```json
{
  "id": "77347477-821d-4d5b-af6a-cea33c5ee3c5",
  "entryId": "9c3c4b3b-e1e5-4685-be1d-a7ce08898404",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-05-07T09:50:59.475Z",
  "createdBy": "stage03-fd-1",
  "convertedToLiveAt": null,
  "convertedBy": null,
  "closedAt": null,
  "closedBy": null,
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": false,
  "invoices": [
    {
      "id": "f2e2bf30-473e-4f13-a72c-222154ea785f",
      "folioId": "77347477-821d-4d5b-af6a-cea33c5ee3c5",
      "entryId": "9c3c4b3b-e1e5-4685-be1d-a7ce08898404",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-05-07T09:50:59.478Z",
      "issuedBy": "stage03-fd-1",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-05-07T09:50:59.480Z"
    }
  ]
}
```

### Record cancellation disclosure
- **Pass**: YES
- **API**: POST `/entries/9c3c4b3b-e1e5-4685-be1d-a7ce08898404/disclosures/cancellation` → 201
- **Response JSON**:

```json
{
  "id": "0acec2c1-4c1c-4d76-8986-355c3077a456",
  "entryId": "9c3c4b3b-e1e5-4685-be1d-a7ce08898404",
  "segmentId": "3d3d19cc-12f1-41d5-8d32-4d218be153db",
  "noShowTreatmentStatement": "No-show treated as 1-night charge",
  "disclosedTerms": {
    "tier": "DEFAULT"
  },
  "disclosedAt": "2026-05-07T09:50:59.488Z",
  "disclosedBy": "stage03-fd-1"
}
```

### Record advance payment
- **Pass**: YES
- **API**: POST `/folios/77347477-821d-4d5b-af6a-cea33c5ee3c5/payments` → 201
- **Response JSON**:

```json
{
  "id": "3e4ca912-d554-47fe-b9db-82393898cdcb",
  "folioId": "77347477-821d-4d5b-af6a-cea33c5ee3c5",
  "invoiceId": null,
  "entryId": "9c3c4b3b-e1e5-4685-be1d-a7ce08898404",
  "amount": "1",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-05-07T09:50:59.498Z",
  "receivedAt": "2026-05-07T09:50:59.496Z",
  "recordedBy": "stage03-fd-1",
  "stage": "S3",
  "notes": "seed threshold is 1"
}
```

### Reconcile advance payment
- **Pass**: YES
- **API**: POST `/folios/77347477-821d-4d5b-af6a-cea33c5ee3c5/advance-payment/reconcile` → 200
- **Response JSON**:

```json
{
  "id": "77347477-821d-4d5b-af6a-cea33c5ee3c5",
  "entryId": "9c3c4b3b-e1e5-4685-be1d-a7ce08898404",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-05-07T09:50:59.475Z",
  "createdBy": "stage03-fd-1",
  "convertedToLiveAt": null,
  "convertedBy": null,
  "closedAt": null,
  "closedBy": null,
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```

### Place committed hold
- **Pass**: YES
- **API**: POST `/entries/9c3c4b3b-e1e5-4685-be1d-a7ce08898404/holds/committed` → 201
- **Response JSON**:

```json
{
  "id": "95f759dd-eab1-460f-8fce-33f853f9efa3",
  "entryId": "9c3c4b3b-e1e5-4685-be1d-a7ce08898404",
  "segmentId": "3d3d19cc-12f1-41d5-8d32-4d218be153db",
  "roomId": "97ff364f-8c46-49ed-9861-0a55e703009a",
  "spaceId": null,
  "roomTypeId": "aebac64a-ef69-4ff6-8e47-b2527411e9c9",
  "state": "PLACED",
  "placedAt": "2026-05-07T09:50:59.525Z",
  "placedBy": "stage03-fd-1",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "S3 setup",
  "ttlSeconds": 3600,
  "expiresAt": "2026-05-07T10:50:59.525Z"
}
```

### Dispatch PI (opens W22 + W34 timers)
- **Pass**: YES
- **API**: POST `/invoices/f2e2bf30-473e-4f13-a72c-222154ea785f/dispatch` → 200
- **Response JSON**:

```json
{
  "id": "f2e2bf30-473e-4f13-a72c-222154ea785f",
  "folioId": "77347477-821d-4d5b-af6a-cea33c5ee3c5",
  "entryId": "9c3c4b3b-e1e5-4685-be1d-a7ce08898404",
  "invoiceType": "PROFORMA",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": "proforma-v1",
  "issuedAt": "2026-05-07T09:50:59.478Z",
  "issuedBy": "stage03-fd-1",
  "dispatchedAt": "2026-05-07T09:50:59.551Z",
  "dispatchedBy": "stage03-fd-1",
  "dispatchedTo": "guest@example.com",
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "basis": "S3 setup",
    "dispatchedAt": "2026-05-07T09:50:59.551Z",
    "dispatchedBy": "stage03-fd-1"
  },
  "createdAt": "2026-05-07T09:50:59.480Z"
}
```

### W22 scheduled; W34 absent because payment satisfied
- **Pass**: YES
- **Notes**: w22=5a7d3c86-3651-4756-a36e-664d080099b3 w34=none