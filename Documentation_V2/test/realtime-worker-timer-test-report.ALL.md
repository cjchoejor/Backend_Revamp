# Realtime worker/timer test report (ALL)

- **Ran at**: 2026-04-30T06:17:16.039Z

## Why the first realtime test only covered W2/W9/W11/W28/W29

That first pass was deliberately scoped to validate the **doc gap** we discovered:

- **Doc expectation**: In the SIG docs, W9/W11/W28/W29 are defined as **pg-boss job types** and should fire on their own after registration.
- **Code reality before this work**:
  - `TimerRecord`s were being created for W9/W11/W28 (and W29 logic existed), but **pg-boss `.work(...)` handlers were not registered** for those job types in `src/workers/runner.ts`, so they couldn't fire autonomously.
  - For W2/W3 and most worker patterns, the worker expects `timerRecordId` in the job payload to flip `TimerRecord.status` to `FIRED`. W2 previously scheduled a placeholder payload first, then re-scheduled without a `timerRecordId`, so `TimerRecord` stayed `SCHEDULED` even if pg-boss completed the job.

So we validated W2 as a baseline, then fixed the wiring/scheduling gaps and validated W9/W11/W28/W29 end-to-end with realtime waits. After that, we expanded to the remaining workers.

## Results (configured vs observed)

### W2 SpeculativeHold expiry
- **timerCode**: `SPECULATIVE_HOLD_EXPIRY_W2`
- **timerRecordId**: 4cd99074-5837-47b1-8c11-ce5225b4f6bb
- **expected wait**: ~15s
- **observed wait**: ~16s
- **final status**: FIRED

### W3 CommittedHold expiry
- **timerCode**: `COMMITTED_HOLD_EXPIRY_W3`
- **timerRecordId**: 3e28efbf-365e-4ef7-9dee-c4d295a2f350
- **expected wait**: ~10s
- **observed wait**: ~11.9s
- **final status**: FIRED
- **notes**: This creates a minimal CommittedHold row and schedules expiry near-now.

### W9 Post-checkout inspection window
- **timerCode**: `POST_CHECKOUT_INSPECTION_W9`
- **timerRecordId**: df730927-1119-407b-82d1-650972281048
- **expected wait**: ~12s
- **observed wait**: ~13.7s
- **final status**: FIRED
- **notes**: This uses an explicit near-now dueAt for realtime validation.

### W11 Commission rate missing escalation
- **timerCode**: `COMMISSION_RATE_MISSING_W11`
- **timerRecordId**: 5b9e24cf-b2ff-4094-8f8f-d32461e5545b
- **expected wait**: ~10s
- **observed wait**: ~11.9s
- **final status**: FIRED
- **notes**: This uses an explicit near-now dueAt for realtime validation.

### W28 Feedback solicitation
- **timerCode**: `FEEDBACK_SOLICITATION_W28`
- **timerRecordId**: 8676408b-ddf3-4d43-ad01-166e8f3c7a77
- **expected wait**: ~8s
- **observed wait**: ~9.6s
- **final status**: FIRED
- **notes**: This uses an explicit near-now dueAt for realtime validation.

### W29 Equipment return deadline
- **timerCode**: `EQUIPMENT_RETURN_W29`
- **timerRecordId**: 24da1802-90a2-403f-87fb-93d58ac0e82f
- **expected wait**: ~9s
- **observed wait**: ~9.9s
- **final status**: FIRED
- **notes**: This uses an explicit near-now deadline for realtime validation.

### W8 Payment follow-up
- **timerCode**: `PAYMENT_FOLLOW_UP_W8`
- **timerRecordId**: 097a7b73-239d-466e-b5e4-91547106c730
- **expected wait**: ~6s
- **observed wait**: ~7.6s
- **final status**: FIRED
- **notes**: Schedules pg-boss job and verifies TimerRecord flips to FIRED.

### W24 Housekeeping SLA breach
- **timerCode**: `HOUSEKEEPING_SLA_W24`
- **timerRecordId**: a6f64247-995b-4e60-a483-bfe46237555e
- **expected wait**: ~6s
- **observed wait**: ~7.9s
- **final status**: FIRED
- **notes**: Schedules pg-boss job and verifies TimerRecord flips to FIRED.

