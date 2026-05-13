# Stage 1 (S1) — scenarios (Layer 03a · `#s1-deep`)

Source: **LEGPHEL_Implementation_Reference_v1_1.html** — S1 inquiry & configuration operational flow.

| Scenario JSON file | Reference intent |
|--------------------|-------------------|
| `new-inquiry-intake-and-first-entry.json` | New inquiry intake · L1 creates inquiry + first entry |
| `additional-entry-existing-inquiry.json` | Additional entry under same inquiry |
| `availability-search-configuration-and-deficient-surface.json` | Availability engine query · persisted configuration · deficient surfacing |
| `deficient-room-selection-blocked-without-acknowledgement.json` | DEFICIENT path · selection blocked until acknowledgement |
| `preferred-configuration-selection-clean-room.json` | Select preferred option on clean inventory |
| `s1-to-s2-exit-progress-stage.json` | S1→S2 exit guard / `progress-stage` (may 409 until guards satisfied) |
| `processing-lock-placement-reconfirm-delta.json` | Processing lock TTL · reconfirm · revalidation delta |
| `w7-ota-email-parser-ingestion-scaffold.json` | W7 OTA email ingestion idempotency scaffold |

Architectural forbiddens at S1 (reference caption): no commitment, no hold, no payment, no folio.
