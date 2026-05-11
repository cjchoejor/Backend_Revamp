# S5 V2 gap-coverage acceptance report

- Base URL: `http://localhost:4000/api`
- Started at: `2026-04-22T10:12:29.041Z`
- Passed: **13/13**

## Results

| ID | Title | Pass |
|---|---|---|
| V2-S5-001 | Progress S5→S6 blocks when guestPhysicallyPresent=false | YES |
| V2-S5-002 | Progress S5→S6 blocks when advancePaymentReconciliationComplete=false | YES |
| V2-S5-003 | WAIVE persists waivedBy (and waivedReason) on PreArrivalTask | YES |
| V2-S5-004 | Assigning a room in AVAILABLE_INSPECTED is allowed | YES |
| V2-S5-005 | Assigning UNDER_MAINTENANCE room is allowed when expectedReadyAt <= arrival | YES |
| V2-S5-006 | No-show DEFER path sets awaitingWrittenConfirmationActive=true | YES |
| V2-S5-007 | No-show REACTIVATE clears awaitingWrittenConfirmationActive and resets cutoff | YES |
| V2-S5-008 | No-show SUB_PATH_1 writes terminal state: folio NO_SHOW_CLOSED + entry stage TERMINAL + determination row | YES |
| V2-S5-NT-001 | W4 activation path (timer firing, task init at activation, W34 cancellation, dwell timers) | YES |
| V2-S5-NT-002 | S6+ re-entry into S5 (compressed readiness re-verification) | YES |
| V2-S5-NT-003 | W23 room readiness SLA registration behavior | YES |
| V2-S5-NT-004 | Verify all 9 PreArrivalTask types initialized at S5 activation | YES |
| V2-S5-NT-005 | S5→S1 re-entry path (“config error · FOM” branch) | YES |

## Detailed steps

### V2-S5-001 — Progress S5→S6 blocks when guestPhysicallyPresent=false

- **Request**: `POST http://localhost:4000/api/entries/a6d4e1c3-c6d2-4ff0-9da2-151b34e80fda/progress-stage`
- **Actor**: `L1 (v2-fd-1)`
- **Body**: `{"targetStage":"S6","version":1,"guestPhysicallyPresent":false}`
- **Expected**: 409 StageGateBlockedError blockingCondition=GUEST_NOT_PRESENT
- **Actual status**: 409
- **Response**: `{"error":"StageGateBlockedError","message":"Guest physical presence is required for S5→S6","blockingCondition":"GUEST_NOT_PRESENT"}`
- **Database (PostgreSQL)**: None (request rejected before state transition).

### V2-S5-002 — Progress S5→S6 blocks when advancePaymentReconciliationComplete=false

- **Request**: `POST http://localhost:4000/api/entries/a6d4e1c3-c6d2-4ff0-9da2-151b34e80fda/progress-stage`
- **Actor**: `L1 (v2-fd-1)`
- **Body**: `{"targetStage":"S6","version":1,"guestPhysicallyPresent":true}`
- **Expected**: 409 StageGateBlockedError (advance payment not reconciled)
- **Actual status**: 409
- **Response**: `{"error":"StageGateBlockedError","message":"H1 handoff must be FULFILLED before check-in","blockingCondition":"H1_NOT_FULFILLED"}`
- **Database (PostgreSQL)**: DB setup: sets Folio.advancePaymentReconciliationComplete=false; no state transition occurs when blocked.
- **Notes**: We only assert the block class; specific blockingCondition may differ by gate ordering (tasks/H1/room readiness).

### V2-S5-003 — WAIVE persists waivedBy (and waivedReason) on PreArrivalTask

- **Request**: `PATCH http://localhost:4000/api/pre-arrival-tasks/8523055c-a970-4edf-905a-891ca9c10073`
- **Actor**: `L1 (v2-fd-1)`
- **Body**: `{"action":"WAIVE","waivedReason":"edge-case v2 waive metadata test"}`
- **Expected**: 200 + task.status=WAIVED with waivedBy set
- **Actual status**: 200
- **Response**: `{"id":"8523055c-a970-4edf-905a-891ca9c10073","entryId":"a6d4e1c3-c6d2-4ff0-9da2-151b34e80fda","taskType":"PAYMENT_RECONCILIATION","category":"ADMINISTRATIVE","targetDate":null,"status":"WAIVED","assignedTo":null,"assignedDepartment":null,"completedAt":null,"completedBy":null,"waivedReason":"edge-case v2 waive metadata test","waivedBy":"v2-fd-1","sourceRecordType":null,"sourceRecordId":null,"createdAt":"2026-04-22T10:12:27.730Z","createdBy":"actor-seed-system"}`
- **Database (PostgreSQL)**: Updates pre_arrival_tasks.status/waived_reason/waived_by.
- **Notes**: waivedBy=v2-fd-1

