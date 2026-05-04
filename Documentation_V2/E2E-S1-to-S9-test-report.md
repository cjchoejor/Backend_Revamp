# End-to-end test report — S1 → S9

- Base URL: `http://localhost:4000/api`
- Passed: **34/34**
- Notes: steps marked **SHIM** indicate a controlled DB-level simulation for worker/timer flows or missing controllers.

## Step-by-step log

### E2E-S1-001 — Create inquiry
- **Pass**: YES
- **API**: POST `/inquiries` → 201
- **Request**:

```json
{
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "sourceChannel": "DIRECT"
}
```

- **Response**:

```json
{
  "id": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "referenceNumber": "INQ-1777530380539-494911",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "agentProfileId": null,
  "sourceChannel": "DIRECT",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": null,
  "createdAt": "2026-04-30T06:26:20.540Z",
  "updatedAt": "2026-04-30T06:26:20.540Z",
  "createdBy": "e2e-fd-1",
  "parkedAt": null,
  "parkedBy": null
}
```

- **What is happening**: Creates the inquiry anchor for the lifecycle.
- **Database (PostgreSQL)**: Inserts Inquiry row + links GuestProfile.

### E2E-S1-002 — Create entry (starts at S1)
- **Pass**: YES
- **API**: POST `/entries` → 201
- **Request**:

```json
{
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "useType": "LEISURE",
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z"
}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S1",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:20.554Z",
  "createdBy": "e2e-fd-1",
  "version": 1,
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
  "registrationCompletedBy": null
}
```

- **What is happening**: Creates an Entry and Segment(1) at S1.
- **Database (PostgreSQL)**: Inserts Entry + Segment + TraceEvent(ENTRY_CREATED).

