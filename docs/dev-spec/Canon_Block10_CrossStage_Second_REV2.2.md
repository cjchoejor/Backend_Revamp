# LEGPHEL PMS — Operational Workflow & Control Canon

## Version 2.2 — Block 10

**Scope:** Part 8 second half — Cross-Stage Operational Mechanisms (Sections 56–61, 63–69)
**Status:** Revised — Block 10 of 12
**Date:** 26 March 2026

---

## Block 10 Revision Log

| Rev | Date | Author | Nature | Sections Affected |
|---|---|---|---|---|
| 2.0 | 25 Mar 2026 | Dhendup Cheten / Claude | Initial draft | All |
| 2.1 | 26 Mar 2026 | Dhendup Cheten / Claude | Architect review corrections applied — commission-due record mandate added to group closure (Section 56); DEFICIENT flag doctrine added to room moves (Section 57); overbooking relocation external handshake closure criteria added (Section 61); OTA_CONFLICT routing added to OTA sync (Section 64); work order seed data delivery obligation formalised (Section 65); DEFICIENT flag resolution obligation added to housekeeping basis (Section 66) | Section 56, 57, 61, 64, 65, 66 |
| 2.2 | 26 Mar 2026 | Dhendup Cheten / Claude | MOM-007 thread closures applied — commission references made conditional; T08/T19 open seams replaced with locked architecture; three new cross-stage mechanism sections added | Section 56, Section 58, Section 64, NEW Sections 70A/70B/70C |

**Change references used in this block:**

| Ref | Source | Description |
|---|---|---|
| REV-B10-01 | Block 8 REV-B8-06 downstream consequence | Commission-due record mandate applied to group S9 closure — Section 56 M.12 updated |
| REV-B10-02 | Block 3 REV-B3-03 + Block 7 REV-B7-02 downstream consequence | DEFICIENT flag doctrine applied to room moves — Section 57 M.6, M.8, M.9, M.11 updated |
| REV-B10-03 | Combined Review — GPT (overbooking relocation external handshake closure) | Partner hotel relocation external handshake closure criteria added — Section 61 M.8, M.11, M.12, M.13 updated |
| REV-B10-04 | Block 3 REV-B3-02 + Block 6 REV-B6-04 downstream consequence | OTA_CONFLICT trigger type routing added to OTA sync — Section 64 M.8, M.14 updated |
| REV-B10-05 | Combined Review — Tier 2 (work order seed data delivery obligation) | Work order seed data dependency formalised as tracked delivery obligation — Section 65 M.14 updated |
| REV-B10-06 | Block 8 REV-B8-03 downstream consequence | DEFICIENT flag resolution obligation added to housekeeping basis charter — Section 66 updated |

---

# PART 8 — CROSS-STAGE OPERATIONAL MECHANISMS (continued)

---

## 56. Group Booking Management

### M.1 Purpose
Governs the operational handling of group bookings as a first-class workflow — from intake through settlement — covering group structure, individual tracking, bulk entry, billing mode transitions, and coordination with the group's commercial counterparty.

### M.2 Why This Exists in the Canon
Group bookings at Legphel range from 2 to 27 rooms (full house). They involve different handling for travel agent groups versus corporate groups, hierarchy-aware room allocation for corporate, coordinator dynamics, work order adjustment games, and billing complexity that changes mid-engagement. Groups are not a variation of individual bookings — they are a distinct operational pattern requiring explicit governance.

### M.3 Trigger Conditions
An engagement qualifies as a group when two or more rooms or accommodating units are booked under a single inquiry by the same commercial counterparty (agent, corporate, coordinator).

### M.4 Allowed Actors
Reservations or front desk staff create and manage the group structure. FOM approves billing mode transitions. GM approves FOC entitlements for the group. The coordinator (external party) provides guest lists, amendments, and operational instructions — but coordinator actions are recorded, not self-served.

### M.5 Blocked Actors
The coordinator may not directly access the system. All coordinator requests are mediated by hotel staff and recorded as system events. Front desk may not approve billing splits or FOC allocations without FOM authority.

### M.6 Policy Envelope
**Group FOC policy** — one FOC per ten rooms, or per contract terms. Same FOC validation (MSR, entitlement, seasonality) from Section 30. **Group billing policy** — governs available billing modes and transition authority. **Group cancellation policy** — governs partial cancellation (some rooms cancelled, others retained) and its financial consequences. **Group rate policy** — governs whether the group rate applies to late additions or whether additions revert to standard pricing.

### M.7 Configuration Dependencies
FOC entitlement formula per group size, billing mode options, group rate lock rules (additions within X days of arrival get group rate, after that standard rate), bulk entry tool input format configuration, and rooming list template.

### M.8 Stage Impact
**S1:** Group inquiry created. Expected room count and composition captured. Use type and corporate context selected. Multiple contacts captured — agent as commercial counterparty, coordinator as operational contact, group leader if known.

**S2:** Rate negotiated for the group. Volume pricing bands may apply. FOC entitlement calculated and presented for GM approval. Quotation reflects group terms.

**S3:** Committed hold on the full room block. Advance payment per group policy. Coordinator formally confirmed with authority scope. Work order initiated if the group includes conference or package services.

**S4:** Confirmation covers the full group. Individual entries may be created at S4 (if the rooming list is available) or deferred to S5/S6 (if the rooming list comes later). The system supports both: early rooming list (individual entries created at confirmation) and late rooming list (group container confirmed, individual entries populated when the list arrives).

**S5–S6:** Rooming list arrival and individual entry creation through the bulk entry tool. Three input methods: Excel/CSV upload, copy-paste from email, and rapid manual keyboard entry (tab between fields, auto-suggest from guest database, enter key advances to next guest). For corporate groups, the system presents rooms from best to standard so that hierarchy-aware allocation can be applied — CEO gets the suite, directors get deluxe, staff get standard. Identity verification at S6 is per individual.

**S7:** Individual entries operate independently during the stay. Billing may be CONSOLIDATED (one folio for the group), INDIVIDUAL (each guest has their own folio), or SPLIT (some charges consolidated, others individual). **Billing mode transitions are permitted at any stage from S2 onward with FOM authority and recorded reason.** A guest who was on consolidated billing may request individual billing for personal charges mid-stay. The system creates a folio split event — not by editing the consolidated folio, but by establishing individual tracking for specified charge categories while the group folio continues for the base accommodation.

**S8:** Group checkout may be sequential (guests depart over time) or simultaneous (crowd checkout). For crowd checkout, the system supports advance bill preparation (night audit compiles all group folios the night before), priority sequencing, and parallel processing. Individual settlement per guest's billing mode. Coordinator reviews the consolidated group bill separately from individual settlements.

**S9:** Group closure requires all individual entries to reach terminal state. Outstanding balances per individual or per group are governed independently. For agent-mediated groups where the agent profile has a commission rate configured, commission-due record production follows the configuration-activated mechanism defined in Section 50.5 (T20 parked per MOM-007). When no commission rate is configured, no commission-due record is required for group closure.

### M.9 Records Created or Affected
Group booking container (GRP reference), individual entries (ENT references, one per accommodation unit), group member records (joins individual to group, carries billing mode and assignment), rooming list upload records, bulk entry audit trail, FOC allocation records, coordinator amendment records.

### M.10 Timers / Workers Involved
Rooming list deadline timer — if the rooming list was promised by a date, the Timer Engine tracks it. Pre-arrival timers fire per individual entry. Group checkout coordination timer — surfaces crowd checkout risk.

### M.11 Evidence Required
Group container created with confirmed room block. Individual entries created with identity (when rooming list available). Billing mode established per individual and per group. FOC validation complete. All individual entries at terminal state for group closure.

<!-- REV-B10-01 | 26 Mar 2026 | Source: Block 8 REV-B8-06 downstream consequence | Group S9 closure must produce commission-due records per the T20 interim doctrine. The original text acknowledged commission tracking for agent-mediated groups but did not apply the commission-due record mandate. -->

### M.12 Closure Rule
The group is closed when all individual entries are closed and all group-level financial obligations (consolidated charges, FOC accounting) are resolved. For agent-mediated group bookings where the agent profile has a commission rate configured, a commission-due record is produced at group closure — one record per engagement covering the group totals (total group folio value subject to commission, applicable commission rate, calculated commission amount in BTN). If the group had individual-level billing with separate folios, individual commission-due records reference back to the group container. When no commission rate is configured on the agent profile, no commission-due record is required and group closure is not blocked by its absence (T20 parked per MOM-007). Group closure IS blocked if a commission-due record has been produced and carries a RATE_MISSING escalation that has not been resolved.

