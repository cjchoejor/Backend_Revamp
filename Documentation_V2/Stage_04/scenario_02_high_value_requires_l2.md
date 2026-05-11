# Stage 04 scenario — scenario_02_high_value_requires_l2

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### L1 blocked
- **Pass**: YES
- **API**: POST `/entries/c6baf7c0-7d07-499b-9f52-5f655443b627/confirm` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "High-value confirmation requires FOM",
  "blockingCondition": "AUTH_REQUIRED_L2"
}
```