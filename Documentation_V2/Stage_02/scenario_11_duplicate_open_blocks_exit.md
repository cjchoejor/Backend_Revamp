# Stage 02 scenario — scenario_11_duplicate_open_blocks_exit

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### S2→S3 blocked due to duplicate OPEN
- **Pass**: YES
- **API**: POST `/entries/0d32f229-caa4-4985-beb9-dd9d35ea70a7/progress-stage` → 409
- **Response JSON**:

```json
{
  "error": "StateTransitionError",
  "message": "Entry is not at S2"
}
```