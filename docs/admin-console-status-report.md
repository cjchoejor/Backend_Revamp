# Admin Console Status Report (ACIG v1.1 alignment)

Generated: 2026-05-28  
Repo: `Backend_ReVamped`

## Executive summary

The Admin Console is **partially implemented** across backend services, API routes, and Next.js admin pages.

- **Working today**: core Identity, Inventory, Workflow (modes + policy registry CRUD), Templates (deactivate), Financial/Operational key editors, VIP routing, readiness checks, and a new **Timers & workers** surface with structured (non-JSON) forms for many timer-driven settings.
- **Still missing vs ACIG**: several domain services (Rate plans as real registries, Seasons, Packages, CancellationPolicy service, Communication channel config, OTA config service, AI agent config service, Post-stay governance, etc.), plus **typed validation/ownership enforcement** for generic configuration keys and **RequiredControlCheck** enforcement in multiple places.
- **Key clarification**: there are **two different “policy” concepts**:
  - **Runtime “policy modules”**: TypeScript guard rules under `back_end/src/policies/**` (compiled, developer-owned).
  - **Policy Registry**: versioned DB rows in `policy_registry` (admin-owned). The UI writes these, but the runtime is **not yet wired** to interpret them as replacements for the TypeScript guards.

---

## What is done (implemented)

### Backend (Admin services)

Admin service implementations exist under `back_end/src/services/admin/`:

- **Identity**
  - `hotel-profile-admin-service.ts`: get/update hotel profile.
  - `department-admin-service.ts`: list/create/update (activate/deactivate).
  - `role-admin-service.ts`: list/create/update, permissions mapping, role session config propagation, and **delete** (guarded).
  - `staff-admin-service.ts`: list/create, deactivate, reset PIN.

- **Inventory**
  - `inventory-admin-service.ts`: room types CRUD (including guarded **delete**), rooms list/create/update + deactivate + guarded delete, spaces list/create/update + guarded delete, deficient categories config read/write.

- **Workflow**
  - `workflow-admin-service.ts`: modes list/save/activate/deactivate; policy registry list/save/deactivate.

- **Templates**
  - `template-admin-service.ts`: communication templates CRUD (deactivate via `isActive=false`), handoff template versioning, invoice templates CRUD (deactivate), work order templates CRUD (deactivate).

- **Configuration / Keys**
  - `configuration-admin-service.ts`: generic keyed config (`configuration_entries`) list/get/history/set (supersede).
  - `commercial-admin-service.ts`: curated commercial keys list/get/set.
  - `financial-admin-service.ts`: curated financial keys list/get/set.
  - `operational-admin-service.ts`: curated operational keys list/get/set.

- **VIP**
  - `vip-routing-admin-service.ts`: list/save/deactivate VIP routing rows.

- **Readiness**
  - `readiness-admin-service.ts`: readiness check (currently checks presence of a small set of keys + S9 check).

### Backend (Admin routes)

Admin API is mounted under `back_end/src/routes/admin/router.ts` and includes:

- `overview-router.ts`
- `identity-router.ts`
- `configuration-router.ts`
- `staff-router.ts`
- `readiness-router.ts`
- `inventory-router.ts`
- `commercial-router.ts`
- `workflow-router.ts`
- `templates-router.ts`
- `financial-router.ts`
- `operational-router.ts`
- `vip-router.ts`

Also included: **dev helper** endpoint `POST /api/admin/enqueue` to schedule timer jobs.

### Frontend (Admin pages)

Admin pages exist under `front_end/src/app/(app)/admin/**/page.tsx` including:

- Overview, Hotel profile, Departments, Roles & sessions, Staff
- Room types, Rooms, Spaces
- Configuration (generic), Workflow & thresholds, Commercial, Financial, Operational
- Modes, Policies, Templates, VIP routing
- Readiness, System health
- **New**: `Timers & workers` (`/admin/timers-workers`)