### M.13 Forbidden Acts
Assigning FOC rooms without GM approval and MSR validation. Silently changing the group rate for late additions without following the group rate lock policy. Allowing the coordinator to view overall hotel availability during the booking workflow (coordinator gaming protection from Section 31). Creating individual entries without linking them to the group container. Closing a group without producing a commission-due record for agent-mediated bookings when the agent profile has a commission rate configured.

### M.14 Notes on Open Seams / Deferred Items
The conference and F&B variation list for corporate groups (mentioned in MOM-004 as pending from Dhendup) affects work order template configuration. The seed data for group work order templates depends on this input. See Section 65 M.14 for the tracked delivery obligation.

---

## 57. Room Moves, Upgrades, Downgrades, and Reassignment

### M.1 Purpose
Governs all in-life room changes — guest-requested, hotel-initiated, or system-triggered — ensuring that every move produces a new segment, adjusts the folio correctly, updates inventory, refreshes housekeeping obligations, and maintains full traceability.

### M.2 Why This Exists in the Canon
Room changes are frequent at Legphel. Guests request better views, non-functional amenities force moves, overbooking resolution requires relocation, and operational needs (maintenance, VIP arrival) sometimes require the hotel to initiate a move. Each of these has different authority requirements, different financial consequences, and different guest communication obligations.

### M.3 Trigger Conditions
Guest requests a different room. Hotel discovers a room deficiency that requires a move. Maintenance event makes the current room unavailable. Overbooking resolution requires internal relocation. VIP arrival requires the hotel to reassign a room. Guest composition change requires a different room type.

### M.4 Allowed Actors
Front desk initiates. FOM approves rate-affecting moves and hotel-initiated moves. GM approves moves that involve overbooking resolution or significant financial impact.

### M.5 Blocked Actors
Front desk may not approve a room change that changes the rate without FOM authority. No actor may move a guest to a room that is not in AVAILABLE CLEAN or AVAILABLE INSPECTED state without applying the DEFICIENT flag doctrine.

<!-- REV-B10-02 | 26 Mar 2026 | Source: Block 3 REV-B3-03 + Block 7 REV-B7-02 downstream consequence | Room moves target a new room. That target room may carry a DEFICIENT flag. The doctrine established in Block 3 (DEFICIENT sub-state) and applied in Block 7 (S5 room assignment) applies equally to mid-stay room moves. A DEFICIENT-flagged destination room is not a hard block, but the assignment must be documented. The deficiency discount policy also applies. -->

### M.6 Policy Envelope
**Room change authority policy** — who approves based on the reason and financial impact. **Upgrade perception policy** — hotel-caused moves warrant complimentary upgrade; guest-initiated moves warrant rate difference charge (Section 55). **Rate delta policy** — governs how rate differences are handled: charge the difference, absorb as service recovery, or apply negotiated terms. **Deficiency flag policy** — if the destination room carries an unresolved DEFICIENT flag, the move decision must acknowledge the condition. The configurable condition-based discount may apply per the deficiency discount configuration. The guest must not be moved to a DEFICIENT-flagged room without staff awareness and documented decision.

### M.7 Configuration Dependencies
Room change authority thresholds, rate delta handling rules per move reason, deficiency discount configuration per deficiency type, deficiency flag acknowledgement requirement for room moves, and room move communication templates.

### M.8 Stage Impact
Room moves during S7 trigger the Room Change operational mode. The system activates S1 (availability check for the new room, showing availability AND room readiness simultaneously including any DEFICIENT flag status on candidate rooms), compresses through S2/S3/S4 as needed. A new segment is created. The old room transitions from OCCUPIED to DEPARTED DIRTY. The new room transitions to OCCUPIED. The folio receives an adjustment layer. Housekeeping receives an updated H2 — if the destination room carries a DEFICIENT flag, the H2 includes the condition description and resolution deadline so housekeeping is aware. The drag-and-drop Room Grid triggers this entire sequence silently — the user drags a booking bar from one room to another, sees consequences displayed during the drag (including any DEFICIENT condition on the destination room), and confirms on drop.

### M.9 Records Created or Affected
New segment, room assignment change record (with DEFICIENT flag status of destination room at time of move), folio adjustment lines, inventory state transitions (both rooms), updated H2 handoff (with DEFICIENT condition if applicable), communication record if guest notified, service recovery record if hotel-caused.

### M.10 Timers / Workers Involved
Room readiness SLA timer for the new room (if not immediately ready). DEFICIENT condition resolution deadline timer activates on the new room if it carries an unresolved DEFICIENT flag at time of move. The room change mode implies urgency — the guest is typically waiting — so dwell thresholds are compressed.

### M.11 Evidence Required
New room confirmed as available and ready. DEFICIENT flag status of destination room assessed and documented. Rate delta calculated and approved per authority. Folio adjustment posted. Old room released. New H2 accepted by housekeeping (with DEFICIENT condition acknowledged if applicable).

### M.12 Closure Rule
Room move is closed when the guest is in the new room, the folio is adjusted, both room states are updated, and housekeeping has accepted the new H2.

### M.13 Forbidden Acts
Moving a guest to a room that is not ready. Absorbing a rate increase as complimentary when the move is guest-initiated (the upgrade perception distinction). Performing a room move without segment creation — every move is a governed lifecycle event. Moving a guest to a DEFICIENT-flagged room without acknowledging and documenting the DEFICIENT condition.

### M.14 Notes on Open Seams / Deferred Items
None. Room moves are fully deliberated.

---

## 58. Communication Continuity and Contact Record

### M.1 Purpose
Governs all outbound and inbound communication as operational evidence — ensuring that every material communication is tracked, threaded, acknowledgement-monitored, and available for dispute resolution and audit.

### M.2 Why This Exists in the Canon
Communication is not a peripheral function. At Legphel, WhatsApp is the primary channel. Emails carry quotations, PIs, confirmation vouchers, and cancellation notices. Phone calls produce verbal promises that later become disputes when unrecorded. OTA confirmations arrive as emails. Every one of these communications is operational evidence. The system must track them, thread them, and monitor their acknowledgement.

### M.3 Trigger Conditions
Any outbound communication of material content: quotation sent, PI sent, confirmation voucher sent, amendment notification sent, cancellation notice sent, pre-arrival correspondence, no-show notification, dispute correspondence, feedback solicitation. Any inbound communication that carries operational significance: guest acceptance, agent response, coordinator instruction, OTA confirmation, payment confirmation, complaint, dispute position.

### M.4 Allowed Actors
Any operational staff may send communications through the system. The system auto-generates communications at defined trigger points (confirmation, amendment, cancellation). FOM reviews communication threads during dispute resolution.

### M.5 Blocked Actors
No actor may send material communications outside the system that bypass the communication log. A quotation emailed from a personal email account without a system record is an ungoverned communication. The system must be the communication channel of record.

### M.6 Policy Envelope
**Communication channel policy** — governs which channels are used for which communication types and which client preferences. **Acknowledgement tracking policy** — governs which outbound communications require acknowledgement tracking, the acknowledgement window, and escalation on non-acknowledgement. **Communication disclosure policy** — governs what must be included in specific communication types (cancellation terms in confirmation emails, rate basis in quotation emails).

### M.7 Configuration Dependencies
Communication templates per type and channel, acknowledgement window per communication type, escalation rules for non-acknowledgement, WhatsApp integration configuration, email threading configuration (subject line conventions, reply-to handling), and channel preference per client/agent profile.

### M.8 Stage Impact
Communication is universal across all stages. Every stage that produces a material document (quotation at S2, PI at S3, confirmation at S4, amendment at any stage, cancellation at any stage) generates a tracked communication event. The communication record carries: channel (EMAIL, WHATSAPP, PHONE, OTA), message_id, thread_id, in_reply_to reference, linked stage, linked segment, content summary, send status, and acknowledgement status.

**Acknowledgement tracking as a universal open loop.** Every material outbound communication opens a loop. The loop is closed by: explicit acknowledgement (reply email, WhatsApp response, written confirmation), implicit acknowledgement (guest arrives — de facto confirms they received and accepted the confirmation), or governed timeout (configurable window expires, system escalates, loop formally closed with "no acknowledgement received" record and the non-acknowledgement becomes a flag on the entry).

The acknowledgement loop does not block stage progression in most cases — the hotel should prepare for arrival even if the confirmation acknowledgement has not been received. But the unacknowledged communication remains a visible flag throughout subsequent stages. At no-show determination, the acknowledgement status is a critical data point: a guest who never acknowledged the confirmation may never have received it.

