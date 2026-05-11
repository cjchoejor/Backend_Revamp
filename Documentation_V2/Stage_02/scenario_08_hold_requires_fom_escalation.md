# Stage 02 scenario — scenario_08_hold_requires_fom_escalation

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### L1 blocked; escalation required
- **Pass**: YES
- **API**: POST `/entries/35620a54-c531-4536-8f0d-9dd0ebaa76f0/holds/speculative` → 409
- **Response JSON**:

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Speculative hold requires FOM authority",
  "blockingCondition": "SPECULATIVE_HOLD_REQUIRES_ESCALATION"
}
```