### UX improvements already completed

- **Structured (non-JSON) admin UI added for many timer/worker settings**
  - New metadata + editors:
    - `front_end/src/lib/admin/config-schemas.ts`
    - `front_end/src/components/admin/config-form-editor.tsx`
    - `front_end/src/components/admin/structured-config-panel.tsx`
  - New admin page: `front_end/src/app/(app)/admin/timers-workers/page.tsx`
  - `Workflow`, `Financial`, and `Operational` pages now use structured forms where available and fall back to advanced JSON mode.

- **Reduced JSON burden**
  - Hotel profile now uses normal inputs for contact numbers + operating hours (public holidays still optional JSON).
  - VIP routing now uses comma-separated role codes instead of JSON arrays.

- **Delete/deactivate support added where it was missing**
  - Room types: delete (only when not referenced by rooms/holds).
  - Rooms: deactivate (blocks) + guarded delete.
  - Spaces: guarded delete.
  - Roles: delete (only when no staff references roleCode); otherwise deactivate.
  - Policies: deactivate.
  - Templates: deactivate for communication + invoice templates.
  - VIP routing: deactivate.

---

## Timers & workers: what exists today

### Runtime worker runner

Worker runner exists at `back_end/src/workers/runner.ts` and registers many queues (pg-boss), including:

- W1 stage dwell monitor
- W2 speculative hold expiry
- W3 committed hold expiry
- W4 pre-arrival window activation
- W5 no-show cutoff + awaiting-written-confirmation
- W6 night audit
- W7 OTA email parser poll
- W8 payment follow-up
- W9 post-checkout inspection
- W10 deficient resolution deadline
- W11 commission rate missing
- W12 credit ceiling monitoring
- W14 VIP arrival notification
- W15 quotation expiry
- W16 processing lock TTL expiry
- W18 AI audit supplement
- W21 payment milestone
- W22 acknowledgement window + tracker
- W23 room readiness SLA
- W24 housekeeping SLA
- W25 handoff acceptance
- W26 checkout time
- W27 dispute SLA
- W28 feedback solicitation
- W29 equipment return
- W30 retention workers
- W32 FOM override frequency
- W37 stay-night night audit helper

### Worker/timer configuration storage

Timer/worker behavior is configured primarily via **`configuration_entries`** keys. Seeds populate many of these keys in `back_end/prisma/seed.ts`.

### Admin UI for timers/workers

The Admin Console now includes `/admin/timers-workers` which provides structured forms for a subset of timer-related keys, including:

- `processingLock.ttl.perChannel` (W16)
- `ota_email_poll_interval_seconds` (W7)
- `acknowledgement.windowPerType` (W22)
- `stageDwell.thresholds` (dwell monitors)
- `nightAudit.scheduleTime` (night audit schedule)
- `nightAudit.schedule` (W37 hour)
- `payment.followUp.intervals` + `payment.followUp.ttlDays` (W8)
- `advancePayment.followUpWindowSeconds` + `advancePayment.escalationWindowSeconds` (W34)
- `inspection.postCheckout.windowHours` (W9)
- `housekeeping.sla.windowMinutes` (W24)
- `room.readiness.slaWindow` (W23)
- plus expiry TTLs for S1/S2/S3 and no-show cutoff settings

**Note**: ACIG contains additional worker/timer configuration surfaces not yet modeled as curated forms (see “To do”).

---

## Policies: why you “see many policies” but `policy_registry` is empty

### 1) You may be looking at TypeScript policies

The repository contains ~149 TypeScript policy modules under:

- `back_end/src/policies/**`

These are **compiled runtime rules**, not DB entries. They will exist even if `policy_registry` is empty.

### 2) `policy_registry` is DB-owned and starts empty unless seeded or written via admin

The seed resets the DB and begins with:

- `await prisma.policyRegistry.deleteMany();`

If you are using a DB that was seeded before policy rows were added, or you’re not running seed, `policy_registry` will be empty.

