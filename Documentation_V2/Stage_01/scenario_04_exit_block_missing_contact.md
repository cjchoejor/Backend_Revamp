# Stage 01 scenario — scenario_04_exit_block_missing_contact

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### Progress S1→S2 rejected without contact details
- **Pass**: YES
- **API**: POST `/entries/a4b9658b-257f-43a5-bbdd-9ef61b4711b8/progress-stage` → 409
- **Response JSON**:

```json
{
  "error": "StageGateBlockedError",
  "message": "Primary contact details required on GuestProfile",
  "blockingCondition": "MISSING_PRIMARY_CONTACT"
}
```