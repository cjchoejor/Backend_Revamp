# LEGPHEL PMS — Backend_ReVamped (Claude operating notes)

This file is the operating reference for Claude when working in this repo. Update it whenever the codebase shape changes meaningfully (new admin services, new schema migrations, new runtime conventions, new dev commands).

## What this project is

LEGPHEL PMS is a **single-tenant hotel Property Management System** with two distinct surfaces:

- **Operational lifecycle (S1 → S9)** — the 9 stages an entry passes through from inquiry to post-stay. Governed by `docs/SIG-S1..S9` (Stage Implementation Guidelines).
- **Off-axis L4 Admin Console** — the configuration authority surface, accessible only to L4 (General Manager / admin) actors. Governed by `docs/ACIG-v1_1.md` (Admin Console Implementation Guideline).

When working on stage S1–S9 behavior, the relevant SIG is the source of truth. When working on admin console features, ACIG is.

## Documents — where the specs live

All design docs live in `docs/`. The canonical references:

| File | What it covers |
|---|---|
| `docs/ACIG-v1_1.md` | Admin Console Implementation Guideline. Authority for the L4-only admin surface — schema models (§2), config-key meta-registry (§9), the 26 admin services (§6.2), routes (§8). |
| `docs/SIG-S1-v1_2.md` | Stage 1 Implementation Guideline (inquiry intake / availability search). |
| `docs/SIG-S2-v1_3.md` | Stage 2 (quotation). |
| `docs/SIG-S3-v2_0.md` | Stage 3 (committed hold + S4 confirmation prep). |
| `docs/SIG-S4-v2_0.md` | Stage 4 (reservation confirmation; rate freezing). |
| `docs/SIG-S5-v1_0.md` | Stage 5 (pre-arrival window, no-show cutoff, check-in). |
| `docs/SIG-S6-v1_0.md` | Stage 6 (in-house; VIP arrival routing; H1 handoff). |
| `docs/SIG-S7-v1_0.md` | Stage 7 (charge posting; credit ceiling gates; H2 handoff). |
| `docs/SIG-S8-v1_0.md` | Stage 8 (checkout; FOM overrides; W26 checkout timers). |
| `docs/SIG-S9-v1_0.md` | Stage 9 (post-stay; invoices; payment follow-up; government submission; lost & found retention). |
| `docs/admin-console-status-report.md` | Living gap analysis. Read whenever the user asks "what's missing?" — but verify against current code; the report can lag the codebase. |
| `docs/admin-console-visual.html` | UX/style reference. Source for the canonical 9 admin domain definitions. |

When a user asks "what does the spec say about X?", the relevant document above is the source. Quote chapter and verse rather than paraphrasing.

## Stack

- **Backend**: Node + TypeScript (ESM), Express, Prisma 5, PostgreSQL (DB: `legphel_pms_dev`), pg-boss for timer queue. Path: `back_end/`. Dev port 4000.
- **Frontend**: Next.js (App Router) + TypeScript + TanStack Query + sonner toasts. Path: `front_end/`. Dev port 3001 (proxies `/api/*` to backend).

## Repo map — where things live

Anchor these in your head before searching:

### Backend (`back_end/`)

