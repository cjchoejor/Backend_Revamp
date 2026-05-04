# Worker/timer timebox plan (30-minute window)

- **Effective from**: 2026-04-30T06:17:12.515Z
- **Effective to**: 2026-04-30T06:27:12.515Z

This document records the **current active values** (before) and the **short test values** (after) used to make time-based workers fire within seconds/minutes.

## How values were set

- We store timer/worker configuration in the `configuration_entries` table (`ConfigurationEntry` model).
- For each key below, the script inserts a **new ConfigurationEntry row** with:
  - `effectiveFrom = now`
  - `effectiveTo = now + 30 minutes`
  - `configValue = short test value`
- This overrides older values *temporarily* (because selection is by latest effectiveFrom within the active range).
- After the 30-minute window, the test values automatically expire (due to `effectiveTo`).

## Key-by-key changes

### `acknowledgement.windowPerType`
- **Purpose**: W22 acknowledgement windows + H2/H3 SLA windows (used across S2/S4/S6).
- **Unit**: seconds
- **Before (active)**:
```json
{
  "h2": 3600,
  "h3": 3600,
  "pi": 86400,
  "invoice": 604800,
  "voucher": 172800,
  "amendment": 43200,
  "quotation": 86400,
  "preArrival": 86400,
  "cancellation": 43200
}
```
- **After (test value)**:
```json
{
  "quotation": 60,
  "voucher": 60,
  "h2": 60,
  "h3": 60
}
```

### `expiry.s1.defaultTtlSeconds`
- **Purpose**: ENTRY_EXPIRY timer on unpark / S1 expiry.
- **Unit**: seconds
- **Before (active)**:
```json
{
  "DEFAULT": 3600
}
```
- **After (test value)**:
```json
{
  "DEFAULT": 120
}
```

### `expiry.s2.speculativeHoldTtlSeconds`
- **Purpose**: SPECULATIVE_HOLD_EXPIRY_W2 dueAt.
- **Unit**: seconds
- **Before (active)**:
```json
900
```
- **After (test value)**:
```json
120
```

### `expiry.s3.committedHoldTtlSeconds`
- **Purpose**: COMMITTED_HOLD_EXPIRY_W3 dueAt.
- **Unit**: seconds
- **Before (active)**:
```json
3600
```
- **After (test value)**:
```json
180
```

### `noShow.cutoffWindowMinutes`
- **Purpose**: W5 cutoff scheduling (NO_SHOW_CUTOFF_W5 dueAt relative to expected arrival).
- **Unit**: minutes
- **Before (active)**:
```json
120
```
- **After (test value)**:
```json
1
```

### `noShow.awaitingConfirmationWindowMinutes`
- **Purpose**: AWAITING_WRITTEN_CONFIRMATION_W5 dueAt (NoShow DEFER path).
- **Unit**: minutes
- **Before (active)**:
```json
180
```
- **After (test value)**:
```json
1
```

### `preArrival.windowDays`
- **Purpose**: W4 PRE_ARRIVAL_COUNTDOWN_W4 schedule time relative to arrival.
- **Unit**: days (0 => immediate window open)
- **Before (active)**:
```json
1
```
- **After (test value)**:
```json
0
```

### `housekeeping.sla.windowMinutes`
- **Purpose**: W24 HOUSEKEEPING_SLA_W24 dueAt after S8 physical departure + W23 fallback window.
- **Unit**: minutes
- **Before (active)**:
```json
180
```
- **After (test value)**:
```json
1
```

### `housekeeping.sla.readinessWindowMinutes`
- **Purpose**: W23 ROOM_READINESS_SLA_W23 dueAt after room assignment when room not ready.
- **Unit**: minutes
- **Before (active)**:
```json
180
```
- **After (test value)**:
```json
1
```

### `inspection.postCheckout.windowDays`
- **Purpose**: W9 POST_CHECKOUT_INSPECTION_W9 dueAt when inspection is deferred at S8.
- **Unit**: days (min 1 in code; use timer dueAt adjustment for fast test if needed)
- **Before (active)**:
```json
2
```
- **After (test value)**:
```json
1
```

### `feedback.solicitation.delaySeconds`
- **Purpose**: W28 FEEDBACK_SOLICITATION_W28 dueAt after S9 close.
- **Unit**: seconds
- **Before (active)**:
```json
3600
```
- **After (test value)**:
```json
10
```

### `commission.rateMissing.resolutionSeconds`
- **Purpose**: W11 COMMISSION_RATE_MISSING_W11 dueAt after S9 close (RATE_MISSING).
- **Unit**: seconds
- **Before (active)**:
```json
60
```
- **After (test value)**:
```json
60
```

### `payment.followUp.ttlDays`
- **Purpose**: W8 follow-up dueAt when closing S9 with OUTSTANDING (TimerRecord only in this slice).
- **Unit**: days (fractional allowed; set to ~259 seconds)
- **Before (active)**:
```json
7
```
- **After (test value)**:
```json
0.003
```

### `availability.staleness.ttlSeconds`
- **Purpose**: W1 StageDwellMonitor uses it to compute availability staleness cutoff.
- **Unit**: seconds
- **Before (active)**:
```json
900
```
- **After (test value)**:
```json
30
```

### `stageDwell.thresholds`
- **Purpose**: W1 StageDwellMonitor thresholds for dwell escalation (if used).
- **Unit**: seconds
- **Before (active)**:
```json
{
  "S1": {
    "IDLE": {
      "warning": 900,
      "critical": 1800,
      "escalation": 2700
    },
    "ACTIVE": {
      "warning": 600,
      "critical": 1200,
      "escalation": 1800
    },
    "PARKED": {
      "warning": 1800,
      "critical": 3600,
      "escalation": 5400
    }
  }
}
```
- **After (test value)**:
```json
{
  "S1": {
    "ACTIVE": {
      "warning": 10,
      "critical": 20,
      "escalation": 30
    },
    "IDLE": {
      "warning": 10,
      "critical": 20,
      "escalation": 30
    },
    "PARKED": {
      "warning": 10,
      "critical": 20,
      "escalation": 30
    }
  },
  "DEFAULT": {
    "ACTIVE": {
      "warning": 10,
      "critical": 20,
      "escalation": 30
    },
    "IDLE": {
      "warning": 10,
      "critical": 20,
      "escalation": 30
    },
    "PARKED": {
      "warning": 10,
      "critical": 20,
      "escalation": 30
    }
  }
}
```

### `processingLock.ttl.perChannel`
- **Purpose**: PROCESSING_LOCK_TTL scheduling for S1 processing locks.
- **Unit**: seconds
- **Before (active)**:
```json
{
  "PHONE": 600,
  "EMAIL_AI": 300,
  "FRONT_DESK": 600,
  "WHATSAPP_AI": 300
}
```
- **After (test value)**:
```json
{
  "DEFAULT": 60
}
```

### `fomOverride.frequency`
- **Purpose**: W33 rolling window and max frequency (not a timer; used when worker runs).
- **Unit**: days + count
- **Before (active)**:
```json
{
  "maxFrequency": 1,
  "rollingWindowDays": 7
}
```
- **After (test value)**:
```json
{
  "rollingWindowDays": 1,
  "maxFrequency": 1
}
```

## Notes / constraints

- Some windows are designed in **days** (e.g. `inspection.postCheckout.windowDays`, `payment.followUp.ttlDays`).
  - For those, we set them to the smallest valid value, and in the timed test we’ll either:
    - choose flows where the worker is not required to fire, or
    - adjust the scheduled timer’s `dueAt/firesAt` to near-now (still letting pg-boss process it naturally).