### P18 Guest data retention (code path for W30)
- **timerCode**: `GUEST_DATA_RETENTION_P18`
- **timerRecordId**: 31670874-40b8-45ca-8591-8b2cc48224cf
- **expected wait**: ~6s
- **observed wait**: ~7.8s
- **final status**: FIRED

### W6 Night audit
- **timerCode**: `NIGHT_AUDIT_W6`
- **timerRecordId**: (trace)
- **expected wait**: ~4s
- **observed wait**: ~5.6s
- **final status**: PASS
- **notes**: Validated via TraceEvent (night audit writes immutable NightAuditRecord instead of TimerRecord).

### W7 OTA email poll (noop wiring)
- **timerCode**: `OTA_EMAIL_PARSER_POLL`
- **timerRecordId**: (trace)
- **expected wait**: ~4s
- **observed wait**: ~5.8s
- **final status**: PASS
- **notes**: Repo slice has no IMAP integration; worker is wired and emits a NOOP trace.

### W12 Credit ceiling monitoring
- **timerCode**: `CREDIT_CEILING_MONITORING_W12`
- **timerRecordId**: 9f67c186-12a0-4385-9f03-6d62e986cecb
- **expected wait**: ~6s
- **observed wait**: ~7.8s
- **final status**: FIRED

### W18 AI audit supplement (noop wiring)
- **timerCode**: `AI_AUDIT_SUPPLEMENT_W18`
- **timerRecordId**: (trace)
- **expected wait**: ~4s
- **observed wait**: ~5.6s
- **final status**: PASS

### W32 FOM override frequency monitor
- **timerCode**: `FOM_OVERRIDE_FREQUENCY_W32`
- **timerRecordId**: a069a6c7-9787-42f9-b187-54b1d7e84c9d
- **expected wait**: ~4s
- **observed wait**: ~0s
- **final status**: FIRED
- **notes**: Validated via TimerRecord (worker marks FIRED when timerRecordId is supplied).

### W10 Deficient resolution deadline
- **timerCode**: `DEFICIENT_RESOLUTION_DEADLINE_W10`
- **timerRecordId**: 917432ec-af0a-4e9f-a354-279cb4b2903a
- **expected wait**: ~6s
- **observed wait**: ~7.6s
- **final status**: FIRED

### W21 Payment milestone
- **timerCode**: `PAYMENT_MILESTONE_W21`
- **timerRecordId**: 385160cc-1964-4aff-9500-80bcbf310834
- **expected wait**: ~6s
- **observed wait**: ~8s
- **final status**: FIRED

### W26 Checkout time prompt
- **timerCode**: `CHECKOUT_TIME_W26`
- **timerRecordId**: db2af625-971f-460b-b8f8-e8cca850b606
- **expected wait**: ~6s
- **observed wait**: ~7.8s
- **final status**: FIRED

### W27 Dispute SLA check
- **timerCode**: `DISPUTE_SLA_W27`
- **timerRecordId**: 226bdb71-21d2-4a36-b443-ee96debd1ddf
- **expected wait**: ~6s
- **observed wait**: ~7.6s
- **final status**: FIRED

### W4 Pre-arrival window activation
- **timerCode**: `PRE_ARRIVAL_COUNTDOWN_W4`
- **timerRecordId**: 7b358df9-6871-43e2-817f-0e6c686d6eb2
- **expected wait**: ~5s
- **observed wait**: ~5.9s
- **final status**: FIRED
- **notes**: Transitions Entry S4→S5 and registers NO_SHOW_CUTOFF_W5.

### W5 No-show cutoff fired
- **timerCode**: `NO_SHOW_CUTOFF_W5`
- **timerRecordId**: 953cc2ab-f9cd-42be-bcaf-3cb51ecbe838
- **expected wait**: ~5s
- **observed wait**: ~5.8s
- **final status**: FIRED

### W5 Awaiting written confirmation auto-finalise
- **timerCode**: `AWAITING_WRITTEN_CONFIRMATION_W5`
- **timerRecordId**: f8ccf1cd-a6b1-4ca9-a7d7-50cfa8269e53
- **expected wait**: ~5s
- **observed wait**: ~5.7s
- **final status**: FIRED
- **notes**: Creates Folio+advance payment and lets worker finalize to TERMINAL/NO_SHOW_CLOSED.

