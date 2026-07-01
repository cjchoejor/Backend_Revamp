# LEGPHEL PMS — Canon v2.5 Change Set
## Addendum to Canon v2.4
**Document:** CANON-V2.5-CHANGESET.md
**Date:** 07 April 2026
**Authority:** MOM-ARCH-2026-013 (Gate 1 Review Flags — RF-3 resolution)
**Nature:** Additive only — no deletions, no restructuring of v2.4 content
**Base document:** Canon v2.4 (v2.2 + CANON-V2.3-CHANGESET.md + CANON-V2.4-CHANGESET.md)
**Applies to:** Block 11 §70 and §71

> **How to read this document:** Each change entry specifies the exact block, section, and insertion point. "Insert after" gives the last sentence of existing text before the insertion. "New text" is what is added immediately after that point. No existing v2.4 text is modified or deleted.

---

## Revision Log

| Rev | Date | Author | Nature |
|---|---|---|---|
| 2.5 | 07 April 2026 | Dhendup Cheten / Claude | One targeted addition: Session Event Record added to §70 and §71 (RF-3 resolution, MOM-ARCH-2026-013) |

---

## Change Reference Index

| Ref | Source | Block/Section | Nature |
|---|---|---|---|
| REV-B11-V25-01 | RF-3 / MOM-ARCH-2026-013 | Block 11 §70 | Session Event Record added to canonical record types table |
| REV-B11-V25-02 | RF-3 / MOM-ARCH-2026-013 | Block 11 §71 | Session Event Record mutation rules added |

---

# PART 1 — BLOCK 11 CHANGES

---

## REV-B11-V25-01
**Source:** RF-3 / MOM-ARCH-2026-013
**Block:** 11
**Section:** §70 — Canonical Record Types
**Nature:** Session Event Record added as a new row to the existing canonical record types table. Derived from §34.4 (Authentication, Attribution, and Session Control), which requires that all session boundary events — PIN switch, idle auto-lock, manual lock, hard logout — are recorded with timestamp, actor, and event detail.

**In the existing §70 canonical record types table, insert the following row after the "Commission-Due Record" row (or in the authentication/session cluster if one exists):**

```
<!-- REV-B11-V25-01 | 07 Apr 2026 | Source: RF-3 / MOM-ARCH-2026-013 |
§34.4 requires that session boundary events are recorded with timestamp and actor.
The language used ("recorded as a session event", "lock event is recorded",
"hard logout event is recorded") is identical to the language that produces
canonical records throughout the Canon. Session Event Record was documented in
§34.4 but absent from §70. This addition closes that omission. -->
```

| Record Type | Definition | Created At | Sealed/Closed At | Primary Anchor |
|---|---|---|---|---|
| **Session Event Record** | A governed record of a session boundary event at an operational terminal. Event types: PIN_SWITCH (outgoing and incoming actor both recorded), IDLE_AUTO_LOCK (inactivity threshold reached; session paused), MANUAL_LOCK (staff-initiated one-action lock; session paused), HARD_LOGOUT (extended inactivity threshold reached; session terminated). Carries: event_type, terminal_identifier, actor_id (incoming actor for PIN_SWITCH; locking actor for lock events; logging-out actor for hard logout), outgoing_actor_id (PIN_SWITCH only), timestamp, trigger (MANUAL, TIMER, or INACTIVITY). Supports attribution integrity verification, shift boundary governance, and FOM session visibility. | On occurrence of any session boundary event | Immutable from creation — no update or amendment path exists | Staff user record (actor_id) |

---

## REV-B11-V25-02
**Source:** RF-3 / MOM-ARCH-2026-013
**Block:** 11
**Section:** §71 — Record Mutation and Layering Rules
**Nature:** Session Event Record mutation rules added as a new row to the existing mutation rules table.

**In the existing §71 mutation rules table, insert the following row after the "Commission-Due Record" row (or adjacent to Session Event Record's position in §70):**

```
<!-- REV-B11-V25-02 | 07 Apr 2026 | Source: RF-3 / MOM-ARCH-2026-013 |
Mutation rules for Session Event Record — companion to REV-B11-V25-01. -->
```

| Record Type | Create | Update (editable fields) | Amend (layered change) | Seal (becomes immutable) | Archive |
|---|---|---|---|---|---|
| Session Event Record | On occurrence of session boundary event — system-generated (L0 actor) | Not permitted — no fields are editable after creation | Not permitted — no amendment path exists. A corrected or superseding session event is a new record; the original is preserved. | Immutable from creation — no explicit seal event required; the record is sealed at creation | With the associated staff user record; retained for audit and governance reporting |

---

# SUMMARY — WHAT CANON v2.5 ADDS OVER v2.4

| Area | What was missing in v2.4 | What v2.5 adds |
|---|---|---|
| §70 Canonical Record Types | Session boundary events described and required in §34.4 but absent from the canonical record types register. No formal definition of what the record contains, when it is created, or what it anchors to. | Session Event Record added to §70 with full definition: four event types (PIN_SWITCH, IDLE_AUTO_LOCK, MANUAL_LOCK, HARD_LOGOUT), defined fields, created on occurrence, immutable from creation, anchored to staff user record. |
| §71 Record Mutation Rules | No mutation rules for Session Event Record — consequence of its absence from §70. | Session Event Record mutation rules added: create-only, no update, no amendment, sealed at creation, archived with staff user record. |

**Canon v2.5 = Canon v2.4 + this change set. No v2.4 content is modified or deleted.**

---

*End of CANON-V2.5-CHANGESET.md*
*Authority: MOM-ARCH-2026-013 | Architect: Dhendup Cheten | Date: 07 April 2026*
