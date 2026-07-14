# LEGPHEL PMS — Backend_ReVamped (Claude operating notes)

This file is the operating reference for Claude when working in this repo. Update it whenever the codebase shape changes meaningfully (new admin services, new schema migrations, new runtime conventions, new dev commands).

## ⚠️ Two frontends exist — backend must stay UI-agnostic

The user (cjchoejor) maintains the frontend at `front_end/` **for testing only**. The **real production frontend** is being built by a separate developer with a different UX design and different component structure. That means:

- **Business logic MUST live in the backend.** Anywhere the testing frontend has a calculation, classification, envelope check, or validation, the backend has to expose it via an endpoint or shared service. Duplicating logic in the testing frontend is fine for local convenience but the backend is always the source of truth.
- **No backend endpoint should assume the testing UI's shape.** Endpoints take inputs (JSON) and return outputs (JSON) — don't design them around what the current form fields look like.
- **When adding a new feature: expose a backend endpoint FIRST, then have the testing UI consume it.** The friend's frontend consumes the same endpoint with a different UI. If the calculation only lives in the testing frontend, the friend's UI can't use it and business rules diverge.
- **When you find business logic in `front_end/` that shouldn't be there** — extract it to a backend service + lookup endpoint, delete the frontend duplicate, and update the testing UI to call the endpoint.

Existing backend-authoritative endpoints that show this pattern:
- `GET /api/lookups/child-policy` → child age bands, meal pricing, unaccompanied-minor cutoff
- `POST /api/lookups/allowed-room-counts` → chargeable-occupants + allowed-room-count envelope
- `POST /api/entries/:id/room-assignments/from-sealed-per-night` → bulk assignment from sealed per-night selection

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
| `docs/Legphel-Child-Policy.md` | Front-desk-facing plain-language child policy (age bands, meals, beds, capacity, supervision). Source for the defaults seeded into the 5 `registry.child.*` policies. |
| `docs/legphel-pms-converged.html` | Static HTML prototype of the desired booking-flow layout — three-column desktop (nav + main + summary panel), sticky topbar, event/timer chips. Reference for the unified booking flow at `/inquiries/new`. |
| `docs/policy-wiring-audit-explained.md` | Plain-language walkthrough of the 2026-06-27 policy audit (149 System-A guards + 24 System-B registry policies). Explains System A vs B, what "wired/unwired" means, the shadow-inventory dead-chain case, and shadow-inventory as a concept. Use as reference when someone asks "why is X policy not doing anything?" |
| `docs/multi-room-bug-hunt.md` | Per-bug status table for the 2026-07-13 multi-room sweep (persistence, pricing, state-machine gaps). Location, description, status, fix date. Read before touching `optionSelected` / `CommittedHold` / `roomAssignments`. |
| `docs/backend-bug-hunt.md` | Broader 2026-07-13 backend sweep (auth, money precision, atomicity, silent failures). 41 findings ranked by severity, all currently **Open**. Read before touching auth headers, folio balance math, timer scheduling, or money-typed columns. |

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
| `scripts/` | One-off scripts: targeted seeds (`seed-additional-policies.ts`, `seed-additional-config-keys.ts`, `seed-predefined-modes.ts`), rename helpers (`rename-room-type-id.ts`), inspection (`inspect-policy-registry.ts`), acceptance tests (`s*-acceptance-tests.ts`, `Test_ReVamp/`), the destructive `wipe-operational-data.ts` (`--confirm`; keeps config/staff/rooms/registries). |
| `scripts/import-data/` | **Real Legphel data importers** (dry-run by default, `--commit` to write). `import-legacy-rooms.ts` — `legacy-bookings/room.csv` → 10 RoomTypes + 27 Rooms + per-type RatePlanRegistry (clears the demo catalogue first). `import-legacy-agent-rates.ts` — `agent_rate` CSV → 127 TravelAgents + 9 CorporateAccounts + RateCards. `import-legacy-bookings.ts` — `legacy-bookings/*.csv` → Inquiry→Entry→…→Folio (looks rooms up by number, never creates them). **Load order: wipe → rooms → agents → bookings.** |
| `src/index.ts` | Express bootstrap; spawns pg-boss + workers only when `RUN_WORKERS=true`. |
| `src/db.ts` | Singleton `PrismaClient` export. Always import from here, never `new PrismaClient()`. |
| `src/routes/admin/` | Admin route groups, one file per service. Guarded with `requireActorLevel("L4")` + `validateBody(zodSchema)`. |
| `src/routes/` (non-admin) | Operational route groups (stage-aware). |
| `src/services/admin/` | The 26 ACIG admin services (`*-admin-service.ts`). Plain exported functions, prisma as first arg. |
| `src/services/domain/` | Operational stage services (`s1-entry-service.ts`, `s2-hold-service.ts`, etc.) + cross-stage services: `child-policy-service.ts` (age classification, meal rate, separate-bed charge), `capacity-validation-service.ts` (room-type capacity + composition checks). |
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
| `src/lib/admin/policy-schemas.ts` | Typed-form metadata for `policy_registry` rows. Field kinds: `number`, `text`, `boolean`, `json`. |
| `src/config/admin-nav.ts` | Nav items + the canonical 9 admin domain definitions (`adminDomains`). |
| `src/hooks/use-session.ts` | Reads the PIN-session from the operational auth layer. |
| `src/components/booking-flow/` | Unified `/inquiries/new` page: `booking-flow.tsx` orchestrator, `step-card.tsx` primitive, `booking-context-bar.tsx` sticky breadcrumb, `booking-flow-context.tsx` embed signal, `booking-timer-panel.tsx` right-side countdown drawer. |
| `src/components/stages/s1/availability-calendar.tsx` | Date × room-type calendar grid used inside the S1 workspace during the booking flow. |
| `src/lib/api/child-policy.ts` | Client for `GET /api/lookups/child-policy` (drives child-age input cap). |

### Memory / Claude state

