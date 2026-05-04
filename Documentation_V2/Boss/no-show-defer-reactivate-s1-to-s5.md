# Boss summary report

- **Source report**: `Documentation_V2/test/E2E-no-show-defer-reactivate-s1-to-s5-test-report.no-db.md`
- **Scenario title**: E2E no-show defer/reactivate report (S1 → S5) — no DB diffs
- **Goal**: Validate S5 no-show DEFER then REACTIVATE path.
- **Base URL**: `http://localhost:4000/api`
- **Entry ID**: `47a157bb-7240-4bde-bd9c-dced2b8ec10f`
- **Inquiry ID**: `18997a3d-0918-4907-b444-e3180559c20c`
- **Result**: **PASS (flow executed to end)**

## API trace (request/response)

### S1 create inquiry
- **Goal**: Execute `POST` `/inquiries` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/inquiries",
  "body": {
    "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
    "sourceChannel": "WALK_IN",
    "notes": "e2e no-show defer/reactivate flow"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "18997a3d-0918-4907-b444-e3180559c20c",
  "referenceNumber": "INQ-1777286943414-807070",
  "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
  "agentProfileId": null,
  "sourceChannel": "WALK_IN",
  "defaultCustodianId": "staff-frontdesk-1",
  "notes": "e2e no-show defer/reactivate flow",
  "createdAt": "2026-04-27T10:49:03.415Z",
  "updatedAt": "2026-04-27T10:49:03.415Z",
  "createdBy": "e2e-fd-6",
  "parkedAt": null,
  "parkedBy": null
}
```

- **Achieved**: YES

### S1 create entry
- **Goal**: Execute `POST` `/entries` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries",
  "body": {
    "inquiryId": "18997a3d-0918-4907-b444-e3180559c20c",
    "useType": "LEISURE",
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z",
    "guestCount": 1,
    "otaSource": false
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "inquiryId": "18997a3d-0918-4907-b444-e3180559c20c",
  "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S1",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T10:49:03.441Z",
  "updatedAt": "2026-04-27T10:49:03.441Z",
  "createdBy": "e2e-fd-6",
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

- **Achieved**: YES

### S1 availability search
- **Goal**: Execute `POST` `/availability/search` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/availability/search",
  "body": {
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z",
    "guestCount": 1,
    "useType": "LEISURE"
  }
}
```

- **Response**: HTTP 200

```json
{
  "configurationId": "76db6c46-8f88-417c-8aef-487a33494ec3",
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "queriedAt": "2026-04-27T10:49:03.463Z",
  "isStale": false,
  "results": {
    "availableRooms": [
      {
        "inventoryId": "a987bbe7-64c3-4abc-88f4-2d9fe047b874",
        "roomNumber": "401",
        "claimState": "FREE",
        "roomId": "a987bbe7-64c3-4abc-88f4-2d9fe047b874"
      }
    ],
    "unavailableRooms": [
      {
        "inventoryId": "74de5585-f688-4d3d-9863-c292591454f8",
        "roomNumber": "501",
        "unavailabilityReason": "CLAIMED",
        "roomId": "74de5585-f688-4d3d-9863-c292591454f8"
      },
      {
        "inventoryId": "5a25c6f0-12f7-45dc-92ca-9bea24b3d574",
        "roomNumber": "502-DEF",
        "unavailabilityReason": "CLAIMED",
        "roomId": "5a25c6f0-12f7-45dc-92ca-9bea24b3d574"
      },
      {
        "inventoryId": "cda853b9-2d02-4700-8639-2ee00fc65796",
        "roomNumber": "503",
        "unavailabilityReason": "CLAIMED",
        "roomId": "cda853b9-2d02-4700-8639-2ee00fc65796"
      }
    ],
    "deficientRooms": [
      {
        "inventoryId": "353020fa-0976-4783-babf-20edd4128402",
        "roomNumber": "402-DEF",
        "claimState": "FREE",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null,
        "roomId": "353020fa-0976-4783-babf-20edd4128402"
      }
    ],
    "maintenanceConflicts": [],
    "searchTimestamp": "2026-04-27T10:49:03.462Z",
    "isRevalidationRequired": false
  }
}
```

