# Stage 01 scenario — scenario_03_inquiry_park_unpark

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Park inquiry
- **Pass**: YES
- **API**: POST `/inquiries/ab629e5b-a543-4b51-bf6d-e65acc46840e/park` → 200
- **Response JSON**:

```json
{
  "ok": true
}
```

### Entry status became PARKED
- **Pass**: YES
- **Notes**: Observed status=PARKED

### Unpark inquiry
- **Pass**: YES
- **API**: POST `/inquiries/ab629e5b-a543-4b51-bf6d-e65acc46840e/unpark` → 200
- **Response JSON**:

```json
{
  "ok": true
}
```

### Entry status became ACTIVE
- **Pass**: YES
- **Notes**: Observed status=ACTIVE