### W15 Quotation expiry
- **timerCode**: `QUOTATION_VALIDITY_W15`
- **timerRecordId**: 65b7476b-b5dd-405e-9b96-b3243bea931d
- **expected wait**: ~5s
- **observed wait**: ~5.5s
- **final status**: FIRED

### W22 Quotation acknowledgement tracker
- **timerCode**: `QUOTATION_ACK_TRACKER`
- **timerRecordId**: 530deca5-5791-4471-be26-0cf0a3d79b30
- **expected wait**: ~5s
- **observed wait**: ~5.9s
- **final status**: FIRED

### W22 Acknowledgement window timeout
- **timerCode**: `ACKNOWLEDGEMENT_WINDOW_W22`
- **timerRecordId**: f75d0166-ec87-4320-8e83-6011d0f606cc
- **expected wait**: ~5s
- **observed wait**: ~5.7s
- **final status**: FIRED

### W23 Room readiness SLA breach
- **timerCode**: `ROOM_READINESS_SLA_W23`
- **timerRecordId**: f8b03c3b-5c89-406f-9a6a-e08d09b75baf
- **expected wait**: ~5s
- **observed wait**: ~5.6s
- **final status**: FIRED

### W25 Handoff acceptance window expiry
- **timerCode**: `H2_H3_ACCEPTANCE_W25`
- **timerRecordId**: c5d0e9ae-30e8-441b-98b2-a05f20769dce
- **expected wait**: ~5s
- **observed wait**: ~6s
- **final status**: FIRED

### W34 Advance payment follow-up
- **timerCode**: `ADVANCE_PAYMENT_FOLLOW_UP_W34`
- **timerRecordId**: 21a6351e-7824-4398-b025-b92d7b56487a
- **expected wait**: ~5s
- **observed wait**: ~5.8s
- **final status**: FIRED

### W16 Processing lock expiry
- **timerCode**: `PROCESSING_LOCK_TTL`
- **timerRecordId**: (no TimerRecord)
- **expected wait**: ~0s
- **observed wait**: (not fired within timeout)
- **final status**: PASS
- **notes**: Observed lock.status=EXPIRED

### W20 Entry expiry
- **timerCode**: `ENTRY_EXPIRY`
- **timerRecordId**: (no TimerRecord)
- **expected wait**: ~0s
- **observed wait**: (not fired within timeout)
- **final status**: PASS
- **notes**: Observed entry.status=EXPIRED

### W1 Stage dwell monitor
- **timerCode**: `STAGE_DWELL_MONITOR`
- **timerRecordId**: (no TimerRecord)
- **expected wait**: ~0s
- **observed wait**: (not fired within timeout)
- **final status**: PASS
- **notes**: warningFiredAt=2026-04-30T06:21:14.782Z, criticalFiredAt=2026-04-30T06:21:14.782Z, escalatedAt=2026-04-30T06:21:14.782Z

## Raw JSON