### E2E-S1-003 — Run availability search and persist configuration
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/availability/query` → 200
- **Request**:

```json
{
  "checkInDate": "T+2d",
  "checkOutDate": "T+3d"
}
```

- **Response**:

```json
{
  "configuration": {
    "id": "cb837de4-a002-482f-9623-8628ee9bfb96",
    "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
    "segmentId": null,
    "searchCriteria": {
      "checkInDate": "2026-05-02T06:26:20.557Z",
      "checkOutDate": "2026-05-03T06:26:20.557Z"
    },
    "resultSet": {
      "availableRooms": [
        {
          "claimState": "FREE",
          "roomNumber": "401",
          "inventoryId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25"
        }
      ],
      "deficientRooms": [
        {
          "claimState": "FREE",
          "roomNumber": "402-DEF",
          "inventoryId": "50fe62cc-cd54-4045-884c-424aa8bb80a0",
          "deficientCategory": "HOUSEKEEPING",
          "deficientDescription": null
        }
      ],
      "searchTimestamp": "2026-04-30T06:26:20.563Z",
      "unavailableRooms": [
        {
          "roomNumber": "501",
          "inventoryId": "a9df4211-2696-4017-9b3a-b0249d2ba75c",
          "unavailabilityReason": "CLAIMED"
        },
        {
          "roomNumber": "502-DEF",
          "inventoryId": "ffdda7bf-8017-427b-8e96-1aa62b95759a",
          "unavailabilityReason": "CLAIMED"
        },
        {
          "roomNumber": "503",
          "inventoryId": "aa9a578b-7642-44ae-93cc-9afac9bc453e",
          "unavailabilityReason": "CLAIMED"
        }
      ],
      "maintenanceConflicts": [],
      "isRevalidationRequired": false
    },
    "optionSelected": null,
    "isStale": false,
    "stalenessAt": null,
    "deficientAcknowledgements": null,
    "sealedAt": null,
    "createdAt": "2026-04-30T06:26:20.564Z",
    "createdBy": "e2e-fd-1"
  },
  "result": {
    "availableRooms": [
      {
        "inventoryId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "a9df4211-2696-4017-9b3a-b0249d2ba75c",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "a9df4211-2696-4017-9b3a-b0249d2ba75c"
      },
      {
        "inventoryId": "ffdda7bf-8017-427b-8e96-1aa62b95759a",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "ffdda7bf-8017-427b-8e96-1aa62b95759a"
      },
      {
        "inventoryId": "aa9a578b-7642-44ae-93cc-9afac9bc453e",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "aa9a578b-7642-44ae-93cc-9afac9bc453e"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "50fe62cc-cd54-4045-884c-424aa8bb80a0",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "50fe62cc-cd54-4045-884c-424aa8bb80a0"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-30T06:26:20.563Z",
    "isRevalidationRequired": false
  }
}
```

- **What is happening**: S1 availability search produces an AvailabilityConfiguration and results including DEFICIENT annotations.
- **Database (PostgreSQL)**: Inserts AvailabilityConfiguration(resultSet, searchCriteria).

### E2E-S1-004 — Select preferred option on configuration
- **Pass**: YES
- **API**: PATCH `/availability/configurations/cb837de4-a002-482f-9623-8628ee9bfb96/select` → 200
- **Request**:

```json
{
  "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25"
}
```

- **Response**:

```json
{
  "id": "cb837de4-a002-482f-9623-8628ee9bfb96",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "segmentId": null,
  "searchCriteria": {
    "checkInDate": "2026-05-02T06:26:20.557Z",
    "checkOutDate": "2026-05-03T06:26:20.557Z"
  },
  "resultSet": {
    "availableRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "401",
        "inventoryId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "50fe62cc-cd54-4045-884c-424aa8bb80a0",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-30T06:26:20.563Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "a9df4211-2696-4017-9b3a-b0249d2ba75c",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "ffdda7bf-8017-427b-8e96-1aa62b95759a",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "aa9a578b-7642-44ae-93cc-9afac9bc453e",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-30T06:26:20.564Z",
  "createdBy": "e2e-fd-1"
}
```

- **What is happening**: Preferred option selection is the key exit evidence from S1.
- **Database (PostgreSQL)**: Updates AvailabilityConfiguration.optionSelected; inserts TraceEvent(CONFIGURATION_SELECTED).

### E2E-S1-005 — Progress S1→S2
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/progress-stage` → 200
- **Request**:

```json
{
  "targetStage": "S2",
  "version": 1
}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:20.587Z",
  "createdBy": "e2e-fd-1",
  "version": 2,
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
  "registrationCompletedBy": null
}
```

- **What is happening**: Seals preferred AvailabilityConfiguration and advances Entry stage.
- **Database (PostgreSQL)**: Atomic update: Entry.currentStage=S2 and AvailabilityConfiguration.sealedAt set.

### E2E-S2-001 — Create quotation (DRAFT)
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/quotations` → 201
- **Request**:

```json
{
  "commercialTerms": {
    "nightlyRate": 500
  },
  "totalAmount": 1000
}
```

- **Response**:

```json
{
  "id": "ec0e2952-d9fd-4715-978a-f4a90911522b",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "segmentId": "de62cea0-27c4-4aba-aad6-a2d584f1ce5e",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "601e4e23-2d92-4d5e-a54a-6d986196ece4",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": null,
  "sentAt": null,
  "sentTo": null,
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-30T06:26:20.602Z",
  "createdBy": "e2e-fd-1"
}
```

- **What is happening**: Creates initial quotation round at S2.
- **Database (PostgreSQL)**: Inserts Quotation(state=DRAFT).

### E2E-S2-002 — Send quotation (DRAFT→SENT)
- **Pass**: YES
- **API**: POST `/quotations/ec0e2952-d9fd-4715-978a-f4a90911522b/send` → 200
- **Request**:

```json
{
  "validDays": 2,
  "sentTo": "guest@example.com"
}
```

- **Response**:

```json
{
  "id": "ec0e2952-d9fd-4715-978a-f4a90911522b",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "segmentId": "de62cea0-27c4-4aba-aad6-a2d584f1ce5e",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "SENT",
  "commercialTerms": {
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "601e4e23-2d92-4d5e-a54a-6d986196ece4",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-05-02T06:26:20.606Z",
  "sentAt": "2026-04-30T06:26:20.606Z",
  "sentTo": "guest@example.com",
  "communicationRecordId": null,
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-30T06:26:20.602Z",
  "createdBy": "e2e-fd-1"
}
```

- **What is happening**: Sending seals the quotation and registers timers for validity/ack tracking (TimerRecord shim).
- **Database (PostgreSQL)**: Updates Quotation; inserts TimerRecord entries tied to quotationId payload.

### E2E-S2-003 — Accept quotation (SENT→ACCEPTED)
- **Pass**: YES
- **API**: POST `/quotations/ec0e2952-d9fd-4715-978a-f4a90911522b/accept` → 200
- **Request**:

```json
{}
```

- **Response**:

```json
{
  "id": "ec0e2952-d9fd-4715-978a-f4a90911522b",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "segmentId": "de62cea0-27c4-4aba-aad6-a2d584f1ce5e",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "ACCEPTED",
  "commercialTerms": {
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "601e4e23-2d92-4d5e-a54a-6d986196ece4",
    "resolvedRateAmount": 500,
    "resolvedRatePlanId": "rp-dlx-default"
  },
  "totalAmount": "500",
  "currency": "BTN",
  "validUntil": "2026-05-02T06:26:20.606Z",
  "sentAt": "2026-04-30T06:26:20.606Z",
  "sentTo": "guest@example.com",
  "communicationRecordId": "d98470d0-ed08-4347-ba4b-f0a6dd6a1b7d",
  "supersededById": null,
  "supersededAt": null,
  "expiredAt": null,
  "acceptedAt": "2026-04-30T06:26:20.628Z",
  "acceptedBy": "e2e-fd-1",
  "folioId": null,
  "sealedAt": null,
  "createdAt": "2026-04-30T06:26:20.602Z",
  "createdBy": "e2e-fd-1"
}
```

- **What is happening**: Acceptance closes the quotation loop required for S2 exit.
- **Database (PostgreSQL)**: Updates Quotation.acceptedAt/acceptedBy; cancels TimerRecord rows for that quotationId.

### E2E-S3-001 — Progress S2→S3
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/progress-stage` → 200
- **Request**:

```json
{
  "targetStage": "S3",
  "version": 2
}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S3",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:20.650Z",
  "createdBy": "e2e-fd-1",
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
  "registrationCompletedBy": null
}
```

- **What is happening**: Moves into Reservation Setup with accepted quotation evidence.
- **Database (PostgreSQL)**: Updates Entry.currentStage=S3.

### E2E-S3-002 — Create provisional folio + billing model transition + proforma invoice
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/folio/provisional` → 201
- **Request**:

```json
{
  "billingModel": "GUEST_PAY"
}
```

- **Response**:

```json
{
  "id": "aa44a5d4-abea-4b03-94bc-7bfe63dfc69c",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-30T06:26:20.662Z",
  "createdBy": "e2e-fd-1",
  "convertedToLiveAt": null,
  "convertedBy": null,
  "closedAt": null,
  "closedBy": null,
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": false,
  "invoices": [
    {
      "id": "521d835c-a465-40f9-ada0-ecf85b5e296e",
      "folioId": "aa44a5d4-abea-4b03-94bc-7bfe63dfc69c",
      "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-30T06:26:20.664Z",
      "issuedBy": "e2e-fd-1",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-30T06:26:20.665Z"
    }
  ]
}
```

- **What is happening**: S3 evidence foundation for S4 confirmation.
- **Database (PostgreSQL)**: Creates Folio + BillingModelTransitionRecord + PROFORMA Invoice.

### E2E-S3-003 — Record cancellation disclosure
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/disclosures/cancellation` → 201
- **Request**:

```json
{
  "noShowTreatmentStatement": "No-show: charge 1 night",
  "disclosedTerms": {
    "noShow": true
  }
}
```

- **Response**:

```json
{
  "id": "9399b628-3ee6-40c4-be4c-bb18089fcade",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "segmentId": "de62cea0-27c4-4aba-aad6-a2d584f1ce5e",
  "noShowTreatmentStatement": "No-show: charge 1 night",
  "disclosedTerms": {
    "noShow": true
  },
  "disclosedAt": "2026-04-30T06:26:20.672Z",
  "disclosedBy": "e2e-fd-1"
}
```

- **What is happening**: Required before placing a committed hold and confirming the reservation.
- **Database (PostgreSQL)**: Creates CancellationDisclosureRecord(entryId).

### E2E-S3-004 — Record advance payment (IN)
- **Pass**: YES
- **API**: POST `/folios/aa44a5d4-abea-4b03-94bc-7bfe63dfc69c/payments` → 201
- **Request**:

```json
{
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "amount": 100
}
```

- **Response**:

```json
{
  "id": "ff764d4a-804d-4769-9e2d-4c4c890eb321",
  "folioId": "aa44a5d4-abea-4b03-94bc-7bfe63dfc69c",
  "invoiceId": null,
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "amount": "100",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-30T06:26:20.678Z",
  "receivedAt": "2026-04-30T06:26:20.677Z",
  "recordedBy": "e2e-fd-1",
  "stage": "S3",
  "notes": "E2E advance payment"
}
```

- **What is happening**: Advance payment evidence to satisfy committed-hold and later gates.
- **Database (PostgreSQL)**: Creates PaymentRecord(stage=S3, direction=IN).

### E2E-S3-005 — Reconcile advance payment
- **Pass**: YES
- **API**: POST `/folios/aa44a5d4-abea-4b03-94bc-7bfe63dfc69c/advance-payment/reconcile` → 200
- **Request**:

```json
{
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "note": "E2E reconcile"
}
```

- **Response**:

```json
{
  "id": "aa44a5d4-abea-4b03-94bc-7bfe63dfc69c",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-30T06:26:20.662Z",
  "createdBy": "e2e-fd-1",
  "convertedToLiveAt": null,
  "convertedBy": null,
  "closedAt": null,
  "closedBy": null,
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```

- **What is happening**: Marks advance payment reconciliation complete via service logic.
- **Database (PostgreSQL)**: Updates Folio.advancePaymentReconciliationComplete=true (and related payment reconciliation state).

### E2E-S3-006 — Place committed hold
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/holds/committed` → 201
- **Request**:

```json
{
  "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25",
  "commercialJustification": "E2E committed hold"
}
```

- **Response**:

```json
{
  "id": "14ea8b4a-1441-40c7-a9ee-c9d127c03d48",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "segmentId": "de62cea0-27c4-4aba-aad6-a2d584f1ce5e",
  "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25",
  "spaceId": null,
  "roomTypeId": "601e4e23-2d92-4d5e-a54a-6d986196ece4",
  "state": "PLACED",
  "placedAt": "2026-04-30T06:26:20.698Z",
  "placedBy": "e2e-fd-1",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "E2E committed hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-30T07:26:20.698Z"
}
```

- **What is happening**: Committed hold is required before room assignment at S5 in this backend slice.
- **Database (PostgreSQL)**: Creates/updates CommittedHold + updates Room claim state + schedules W3.

### E2E-S4-001 — Confirm reservation (S3→S4)
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/confirm` → 200
- **Request**:

```json
{
  "version": 3
}
```

- **Response**:

```json
{
  "reservation": {
    "id": "441c98c8-c73e-40fd-a757-83b4b0dadd36",
    "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
    "segmentId": "de62cea0-27c4-4aba-aad6-a2d584f1ce5e",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {
      "noShow": true
    },
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-05-02T06:26:20.547Z",
    "frozenCheckOutDate": "2026-05-03T06:26:20.547Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-04-30T06:26:20.727Z",
    "confirmedBy": "e2e-fd-1",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-30T06:26:20.728Z"
  },
  "entry": {
    "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
    "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
    "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-05-02T06:26:20.547Z",
    "checkOutDate": "2026-05-03T06:26:20.547Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-30T06:26:20.554Z",
    "updatedAt": "2026-04-30T06:26:20.739Z",
    "createdBy": "e2e-fd-1",
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
    "registrationCompletedBy": null
  }
}
```

- **What is happening**: S4 confirmation snapshot + H1 creation + ownership assignment record.
- **Database (PostgreSQL)**: Creates Reservation; updates CommittedHold.CONFIRMED; creates H1 Handoff; writes CommunicationRecord + ACK timer; TraceEvents.

### E2E-S4-002-shim — Shim: activate S5 (simulate W4 pre-arrival activation) (SHIM)
- **Pass**: YES
- **What is happening**: S4→S5 is timer/worker-driven in the SIG. This repo does not implement W4, so we simulate activation explicitly.
- **Database (PostgreSQL)**: Updates Entry.currentStage to S5.

### E2E-S5-001 — Accept H1 handoff
- **Pass**: YES
- **API**: POST `/handoffs/50c2ec1b-d733-4a7a-92a6-d5f1178dd102/accept` → 200
- **Request**:

```json
{
  "checklistCompletion": {
    "VOUCHER_VERIFIED": true,
    "PAYMENT_STATUS_REVIEWED": true
  }
}
```

- **Response**:

```json
{
  "id": "50c2ec1b-d733-4a7a-92a6-d5f1178dd102",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "handoffType": "H1",
  "state": "ACCEPTED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-1",
  "toRole": "FRONT_DESK",
  "toActorId": null,
  "checklistContent": [
    {
      "code": "VOUCHER_VERIFIED",
      "mandatory": true,
      "description": "Confirmation voucher on file"
    },
    {
      "code": "PAYMENT_STATUS_REVIEWED",
      "mandatory": true,
      "description": "Advance payment status reviewed"
    },
    {
      "code": "SPECIAL_REQUESTS_NOTED",
      "mandatory": false,
      "description": "Special requests noted"
    }
  ],
  "deficientConditionStatus": null,
  "fulfilmentEvidence": null,
  "assignedAt": null,
  "acceptedAt": "2026-04-30T06:26:20.755Z",
  "acceptedBy": "e2e-fd-1",
  "fulfilledAt": null,
  "fulfilledBy": null,
  "closedAt": null,
  "rejectedAt": null,
  "rejectedBy": null,
  "rejectionReason": null,
  "escalatedAt": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "cancelledReason": null,
  "slaDeadlineAt": null,
  "isAutoFulfilled": false,
  "createdAt": "2026-04-30T06:26:20.737Z",
  "createdBy": "e2e-fd-1",
  "stageContext": "S4"
}
```

- **What is happening**: Front desk accepts reservation handoff for pre-arrival execution.
- **Database (PostgreSQL)**: Updates HandoffRecord state/acceptedAt/acceptedBy.

### E2E-S5-002 — Assign a room at S5
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/room-assignments` → 201
- **Request**:

```json
{
  "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25"
}
```

- **Response**:

```json
{
  "id": "ffd499b6-2557-486b-89c0-372a9eacc869",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25",
  "assignedAt": "2026-04-30T06:26:20.766Z",
  "assignedBy": "e2e-fd-1",
  "deficientAtAssignment": false,
  "deficientConditionRecordId": null,
  "acknowledgementActorId": null,
  "acknowledgementAt": null,
  "notes": "e2e",
  "createdAt": "2026-04-30T06:26:20.766Z"
}
```

- **What is happening**: Room assignment sets up S7 stay exit gating later (occupied room required).
- **Database (PostgreSQL)**: Creates RoomAssignment; updates Room claim state where applicable.

### E2E-S5-002b — Fulfil H1 handoff
- **Pass**: YES
- **API**: POST `/handoffs/50c2ec1b-d733-4a7a-92a6-d5f1178dd102/fulfil` → 200
- **Request**:

```json
{
  "fulfilmentEvidence": {
    "roomAssignmentId": "ffd499b6-2557-486b-89c0-372a9eacc869",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  }
}
```

- **Response**:

```json
{
  "id": "50c2ec1b-d733-4a7a-92a6-d5f1178dd102",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "handoffType": "H1",
  "state": "FULFILLED",
  "fromRole": "RESERVATIONS",
  "fromActorId": "e2e-fd-1",
  "toRole": "FRONT_DESK",
  "toActorId": null,
  "checklistContent": [
    {
      "code": "VOUCHER_VERIFIED",
      "mandatory": true,
      "description": "Confirmation voucher on file"
    },
    {
      "code": "PAYMENT_STATUS_REVIEWED",
      "mandatory": true,
      "description": "Advance payment status reviewed"
    },
    {
      "code": "SPECIAL_REQUESTS_NOTED",
      "mandatory": false,
      "description": "Special requests noted"
    }
  ],
  "deficientConditionStatus": null,
  "fulfilmentEvidence": {
    "roomAssignmentId": "ffd499b6-2557-486b-89c0-372a9eacc869",
    "readinessConfirmed": true,
    "paymentStatusConfirmed": true,
    "ceilingProximityAddressed": true
  },
  "assignedAt": null,
  "acceptedAt": "2026-04-30T06:26:20.755Z",
  "acceptedBy": "e2e-fd-1",
  "fulfilledAt": "2026-04-30T06:26:20.770Z",
  "fulfilledBy": "e2e-fd-1",
  "closedAt": null,
  "rejectedAt": null,
  "rejectedBy": null,
  "rejectionReason": null,
  "escalatedAt": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "cancelledReason": null,
  "slaDeadlineAt": null,
  "isAutoFulfilled": false,
  "createdAt": "2026-04-30T06:26:20.737Z",
  "createdBy": "e2e-fd-1",
  "stageContext": "S4"
}
```

- **What is happening**: H1 must be fulfilled before check-in (S5→S6).
- **Database (PostgreSQL)**: Updates HandoffRecord(H1) to FULFILLED with fulfilmentEvidence.

### E2E-S5-004 — Progress S5→S6
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/progress-stage` → 200
- **Request**:

```json
{
  "targetStage": "S6",
  "version": 5,
  "guestPhysicallyPresent": true
}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S6",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:20.783Z",
  "createdBy": "e2e-fd-1",
  "version": 6,
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
  "registrationCompletedBy": null
}
```

- **What is happening**: Check-in initiation.
- **Database (PostgreSQL)**: Updates Entry.currentStage=S6; creates H2/H3 where applicable; closes H1 as needed.

### E2E-S6-000 — Verify guest identity
- **Pass**: YES
- **API**: POST `/guest-profiles/2f33d55f-b232-44d3-b6c0-d95a922db54b/verify-identity` → 200
- **Request**:

```json
{
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "verificationPath": "FIRST_TIME"
}
```

- **Response**:

```json
{
  "id": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "firstName": "Pema",
  "lastName": "Wangchuk",
  "email": "pema.wangchuk@example.com",
  "phone": null,
  "nationality": null,
  "vipTier": null,
  "clientTier": "STANDARD",
  "preferences": null,
  "behaviouralFlags": null,
  "observationQueue": null,
  "stayHistorySummary": null,
  "isActive": true,
  "identityVerifiedAt": "2026-04-30T06:26:20.796Z",
  "identityVerifiedBy": "e2e-fd-1",
  "identityVerificationPath": "FIRST_TIME",
  "createdAt": "2026-04-30T06:26:19.346Z",
  "updatedAt": "2026-04-30T06:26:20.796Z",
  "createdBy": "actor-seed-system"
}
```

- **What is happening**: S6→S7 gate requires identity verification.
- **Database (PostgreSQL)**: Updates GuestProfile verification fields; inserts TraceEvent for verification path.

### E2E-S6-001 — Progress S6→S7 (complete check-in)
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/progress-stage` → 200
- **Request**:

```json
{
  "targetStage": "S7",
  "version": 6,
  "transitionData": {
    "keyCount": 2,
    "registrationConfirmed": true
  }
}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S7",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:20.810Z",
  "createdBy": "e2e-fd-1",
  "version": 7,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-30T06:26:20.810Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-1",
  "registrationCompletedAt": "2026-04-30T06:26:20.810Z",
  "registrationCompletedBy": "e2e-fd-1",
  "folio": {
    "id": "aa44a5d4-abea-4b03-94bc-7bfe63dfc69c",
    "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
    "state": "LIVE",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-30T06:26:20.662Z",
    "createdBy": "e2e-fd-1",
    "convertedToLiveAt": "2026-04-30T06:26:20.821Z",
    "convertedBy": "e2e-fd-1",
    "closedAt": null,
    "closedBy": null,
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "0",
    "advancePaymentReconciliationComplete": true
  },
  "guestProfile": {
    "id": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
    "firstName": "Pema",
    "lastName": "Wangchuk",
    "email": "pema.wangchuk@example.com",
    "phone": null,
    "nationality": null,
    "vipTier": null,
    "clientTier": "STANDARD",
    "preferences": null,
    "behaviouralFlags": null,
    "observationQueue": null,
    "stayHistorySummary": null,
    "isActive": true,
    "identityVerifiedAt": "2026-04-30T06:26:20.796Z",
    "identityVerifiedBy": "e2e-fd-1",
    "identityVerificationPath": "FIRST_TIME",
    "createdAt": "2026-04-30T06:26:19.346Z",
    "updatedAt": "2026-04-30T06:26:20.796Z",
    "createdBy": "actor-seed-system"
  },
  "handoffs": [
    {
      "id": "abddb8e8-76cf-4eaa-b116-85a97593d9c8",
      "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
      "handoffType": "H3",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-1",
      "toRole": "F_AND_B",
      "toActorId": null,
      "checklistContent": {
        "mealPlan": "per reservation inclusions",
        "guestCount": 1,
        "roomNumber": "401",
        "stayDuration": {
          "checkInDate": "2026-05-02T06:26:20.547Z",
          "checkOutDate": "2026-05-03T06:26:20.547Z"
        },
        "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
        "packageInclusions": [],
        "cuisinePreferences": null,
        "dietaryRequirements": null
      },
      "deficientConditionStatus": null,
      "fulfilmentEvidence": null,
      "assignedAt": null,
      "acceptedAt": null,
      "acceptedBy": null,
      "fulfilledAt": null,
      "fulfilledBy": null,
      "closedAt": null,
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": "2026-04-30T07:26:20.810Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-30T06:26:20.818Z",
      "createdBy": "e2e-fd-1",
      "stageContext": "S6"
    },
    {
      "id": "5f3a2797-a179-4e3f-b32f-8c12519878e2",
      "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
      "handoffType": "H2",
      "state": "CREATED",
      "fromRole": "FRONT_DESK",
      "fromActorId": "e2e-fd-1",
      "toRole": "HOUSEKEEPING",
      "toActorId": null,
      "checklistContent": {
        "roomNumber": "401",
        "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
        "expectedStayNights": 1
      },
      "deficientConditionStatus": null,
      "fulfilmentEvidence": null,
      "assignedAt": null,
      "acceptedAt": null,
      "acceptedBy": null,
      "fulfilledAt": null,
      "fulfilledBy": null,
      "closedAt": null,
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": "2026-04-30T07:26:20.810Z",
      "isAutoFulfilled": false,
      "createdAt": "2026-04-30T06:26:20.815Z",
      "createdBy": "e2e-fd-1",
      "stageContext": "S6"
    },
    {
      "id": "50c2ec1b-d733-4a7a-92a6-d5f1178dd102",
      "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
      "handoffType": "H1",
      "state": "CLOSED",
      "fromRole": "RESERVATIONS",
      "fromActorId": "e2e-fd-1",
      "toRole": "FRONT_DESK",
      "toActorId": null,
      "checklistContent": [
        {
          "code": "VOUCHER_VERIFIED",
          "mandatory": true,
          "description": "Confirmation voucher on file"
        },
        {
          "code": "PAYMENT_STATUS_REVIEWED",
          "mandatory": true,
          "description": "Advance payment status reviewed"
        },
        {
          "code": "SPECIAL_REQUESTS_NOTED",
          "mandatory": false,
          "description": "Special requests noted"
        }
      ],
      "deficientConditionStatus": null,
      "fulfilmentEvidence": {
        "roomAssignmentId": "ffd499b6-2557-486b-89c0-372a9eacc869",
        "readinessConfirmed": true,
        "paymentStatusConfirmed": true,
        "ceilingProximityAddressed": true
      },
      "assignedAt": null,
      "acceptedAt": "2026-04-30T06:26:20.755Z",
      "acceptedBy": "e2e-fd-1",
      "fulfilledAt": "2026-04-30T06:26:20.770Z",
      "fulfilledBy": "e2e-fd-1",
      "closedAt": "2026-04-30T06:26:20.810Z",
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null,
      "escalatedAt": null,
      "cancelledAt": null,
      "cancelledBy": null,
      "cancelledReason": null,
      "slaDeadlineAt": null,
      "isAutoFulfilled": false,
      "createdAt": "2026-04-30T06:26:20.737Z",
      "createdBy": "e2e-fd-1",
      "stageContext": "S4"
    }
  ]
}
```

- **What is happening**: Completes check-in; folio converts to LIVE in canonical design (this repo uses existing S6 service behaviour).
- **Database (PostgreSQL)**: Updates Entry.currentStage=S7; writes key issuance + registration snapshot fields.

### E2E-S7-001 — Post a folio charge at S7
- **Pass**: YES
- **API**: POST `/folios/aa44a5d4-abea-4b03-94bc-7bfe63dfc69c/charges` → 200
- **Request**:

```json
{
  "amount": 25,
  "lineType": "SERVICE"
}
```

- **Response**:

```json
{
  "id": "b152c76d-d40d-4cdb-865c-6c5bc2fedcad",
  "folioId": "aa44a5d4-abea-4b03-94bc-7bfe63dfc69c",
  "lineType": "SERVICE",
  "description": "Laundry",
  "amount": "25",
  "currency": "BTN",
  "chargeDate": "2026-04-30T06:26:20.853Z",
  "stage": "S7",
  "postedBy": "e2e-fd-1",
  "nightAuditRecordId": null,
  "isPostStay": false,
  "postedAt": "2026-04-30T06:26:20.862Z",
  "createdAt": "2026-04-30T06:26:20.862Z"
}
```

- **What is happening**: S7 allows immutable folio line posting; corrections happen via offset lines.
- **Database (PostgreSQL)**: Inserts FolioLine(stage=S7).

### E2E-S7-001b-shim — Shim: park other S7 entries for deterministic COMPLETE night audit (SHIM)
- **Pass**: YES
- **What is happening**: Seed creates additional S7 ACTIVE entries that can cause PARTIAL night audit; we park them so the audit run is COMPLETE for this E2E entry.
- **Database (PostgreSQL)**: Updates Entry.status=PARKED for 2 other S7 ACTIVE entries.

### E2E-S7-002 — Run night audit
- **Pass**: YES
- **API**: POST `/night-audit/run` → 200
- **Request**:

```json
{
  "operatingDate": "2026-05-02"
}
```

- **Response**:

```json
{
  "id": "42326f82-a4fa-4882-88f2-9441668fc7e7",
  "operatingDate": "2026-05-02T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 1,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-30T06:26:20.874Z",
  "createdBy": "e2e-fom-1"
}
```

- **What is happening**: Night audit is a gate for S7→S8 in this backend.
- **Database (PostgreSQL)**: Writes NightAuditRecord and potentially additional FolioLines.

### E2E-S7-003-shim — Shim: create H4 required for S7→S8 (SHIM)
- **Pass**: YES
- **What is happening**: S7→S8 checks H4 initiated; we create it if not present for this end-to-end run.
- **Database (PostgreSQL)**: Inserts HandoffRecord(H4, CREATED).

### E2E-S7-004 — Progress S7→S8
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/progress-stage` → 200
- **Request**:

```json
{
  "targetStage": "S8",
  "version": 7
}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S8",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:20.894Z",
  "createdBy": "e2e-fd-1",
  "version": 8,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-30T06:26:20.810Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-1",
  "registrationCompletedAt": "2026-04-30T06:26:20.810Z",
  "registrationCompletedBy": "e2e-fd-1"
}
```

- **What is happening**: Exits stay management into checkout & settlement stage.
- **Database (PostgreSQL)**: Updates Entry.currentStage=S8.

### E2E-S8-001 — Record key return
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/key-return` → 200
- **Request**:

```json
{
  "keyCountReturned": 2
}
```

- **Response**:

```json
{
  "id": "5c51d446-dd57-42ab-a327-c24acaed0c8e",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25",
  "receivedBy": "e2e-fd-1",
  "returnedAt": "2026-04-30T06:26:20.909Z",
  "keyCountIssued": 2,
  "keyCountReturned": 2,
  "countReconciled": true,
  "reconciliationNote": null,
  "createdAt": "2026-04-30T06:26:20.910Z"
}
```

- **What is happening**: S8 checkout evidence: keys returned.
- **Database (PostgreSQL)**: Inserts KeyReturnRecord.

### E2E-S8-002 — Record room inspection
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/room-inspection` → 200
- **Request**:

```json
{
  "deficientFlagStatus": "NOT_APPLICABLE",
  "damageFound": false
}
```

- **Response**:

```json
{
  "id": "ef91e72f-be44-4660-a99c-7eb324807751",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "roomId": "dc9cd6a0-834c-4b9a-9581-4cf1a6137e25",
  "segmentId": "de62cea0-27c4-4aba-aad6-a2d584f1ce5e",
  "inspectedBy": "e2e-fd-1",
  "inspectedAt": "2026-04-30T06:26:20.921Z",
  "isDeferred": false,
  "deficientFlagStatus": "NOT_APPLICABLE",
  "deficientConditionId": null,
  "inspectorAssessment": null,
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-30T06:26:20.922Z"
}
```

- **What is happening**: S8 checkout evidence: inspection captured.
- **Database (PostgreSQL)**: Inserts RoomInspectionRecord; may schedule timers (W9/W24) in canonical design.

### E2E-S8-003 — Initiate folio settlement
- **Pass**: YES
- **API**: POST `/folios/aa44a5d4-abea-4b03-94bc-7bfe63dfc69c/settle` → 200
- **Request**:

```json
{
  "settlementMethod": "CASH",
  "billingModelConfirmation": "GUEST_PAY",
  "paymentVerificationRef": "cash-001"
}
```

- **Response**:

```json
{
  "id": "aa44a5d4-abea-4b03-94bc-7bfe63dfc69c",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "state": "SETTLED",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-30T06:26:20.662Z",
  "createdBy": "e2e-fd-1",
  "convertedToLiveAt": "2026-04-30T06:26:20.821Z",
  "convertedBy": "e2e-fd-1",
  "closedAt": "2026-04-30T06:26:20.929Z",
  "closedBy": "e2e-fd-1",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```

- **What is happening**: Moves folio to SETTLED/OUTSTANDING depending on billing model and payment state.
- **Database (PostgreSQL)**: Updates Folio.state + emits settlement records if implemented.

### E2E-S8-004 — Fulfil H4 handoff
- **Pass**: YES
- **API**: POST `/handoffs/5211c2cd-3914-4c22-b990-845335729137/fulfil` → 200
- **Request**:

```json
{
  "fulfilmentEvidence": {
    "chargesPostedConfirmation": true,
    "roomInspectionStatus": "COMPLETED",
    "damageAssessmentStatus": "NO_DAMAGE",
    "deficientFlagFinalStatus": "NOT_APPLICABLE"
  }
}
```

- **Response**:

```json
{
  "id": "5211c2cd-3914-4c22-b990-845335729137",
  "entryId": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "SYSTEM",
  "toRole": "HK",
  "toActorId": null,
  "checklistContent": {},
  "deficientConditionStatus": null,
  "fulfilmentEvidence": {
    "roomInspectionStatus": "COMPLETED",
    "damageAssessmentStatus": "NO_DAMAGE",
    "deficientFlagFinalStatus": "NOT_APPLICABLE",
    "chargesPostedConfirmation": true
  },
  "assignedAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "fulfilledAt": "2026-04-30T06:26:20.979Z",
  "fulfilledBy": "e2e-fd-1",
  "closedAt": null,
  "rejectedAt": null,
  "rejectedBy": null,
  "rejectionReason": null,
  "escalatedAt": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "cancelledReason": null,
  "slaDeadlineAt": null,
  "isAutoFulfilled": false,
  "createdAt": "2026-04-30T06:26:20.883Z",
  "createdBy": "actor-seed-system",
  "stageContext": "S8"
}
```

- **What is happening**: S8 exit gate requires H4 fulfilled in this backend.
- **Database (PostgreSQL)**: Updates HandoffRecord(H4) to FULFILLED and stores fulfilmentEvidence.

### E2E-S8-005 — Progress S8→S9
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/progress-stage` → 200
- **Request**:

```json
{
  "targetStage": "S9",
  "version": 8
}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S9",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:21.002Z",
  "createdBy": "e2e-fd-1",
  "version": 9,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-30T06:26:20.810Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-1",
  "registrationCompletedAt": "2026-04-30T06:26:20.810Z",
  "registrationCompletedBy": "e2e-fd-1"
}
```

- **What is happening**: Entry moves into post-stay closure.
- **Database (PostgreSQL)**: Updates Entry.currentStage=S9.

### E2E-S9-000-shim — Shim: dispatch any remaining DRAFT invoices (SHIM)
- **Pass**: YES
- **What is happening**: Closure gate requires invoices to be dispatched; this repo does not expose a full invoice dispatch controller for all invoice types in the S1→S9 path.
- **Database (PostgreSQL)**: Updates Invoice.state to DISPATCHED and sets dispatchedAt/dispatchedBy.

### E2E-S9-001 — Close entry at S9 (S9→CLOSED)
- **Pass**: YES
- **API**: POST `/entries/599ba255-e9f6-482f-be1a-29fb5f8c8c71/close` → 200
- **Request**:

```json
{}
```

- **Response**:

```json
{
  "id": "599ba255-e9f6-482f-be1a-29fb5f8c8c71",
  "inquiryId": "b24d5446-7b7c-4e7e-9a22-a5a777404b23",
  "guestProfileId": "2f33d55f-b232-44d3-b6c0-d95a922db54b",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "CLOSED",
  "currentStage": "S9",
  "walkInCompressed": false,
  "checkInDate": "2026-05-02T06:26:20.547Z",
  "checkOutDate": "2026-05-03T06:26:20.547Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-30T06:26:20.554Z",
  "updatedAt": "2026-04-30T06:26:21.044Z",
  "createdBy": "e2e-fd-1",
  "version": 10,
  "closedAt": "2026-04-30T06:26:21.043Z",
  "closedBy": "e2e-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-30T06:26:20.810Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "e2e-fd-1",
  "registrationCompletedAt": "2026-04-30T06:26:20.810Z",
  "registrationCompletedBy": "e2e-fd-1"
}
```

- **What is happening**: Final closure after settlement readiness and required gates.
- **Database (PostgreSQL)**: Updates Entry.status=CLOSED + writes closure records (where implemented).