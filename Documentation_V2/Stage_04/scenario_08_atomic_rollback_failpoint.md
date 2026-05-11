# Stage 04 scenario — scenario_08_atomic_rollback_failpoint

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Confirm fails at failpoint
- **Pass**: YES
- **API**: POST `/entries/de864cb4-dcb9-4e93-9f6f-cfe2d4bafa20/confirm` → 500
- **Request JSON**:

```json
{
  "version": 3,
  "failpoint": "AFTER_HOLD_CONFIRMED"
}
```
- **Response JSON**:

```json
{
  "error": "InternalError",
  "message": "Unexpected server error"
}
```

### CommittedHold still PLACED (rolled back)
- **Pass**: YES
- **Notes**: state=PLACED

### Room claim state unchanged
- **Pass**: YES
- **Notes**: before=COMMITTED_HELD after=COMMITTED_HELD

### No Reservation created
- **Pass**: YES
- **Notes**: reservationId=none