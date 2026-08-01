# LEGPHEL PMS — Backend_ReVamped (Claude operating notes)

This file is the operating reference for Claude when working in this repo. Update it whenever the codebase shape changes meaningfully (new admin services, new schema migrations, new runtime conventions, new dev commands).

## ⚠️ Two frontends exist — backend must stay UI-agnostic

The user (cjchoejor) maintains the frontend at `front_end/` **for testing only**. The **real production frontend** is being built by a separate developer with a different UX design and different component structure. That means:

- **Business logic MUST live in the backend.** Anywhere the testing frontend has a calculation, classification, envelope check, or validation, the backend has to expose it via an endpoint or shared service. Duplicating logic in the testing frontend is fine for local convenience but the backend is always the source of truth.
- **No backend endpoint should assume the testing UI's shape.** Endpoints take inputs (JSON) and return outputs (JSON) — don't design them around what the current form fields look like.
- **When adding a new feature: expose a backend endpoint FIRST, then have the testing UI consume it.** The friend's frontend consumes the same endpoint with a different UI. If the calculation only lives in the testing frontend, the friend's UI can't use it and business rules diverge.
- **When you find business logic in `front_end/` that shouldn't be there** — extract it to a backend service + lookup endpoint, delete the frontend duplicate, and update the testing UI to call the endpoint.

**No money arithmetic in `front_end/` (enforced 2026-07-22).** Every financial figure the desk shows is read from the API — no sums, no `rate × nights`, no balance fallbacks. `deriveFinancials` ([lib/desk/workspace.ts](front_end/src/lib/desk/workspace.ts)) is a pure *selector* over `EntryDetail` + the `payment-status` response; `moneyOrDash()` renders "—" when the backend has no field. Advance-paid always comes from `GET /api/entries/:id/payment-status` → `totalReceived` (Decimal-safe server-side) via the shared `usePaymentStatus` hook — never from summing folio payment rows. Two figures are currently dark because no endpoint supplies them: a **folio charges total** (only `outstandingBalance` exists) and a **reservation stay total** (only per-night `frozenRate`; there is no `frozenTotalAmount` column). Add those server-side rather than reintroducing the maths here.

Existing backend-authoritative endpoints that show this pattern:
- `GET /api/lookups/child-policy` → child age bands, meal pricing, unaccompanied-minor cutoff
- `POST /api/lookups/allowed-room-counts` → chargeable-occupants + allowed-room-count envelope
- `POST /api/entries/:id/room-assignments/from-sealed-per-night` → bulk assignment from sealed per-night selection

## ⚠️ Branches — main vs. integration-prod-frontend

Two long-lived branches on the same GitHub repo:

| Branch | Contains | Purpose |
|---|---|---|
| `main` | `back_end/` + user's testing `front_end/` | Daily dev branch — the user's testing UI + backend, untouched by friend's code. |
| `integration-prod-frontend` | `back_end/` + user's `front_end/` + `friend_back_end/` + `friend_front_end/` | Integration branch. Holds the friend's production frontend + a snapshot of the friend's backend for reference. User's backend is the source of truth on both branches. |

The friend pushes to his branch `UI-experiment` on the same repo. To pull his latest frontend/backend into the integration branch, use the worktree flow documented under **Working conventions → Pulling friend's latest from UI-experiment**.

**Never merge integration-prod-frontend → main.** Backend changes flow `main → integration-prod-frontend`, never the other direction. Frontend changes stay branch-local.

## Wired: friend's production frontend runs on user's backend (2026-07-14)

The friend's frontend (at `friend_front_end/` on the integration branch) is wired to run against **user's backend** (at `back_end/`). Both were forked from the same base, so the auth contract, endpoint shapes, and DTO structure are byte-equivalent — **no code changes** were needed on his frontend. The wiring is purely config:

**How it works**:
- Friend's `next.config.ts` proxies `/api/*` to `http://127.0.0.1:4000` (user's backend default port) via the `BACKEND_URL` env var. Default already matches — no override needed.
- Friend's `apiRequest` client at [`friend_front_end/src/lib/api/client.ts`](friend_front_end/src/lib/api/client.ts) already sends `Authorization: Bearer <jwt>` from the stored session — matches user's JWT auth middleware.
- Friend's login form calls `POST /api/auth/authenticate` with `{ username, pin, terminalId }` — matches user's endpoint shape exactly.
- Friend's session shape (`{ sessionId, userId, username, actorLevel, terminalId, jwtToken, ... }`) matches what user's `session-service.authenticate` returns.

**How to run both frontends against the same backend simultaneously**:

```bash
# Terminal 1 — user's backend (port 4000)
cd back_end
npm run dev:workers            # or npm run dev

# Terminal 2 — user's testing frontend (port 3001, default)
cd front_end
npm run dev

# Terminal 3 — friend's production frontend on a DIFFERENT port
cd friend_front_end
npm install                    # first time only — his deps aren't installed yet
PORT=3002 npm run dev          # override the 3001 default to avoid collision
```

Then open:
- `http://localhost:3001` — user's testing UI (talks to backend at :4000)
- `http://localhost:3002` — friend's production UI (talks to same backend at :4000)

Log in with the seeded users (`admin` / `4444`, `gm` / `3333`, `fom` / `2222`, `frontdesk` / `1111`).

**Cleanup plan when validation is done**:
Once friend's frontend is confirmed working end-to-end against user's backend, delete the two temporary references:
```bash
git rm -r friend_back_end
git rm -r front_end   # ONLY if user decides to retire the testing frontend
git commit -m "Retire scaffolding: friend's backend + user's testing frontend"
```

The friend's `friend_back_end/` is reference-only — user does NOT wire against it. It stays on the integration branch as a diff target: "if friend's frontend expects a shape user's backend doesn't provide, `friend_back_end/` shows what he originally built against."