### 3) Seed now includes sample policy registry rows (if you re-run it)

`back_end/prisma/seed.ts` now contains:

- `await prisma.policyRegistry.createMany({ data: [...] });`

If your `policy_registry` remains empty, run seed against the current DB:

```bash
cd back_end
npx prisma db seed
```

If you want the whole dev DB reset + seed:

```bash
cd back_end
npx prisma migrate reset
```

---

## What needs to be done (gaps vs ACIG v1.1)

This list is organized around ACIG service inventory (§6.2) and observable repo gaps.

### High priority: missing Admin domain services (ACIG §6.2 inventory)

ACIG lists 26 admin services. The codebase currently implements these (by capability, not exact naming):

- ✅ HotelProfileService (admin)
- ✅ DepartmentService (admin)
- ✅ StaffService (admin)
- ✅ RoleService (admin) (with session config propagation)
- ✅ RoomTypeService (admin-ish; hard delete used instead of ACIG deactivate)
- ✅ RoomInstanceService (admin-ish; deactivate implemented via `isBlocked`)
- ✅ SpaceInventoryService (admin-ish; uses `isAvailable` + delete)
- ❌ RatePlanService (registry + deactivate + walk-in designation + override margin)
- ❌ SeasonService
- ❌ PackageService
- ❌ CommercialThresholdService (dedicated, not just keyed JSON)
- ❌ CancellationPolicyService (dedicated policies & governance)
- ⚠️ WorkflowConfigurationService (partly via keyed config; ACIG expects typed ownership)
- ✅ ModeService (admin-ish)
- ✅ PolicyRegistryService (CRUD exists, but not wired into runtime)
- ❌ CommunicationConfigService (channels + credentials + connectivity tests)
- ✅ HandoffTemplateService (versioning exists; deactivation-by-version not fully surfaced)
- ✅ WorkOrderTemplateService (exists; UI still limited)
- ⚠️ FinancialConfigurationService (keyed only; ACIG expects dedicated surfaces + validations)
- ⚠️ OperationalScheduleService (keyed only; ACIG expects cron validation)
- ✅ VIPNotificationRoutingService (admin-ish)
- ❌ PostStayAndGovernanceService (feedback templates CRUD, platform links, government portal config, commission basis rules, identity doc types)
- ❌ OTAConfigurationService (source flags, polling interval, conflict rules, no-show penalty structure)
- ❌ AIAgentConfigService (LLM credentials, trust levels, connectivity tests, etc.)
- ⚠️ ConfigurationService (generic): currently allows any key set, but ACIG wants **typed validators + key ownership enforcement**
- ✅ ReadinessService (admin-ish; currently checks a small subset)

### High priority: configuration UX completion (remove JSON for normal admins)

Even with the new structured editor, several settings still rely on raw JSON:

- `pricing.ratePlans` (Commercial) — currently JSON-only in UI.
- Mode config JSON (`/admin/modes`) — JSON-only.
- Handoff checklist templates, invoice templates, work order templates — UI is list-only or minimal; needs forms.
- Permissions editor (`/admin/roles`) — still raw line-per-permission ID.

Recommended next steps:

- Add structured editors for:
  - rate plans list + deactivation
  - cancellation policy tiers
  - room assignment priority rules
  - checkout cutoff time as a real time picker
  - invoice template CRUD UI
  - handoff checklist editor UI (list with add/remove/reorder)

### High priority: timer/worker settings coverage (ACIG alignment)

The system has many workers registered in `back_end/src/workers/runner.ts`, but the admin console only exposes a subset of the relevant config knobs.

Needed:

- Build a canonical “Timer/Worker Settings Registry” that maps:
  - worker → config keys → expected shapes → validations
- Extend `/admin/timers-workers` to cover:
  - W12 credit ceiling thresholds & monitoring parameters
  - W10 deficient resolution deadline config (ACIG mentions required control checks when removing categories)
  - W26 checkout time worker settings
  - W30 retention schedules
  - any “per-channel” SLA timers for voice notes (W17) if used