```json
[
  {
    "name": "W2 SpeculativeHold expiry",
    "timerCode": "SPECULATIVE_HOLD_EXPIRY_W2",
    "timerId": "4cd99074-5837-47b1-8c11-ce5225b4f6bb",
    "expectedWaitSeconds": 15,
    "observedWaitSeconds": 16,
    "status": "FIRED"
  },
  {
    "name": "W3 CommittedHold expiry",
    "timerCode": "COMMITTED_HOLD_EXPIRY_W3",
    "timerId": "3e28efbf-365e-4ef7-9dee-c4d295a2f350",
    "expectedWaitSeconds": 10,
    "observedWaitSeconds": 11.9,
    "status": "FIRED",
    "notes": "This creates a minimal CommittedHold row and schedules expiry near-now."
  },
  {
    "name": "W9 Post-checkout inspection window",
    "timerCode": "POST_CHECKOUT_INSPECTION_W9",
    "timerId": "df730927-1119-407b-82d1-650972281048",
    "expectedWaitSeconds": 12,
    "observedWaitSeconds": 13.7,
    "status": "FIRED",
    "notes": "This uses an explicit near-now dueAt for realtime validation."
  },
  {
    "name": "W11 Commission rate missing escalation",
    "timerCode": "COMMISSION_RATE_MISSING_W11",
    "timerId": "5b9e24cf-b2ff-4094-8f8f-d32461e5545b",
    "expectedWaitSeconds": 10,
    "observedWaitSeconds": 11.9,
    "status": "FIRED",
    "notes": "This uses an explicit near-now dueAt for realtime validation."
  },
  {
    "name": "W28 Feedback solicitation",
    "timerCode": "FEEDBACK_SOLICITATION_W28",
    "timerId": "8676408b-ddf3-4d43-ad01-166e8f3c7a77",
    "expectedWaitSeconds": 8,
    "observedWaitSeconds": 9.6,
    "status": "FIRED",
    "notes": "This uses an explicit near-now dueAt for realtime validation."
  },
  {
    "name": "W29 Equipment return deadline",
    "timerCode": "EQUIPMENT_RETURN_W29",
    "timerId": "24da1802-90a2-403f-87fb-93d58ac0e82f",
    "expectedWaitSeconds": 9,
    "observedWaitSeconds": 9.9,
    "status": "FIRED",
    "notes": "This uses an explicit near-now deadline for realtime validation."
  },
  {
    "name": "W8 Payment follow-up",
    "timerCode": "PAYMENT_FOLLOW_UP_W8",
    "timerId": "097a7b73-239d-466e-b5e4-91547106c730",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 7.6,
    "status": "FIRED",
    "notes": "Schedules pg-boss job and verifies TimerRecord flips to FIRED."
  },
  {
    "name": "W24 Housekeeping SLA breach",
    "timerCode": "HOUSEKEEPING_SLA_W24",
    "timerId": "a6f64247-995b-4e60-a483-bfe46237555e",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 7.9,
    "status": "FIRED",
    "notes": "Schedules pg-boss job and verifies TimerRecord flips to FIRED."
  },
  {
    "name": "P18 Guest data retention (code path for W30)",
    "timerCode": "GUEST_DATA_RETENTION_P18",
    "timerId": "31670874-40b8-45ca-8591-8b2cc48224cf",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 7.8,
    "status": "FIRED"
  },
  {
    "name": "W6 Night audit",
    "timerCode": "NIGHT_AUDIT_W6",
    "timerId": "(trace)",
    "expectedWaitSeconds": 4,
    "observedWaitSeconds": 5.6,
    "status": "PASS",
    "notes": "Validated via TraceEvent (night audit writes immutable NightAuditRecord instead of TimerRecord)."
  },
  {
    "name": "W7 OTA email poll (noop wiring)",
    "timerCode": "OTA_EMAIL_PARSER_POLL",
    "timerId": "(trace)",
    "expectedWaitSeconds": 4,
    "observedWaitSeconds": 5.8,
    "status": "PASS",
    "notes": "Repo slice has no IMAP integration; worker is wired and emits a NOOP trace."
  },
  {
    "name": "W12 Credit ceiling monitoring",
    "timerCode": "CREDIT_CEILING_MONITORING_W12",
    "timerId": "9f67c186-12a0-4385-9f03-6d62e986cecb",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 7.8,
    "status": "FIRED"
  },
  {
    "name": "W18 AI audit supplement (noop wiring)",
    "timerCode": "AI_AUDIT_SUPPLEMENT_W18",
    "timerId": "(trace)",
    "expectedWaitSeconds": 4,
    "observedWaitSeconds": 5.6,
    "status": "PASS"
  },
  {
    "name": "W32 FOM override frequency monitor",
    "timerCode": "FOM_OVERRIDE_FREQUENCY_W32",
    "timerId": "a069a6c7-9787-42f9-b187-54b1d7e84c9d",
    "expectedWaitSeconds": 4,
    "observedWaitSeconds": 0,
    "status": "FIRED",
    "notes": "Validated via TimerRecord (worker marks FIRED when timerRecordId is supplied)."
  },
  {
    "name": "W10 Deficient resolution deadline",
    "timerCode": "DEFICIENT_RESOLUTION_DEADLINE_W10",
    "timerId": "917432ec-af0a-4e9f-a354-279cb4b2903a",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 7.6,
    "status": "FIRED"
  },
  {
    "name": "W21 Payment milestone",
    "timerCode": "PAYMENT_MILESTONE_W21",
    "timerId": "385160cc-1964-4aff-9500-80bcbf310834",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 8,
    "status": "FIRED"
  },
  {
    "name": "W26 Checkout time prompt",
    "timerCode": "CHECKOUT_TIME_W26",
    "timerId": "db2af625-971f-460b-b8f8-e8cca850b606",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 7.8,
    "status": "FIRED"
  },
  {
    "name": "W27 Dispute SLA check",
    "timerCode": "DISPUTE_SLA_W27",
    "timerId": "226bdb71-21d2-4a36-b443-ee96debd1ddf",
    "expectedWaitSeconds": 6,
    "observedWaitSeconds": 7.6,
    "status": "FIRED"
  },
  {
    "name": "W4 Pre-arrival window activation",
    "timerCode": "PRE_ARRIVAL_COUNTDOWN_W4",
    "timerId": "7b358df9-6871-43e2-817f-0e6c686d6eb2",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.9,
    "status": "FIRED",
    "notes": "Transitions Entry S4→S5 and registers NO_SHOW_CUTOFF_W5."
  },
  {
    "name": "W5 No-show cutoff fired",
    "timerCode": "NO_SHOW_CUTOFF_W5",
    "timerId": "953cc2ab-f9cd-42be-bcaf-3cb51ecbe838",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.8,
    "status": "FIRED"
  },
  {
    "name": "W5 Awaiting written confirmation auto-finalise",
    "timerCode": "AWAITING_WRITTEN_CONFIRMATION_W5",
    "timerId": "f8ccf1cd-a6b1-4ca9-a7d7-50cfa8269e53",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.7,
    "status": "FIRED",
    "notes": "Creates Folio+advance payment and lets worker finalize to TERMINAL/NO_SHOW_CLOSED."
  },
  {
    "name": "W15 Quotation expiry",
    "timerCode": "QUOTATION_VALIDITY_W15",
    "timerId": "65b7476b-b5dd-405e-9b96-b3243bea931d",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.5,
    "status": "FIRED"
  },
  {
    "name": "W22 Quotation acknowledgement tracker",
    "timerCode": "QUOTATION_ACK_TRACKER",
    "timerId": "530deca5-5791-4471-be26-0cf0a3d79b30",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.9,
    "status": "FIRED"
  },
  {
    "name": "W22 Acknowledgement window timeout",
    "timerCode": "ACKNOWLEDGEMENT_WINDOW_W22",
    "timerId": "f75d0166-ec87-4320-8e83-6011d0f606cc",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.7,
    "status": "FIRED"
  },
  {
    "name": "W23 Room readiness SLA breach",
    "timerCode": "ROOM_READINESS_SLA_W23",
    "timerId": "f8b03c3b-5c89-406f-9a6a-e08d09b75baf",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.6,
    "status": "FIRED"
  },
  {
    "name": "W25 Handoff acceptance window expiry",
    "timerCode": "H2_H3_ACCEPTANCE_W25",
    "timerId": "c5d0e9ae-30e8-441b-98b2-a05f20769dce",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 6,
    "status": "FIRED"
  },
  {
    "name": "W34 Advance payment follow-up",
    "timerCode": "ADVANCE_PAYMENT_FOLLOW_UP_W34",
    "timerId": "21a6351e-7824-4398-b025-b92d7b56487a",
    "expectedWaitSeconds": 5,
    "observedWaitSeconds": 5.8,
    "status": "FIRED"
  },
  {
    "name": "W16 Processing lock expiry",
    "timerCode": "PROCESSING_LOCK_TTL",
    "timerId": "(no TimerRecord)",
    "expectedWaitSeconds": 0,
    "observedWaitSeconds": null,
    "status": "PASS",
    "notes": "Observed lock.status=EXPIRED"
  },
  {
    "name": "W20 Entry expiry",
    "timerCode": "ENTRY_EXPIRY",
    "timerId": "(no TimerRecord)",
    "expectedWaitSeconds": 0,
    "observedWaitSeconds": null,
    "status": "PASS",
    "notes": "Observed entry.status=EXPIRED"
  },
  {
    "name": "W1 Stage dwell monitor",
    "timerCode": "STAGE_DWELL_MONITOR",
    "timerId": "(no TimerRecord)",
    "expectedWaitSeconds": 0,
    "observedWaitSeconds": null,
    "status": "PASS",
    "notes": "warningFiredAt=2026-04-30T06:21:14.782Z, criticalFiredAt=2026-04-30T06:21:14.782Z, escalatedAt=2026-04-30T06:21:14.782Z"
  }
]
```