**Supersession tracking.** When a segment is superseded (re-entry creates a new segment), all communications from the prior segment are flagged as superseded. The system offers the user the option to send an invalidation or update notification to the guest or agent. If the user declines to send, a mandatory reason is recorded. Amended communications carry the AMENDED prefix in the subject line and reply to the original thread where possible.

**Communication threading.** All communications for the same entry should use the same email thread where possible — same subject line with appropriate prefix (QUOTATION, CONFIRMATION, AMENDED, CANCELLED), reply-to the original message-id. This keeps the client's inbox organised and provides a complete communication history. WhatsApp messages are threaded by the contact's phone number.

### M.9 Records Created or Affected
Communication record per message (outbound or inbound), acknowledgement tracking record, supersession flag records, thread reference records. Communication records are immutable — a sent message cannot be unsent in the system's records.

### M.10 Timers / Workers Involved
Acknowledgement window timer per outbound material communication. Non-acknowledgement escalation timer. Follow-up reminder timer for communications awaiting response (distinct from acknowledgement — a quotation awaiting acceptance is a business follow-up, not just an acknowledgement check).

### M.11 Evidence Required
Every material outbound communication has a tracked record with delivery status. Acknowledgement status is current for all tracked communications. Superseded communications are flagged.

### M.12 Closure Rule
An individual communication's loop closes on acknowledgement receipt or governed timeout. The communication thread for an entry closes when the entry reaches terminal state and all material communications have been acknowledged or timed out.

### M.13 Forbidden Acts
Sending material communications outside the system. Deleting communication records. Ignoring non-acknowledgement flags without recorded reason. Sending superseded documents (quotation from a prior segment) without explicit revalidation.

### M.14 Notes on Open Seams / Deferred Items
**T08 (Email Service Infrastructure) — LOCKED (MOM-007).** The email infrastructure architecture is defined: Amazon SES for outbound with domain authentication, IMAP polling for inbound (webhook seam designed), WhatsApp Business API through BSP for bidirectional WhatsApp, Android call log integration for phone tracking, full content storage, and attachment enforcement gate. The communication operational doctrine in this section remains authoritative — T08 defines how the infrastructure implements these requirements. A soft processing lock mechanism governs inventory concurrency when multiple channels process bookings simultaneously — see Section [NEW: Soft Processing Lock].

**T19 (AI Communication Agent) — LOCKED (MOM-007).** The AI agent reads inbound emails and WhatsApp messages, classifies intent, generates draft responses, and proposes system actions. It operates within the communication framework defined in this section — same tracking, same threading, same acknowledgement model. The AI agent adds an automated processing layer; it does not change the communication doctrine. All AI-generated communications require human review and approval at the default trust level (ALWAYS_REQUIRE_APPROVAL). Trust levels are configurable per action category in the Admin Console. Three guardrails are binding: never assume (ask under ambiguity), escalate when out of depth, and Tier 1 authority only. See Section [NEW: AI Communication Agent Operational Model].

**System-suggested communication language.** When the AI agent is active, it generates contextual language drafts from engagement data, guest profile, and communication history. When the AI agent is inactive or unavailable, the system falls back to template-based suggested language configurable through the Admin Console. Both modes require human review and confirmation before sending. The language is designed so that even an inexperienced staff member can communicate professionally — the system provides the words, the staff member confirms and sends.

---

## 59. Availability Configuration and Recall

### M.1 Purpose
Governs the persistence, recall, and revalidation of availability configurations — ensuring that previously explored options remain accessible for cross-stage and cross-segment recall without forcing full re-navigation.

### M.2 Why This Exists in the Canon
When a guest reviews Quotation Q2 and then says "actually I prefer Q1," the front desk must be able to recall Q1 without re-entering S1 from scratch. The system must check whether Q1 is still viable — inventory still available, rate plan still active, client tier unchanged — and surface any changes for FOM decision.

### M.3 Trigger Conditions
Guest or agent requests a previously explored option. Re-entry to an earlier stage where prior configurations exist. Cross-entry recall (a configuration explored for Entry 1 is relevant to Entry 2 under the same inquiry).

### M.4 Allowed Actors
Any operational staff may recall a configuration. FOM decides when recalled options have changed conditions (Option C — flag and decide, from MOM-005).

### M.5 Blocked Actors
No actor may select a recalled configuration without the system performing viability checks. Recall is not a blind restore — it is a recall-plus-revalidate operation.

### M.6 Policy Envelope
**Configuration validity policy** — governs how long a configuration remains recallable, what viability checks are mandatory on recall, and what constitutes a material change that requires FOM decision.

### M.7 Configuration Dependencies
Availability configuration staleness window, viability check rules (inventory state, rate plan status, client tier change detection, DEFICIENT flag status change), and recall scope (same entry only, or cross-entry within same inquiry).

### M.8 Stage Impact
Configurations are created during S1 and carried into S2. Recall may be invoked from S2 (switching between quotation bases), from S3 (reconsidering the commercial basis before hold placement), or during re-entry to any stage where a prior configuration is relevant. On recall, the viability check includes the current DEFICIENT flag status on rooms in the configuration — if a room was clean when the configuration was created but now carries a DEFICIENT flag, this is a material change surfaced for FOM decision.

### M.9 Records Created or Affected
Recall event record (who recalled, what was recalled, what viability checks ran, what changed, what FOM decided if applicable). The recalled configuration is not modified — a new configuration derived from the recalled one may be created if conditions changed.

### M.10 Timers / Workers Involved
Staleness timer on each configuration. Expired configurations remain recallable but require full revalidation.

### M.11 Evidence Required
Viability checks executed and results recorded. FOM decision recorded if conditions changed (including DEFICIENT flag changes). New configuration created if recalled option was modified.

### M.12 Closure Rule
Recall closes when the configuration is either selected as the active basis (proceeding through the workflow) or declined (the user chose a different option).

### M.13 Forbidden Acts
Selecting a recalled configuration without viability checks. Honouring an expired quotation's rate for a client whose tier has changed without FOM approval. Treating recall as a rollback — it is a new selection informed by historical data.

### M.14 Notes on Open Seams / Deferred Items
Per-stage option tables vs unified configuration table is a schema question deferred to DEV-SPEC-001.

---

## 60. Conference, Event, and Package-Linked Operations

### M.1 Purpose
Governs conference and event operations as first-class operational content within the S1–S9 lifecycle — covering space inventory, equipment allocation, F&B composition, work order coordination, and the distinct stage-by-stage behaviours that conferences and events produce.

### M.2 Why This Exists in the Canon
Conference was explicitly deferred to a future module in the original operational workflow. MOM-006 reversed that deferral. Conference is first-class. This section consolidates the conference-specific operational requirements that extend beyond what the individual stage charters cover.

### M.3 Trigger Conditions
Engagement use type is CONFERENCE, EVENT, or any combined engagement that includes a space booking.

### M.4 Allowed Actors
Reservations or front desk creates the engagement. Coordinator is the external operational contact. FOM conducts verification and approves conference-specific decisions. GM approves FOC and significant commercial adjustments.

### M.5 Blocked Actors
Coordinator cannot self-serve within the system. Conference-only attendees (non-accommodation) do not require individual entries or identity verification — they are anonymous cover counts.

### M.6 Policy Envelope
**Space allocation policy** — governs time-block booking, turnaround buffers, and consecutive event coordination. **Equipment allocation policy** — governs movable resource booking, shortage detection, and sourcing requirements. **Conference F&B policy** — governs inclusion taxonomy application, cover tracking, and entitlement enforcement. **Karaoke noise policy** — two modes based on hotel occupancy: other guests present = default cutoff (configurable, e.g., 10 PM); karaoke group are sole guests = FOM can apply extended cutoff with recorded reason.

### M.7 Configuration Dependencies
Space inventory registry with seating configurations and expansion configurations, equipment and movable resource registry with unit counts, F&B inclusion taxonomy (UNDP reference as seed), turnaround buffer durations per space per use type transition, karaoke cutoff times, and conference work order templates.

### M.8 Stage Impact
Conference-specific stage behaviour is documented in the stage charters' use-type variation sections. This cross-stage section covers the operational patterns that span multiple stages:

**Space claim lifecycle:** space is QUOTED at S1 search, may be SPECULATIVELY HELD at S2, COMMITTED HELD at S3, and CONFIRMED and locked at S4. Space claims follow the same Model 1 claim state logic as rooms but applied to time blocks rather than date ranges. The space physical state model (AVAILABLE → SETUP_IN_PROGRESS → EVENT_IN_PROGRESS → BREAKDOWN_IN_PROGRESS → UNDER_MAINTENANCE / BLOCKED) is actively managed during the event.

