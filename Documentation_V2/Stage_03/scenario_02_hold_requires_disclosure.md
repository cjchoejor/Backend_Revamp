# Stage 03 scenario — scenario_02_hold_requires_disclosure

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### Committed hold blocked
- **Pass**: YES
- **API**: POST `/entries/3f1c1649-697d-48dd-a593-dc595232d090/holds/committed` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Cancellation disclosure is required before committed hold",
  "blockingCondition": "CANCELLATION_DISCLOSURE_REQUIRED"
}
```