### High priority: PolicyRegistry runtime integration

Current state:

- UI writes DB `policy_registry`
- Runtime uses TypeScript policies under `back_end/src/policies/**`
- There is **no bridge** that loads registry policy definitions and changes behavior.

ACIG intent suggests registry policies should be the admin-editable policy surfaces.

Options:

- **Option A (recommended)**: treat `policy_registry` as *additional policy inputs* (feature flags / thresholds), and update TypeScript policy modules to read from `policy_registry` for specific keys.
- **Option B**: build a generalized “policy execution engine” from stored JSON definitions (high risk, bigger scope).

### Important: validation + safety

ACIG requires:

- **Typed validators per config key** (reject unknown key writes; reject invalid shape)
- **Key ownership enforcement** (generic ConfigurationService must not set keys owned by domain services)
- **RequiredControlCheck** on governance-heavy saves (roles/permissions coverage, removing categories referenced by open records, etc.)

Current state:

- Some ad-hoc guards exist (e.g. forbid <= 0 on certain expiry keys in `configuration-admin-service.ts`)
- No global typed schema registry exists yet.

### Database/data gaps

If you see missing policies/timers/workers “according to ACIG”, it is usually because:

- the key is not present in `configuration_entries`
- or the worker exists but is not parameterized via config yet
- or seed hasn’t been re-run after adding new rows

Action items:

- Add a readiness group specifically for “workers/timers configuration completeness”.
- Seed missing keys for timer knobs that already exist in workers.

---

## Concrete deliverables completed in this repo (file list)

### New/updated frontend files

- `front_end/src/app/(app)/admin/timers-workers/page.tsx`
- `front_end/src/lib/admin/config-schemas.ts`
- `front_end/src/components/admin/config-form-editor.tsx`
- `front_end/src/components/admin/structured-config-panel.tsx`
- Updated:
  - `front_end/src/app/(app)/admin/workflow/page.tsx`
  - `front_end/src/app/(app)/admin/financial/page.tsx`
  - `front_end/src/app/(app)/admin/operational/page.tsx`
  - `front_end/src/app/(app)/admin/configuration/page.tsx` (uses structured editor where available)
  - `front_end/src/app/(app)/admin/hotel-profile/page.tsx`
  - `front_end/src/app/(app)/admin/vip-routing/page.tsx`
  - `front_end/src/app/(app)/admin/policies/page.tsx`
  - `front_end/src/config/admin-nav.ts`

### New/updated backend files

- Updated inventory deletes/deactivates:
  - `back_end/src/services/admin/inventory-admin-service.ts`
  - `back_end/src/routes/admin/inventory-router.ts`
- Roles delete:
  - `back_end/src/services/admin/role-admin-service.ts`
  - `back_end/src/routes/admin/identity-router.ts`
- Policy registry endpoints already exist:
  - `back_end/src/services/admin/workflow-admin-service.ts`
  - `back_end/src/routes/admin/workflow-router.ts`
- Seed now includes sample registry policies:
  - `back_end/prisma/seed.ts`

---

## Next recommended milestones

1) **ACIG Service completion**: implement missing services #8–#12, #16, #22–#24 (rate plans, season/package, cancellation policy, comm channels, post-stay governance, OTA config, AI agent config).

2) **Replace remaining JSON admin edits** with structured forms:
   - rate plans editor (the biggest one)
   - cancellation policy tiers
   - invoice/work order template editors

3) **Policy Registry runtime wiring**: define which runtime decisions are allowed to be overridden by DB registry and implement safe reads + caching.

4) **Validation registry**:
   - zod schemas per config key
   - reject unknown key writes
   - enforce key ownership boundaries

5) **Readiness expansion**: add explicit checks for “worker config completeness” and “policy registry seeded”.