**Auth env vars now documented** in [`back_end/.env.example`](back_end/.env.example):
- `JWT_SECRET` — set in production; dev falls back to `"dev-jwt-secret"` with a console warning
- `AUTH_ALLOW_HEADER_FALLBACK` — set to `true` only if you need to accept legacy `X-Actor-Id`/`X-Actor-Level` headers (off by default, JWT is authoritative)

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
| `docs/rate-mapping-visual.html` | Visual money-flow map (2026-07-28): every rate/amount traced DB table.column → backend computation → API field → UI/PDF, per stage S1–S9, with the 8 confirmed wrong-pull risks flagged (child pricing not applied, meal rates 0 for non-agent, hydration freezing per-room totals from 0, etc.). Open in a browser. Regenerate when pricing code changes. |

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
| Today | `/desk/today` (also `/desk` → redirect) | **Built** — "needs you next" attention list (sorted by dwell urgency, capped at 7 rows with the remainder folded into per-step count pills so bulk-imported bookings can't wall the page) + hotel-day rhythm column: arriving/leaving/in-house/new-inquiry stats plus named arrival & departure mini-lists computed from `checkInDate`/`checkOutDate` vs the local calendar day. Wired to real entries |
| Bookings | `/desk/bookings` | **Built** — card grid (step pips + need + dwell), filter chips by phase, wired to `listEntries`. Header "New booking" button → intake. Opens the workspace. |
| New inquiry (intake) | `/desk/bookings/new` | **Built** — desk-styled S1 intake ([inquiry/new-inquiry-form.tsx](front_end/src/components/desk/inquiry/new-inquiry-form.tsx)). New/returning guest; **phone auto-match** (typing a known number surfaces & adopts the existing guest profile); phone country-code preset (+975/+91/+61) with a `+` custom fallback; required **nationality** preset (Bhutanese/Indian) with `+` custom; **"Came in as"** = Walk-in · Direct online · Direct voice · OTA · Corporation · Travel agent · Group/MICE (mapped to the 5 backend-valid `sourceChannel` values — custodian assignment Policy 3 throws on unknown channels — with the finer distinction kept in `notes`; Group/MICE → `useType:"GROUP"`); Travel agent/Corporation reveal the matching lookup picker; **adults + children + per-child ages** (sent as structured `adultCount`/`childCount`/`childAges` on the entry per main's Phase-D child-policy model — no longer stuffed into `notes`; `guestCount` still carries the total; child-age inputs are capped at the live `unaccompaniedMinor.minimumAge`−1 from the `GET /api/lookups/child-policy` snapshot, and ages are required before submit when children > 0 so the backend's S1 child/capacity validation can run and reject BLOCK issues e.g. unaccompanied-minor / over-capacity; `cnbPercent` is still rate-card/S2-level); check-in defaults to today / check-out tomorrow with `min`=today (no past dates). Creates guest profile → `createInquiry` → `createEntry`, opens the workspace. |
| Workspace | `/desk/bookings/[id]` | **Built** — 3-pane journey (rail · canvas · summary) + gate bar, wired to `getEntry`. Reads are real (quotation/reservation/folio/holds/room/identity via [lib/desk/workspace.ts](front_end/src/lib/desk/workspace.ts)). **Native actions so far**: (1) **Inquiry (S1)** — [inquiry-step.tsx](front_end/src/components/desk/workspace/inquiry-step.tsx): availability search + preferred-room select + indicative pricing, gated on `s1Readiness`, advances via `progressStage("S2")`. Room selection has two views (2026-07-31): the room-status **table** (rows × nights, default; only view for per-night vary mode) and a **guest board** ([room-select-board.tsx](front_end/src/components/desk/workspace/room-select-board.tsx), S2-board-style chips into bins) where the rooms holding guests ARE the selection — uniform placements write the same `tableSel`; a night strip ("All nights" + per-night scopes, S2-meal-scope style) lets placement differ by night, emitting a per-night payload the parent seals with (mirrored into `varySel` for table continuity). Capacity on BOTH boards counts **chargeable** guests only (mirrors `computeChargeableOccupants` — under-11s share bedding, no slot; occ chip reads e.g. "2/3 +1kid"). Placement itself is a picking aid only (S1 seals room ids; who-sleeps-where is set on the S2 board). (2) **Quote (S2)** — [quote-step.tsx](front_end/src/components/desk/workspace/quote-step.tsx): full quote lifecycle (create draft → apply/approve discount → send → record acceptance → supersede) + optional speculative hold, gated on `s2Readiness`, advances via `progressStage("S3")`. (3) **Set up (S3)** — [setup-step.tsx](front_end/src/components/desk/workspace/setup-step.tsx): provisional folio & billing model, cancellation disclosure, advance payment (record/reconcile/payment-status/FOM credit extension), committed hold, proforma-invoice dispatch, group/corporate coordinator + milestones + FOC-GM (conditional), FOM re-entry to Quote/Inquiry, and terminal **cancel** (danger confirm modal). Gate "Review & confirm" navigates to the Confirm step. (4) **Confirm/freeze (S3→S4)** — reachable from S3 (`maxReachableOrder`), gated on the full 8-item `s3Readiness`/`confirmReadiness` checklist, freezes via `progressStage("S4")` behind the consequence modal ([confirm-modal.tsx](front_end/src/components/desk/workspace/confirm-modal.tsx), supports `tone="danger"`). After the freeze the confirmed Confirm step offers **"Continue to Arrival"** → `activatePreArrival` (W4) → S5. (5) **Arrival (S5)** — [arrival-step.tsx](front_end/src/components/desk/workspace/arrival-step.tsx): H1 handoff accept (checklist) → fulfil, room assignment (committed-hold/preferred/catalog picker), pre-arrival tasks complete/waive, advance reconcile + FOM credit-ceiling ack, guest-present attestation; gated on `s5Readiness` + guest-present, advances via `progressStage("S6", { guestPhysicallyPresent: true })`. (6) **Check-in (S6)** — [checkin-step.tsx](front_end/src/components/desk/workspace/checkin-step.tsx): guest identity verification (path + document), VIP arrival notice, room (+ L2 room-change re-entry), advance/payment status, registration + key count; gated on `s6Readiness` + registration + keys, and the **"Check in & go live"** commit (folio → LIVE, room occupied, H2/H3 created) fires `completeCheckInToS7` behind the consequence modal. (7) **Stay (S7)** — [stay-step.tsx](front_end/src/components/desk/workspace/stay-step.tsx): live folio (post charge / correction / credit note), running total, night audit (status + L2 run, reported up for the gate), H2/H3 + H4 pre-checkout (create→accept→fulfil), room deficiencies finalize, disputes (open/start review), L2 amendments + room-change re-entry; gated on `s7Readiness` + night-audit, advances via `progressStage("S8")`. (8) **Check-out (S8)** — [checkout-step.tsx](front_end/src/components/desk/workspace/checkout-step.tsx): the bill (charges/payments/balance) with the **full S7-style charge toolkit** (2026-08-03, operator request — post charge with F&B/Service/Other type select, credit note L2+, and corrections, everything dated to the checkout day since "today" can collide with the just-audited final stay night; backend `correctCharge` relaxed from S7-only to S7-or-S8 to match `postCharge`, the folio-LIVE gate still blocks everything once settled), H4 fulfil, key return, room inspection (deferral + deficiency + damage), **settlement** (method/ref/partial/FOM-ack) as the last commitment boundary via `initiateSettlement` behind the consequence modal ("take payment → folio closes, room released"), final-invoice issue/dispatch, S8→S7 re-entry for extra charges, and GM dispute closure; gated on `s8Readiness`, advances via `progressStage("S9")` ("Close & seal the stay"). **All S1–S9 steps are now native** — the deep-link "Open working tools" bridge is only used for stages with no dedicated desk step (e.g. viewing the terminal Closed step / read-only history). **Park/unpark** (SIG-S1 §3.4 / SIG-S2 §3.3, L1+, valid only at S1/S2): a header **Park** button (warm amber reason modal) / **Resume** button driven by `parkEntry`/`unparkEntry` ([lib/api/entries.ts](front_end/src/lib/api/entries.ts) → `POST /api/entries/:id/park`·`/unpark`). While `status==="PARKED"` the gate bar shows "Resume to continue" instead of any forward step (the backend state machine requires ACTIVE). Parked bookings carry a "Parked" pill on the Bookings cards and Today list, and are de-prioritised out of Today's urgency ranking + "sitting too long" count (a park is a deliberate pause, not a stuck booking). |
| Rooms | `/desk/rooms` | **Built** — floor grid + KPIs + legend, wired to `listRooms`. Status collapsed from `currentClaimState`/`physicalState`/flags via [lib/desk/rooms.ts](front_end/src/lib/desk/rooms.ts). Read-only (no room-status mutation endpoint is exposed to the desk). |
| Billing | `/desk/billing` | **Built** — folio table (state + balance) for folio-bearing bookings; reuses `deriveFinancials`/`folioView` from [lib/desk/workspace.ts](front_end/src/lib/desk/workspace.ts). Fetches per-entry detail via `useQueries`. Rows open the workspace. |
| Reports | `/desk/reports` | **Built** — KPIs (occupancy/in-house) + horizontal bars (bookings-by-step, inquiry channel mix, rooms-by-status), all `∑`-computed client-side from `listRooms`/`listEntries`/`listInquiries`. Revenue/ADR/RevPAR + occupancy forecast are explicitly flagged as not-yet-available (no backend reporting aggregation) rather than faked. |

All 5 nav pages are built. [desk-placeholder.tsx](front_end/src/components/desk/desk-placeholder.tsx) is retained for any future page added before it's implemented.

The deep-link bridge to `/entries/[id]/stages/[slug]` is **gone** (those routes were deleted). The workspace gate bar's only non-native fallback is the terminal **Closed** step, which shows a disabled "Sealed · read-only" button.

**Booking journey summary — the "S1–S4 handoff summary" (2026-07-24):** a read-only, staff-facing recap of everything the customer chose or did from Inquiry → Confirmation, shown on the **Confirm step** so the operator reviews the whole booking before the freeze. Backend-authoritative per the money/UI-agnostic rule: `GET /api/entries/:id/journey-summary` (L1+) → [booking-journey-summary-service.ts](back_end/src/services/domain/booking-journey-summary-service.ts) `buildBookingJourneySummary(prisma, entryId)` — a pure aggregation (nothing persisted, no new business outcome) sourcing every field from the records that already back each stage: Inquiry/Entry/`optionSelected` (S1) → `Quotation.commercialTerms` + `QuotationLine` (S2) → Folio/CommittedHold/CancellationDisclosure/advance-payment status (S3) → `Reservation` frozen snapshot (S4). Money is read from the DB / `getPaymentStatus` server-side (never re-summed). **Not** a `HandoffRecord` — the H1–H5 handoffs are *departmental* transfers; this is a *customer-journey* recap and shares none of that machinery. Frontend: `getJourneySummary` + `BookingJourneySummary` in [lib/api/entries.ts](front_end/src/lib/api/entries.ts), rendered by [journey-summary.tsx](front_end/src/components/desk/workspace/journey-summary.tsx) (`JourneySummaryBlock`), wired into [confirm-step.tsx](front_end/src/components/desk/workspace/confirm-step.tsx). The S4 confirmation voucher (guest-facing) reads the same underlying records.

**Segment history — the "Segments" tab (2026-07-28):** the per-pass Segment record (Implementation Reference §1.2/§6.2 — one Segment per pass through the stages; re-entry seals the current one read-only and opens the next) is now readable end-to-end. Backend-authoritative per the UI-agnostic rule: `GET /api/entries/:id/segments` (L1+) → [segment-history-service.ts](back_end/src/services/domain/segment-history-service.ts) `buildSegmentHistory(prisma, entryId)` — a pure aggregation (nothing persisted) returning one item per Segment: opened-at stage, `stagePath` (reconstructed by time-windowing StageDwellRecords into each segment's `[startedAt, sealedAt)`), open reason + mode (`ENTRY.BACKFLOW_*` trace payloads keyed by `payload.segmentNumber` — the durable source, since sealing overwrites `Segment.notes` with the seal cause), seal cause/actor (names resolved via StaffUser), and the per-segment records (Reservation via unique `segmentId`, Quotations, AmendmentEventRecords, BillingModelTransitionRecords, speculative-hold count). Money read from DB Decimals, never re-summed. Frontend: `getSegmentHistory` + `SegmentHistory` types in [lib/api/entries.ts](front_end/src/lib/api/entries.ts); [segment-history.tsx](front_end/src/components/desk/workspace/segment-history.tsx) (`SegmentHistoryPanel`) renders the stack in operator language ("Segment N", newest first, sealed segments locked). Surfaced as a top-level **Segments** view in [booking-workspace.tsx](front_end/src/components/desk/workspace/booking-workspace.tsx) — see the recall entry below for the placement.

**Cross-segment configuration recall — "reuse a prior segment" (2026-07-28):** the operator can view any sealed segment in full and reuse its room configuration as the current segment's basis. **Authority: Canon Block 10 §59 "Availability Configuration and Recall"** (`docs/dev-spec/Canon_Block10_CrossStage_Second_REV2.2.md`) — M.1 mandates "cross-stage and **cross-segment** recall without forcing full re-navigation"; M.2 is the exact desk scenario ("guest prefers Q1"). **It is deliberately NOT a copy**, per four constraints that shape the implementation:
- **M.5** "Recall is not a blind restore — it is a recall-plus-revalidate operation." The availability engine re-runs against present state on every call.
- **M.9** "The recalled configuration is not modified — a new configuration derived from the recalled one may be created." So the sealed segment's config is read-only; a **new** `AvailabilityConfiguration` is written on the *current* segment, left **unsealed** so the operator re-confirms it through the normal save-selection path.
- **M.4** "FOM decides when recalled options have changed conditions" → any material change requires **L2+** (`PolicyGateBlockedError("AUTH_REQUIRED_L2")`). An *unchanged* segment is L1-reusable.
- **M.8** the viability check must include the live DEFICIENT flag; **M.13** forbids treating recall as a rollback.

Backend: [segment-recall-service.ts](back_end/src/services/domain/segment-recall-service.ts) `recallSegmentConfiguration()` → `POST /api/entries/:id/segments/:segmentNumber/recall` (L1+), body `{ apply?: boolean, reason?: string }`. `apply:false` (default) **previews** — runs all three viability checks (availability bucket / DEFICIENT flag / indicative rate, per selected room) and returns the delta without writing. `apply:true` commits, carrying forward only rooms that survived revalidation (`droppedRooms` reports the rest; all-dropped → `RECALL_NO_VIABLE_ROOMS`). Gated to **S1–S3** — post-freeze the basis is bound to the confirmed reservation, so a re-entry must open a fresh segment first. Reuses the now-exported `runAvailabilityEngineForEntry` from [s1-availability-service.ts](back_end/src/services/domain/s1-availability-service.ts). **Evidence (M.9/M.11)** is recorded as TraceEvents — `SEGMENT.RECALL_REVALIDATED` (preview), `SEGMENT.RECALL_BLOCKED_PENDING_FOM` (L1 hit the gate), `SEGMENT.RECALL_APPLIED` (with `fomDecisionBy`/`fomDecisionLevel`) — each carrying the spec's delta shape (the same three booleans + three deltas as `RevalidationDeltaRecord`, which can't host a recall because it's FK-bound to `ProcessingLock`).

**"Copy into a new segment" — the composite action (2026-07-28):** the stakeholder-requested workflow ("copy an existing segment and create a new one based on it"). `POST /api/entries/:id/segments/:segmentNumber/duplicate` (L1+ to call; the underlying re-entry enforces its own level), body `{ toStage: "S1"|"S2"|"S3", reason }` → `duplicateSegmentIntoNew()` in [segment-recall-service.ts](back_end/src/services/domain/segment-recall-service.ts). It is **two governed operations, not a record copy**: (1) a **re-entry/backflow** — which is what actually creates the Segment, carrying its authority gate, mode-registry check, consequence engine, timer cancellations and hold/invoice effects; then (2) the **recall-plus-revalidate** above, onto the segment the re-entry just opened. Duplicating a `Segment` row directly would bypass all of (1) and is never done. Legal `toStage` per current stage (`DUPLICATE_ROUTES`, mirrored on the frontend): S2→S1 · S3→S1,S2 · S4→S1,S2,S3 · S5→S1 · S7→S2,S3 — only stages where a configuration basis is still meaningful. **Pre-flight check**: refuses before the re-entry if the source segment has no chosen configuration, since a committed re-entry can't be undone and would strand the operator in an empty segment. **Partial-outcome contract**: the re-entry commits first and is irreversible, so if the recall is then blocked (FOM gate / no viable rooms) the call still resolves with `duplicated: true, prefilled: false, recallBlocked: {...}` — the new segment is real and the basis awaits approval; the desk toasts a warning rather than implying failure. Frontend: `duplicateSegment` + `DUPLICATE_ROUTES` in [lib/api/entries.ts](front_end/src/lib/api/entries.ts); each segment card carries **"Copy into a new segment"** (target-stage picker + required reason). This is now the **only** recall affordance on the desk — the within-segment "Reuse in this segment" button was removed 2026-07-31 (operator request); see the note under the recall section below.

**Per-segment drill-in:** each card expands (chevron) into a step-by-step view of the nine journey steps — reached steps numbered in green, unreached dimmed — populated from that segment's own records. `availabilityConfigs` was added to the segment-history payload for this (the S1 search + room selection, resolved to room numbers, flagged when it came from a recall). **Honest limit surfaced in the S3 row**: `Folio`, `CommittedHold` and `CancellationDisclosureRecord` are all `entryId @unique` singletons that persist/mutate across every segment by design, so they cannot be shown "as they were" in an earlier segment — the UI says so rather than implying otherwise. Genuinely segment-scoped: AvailabilityConfiguration, Quotation, SpeculativeHold, Reservation, AmendmentEventRecord, BillingModelTransitionRecord.

**Defect fixed alongside:** `s1AvailabilityService.recallConfiguration` (the pre-existing stale-config path, `POST /availability/configurations/:id/recall`) **rewrites the configuration in place** and was scoped to nothing but `isStale` — pointing it at an earlier segment's config would have mutated sealed commercial history (the exact pattern the segment model prevents). It now rejects any config whose `segmentId` isn't the current segment, directing callers to the recall route above.

**Segments moved from the workspace side column to a top-level view** — a header chip ("Segments · N") toggles [segment-history.tsx](front_end/src/components/desk/workspace/segment-history.tsx) `SegmentHistoryPanel` into the full canvas (it no longer appears as a third side tab).

**The desk's within-segment "reuse" UI was removed 2026-07-31** (operator request): the "Reuse this segment as the basis" button and its recall-preview modal (per-check changed/unchanged, material-change list, dropped rooms, the FOM wall) are gone from `segment-history.tsx`. **The backend is untouched** — `POST /api/entries/:id/segments/:segmentNumber/recall` still exists and is still exercised on every copy-into-new-segment, since `duplicateSegmentIntoNew` performs the recall-plus-revalidate server-side as its second step. What changed is only that the desk no longer offers recall *onto the current segment* as a standalone action. Consequence: `recallSegment` + `SegmentRecallOutcome`/`RecallViabilityDelta` in [lib/api/entries.ts](front_end/src/lib/api/entries.ts) are now **unreferenced client-side** — kept deliberately so the production frontend (and a future desk affordance) can call the endpoint without re-deriving the types. Don't delete them as dead code.

**Confirmation-voucher receipt panel on the Confirm step (2026-07-24, frontend-only):** the voucher is already generated + dispatched + rendered-to-PDF + emailed by `confirmReservation` at S4 (see the **PDF bill generation** + **Email** sections). [confirmation-voucher.tsx](front_end/src/components/desk/workspace/confirmation-voucher.tsx) (`ConfirmationVoucherBlock`) just **surfaces** those four facts on the desk once the reservation is confirmed, reading only existing endpoints — reservation scalars (`confirmationVoucher*` PDF fields, added to the `ReservationSummary` type), the timers feed (`ACKNOWLEDGEMENT_WINDOW_W22`), and the trace feed (`RESERVATION_CONFIRMATION_EMAIL.SENT|SKIPPED|ERROR`) — plus a **View voucher PDF** button on the existing `GET /api/reservations/:id/confirmation-voucher-pdf` route. No backend change. [confirm-step.tsx](front_end/src/components/desk/workspace/confirm-step.tsx) now branches on `entry.reservation?.confirmedAt`: pre-freeze shows the freeze gates; post-freeze shows the journey recap + this receipt (and [booking-workspace.tsx](front_end/src/components/desk/workspace/booking-workspace.tsx) routes the confirmed-S4 view to `ConfirmStep` instead of the generic `StepCanvas`).

**"Handoff to front desk" section on confirmed S4 (2026-08-02, operator request):** the front-desk prep subset of the pre-arrival tasks — payment reconciliation, special-request fulfilment, late-arrival meal coordination, site visit — rendered at the BOTTOM of the confirmed S4 view with the same Complete/Waive affordances as the Arrival step (`HANDOFF_TASKS` in confirm-step.tsx, `patchPreArrivalTask`). Enabled backend-side: `confirmReservation` now seeds the full pre-arrival task set at confirmation (best-effort call to `initialiseTasks`, idempotent via `@@unique(entryId, taskType)` — the S4→S5 activation's lazy init simply finds them present), so tasks exist from S4 onward instead of only after arrival activation. Same rows as the Arrival step's task list — completing in either place writes the same record; `updatePreArrivalTask` has no stage gate, so no relaxation was needed.

**Special-preference section, editable on every stage (2026-07-24):** a pinned strip in the workspace's non-scrolling top bar ([special-preference.tsx](front_end/src/components/desk/workspace/special-preference.tsx), rendered by [booking-workspace.tsx](front_end/src/components/desk/workspace/booking-workspace.tsx)) shows the guest's special preference on S1…S9 and lets the operator add/edit it **in place** (shows the saved value so it's never duplicated). Reuses `Inquiry.notes` — the intake note field. New **stage-agnostic** save path (the only intake-note edit was S1-gated): `PATCH /api/inquiries/:id/notes` (L1+) → `s1InquiryService.updateInquiryNotes` (mirrors `captureCorporateContext`; empty string clears to null; audits `INQUIRY.SPECIAL_PREFERENCE_UPDATED`). Frontend client `updateInquiryNotes` in [lib/api/inquiries.ts](front_end/src/lib/api/inquiries.ts); `EntryDetail.inquiry` gained `notes` in [types/api.ts](front_end/src/types/api.ts). Also parking is now an exit-time dialog rather than a header button (`handleExit` on the "Bookings" back button), and the desk journey rail shows stage numbers (not ticks) for completed steps.

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
- `CorporateAccount` — same shape + gstNumber + billingAddress + **`contractRefs String[]` + `coordinators Json?`** (migration `20260721120000`, spec-aligned with `CorporateProfile.contractRefs`/`coordinators`, DEV-SPEC-001-Part2 §2.6.2). These are the corporate commercial context (SIG-S1 §100.6 / Policy 17); the desk intake **inherits** them when an account is picked (first contractRef + first coordinator name pre-fill `Inquiry.corporateClientRef`/`corporateCoordinator` via `captureCorporateContext`), falling back to free-text for accounts with none. Editable on `/admin/corporate-accounts`; carried on the L1 lookup (`GET /api/lookups/corporate-accounts/search`) so the desk can read them.
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
| 3 | S3 → S2 | `s3-reentry-state-machine.initiateS3ToS2Backflow` | (existing) | L2+ | (pre-registry) — **releases the committed hold since 2026-08-02** (operator ruling; was HOLD_RETAINED): a new segment places its own commitments, so the sealed segment's hold is released (all pinned rooms → FREE, timers cancelled) same as S3→S1. `releaseOnReEntry` now takes a `reason` param, no-ops (returns null) when no hold exists, and releases **CONFIRMED** holds as well as PLACED — S4 upgrades the hold to CONFIRMED, so the S4→S1/S5→S1 backflow hooks (which call it) were silently no-oping and leaving rooms pinned into the new segment. S4→S2 and S4→S3 still declare HOLD_RETAINED per spec (post-confirmation, same rooms/dates) — an open question if the release-everywhere ruling should extend to them. |
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

### Room availability is decided by DATES, never by `currentClaimState` (2026-07-29)

`Room.currentClaimState` is a **NOW snapshot with no date dimension**. It is display/ops state — it must never be used to answer "can this room be booked?", because that question is always about a date range.

The S1 availability engine has worked this way since 2026-07-24 (non-FREE rooms stay in the candidate pool; per-date overlap decides). Policy 26 had not, so `placeCommittedHold` rejected rooms S1 legitimately offered. Three reachable failures: a second forward booking on a room that already held one for other dates; any future booking on a room occupied tonight; and an operator retrying their own hold (attempt 1 pinned the room `COMMITTED_HELD`, attempt 2 failed the FREE check against itself).

**Helper**: [`lib/room-booking-conflicts.ts`](back_end/src/lib/room-booking-conflicts.ts) — `findRoomBookingConflicts(db, { roomIds, checkIn, checkOut, excludeEntryId })` returns overlapping reservations + committed holds with guest/booking context. `endDate` is the **exclusive** checkout, so back-to-back turnover is not a conflict.

**Policy 26** ([p26-committed-hold-inventory-availability.ts](back_end/src/policies/11-committed-hold/p26-committed-hold-inventory-availability.ts)) now splits authority:
- `enforceNoOverlappingBookingForCommittedHold` — commercial (is someone else booked on these dates?)
- `enforceCommittedHoldRoomPhysicallyUsable` — physical (blocked / maintenance deadline inside the stay)
- `enforceCommittedHoldInventoryAvailable` — **deprecated**, retained only for entries with no stay dates

The overlap predicates deliberately **mirror the sibling query in `s1-availability-service.ts`** (reservations by frozen dates; holds by entry dates + PLACED/CONFIRMED + unexpired; both excluding self). Keep the two in step — if S1 offers a room, S3 must accept it. Divergence reintroduces this bug.

Housekeeping readiness (`DEPARTED_DIRTY`) is deliberately **not** a booking gate — same-day turnover is normal. It stays enforced at check-in by the SIG-S6 per-room physical-ready check.

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

### Per-room composition track (S2–S9) — merged from `integration-prod-frontend` 2026-07-27

The production-frontend developer's per-room quote model (mirrors the hotel's legacy PMS grid: rows per room, meal-plan pax distribution, negotiated per-room rates, SC/GST/FOC toggles). `RoomAssignment` carries the composition columns (occupant/adult counts, CNB age-band counts under-6/6–10/11+, `mealPlan*Count` distribution, à-la-carte pax, `negotiated*Rate`, `serviceChargeApplies`/`gstApplies`/`isFoc`, `frozenSubtotal`/`frozenTotal`); `Reservation.frozenCommercialTerms` snapshots the terms at S4. Pricing lives in [lib/room-composition.ts](back_end/src/lib/room-composition.ts) (`computeRoomComposition`, `computeQuotationCompositionTotals`); hydration into RoomAssignment rows via [lib/hydrate-room-assignment-composition.ts](back_end/src/lib/hydrate-room-assignment-composition.ts). Policies: p78 (extra bed required for CNB 11+), p79 (composition counts consistent), both under `policies/34-room-composition/`. `createQuotation` accepts `roomCompositions[]` — when supplied, `totalAmount` is the composition **stay-total** (tax-inclusive); when absent the legacy per-night flat model runs (booking-wide `mealPlan`/`extraBedCount` still supported). Night audit posts one ROOM_CHARGE per active assignment (per-room `frozenSubtotal`/nights, falling back to `reservation.frozenRate`); quotation/voucher/invoice PDFs render per-room lines. Frontend: `RoomCompositionPlanner` ([room-compositions-board.tsx](front_end/src/components/desk/workspace/room-compositions-board.tsx)) on the S2 quote step, with two modes (only the active one mounted — both auto-emit, so co-mounting would race the parent's state; the planner keeps the last emitted snapshot in a ref and seeds it into whichever mode mounts next as `initial`, so switching **carries state across**: board→table is lossless tallies, table→board deterministically re-seats chips to match the counts and flags overflow beyond the intake party): **Table** (default) — `RoomCompositionsTable` ([room-compositions-table.tsx](front_end/src/components/desk/workspace/room-compositions-table.tsx)), a spreadsheet grid, one row per sealed room with grouped column headers; Occ is DERIVED from adult/6–10/<6 cells (Policy-79 rule 1 untypeable), arrow-key/Enter cell navigation (text+numeric inputs, not `type=number`, so arrows navigate instead of spinning), bulk fills ("Distribute party", "Everyone on <plan>" = each row's pax to its occupancy, "Copy row 1 ↓" clones meals/beds/toggles/rates but never guest bands), Σ footer reconciling vs the intake party, sticky room column, collapsed rates/Others column groups, and **adaptive columns** — CNB columns appear when the intake party has children **or** when saved data already carries child counts (the manual "Kids +" corner override was removed 2026-07-31 on operator request; only "Rates +" remains in the corner), meal-plan columns per plan-chip toggle / "Everyone on…" (hiding a plan zeroes it so nothing invisible feeds the draft). **Guest board** — `RoomCompositionsBoard` (same file as the planner): one chip per guest, tap/drag into room bins, bulk meal-plan bar on selection; toggle hidden when the entry has no party breakdown. The pre-2026-07-28 per-room-cards `RoomCompositionsEditor` ([room-compositions-editor.tsx](front_end/src/components/desk/workspace/room-compositions-editor.tsx)) is retired from the planner (file kept, unreferenced). `RoomCompositionSummary` on the stay step.

**Per-date meal plans (2026-07-28).** A guest wanting AP on arrival night and CP after had nowhere to live: `mealPlan*Count` sits on `RoomAssignment` and applied to the whole stay (`perNightMeals × nights`). Now modelled as **room default + per-night exceptions**:

- **`RoomNightMealPlan`** (migration `20260728111408_room_night_meal_plans`) — one row per (assignment, night) that DIFFERS from the room's stay-wide distribution. Absent night = room default, so **no backfill and no price change for any existing booking** (verified: parity test asserts an override-free composition prices to the same cent). A table, not a JSON column, because the kitchen's question is "how many breakfasts on the 15th?" — a query across rooms on `date`. Cascades from its assignment.
- **Pricing** ([room-composition.ts](back_end/src/lib/room-composition.ts)): room + extra bed still multiply by nights; **meals now sum night by night**, each night taking its override if present. An override **replaces** that night's whole distribution rather than adding to it. New return fields `mealsSubtotal` + `perNightMealBreakdown` (`{date, meals, overridden}`); `perNightMeals` still means the room's *usual* night, so existing display code is unchanged. Overrides are ignored when `startDate` is null — without it there's no way to place a night, so guessing would be worse than skipping.
- **Guards** ([p79](back_end/src/policies/34-room-composition/p79-composition-counts-consistent.ts)): each overridden night must satisfy the occupancy ceiling **on its own** (a 2-guest room can't get 3 AP covers on the 14th), and `enforceNightOverridesWithinStay` rejects a date outside the stay — checkout day is *not* a stay-night — or two plans for the same night (which would make pricing depend on array order). The desk limits the picker to the booked nights; the backend re-checks because a plan pinned outside the stay would silently never price.
- **Carried through** `createQuotation` → `commercialTerms.roomCompositions[].nightMealOverrides` → `hydrateRoomAssignmentComposition` nested-creates the child rows, so the durable record matches what was priced.

**Guest-board UI for it:** the plan bar gained a date-scope strip — **Whole stay** (default) or one chip per booked night; the plan buttons and each chip's dropdown write at whatever scope is selected, and setting a night back to the room default clears the exception rather than storing a redundant one. A standing "Nights that differ" strip shows exceptions when nothing is selected. The **table has no column for these** and would have dropped them on a mode switch, so it carries the seed's `nightMealOverrides` through untouched; the board re-derives them from chip placement (same deterministic seating as the stay-wide plans) on its next emit.

**Room focus (2026-07-28):** the guest board no longer always shows every sealed room. Clicking a **room number in the table** opens that room alone in the board (the room cell only — a row-level handler would fight the grid's cell editing), and the board carries an **All rooms / per-room tab strip**. `focusRoomId` lives on `RoomCompositionPlanner` so it survives mode switches. **Display-only** — every sealed room still holds its guests, still emits, still prices; filtering the emission would silently drop rooms from the quotation.

**Rate reference under the composition editors (2026-08-01):** the negotiated-rate cells needed an anchor — what would the room cost *without* a negotiation? New backend-authoritative lookup `GET /api/entries/:id/rate-reference` (L1+) → [rate-reference-service.ts](back_end/src/services/domain/rate-reference-service.ts) `buildEntryRateReference(prisma, entryId)`: per sealed room **type** (grouped, room numbers listed), the room rate the draft will default to (agent/corporate card via `resolveAgentRate` incl. per-type override, else `resolveRatePlanPricingForS2Quotation`), the card's extra-bed/breakfast/lunch/dinner add-on rates (null when no card — the Track-B house-price-list gap, shown as dashes), the standard rate + MSR floor as negotiation bounds (MSR null on card rates — negotiated, not MSR-bound, same as the quote pipeline), and config GST/SC rates. Pure read; mirrors `prepareQuotationDraft`'s defaults exactly. Frontend: `getRateReference` + `EntryRateReference` in [lib/api/entries.ts](front_end/src/lib/api/entries.ts); [rate-reference-strip.tsx](front_end/src/components/desk/workspace/rate-reference-strip.tsx) renders below **both** planner modes (planner takes an `entryId` prop). Display-only; this is not the live-pricing preview endpoint (open item 3 below — still pending).

**Inline quotation document view — no PDF needed (2026-08-01):** `GET /api/quotations/:id/preview-html` (L1+, [documents router](back_end/src/routes/documents/router.ts)) returns the A1 house-format quotation as HTML, composed **fresh from the quotation's current `commercialTerms`** with zero side effects — no PDF render, no storage write, no QuotationLine snapshot, no trace (`Cache-Control: no-store`). Enabled by factoring the document composition out of [quotation-pdf-service.ts](back_end/src/services/domain/quotation-pdf-service.ts) into `buildQuotationDocRender` — the stored-PDF path (`generateOrLoadQuotationPdf`) and the preview (`renderQuotationPreviewHtml`) run the same composition, so they can never disagree. Composition upgraded alongside (both paths): line descriptions now lead with the **room-type name** and always state the **meal plan** — per-room plan tallies ("2 CP · 1 MAP+L") or an explicit "EP (room only)" instead of a blank, matching the docs/bills A1 specimen ("Deluxe · 1 room · 2 adults · MAP"). **Discount display (2026-08-02, operator ruling):** the document table prints the **ORIGINAL (pre-discount) prices** and shows the discount as an explicit deduction row ("Discount N% · − amount") above Net value; Net/SC/GST/Total stay the discounted figures. Enabled by a second pricing run at quote time: `prepareQuotationDraft` stores `commercialTerms.compositionTotalsPreDiscount` (slim: totals + per-room totals, costed with `defaultRoomRate = resolvedNightlyRate`) whenever the discount moved the rate — per-room `negotiatedRoomRate`s price identically in both runs (negotiated ≠ discounted). The flat path recomputes its original per-night amount directly from `resolvedNightlyRate` at render. Applies only when `resolvedNightlyRate > effectiveRate` (agent/corporate card rates never show it); legacy discounted quotes without the stored snapshot fall back to discounted rows + a "pre → post / room / night" disclosure note. Desk: `fetchQuotationPreviewHtml` in [lib/api/documents.ts](front_end/src/lib/api/documents.ts) (auth-header fetch, HTML text); [quotation-preview.tsx](front_end/src/components/desk/workspace/quotation-preview.tsx) renders it in a sandboxed `srcDoc` iframe (`allow-same-origin` only — no scripts; self-sizing via onLoad measure); each Quote-history row on [quote-step.tsx](front_end/src/components/desk/workspace/quote-step.tsx) has a **View/Hide** toggle (one open at a time), and every quote mutation invalidates `["quotation-preview"]` so the open preview tracks discounts/supersedes live.

**"Why this price" — pricing-pipeline trail on the quote step (2026-08-02, frontend-only):** each Quote-history row carries a **"Why this price"** toggle rendering [price-resolution.tsx](front_end/src/components/desk/workspace/price-resolution.tsx) (`PriceResolutionPanel`) — a display-only translation of the pricing pipeline's stored result on that version's immutable `commercialTerms`: the `resolutionPath` steps (plan priority / deterrent uplift / group band / discount / MSR check) in operator language, plan rate → effective rate, MSR floor + below-MSR warn, and the agent/corporate card override with the `standardPricing` reference ("the standard plan would have charged…"). Nothing is recomputed (no-money-math rule); fields render defensively since older quotes lack the trail. The live-preview variant (pricing while editing compositions, open item 3) would reuse this panel fed by the future non-persisting preview endpoint.

**Per-booking advance requirement + proforma inline preview (2026-08-01):** migration `20260801120000_advance_requirement_and_credit_expiry` added `Folio.advanceRequiredAmount` / `advanceRequiredBasis` and `CreditExtensionCeilingRecord.expiresAt`. (1) **Advance requirement**: `POST /api/entries/:id/advance-requirement` (L1+, body `{mode:"AMOUNT",amount} | {mode:"PERCENT",percent} | {mode:"CLEAR"}`) → `setAdvanceRequirement` in [s3-payment-service.ts](back_end/src/services/domain/s3-payment-service.ts). PERCENT resolves against the **operative quotation's** `totalAmount` at set time (Decimal `pctOf`+`round2`; re-set after a renegotiation to track the new total; errors when no live quote). The stored amount **overrides** the `advancePayment.thresholds` config AND the group boost in `computeAdvancePaymentEvaluation`; payment-status now carries `requirementSource: "OPERATOR"|"CONFIG"` + `requirementBasis`. Traces `ADVANCE_PAYMENT.REQUIREMENT_SET/_CLEARED`. **Changed requirement re-issues the proforma (Class-1 supersession):** when the change (incl. CLEAR) alters the resolved amount AND a live proforma is FROZEN (PDF rendered and/or dispatched), it is marked SUPERSEDED with `supersededById` → a fresh DRAFT (new INV number, `versionNumber`+1, metadata `basis: "ADVANCE_REQUIREMENT_CHANGED"`); the route returns `reissuedProforma` and the desk toasts "dispatch it again" (payment re-locks via the bill-before-money guard until it goes out). **Since 2026-08-02 the re-issue is unconditional on change** (operator ruling; previously a never-rendered DRAFT was kept and recomposed): every requirement change supersedes ALL live proformas — dispatched issues AND unsent drafts — and mints a fresh DRAFT, so "Set requirement" always produces a new proforma. Setting the same amount again still never re-issues — **unless no live proforma exists at all (also 2026-08-02)**: a re-entry supersedes every pending proforma (`supersedePendingInvoicesTx`) and the folio singleton survives into the new segment, so `ensureProvisionalFolio…` never mints a starter again; without a fresh issue, S3 dead-ended (nothing to dispatch → bill-before-money locks payments). `setAdvanceRequirement` now mints a fresh DRAFT (metadata `basis: "REISSUED_AFTER_REENTRY"`, empty `supersedes`) whenever zero non-superseded proformas exist, even if the figure is unchanged (the folio remembers the old segment's requirement); the desk toast distinguishes "superseded → dispatch again" from "fresh proforma generated for this segment". The quotation path has no such dead-end — quotes are per-segment rows and the S2-exit gate (`resolveOperativeQuotation`, segment-scoped) forces a fresh one in the new segment. **The pin itself is also segment-scoped (2026-08-02 operator ruling)**: `resolveOperatorAdvanceRequirement(folio, currentSegmentStartedAt)` (exported from s3-payment-service) returns null when `basis.setAt` predates the current segment's `startedAt` — a prior segment's pin does NOT carry across a re-entry; each segment starts from the configured `advancePayment.thresholds` until the desk pins afresh. Shared by the payment evaluation, `setAdvanceRequirement`'s change detection (so re-pinning the same figure after re-entry registers as a change), and `buildProformaDocRender` (so the new segment's proforma prints the default, not the old figure). The stale folio columns are left in place — scoped out at read time, no migration. Desk proforma rows carry **"Current · vN"** (green) / **"Old · vN"** chips. **Old rows are viewable inline too** — their View embeds the **stored PDF** (blob object-URL in the same portrait frame; `FrozenPdfFrame` in [quotation-preview.tsx](front_end/src/components/desk/workspace/quotation-preview.tsx), `frozenPdf` prop on `ProformaPreview`/`QuotationPreview`) because a recomposition would print today's figures under yesterday's number; an old row with no stored artifact is **also viewable since 2026-08-02** — it recomposes with an amber caveat strip ("never rendered or sent — reconstruction using current figures", `notice` prop on `ProformaPreview`/`DocumentPreviewFrame`) so it can't be mistaken for what went out. **Freeze-at-supersession (2026-08-02, operator ruling — old versions must RETAIN their figures, not recompose later data):** every path that supersedes a proforma renders the never-rendered ones to PDF FIRST (`freezeUnrenderedProformasForEntry` in [invoice-pdf-service.ts](back_end/src/services/domain/invoice-pdf-service.ts); best-effort, write-once) — wired pre-change in `setAdvanceRequirement` (dynamic import — invoice-pdf-service statically imports s3-payment-service, so a static import back would cycle) and pre-tx in the S3→S1 re-entry + S4→S1/S5→S1 backflows. Quotations get the same: `supersedeQuotationWithNewDraft` and the S4→S2 backflow (which supersedes the ACCEPTED quote) freeze a PDF-less prior via `generateOrLoadQuotationPdf` first — a quotation's own terms are immutable, but its composition reads live context (entry dates, current tax config on the flat path). The caveat reconstruction remains only as the fallback for render failures and pre-fix legacy rows (whose point-in-time data is unrecoverable). Superseded/expired **quotations** with a stored PDF get the same frozen inline view; without one they recompose safely (each quotation row's `commercialTerms` are immutable per version). `pdfStorageKey` added to `QuotationSummary`/`InvoiceSummary` types (already in the payloads). (2) **Credit-extension timer**: `validForHours` on the credit-extension body → `expiresAt`; enforcement is **read-time** in the evaluation (expired extension stops satisfying the condition — no worker), surfaced as `creditExtensionExpiresAt`/`creditExtensionExpired`. (2b) **Bill before money (2026-08-01 operator ruling)**: an S3 advance payment cannot be recorded until a proforma has been **DISPATCHED** — `enforceProformaDispatchedBeforeAdvancePayment` ([p27](back_end/src/policies/12-advance-payment/p27-advance-payment-reconciliation.ts), error `PROFORMA_NOT_DISPATCHED_FOR_ADVANCE`) wired into `s3-folio-service.recordPayment`; the desk's "Log payment received" form stays locked with a hint until dispatch. Complements p40's after-the-fact freeze gate (`enforceProformaDispatchedWhenAdvancePaid`) by enforcing the ORDER up front. **(2b-b) Answer before money (2026-08-03 operator ruling):** once the proforma HAS been dispatched, the guest's reply must be RECORDED (p52 capture) before an advance can be logged — `enforceProformaGuestAnswerRecordedBeforeAdvancePayment` (same p27 file, error `PROFORMA_GUEST_ANSWER_REQUIRED_FOR_ADVANCE`), keyed on the current segment's latest dispatched proforma communication (segment-windowed like the p40 gate). The desk's payment form stays locked with a "note down the guest's response first" hint (and a toast if the locked area is clicked) until the reply block above it captures the answer. **(2b-ii) Payment window with deadline (2026-08-01)**: the advance is due BETWEEN proforma dispatch and the check-in date — payment-status now carries `advanceWindow: { opensAt, deadline, active, overdue }` (opensAt = latest live proforma's `dispatchedAt`, deadline = `Entry.checkInDate`; `active` only while unsatisfied and pre-deadline). Read-time facts, **no worker** (same precedent as the credit-extension expiry — the S5/S6 arrival gates are the enforcement teeth); the desk's "Money received" block renders a ticking `countdownTo` chip + overdue state, and the journey summary's S3 card shows the window. (3) **Proforma reflects the advance** (A2 reference — "the hero is the advance"): [invoice-pdf-service.ts](back_end/src/services/domain/invoice-pdf-service.ts) PROFORMA composition factored into `buildProformaDocRender` (shared by PDF + preview); prints "Advance received", "Advance due now" = requirement − received (operator requirement → config evaluation → full-balance fallback, with a "(N% of quote)" qualifier), and "Balance at checkout". `GET /api/invoices/:id/preview-html` (L1+, proforma only, no side effects) mirrors the quotation preview. **Defect fixed alongside (2026-08-01):** the invoice loader filtered quotations to `state: "ACCEPTED"` — under the generate-vs-send rule a quote is often never accepted, so `terms` came back null and the proforma printed 0.00 in every money row (and "1 night" regardless of stay). `invoicePrelude` now resolves the **operative** quotation (`resolveOperativeQuotation`, current segment → newest ACCEPTED → newest), nights fall back to the real date span, the rate line follows the A2 shape ("Suite · 3 rooms · 6 adults · EP (room only) · per night"), "To" is the agent/corporate when one books (guest stays on "For guest"), and the Net/Service/GST decomposition falls back to the stay-charge engine instead of 0.00. Applies to the FINAL branch's prelude too. (4) **Desk** ([setup-step.tsx](front_end/src/components/desk/workspace/setup-step.tsx)) — S3 money flow is now three blocks in working order (operator ruling): **"What the guest must pay"** (status fact + requirement setter, flat Nu / % of quote — conversion is server-side, no money math) → **Proforma invoice** (prints those figures; rows have View/Hide inline preview via `ProformaPreview` in [quotation-preview.tsx](front_end/src/components/desk/workspace/quotation-preview.tsx), generalised `DocumentPreviewFrame`) → **"Money received from the guest"** ("Record payment" renamed **"Log payment received"**, reconcile, and the FOM credit extension with "Valid for (hours)" + expiry display). **S3 checklist honesty + hard review gate (2026-08-01):** `s3Readiness` no longer shows vacuously-green lines — "Proforma sent to guest" appears only once money was actually received, and "Advance settled or credit extended" only when the requirement is > 0 (or money came in / status unknown); opts gained `requiredAmount` (fed from payment-status). "Proforma invoice on folio" reads "Proforma invoice generated" (generating is the mandate; sending is optional). The **Confirm review is unreachable until the checklist is fully green**: `maxReach` caps at 3 while S3-and-not-ready (rail node 4 stays a locked future step) and "Review & confirm" is disabled/locked until then.

**Quote/proforma desk language + cross-segment history (2026-08-01, frontend-only):** (1) "Draft" is no longer desk vocabulary — a created quotation shows **"Ready to send"** ([quote-step.tsx](front_end/src/components/desk/workspace/quote-step.tsx) `STATE_TAG`; button is "Create quote"), and a proforma shows "Ready to send"/"Dispatched" ([setup-step.tsx](front_end/src/components/desk/workspace/setup-step.tsx) `invoiceStateLabel`). Backend states (`DRAFT` etc.) are untouched. (2) After a re-entry opens a new segment, the **Quote history shows every segment's quotations** (previously filtered to the current segment): rows carry a "Segment N · current" (green) or "Segment N" (muted, 0.75 opacity) chip whenever quotes span segments, sorted current-segment-first; prior-segment rows are reference-only by construction (the action blocks still bind to the current-segment `quotations` filter — only View/PDF work on old rows). Same for the **proforma list** on the setup step — `Invoice` has no `segmentId`, so each proforma is attributed to the segment whose `[startedAt, sealedAt)` window contains its `createdAt` (the segment-history service's time-windowing, client-side); rows show the full readable INV id + `vN` when >1. `SegmentSummary` gained `startedAt`, `InvoiceSummary` gained `invoiceNumber`/`versionNumber`/`supersededById` in [types/api.ts](front_end/src/types/api.ts) (fields were already in the payload — the include returns full rows).

**Legacy booking-level meal plan UI removed from the desk (2026-08-01):** the collapsed "Legacy booking-level meal plan" `<details>` on the quote step (booking-wide `mealPlan`/`extraBedCount`) was unreachable in practice — the composition planner always emits one row per sealed room, so `roomCompositions` is never empty and the backend's booking-wide fallback never ran from the desk. UI + state + payload fields removed from [quote-step.tsx](front_end/src/components/desk/workspace/quote-step.tsx). **The backend flat path is untouched** (`QuotationDraftInput.mealPlan`/`extraBedCount` remain — UI-agnostic API compat for the production frontend and API callers), as are the optional fields on the frontend `createQuotation` client.

**Open items agreed 2026-07-27 (user + production-frontend dev):**
1. **Split billing is orphaned on this branch.** The friend force-pushed it out of `integration-prod-frontend` (his withdrawal accepted); we still carry the full feature (code, 2 applied migrations, backfilled `FolioLine.billingModel` data) from the earlier merge. Its per-line PATCH endpoint is also still blocked by the db.ts `FOLIO_LINE_IMMUTABLE` guard. Nothing consumes it operationally — leave as-is until a deliberate keep-or-remove decision; don't build on it.
2. **Composition meal pricing applies no child discount** — flat pax × meal rate; a 6–10 child in `mealPlanCpCount` pays full rate. Accepted for now: the friend is revising and will send changes. The age-band counts are already on the row, and the correct helper (`computeGroupMealCharge`, registry-driven 0/70/100%) exists — the booking-wide (non-composition) path already uses it, so the two paths currently disagree on child meals.
3. **No live pricing while editing compositions** — the editor is input-capture only; money appears after "Create draft quote" (backend prices during creation). A non-persisting preview endpoint (`POST /entries/:id/quotation-preview` running the same composition pricing) is the agreed future fix — required before the UI can show legacy-grid-style live per-row totals, since money math in the frontend is forbidden.

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

### Policy 26 is date-aware — committed hold no longer reads the room's "now" flag (2026-07-29)

**Symptom:** every committed hold at S3 failed with `INVENTORY_NOT_AVAILABLE` — "Room is not available for committed hold". Present on **main** as well (`p26-*.ts` and `s3-hold-service.ts` were byte-identical across branches); only the availability engine's per-date work was branch-local.

**Cause — two components disagreeing about "available".** `Room.currentClaimState` is a single global flag describing the room *right now*. The availability engine says so in its own comment ([availability-engine.ts](back_end/src/engines/availability-engine.ts) §"Model 1 claim state"): *"a non-FREE claim state means the room has an active commercial claim TODAY — but the claim ends at some point, and the room becomes bookable again for future dates. `currentClaimState` is a snapshot, not a per-date view."* The engine was made date-aware on 2026-07-24; **Policy 26 was not**. So S1 correctly offered rooms for a future stay, the operator sealed them, and S3 refused because some *other* booking's claim sat on the flag. `currentClaimState` goes CONFIRMED at S4 and stays there until departure, so on a database with a normal forward book every room reads non-FREE and **no committed hold could ever be placed**.

**Not a stale-data problem.** Initial reading of the newest assignment per room suggested abandoned claims; checking *all* referencing entries showed every pinned room belonged to a live ACTIVE/S4–S5 booking. A release-stale-claims sweep found **0** rooms to free. The guard was the whole fault.

**Fix.** [room-booking-conflicts.ts](back_end/src/lib/room-booking-conflicts.ts) `findRoomBookingConflicts(db, {roomIds, checkIn, checkOut, excludeEntryId})` is now the single definition of "is this room taken on these dates", mirroring the S1 blockage query exactly — overlapping `Reservation` (via its entry's room assignments) + live `CommittedHold` in PLACED/CONFIRMED, half-open `[checkIn, checkOut)` so back-to-back stays don't collide, self excluded. `enforceNoOverlappingBookingForCommittedHold` ([p26](back_end/src/policies/11-committed-hold/p26-committed-hold-inventory-availability.ts)) consumes it and names the blocking entry + its dates in the error. `placeCommittedHold` guards **every** sealed room through it.

The date-blind `enforceCommittedHoldInventoryAvailable` is **not** dead: `placeCommittedHold` still calls it on the degenerate branch where the entry carries no `checkInDate`/`checkOutDate` ([s3-hold-service.ts](back_end/src/services/domain/s3-hold-service.ts) — with no dates there is nothing to intersect, so the NOW snapshot is the only signal available). Don't call it from any path that *does* have dates.

> **Note (2026-07-29 merge):** this section and **"Room availability is decided by DATES, never by `currentClaimState`"** above describe the **same fix**, written independently on `UI-experiment2` and `integration-prod-frontend`. Both branches had also written the conflict helper separately — the merge kept `room-booking-conflicts.ts` and deleted the other branch's `room-date-conflicts.ts` / `findRoomDateConflicts`, which no longer exist. The section above is the API reference; this one keeps the diagnostic narrative. Prefer merging them the next time this area is touched.

**Not a loosening.** Verified on live data: exact-overlap, overlapping-start, overlapping-end and fully-containing ranges all still block; back-to-back (new stay starts on the previous checkout day) and a far-future range pass; an entry never blocks itself. On the reported entry all 6 sealed rooms went BLOCK→PASS, and those rooms carry 807 real bookings over two years — none overlapping the requested 29 Jul → 2 Aug.

**Because both sides now call the same helper, search and hold cannot drift apart again** — that drift was the bug.

### Guest acceptance on every governed communication + generate-vs-send gates (2026-07-28)

**The rule (operator ruling, overrides SIG-S2 §1.4.1):** **generating** a quotation or proforma is mandatory to move a booking forward; **sending** it is not. Acceptance is *evidence of what the guest said*, so it stays recordable only against something actually dispatched — which is precisely why it can no longer be the gate.

**Acceptance capture, generalised.** All four guest-facing artifacts already opened a W22 acknowledgement window on dispatch (`CommunicationRecord.acknowledgementStatus`), but only the S2 quotation had any way to *close* it — everything else could only time out. [communication-acknowledgement-service.ts](back_end/src/services/domain/communication-acknowledgement-service.ts) generalises `acceptQuotation`'s shape:

| Stage | Artifact | `commType` | Trace on capture |
|---|---|---|---|
| S2 | Quotation | `QUOTATION` | `QUOTATION.ACKNOWLEDGEMENT_RECORDED` (the older `acceptQuotation` path also still exists) |
| S3 | Proforma invoice | `PROFORMA_INVOICE` | `PROFORMA_INVOICE.ACKNOWLEDGEMENT_RECORDED` |
| S4 | Confirmation voucher | `CONFIRMATION_VOUCHER` | `CONFIRMATION_VOUCHER.ACKNOWLEDGEMENT_RECORDED` |
| S5 | Pre-arrival reminder | `PRE_ARRIVAL_REMINDER` | `PRE_ARRIVAL_REMINDER.ACKNOWLEDGEMENT_RECORDED` |

- `POST /api/communications/:id/acknowledge` (L1+), body `{ method: "WRITTEN"|"VERBAL", verbatimNote?, receivedAt? }` — sets `RECEIVED`, cancels the W22 pg-boss job **and** its TimerRecord, writes the trace. VERBAL requires `verbatimNote` (the note *is* the evidence). A back-dated `receivedAt` is honoured; a future-dated one is clamped to now. Late capture is allowed and recorded as `withinWindow: false` / `timedOutBeforeCapture: true` rather than refused.
- `GET /api/entries/:id/communications` (L1+) — the four types newest-first with server-computed `canAcknowledge` / `isOverdue`, so neither frontend re-derives them.
- Guards in [p52-communication-acknowledgement-capture.ts](back_end/src/policies/20-communication-acknowledgement-tracking/p52-communication-acknowledgement-capture.ts): outbound only, acknowledgeable type only, **`sendStatus === "DISPATCHED"` only**, and capture-once.
- **Evidence, never a gate — with one exception (operator ruling 2026-07-31)**: a proforma that was actually **DISPATCHED** must have the guest's answer **recorded** before the S3→S4 freeze — `enforceDispatchedProformaGuestAnswerRecordedForS4Confirmation` ([p40](back_end/src/policies/16-confirmation-authority/p40-s4-confirmation-readiness-gates.ts), error `PROFORMA_GUEST_ANSWER_NOT_RECORDED`), keyed on the **latest** dispatched `PROFORMA_INVOICE` communication (a re-issued proforma re-opens the question; TIMED_OUT does not satisfy — capture the late answer). A generated-but-never-sent proforma still confirms without any acknowledgement, so the generate-vs-send rule is untouched. Quotation, voucher and pre-arrival acknowledgements remain evidence-only. Desk: conditional checklist item "Guest's answer to the proforma recorded" in `s3Readiness` (shown only when a live proforma was dispatched; fed by the communications feed), and the pre-freeze Confirm step renders `CommunicationAcceptanceBlock` for the proforma so the answer can be captured right where the gate blocks. **Segment-scoped since 2026-08-02**: `CommunicationRecord` carries no segmentId, so both the p40 gate query (s4-confirmation-service) and the desk (checklist item + `CommunicationAcceptanceBlock`'s new `sinceIso` prop, fed with the current segment's `startedAt`) consider only communications created within the current segment's window — a sealed segment's dispatch and its answer neither satisfy nor block the new segment's freeze. The setup-step's proforma reply block now renders unconditionally on S3 (shows "hasn't been emailed yet — nothing to answer" until this segment's proforma goes out, instead of vanishing after a re-entry). **W22 windows are cancelled on every new-segment re-entry (2026-08-02)**: a sealed segment's reply windows are moot, so `runBackflow` always appends `ACKNOWLEDGEMENT_WINDOW_W22` to `cancelTimerCodes`, and the non-runBackflow segment-openers (S3→S1/S3→S2 machine, S8→S2, S7→S1 room change, S6→S1 room change) cancel it explicitly — previously a stale voucher countdown from the frozen segment kept ticking on the desk at S3. Late answers are still capturable (p52). Repair scripts for pre-fix data (both dry-run default, `--commit`): [release-stale-segment-holds.ts](back_end/scripts/release-stale-segment-holds.ts) (prior-segment PLACED/CONFIRMED holds on S1–S3 entries) and [cancel-stale-segment-ack-windows.ts](back_end/scripts/cancel-stale-segment-ack-windows.ts) (SCHEDULED W22 timers predating the current segment).

**Gate change — quotation ACCEPTED → generated.** [operative-quotation.ts](back_end/src/lib/operative-quotation.ts) `resolveOperativeQuotation(quotations, segmentId)` picks the commercial basis: ACCEPTED wins whenever one exists, else the newest live quote (SENT above DRAFT); SUPERSEDED/EXPIRED are never operative. Wired into **both** boundaries — `enforceQuotationGeneratedForS2Exit` (S2→S3, [s2-s3-state-machine.ts](back_end/src/state-machines/s2-s3-state-machine.ts)) and `enforceQuotationPresentForS4Confirmation` (S4 freeze, [s4-confirmation-service.ts](back_end/src/services/domain/s4-confirmation-service.ts)); relaxing only S2 would have jammed the booking one stage later. Error code is now `NO_QUOTATION_GENERATED`. **The spec-strict `enforceAcceptedQuotationPresentForS2Exit` / `…ForS4Confirmation` are retained unused** so the stricter rule can be restored by swapping the call site back. A booking the guest *did* accept freezes exactly the terms it always did — only the never-sent case behaves differently, and there the alternative was being unable to confirm at all.

**Proforma at S3→S4 needed no change** — SIG-S3 §1.5.3 already says "at least one Invoice of type PROFORMA has been **generated**", and `enforceProformaInvoicePresentForS4Confirmation` only ever checked existence.

**Defect fixed alongside:** `s9-service.dispatchInvoice` wrote the PI acknowledgement loop as `commType: "INVOICE_SUPERSEDED_NOTICE"` — a stale dodge around a Windows Prisma-generate issue, even though `PROFORMA_INVOICE` had been in the enum all along. Every PI dispatch was mislabelled and unfindable by type. Fixed, with [backfill-proforma-comm-type.ts](back_end/scripts/backfill-proforma-comm-type.ts) (dry-run default, `--commit`) relabelling existing rows; 1 row migrated.

**Frontend:** `listEntryCommunications` / `acknowledgeCommunication` + `EntryCommunication` in [lib/api/entries.ts](front_end/src/lib/api/entries.ts); shared [communication-acceptance.tsx](front_end/src/components/desk/workspace/communication-acceptance.tsx) (`CommunicationAcceptanceBlock`, keyed `["entry-communications", entryId]`) rendered on **setup-step** (proforma, only once dispatched), **confirm-step** (voucher, post-confirmation) and **arrival-step** (pre-arrival reminder). It renders three states — nothing sent yet / capture form / accepted — all driven by the server flags. `s2Readiness` + `s3Readiness` + `stepPreconditions` in [lib/desk/workspace.ts](front_end/src/lib/desk/workspace.ts) now read "Quote generated" instead of "Quote accepted"/"Quote sent to guest", matching the backend.

### Park / unpark — spec conformance pass (2026-07-28)

A read of the park path against the specs found the mechanics correct (provenance, reason capture, L1+ auth, which timers park does and doesn't touch) but the **stage envelope wrong and two defects**. All four are now fixed.

**Park is valid from any live stage.** [p01-entry-park-allowed-stages.ts](back_end/src/policies/01-availability/p01-entry-park-allowed-stages.ts) allowed **S1/S2 only** — a narrowing with no spec basis that blocked the S3/S4/S5 parks the SIGs mandate. Authority is DEV-SPEC-001 Part 3 §3.2.8 (`any (ACTIVE, Sn) ──► (PARKED, Sn)`), restated per stage in SIG-S1 §3.3 · SIG-S2 §3.3 · SIG-S3 transition table · SIG-S4 §2.1/§3.1 · SIG-S5 §3.1 · SIG-S7 §7, with Part 13's policy matrix listing Expiry/parking at S1,S2,S3,S5,S7,S9. The module now exports `isEntryParkAllowedForStage` (predicate) alongside the throwing guard, and **`parkInquiry`'s cascade uses the same predicate** — previously it had no stage check at all, so the inquiry route could park an S5/S7 entry the entry route refused. Ineligible children are skipped (and reported as `entriesSkipped`) rather than failing the whole inquiry park.

**Unpark no longer manufactures an expiry clock.** `ENTRY_EXPIRY` exists at **S1 only** — registered at entry creation, cancelled for good on S1→S2 ([s1-state-machine.ts](back_end/src/state-machines/s1-state-machine.ts)), never re-registered. `restoreStageExpiryTimersTx` re-armed one at the **S1 TTL regardless of stage**, so an unparked S2 entry expired ~1h later and — via the unguarded inquiry cascade — an unparked S5/S7 entry got marked EXPIRED with `releaseEntryRoomsToFree` freeing an in-house guest's room. It now consults `entryExpiryTimerAppliesAtStage(stage)` and beyond S1 just cancels the park timer. Stage-specific clocks (quotation validity, no-show cutoff, night audit) were never touched by park and still aren't — per SIG-S2 §3.3 and SIG-S5 §3.1.

**A PARKED entry can no longer be progressed.** Nothing enforced `status === ACTIVE` on any transition (`enforceEntryAtS1ForS1ToS2Progression` only rejected EXPIRED), so S1→S2 on a parked entry succeeded, cancelled the park-expiry timer and opened the next dwell record in ACTIVE mode while `status` stayed PARKED — a timer-less zombie. New `enforceEntryActiveForStageTransition` ([p01-entry-progression-stage-gates.ts](back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts), `blockingCondition: "ENTRY_PARKED"` / `"ENTRY_NOT_ACTIVE"`) is called by **every** transition entry point: the 7 forward progressions (S1→S2, S2→S3, S3→S4 confirm, S5→S6, S6→S7 check-in, S7→S8, S8→S9), `runBackflow` (all 9 backflows), the S3→S1/S2, S8→S7/S2 and S6→S1/S7-room-change re-entries. **W4** (the system S4→S5 activation) *skips* with `reason: "ENTRY_PARKED"` instead of throwing, since pg-boss would otherwise retry forever.

**Sealed records are read-only for working writes too (2026-07-31).** An EXPIRED entry keeps its stage (S1 stays S1), so stage-gated services accepted writes against it — the reported case: an availability search + room selection saved onto an expired booking from the desk. New `enforceEntryNotSealedForWorkingAction` (same p01 file, `blockingCondition: "ENTRY_SEALED_READ_ONLY"`) rejects EXPIRED/CANCELLED/CLOSED — **PARKED deliberately passes** (a park is a pause, not a seal). Wired into `queryAvailability` + `selectOption` (s1-availability-service) and `updateEntryIntakeFields` (s1-entry-service). Desk side: `booking-workspace` now renders EVERY step of a sealed booking through the inert read-only path (banner shows the sealed outcome); the terminal Closed step keeps its dedicated sealed summary canvas.

**`expiry.parking.followUpDays` is now a real config row.** It was read by `resolveParkExpiryDays` but seeded nowhere and absent from `config-key-registry.ts`, so the "configurable" 30-day threshold (Part 13 §Seeded Defaults) always fell back to the hardcoded default. Seeded as a plain number in [seed.ts](back_end/prisma/seed.ts) + [seed-additional-config-keys.ts](back_end/scripts/seed-additional-config-keys.ts) (the non-destructive path — run `npx tsx scripts/seed-additional-config-keys.ts` on an existing DB), owned by `ConfigurationService`, added to `FORBIDDEN_ZERO_KEYS`, and editable on `/admin/timers-workers`.

**Desk UI**: the workspace's `parkable` no longer hard-codes S1/S2. Park is offered on the **exit dialog at S1/S2** (pausing an unfinished enquiry is an exit choice) and as an explicit **Park button from S3 onward**; `Resume` gates on `parked` alone. Note the enum trap that caused a regression mid-fix: `parkable` requires `status === "ACTIVE"`, so it is always false for an already-parked entry — never gate Resume on it.

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

### PDF bill generation (2026-07-14)

Every guest-facing bill is now a real PDF, rendered ONCE by Puppeteer, stored write-once, checksum-signed, and served forever from the stored file. Never re-rendered on demand. Corrections issue a new invoice with `versionNumber + 1` (append-only), never mutate the existing artifact.

**Four templates in [`services/infrastructure/pdf-templates/`](back_end/src/services/infrastructure/pdf-templates/)**:

| Stage | Template | Matches | Served via |
|---|---|---|---|
| S2 | `quotation-proforma-template.ts` — title="QUOTATION" | `images/quotation.pdf` | [`services/domain/quotation-pdf-service.ts`](back_end/src/services/domain/quotation-pdf-service.ts) → wired in `sendQuotation` |
| S3 | `quotation-proforma-template.ts` — title="PROFORMA INVOICE" (same template, title swap) | `images/Proforma_Invoice.pdf` | [`services/domain/invoice-pdf-service.ts`](back_end/src/services/domain/invoice-pdf-service.ts) PROFORMA branch → wired in `dispatchInvoice` |
| S4 | `confirmation-voucher-template.ts` | `images/Reservation_Confirmation_for email.pdf` | [`services/domain/confirmation-voucher-pdf-service.ts`](back_end/src/services/domain/confirmation-voucher-pdf-service.ts) → wired in `confirmReservation` |
| S8/S9 | `room-invoice-template.ts` | `images/Commercial invoice.pdf` | [`services/domain/invoice-pdf-service.ts`](back_end/src/services/domain/invoice-pdf-service.ts) FINAL branch → filters folio lines to ROOM_CHARGE only (no F&B), computes subtotal + service charge + GST as separate totals lines, "Prepared by:" pulls session actor's `fullName` |

**Infrastructure ([`lib/document-storage.ts`](back_end/src/lib/document-storage.ts) + [`services/infrastructure/pdf-render-service.ts`](back_end/src/services/infrastructure/pdf-render-service.ts))**:
- Puppeteer 25 headless Chromium; shared browser instance kept alive across renders.
- Storage keys `documents/YYYY/MM/<KIND>/<READABLE_ID>-vN.pdf` under `STORAGE_ROOT_DIR` (default `./storage`, gitignored).
- Write-once: `writeDocument` rejects if the key already exists. Corrections must issue new keys via version bump.
- Atomic writes: temp file + rename.
- `hashSha256(bytes)` + `verifyChecksum(key, expected)` helpers.
- [`lib/pdf-render-context.ts`](back_end/src/lib/pdf-render-context.ts) loads HotelProfile (name, address, phone, TPN, GST TPN, logo as data URI) and resolves the "Prepared by:" staff name from the session actor.

**Immutability policy** ([`policies/31-invoice-integrity/p68-invoice-immutability.ts`](back_end/src/policies/31-invoice-integrity/p68-invoice-immutability.ts)) — `assertInvoiceMutationAllowed(existing, attemptedFields)` throws `PolicyGateBlockedError` if any non-dispatch field is edited on a rendered invoice. `updateIssuedInvoice(tx, id, data)` is the safe wrapper for post-issuance updates (dispatch metadata + supersede pointer only).

**Schema migration `20260714120000_pdf_bills_infrastructure`** added:
- `Invoice` + `Quotation`: `pdfStorageKey`, `pdfChecksum`, `pdfChecksumAlgo` (default "SHA-256"), `pdfRenderedAt`, `pdfRenderedBy`, `renderInputSnapshot Json`.
- `Reservation`: parallel `confirmationVoucherStorageKey` / `Checksum` / `ChecksumAlgo` / `RenderedAt` / `RenderedBy` / `InputSnapshot`.
- New `InvoiceLine` table — immutable line-item snapshot (particular, roomNo, nights, rate, amount, discount/service/gst subtotals, soft `folioLineId` ref).
- New `QuotationLine` table — immutable quotation booking-table snapshot (date, occupants, mealPlan, extraBeds, tax-INCLUSIVE amount).
- New `InvoiceIntegrityCheck` table — append-only audit log for periodic SHA-256 verifications.
- `HotelProfile`: `accountNumber`, `tpnNumber`, `gstTpnNumber`, `logoStorageKey` (Bhutanese invoice legal fields).
- `RateCard.rateIsTaxInclusive Boolean @default(false)` — when true, pricing engine back-solves base rate. Wired schema-side; pricing-engine consumer is a follow-up.

**Quotation.id is now the readable QUO-YYYYMMDD-NNNN** (was UUID). All three `tx.quotation.create` sites in `s2-quotation-service.ts` pass `id: referenceNumber`. Downstream `QuotationLine.quotationId` FK holds the readable value, not a UUID. Follows the existing Invoice pattern.

**Two rate conventions in play** (both supported):
- **Quotation / Proforma** — row `amount` is tax-INCLUSIVE (guest summary). Template's Amount (Nu.) column shows the all-in per-night total.
- **Room Invoice** — Rate is tax-EXCLUSIVE (base). Subtotal / Service Charge (from `billing.serviceChargeRate` config) / GST (from `billing.salesTaxRate` config) shown as separate totals lines.

**GST is ON at 5% since 2026-08-03 (operator ruling): `billing.salesTaxRate` = 0.05, `billing.serviceChargeRate` = 0.10.** GST is compound — always 5% of (net value + service charge) — and every engine already computed it that way ([room-composition.ts](back_end/src/lib/room-composition.ts), [compute-stay-charges.ts](back_end/src/services/infrastructure/compute-stay-charges.ts), S7/S8 charge posting, invoice render); only the config was off (salesTaxRate seeded 0 = disabled, serviceChargeRate never seeded → 0.1 fallback). Both keys are now in [seed.ts](back_end/prisma/seed.ts) + [seed-additional-config-keys.ts](back_end/scripts/seed-additional-config-keys.ts), and [set-billing-gst-service-rates.ts](back_end/scripts/set-billing-gst-service-rates.ts) (dry-run default, `--commit`) repairs an existing DB via append-only supersede — already applied to `legphel_pms_dev`. The FINAL-invoice branch of [invoice-pdf-service.ts](back_end/src/services/domain/invoice-pdf-service.ts) now reads rates via the shared `resolveChargeRates` (was `requireActiveConfigValue(...) || 0.05`, which threw on the unseeded SC key and overrode a deliberate 0, letting the invoice print rates the folio never charged). Known remaining gap: night-audit ROOM_CHARGE lines post the net per-night amount with no SC/GST companion lines — the final invoice adds SC+GST at render on top of the room subtotal, but `Folio.outstandingBalance` mid-stay under-states by SC+GST on room charges.

**Email attachments** — `StageEmailContent.attachments` (optional array of `{ filename, content: Buffer, contentType? }`) passes through `dispatchStageEmailBestEffort` → `sendEmail` → Nodemailer. Every stage service (S2 quotation, S3 proforma, S4 confirmation, S8/S9 final) attaches its PDF to the outbound email so guests receive the formal document alongside the summary body.

**S4 email body** now matches `images/email_template.png` — Reservation Team header, colour-coded reservation-details card, four policy cards (Cancellation red / Extra Guest green / Pet blue / Child Age purple), "Kindly find the attachment below" hint, hotel-contact footer with "SewaLandSue!" red bar.

**Download routes** ([`routes/documents/router.ts`](back_end/src/routes/documents/router.ts)) — L1+:
- `GET /api/quotations/:id/pdf`
- `GET /api/invoices/:id/pdf` (handles both PROFORMA and FINAL by invoice type)
- `GET /api/reservations/:id/confirmation-voucher-pdf`

Each renders on-demand if the artifact hasn't been stored yet (internal preview convenience); once stored, subsequent hits stream the file directly.

**Deferred items** (see [`docs/pdf-bill-generation-todo.md`](docs/pdf-bill-generation-todo.md)):
- **Re Check-In / Re Check-Out fields** on the confirmation voucher — related to double-entry / multi-entry booking design. Template renders placeholders for now.
- **Monthly integrity verification worker** — the schema table exists (`InvoiceIntegrityCheck`) but the cron isn't wired yet.
- **HotelProfile admin fields** for `accountNumber`, `tpnNumber`, `gstTpnNumber`, `logoStorageKey` — column exists but no admin UI form yet. Voucher template falls back to the reference logo in `images/legphel_logo without background.png` until admin uploads.
- **RateCard pricing-engine consumer** for `rateIsTaxInclusive`. Column is honoured on write; pipeline back-solve when true is a follow-up.

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

### Pulling friend's latest from UI-experiment (integration branch only)

When the friend pushes updates to `origin/UI-experiment`, sync them into `friend_back_end/` and `friend_front_end/` on the `integration-prod-frontend` branch. Uses a temporary `git worktree` — no submodules or subtrees.

```bash
# Make sure you're on the integration branch
git checkout integration-prod-frontend
git fetch origin UI-experiment

# 1. Create a temporary parallel checkout of his branch at ../friend-tmp
git worktree add ../friend-tmp origin/UI-experiment

# 2. Wipe current friend_* folders so removed files on his side actually go away
rm -rf friend_back_end friend_front_end

# 3. Copy his latest back_end/ and front_end/ into your working tree under NEW names
cp -r ../friend-tmp/back_end ./friend_back_end
cp -r ../friend-tmp/front_end ./friend_front_end

# 4. Remove the temporary worktree
git worktree remove ../friend-tmp

# 5. Commit + push
git add -A friend_back_end friend_front_end
git commit -m "Sync friend_back_end + friend_front_end from UI-experiment"
git push
```

The reason for the temp worktree: git can only check out ONE branch per folder. To grab friend's files with a DIFFERENT folder name (so both his and yours can coexist), we need a second working tree pointed at his branch, then copy from it and throw it away. See the branch-management section for why this workflow exists.