| Location | What's there |
|---|---|
| `C:\Users\ASUS\.claude\projects\d--New-Legphel-Web-Backend-ReVamped\memory\` | Persistent memory directory. |
| `…/memory/MEMORY.md` | Index — always loaded into Claude's context. Keep entries one line each. |
| `…/memory/project_orientation.md`, `…/user_profile.md`, `…/reference_specs.md`, `…/project_modes_registry.md` | Individual memory files. |

## Front-desk operator surface (`/desk`) — THE operational frontend

`/desk` is now **the** operational frontend (promoted 2026-06-26 on branch `UI`; main untouched). The old entry-centric surface — `/dashboard`, `/entries/...`, `/inquiries/...`, the dark-red `AppShell` + its `sidebar`/`topbar`, and the whole `components/stages/**`, `components/dashboard/**`, `components/inquiries/**` trees plus `config/site.ts` + `config/stages.ts` — was **deleted**. Only two surfaces remain under `(app)`: **`/desk`** (operations) and **`/admin`** (L4 config console, incl. `/admin/health` system health). Entry points (`app/page.tsx`, `middleware.ts`, `login-form.tsx`, `redirectAfterLogin`) all route to `/desk`; `app-or-admin-layout.tsx` is now a thin pass-through (both surfaces bring their own shell). Admin + System health are reachable from the desk sidebar's **System** group (both L4-gated — the entire `/admin` tree sits behind `AdminGuard`'s L4 wall). It realises the converged mockup (`docs`/Downloads `legphel-pms-converged`) in **operator language** — no stage numbers or clauses on screen. The S1–S9 lifecycle is presented as a 9-step journey: **Inquiry · Quote · Set up · Confirm · Arrival · Check-in · Stay · Check-out · Closed** (mapping: S1→Inquiry … S9→Closed).

- **Theme**: warm cream/green design tokens ported from the mockup, scoped entirely under `.desk-root` in [front_end/src/styles/desk-theme.css](front_end/src/styles/desk-theme.css) (CSS nesting, no leakage to admin/other app). Fonts: Hanken Grotesk + IBM Plex Mono, added as `--font-hanken` / `--font-plex-mono` in [front_end/src/app/layout.tsx](front_end/src/app/layout.tsx).
- **Shell**: [desk-shell.tsx](front_end/src/components/desk/desk-shell.tsx) — own sidebar/topbar/clock/notification-bell, reuses real `useSession` auth. Sidebar nav groups: **Operations** (Today · Bookings · Rooms) · **Money** (Billing · Reports) · **System** (System health · Admin console — both L4-gated). The old `AppShell` is gone; `app-or-admin-layout.tsx` is a thin pass-through.
- **View model**: [front_end/src/lib/desk/model.ts](front_end/src/lib/desk/model.ts) — the single translation layer from backend `EntryListItem` (S1–S9) to operator vocabulary (`DESK_STEPS`, `stepForStage`, `toDeskBooking`, dwell-timer derivation, avatar/initials helpers). Pages stay dumb; all mapping lives here.
- **Data**: reuses the existing non-admin API clients (`listEntries`, etc.) — no new backend. Where the mockup shows fields the API doesn't carry (price band, advance, deadline timers), the desk derives honest substitutes (e.g. dwell-since-`updatedAt` as the urgency signal) rather than fabricating.
- **Nav**: Today · Bookings · Rooms · Billing · Reports. Built page by page.

| Page | Route | Status |
|---|---|---|
| Today | `/desk/today` (also `/desk` → redirect) | **Built** — "needs you next" attention list (sorted by dwell urgency) + desk stats, wired to real entries |
| Bookings | `/desk/bookings` | **Built** — card grid (step pips + need + dwell), filter chips by phase, wired to `listEntries`. Header "New booking" button → intake. Opens the workspace. |
| New inquiry (intake) | `/desk/bookings/new` | **Built** — desk-styled S1 intake ([inquiry/new-inquiry-form.tsx](front_end/src/components/desk/inquiry/new-inquiry-form.tsx)). New/returning guest; **phone auto-match** (typing a known number surfaces & adopts the existing guest profile); phone country-code preset (+975/+91/+61) with a `+` custom fallback; required **nationality** preset (Bhutanese/Indian) with `+` custom; **"Came in as"** = Walk-in · Direct online · Direct voice · OTA · Corporation · Travel agent · Group/MICE (mapped to the 5 backend-valid `sourceChannel` values — custodian assignment Policy 3 throws on unknown channels — with the finer distinction kept in `notes`; Group/MICE → `useType:"GROUP"`); Travel agent/Corporation reveal the matching lookup picker; **adults + children + per-child ages** (sent as structured `adultCount`/`childCount`/`childAges` on the entry per main's Phase-D child-policy model — no longer stuffed into `notes`; `guestCount` still carries the total; child-age inputs are capped at the live `unaccompaniedMinor.minimumAge`−1 from the `GET /api/lookups/child-policy` snapshot, and ages are required before submit when children > 0 so the backend's S1 child/capacity validation can run and reject BLOCK issues e.g. unaccompanied-minor / over-capacity; `cnbPercent` is still rate-card/S2-level); check-in defaults to today / check-out tomorrow with `min`=today (no past dates). Creates guest profile → `createInquiry` → `createEntry`, opens the workspace. |
| Workspace | `/desk/bookings/[id]` | **Built** — 3-pane journey (rail · canvas · summary) + gate bar, wired to `getEntry`. Reads are real (quotation/reservation/folio/holds/room/identity via [lib/desk/workspace.ts](front_end/src/lib/desk/workspace.ts)). **Native actions so far**: (1) **Inquiry (S1)** — [inquiry-step.tsx](front_end/src/components/desk/workspace/inquiry-step.tsx): availability search + preferred-room select + indicative pricing, gated on `s1Readiness`, advances via `progressStage("S2")`. (2) **Quote (S2)** — [quote-step.tsx](front_end/src/components/desk/workspace/quote-step.tsx): full quote lifecycle (create draft → apply/approve discount → send → record acceptance → supersede) + optional speculative hold, gated on `s2Readiness`, advances via `progressStage("S3")`. (3) **Set up (S3)** — [setup-step.tsx](front_end/src/components/desk/workspace/setup-step.tsx): provisional folio & billing model, cancellation disclosure, advance payment (record/reconcile/payment-status/FOM credit extension), committed hold, proforma-invoice dispatch, group/corporate coordinator + milestones + FOC-GM (conditional), FOM re-entry to Quote/Inquiry, and terminal **cancel** (danger confirm modal). Gate "Review & confirm" navigates to the Confirm step. (4) **Confirm/freeze (S3→S4)** — reachable from S3 (`maxReachableOrder`), gated on the full 8-item `s3Readiness`/`confirmReadiness` checklist, freezes via `progressStage("S4")` behind the consequence modal ([confirm-modal.tsx](front_end/src/components/desk/workspace/confirm-modal.tsx), supports `tone="danger"`). After the freeze the confirmed Confirm step offers **"Continue to Arrival"** → `activatePreArrival` (W4) → S5. (5) **Arrival (S5)** — [arrival-step.tsx](front_end/src/components/desk/workspace/arrival-step.tsx): H1 handoff accept (checklist) → fulfil, room assignment (committed-hold/preferred/catalog picker), pre-arrival tasks complete/waive, advance reconcile + FOM credit-ceiling ack, guest-present attestation; gated on `s5Readiness` + guest-present, advances via `progressStage("S6", { guestPhysicallyPresent: true })`. (6) **Check-in (S6)** — [checkin-step.tsx](front_end/src/components/desk/workspace/checkin-step.tsx): guest identity verification (path + document), VIP arrival notice, room (+ L2 room-change re-entry), advance/payment status, registration + key count; gated on `s6Readiness` + registration + keys, and the **"Check in & go live"** commit (folio → LIVE, room occupied, H2/H3 created) fires `completeCheckInToS7` behind the consequence modal. (7) **Stay (S7)** — [stay-step.tsx](front_end/src/components/desk/workspace/stay-step.tsx): live folio (post charge / correction / credit note), running total, night audit (status + L2 run, reported up for the gate), H2/H3 + H4 pre-checkout (create→accept→fulfil), room deficiencies finalize, disputes (open/start review), L2 amendments + room-change re-entry; gated on `s7Readiness` + night-audit, advances via `progressStage("S8")`. (8) **Check-out (S8)** — [checkout-step.tsx](front_end/src/components/desk/workspace/checkout-step.tsx): the bill (charges/payments/balance + final-morning charge), H4 fulfil, key return, room inspection (deferral + deficiency + damage), **settlement** (method/ref/partial/FOM-ack) as the last commitment boundary via `initiateSettlement` behind the consequence modal ("take payment → folio closes, room released"), final-invoice issue/dispatch, S8→S7 re-entry for extra charges, and GM dispute closure; gated on `s8Readiness`, advances via `progressStage("S9")` ("Close & seal the stay"). **All S1–S9 steps are now native** — the deep-link "Open working tools" bridge is only used for stages with no dedicated desk step (e.g. viewing the terminal Closed step / read-only history). **Park/unpark** (SIG-S1 §3.4 / SIG-S2 §3.3, L1+, valid only at S1/S2): a header **Park** button (warm amber reason modal) / **Resume** button driven by `parkEntry`/`unparkEntry` ([lib/api/entries.ts](front_end/src/lib/api/entries.ts) → `POST /api/entries/:id/park`·`/unpark`). While `status==="PARKED"` the gate bar shows "Resume to continue" instead of any forward step (the backend state machine requires ACTIVE). Parked bookings carry a "Parked" pill on the Bookings cards and Today list, and are de-prioritised out of Today's urgency ranking + "sitting too long" count (a park is a deliberate pause, not a stuck booking). |
| Rooms | `/desk/rooms` | **Built** — floor grid + KPIs + legend, wired to `listRooms`. Status collapsed from `currentClaimState`/`physicalState`/flags via [lib/desk/rooms.ts](front_end/src/lib/desk/rooms.ts). Read-only (no room-status mutation endpoint is exposed to the desk). |
| Billing | `/desk/billing` | **Built** — folio table (state + balance) for folio-bearing bookings; reuses `deriveFinancials`/`folioView` from [lib/desk/workspace.ts](front_end/src/lib/desk/workspace.ts). Fetches per-entry detail via `useQueries`. Rows open the workspace. |
| Reports | `/desk/reports` | **Built** — KPIs (occupancy/in-house) + horizontal bars (bookings-by-step, inquiry channel mix, rooms-by-status), all `∑`-computed client-side from `listRooms`/`listEntries`/`listInquiries`. Revenue/ADR/RevPAR + occupancy forecast are explicitly flagged as not-yet-available (no backend reporting aggregation) rather than faked. |

All 5 nav pages are built. [desk-placeholder.tsx](front_end/src/components/desk/desk-placeholder.tsx) is retained for any future page added before it's implemented.

The deep-link bridge to `/entries/[id]/stages/[slug]` is **gone** (those routes were deleted). The workspace gate bar's only non-native fallback is the terminal **Closed** step, which shows a disabled "Sealed · read-only" button.

**Admin reskinned into the desk format (2026-06-26):** `/admin` + `/admin/health` now wear the desk cream/green palette. Done centrally, not per-page — [admin-theme.css](front_end/src/app/(app)/admin/admin-theme.css) overrides the design-system tokens (`--background`/`--card`/`--primary`/`--foreground`/`--border`/`--muted-foreground`/`--accent`/`--destructive`/`--success`/`--ring`/`--radius` + `--font-sans`/`--font-display` → Hanken) **scoped to `.admin-console`** (the shell root). Because `.admin-console` is a closer ancestor than `:root`/`.dark`, those values win for the whole admin subtree, recolouring every `admin-*` class, Tailwind semantic utility (`bg-background`, `text-muted-foreground`, …) and shadcn component at once. Palette values are ported from [desk-theme.css](front_end/src/styles/desk-theme.css). The no-op `ThemeToggle` was removed from the admin header (admin now has no dark mode — tokens are pinned). Residual hardcoded `red-*`/`amber-*` utilities are left as-is (semantic error/warning colours that harmonise with the desk's own terracotta/amber).

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

### Authentication & actor level (fixed 2026-07-09 — was the #1 Critical)

The actor's LEVEL is **authenticated from the login session token**, not a client header. PIN login ([session-service.ts](back_end/src/services/infrastructure/session-service.ts)) signs a JWT carrying `{ userId, actorLevel, sessionId, terminalId }` (level from the StaffUser record). The global middleware [`authenticateActor`](back_end/src/middleware/auth.ts) (still exported as `parseActorHeaders` for the existing mount) verifies `Authorization: Bearer <jwt>` via [`verifySessionToken`](back_end/src/lib/auth-token.ts) and sets `req.actor` from the **verified payload** — the `X-Actor-Level` header is ignored. `requireActorLevel(min)` is hierarchical (L4≥L3≥L2≥L1). The frontend sends the token from `session.jwtToken` in [client.ts](front_end/src/lib/api/client.ts) `apiRequest` (the whole app routes through it).

- **Secret**: `JWT_SECRET` (env, ≥16 chars; `.env` has a 64-char one). No hardcoded fallback — [auth-token.ts](back_end/src/lib/auth-token.ts) throws in production if unset, uses a loud insecure dev default otherwise.
- **Dev/test escape hatch**: `ALLOW_HEADER_AUTH=true` re-enables the legacy `X-Actor-Id`/`X-Actor-Level` header trust (for curl/scripts). **OFF by default; never enable in a deployed/shared env** — it re-opens the spoofing hole. Backend acceptance-test scripts that hit HTTP with headers need this flag.
- **GM carve-out**: `requireGmRole(prisma, actorId)` ([require-gm-role.ts](back_end/src/lib/admin/require-gm-role.js)) re-resolves the StaffUser and is now wired into custom-mode activation (ACIG §6.1A.2).

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

### EntityVersionSnapshot — version history for in-place admin CRUD tables

Per ACIG §3.4 the audit trail records WHO changed WHAT and WHEN via TraceEvent, but the *prior values* were not stored — once a HotelProfile field was overwritten, the previous state was gone. Phase A (2026-06-11) closed that gap with a generic snapshot table.

**Schema**: `EntityVersionSnapshot` in [schema.prisma](back_end/prisma/schema.prisma) — `(entityType, entityId, version, rowJson, changedBy, changedAt, changeNote)` with `@@unique([entityType, entityId, version])`.

**Wrapper**: [`captureSnapshotTx`](back_end/src/lib/admin/entity-version-snapshot.ts) — call **inside an existing `prisma.$transaction`** immediately before any `tx.<entity>.update({...})` on a tracked table. Captures the current row state as JSON, increments the per-entity version counter, and writes the snapshot. `withEntityVersionSnapshot` is the higher-level form for callers that own the transaction.

**Tracked entities** (17 — defined in `TRACKED_ENTITY_TYPES`): HotelProfile, Department, Role, StaffUser, RatePlanRegistry, SeasonCalendar, PackageRegistry, CancellationPolicyRegistry, ModeConfiguration, CommunicationTemplate, InvoiceTemplate, FeedbackSurveyTemplate, HandoffChecklistTemplate, WorkOrderTemplate, VipNotificationRoutingConfig — plus the 2 Phase-B-to-come tables (TravelAgent, CorporateAccount). **Not tracked**: ConfigurationEntry / PolicyRegistry (already use append-only versioning natively); high-volume operational tables (TraceEvent, etc. — already audit-by-design).

**Routes** (L4-only): `GET /admin/version-snapshots?entityType=X&entityId=Y` lists snapshots newest-first; `POST /admin/version-snapshots/restore` body `{snapshotId, changeNote?}` restores. Restore captures another snapshot of the current state before reverting, so the restore itself is undoable.

**Adding to a new admin page** (mechanical):
```tsx
import { VersionsTab } from "@/components/admin/versions-tab";

<VersionsTab
  entityType="Department"          // must be in TRACKED_ENTITY_TYPES
  entityId={departmentId}
  invalidateOnRestore={[["admin", "departments"]]}  // query keys to refresh after restore
/>
```

The component shows snapshots newest-first, each row expands to view the prior JSON, "Restore" prompts for a change note then a confirmation. Pages currently wired with the tab: HotelProfile. The other 14 are mechanical additions — drop the component anywhere on the page, pass the entity's id, and pass the query keys it uses for its own data fetching.

**Adding tracking to a new entity**:
1. Add the entity name to `TRACKED_ENTITY_TYPES` in [entity-version-snapshot.ts](back_end/src/lib/admin/entity-version-snapshot.ts)
2. Add the Prisma delegate name to `ENTITY_DELEGATE` in the same file
3. Inside each `prisma.$transaction(async (tx) => …)` that updates this entity, call `await captureSnapshotTx(tx, { entityType, entityId, actorId })` immediately before the `.update()`
4. Drop `<VersionsTab>` on the admin page

### Travel agents, corporate accounts, and rate cards (Phase B)

Domain 03 (Commercial) now has dedicated CRUD for **TravelAgent** and **CorporateAccount** under `/admin/travel-agents` and `/admin/corporate-accounts`. Each carries a versioned **RateCard** (append-only — editing creates a new version, prior gets `effectiveTo` set) plus optional per-room-type overrides.

**Models** ([schema.prisma](back_end/prisma/schema.prisma)):
- `TravelAgent` — id (`TA-YYYYMMDD-NNNN`), displayName, contactNumber, contactEmail, modeOfContact (PHONE/EMAIL/WHATSAPP/IN_PERSON/OTHER), notes, isActive
- `CorporateAccount` — same shape + gstNumber + billingAddress
- `RateCard` — partyType (TRAVEL_AGENT/CORPORATE) + partyId (polymorphic, no FK), roomBaseRate, extraBedRate, cnbPercent, breakfast/lunch/dinner standalone rates, CP/MAP_LUNCH/MAP_DINNER/AP meal-plan rates, currency, effectiveFrom/effectiveTo
- `RoomTypeRateOverride` — per-room-type roomBaseRate override on a specific RateCard. New RateCard versions automatically carry forward the active overrides from the prior version.

**Enums**: `ContactMode`, `PartyType`, `MealPlanType` (CP / MAP_LUNCH / MAP_DINNER / AP). Standalone meal add-ons (breakfast/lunch/dinner) are separate Decimal fields on RateCard, not enum values.

**Services** (all 3 in `back_end/src/services/admin/`):
- `travel-agent-admin-service.ts` — CRUD with EntityVersionSnapshot integration
- `corporate-account-admin-service.ts` — CRUD with snapshots
- `rate-card-admin-service.ts` — `createRateCardVersion` (supersedes prior + copies overrides forward), `setRoomTypeRateOverride`, `deleteRoomTypeRateOverride`, `listRateCardsForParty`, `getActiveRateCard`

**Rate resolution helper** at [`back_end/src/lib/agent-rate-resolution.ts`](back_end/src/lib/agent-rate-resolution.ts) — `resolveAgentRate({ partyType, partyId, roomTypeId, mealPlan?, asOf? })` returns the applicable per-night rate breakdown (room rate after override resolution + meal plan rate + standalone add-ons + cnbPercent + currency). Returns `null` if no rate card exists for the party — caller (Phase C: S2 quotation service) decides whether to fall back to the hotel's standard rate plan.

**Versioning**: TravelAgent and CorporateAccount were added to `TRACKED_ENTITY_TYPES` in [entity-version-snapshot.ts](back_end/src/lib/admin/entity-version-snapshot.ts) — every CRUD save on either captures a snapshot. RateCard is versioned natively via the append-only pattern (no EntityVersionSnapshot needed).

**Reusable rate-card editor** at [`front_end/src/components/admin/rate-card-editor.tsx`](front_end/src/components/admin/rate-card-editor.tsx) — used by both the Travel Agents and Corporate Accounts pages. Handles the full grid of rate fields, per-room-type override CRUD, and historical version listing in one self-contained component.

**Phase C — done 2026-06-12**: front-desk wiring complete.

- **Schema** ([schema.prisma](back_end/prisma/schema.prisma)): Inquiry gained two nullable FKs — `travelAgentId` and `corporateAccountId`. Mutually exclusive. Backed by `ON UPDATE CASCADE` (matches the readable-ID pattern). Migration `20260612071638_inquiry_links_to_phase_b`.
- **L1-accessible lookup routes** at [`back_end/src/routes/lookups/router.ts`](back_end/src/routes/lookups/router.ts) — `GET /api/lookups/travel-agents/search?q=…` and `/api/lookups/corporate-accounts/search?q=…`. These mirror the L4-only admin search but with L1 authority so receptionists can use them during intake.
- **S1 inquiry service** ([s1-inquiry-service.ts](back_end/src/services/domain/s1-inquiry-service.ts)): `createInquiry` accepts `travelAgentId` and `corporateAccountId`, validates mutual exclusivity, verifies the referenced party exists and is active, and includes both relations in `getInquiryById`. DTO updated with Zod `.refine()` enforcing the XOR.
- **S2 quotation service** ([s2-quotation-service.ts](back_end/src/services/domain/s2-quotation-service.ts)): new helper `resolveAgentRateForEntryQuotation` looks up the inquiry's linked party, calls `resolveAgentRate` ([agent-rate-resolution.ts](back_end/src/lib/agent-rate-resolution.ts)), and when a card exists overrides `effectiveRate` / `resolvedNightlyRate` / `currency` with the negotiated rate. `commercialTerms` now carries an `agentRate` block (rateCardId, partyType, partyId, roomRate, source, addOns, cnbPercent, currency) plus a `standardPricing` reference of what the hotel's standard rate plan would have charged. Below-MSR check is skipped for agent rates (they're negotiated, not subject to MSR). Currently only wired into single-party `createQuotation`; group quotations still use standard pricing.
- **Front-desk picker** ([agent-corporate-picker.tsx](front_end/src/components/inquiries/agent-corporate-picker.tsx)): reusable mutually-exclusive picker (None / Travel agent / Corporate) with debounced search-by-name and click-to-select. Wired into the new-inquiry form ([new-inquiry-form.tsx](front_end/src/components/inquiries/new-inquiry-form.tsx)).
- **Backward compatibility**: legacy `Inquiry.agentProfileId` and `Inquiry.corporateClientRef` columns remain. Pre-Phase-B inquiries still work; new intake writes to the two FK columns instead.

### Reservation is per-segment immutable history (SIG-S4 §90/§197, AC-S4-024/025/026)

`Reservation` is **one immutable row per segment**, not one per entry (migration `20260706063324_reservation_per_segment_history`). `Reservation.entryId` is **not** unique; `Reservation.segmentId` **is** unique (a second confirmation for the same segment is rejected). Re-entry mints a new segment → `confirmReservation` ([s4-confirmation-service.ts](back_end/src/services/domain/s4-confirmation-service.ts)) **creates a new row** (never upserts) and repoints `Entry.currentReservationId`; the prior segment's reservation stays read-only history.

- **Reads unchanged**: `Entry.reservation` (via `currentReservationId` FK) still resolves the **current** (latest-confirmed) reservation — all existing `entry.reservation` / `include: { reservation: true }` sites keep working. `Entry.reservations` (relation `EntryReservations`) is the full per-segment history.
- **Immutability enforced in [db.ts](back_end/src/db.ts)**: `reservation.update` / `updateMany` / `upsert` / `delete` all throw `RESERVATION_IMMUTABLE`. Only `reservation.create` is allowed. Re-entry paths ([s7-amendment-service.ts](back_end/src/services/application/s7-amendment-service.ts), [s8-re-entry-service.ts](back_end/src/services/domain/s8-re-entry-service.ts)) no longer re-point the old reservation's `segmentId` — the new segment gets its own reservation at re-confirmation.

### Backflows / re-entry transitions (2026-07-14)

The 13 spec-mandated regression paths (SIG-S2 §1.3, SIG-S4 §3.1, SIG-S5 §1.3, SIG-S7 §3.3, Part3 §3.2.4) are all wired. Six existed prior; nine were added on 2026-07-14 alongside the mode-registry runtime.

**Unified helper**: [`state-machines/backflows-state-machine.ts`](back_end/src/state-machines/backflows-state-machine.ts) — `runBackflow(prisma, {entryId, fromStage, toStage, actor, reason, modeKey, hooks, cancelTimerCodes})`. Every backflow calls this. Bookkeeping (segment seal + open, dwell records, entry.currentStage bump, `ENTRY.BACKFLOW_<MODE>_<FROM>_<TO>` trace) is uniform; only side-effects (`hooks`) and timer cancellations differ.

**All 13 backflows**:

| # | Path | Function | Route | Authority | Mode key |
|---|---|---|---|---|---|
| 1 | S2 → S1 | `backflowS2ToS1` | `POST /entries/:id/backflow/s2-to-s1` | L1+ | NEW_BOOKING |
| 2 | S3 → S1 | `s3-reentry-state-machine.initiateS3ToS1Backflow` | (existing) | L2+ | (pre-registry) |
| 3 | S3 → S2 | `s3-reentry-state-machine.initiateS3ToS2Backflow` | (existing) | L2+ | (pre-registry) |
| 4 | S4 → S1 | `backflowS4ToS1` | `POST /entries/:id/backflow/s4-to-s1` | L2+ | NEW_BOOKING |
| 5 | S4 → S2 | `backflowS4ToS2` | `POST /entries/:id/backflow/s4-to-s2` | L2+ | RATE_REVISION |
| 6 | S4 → S3 | `backflowS4ToS3` | `POST /entries/:id/backflow/s4-to-s3` | L2+ | BILLING_MODEL_CHANGE |
| 7 | S5 → S1 | `backflowS5ToS1` | `POST /entries/:id/backflow/s5-to-s1` | L2+ | NEW_BOOKING |
| 8 | S6 → S1 | (existing room-change amendment) | (existing) | L2+ | ROOM_CHANGE |
| 9 | S7 → S1 | `s7-amendment-service.roomChangeReEntryToS1` | (existing) | L2+ | ROOM_CHANGE |
| 10 | S7 → S2 | `backflowS7ToS2` | `POST /entries/:id/backflow/s7-to-s2` | **L3+** (GM only — rate revision) | RATE_REVISION |
| 11 | S7 → S3 | `backflowS7ToS3` | `POST /entries/:id/backflow/s7-to-s3` | L2+ | BILLING_MODEL_CHANGE |
| 12 | S7 → S4 | `backflowS7ToS4` (extra field: `newCheckOutDate`) | `POST /entries/:id/backflow/s7-to-s4` | L2+ | DATE_EXTENSION |
| 13 | S8 → S7 | `s8-re-entry-service.reEnterS8ToS7` (NO new segment) | (existing) | L2+ | (pre-registry) |
| 14 | S8 → S2 | `s8-re-entry-service.reEnterS8ToS2` | (existing) | L2+ | (pre-registry) |
| 15 | Any → S2 | `backflowComplaintToS2` | `POST /entries/:id/backflow/complaint-to-s2` | L2+ | COMPLAINT_RESOLUTION |

**Authority gates**: [`p01-backflow-authority.ts`](back_end/src/policies/01-availability/p01-backflow-authority.ts) — one function per backflow, error codes are stable so the frontend can pattern-match (e.g. `AUTH_REQUIRED_L3` for S7→S2).

**Consequences engine**: [`re-entry-consequence-engine.ts`](back_end/src/engines/re-entry-consequence-engine.ts) now knows the side-effect set for every backflow (e.g. S4→S2 → `RESERVATION_SUPERSEDED, HOLD_RETAINED, FOLIO_CONTINUES, INVOICES_NOT_SUPERSEDED, CANCEL_W4_TIMERS`). Emits `REENTRY.CONSEQUENCES_COMPUTED` trace with the full list.

**Mode registry runtime**: [`lib/mode-registry-runtime.ts`](back_end/src/lib/mode-registry-runtime.ts) — `requireActiveMode(db, modeKey)` returns the highest-version ACTIVE `ModeConfiguration` row. 30-second TTL cache; admin writes invalidate via `invalidateModeRegistryCache(modeKey)` (wired in [workflow-admin-service.ts](back_end/src/services/admin/workflow-admin-service.ts)). Every backflow calls `requireActiveMode`, so the 8 seeded modes are now load-bearing — deactivating a mode via `/admin/modes` disables the corresponding backflows.

**Compatibility**: `isTransitionAllowedByMode(mode, from, to)` softly warns via `MODE.STAGEROUTE_INCONSISTENT` trace when the mode's `stageRoute` doesn't declare the requested transition. Doesn't block — the fixed backflow implementation is trusted, but the trace surfaces cases where the seed needs extending.

**What still isn't there**: the frontend (testing UI) doesn't have buttons for the 9 new backflows yet. They're callable via API; front-desk-facing UI is a follow-up. Same for the friend's real production frontend — endpoints are stable so both can wire whenever.

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

25 admin-editable policies exist in `policy_registry` — 24 are actively consulted at runtime; 1 (`registry.shadowInventory.l4Only`) is seeded but its only consumer (p14) is an orphan file, so the real shadow-inventory enforcement flows through the `availability.shadowInventory.visibilityRules` ConfigurationEntry path instead.

All follow the same override pattern: **registry row → ConfigurationEntry fallback → TS default**.

Currently wired (each editable on `/admin/policies` with typed forms):

1. `registry.noShow.graceMinutes` → W4 pre-arrival activation worker
2. `registry.duplicateInquiry.blockS1Exit` → p12 (S1 exit guard)
3. `registry.shadowInventory.l4Only` → p14 **(orphan — p14 is not imported anywhere; enforcement is via ConfigurationEntry `availability.shadowInventory.visibilityRules` in `s1-availability-service` + `s1-processing-lock-service`)**
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
14. `registry.groupDetection.guestCountThreshold` → s1-entry-service / p64 **(now supports `includeAdults` / `includeChildren` / `includeYoungChildren` boolean flags on the same row — Policy 64 computes an effective count from the per-band breakdown when childAges is present)**
15. `registry.creditCeiling.tier2Percent` → p44 + p45 (S5 check-in gate + S7 charge-posting gate)
16. `registry.creditCeiling.softGatePercent` → p45 soft gate (100% threshold)
17. `registry.creditCeiling.advisoryThresholds` → s7-folio-lines-service / W12 (tier1/tier2 advisory %)
18. `registry.lostFound.retentionWarning.days` → W30
19. `registry.vip.notificationRoutingPerTier` → entry-lifecycle state machine (SIG-S6 §9, blocking for S6_READINESS)
20. `registry.child.ageBands` → child-policy-service (`classifyAge`) → capacity-validation-service, s1-entry-service group-detection band split
21. `registry.child.mealPricing` → child-policy-service (`getMealRateMultiplier`) — NOT yet consumed by the pricing engine (pending)
22. `registry.child.separateBedCharge` → child-policy-service (`getSeparateBedCharge`) — NOT yet consumed by the pricing engine (pending)
23. `registry.child.unaccompaniedMinorMinAge` → capacity-validation-service (BLOCK issue `UNACCOMPANIED_MINOR`); frontend form reads via `/api/lookups/child-policy` to set the child-age input cap dynamically
24. `registry.child.adultToChildRatio` → capacity-validation-service (WARN issue `ADULT_CHILD_RATIO_EXCEEDED`)
25. `registry.groupBooking.advancePaymentBoost` → s3-payment-service `computeAdvancePaymentEvaluation`. Multiplies the resolved base amount (respects per-source thresholds too) by `multiplierPercent` when parent entry is `GROUP_MASTER`. Default 200%.

Frontend schema registry at [`front_end/src/lib/admin/policy-schemas.ts`](front_end/src/lib/admin/policy-schemas.ts) — typed field metadata per known policy ID; supports `number`, `text`, `boolean`, and `json` field kinds. `boolean` renders as a checkbox with an "On/Off" text indicator; `buildDefinition` in `/admin/policies` page coerces to a real boolean before persisting. Adding a new policy = new schema entry + new seed row + new `getRegistryPolicy()` consumer.

### Unwired policy inventory (audit 2026-06-27)

Audit found 17 System-A (TS guard) files unwired at the time. Since then **`p66-group-foc-and-billing-split`** has been wired into `s3-reservation-setup-service.ensureProvisionalFolioAndBillingModel` as part of the group-billing track (2026-07-09) — remove it from the list. The remaining unwired: `p01-s8-to-s9-room-and-keys-gates`, `p10-checkout-due`, `p14-shadow-inventory-visibility` (redundant with the ConfigurationEntry path), `p15-guest-identity-capture`, `p21-mid-stay-rate-amendment`, `p24-mid-stay-discount`, `p31-folio-provisional-required-to-convert-live`, `p32-billing-model-mid-stay-transition`, `p36-early-departure`, `p43-credit-ceiling-commitment-snapshot-carry`, `p47-deficient-surface-in-search-crossref` (placeholder), `p51-room-inspection-exists-for-s8-to-s9`, `p53-active-dispute-management`, `p58-room-change-mode-trigger`, `p59-night-audit-countdown`, `p70-feedback-solicitation`, plus the 6 AI-agent + voice-note placeholders (`p73`–`p77`, `p47`). Each represents implemented-but-uncalled spec logic — either wire it or delete it deliberately; don't leave it drifting.

Plain-language explainer of the audit (System A vs B, "wired/unwired", the shadow-inventory dead-chain) lives at [`docs/policy-wiring-audit-explained.md`](docs/policy-wiring-audit-explained.md) — read it when someone asks "why is X policy not doing anything?"

### Child policy + capacity validation (2026-06-25)

Two new domain services drive the child-policy runtime.

**[`child-policy-service.ts`](back_end/src/services/domain/child-policy-service.ts)** — one-shot loader `loadChildPolicyBundle(prisma)` returns all 5 `registry.child.*` policies with defaults applied. Exports:
- `classifyAge(age, bundle) → "YOUNG_CHILD" | "CHILD" | "ADULT"` — bands come from `registry.child.ageBands` (default 0–5 / 6–10 / 11+)
- `getMealRateMultiplier(age, bundle) → 0..1` — from `registry.child.mealPricing`
- `getSeparateBedCharge(age, bundle, roomBaseRate?)` — handles FLAT and PERCENT_OF_ROOM bases from `registry.child.separateBedCharge`
- `summarizeChildAges(ages, bundle)` — bucket counts per band

**[`capacity-validation-service.ts`](back_end/src/services/domain/capacity-validation-service.ts)** — `validateCapacity(prisma, { roomTypeId?, adults, childAges })` returns issues with codes: `OVER_MAX_OCCUPANCY`, `OVER_MAX_CHILDREN`, `TOO_FEW_ADULTS`, `ADULT_CHILD_RATIO_EXCEEDED`, `UNACCOMPANIED_MINOR`, `CHILD_AGE_ABOVE_LEGAL_MINOR`, `NO_ROOM_TYPE`. Severity `BLOCK` or `WARN`. Two independent age cuts run: pricing bands (child-policy `ageBands`) for bed/meal/room-capacity math; legal age (`unaccompaniedMinor.minimumAge`) for supervision + responsibility. Called from `s1EntryService.createEntry` + `updateEntryIntakeFields` — BLOCK issues throw `ValidationError`.

### RoomType capacity columns (2026-06-26)

Migration `20260626053415_add_roomtype_capacity_fields` added four columns to `RoomType`: `maxOccupancy` (default 2), `maxChildren` (default 2), `requiredAccompanyingAdults` (default 1), `maxExtraBeds` (default 0). Editable per-type on the rewritten `/admin/room-types` page (new "Edit" affordance on each row with inline numeric editors). Backend DTOs `createRoomTypeRequestSchema` + `updateRoomTypeRequestSchema` accept them; `inventoryAdminService.createRoomType` + `.updateRoomType` persist them. Consumed by `capacity-validation-service`.

### Entry guest-composition columns (2026-06-25)

Migration `20260625105007_add_entry_guest_breakdown` added `Entry.adultCount`, `Entry.childCount`, `Entry.childAges Int[]`. `guestCount` remains the canonical total (= adultCount + childCount). Frontend inquiry form has separate "Adults" + "Children" inputs; when children > 0, a per-child age grid appears. Backend DTO + service accept the new fields; validation of the age upper bound is done in the service against `registry.child.unaccompaniedMinorMinAge.minimumAge` (not hardcoded — the Zod schema only enforces the sanity ceiling of 150).

### Unified booking flow at `/inquiries/new` (2026-06-24 → 2026-06-27)

Replaces the previous standalone inquiry-form page with a **three-step vertical accordion** ([`booking-flow.tsx`](front_end/src/components/booking-flow/booking-flow.tsx)):

- **Step 1** — Guest & inquiry intake (embeds `NewInquiryForm` with `keepMounted` so state survives the collapse-when-done cycle; PATCH support via new `updateEntryIntake` API + `updateEntryIntakeFields` service for editing after creation, S1-stage-gated)
- **Step 2** — S1 workspace (availability search, seal preferred room type)
- **Step 3** — S2 workspace (quotation, progress to S3)

Key infrastructure:
- [`step-card.tsx`](front_end/src/components/booking-flow/step-card.tsx) — locked/active/done visual states with optional `keepMounted` (keeps children mounted for state preservation), `onEdit` / `onClose` handlers, `isEditing` flag
- [`booking-context-bar.tsx`](front_end/src/components/booking-flow/booking-context-bar.tsx) — sticky top breadcrumb rendering chips for guest, contact (email + phone), agent/corporate, dates + nights, adults/children (with child ages), sealed room, accepted quotation, and current stage
- [`booking-flow-context.tsx`](front_end/src/components/booking-flow/booking-flow-context.tsx) — signal wrapping the embedded workspaces. `ProgressStageButton` consults it via `useIsInBookingFlow()` and skips `router.push` so stage advances stay inline; the orchestrator auto-advances steps based on entry state
- `step2Done` gated on `entry.currentStage !== "S1"` (not just sealed config) so step 3 opens only after the operator clicks "Progress to S2"
- Auto-fulfil button in S2 workspace is now hidden when `entry.currentStage !== "S1"` (its label was misleading — the backend requires stage S1)
- Timezone-safe date math (`Date.UTC`-based) in the intake form — check-in change auto-fills check-out to next day and syncs a "Number of nights" field. S1 workspace's search form syncs check-in/check-out from entry via `useEffect` on entry field changes so upstream edits reflect

### Availability calendar grid (Phase 2 of the booking flow)

[`availability-calendar.tsx`](front_end/src/components/stages/s1/availability-calendar.tsx) replaces the flat rooms-list display in S1 workspace with a date × room-type matrix. Dates as columns (one per night), room types as rows, each cell showing available-count badge. Type filter sourced from ALL room types (not just result set) — via [`GET /api/rooms`](back_end/src/routes/availability/router.ts) which now returns `floorNumber` + `roomType { id, code, name }`. Floor filter from `Room.floorNumber`. Clicking a row selects that type (backend receives one room of the type for sealing; specific room number is assigned later at pre-arrival or check-in per user's operational preference). Per-row room chips deliberately removed — commitment at S1 is to type only.

**Caveat (Phase 2.5 pending)**: current availability engine ignores reservations/holds when computing availability — it returns rooms based on present physical state. So every date column shows the same count. When the engine grows per-date conflict detection, columns will diverge without any UI change.

### Booking-flow side panels (2026-06-27)

Two floating right-side panels visible on `/inquiries/new` once an entry exists:

- **[`booking-timer-panel.tsx`](front_end/src/components/booking-flow/booking-timer-panel.tsx)** — reads new `GET /api/entries/:id/timers` endpoint (returns SCHEDULED `TimerRecord` rows sorted by `firesAt`). Minimized state shows a labeled countdown pill (e.g. `Inquiry expiry 12:34`); expanded state lists all active timers with friendly `labelForTimer()` mapping (Inquiry expiry / Quote validity / Speculative hold / Reservation hold / Advance payment follow-up / etc). Tone-aware (amber < 30 min, red < 5 min). Countdown ticks every second regardless of open/closed state.
- **`EntryTracePanel`** — adapted to take an optional `entryId` prop so it works outside the `/entries/[entryId]` route context.

### Child policy lookup (2026-06-26)

New L1-accessible endpoint [`GET /api/lookups/child-policy`](back_end/src/routes/lookups/router.ts) returns the live `ChildPolicyBundle` for the front-desk forms. Used by the booking-flow inquiry form to drive the child-age input's `max` attribute dynamically (`unaccompaniedMinor.minimumAge - 1`) — no hardcoded 17. Frontend client at [`front_end/src/lib/api/child-policy.ts`](front_end/src/lib/api/child-policy.ts).

### Config-key ownership registry cleanup (2026-06-27)

`expiry.s1.defaultTtlSeconds`, `expiry.s2.quotationValidityDays`, `expiry.s2.speculativeHoldTtlSeconds`, `expiry.s3.committedHoldTtlSeconds`, `expiry.defaults`, `ownership.assignmentRules`, `billingModel.availablePerSource` — all moved from `WorkflowConfigurationService` owner to `ConfigurationService` in [`config-key-registry.ts`](back_end/src/lib/admin/config-key-registry.ts). The `/admin/workflow` page was deleted earlier (100% duplicate of Timers-Workers), but the ownership registry still pointed these keys at that surface — result was a dead loop where the generic endpoint rejected writes and the "owner" surface never had a route for them. Reassigning to `ConfigurationService` lets the generic PATCH endpoint (which the Timers-Workers page uses) accept the writes. Shape validators (positiveInt, isObject, isArray) preserved.

### Group billing wiring (2026-07-09) — `Entry.groupBillingMode` is now load-bearing

Was a latent flag; now wired end-to-end. Policy 64 sets `groupBillingMode = GROUP_MASTER` at S1 when effective guest count crosses the configurable threshold (include flags on `registry.groupDetection.guestCountThreshold` decide which age bands count — adults + children 6–10 by default, young children excluded). Downstream:

| Stage | Group-aware behaviour |
|---|---|
| **S1 intake update** | `updateEntryIntakeFields` re-runs Policy 64 when guest counts change. Skipped when `groupBillingModeManualOverride === true`. Reclassification writes an audit trace `ENTRY.GROUP_BILLING_MODE_RECLASSIFIED`. |
| **S3 folio setup** | Billing model picker pre-fills `DIRECT_BILL` with a visible hint. `enforceGroupBillingSplitConfigured` (p66) guards the transition. Changing to a non-group-friendly model (anything other than `DIRECT_BILL` / `TOUR_OPERATOR_VOUCHER`) requires L3+ authority — `s3-reservation-setup-service` throws `AuthorizationError` otherwise. |
| **S3 payment** | `computeAdvancePaymentEvaluation` multiplies the required amount by `registry.groupBooking.advancePaymentBoost.multiplierPercent` (default 200 = 2×). Now honours per-source thresholds too (`advancePayment.thresholds.OTA.amount` etc.), not just DEFAULT. Response carries `groupBoostApplied: { multiplierPercent, baseAmount }` when the boost fired; frontend shows a hint. |
| **S4 confirmation email** | `renderReservationConfirmationEmail` branches on `isGroup` — subject becomes "Group reservation confirmed", greeting uses `groupLeaderName` (contact person → guest profile fallback), adds "Group booking · N rooms" + "Billing: {model}" lines. |
| **W4 pre-arrival activation (S4→S5)** | Enforces `contactPersonName` + `contactPersonPhone` are set. Returns `{ skipped: true, reason: "MISSING_CONTACT_PERSON" }` otherwise. Applies to ALL entries (not just groups) — the on-site contact is a universal requirement per the business rule. |
| **S6 check-in** | `completeCheckInToS7` iterates ALL distinct room assignments for group entries. Per-room physical-ready enforcement (fail-fast if any room isn't ready). One H2 + one H3 handoff created per room, dedup keyed off the new `HandoffRecord.roomAssignmentId` FK (falls back to `checklistContent.roomNumber` for pre-migration rows). Per-room rejection check via `perRoomHandoffs` map. Room state CONFIRMED→OCCUPIED transitions run per room. |
| **S7 amendments** | `AmendmentEventRecord.affectsGroup` populated from the parent entry's `groupBillingMode` at create time. Both `s7-amendment-service.recordAmendment` and `entry-lifecycle-state-machine`'s room-change flow read the flag. |
| **S8 final invoicing** | `resolveGroupInvoiceOverrides` helper in [`s8-settlement-service.ts`](back_end/src/services/domain/s8-settlement-service.ts) applies at all 3 FINAL invoice create sites (issueInvoiceAtS8, DIRECT_BILL settle, VOUCHER settle). Prefixes `templateKey` with `group-` and adds `{ groupBooking: true, roomCount, guestCount, groupLeader }` to metadata. Frontend (S9 workspace invoice list) shows an indigo `Group · N rooms` pill. |
| **All views** | `<GroupBadge>` component ([front_end/src/components/entries/group-badge.tsx](front_end/src/components/entries/group-badge.tsx)) — indigo pill with Users icon. Only renders when `groupBillingMode === "GROUP_MASTER"`. Placed on entry list, EntryHeader (workspace pages), S3 folio card, BookingContextBar sticky breadcrumb. |

**Manual override:** `PATCH /api/entries/:id/group-billing-mode` — L3+ endpoint, Zod-validated body `{ mode: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null, reason: string, clearManualOverride?: boolean }`. Sets `Entry.groupBillingMode` explicitly + flips `Entry.groupBillingModeManualOverride = true` so subsequent intake edits don't re-classify. Setting `clearManualOverride: true` re-enables Policy 64 auto-reclassify. Audit trace `ENTRY.GROUP_BILLING_MODE_MANUALLY_SET` records reason + prior state. Service at [`back_end/src/services/admin/group-billing-mode-admin-service.ts`](back_end/src/services/admin/group-billing-mode-admin-service.ts).

**Migration** `20260709091543_group_hardening_contact_person_and_handoff_fk` added:
- `Entry.groupBillingModeManualOverride Boolean @default(false)`
- `Entry.contactPersonName String?` + `Entry.contactPersonPhone String?`
- `HandoffRecord.roomAssignmentId String?` + FK to `RoomAssignment`
- `AmendmentEventRecord.affectsGroup Boolean @default(false)`

Note: after applying, stop `npm run dev:workers`, run `npx prisma generate`, restart — engine binary lock (Windows EPERM) unless you bounce.

### HandoffChecklistContent typed shape

[`back_end/src/lib/handoff-checklist.ts`](back_end/src/lib/handoff-checklist.ts) — replaces the ad-hoc `as any` casts on `HandoffRecord.checklistContent` reads. Exports `HandoffChecklistContent` (union of every field ever written — all optional) + `readHandoffChecklistContent(value)` safe narrower. Used by check-in-service for the per-room dedup / rejection-check.

### Multi-room selection at S1 + per-night persistence (2026-07-13)

Big body of work turning S1 room selection into a proper per-(room, night) affair — and hardening every downstream service to survive multi-room bookings that AREN'T classified as groups.

**Selection model:**
- Calendar grid: rows = individual rooms (filtered by type + floor), columns = nights. Click a cell to toggle assignment.
- Per-night selection saved on `AvailabilityConfiguration.optionSelected` as a JSON blob. Three legal shapes:
  1. Legacy: `{ roomId, isDeficient }`
  2. Whole-stay multi: `{ roomIds: [{ roomId, isDeficient }], isDeficient }`
  3. Per-night: `{ perNight: [{ date, roomIds: [{ roomId, isDeficient }] }], isDeficient }`
- **Backend reader**: [`back_end/src/lib/option-selected-reader.ts`](back_end/src/lib/option-selected-reader.ts) `readOptionSelected(opt)` → `{ distinctRoomIds, perNight, anyDeficient }`. Every backend service that reads `optionSelected` uses this helper — no more shape-specific casts. Frontend mirror: `optionSelectedRoomIds()` in `types/api.ts`.
- No auto-seal: operator explicitly clicks Save selection when every night reaches target count. Change selection button re-opens for editing.

**Persistence extended downstream** (`20260713044307_per_night_persistence_downstream`):
- `RoomAssignment.startDate` + `endDate` (nullable) — per-night dated assignments, one row per (roomId, contiguous range).
- `CommittedHold.perNightBreakdown Json?` — snapshot of the sealed per-night selection so S3+ services can reconstruct intent without re-reading the availability configuration.
- New helper `roomAssignmentService.assignRoomsFromSealedPerNight(prisma, entryId, actorId)` — folds nights into contiguous ranges and creates one `RoomAssignment` per (roomId, range). Route: `POST /entries/:id/room-assignments/from-sealed-per-night`.

**Multi-room ≠ group** — the class-of-bug fix (2026-07-13):

Historically, batched-processing code keyed off `groupBillingMode === "GROUP_MASTER"`. But GROUP_MASTER only fires above the guest-count threshold (default 6). A 2-room booking for 4 guests would drop into the "single room" code path and only process the first room. Fixed everywhere:

| Service | Old condition | New condition |
|---|---|---|
| `check-in-service.completeCheckInToS7` | `groupBillingMode === "GROUP_MASTER" ? all : first` | `distinctAssignments.length > 1 ? all : first` |
| `s8-checkout-service.completeCheckoutPhysicalDeparture` | same | same |
| `cancellation-service.cancelEntryEarlyDepartureAfterCheckIn` (S7) | `roomAssignments[0]` only | iterate `distinctRoomsToRelease` |
| `s3-hold-service.placeCommittedHold` (2026-07-13 hardening) | pinned only `input.roomId` to COMMITTED_HELD | reads sealed `optionSelected` and pins ALL distinct rooms |
| `cancellation-service.cancelEntryAtS3` + `cancelEntryAtS5` | only released `hold.roomId` | iterates `hold.perNightBreakdown` + `hold.roomId` — releases every room |
| Frontend S6 workspace banner | shown for GROUP_MASTER only, said "Group booking" | shown any time distinct rooms > 1, says "Multi-room booking" |

**S2 quotation multi-room-safe pricing** (2026-07-13):
- Was reading `optionSelected.roomId` directly, throwing "Preferred configuration missing roomTypeId" for any multi-room seal. Now goes through `readOptionSelected` + `firstRoomId` helpers.
- `Quotation.totalAmount` = `effectiveRate × roomCount` (was just `effectiveRate` → wildly under-priced multi-room bookings). Downstream × nights gives the true stay total.
- `commercialTerms.roomCount` and `commercialTerms.pricingBreakdown` (`{ nightlyRate, nights, roomCount, subTotal }`) explicit for downstream consumers (S3 threshold, S4 confirmation, S9 reconciliation) so they don't re-derive room count.
- Applied at BOTH quotation entry points: `createQuotation` (single-party) + `createGroupQuotation` (group path).

### Multi-room bug hunt (2026-07-13) — log moved to docs

Full per-bug status table (location, description, status, fix date) lives at [`docs/multi-room-bug-hunt.md`](docs/multi-room-bug-hunt.md). Read it when hunting for regressions in the multi-room path or when adding new code that touches `optionSelected` / `CommittedHold` / `roomAssignments`. Summary: all 11 identified bugs fixed 2026-07-13; 1 suspected bug (speculative hold release) verified as single-room-by-design; 4 additional call sites also confirmed as single-room-by-design.

### Group-billing wiring — status (updated 2026-07-13)

Completed since the "load-bearing" note:

- ✅ **Batched S8 checkout** — done; mirror of check-in
- ✅ **Batched multi-room check-in for non-group entries** — done via the "multi-room ≠ group" fix
- ✅ **Contact person input fields** on booking flow step 1 — done
- ✅ **Admin UI for `PATCH /group-billing-mode`** — `<GroupBillingModeToggle>` component on `EntryHeader`, L3+ only
- ✅ **Group-tier credit ceiling** — `registry.groupBooking.creditCeilingBoost` policy seeded + `recommendCreditCeilingForEntry(prisma, entryId, baseAmount)` helper in s3-payment-service
- ✅ **Per-date availability engine (Phase 2.5)** — engine consults `Reservation` + `CommittedHold` intersecting the query range; returns `perDate` breakdown; calendar cells consume it
- ✅ **`NightAuditAnomaly.roomId`** — column added, downstream code can populate per-room anomalies

Still open (short list):

- **Child meal pricing engine wiring** — `computeGroupMealCharge` helper exists in child-policy-service; `s2-quotation-service` attaches `perGuestMealBreakdown` to `commercialTerms` when adult meal rate is available (via agent rate card breakfast add-on). BUT the actual pricing engine total doesn't yet consume it — still uses flat adult rate × all guests. Follow-up: replace flat meal charge with `computeGroupMealCharge(...).total`.
- **Night audit per-room populate** — schema column exists; audit worker still records at entry-level. Follow-up: pass roomId when the discrepancy is room-scoped.
- **Per-date availability engine consumers** — `getEntryWithRoom` (S8 helper) + `s7-amendment-service.roomChangeReEntryToS1` still use `roomAssignments: take: 1`. Correct in their contexts (they operate on ONE specific room the operator picked), but worth an audit.

### Mode registry (ACIG §2.1A.7)

Schema migrated 2026-06-01 to match ACIG §2.1A.7 — `stageRoute`, `autoFulfilmentConditions`, `featureDependencies` are now typed JSON columns (was a single `config: Json` blob). The 8 canonical predefined modes are seeded (NEW_BOOKING, ROOM_CHANGE, RATE_REVISION, DATE_EXTENSION, EARLY_DEPARTURE, BILLING_MODEL_CHANGE, GUEST_COMPOSITION_CHANGE, COMPLAINT_RESOLUTION) as v1 / ACTIVE / isPredefined=true.

**Load-bearing as of 2026-07-14**: [`lib/mode-registry-runtime.ts`](back_end/src/lib/mode-registry-runtime.ts) provides `requireActiveMode(db, modeKey)`, `resolveActiveMode(db, modeKey)`, `invalidateModeRegistryCache(modeKey?)`, and `isTransitionAllowedByMode(mode, from, to)`. Every backflow (see **Backflows / re-entry transitions**) calls `requireActiveMode` — deactivating a mode from `/admin/modes` immediately disables its backflow. Admin writes (`saveMode`, `activateMode`, `deactivateMode`) call `invalidateModeRegistryCache(modeKey)` so the 30-second TTL cache doesn't lag admin edits. `isTransitionAllowedByMode` emits `MODE.STAGEROUTE_INCONSISTENT` traces when a backflow's from/to isn't declared in the mode's `stageRoute` — soft signal to extend the seed. **What's NOT yet consumed**: `autoFulfilmentConditions` (backflows still fire full transitions rather than auto-skipping validated sub-stages), `featureDependencies` (informational; nothing gates on subsystem presence yet).

### Timer / worker config coverage

`/admin/timers-workers` exposes 21 typed config keys with friendly editors. `/admin/operational` covers operational-schedule keys (checkout, night audit, room assignment, housekeeping/inspection SLAs). `OPERATIONAL_CONFIG_SCHEMAS` in `config-schemas.ts` lets keys get typed editors on the operational page without polluting the timers-workers list.

### Timer cancellation (fixed 2026-07-09) — `engine.cancel(jobId)` now actually cancels

Historically `TimerEngine.cancel` called `boss.cancel(jobId)` with only the job id and swallowed the error. pg-boss v12 requires the **queue name**: `cancel(queueName, jobId)`. So **every** timer cancellation across the system was a silent no-op — cancelled pg-boss jobs still fired; only downstream worker state-guards saved us. [timer-engine.ts](back_end/src/lib/timer-engine.ts) now resolves the queue name from pg-boss's own `pgboss.job` table (via a small dedicated `pg.Pool`) and calls `cancel(queueName, jobId)`, and **logs** (no longer swallows) on failure. Callers still pass only `pgBossJobId` — the signature is unchanged.

This was the root cause of **parked entries expiring early**: park cancels the short stage-expiry timer and arms a 30-day `PARKING_FOLLOW_UP` `ENTRY_EXPIRY` job — but the cancel no-op'd, so the short timer still fired. Defense-in-depth was also added: [`expireEntry`](back_end/src/services/domain/s1-entry-service.ts) now skips a `PARKED` entry unless the firing job is the genuine park-follow-up (its pg-boss payload carries `parkFollowUp: true`, forwarded by [w20-entry-expiry-worker.ts](back_end/src/workers/w20-entry-expiry-worker.ts)), with a tx re-check to close the TOCTOU race. Per SIG-S1 §3.4 a parked entry still expires — but only after the 30-day park-expiry threshold, never on its short stage window.

Also (fixed 2026-07-10): park/unpark now switch the open `StageDwellRecord.mode` (`PARKED` on park, `ACTIVE` on unpark, in `parkEntry`/`unparkEntry` + the cascade variants) so the W1 StageDwellMonitor applies the relaxed **PARKED** threshold band per SIG-S1 §1187 (was staying `ACTIVE`, so a parked booking got "sitting too long" warnings on the tight active thresholds).

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