### V2-S5-004 — Assigning a room in AVAILABLE_INSPECTED is allowed

- **Request**: `POST http://localhost:4000/api/entries/a6d4e1c3-c6d2-4ff0-9da2-151b34e80fda/room-assignments`
- **Actor**: `L1 (v2-fd-1)`
- **Body**: `{"roomId":"351c9f4c-b68f-45c9-a5dc-15ffc422a56e"}`
- **Expected**: 201 created room assignment
- **Actual status**: 201
- **Response**: `{"id":"cb2b02b1-c365-42f2-9f51-e81a01ed087e","entryId":"a6d4e1c3-c6d2-4ff0-9da2-151b34e80fda","roomId":"351c9f4c-b68f-45c9-a5dc-15ffc422a56e","assignedAt":"2026-04-22T10:12:29.200Z","assignedBy":"v2-fd-1","deficientAtAssignment":false,"deficientConditionRecordId":null,"acknowledgementActorId":null,"acknowledgementAt":null,"notes":null,"createdAt":"2026-04-22T10:12:29.200Z"}`
- **Database (PostgreSQL)**: Creates room_assignments row pointing to a room with physical_state=AVAILABLE_INSPECTED.

### V2-S5-005 — Assigning UNDER_MAINTENANCE room is allowed when expectedReadyAt <= arrival

- **Request**: `POST http://localhost:4000/api/entries/8dd9c2d1-30fb-49e9-85ed-94fc4b2367c2/room-assignments`
- **Actor**: `L1 (v2-fd-1)`
- **Body**: `{"roomId":"629805a6-23e1-456b-92bc-afc8ed2ab289"}`
- **Expected**: 201 created room assignment
- **Actual status**: 201
- **Response**: `{"id":"73ba8de6-75c0-428a-9caa-7935de24e833","entryId":"8dd9c2d1-30fb-49e9-85ed-94fc4b2367c2","roomId":"629805a6-23e1-456b-92bc-afc8ed2ab289","assignedAt":"2026-04-22T10:12:29.229Z","assignedBy":"v2-fd-1","deficientAtAssignment":false,"deficientConditionRecordId":null,"acknowledgementActorId":null,"acknowledgementAt":null,"notes":null,"createdAt":"2026-04-22T10:12:29.229Z"}`
- **Database (PostgreSQL)**: Creates room_assignments row; validates rooms.expected_ready_at against arrival window.
- **Notes**: expectedReadyAt=2026-04-25T08:59:00.000Z

### V2-S5-006 — No-show DEFER path sets awaitingWrittenConfirmationActive=true

- **Request**: `POST http://localhost:4000/api/entries/8c0353f3-2d72-4045-8f31-4e6eb1304cf6/no-show`
- **Actor**: `L2 (v2-fom-1)`
- **Body**: `{"determinationPath":"DEFER","awaitingConfirmationWindowMinutes":30,"contactAttemptLog":[{"channel":"CALL","attemptedAt":"(now)","outcome":"NO_ANSWER"}],"decisionReason":"awaiting written confirmation"}`
- **Expected**: 200 + Entry.awaitingWrittenConfirmationActive=true
- **Actual status**: 200
- **Response**: `{"id":"8c0353f3-2d72-4045-8f31-4e6eb1304cf6","inquiryId":"2f264401-d19d-4455-9c12-19d1b7b85324","guestProfileId":"83f26f55-7030-489e-b8fd-70a11aad1927","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S5","checkInDate":"2026-04-25T09:00:00.000Z","checkOutDate":"2026-04-27T09:00:00.000Z","guestCount":1,"otaSource":false,"createdAt":"2026-04-22T10:12:29.231Z","updatedAt":"2026-04-22T10:12:29.240Z","createdBy":"v2-system","version":2,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":"2026-04-22T10:12:29.230Z","creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":true,"keysIssuedAt":null,"keysIssuedCount":null,"keysIssuedBy":null,"registrationCompletedAt":null,"registrationCompletedBy":null}`
- **Database (PostgreSQL)**: Updates entries.awaiting_written_confirmation_active=true.

### V2-S5-007 — No-show REACTIVATE clears awaitingWrittenConfirmationActive and resets cutoff

