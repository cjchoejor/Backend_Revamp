# Stage 02 scenario — scenario_07_ack_open_loop_blocks_exit

- Base URL: `http://localhost:4000/api`
- Passed: **4/4**

## Steps

### Ack window exceeded recorded (precondition)
- **Pass**: YES
- **Notes**: traceId=ae5e0334-0618-453a-916c-1bb4b9f5433f

### S2→S3 blocked until open loop resolved
- **Pass**: YES
- **API**: POST `/entries/043ec8f3-0ad3-4d5a-837b-22c530e189d9/progress-stage` → 409
- **Response JSON**:

```json
{
  "error": "StageGateBlockedError",
  "message": "Acknowledgement window exceeded; open loop must be resolved before exit",
  "blockingCondition": "ACK_OPEN_LOOP_UNRESOLVED"
}
```

### FOM resolves ack open loop
- **Pass**: YES
- **API**: POST `/quotations/9e5141f0-255c-46c5-b3c8-d57724107780/ack-open-loop/resolve` → 200
- **Response JSON**:

```json
{
  "ok": true,
  "quotationId": "9e5141f0-255c-46c5-b3c8-d57724107780"
}
```

### S2→S3 succeeds after resolution
- **Pass**: YES
- **API**: POST `/entries/043ec8f3-0ad3-4d5a-837b-22c530e189d9/progress-stage` → 200
- **Response JSON**:

```json
{
  "id": "043ec8f3-0ad3-4d5a-837b-22c530e189d9",
  "inquiryId": "6bf07af8-b08c-48e5-ac05-1477a651855e",
  "guestProfileId": "4737c121-916b-484c-a71c-dc3e34f2dbe8",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S3",
  "walkInCompressed": false,
  "checkInDate": "2026-05-08T08:54:35.970Z",
  "checkOutDate": "2026-05-09T08:54:35.970Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-07T08:54:35.975Z",
  "updatedAt": "2026-05-07T08:54:38.126Z",
  "createdBy": "stage02-fd-1",
  "version": 3,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null,
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```