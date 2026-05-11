# Stage 02 scenario — scenario_10_validity_lapsed_blocks_exit

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### S2→S3 blocked due to validity lapsed
- **Pass**: YES
- **API**: POST `/entries/6948f988-81d3-422b-9956-346cdfafe325/progress-stage` → 409
- **Response JSON**:

```json
{
  "error": "StageGateBlockedError",
  "message": "Accepted quotation validity lapsed; revalidation required",
  "blockingCondition": "QUOTATION_VALIDITY_LAPSED"
}
```