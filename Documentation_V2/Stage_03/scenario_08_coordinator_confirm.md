# Stage 03 scenario — scenario_08_coordinator_confirm

- Base URL: `http://localhost:4000/api`
- Passed: **2/2**

## Steps

### Coordinator confirmed
- **Pass**: YES
- **API**: POST `/entries/05531046-f07b-4868-b6de-aa8eb695e3c3/coordinator/confirm` → 200
- **Response JSON**:

```json
{
  "ok": true,
  "entryId": "05531046-f07b-4868-b6de-aa8eb695e3c3",
  "workOrderId": "ab87e6b4-6547-4295-a153-8be3787e0669"
}
```

### TraceEvent recorded
- **Pass**: YES
- **Notes**: traceId=497d79e1-f791-40f2-97d4-12489bec9fb1