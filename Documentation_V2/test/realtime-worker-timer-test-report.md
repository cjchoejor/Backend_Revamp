# Realtime worker/timer test report

- **Ran at**: 2026-04-28T10:22:27.540Z
- **Entry**: ce5ac87e-8119-4c19-9e1e-8677f945f437
- **Room**: 37d3a578-464c-4723-a21b-71fd9889b4bf

## Scenario

- Create new Entry at **S2** + Segment
- Place a **Speculative Hold** with (ttlSeconds = 20)
- Wait for pg-boss queue **SPECULATIVE_HOLD_EXPIRY_W2** to fire naturally

## Configured vs observed timing

- **Timer code**: `SPECULATIVE_HOLD_EXPIRY_W2`
- **Configured ttlSeconds (input override)**: 20
- **TimerRecord.firesAt**: 2026-04-28T10:22:47.772Z
- **Expected wait (derived)**: ~20s
- **Observed firedAt**: 2026-04-28T10:22:49.679Z
- **Observed wait**: ~21.9s
- **Final TimerRecord.status**: FIRED

## Raw TimerRecord snapshot

```json
{
  "timerRecordId": "b9553251-08a2-4815-a9dc-61c9e6dffc42",
  "timerCode": "SPECULATIVE_HOLD_EXPIRY_W2",
  "dueAt": "2026-04-28T10:22:47.772Z",
  "firesAt": "2026-04-28T10:22:47.772Z",
  "scheduledAt": "2026-04-28T10:22:27.735Z",
  "firedAt": "2026-04-28T10:22:49.679Z",
  "status": "FIRED",
  "expectedWaitSeconds": 20,
  "observedWaitSeconds": 21.9,
  "bossJobsBefore": [
    {
      "id": "742fa739-a5d8-4c70-91af-cb63350578fc",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "created",
      "start_after": "2026-04-28T10:22:47.772Z",
      "created_on": "2026-04-28T10:22:27.986Z",
      "completed_on": null,
      "retry_count": 0
    },
    {
      "id": "b5a52bd3-eefc-4aab-9bba-ae339109fd11",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:18:30.540Z",
      "created_on": "2026-04-28T10:18:10.659Z",
      "completed_on": "2026-04-28T10:18:34.525Z",
      "retry_count": 0
    },
    {
      "id": "933e1674-88e1-492f-a6f7-76a1fe970712",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:18:30.540Z",
      "created_on": "2026-04-28T10:18:10.636Z",
      "completed_on": "2026-04-28T10:18:32.506Z",
      "retry_count": 0
    },
    {
      "id": "25add97c-e83d-4b39-b6a6-44cb6b2ca278",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:15:51.785Z",
      "created_on": "2026-04-28T10:15:31.906Z",
      "completed_on": "2026-04-28T10:15:55.815Z",
      "retry_count": 0
    },
    {
      "id": "d0c84851-47d0-4905-b974-1e25066687c4",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:15:51.785Z",
      "created_on": "2026-04-28T10:15:31.884Z",
      "completed_on": "2026-04-28T10:15:53.798Z",
      "retry_count": 0
    }
  ],
  "bossJobsAfter": [
    {
      "id": "742fa739-a5d8-4c70-91af-cb63350578fc",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:22:47.772Z",
      "created_on": "2026-04-28T10:22:27.986Z",
      "completed_on": "2026-04-28T10:22:49.706Z",
      "retry_count": 0
    },
    {
      "id": "b5a52bd3-eefc-4aab-9bba-ae339109fd11",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:18:30.540Z",
      "created_on": "2026-04-28T10:18:10.659Z",
      "completed_on": "2026-04-28T10:18:34.525Z",
      "retry_count": 0
    },
    {
      "id": "933e1674-88e1-492f-a6f7-76a1fe970712",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:18:30.540Z",
      "created_on": "2026-04-28T10:18:10.636Z",
      "completed_on": "2026-04-28T10:18:32.506Z",
      "retry_count": 0
    },
    {
      "id": "25add97c-e83d-4b39-b6a6-44cb6b2ca278",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:15:51.785Z",
      "created_on": "2026-04-28T10:15:31.906Z",
      "completed_on": "2026-04-28T10:15:55.815Z",
      "retry_count": 0
    },
    {
      "id": "d0c84851-47d0-4905-b974-1e25066687c4",
      "name": "SPECULATIVE_HOLD_EXPIRY_W2",
      "state": "completed",
      "start_after": "2026-04-28T10:15:51.785Z",
      "created_on": "2026-04-28T10:15:31.884Z",
      "completed_on": "2026-04-28T10:15:53.798Z",
      "retry_count": 0
    }
  ]
}
```
