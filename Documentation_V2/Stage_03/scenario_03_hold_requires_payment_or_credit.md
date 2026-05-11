# Stage 03 scenario — scenario_03_hold_requires_payment_or_credit

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Folio created
- **Pass**: YES
- **Response JSON**:

```json
{
  "id": "4d3c2198-c31c-4e08-bf15-8fea0932f9fd",
  "entryId": "d788e50d-69d5-48c4-83c7-a905791a294a",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-05-07T09:50:59.824Z",
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
      "id": "1512f4e7-dd76-4ec8-99c2-f305b2b7c9c1",
      "folioId": "4d3c2198-c31c-4e08-bf15-8fea0932f9fd",
      "entryId": "d788e50d-69d5-48c4-83c7-a905791a294a",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-05-07T09:50:59.824Z",
      "issuedBy": "stage03-fd-1",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-05-07T09:50:59.825Z"
    }
  ]
}
```

### Disclosure recorded
- **Pass**: YES
- **Response JSON**:

```json
{
  "id": "fc8abe3b-7cd6-401e-8545-5c85c7d08f2f",
  "entryId": "d788e50d-69d5-48c4-83c7-a905791a294a",
  "segmentId": "3a3acd0b-cae1-42e1-a88f-4c24672b9767",
  "noShowTreatmentStatement": "No-show treated as 1-night charge",
  "disclosedTerms": {},
  "disclosedAt": "2026-05-07T09:50:59.830Z",
  "disclosedBy": "stage03-fd-1"
}
```

### Committed hold blocked without payment/credit
- **Pass**: YES
- **API**: POST `/entries/d788e50d-69d5-48c4-83c7-a905791a294a/holds/committed` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Advance payment threshold not satisfied (credit extension required)",
  "blockingCondition": "ADVANCE_PAYMENT_NOT_SATISFIED"
}
```