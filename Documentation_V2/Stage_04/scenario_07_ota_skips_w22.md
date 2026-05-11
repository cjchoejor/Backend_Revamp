# Stage 04 scenario — scenario_07_ota_skips_w22

- Base URL: `http://localhost:4000/api`
- Passed: **2/2**

## Steps

### Confirm OTA entry
- **Pass**: YES
- **API**: POST `/entries/2afc79aa-8f3e-4f96-b701-8d8c5c2ebff2/confirm` → 200
- **Response JSON**:

```json
{
  "reservation": {
    "id": "bc48a13b-1370-4584-86c7-66890a782cb6",
    "entryId": "2afc79aa-8f3e-4f96-b701-8d8c5c2ebff2",
    "segmentId": "cfa89bef-d18c-42b2-8f37-38289aa47222",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {},
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-06-06T12:05:15.731Z",
    "frozenCheckOutDate": "2026-06-07T12:05:15.731Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-05-07T12:05:15.910Z",
    "confirmedBy": "staff-frontdesk-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-05-07T12:05:15.910Z"
  },
  "entry": {
    "id": "2afc79aa-8f3e-4f96-b701-8d8c5c2ebff2",
    "inquiryId": "97d35b62-2c56-4447-95ea-c15f02ce6429",
    "guestProfileId": "52bea822-acd1-47a8-836a-e34fb61e6e69",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-06-06T12:05:15.731Z",
    "checkOutDate": "2026-06-07T12:05:15.731Z",
    "guestCount": 1,
    "otaSource": true,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-05-07T12:05:15.736Z",
    "updatedAt": "2026-05-07T12:05:15.921Z",
    "createdBy": "staff-frontdesk-1",
    "version": 4,
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
}
```

### No S4 voucher W22 scheduled
- **Pass**: YES
- **Notes**: commId=d576ce9f-d984-49e8-90b1-744f987402f0 w22=none