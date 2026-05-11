# Stage 03 scenario — scenario_09_payment_milestones_w21

- Base URL: `http://localhost:4000/api`
- Passed: **3/3**

## Steps

### Schedule milestones
- **Pass**: YES
- **API**: POST `/entries/b8d8bab2-2827-4213-adfa-33bbc09b23b8/payment-milestones/schedule` → 201
- **Response JSON**:

```json
{
  "ok": true,
  "entryId": "b8d8bab2-2827-4213-adfa-33bbc09b23b8",
  "scheduled": [
    {
      "milestone": "M1",
      "timerRecordId": "107c4b34-f357-4ba4-a305-81c67015e5c0",
      "dueAt": "2026-05-07T09:51:03.330Z"
    }
  ]
}
```

### TimerRecord exists
- **Pass**: YES
- **Notes**: timerId=107c4b34-f357-4ba4-a305-81c67015e5c0

### W21 worker emitted trace
- **Pass**: YES
- **Notes**: traceId=4b75ebc7-f620-4461-b8d5-45120bb0ccd7