| Location | What's there |
|---|---|
| `prisma/schema.prisma` | Single Prisma schema (admin + operational models). Migrations under `prisma/migrations/`. |
| `prisma/seed.ts` | Destructive seed — wipes tables it owns then re-seeds. Run via `npm run db:seed`. |
| `scripts/` | One-off scripts: targeted seeds (`seed-additional-policies.ts`, `seed-additional-config-keys.ts`, `seed-predefined-modes.ts`), rename helpers (`rename-room-type-id.ts`), inspection (`inspect-policy-registry.ts`), acceptance tests (`s*-acceptance-tests.ts`, `Test_ReVamp/`). |
| `src/index.ts` | Express bootstrap; spawns pg-boss + workers only when `RUN_WORKERS=true`. |
| `src/db.ts` | Singleton `PrismaClient` export. Always import from here, never `new PrismaClient()`. |
| `src/routes/admin/` | Admin route groups, one file per service. Guarded with `requireActorLevel("L4")` + `validateBody(zodSchema)`. |
| `src/routes/` (non-admin) | Operational route groups (stage-aware). |
| `src/services/admin/` | The 26 ACIG admin services (`*-admin-service.ts`). Plain exported functions, prisma as first arg. |
| `src/services/domain/` | Operational stage services (`s1-entry-service.ts`, `s2-hold-service.ts`, etc.). |
| `src/services/infrastructure/` | Timer engine, audit, notification, document-generation, **email-service.ts** (Nodemailer SMTP). |
| `src/policies/**` | 149 compiled-runtime guard modules organised by domain (`01-availability/`, `08-pricing-rate-plan/`, …). Not admin-editable. |
| `src/state-machines/` | Per-stage transition logic (`s1-state-machine.ts`, `entry-lifecycle-state-machine.ts`). |
| `src/workers/` | W1–W37 background workers. `runner.ts` registers them with pg-boss. |
| `src/engines/` | Pricing pipeline, tax, doc-gen, etc. |
| `src/lib/` | Plumbing: `config-store.ts` (ConfigurationEntry reads), `policy-registry-runtime.ts` (registry → operational bridge), `errors.ts`, `timer-engine.ts`, `readable-id.ts`. |
| `src/lib/admin/` | Admin-only plumbing: `config-key-registry.ts` (ownership + validators), `supersede-configuration.ts`, `write-admin-audit.ts`. |
| `src/dtos/08-admin/request-schemas.ts` | Zod schemas for every admin write. |
| `src/middleware/` | `auth.ts` (PIN-session + actor-level checks), `validate-body.ts`. |

### Frontend (`front_end/`)

| Location | What's there |
|---|---|
| `src/app/(app)/admin/` | Admin console pages, one folder per route (each contains `page.tsx`). |
| `src/app/(app)/admin/layout.tsx` | Shared admin shell. |
| `src/components/admin/` | Reusable admin widgets: `structured-config-panel.tsx`, `config-form-editor.tsx`, `smart-config-editor.tsx`. |
| `src/lib/api/admin.ts` | Frontend API client for every admin endpoint + type aliases (`PolicyAdmin`, `ModeAdmin`, …). |
| `src/lib/api/client.ts` | `apiRequest()` + `ApiError` (carries HTTP `status`). |
| `src/lib/admin/config-schemas.ts` | Typed-form metadata for known ConfigurationEntry keys (`TIMER_WORKER_CONFIG_KEYS`, `OPERATIONAL_CONFIG_SCHEMAS`). |
| `src/lib/admin/policy-schemas.ts` | Typed-form metadata for `policy_registry` rows. |
| `src/config/admin-nav.ts` | Nav items + the canonical 9 admin domain definitions (`adminDomains`). |
| `src/hooks/use-session.ts` | Reads the PIN-session from the operational auth layer. |

### Memory / Claude state