**Work order as the central coordination document.** The work order is created between S1 and S3, lives through S8, carries all F&B configurations, special requests, equipment requirements, setup instructions, and coordinator amendments. Every amendment is layered. The work order to-do list is seeded from special requests and pre-configurable templates. Each to-do item has an owner, a deadline, and Timer Engine monitoring.

**F&B cover tracking.** During the event (S7), F&B tracks covers by meal period against the work order allocation. Consumption exceeding the allocation is flagged for coordinator acknowledgement before additional charges are posted. The waiter captures the room number (for accommodation guests) or the event reference (for conference-only attendees) at seating. The system validates entitlement and logs the cover.

**Equipment return tracking.** After the event, if hotel equipment was allocated (movable resources), the Timer Engine monitors return deadlines. If external equipment was hired, the sourcing record tracks return.

### M.9 Records Created or Affected
Space allocation records, equipment allocation records, work order and to-do items, F&B consumption records, coordinator interaction records, setup and breakdown monitoring records.

### M.10 Timers / Workers Involved
Setup monitoring timer (SETUP_IN_PROGRESS duration), breakdown monitoring timer, equipment return deadline timer, work order to-do deadline timers, and turnaround buffer sufficiency alerts for consecutive events.

### M.11 Evidence Required
Space confirmed and locked. Equipment allocated or shortage flagged. Work order complete with all items assigned. F&B consumption tracked per meal period. Equipment returned or return overdue flagged.

### M.12 Closure Rule
Conference engagement closes through the standard S9 process. Space claims are released on event completion. Equipment return is tracked to completion. Work order is closed when all items are fulfilled or explicitly cancelled.

### M.13 Forbidden Acts
Booking a space without checking turnaround buffer against adjacent events. Allowing conference-only attendees to charge to accommodation folios (they are anonymous cover counts — individual purchases are walk-in transactions with immediate settlement). Skipping FOM verification at S4 for conference engagements.

### M.14 Notes on Open Seams / Deferred Items
Conference hall real names (C1–C4 are placeholders) pending from Legphel management. Seating capacity per configuration pending confirmation. These are admin console seed data items, not canon gaps.

---

## 61. Overbooking, Walk, and Partner Relocation

### M.1 Purpose
Governs overbooking as a formalised, policy-driven commercial capability with full traceability — covering both deliberate overbooking (commercial strategy) and unintentional overbooking (OTA sync gap), and defining the partner hotel relocation workflow for resolution.

### M.2 Why This Exists in the Canon
Overbooking is not an accident at Legphel — it is a deliberate commercial strategy used when stakes are high. The hotel also experiences unintentional overbooking from OTA bookings not reflected in the PMS. Both scenarios require governed detection, decision-making, and resolution. The system must formalise what was previously an informal practice.

### M.3 Trigger Conditions
**Deliberate overbooking:** FOM/GM decides to accept a booking when committed inventory already meets or exceeds physical inventory for the date range. **Unintentional overbooking:** discovered when an OTA booking is entered and creates an inventory conflict. **Detection:** the system checks inventory at every confirmation (S4) and at every OTA booking verification. The moment commitments exceed physical inventory, the OVERBOOKED claim state activates.

### M.4 Allowed Actors
Front desk records overbooking requests (for VIP or high-value clients calling when hotel is full — front desk records the requirement, does not commit). FOM assesses and recommends. GM approves overbooking and the associated mitigation plan. GM approves partner hotel relocation.

### M.5 Blocked Actors
Front desk cannot commit to overbooking. Front desk cannot promise a room when the hotel is full. Front desk records the requirement and escalates to FOM/GM for decision.

### M.6 Policy Envelope
**Overbooking policy** — governs when overbooking is even available as an option (high-value business, VIP customers, loyalty considerations). Defines maximum overbooking limits (configurable count or percentage). Defines approval authority by overbooking level. **Relocation policy** — governs partner hotel selection, rate differential responsibility (hotel almost always absorbs), guest communication, and structured handover requirements. **External handshake closure policy** — governs the evidence requirements that close the relocation loop: partner hotel receipt confirmation, guest acceptance confirmation, and rate differential settlement.

### M.7 Configuration Dependencies
Overbooking activation criteria, maximum overbooking limits per date range, approval authority per overbooking level, partner hotel registry (contacts, contracted rates, capacity, commercial terms), rate differential handling rules, guest handover template, and external handshake closure window configuration.

### M.8 Stage Impact
Overbooking detection fires at S4 (confirmation) when the confirmation would create an OVERBOOKED condition. It also fires at OTA booking verification when a newly entered OTA booking creates a conflict. The system presents the decision to FOM/GM: real bookings on one side, the overbooking request on the other, with full context on each entity — who they are, commercial value, history, decision trail. FOM/GM can approve the overbooking with a mitigation plan, initiate relocation of a lower-priority booking, or reject the request.

**Partner hotel relocation workflow:** When relocation is decided, the system records the relocation decision with GM authority and reason. The partner hotel receives a structured handover: guest requirements, agreed rate, service commitments, and reason for relocation. Rate differential (if partner hotel charges more) is tracked with clear attribution of who pays — almost always the hotel absorbs the cost. The guest receives a governed communication explaining the relocation with appropriate framing. The original entry transitions to a relocation state with full history preserved.

<!-- REV-B10-03 | 26 Mar 2026 | Source: Combined Review — GPT (overbooking relocation external handshake closure) | The original relocation workflow defined the decision and the handover outbound step. It did not define what evidence closes the relocation loop — who confirms the guest was received, what record proves the rate differential was resolved, and when the open loop closes. Without this, a relocated guest could theoretically remain as an open loop indefinitely. The following paragraph defines the closure criteria. -->