- **Achieved**: YES

### S1 select availability option
- **Goal**: Execute `PATCH` `/availability/configurations/76db6c46-8f88-417c-8aef-487a33494ec3/select` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "PATCH",
  "path": "/availability/configurations/76db6c46-8f88-417c-8aef-487a33494ec3/select",
  "body": {
    "roomId": "a987bbe7-64c3-4abc-88f4-2d9fe047b874"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "76db6c46-8f88-417c-8aef-487a33494ec3",
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "segmentId": null,
  "searchCriteria": {
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "useType": "LEISURE",
    "guestCount": 1,
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z"
  },
  "resultSet": {
    "availableRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "401",
        "inventoryId": "a987bbe7-64c3-4abc-88f4-2d9fe047b874"
      }
    ],
    "deficientRooms": [
      {
        "claimState": "FREE",
        "roomNumber": "402-DEF",
        "inventoryId": "353020fa-0976-4783-babf-20edd4128402",
        "deficientCategory": "HOUSEKEEPING",
        "deficientDescription": null
      }
    ],
    "searchTimestamp": "2026-04-27T10:49:03.462Z",
    "unavailableRooms": [
      {
        "roomNumber": "501",
        "inventoryId": "74de5585-f688-4d3d-9863-c292591454f8",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "502-DEF",
        "inventoryId": "5a25c6f0-12f7-45dc-92ca-9bea24b3d574",
        "unavailabilityReason": "CLAIMED"
      },
      {
        "roomNumber": "503",
        "inventoryId": "cda853b9-2d02-4700-8639-2ee00fc65796",
        "unavailabilityReason": "CLAIMED"
      }
    ],
    "maintenanceConflicts": [],
    "isRevalidationRequired": false
  },
  "optionSelected": {
    "roomId": "a987bbe7-64c3-4abc-88f4-2d9fe047b874",
    "isDeficient": false
  },
  "isStale": false,
  "stalenessAt": null,
  "deficientAcknowledgements": null,
  "sealedAt": null,
  "createdAt": "2026-04-27T10:49:03.463Z",
  "createdBy": "e2e-fd-6"
}
```

- **Achieved**: YES

### S1->S2 progress-stage
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/progress-stage",
  "body": {
    "targetStage": "S2",
    "version": 1
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "inquiryId": "18997a3d-0918-4907-b444-e3180559c20c",
  "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S2",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T10:49:03.441Z",
  "updatedAt": "2026-04-27T10:49:03.501Z",
  "createdBy": "e2e-fd-6",
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

- **Achieved**: YES

### S2 create quotation
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/quotations` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/quotations",
  "body": {
    "nightlyRate": 100,
    "currency": "BTN",
    "notes": "e2e quotation"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "205ab9b8-4969-4fbe-ac99-ef47e9b7ca21",
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "segmentId": "85580eec-e774-4a32-98e7-99f66a599a22",
  "versionNumber": 1,
  "referenceNumber": "Q-001",
  "state": "DRAFT",
  "commercialTerms": {
    "notes": "e2e quotation",
    "useType": "LEISURE",
    "currency": "BTN",
    "inclusions": [],
    "roomTypeId": "66938011-f735-4b52-9b8a-f0d1207004b2",
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
  "createdAt": "2026-04-27T10:49:03.517Z",
  "createdBy": "e2e-fd-6"
}
```

- **Achieved**: YES

### S2 send quotation
- **Goal**: Execute `POST` `/quotations/205ab9b8-4969-4fbe-ac99-ef47e9b7ca21/send` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/quotations/205ab9b8-4969-4fbe-ac99-ef47e9b7ca21/send",
  "body": {
    "id": "205ab9b8-4969-4fbe-ac99-ef47e9b7ca21",
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "segmentId": "85580eec-e774-4a32-98e7-99f66a599a22",
    "versionNumber": 1,
    "referenceNumber": "Q-001",
    "state": "SENT",
    "commercialTerms": {
      "notes": "e2e quotation",
      "useType": "LEISURE",
      "currency": "BTN",
      "inclusions": [],
      "roomTypeId": "66938011-f735-4b52-9b8a-f0d1207004b2",
      "resolvedRateAmount": 500,
      "resolvedRatePlanId": "rp-dlx-default"
    },
    "totalAmount": "500",
    "currency": "BTN",
    "validUntil": "2026-04-29T10:49:03.522Z",
    "sentAt": "2026-04-27T10:49:03.522Z",
    "sentTo": null,
    "communicationRecordId": null,
    "supersededById": null,
    "supersededAt": null,
    "expiredAt": null,
    "acceptedAt": null,
    "acceptedBy": null,
    "folioId": null,
    "sealedAt": null,
    "createdAt": "2026-04-27T10:49:03.517Z",
    "createdBy": "e2e-fd-6"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S2 accept quotation
- **Goal**: Execute `POST` `/quotations/205ab9b8-4969-4fbe-ac99-ef47e9b7ca21/accept` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/quotations/205ab9b8-4969-4fbe-ac99-ef47e9b7ca21/accept",
  "body": {
    "id": "205ab9b8-4969-4fbe-ac99-ef47e9b7ca21",
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "segmentId": "85580eec-e774-4a32-98e7-99f66a599a22",
    "versionNumber": 1,
    "referenceNumber": "Q-001",
    "state": "ACCEPTED",
    "commercialTerms": {
      "notes": "e2e quotation",
      "useType": "LEISURE",
      "currency": "BTN",
      "inclusions": [],
      "roomTypeId": "66938011-f735-4b52-9b8a-f0d1207004b2",
      "resolvedRateAmount": 500,
      "resolvedRatePlanId": "rp-dlx-default"
    },
    "totalAmount": "500",
    "currency": "BTN",
    "validUntil": "2026-04-29T10:49:03.522Z",
    "sentAt": "2026-04-27T10:49:03.522Z",
    "sentTo": null,
    "communicationRecordId": "66ad017a-bbbc-4646-9dbf-9a5c87329987",
    "supersededById": null,
    "supersededAt": null,
    "expiredAt": null,
    "acceptedAt": "2026-04-27T10:49:03.551Z",
    "acceptedBy": "e2e-fd-6",
    "folioId": null,
    "sealedAt": null,
    "createdAt": "2026-04-27T10:49:03.517Z",
    "createdBy": "e2e-fd-6"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S2->S3 progress-stage
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/progress-stage` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/progress-stage",
  "body": {
    "targetStage": "S3",
    "version": 2
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "inquiryId": "18997a3d-0918-4907-b444-e3180559c20c",
  "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S3",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T10:49:03.441Z",
  "updatedAt": "2026-04-27T10:49:03.574Z",
  "createdBy": "e2e-fd-6",
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

- **Achieved**: YES

### S3 ensure provisional folio + billing model
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/folio/provisional` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/folio/provisional",
  "body": {
    "billingModel": "GUEST_PAY"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "16fd088d-2e7e-47fd-a83b-1880bd302f65",
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:49:03.584Z",
  "createdBy": "e2e-fd-6",
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
      "id": "0db242fd-c391-4b5f-b94e-772f7c37a2a4",
      "folioId": "16fd088d-2e7e-47fd-a83b-1880bd302f65",
      "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
      "invoiceType": "PROFORMA",
      "state": "DRAFT",
      "invoiceNumber": null,
      "totalAmount": null,
      "templateKey": "proforma-v1",
      "issuedAt": "2026-04-27T10:49:03.587Z",
      "issuedBy": "e2e-fd-6",
      "dispatchedAt": null,
      "dispatchedBy": null,
      "dispatchedTo": null,
      "supersededById": null,
      "versionNumber": 1,
      "metadata": {
        "basis": "S3 setup"
      },
      "createdAt": "2026-04-27T10:49:03.588Z"
    }
  ]
}
```

- **Achieved**: YES

### S3 record advance payment
- **Goal**: Execute `POST` `/folios/16fd088d-2e7e-47fd-a83b-1880bd302f65/payments` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/folios/16fd088d-2e7e-47fd-a83b-1880bd302f65/payments",
  "body": {
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "amount": 500,
    "notes": "advance for defer scenario"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "ad7867d3-907c-45ed-93af-57c7fa94cd24",
  "folioId": "16fd088d-2e7e-47fd-a83b-1880bd302f65",
  "invoiceId": null,
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "amount": "500",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "IN",
  "createdAt": "2026-04-27T10:49:03.602Z",
  "receivedAt": "2026-04-27T10:49:03.601Z",
  "recordedBy": "e2e-fd-6",
  "stage": "S3",
  "notes": "advance for defer scenario"
}
```

- **Achieved**: YES

### S3 reconcile advance payment
- **Goal**: Execute `POST` `/folios/16fd088d-2e7e-47fd-a83b-1880bd302f65/advance-payment/reconcile` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/folios/16fd088d-2e7e-47fd-a83b-1880bd302f65/advance-payment/reconcile",
  "body": {
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "note": "reconcile for defer scenario"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "16fd088d-2e7e-47fd-a83b-1880bd302f65",
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "state": "PROVISIONAL",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-27T10:49:03.584Z",
  "createdBy": "e2e-fd-6",
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

- **Achieved**: YES

### S3 cancellation disclosure
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/disclosures/cancellation` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/disclosures/cancellation",
  "body": {
    "noShowTreatmentStatement": "Standard no-show policy",
    "disclosedTerms": {
      "windowHours": 24
    }
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "d5b061d4-ee28-4553-95d2-c7870f4b8e2e",
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "segmentId": "85580eec-e774-4a32-98e7-99f66a599a22",
  "noShowTreatmentStatement": "Standard no-show policy",
  "disclosedTerms": {
    "windowHours": 24
  },
  "disclosedAt": "2026-04-27T10:49:03.615Z",
  "disclosedBy": "e2e-fd-6"
}
```

- **Achieved**: YES

### S3 committed hold
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/holds/committed` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/holds/committed",
  "body": {
    "roomId": "a987bbe7-64c3-4abc-88f4-2d9fe047b874",
    "commercialJustification": "No-show defer scenario hold"
  }
}
```

- **Response**: HTTP 201

```json
{
  "id": "4a096a25-b2d7-4ca1-af28-82ed7b9dfe86",
  "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "segmentId": "85580eec-e774-4a32-98e7-99f66a599a22",
  "roomId": "a987bbe7-64c3-4abc-88f4-2d9fe047b874",
  "spaceId": null,
  "roomTypeId": "66938011-f735-4b52-9b8a-f0d1207004b2",
  "state": "PLACED",
  "placedAt": "2026-04-27T10:49:03.632Z",
  "placedBy": "e2e-fd-6",
  "confirmedAt": null,
  "confirmedBy": null,
  "releasedAt": null,
  "releasedBy": null,
  "releaseReason": null,
  "commercialJustification": "No-show defer scenario hold",
  "ttlSeconds": 3600,
  "expiresAt": "2026-04-27T11:49:03.632Z"
}
```

- **Achieved**: YES

### S3->S4 confirm reservation
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/confirm` and advance scenario state.
- **Request**: actor `L1`/`e2e-fd-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/confirm",
  "body": {
    "version": 3
  }
}
```

- **Response**: HTTP 200

```json
{
  "reservation": {
    "id": "5df29d1d-f567-4fb4-97be-740becc0319a",
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "segmentId": "85580eec-e774-4a32-98e7-99f66a599a22",
    "frozenRate": "500",
    "frozenRatePlanId": "rp-dlx-default",
    "frozenInclusions": [],
    "frozenCancellationTerms": {
      "windowHours": 24
    },
    "frozenBillingModel": "GUEST_PAY",
    "frozenCheckInDate": "2026-04-27T00:00:00.000Z",
    "frozenCheckOutDate": "2026-04-28T00:00:00.000Z",
    "frozenGuestCount": 1,
    "creditCeilingIfExtended": null,
    "confirmedAt": "2026-04-27T10:49:03.668Z",
    "confirmedBy": "e2e-fd-6",
    "confirmationVoucherSent": true,
    "sealedAt": null,
    "createdAt": "2026-04-27T10:49:03.669Z"
  },
  "entry": {
    "id": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
    "inquiryId": "18997a3d-0918-4907-b444-e3180559c20c",
    "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S4",
    "walkInCompressed": false,
    "checkInDate": "2026-04-27T00:00:00.000Z",
    "checkOutDate": "2026-04-28T00:00:00.000Z",
    "guestCount": 1,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-27T10:49:03.441Z",
    "updatedAt": "2026-04-27T10:49:03.680Z",
    "createdBy": "e2e-fd-6",
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

- **Achieved**: YES

### W4 pre-arrival activation (manual trigger)
- **Goal**: Execute `WORKER` `PRE_ARRIVAL_COUNTDOWN_W4` and advance scenario state.
- **Request**: actor `L1`/`SYSTEM`

```json
{
  "method": "WORKER",
  "path": "PRE_ARRIVAL_COUNTDOWN_W4",
  "body": {
    "skipped": false,
    "entryId": "47a157bb-7240-4bde-bd9c-dced2b8ec10f"
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### TEST SETUP (DB): mark noShowCutoffReachedAt
- **Goal**: Execute `DB` `Entry.noShowCutoffReachedAt` and advance scenario state.
- **Request**: actor `L2`/`SYSTEM`

```json
{
  "method": "DB",
  "path": "Entry.noShowCutoffReachedAt",
  "body": {
    "ok": true
  }
}
```

- **Response**: HTTP 200

```json
null
```

- **Achieved**: YES

### S5 no-show DEFER
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/no-show` and advance scenario state.
- **Request**: actor `L2`/`e2e-fom-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/no-show",
  "body": {
    "determinationPath": "DEFER",
    "contactAttemptLog": [
      {
        "channel": "PHONE",
        "attemptedAt": "2026-04-27T10:49:13.897Z",
        "outcome": "NO_ANSWER"
      }
    ],
    "decisionReason": "Need written confirmation",
    "awaitingConfirmationWindowMinutes": 10
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "inquiryId": "18997a3d-0918-4907-b444-e3180559c20c",
  "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S5",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T10:49:03.441Z",
  "updatedAt": "2026-04-27T10:49:13.896Z",
  "createdBy": "e2e-fd-6",
  "version": 5,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": "2026-04-27T10:49:13.895Z",
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

- **Achieved**: YES

### S5 no-show REACTIVATE
- **Goal**: Execute `POST` `/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/no-show` and advance scenario state.
- **Request**: actor `L2`/`e2e-fom-6`

```json
{
  "method": "POST",
  "path": "/entries/47a157bb-7240-4bde-bd9c-dced2b8ec10f/no-show",
  "body": {
    "determinationPath": "REACTIVATE",
    "contactAttemptLog": [
      {
        "channel": "PHONE",
        "attemptedAt": "2026-04-27T10:49:13.911Z",
        "outcome": "CONNECTED",
        "response": "Arriving late"
      }
    ],
    "decisionReason": "Guest confirmed arrival"
  }
}
```

- **Response**: HTTP 200

```json
{
  "id": "47a157bb-7240-4bde-bd9c-dced2b8ec10f",
  "inquiryId": "18997a3d-0918-4907-b444-e3180559c20c",
  "guestProfileId": "1f12c23c-1f93-4aeb-859e-079896f5b39c",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S5",
  "walkInCompressed": false,
  "checkInDate": "2026-04-27T00:00:00.000Z",
  "checkOutDate": "2026-04-28T00:00:00.000Z",
  "guestCount": 1,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-27T10:49:03.441Z",
  "updatedAt": "2026-04-27T10:49:13.922Z",
  "createdBy": "e2e-fd-6",
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

- **Achieved**: YES