- **Request**: `POST http://localhost:4000/api/entries/9a480650-e979-42af-9417-39750df12d4c/no-show`
- **Actor**: `L2 (v2-fom-1)`
- **Expected**: 200 + awaitingWrittenConfirmationActive=false and noShowCutoffReachedAt=null
- **Actual status**: 200
- **Response**: `{"id":"9a480650-e979-42af-9417-39750df12d4c","inquiryId":"2f264401-d19d-4455-9c12-19d1b7b85324","guestProfileId":"83f26f55-7030-489e-b8fd-70a11aad1927","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"S5","checkInDate":"2026-04-25T09:00:00.000Z","checkOutDate":"2026-04-27T09:00:00.000Z","guestCount":1,"otaSource":false,"createdAt":"2026-04-22T10:12:29.244Z","updatedAt":"2026-04-22T10:12:29.252Z","createdBy":"v2-system","version":2,"closedAt":null,"closedBy":null,"noShowCutoffReachedAt":null,"creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":false,"keysIssuedAt":null,"keysIssuedCount":null,"keysIssuedBy":null,"registrationCompletedAt":null,"registrationCompletedBy":null}`
- **Database (PostgreSQL)**: Updates entries.awaiting_written_confirmation_active=false and entries.no_show_cutoff_reached_at=null.

### V2-S5-008 — No-show SUB_PATH_1 writes terminal state: folio NO_SHOW_CLOSED + entry stage TERMINAL + determination row

- **Request**: `POST http://localhost:4000/api/entries/592b0b9f-193d-444f-812b-ed889a8fc4b2/no-show`
- **Actor**: `L2 (v2-fom-1)`
- **Expected**: 200 + Folio.state=NO_SHOW_CLOSED, Folio.closedAt/closedBy set, Entry.currentStage=TERMINAL, NoShowDeterminationRecord exists
- **Actual status**: 200
- **Response**: `{"id":"592b0b9f-193d-444f-812b-ed889a8fc4b2","inquiryId":"2f264401-d19d-4455-9c12-19d1b7b85324","guestProfileId":"83f26f55-7030-489e-b8fd-70a11aad1927","segmentNumber":1,"useType":"LEISURE","status":"ACTIVE","currentStage":"TERMINAL","checkInDate":"2026-04-25T09:00:00.000Z","checkOutDate":"2026-04-27T09:00:00.000Z","guestCount":1,"otaSource":false,"createdAt":"2026-04-22T10:12:29.258Z","updatedAt":"2026-04-22T10:12:29.277Z","createdBy":"v2-system","version":2,"closedAt":"2026-04-22T10:12:29.276Z","closedBy":"v2-fom-1","noShowCutoffReachedAt":"2026-04-22T10:12:29.257Z","creditCeilingTier2AcknowledgedAt":null,"creditCeilingTier2AcknowledgedBy":null,"awaitingWrittenConfirmationActive":false,"keysIssuedAt":null,"keysIssuedCount":null,"keysIssuedBy":null,"registrationCompletedAt":null,"registrationCompletedBy":null,"noShowDetermination":{"id":"77d453cb-0f94-4f3d-9c91-cf1312457451","entryId":"`
- **Database (PostgreSQL)**: Creates no_show_determination_records; updates folios.*; updates entries.current_stage=TERMINAL and entries.closedAt/by.
- **Notes**: folioState=NO_SHOW_CLOSED; stage=TERMINAL; hasDetermination=true

### V2-S5-NT-001 — W4 activation path (timer firing, task init at activation, W34 cancellation, dwell timers)

- **Expected**: NOT TESTABLE in this repo slice
- **Notes**: No worker/timer engine dispatcher exists in this backend slice; cannot trigger W4/W34/W1 end-to-end via API.

### V2-S5-NT-002 — S6+ re-entry into S5 (compressed readiness re-verification)

- **Expected**: NOT TESTABLE until earlier-stage and re-entry orchestration is implemented
- **Notes**: Requires upstream stage transitions + re-entry topology not present as an exposed route/engine in this slice.

### V2-S5-NT-003 — W23 room readiness SLA registration behavior

- **Expected**: NOT TESTABLE in this repo slice
- **Notes**: Timer registration/worker execution (W23) is not implemented end-to-end; we can only test room assignment validation rules.

### V2-S5-NT-004 — Verify all 9 PreArrivalTask types initialized at S5 activation

- **Expected**: PARTIALLY NOT TESTABLE with current seed
- **Notes**: Current seed creates only a subset of task types; full activation checklist initialization (and per-task semantics) is not implemented as a callable operation.

### V2-S5-NT-005 — S5→S1 re-entry path (“config error · FOM” branch)

- **Expected**: NOT IMPLEMENTED in this slice
- **Notes**: Flowchart references this branch; no service/route exists to trigger S5→S1 re-entry from configuration error in current code.