**External handshake closure.** The relocation creates two open loops that must both close before the relocation event is considered complete. The first loop is partner hotel receipt confirmation: the partner hotel must confirm that the guest has arrived and been accommodated. Until this confirmation is received, the relocation event remains open. FOM marks the loop closed when: a written confirmation from the partner hotel (email, WhatsApp, or phone call recorded as a communication event) confirms the guest's arrival and check-in. The second loop is rate differential settlement: if the partner hotel charges more than the original rate, the hotel's obligation to absorb the differential must be tracked. FOM records the differential amount, the expected settlement date, and the method (credit to the partner hotel's account, direct payment, or future booking offset per the partner relationship terms). Both loops must close within the configured external handshake closure window — managed by the Timer Engine. If either loop exceeds the window, FOM is escalated and GM is notified. A relocation event that remains with both loops open past the window is a financial and reputational control failure.

**Alert chain:** The moment overbooking is detected — specifically when both parties have confirmed — the system alerts from front desk to GM immediately. This is real-time escalation, not a next-morning report.

### M.9 Records Created or Affected
Overbooking detection record, overbooking decision record (approval or rejection with reason), mitigation plan record, relocation decision record, partner hotel handover record, rate differential record, guest communication record, entry status transition to relocation state, partner hotel receipt confirmation record, rate differential settlement record.

### M.10 Timers / Workers Involved
Overbooking resolution timer — once detected, the overbooking must be resolved within a configurable window. Partner hotel reconfirmation timer — if the guest is relocated, the partner hotel must confirm availability within a defined window. External handshake closure timer — both open loops (partner hotel receipt and rate differential settlement) are monitored by the Timer Engine.

### M.11 Evidence Required
Overbooking detected and recorded. GM decision recorded with mitigation plan. If relocation: partner hotel confirmed, guest notified, rate differential recorded, handover completed, partner hotel receipt confirmation received, rate differential settlement tracked.

### M.12 Closure Rule
Overbooking is closed when either the conflict is resolved (one booking cancelled, one relocated, or dates shifted to eliminate overlap) or the OVERBOOKED state is accepted with a recorded mitigation plan and all affected parties are notified. For relocation specifically: the relocation event closes only when both external handshake loops are closed — partner hotel receipt confirmation received AND rate differential settlement recorded. An open loop on either criterion keeps the relocation event active regardless of whether the guest has physically departed the partner hotel.

### M.13 Forbidden Acts
Front desk committing to a booking when inventory is full without FOM/GM authority. Dismissing an overbooking alert. Relocating a guest without GM approval. Sending a guest to a partner hotel without structured handover. Closing a relocation event without confirming that the guest was received by the partner hotel. Treating the rate differential as absorbed without recording the settlement method and expected date.

### M.14 Notes on Open Seams / Deferred Items
None. Overbooking and relocation are fully deliberated across MOM-004 and MOM-005.

---

## 63. Walk-In Handling

### M.1 Purpose
Governs the compressed lifecycle for guests who arrive without prior reservation — ensuring that walk-in intake follows the same governance as any other booking, compressed for immediacy but not stripped of controls.

### M.2 Why This Exists in the Canon
Walk-in guests are a regular occurrence at Legphel. They arrive at the front desk with no inquiry, no entry, no quotation. The system must handle this as a governed compressed lifecycle, not as an informal shortcut that bypasses the stage model.

### M.3 Trigger Conditions
A guest presents at the front desk with no active entry in the system.

### M.4 Allowed Actors
Front desk processes standard walk-ins. FOM required for rate override, credit extension, or room upgrade. GM required for walk-in during overbooking condition.

### M.5 Blocked Actors
No walk-in may be checked in without identity verification. No walk-in may receive credit extension without FOM/GM approval.

### M.6 Policy Envelope
**Walk-in rate policy** — governs rate selection for walk-ins. Default: walk-in rate plan from the rate plan registry, or rack rate. Agent and promotional rates are not applicable unless FOM override. **Walk-in payment policy** — governs payment requirements. Default: full payment or configurable deposit at check-in. **Walk-in identity policy** — governs identity verification requirements (mandatory, no deferred option for walk-ins).

### M.7 Configuration Dependencies
Walk-in rate plan configuration, walk-in payment threshold, walk-in identity requirements, and hours-only stay prohibition configuration (the flowchart notes: "not to entertain if the duration of stay is for a few hours" — this is a configurable minimum stay duration).

### M.8 Stage Impact
The walk-in creates a compressed S1→S3→S4→S6 flow. S1 creates the inquiry and entry with source WALK_IN, runs an availability search in real time. S2 is skipped if the guest accepts the walk-in rate (auto-fulfilled). S3 compresses: hold and payment occur simultaneously at the front desk. S4 compresses: confirmation is immediate. S5 is auto-fulfilled because the guest is physically present. S6 proceeds normally: identity verification, room assignment (including DEFICIENT flag check per the standard S6 doctrine), folio conversion, key issuance, H2/H3 creation. The state machine sees valid transitions for every stage. The audit trail records every stage passage even when compressed. After S6, the walk-in entry is a normal entry — it participates in S7 through S9 identically to any reservation-originated entry.

### M.9 Records Created or Affected
Inquiry, entry (source: WALK_IN), availability configuration, reservation (compressed creation), folio (provisional created and immediately converted to live), payment record, identity verification record, all standard S6 records.

### M.10 Timers / Workers Involved
No special timers beyond the standard stage timers. Walk-in processing has inherent urgency (the guest is physically waiting) which is reflected in the compressed mode's dwell thresholds.

### M.11 Evidence Required
Same as standard S6 exit evidence. The compression does not reduce the evidence requirements — it compresses the timeline.

### M.12 Closure Rule
Walk-in intake closes when S6 is complete. The entry then follows the standard S7–S9 lifecycle.

### M.13 Forbidden Acts
Checking in a walk-in without identity verification. Extending credit to an unknown walk-in without FOM/GM approval. Accepting a walk-in for a few-hours stay if the minimum stay policy prohibits it. Creating a walk-in entry without full audit trail.

### M.14 Notes on Open Seams / Deferred Items
Day-use rooms (a few-hours stay product) are a future capability. The current configuration prohibits hours-only walk-ins. When day-use is enabled, the walk-in mechanism will support it through configuration, not code change.

---

## 64. OTA Interim Sync

### M.1 Purpose
Governs the interim mechanism for synchronising OTA bookings with the PMS through email parsing — ensuring that OTA bookings are captured, verified, and integrated into the inventory and lifecycle model despite the absence of direct API integration.

### M.2 Why This Exists in the Canon
Legphel has no direct OTA integration. OTA bookings (Booking.com, Agoda, MakeMyTrip, Expedia) arrive as confirmation emails. Without a governed sync mechanism, bookings are missed and overbooking is discovered at check-in — the worst possible moment.

### M.3 Trigger Conditions
An email arrives in the dedicated OTA inbox from a known OTA domain.

### M.4 Allowed Actors
Front desk verifies and confirms OTA booking records. The email parsing system creates provisional records. FOM resolves overbooking conflicts detected during OTA verification.

### M.5 Blocked Actors
The parsing system does not auto-confirm bookings. Human verification is mandatory. No OTA booking enters the live inventory without front desk verification.

### M.6 Policy Envelope
**OTA verification policy** — governs the mandatory verification steps before a parsed booking becomes a confirmed record. **OTA cancellation policy** — governs handling of OTA cancellation emails. No automation in the cancellation path — system matches, surfaces, and presents options; human decides. **OTA conflict routing policy** — governs how inventory conflicts detected during OTA verification are classified and routed: OTA_CONFLICT trigger type (not DELIBERATE) routes to the expanded overbooking framework with the additional external guest communication obligation.

### M.7 Configuration Dependencies
Dedicated OTA inbox address, known OTA sender domains, parsing templates per OTA, provisional record schema, OTA_SOURCE flag configuration, and overbooking detection integration.

### M.8 Stage Impact
On email arrival, the system pre-populates fields if parsing succeeds. Front desk is notified immediately. Front desk reads the original email, verifies all fields, and confirms. On confirmation, the booking enters the lifecycle as a standard entry at S4 (confirmed) with source: OTA and the OTA_SOURCE flag set.

<!-- REV-B10-04 | 26 Mar 2026 | Source: Block 3 REV-B3-02 + Block 6 REV-B6-04 downstream consequence | When OTA booking verification creates an inventory conflict, the overbooking trigger type must be OTA_CONFLICT, not DELIBERATE. The original Section 64 referenced overbooking detection during verification but did not specify the trigger type routing. With OTA_CONFLICT established as a distinct path in Block 3 and formalised at S4 in Block 6, Section 64 must explicitly route OTA conflicts through the OTA_CONFLICT path. -->

Overbooking detection runs at the front desk verification click. If verification creates an inventory conflict, the overbooking detection engine reads the OTA_SOURCE flag and classifies the trigger type as OTA_CONFLICT — not DELIBERATE. The OTA_CONFLICT path carries the additional open loop: the OTA platform (or the guest via OTA channel) must be notified if the conflict results in the OTA-side booking being displaced. This notification obligation is tracked as a separate open loop in the overbooking resolution record, distinct from the standard overbooking mitigation plan. FOM manually closes the OTA notification loop when confirmation of OTA-side resolution is received. The classification as OTA_CONFLICT is immutable once set — it cannot be reclassified as DELIBERATE.

On OTA cancellation email: system matches the cancellation reference to existing bookings, surfaces the applicable cancellation policy and financial implications, and presents resolution options. FOM or GM approval for policy waivers. Every decision is permanently recorded.

### M.9 Records Created or Affected
OTA email receipt record, parsed provisional booking record (with OTA_SOURCE flag set), verification event record, confirmed entry (if verified) with OTA_SOURCE flag, overbooking detection record with OTA_CONFLICT trigger type (if conflict), OTA notification open loop record (if conflict), cancellation processing record (if cancellation email).

### M.10 Timers / Workers Involved
OTA email processing timer — emails should be processed within a configurable window. Unprocessed emails are visible as pending items. Overbooking alert fires immediately on conflict detection during verification.

### M.11 Evidence Required
Email received and recorded. Parsing result recorded. Front desk verification complete. OTA_SOURCE flag set. Entry created or conflict escalated with correct OTA_CONFLICT trigger type.

### M.12 Closure Rule
OTA sync for a specific email closes when the booking is verified and entered, or when a parse failure is recorded and manually resolved, or when a cancellation is processed.

### M.13 Forbidden Acts
Auto-confirming parsed bookings without human verification. Processing OTA cancellations automatically. Ignoring parse failures (they sit as visible pending items). Classifying an OTA-conflict overbooking as DELIBERATE. Setting the trigger type as DELIBERATE when the OTA_SOURCE flag is present.

### M.14 Notes on Open Seams / Deferred Items
**T08 (Email Infrastructure) — LOCKED (MOM-007).** The email parsing architecture is defined: IMAP polling monitors a dedicated OTA inbox at configurable intervals (default 5 minutes). The OTA source registry in the Admin Console is sample-based — GM pastes example emails from each OTA and the system uses these as pattern templates. AI agent (T19) performs extraction with confidence scoring; manual extraction is the fallback when AI is unavailable or confidence is low. Parsing success rate is tracked per OTA with automatic degradation alerts when accuracy drops below threshold. The operational classification logic and OTA_CONFLICT routing defined in this section are permanent architecture — T08 automates the ingestion, it does not change the classification. When direct OTA API integration arrives, the IMAP parsing layer is replaced but the OTA_SOURCE flag, booking record structure, overbooking detection, and OTA_CONFLICT trigger type remain.

---

## 65. Work Order, Allocation, and Consumption Logic

### M.1 Purpose
Governs the work order as a living control document — tracking service allocations, consumption, and amendments from initiation through closure.

### M.2 Why This Exists in the Canon
Work orders exist for engagements with service obligations beyond basic accommodation: conferences, group packages, catering, and any engagement where the hotel commits to deliver specific services at specific times. The work order is the operational control document that coordinates housekeeping, F&B, equipment, and setup activities.

### M.3 Trigger Conditions
Work order is initiated when an engagement includes package services, conference requirements, catering obligations, or structured special requests that require cross-department coordination.

### M.4 Allowed Actors
Reservations or front desk creates and manages work orders. The coordinator may request amendments (mediated by hotel staff). FOM reviews and approves. Housekeeping, F&B, and other departments receive to-do items.

### M.5 Blocked Actors
Coordinator amendments are not self-served. They are recorded by hotel staff after coordinator instruction.

### M.6 Policy Envelope
**Work order amendment policy** — coordinator has no value-based amendment limit; all amendments layered and audited. **Consumption tracking policy** — governs how over-allocation is handled: coordinator acknowledgement required before additional charges posted.

### M.7 Configuration Dependencies
Work order templates per engagement type, to-do item category registry, assignment rules, and over-allocation threshold.

### M.8 Stage Impact
Work order may be initiated between S1 and S3. It lives through S8. Every amendment is layered. To-do items are assigned to roles, individuals, or multiple co-assignees. Timer Engine monitors all deadlines. Consumption is tracked against allocations during S7. Closure occurs at S8 when all items are fulfilled or cancelled.

### M.9 Records Created or Affected
Work order record, to-do items, amendment records, consumption records, over-allocation acknowledgement records, completion evidence records.

### M.10 Timers / Workers Involved
To-do deadline timers per item. Approaching deadlines prompt assigned staff. Breached deadlines alert FOM. A lightweight workload indicator (read-only for FOM) shows active task count and overdue item count per staff member.

### M.11 Evidence Required
All to-do items completed or cancelled with reason. Consumption tracked against allocation. Over-allocation acknowledged.

### M.12 Closure Rule
Work order closes when all items are fulfilled or cancelled and consumption reconciliation is complete.

### M.13 Forbidden Acts
Editing a work order in-place — all changes are layered amendments. Deleting to-do items — they are cancelled with reason, not deleted. Posting consumption charges without operational anchor.

<!-- REV-B10-05 | 26 Mar 2026 | Source: Combined Review — Tier 2 (work order seed data delivery obligation) | The conference and F&B variation list for corporate groups was noted as "pending from Dhendup" in the original M.14 and in Section 56 M.14. This is framed as a data-pending item, but it is actually a tracked delivery obligation that blocks finalisation of conference work order templates. Framing it as open seam understates its urgency. The following updates M.14 to treat it as a delivery dependency with an explicit consequence. -->

### M.14 Notes on Open Seams / Deferred Items
**Conference and F&B variation list — tracked delivery obligation.** The conference and F&B variation list for corporate groups (referenced in MOM-004 as pending from Dhendup Cheten) is a tracked delivery dependency for work order template seed data. Until this list is delivered, the Admin Console cannot be seeded with the correct work order templates for corporate conference engagements. This blocks the following downstream activities: finalisation of conference work order templates in Admin Console setup, S5 work order to-do list pre-population for conference engagements, and the conference-specific S3 work order initiation capability. This is not an open seam — it is a known pending input with a known owner. The delivery obligation must be tracked outside the canon and confirmed before Admin Console setup for conference operations proceeds.

---

## 66. Basis Systems — Housekeeping

### M.1 Purpose
Defines how housekeeping participates in the PMS lifecycle — what it inherits, what it must confirm, and how it blocks or enables operational flow. This is a participation charter, not a full housekeeping module specification.

### M.2 Why This Exists in the Canon
The PMS depends on housekeeping for room readiness (S5/S6), stayover service (S7), room turnover (S8), and room inspection (S8). Without a defined participation charter, the boundary between PMS and housekeeping is unclear and integration becomes informal.

<!-- REV-B10-06 | 26 Mar 2026 | Source: Block 8 REV-B8-03 downstream consequence | The DEFICIENT condition resolution obligation established in S7 (REV-B8-03) makes housekeeping responsible for resolving DEFICIENT conditions within a configured deadline during the stay. This responsibility must be explicitly stated in the housekeeping participation charter so that the obligation is clear to the housekeeping function and visible at the charter level. -->

### M.3–M.8 Consolidated
Housekeeping participates through H2 handoff (received at S6), room physical state management (updating DEPARTED DIRTY → AVAILABLE CLEAN), stayover schedule execution (daily for standard, configurable for apartment), room inspection at checkout, bed configuration changes, and VIP room preparation per profiling system requirements.

**DEFICIENT condition resolution.** During active stays (S7), housekeeping is the responsible actor for resolving DEFICIENT conditions on occupied rooms. Each DEFICIENT condition identified at S5 assignment or S6 check-in carries a resolution deadline managed by the Timer Engine. Housekeeping must resolve the condition (repair the broken amenity, address the cosmetic issue, restore the sub-standard fixture) within the configured deadline and post a resolution event with the condition description, resolving action, responsible actor, and timestamp. If the deadline is approaching, housekeeping receives a Timer Engine prompt. If the deadline is breached, FOM is alerted. If the condition remains UNRESOLVED at checkout, it is surfaced in the S8 room inspection record — the inspector must assess whether the unresolved condition warrants a charge reduction or service recovery compensation, distinguishing pre-existing hotel-side conditions from guest-caused damage.

Housekeeping SLA timers govern turnover speed. Housekeeping cannot block check-in unless the room is genuinely not ready — in which case the system surfaces alternatives. Housekeeping reports damages through the room inspection mechanism. Full housekeeping task management, scheduling algorithms, and inspection checklists are future module scope.

### M.9–M.14 Consolidated
Records: room physical state transitions, inspection records, damage reports, H2 acceptance and fulfilment, DEFICIENT condition resolution events, UNRESOLVED DEFICIENT status records at checkout. Timers: housekeeping SLA, stayover schedule, VIP preparation deadlines, DEFICIENT condition resolution deadlines. Evidence: room state updated, inspection complete (with DEFICIENT flag status), H2 fulfilled, DEFICIENT conditions resolved or UNRESOLVED status documented. Closure: H2 closed when stay ends. Forbidden: updating room state without actual housekeeping action, ignoring SLA breaches, failing to post DEFICIENT condition resolution events when conditions are resolved, returning a room to AVAILABLE CLEAN while a DEFICIENT condition remains unresolved (the DEFICIENT flag must be cleared before the room can reach AVAILABLE INSPECTED state).

---

## 67. Basis Systems — F&B

### M.1 Purpose
Defines how F&B participates in the PMS lifecycle — what it inherits, what it must confirm, and how it blocks or enables operational flow. This is a participation charter, not a full F&B module specification.

### M.2 Why This Exists in the Canon
The PMS depends on F&B for meal plan execution (per H3 handoff), cover tracking against entitlements, dietary requirement compliance, and charge posting for non-included items. Without a defined participation charter, F&B becomes a black box that the PMS cannot govern.

### M.3–M.8 Consolidated
F&B participates through H3 handoff (received at S6), cover tracking by meal period (room number capture at seating, entitlement validation), charge posting for non-included items at point of service, late arrival meal coordination (pre-cooked food menu, kitchen closing time management), conference F&B delivery per work order, and preference hierarchy execution (individual > agent default > hotel default). F&B cannot block check-in but can block checkout if consumption records are incomplete (H4 reporting). Full kitchen management, menu configuration, POS integration, and inventory management are future module scope.

### M.9–M.14 Consolidated
Records: consumption records, cover tracking records, charge posting records, H3 acceptance and fulfilment, dietary compliance records. Timers: kitchen closing time alerts, meal service deadlines per work order. Evidence: consumption tracked, H3 fulfilled, H4 reported. Closure: H3 closed when stay ends. Forbidden: posting F&B charges without consumption record (operational anchor requirement).

---

## 68. Space, Asset, and Equipment Basis

### M.1 Purpose
Governs the operational non-room inventory that the PMS must track for conference and event operations — space allocation, asset availability, equipment management, and external sourcing.

### M.2 Why This Exists in the Canon
Conference operations require more than rooms. They require halls, equipment, furniture, and sometimes externally hired resources. The PMS must track what is available, what is allocated, what is in shortage, and what has been sourced externally.

### M.3–M.8 Consolidated
**Space inventory:** all bookable/allocatable physical spaces configured in admin console. Time-block allocation. Seating configurations with capacity per configuration. Expansion configurations combining adjacent spaces. Space physical state model with Timer Engine monitoring setup and breakdown.

**Asset registry:** owned items (tables, chairs, linen, AV equipment) with total count per category. Allocation against confirmed bookings with shortage detection. When shortage is detected, FOM is alerted before confirmation proceeds.

**Equipment:** permanent fixtures per space (PA system, projector, fixed screen, AC) confirmed on booking. Movable resources (sound mixer, etc.) with unit count and availability check across overlapping time blocks. Transit and setup buffer time per resource.

**External sourcing:** decorator hire, furniture hire, utensil hire recorded with cost, expected delivery, and return deadline. Timer Engine monitors return deadlines.

### M.9–M.14 Consolidated
Records: space allocation, equipment allocation, asset allocation, sourcing records, shortage detection records. Timers: setup monitoring, breakdown monitoring, return deadlines. Evidence: all allocated, shortages resolved or flagged, returns tracked. Closure: allocations released on event completion, returns confirmed. Forbidden: booking equipment without availability check, ignoring shortage detection.

**Out of scope:** asset condition tracking, location within hotel, depreciation, vendor management, full procurement workflows. Multi-entity shared return tracking (Legphel, Legphel Eats, Fuzzy Automation) is a separate future micro-tool.

---

## 69. Emergency, Security, and Critical Incident Handling

### M.1 Purpose
Governs the system's role in emergency and security incidents during a guest's stay — ensuring that incidents are recorded, escalated, and resolved with appropriate authority while protecting guest privacy and hotel reputation.

### M.2 Why This Exists in the Canon
Medical emergencies, theft, unauthorized room access, deaths, and other critical incidents occur in hotel operations. The system must support recording these events, managing the operational response, and preserving evidence — without becoming a crisis management tool (that is a human leadership function).

### M.3 Trigger Conditions
Medical emergency (minor or major), security incident (theft, unauthorized access, missing luggage), guest death, fire or natural disaster affecting operations, and any incident requiring police involvement or management escalation.

### M.4 Allowed Actors
Any staff member may report an incident. FOM manages the operational response. GM is required for police involvement, legal matters, and incidents affecting hotel reputation. The system records; humans lead.

### M.5 Blocked Actors
Front desk staff may not handle major incidents without FOM/GM involvement. No staff member may disclose incident details to other guests or external parties without GM authorisation.

### M.6 Policy Envelope
**Incident classification policy** — governs severity levels and escalation paths. **Privacy and disclosure policy** — governs what information about an incident may be shared, with whom, and under what authority. **Room securing policy** — governs when and how a room is secured and removed from availability after a critical incident (e.g., death: restrict access, awaiting authorities, cleansing ritual before return to service).

### M.7 Configuration Dependencies
Incident category registry, severity levels, escalation paths per severity, room securing rules, and disclosure authority rules.

### M.8 Stage Impact
Incidents occur during S7 (stay) but may also affect S8 (if the incident delays checkout) and S9 (if the incident produces post-stay legal or financial consequences). An incident record attaches to the entry. If the incident results in room unavailability (room secured after death, room under investigation after theft), the room physical state transitions to BLOCKED with the incident as the reason, and the maintenance conflict detection mechanism fires for any future bookings assigned to that room.

**Medical emergencies:** system records the event, tracks hotel response (first aid provided, ambulance called, hospital referral), and captures follow-up. Minor incidents (headache, small cuts) are recorded as service events. Major incidents trigger GM notification and may require legal documentation.

**Security incidents:** system records the event with evidence references (CCTV timestamps, staff statements). Theft requires GM consultation before police reporting. Missing luggage follows a documented investigation process. The system tracks the investigation status and resolution.

**Guest death:** the most sensitive incident. System records minimally — the event, GM notification, room securing, and subsequent actions. Guest privacy and dignity are paramount. The room transitions to BLOCKED with mandatory cleansing ritual completed before return to service. Non-disclosure is default; any disclosure requires GM authorization.

**Lost and found:** system records found items with description, location found, guest association (if determinable), and return status. If the guest has already departed, the contact system attempts to reach them. Items unclaimed after a configurable period follow the lost property disposal policy.

### M.9 Records Created or Affected
Incident record (type, severity, location, involved parties, actions taken, resolution), room state transition (if applicable), evidence reference records, follow-up task records, lost and found records.

### M.10 Timers / Workers Involved
Incident escalation timer (FOM/GM notification within configured window). Follow-up timer for unresolved incidents. Lost and found retention timer.

### M.11 Evidence Required
Incident recorded with type and severity. Appropriate authority notified. Response actions documented. Resolution or ongoing status documented.

### M.12 Closure Rule
Incident closes when the situation is resolved, all response actions are complete, and no further follow-up is required. Incidents with ongoing legal implications remain in a governed open state with periodic review.

### M.13 Forbidden Acts
Disclosing incident details without GM authorization. Returning a room to service after a death without completing the required cleansing procedure. Deleting or modifying incident records. Handling a major incident without FOM/GM involvement.

### M.14 Notes on Open Seams / Deferred Items
Full crisis management procedures, evacuation protocols, and business continuity planning are outside PMS scope. The PMS records, tracks, and supports — it does not replace human crisis leadership.

---

## NEW Section 70A — Soft Processing Lock

### M.1 Purpose
Governs inventory concurrency when multiple intake channels (email AI agent, WhatsApp AI agent, front desk, phone) process bookings that reference the same inventory simultaneously.

### M.2 Why This Exists in the Canon
Without a concurrency mechanism, two channels can independently promise the same room to two different guests. The AI agent drafts a confirmation for a Deluxe room while the front desk books the same room for a walk-in. When FOM approves the AI draft, the room is already gone. This is a predictable race condition that the system must govern.

### M.3 Trigger Conditions
A soft processing lock is placed whenever any channel processor — AI agent, front desk operator, or any other intake mechanism — identifies a specific inventory configuration (room, hall, apartment unit, date range) that it intends to reference in a response or booking action.

### M.4 Allowed Actors
Any system actor or human actor processing a booking request. The AI Communication Agent places locks automatically when drafting responses. Front desk staff trigger locks implicitly when they begin a booking workflow that selects specific inventory.

### M.5 Blocked Actors
No actor is blocked by a processing lock. The lock is an awareness mechanism, not a blocking mechanism. A second actor targeting the same inventory sees a notification but may proceed.

### M.6 Policy Envelope
**Processing lock TTL policy** — governs the duration of processing locks. Default 15 minutes. Configurable per channel and per engagement type. **Priority queue policy** — first lock has priority; subsequent locks are informed.

### M.7 Configuration Dependencies
Lock TTL per channel (email AI, WhatsApp AI, front desk, phone), priority queue display configuration, revalidation check parameters.

### M.8 Stage Impact
Processing locks operate across all stages where inventory selection occurs. Primarily S1 (availability configuration), S2 (quotation referencing inventory), S3 (hold placement), and any amendment that involves room or space changes. The lock is transient — it exists only during active processing and expires silently if abandoned.

### M.9 Records Created or Affected
Processing lock record (transient — created on lock, deleted on expiry or release). Revalidation delta record (attached to the draft communication record showing what changed during processing). No permanent inventory state change — the lock does not alter the claim state model.

### M.10 Timers / Workers Involved
Timer Engine manages lock TTL. Expired locks are automatically released and logged.

### M.11 Evidence Required
When a draft is approved after revalidation: the revalidation result is recorded (what was checked, what changed, what the approver decided). When a lock expires without action: the expiry is logged with the processing context.

### M.12 Closure Rule
A processing lock closes in one of three ways: the booking action is completed (lock converts to an inventory claim state per the claim model), the draft is rejected (lock released immediately), or the lock TTL expires (lock released automatically with log entry).

### M.13 Forbidden Acts
Treating a processing lock as a commercial hold. Using processing locks to reserve inventory for extended periods. Allowing a processing lock to block another actor's booking workflow (the lock informs, it does not block).

### M.14 Notes on Open Seams / Deferred Items
The priority queue is implicit in v2.2 — first lock has priority by timestamp. A more sophisticated priority mechanism (based on commercial value of the competing bookings) is a future enhancement.

---

## NEW Section 70B — AI Communication Agent Operational Model

### M.1 Purpose
Governs how the AI Communication Agent interacts with staff, guests, and the PMS operational workflow — defining its authority, its boundaries, and the human oversight model.

### M.2 Why This Exists in the Canon
The AI agent is not a tool that staff use. It is a system actor that processes inbound communications, drafts responses, proposes system actions, and drives engagement progression through conversation. Its operational model must be explicitly governed because an ungoverned AI agent violates P1 (no bypass, only escalation), P3 (system-enforced over trust-based), and P6 (ownership and attribution).

### M.3 Trigger Conditions
The AI agent activates when: an inbound email is received, an inbound WhatsApp message is received, a scheduled follow-up is due for a tracked communication, or the night audit cycle triggers the AI audit layer.

### M.4 Allowed Actors
The AI agent (system actor with defined identity in the actor registry). Staff who review, approve, edit, or reject AI outputs. FOM/GM who receive escalations from the AI agent.

### M.5 Blocked Actors
The AI agent may not approve its own drafts. The AI agent may not send any communication without a human approval event recorded. The AI agent may not bypass the state machine. The AI agent may not execute governed actions (stage transitions, rate overrides, payment waivers, FOC grants) — it may only propose them for human approval.

### M.6 Policy Envelope
**AI trust level policy** — per-action-category trust levels (ALWAYS_REQUIRE_APPROVAL default, AUTO_APPROVE_HIGH_CONFIDENCE, FULL_AUTO). Managed in Admin Console by GM. **AI escalation policy** — confidence thresholds below which the AI does not draft but escalates directly to human. **AI authority boundary policy** — the AI operates at Tier 1 (front desk) authority. Commercial decisions requiring Tier 2 (FOM) or Tier 3 (GM) are routed to humans.

### M.7 Configuration Dependencies
LLM API connection configuration, trust level per action category, confidence threshold per intent category, escalation routing per intent category, per-channel trust overrides, correction log maximum size, pattern rule registry, AI actor identity in actor registry.

### M.8 Stage Impact
The AI agent operates across all stages. At each stage, the ContextAssemblyService includes the stage's data requirements in the AI's context. The AI asks for missing information, proposes appropriate actions, and drafts stage-appropriate responses. Stage-specific behaviour: at S1 the AI captures requirements and explores options; at S2 it presents quotations and negotiates within configured parameters; at S3 it tracks payment confirmations; at S4 it generates confirmations; at S5-S6 it handles pre-arrival coordination; at S7 it processes mid-stay requests; at S8 it handles checkout queries; at S9 it manages post-stay communication. The AI never advances a stage without human approval of the proposed transition.

### M.9 Records Created or Affected
AI draft record (stored regardless of approval outcome), human decision record (approve/edit/reject with actor identity and timestamp), proposed system action record (what the AI proposed, whether it was approved, what was modified), correction record (when human corrects AI classification or modifies draft), AI audit supplement record (daily, attached to night audit record).

### M.10 Timers / Workers Involved
Draft review TTL — if a draft awaits human review for longer than the configured window, FOM is notified. Revalidation trigger — at moment of human review, inventory and profile revalidation fires. Correction log aggregation — periodic analysis of correction rates per intent category for threshold tuning.

### M.11 Evidence Required
Every AI-processed message has: inbound message stored, AI classification recorded, AI draft stored (if generated), human decision recorded, final sent message stored (if approved). The complete chain from inbound to outbound is reconstructable.

### M.12 Closure Rule
An AI processing cycle closes when: the draft is approved and sent, or the draft is rejected and the human handles it manually, or the message is escalated to human and the human responds. Every cycle reaches a terminal state — no message sits in indefinite processing.

### M.13 Forbidden Acts
AI sending communication without human approval event. AI executing governed actions without human approval. AI operating above Tier 1 authority. AI assuming missing information instead of asking. AI generating responses for unclassifiable messages instead of escalating. Allowing AI drafts to sit in review indefinitely without escalation.

### M.14 Notes on Open Seams / Deferred Items
Language capability for Dzongkha and Nepali is lower than English and Hindi. The system flags low-confidence language detection for human review. As LLM capabilities for these languages improve, confidence thresholds will adjust. The progressive trust model means auto-approval of low-risk actions may be enabled over time as AI accuracy is validated through the correction log metrics.

---

## NEW Section 70C — Voice Note Handling

### M.1 Purpose
Governs the handling of inbound voice notes (audio messages) received through WhatsApp or any other channel where the system cannot automatically extract content.

### M.2 Why This Exists in the Canon
Guests and agents in Bhutan send voice notes in Dzongkha, Sharchop, Nepali, Hindi, and English. The AI agent cannot reliably transcribe or understand local languages. Voice notes must not be silently ignored — they may contain booking confirmations, amendment requests, complaints, or commitments that the hotel must act on.

### M.3 Trigger Conditions
An inbound WhatsApp message (or any other channel message) is received with message_type = VOICE_NOTE.

### M.4 Allowed Actors
The assigned staff member for the linked engagement. Any front desk staff if the engagement is unassigned. FOM for escalation.

### M.5 Blocked Actors
The AI agent may not classify intent, generate draft responses, or propose system actions based on voice note content. Voice notes are human-only processing.

### M.6 Policy Envelope
**Voice note review SLA policy** — configurable window within which a voice note must be listened to and logged. Default: 30 minutes during operating hours.

### M.7 Configuration Dependencies
Voice note review SLA per channel, escalation routing for overdue voice notes.

### M.8 Stage Impact
Voice notes may arrive at any stage. The handling is the same regardless of stage: flag, listen, log, act. If the voice note is a reply to an outbound communication that was awaiting acknowledgement, the acknowledgement loop remains open until the staff member confirms what the voice note said.

### M.9 Records Created or Affected
Inbound communication record (channel = WHATSAPP, message_type = VOICE_NOTE, duration, audio file as attachment, status = VOICE_NOTE_UNPROCESSED). Staff listening summary record (structured note: caller intent, commitments mentioned, dates/numbers, language used, staff identity, timestamp). Status transition: VOICE_NOTE_UNPROCESSED → REVIEWED.

### M.10 Timers / Workers Involved
Voice note review SLA timer — registered with Timer Engine at message receipt. Escalation to FOM if review SLA is breached.

### M.11 Evidence Required
Voice note audio file stored. Staff summary logged with structured fields. Status transitioned to REVIEWED.

### M.12 Closure Rule
The voice note handling loop closes when: the staff member has listened, logged the summary, and taken any required action (creating a booking record, updating an engagement, responding to the sender). If the voice note requires no action, the summary records "no action required" with reason.

### M.13 Forbidden Acts
Marking a voice note as reviewed without listening to it. Closing the voice note loop without a structured summary. AI agent generating responses based on unreviewed voice note content.

### M.14 Notes on Open Seams / Deferred Items
When speech-to-text capabilities for Dzongkha and Nepali become reliable, the AI agent may be extended to transcribe voice notes and pre-populate the summary for human confirmation. This is a future enhancement — the human listening and logging requirement remains the baseline.

---

*End of Block 10 — Part 8 second half (Sections 56–61, 63–69)*

---

**Block 10 Document Control**

| Field | Detail |
|---|---|
| Block | 10 of 12 |
| Scope | Part 8 — Cross-Stage Operational Mechanisms second half: Group Booking (56), Room Moves (57), Communication (58), Availability Recall (59), Conference/Event (60), Overbooking/Relocation (61), Walk-In (63), OTA Sync (64), Work Order (65), Housekeeping Basis (66), F&B Basis (67), Space/Asset/Equipment (68), Emergency/Security (69) |
| Version | 2.2 |
| Status | Revised |
| Previous Version | 2.1 — 26 March 2026 |
| This Revision | 2.2 — 26 March 2026 |
| Changes in This Revision | Section 56 M.8, M.12, M.13 (commission references made conditional on agent profile configuration); Section 58 M.14 (T08/T19 locked with architectural detail and soft processing lock reference); Section 64 M.14 (T08 locked with IMAP polling and AI extraction detail); NEW Sections 70A/70B/70C (Soft Processing Lock, AI Agent Operational Model, Voice Note Handling) |
| Next Block | Block 11 — Part 9 (Matrices, Maps, Catalogues) + Parts 10–11 (DEV-SPEC Seams, Governance) + Appendices |