| Location | What's there |
|---|---|
| `C:\Users\ASUS\.claude\projects\d--New-Legphel-Web-Backend-ReVamped\memory\` | Persistent memory directory. |
| `…/memory/MEMORY.md` | Index — always loaded into Claude's context. Keep entries one line each. |
| `…/memory/project_orientation.md`, `…/user_profile.md`, `…/reference_specs.md`, `…/project_modes_registry.md` | Individual memory files. |

## Admin console — sidebar structure

As of 2026-06-10, the L4 sidebar is organised into **9 collapsible domain groups** matching ACIG §6.2 / `docs/admin-console-visual.html`, plus a pinned **Overview** at the top and a pinned **Utilities** group at the bottom. The drawer containing the active page auto-expands; the others stay collapsed. Source: [admin-nav.ts](front_end/src/config/admin-nav.ts) (`adminNavGroups`), rendered by [admin-shell.tsx](front_end/src/components/admin/admin-shell.tsx).

Every ConfigurationEntry key now appears on **exactly one page** (its spec-owner per `config-key-registry.ts`):

| Domain | Pages | Notes |
|---|---|---|
| 01 Identity & Org | Hotel profile · Departments · Roles & sessions · Staff registry | |
| 02 Inventory | Room types · Rooms · Spaces | |
| 03 Commercial | Rate plans · Seasons · Packages · Commercial thresholds | Owns `discount.*`, `creditCeiling.*`, `foc.configuration`, `overbooking.*`, `confirmation.authorityThresholds`, `speculativeHold.placementThresholds`, `writeOff.authority.thresholds` |
| 04 Workflow governance | Cancellation policies · Modes · Policies (registry) | |
| 05 Communications & templates | Channels & ack windows · Templates · VIP routing | Owns `communication.channels`, `acknowledgement.windowPerType` (richer ack-windows editor lives here now) |
| 06 Financial & operational | Financial settings · Operational settings · Timers & workers | Timers & workers trimmed to only `expiry.s*`, `stageDwell.thresholds`, `deficientResolution.deadlineHours`, `lostFound.retention.warningOffsetDays` (WorkflowConfig + ConfigurationService) |
| 07 Post-stay & governance | Post-stay & governance | |
| 08 OTA & AI agent | OTA config · AI agent config | Owns OTA polling + `processingLock.ttl.perChannel` + voice-note SLAs |
| 09 Generic & readiness | Configuration (orphaned) · Readiness | Configuration page now filters out domain-owned keys per ACIG §6.2.25 — only truly generic keys appear |

### What was removed

- `/admin/workflow` (Workflow & thresholds) — was 100% duplicate of keys surfaced on Financial / Commercial / Timers / Operational. Page directory deleted; `workflowConfigKeys` constant removed.
- `writeOff.authority.thresholds` removed from `FINANCIAL_CONFIG_KEYS` (owner is CommercialThresholdService).
- All previously-duplicated keys (acknowledgement.windowPerType, advancePayment.*, processingLock.*, nightAudit.*, dispute.sla, fomOverride.frequency, housekeeping.sla.windowMinutes, etc.) were removed from `TIMER_WORKER_CONFIG_KEYS` and now appear only on their spec-owner's page. Their typed schemas live in `DOMAIN_OWNED_TYPED_SCHEMAS` so `getConfigSchema()` still finds them when an owner's page renders.

### Number inputs

The `<input type="number">` editors in `config-form-editor.tsx` were rewritten to use a string-draft pattern (`NumberInput`, `CellNumberInput`) so users can backspace to empty, type partial decimals like `0.`, or paste partial values without the field snapping back to `0`. `parseInt` was replaced by `parseFloat` so decimal values like `0.5` are preserved. Old call sites using the `numInput(...)` shim keep working unchanged.

## Admin console — overview

The Overview page (`/admin`) shows four numbers at the top:

| Number | What it means |
|---|---|
| **Domains: 9** | The ACIG admin surface is organised into 9 functional domains (Identity & Org, Inventory, Commercial, Workflow Governance, Communications & Templates, Financial & Operational Schedule, Post-Stay & Governance, OTA & AI Agent, Generic & Readiness). Source: `docs/admin-console-visual.html`. Defined in `front_end/src/config/admin-nav.ts` as `adminDomains`. |
| **Services: 26** | The 26 admin services per ACIG §6.2 (full list in §6.3). Each service owns specific config keys and exposes its own admin endpoints. The number is hardcoded in `back_end/src/routes/admin/overview-router.ts` and matches the sum across all 9 domains. |
| **Config keys: ~80** | Count of distinct `configKey` values in the `configuration_entries` table — i.e. how many keyed configuration items have at least one row. The number varies with seeded + manually-created keys. A "config key" is a single named tunable parameter (e.g. `expiry.s3.committedHoldTtlSeconds`, `acknowledgement.windowPerType`, `nightAudit.scheduleTime`). Each key can have many versions over time; the count is of distinct keys, not rows. The full canonical list is in ACIG §9. |
| **Readiness: OK / Gaps** | Aggregated result of `runReadinessCheck` ([back_end/src/services/admin/readiness-admin-service.ts](back_end/src/services/admin/readiness-admin-service.ts)) — green when all 13 critical config items are seeded and ≥1 rate plan / L4 staff / room exists; red otherwise. |

The headline "26 services across 9 domains" is exact, not approximate — both numbers are spec-mandated. The 80-ish config keys count is dynamic; ACIG §9 lists ~100 canonical keys total, but not all may be seeded in your environment yet.

## Dev commands (cheat sheet)

Run from `back_end/`:

| What you want | Command |
|---|---|
| Backend dev server (HTTP only, no background workers) | `npm run dev` |
| Backend dev server **with workers and timers active** (W1–W37, pg-boss queue) | `npm run dev:workers` |
| Generate Prisma client after schema change | `npm run db:generate` |
| Run pending migrations | `npm run db:migrate` (interactive) or `npx prisma migrate deploy` (non-interactive) |
| Re-seed (destructive — wipes tables it owns) | `npm run db:seed` |

Run from `front_end/`:

| What you want | Command |
|---|---|
| Frontend dev server | `npm run dev` |

**Always use `dev:workers` on the backend if you need timers, no-show cutoff, hold expiry, dwell warnings, follow-up reminders, night audit, or any W*-prefixed background behaviour to actually fire.** Plain `dev` only serves HTTP.

### Windows / Prisma generate EPERM

On Windows, `npx prisma generate` fails with EPERM when a tsx watcher is holding `node_modules\.prisma\client\query_engine-windows.dll.node`. Workaround:

1. Stop the backend dev server (`tsx watch`).
2. Run `npx prisma generate`.
3. Restart `npm run dev:workers` (or `npm run dev`).

The user has approved this stop/restart cycle for migrations.

## Conventions

### Admin services (per ACIG §6.2)

26 admin services in `back_end/src/services/admin/`, one file per service. Each:
- Exports plain functions taking `prisma` as the first arg.
- Has a route file under `back_end/src/routes/admin/` guarded by `requireActorLevel("L4")` + `validateBody(zodSchema)`.
- Writes audit events via `writeAdminAuditEvent` in the **same transaction** as the configuration write (ACIG §3.4).
- Domain-owned config keys are written through their dedicated endpoint, not the generic `/api/admin/configuration/:key` route — `back_end/src/lib/admin/config-key-registry.ts` is the authoritative ownership map.

### Readable business ID prefixes (admin-editable)

Per [readable-id.ts](back_end/src/lib/readable-id.ts) the system mints `PREFIX-YYYYMMDD-NNNN` IDs for 20 business entities:

All 20 entities now use **readable IDs as the primary key**:

- **The 6 originals**: Inquiry (INQ), Entry (ENT), Folio (FOL), Quotation (QUO), Invoice (INV), Reservation (RES).
- **Tier-A — converted in Phase 2 (2026-06-11)**: Handoff (HND), WorkOrder (WO), LostAndFound (LF), Dispute (DSP), NoShow (NS), CreditExtension (CR), RoomAssignment (RA), KeyReturn (KR), RoomInspection (INS), NightAudit (NA), CommissionDue (CD), Payment (PMT), Amendment (AMD), Communication (MSG).

Prefixes are stored on the `ConfigurationEntry` row `idPrefix.assignments` (a flat JSON map of entity → prefix). Admins edit them on `/admin/id-prefixes`. The backend service [id-prefix-admin-service.ts](back_end/src/services/admin/id-prefix-admin-service.ts) enforces:
- Format: 2–4 uppercase letters only (`/^[A-Z]{2,4}$/`)
- **Collision detection**: rejects any change where two entities would share the same prefix
- Audited via `writeAdminAuditEvent` (supersedes the prior version per the ConfigurationEntry append-only pattern)

`allocateReadableId(db, entityKey, at?)` ([readable-id.ts](back_end/src/lib/readable-id.ts)) resolves the active prefix via `resolveReadableIdPrefix()` with a 5-second TTL cache; admin edits take effect immediately on save (cache invalidated inline). Existing callers were migrated to pass the entity key (e.g. `"INVOICE"`) instead of the literal prefix string so admin-edited overrides flow through.

**Phase 2 — done 2026-06-11**: dropped `@default(uuid())` on all 14 tier-A PKs; updated 31 service `create()` call sites (including 1 `upsert` and 1 `createMany`) to call `allocateReadableId(...)` and pass the result as `id`; added `onUpdate: Cascade` to the 8 FKs pointing into tier-A tables (already the Postgres default for these but now explicit in the schema); ran [scripts/backfill-tier-a-readable-ids.ts](back_end/scripts/backfill-tier-a-readable-ids.ts) which rewrote 38 existing UUID rows to readable IDs (sequence numbers derived from each row's `createdAt`; DisputeRecord uses `openedAt` since it has no `createdAt`). FK references cascaded automatically thanks to the existing `ON UPDATE CASCADE` constraints. Re-run the backfill with `--commit` to apply, or omit for a dry run.

### Cancellation entry points

| Cancel type | Service function | Route | Stage gate | Authority |
|---|---|---|---|---|
| S3 pre-confirmation | `cancelEntryAtS3` ([cancellation-service.ts](back_end/src/services/application/cancellation-service.ts)) | `POST /entries/:id/cancel-at-s3` | `enforceEntryAtS3ForS3CancellationRoute` | L1+ (L3+ for penalty waiver) |
| S5 pre-arrival | `cancelEntryAtS5` | `POST /entries/:id/cancel` | `enforceEntryAtS5ForS5CancellationRoute` | L2+ (L3+ for waiver) |
| Early departure (post-check-in) | `cancelEntryEarlyDepartureAfterCheckIn` | `POST /entries/:id/cancel-early-departure` | `enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation` | L2+ |

All three share the same engine — release hold → cancel timers → supersede invoices → post penalty → refund net → transition entry to CANCELLED/TERMINAL → audit trace.

S3 cancel UI lives on the S3 workspace ([s3-workspace.tsx](front_end/src/components/stages/s3/s3-workspace.tsx)) as a destructive-styled "Cancel booking" card, fronted by a two-step confirm (prompt for reason, then danger-variant confirm).

### Operational policy modules

149 TypeScript policy modules under `back_end/src/policies/**` are compiled runtime guards. They are NOT admin-editable. The admin-editable rule surface is `policy_registry` (the DB table) — operational code consults registry rows via the `getRegistryPolicy(db, policyId)` helper in [`back_end/src/lib/policy-registry-runtime.ts`](back_end/src/lib/policy-registry-runtime.ts), with a TTL cache and admin-write invalidation.

### Memory

Persistent notes for future sessions live at:

```
C:\Users\ASUS\.claude\projects\d--New-Legphel-Web-Backend-ReVamped\memory\
```

`MEMORY.md` is the index; individual files cover project orientation, user profile, references, and recent work. Update when something durable changes (schema, runtime conventions, spec deviations).

## What has been built recently

The admin console has been built out heavily. The state below is current as of the most recent CLAUDE.md update.

### Policy registry runtime wiring (the biggest track)

19 admin-editable policies in `policy_registry` are now consulted at runtime by operational code, all following the same pattern: **registry row → ConfigurationEntry fallback → TS default**. The pattern is proven and trivially repeatable.

Currently wired (each editable on `/admin/policies` with typed forms):

1. `registry.noShow.graceMinutes` → W4 pre-arrival activation worker
2. `registry.duplicateInquiry.blockS1Exit` → p12 (S1 exit guard)
3. `registry.shadowInventory.l4Only` → p14
4. `registry.holdExpiry.minutes` → s3-hold-service / W3
5. `registry.discount.actorCeiling` → p23 + s2-quotation-service
6. `registry.vipArrivalAck.seconds` → entry-lifecycle state machine
7. `registry.deficientResolution.deadlineHours` → inventory-admin-service
8. `registry.handoffAck.seconds` → handoff-service (H2 + H4 ack windows)
9. `registry.fomOverride.frequency` → W33
10. `registry.s1Expiry.minutes` → s1-entry-service
11. `registry.s2HoldExpiry.minutes` → s2-hold-service / W2
12. `registry.quotationValidity.days` → s2-quotation-service / W15
13. `registry.advancePaymentFollowUp.windowSeconds` → s9-service / W34
14. `registry.groupDetection.guestCountThreshold` → s1-entry-service / p64
15. `registry.creditCeiling.tier2Percent` → p44 + p45 (S5 check-in gate + S7 charge-posting gate)
16. `registry.creditCeiling.softGatePercent` → p45 soft gate (100% threshold)
17. `registry.creditCeiling.advisoryThresholds` → s7-folio-lines-service / W12 (tier1/tier2 advisory %)
18. `registry.lostFound.retentionWarning.days` → W30
19. `registry.vip.notificationRoutingPerTier` → entry-lifecycle state machine (SIG-S6 §9, blocking for S6_READINESS)

Frontend schema registry at [`front_end/src/lib/admin/policy-schemas.ts`](front_end/src/lib/admin/policy-schemas.ts) — typed field metadata per known policy ID; supports `number`, `text`, and `json` field kinds. Adding a new policy = new schema entry + new seed row + new `getRegistryPolicy()` consumer.

### Mode registry (ACIG §2.1A.7)

Schema migrated 2026-06-01 to match ACIG §2.1A.7 — `stageRoute`, `autoFulfilmentConditions`, `featureDependencies` are now typed JSON columns (was a single `config: Json` blob). The 8 canonical predefined modes are seeded (NEW_BOOKING, ROOM_CHANGE, RATE_REVISION, DATE_EXTENSION, EARLY_DEPARTURE, BILLING_MODEL_CHANGE, GUEST_COMPOSITION_CHANGE, COMPLAINT_RESOLUTION) as v1 / ACTIVE / isPredefined=true. **Operational code does NOT yet route through `ModeConfiguration`** — the modes exist but are not load-bearing.

### Timer / worker config coverage

`/admin/timers-workers` exposes 21 typed config keys with friendly editors. `/admin/operational` covers operational-schedule keys (checkout, night audit, room assignment, housekeeping/inspection SLAs). `OPERATIONAL_CONFIG_SCHEMAS` in `config-schemas.ts` lets keys get typed editors on the operational page without polluting the timers-workers list.

### Email (Phase 1 — SMTP test surface)

Outbound email infrastructure landed as Phase 1 of the S1–S9 communication track. Phase 1 is a test surface only; no stage code calls the service yet.

- **Transport**: Nodemailer over Gmail SMTP (App Password). Configured via `.env` vars `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_REPLY_TO`. See `.env.example` for the canonical list.
- **Service**: `back_end/src/services/infrastructure/email-service.ts` — single entry point `sendEmail(prisma, { to, subject, html, text, threadEntryId, threadReadableId })`. Also exports `verifyTransport()` for the health check.
- **Test redirect**: `EMAIL_REDIRECT_ALL_TO` env var. When set, every send is rerouted to that address and the original recipient is prepended to the subject as `[→guest@example.com]`. Unset for production sends.
- **Disable**: `EMAIL_DISABLE=true` silently skips all sends (CI/local dev convenience).
- **Threading**: each guest journey (one Entry row) threads into one Gmail conversation. First send for an Entry mints a stable Message-ID and persists it on `Entry.emailThreadRootMessageId` (migration `20260604000000_add_entry_email_thread_root`); subsequent sends set `In-Reply-To` / `References` to that root. Subjects are prefixed with `[ENT-XXXX]` for Gmail's subject-based clustering to agree.
- **Admin test page**: `/admin/email-test` — L4-only. Sends arbitrary subject/body, exercises threading via optional `threadEntryId` + `threadReadableId` fields, surfaces SMTP verification status, keeps a 10-row in-session history with Message-IDs.
- **Routes**: `GET /api/admin/email/verify`, `POST /api/admin/email/test-send`. Mounted via `back_end/src/routes/admin/email-router.ts`.
- **Stage email wiring (Phases 2 + 3)**: Every spec-mandated guest email across S2–S9 is now wired. All routes through `dispatchStageEmailBestEffort` in [stage-email-helpers.ts](back_end/src/services/infrastructure/stage-email-helpers.ts), with templates in [stage-email-templates.ts](back_end/src/services/infrastructure/stage-email-templates.ts):

  | Stage | Trigger | Email | Trace prefix |
  |---|---|---|---|
  | S2 | `sendQuotation` post-tx | Quotation with rate, total, validity | `QUOTATION_EMAIL` |
  | S3 | `dispatchInvoice` (PROFORMA) post-tx | Proforma invoice with balance due | `PROFORMA_INVOICE_EMAIL` |
  | S4 | `confirmReservation` post-tx | Reservation confirmation | `RESERVATION_CONFIRMATION_EMAIL` |
  | S5 | `sendPreArrivalReminderOutbound` post-tx | Pre-arrival reminder | `PRE_ARRIVAL_EMAIL` |
  | S8/S9 | `dispatchInvoice` (non-PROFORMA) post-tx | Final invoice / receipt | `FINAL_INVOICE_EMAIL` |
  | S9 | W28 worker | Feedback solicitation | `FEEDBACK_EMAIL` |

  - All threaded under the Entry — every email for one guest journey lands in **one Gmail conversation** via Entry.emailThreadRootMessageId + In-Reply-To/References.
  - Subject prefix uses `entry.inquiryId` (e.g. `[INQ-20260601-0001]`) so the prefix is stable from S2 all the way through S9.
  - All **non-fatal** — SMTP errors don't roll back the operational transaction. The transaction commits first; SMTP runs after.
  - Skips silently with `*_EMAIL.SKIPPED` traces when the guest has no email or `EMAIL_DISABLE=true`.
- **Deliverability hardening**: `email-service.ts` sets `Message-ID` hostname to the SMTP sender's actual domain (not a placeholder TLD), `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058 one-click), `Auto-Submitted: auto-generated` (RFC 3834), and `X-Auto-Response-Suppress`. These reduce spam-folder routing but the single biggest deliverability fix during Gmail→Gmail testing is the recipient marking the first email as "Not spam" + adding the sender to contacts.

### Editable JSON safety

`SmartConfigEditor` ([`front_end/src/components/admin/smart-config-editor.tsx`](front_end/src/components/admin/smart-config-editor.tsx)) is the fallback editor when no typed schema exists. As of the recent UX pass:

- Field names are **read-only by default** (rendered as labels) to prevent accidental shape mutation. Operational code consumes objects by exact field name; a rename breaks the workflow.
- A "Show structure controls" checkbox unlocks rename + remove (with an amber warning banner) for power users.
- "Advanced JSON" toggle remains the full escape hatch.
- The `StructuredConfigPanel` now handles 404 gracefully — initializes to the schema's default value and shows a "first save" CTA instead of an infinite "Loading…".

## Performance — tab navigation speed

The admin console is a Next.js (App Router) client-side SPA. When the user feels "slow tab switching", three things contribute, in descending order:

1. **Next.js dev-mode JIT compilation** (the biggest factor in `npm run dev`). On first visit to any route, Next.js compiles the page chunk on demand — usually 500ms–2s. Subsequent visits to the same route are near-instant because the chunk is cached. **This is unfixable in dev.** To measure real-world speed, run a production build:
   ```
   cd front_end
   npm run build
   npm run start
   ```
   Production builds pre-compile every route. Most "slow" feelings disappear.

2. **Per-page React Query fetches.** Each admin page fires its own `useQuery` calls on mount. The default React Query cache config in [front_end/src/components/providers/app-providers.tsx](front_end/src/components/providers/app-providers.tsx) is now:
   - `staleTime: 5 * 60_000` (5 min) — a re-visited page within 5 minutes uses cached data, no network round-trip.
   - `gcTime: 30 * 60_000` (30 min) — even after a page unmounts, its data stays cached for 30 min.
   - `refetchOnWindowFocus: false` — alt-tabbing back doesn't trigger refetches.
   - `retry: 1`.

   Pages still call `queryClient.invalidateQueries(...)` after their own mutations, so freshness after edits is preserved. Cross-page reads tolerate 5 min staleness — fine for admin config.

3. **Session-loading flash.** Every admin page early-returns `if (!session) return null` before render. The session is held in React state in [session-provider.tsx](front_end/src/components/providers/session-provider.tsx) — once loaded, it persists across navigations, so this should not cause a visible flash after the first auth. If you ever see a flash on every nav, check that the provider isn't remounting.

Next.js `<Link>` from `next/link` defaults to viewport-based auto-prefetch in App Router. All 29 sidebar admin links sit in a visible (or scrollable) sidebar, so their JS chunks are prefetched in the background on idle. No manual `router.prefetch()` needed.

If a particular tab is still slow in production, the bottleneck is almost always its backend query (Prisma + Postgres). Check the slow endpoint with the browser devtools Network panel and look at the `/api/admin/*` response time.

## Working conventions

- **No invented spec items.** When extending an admin surface, cite the ACIG/SIG section. If the spec doesn't mandate it, ask the user before adding.
- **Skip wirings that already work.** If a config key is owned by a domain service and editable on its dedicated page, don't duplicate it on `/admin/timers-workers` — the generic-endpoint ownership check would reject the save.
- **Verify the auditor.** When an Explore agent reports findings, spot-check at least the most load-bearing claims. The agent has been wrong about which keys are seeded (e.g. claimed `checkout.cutoffTime` was seeded when it 404'd in the UI).
- **No commits without being asked.** The user explicitly approves git commits; otherwise just stage edits and report.
- **Update this file** whenever you:
  - Add a new admin service or route group
  - Add a new `registry.*` policy with a runtime consumer
  - Change a Prisma model that affects more than one service
  - Add a new `npm run` script that the user might rely on
  - Discover a spec deviation worth recording
  - Change a runtime convention (e.g., a new helper that replaces an old pattern)
  - Add a new top-level directory or move important code (update the **Repo map** table)
  - Add or significantly change a doc under `docs/` (update the **Documents** table)
  - Add a new admin domain or service (keep the **Admin console — overview** numbers honest)

If the change is single-file and contained (e.g., bugfix in one route handler), no CLAUDE.md update is required.

When updating: edit the relevant section in place rather than appending — keep the file scannable. If a section grows past ~15 rows, split it into sub-sections rather than letting it bloat.
