# Stage 03 scenario — scenario_04_credit_extension_rules

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### CeilingAmount=0 blocked
- **Pass**: YES
- **API**: POST `/entries/4edadaed-460a-4e38-8dd7-daea7844b84e/credit-extension` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "ceilingAmount must be > 0",
  "blockingCondition": "MISSING_CEILING_AMOUNT"
}
```

### Credit extension approved
- **Pass**: YES
- **API**: POST `/entries/4edadaed-460a-4e38-8dd7-daea7844b84e/credit-extension` → 201
- **Response JSON**:

```json
{
  "id": "401cd52e-47a5-4111-8dc5-68b60b4ced92",
  "folioId": "8ab36de8-aadd-4848-a947-d75ba67f2dfd",
  "entryId": "4edadaed-460a-4e38-8dd7-daea7844b84e",
  "ceilingAmount": "1000",
  "currency": "BTN",
  "approvedBy": "stage03-fom-1",
  "approvedAt": "2026-05-07T09:50:59.970Z",
  "reason": "corporate credit",
  "createdAt": "2026-05-07T09:50:59.972Z"
}
```

### FolioId stable
- **Pass**: YES