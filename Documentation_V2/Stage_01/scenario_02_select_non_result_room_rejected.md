# Stage 01 scenario — scenario_02_select_non_result_room_rejected

- Base URL: `http://localhost:4000/api`
- Passed: **1/1**

## Steps

### Select non-result roomId rejected
- **Pass**: YES
- **API**: PATCH `/availability/configurations/01e318f6-fab9-4d04-8dad-0ef88ffbd4f5/select` → 400
- **Request JSON**:

```json
{
  "roomId": "00000000-0000-0000-0000-000000000000"
}
```
- **Response JSON**:

```json
{
  "error": "ValidationError",
  "message": "roomId must be selected from the persisted AvailabilityConfiguration resultSet"
}
```