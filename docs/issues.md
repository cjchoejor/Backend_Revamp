All critical claims are independently verified. I have a complete, evidence-backed picture. Here's the review.

---

# PMS Codebase Review — Doctrine Compliance & Production Readiness

## 1. What I used as the basis for review (your first question)

The codebase ships its own operating map in [CLAUDE.md](Backend_Revamp-main/CLAUDE.md) (updated 9 Jun 2026 — the most recent artifact), but the **authoritative doctrine** lives in the implementation-execution tree. The most recent + reliable hierarchy is:

| Layer                                       | Canonical file                                                             | Date             | Role                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Architecture doctrine** (the "rules")     | `DOSS principles/Rev3/DOSS_V2_Architectural_Principles_Revised.md`         | Mar 2026, locked | **22 absolute principles (P1–P22)** — the highest-authority test every line of code must pass. This is what I scanned against. |
| **Developer spec** (most recent build spec) | `DEV-SPEC finalization/DEV-SPEC-001 Part 1–13` + `CANON-V2_5-CHANGESET.md` | 7–8 Apr 2026     | Newest detailed dev spec, derived from Canon v2.5.                                                                             |
| **Operational behaviour** (stage rules)     | `Operational Workflow and Control Canon V2/Rev2/V2.2/`                     | 26 Mar 2026      | S1–S9 stage behaviour.                                                                                                         |

**Use `DOSS_V2_Architectural_Principles_Revised.md` (Rev3) as the master review basis** — it is self-contained, dated, version-locked, and §10.2 even carries the architect's own register of 9 known violations, which let me separate _acknowledged debt_ from _new deviations_.

**Scope caveat:** the per-stage behavioral specs CLAUDE.md points to (`docs/ACIG-v1_1.md`, `docs/SIG-S1..S9`) are **not bundled in this checkout** (`docs/` is gitignored/absent). So this review judges the code against the **22 architectural principles**, not the line-by-line ACIG/SIG stage behaviour. If you want that second pass, point me at the `docs/` folder.

## 2. Verdict: did the coding stick to its core architecture?

**Largely yes, and the team has been actively paying down the known-violation register — but the recent codeline introduced one Critical security regression and several new layer-boundary breaches.** This is a disciplined, genuinely DOSS-shaped codebase (append-only ledgers, trace events on transitions, config-over-code registry pattern, state-machine gating, fail-safe config loads). The deviations are concentrated and fixable.

**Known violations (§10.2) — progress since the doctrine was written:**

| Known violation                        | Status now                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P5 InquiryModel direct UPDATE          | ✅ **Fixed** — now transactional state-machine path                                                 |
| P7 fire-and-forget audit               | 🟡 **Mostly fixed** — traces now awaited in-tx; 3 residual out-of-tx sites                          |
| P8 config lacks effective dates        | 🟡 **Split** — generic ConfigurationEntry exemplary; rate/season/package registries still lack them |
| P9 live rate references                | ✅ **Mostly addressed** — S4 snapshots frozen terms; one reconfirm-overwrite gap                    |
| P11 work-order in S7                   | ⚠️ **Still present** (acknowledged)                                                                 |
| P13 hardcoded thresholds               | ⚠️ **Still present** — sharpest at credit-ceiling                                                   |
| P21 health/metrics                     | 🟡 **Partial** — health routes added but shallow; no worker metrics                                 |
| **P22 auth at controller not service** | 🔴 **Worse than documented** — see Critical #1                                                      |

## 3. Critical issues — must fix before production

**✅ C1 — RESOLVED 2026-07-09. Actor level is now token-authenticated, no longer self-asserted (P22, P3, P4)**
Fixed: [auth.ts](Backend_Revamp-main/back_end/src/middleware/auth.ts) verifies the login session token (`Authorization: Bearer <jwt>`) via [`verifySessionToken`](Backend_Revamp-main/back_end/src/lib/auth-token.ts) and derives the actor id + LEVEL from the **cryptographically verified payload** (signed from the StaffUser record at login); the `X-Actor-Level` header is no longer trusted. Verified live: a forged `X-Actor-Level: L4` with no token now returns **403** (was 200); L1/L2/L3 tokens are rejected from L4 routes and only a genuine L4 token passes; a header cannot override a token's level. The hardcoded `"dev-jwt-secret"` fallback is removed (fails closed in production), and [`requireGmRole`](Backend_Revamp-main/back_end/src/lib/admin/require-gm-role.ts) is now wired into custom-mode activation.
→ Dev/test escape hatch: `ALLOW_HEADER_AUTH=true` re-enables the legacy header path for local scripts (OFF by default; never enable in a deployed env). **Original finding (history):** `auth.ts` read `x-actor-level` straight from the request and trusted it; `jwt.verify` was never called; any client sending `x-actor-level: L4` got full admin authority.

**🔴 C2 — Room double-booking cannot be prevented at the data layer (P10)**
[RoomAssignment](Backend_Revamp-main/back_end/prisma/schema.prisma) has **no check-in/check-out columns and no overlap/unique constraint**; occupancy is a single scalar `Room.currentClaimState`. The only guard ([room-assignment-service.ts:40](Backend_Revamp-main/back_end/src/services/domain/room-assignment-service.ts:40)) prevents the _same entry_ being assigned twice — it does **not** stop two different entries holding one room over overlapping dates. The classic PMS invariant lives only in app code. Single-tenant serialized writes shrink the race window but don't satisfy P10 (DB-layer enforcement).

**🔴 C3 — An "engine" and a "policy" both write to the database (P12)**
Engines must be pure and policies must return decisions without side effects. Two outright breaches:

- [re-entry-consequence-engine.ts:28](Backend_Revamp-main/back_end/src/engines/re-entry-consequence-engine.ts:28) — `traceEvent.create(...)` inside an engine (5 call sites).
- [p12-duplicate-flag-create-on-inquiry.ts:10](Backend_Revamp-main/back_end/src/policies/04-duplicate-detection/p12-duplicate-flag-create-on-inquiry.ts:10) — a policy that `create`s a DB row.

**🟠 C4 (high→critical for a financial flow) — Dispute lifecycle emits zero audit trace (P7)**
[s7-dispute-service.ts](Backend_Revamp-main/back_end/src/services/domain/s7-dispute-service.ts) — open/close/progress/gate-override all run on bare `prisma` with **no TraceEvent and no transaction**. A billing gate can be overridden with no immutable record of who/when/why. This is the one governed financial flow with no traceability.

## 4. High-severity issues

- **Authority rests on caller-supplied input** — services consume an optional `actorLevel` arg rather than re-deriving it; when omitted, the audit trace _fabricates_ a default level (`L1`/`L2`). [cancellation-service.ts:60-69](Backend_Revamp-main/back_end/src/services/application/cancellation-service.ts:60) (P3/P4).
- **Hardcoded credit-ceiling thresholds shadow a config path in the same file** — [s7-folio-lines-service.ts:249](Backend_Revamp-main/back_end/src/services/domain/s7-folio-lines-service.ts:249) uses literal `0.75/0.9/1.0` to write `creditCeilingTier2AcknowledgedAt`, while `maybeWriteCreditCeilingEvents` 160 lines up reads the same percentages from config. Lower the admin threshold and the real gate ignores it (P13).
- **Non-critical subsystems run inside core transactions (P18)** — `engine.schedule()` (pg-boss) and `generateQuotationDocument` sit _inside_ the S2/S4 commit ([s4-confirmation-service.ts:197](Backend_Revamp-main/back_end/src/services/domain/s4-confirmation-service.ts:197), [s2-quotation-service.ts:641](Backend_Revamp-main/back_end/src/services/domain/s2-quotation-service.ts:641)). A transient queue/doc failure rolls back a confirmed reservation. The codebase's _own_ S7 services do this correctly with try/catch — the pattern just isn't applied at S2/S4.
- **Missing indexes on append-only ledgers (P19)** — `FolioLine` and `PaymentRecord` have **no `@@index([folioId])`**, yet `recomputeFolioOutstandingBalance` runs 4 `WHERE folioId=?` aggregates after _every_ charge/payment. Sequential scans that degrade linearly with ledger growth.
- **Financial balance is a JS-float cached column with no reconciliation CHECK (P10)** — [folio-outstanding-from-payment.ts:26](Backend_Revamp-main/back_end/src/lib/folio-outstanding-from-payment.ts:26) sums money as IEEE-754 `number`; `Math.max(0,…)` silently masks over-refunds.
- **Layer leaks into routes (P12)** — [entries/router.ts:158](Backend_Revamp-main/back_end/src/routes/entries/router.ts:158) mutates `entry` directly (no audit trace); [reservations/router.ts:244](Backend_Revamp-main/back_end/src/routes/reservations/router.ts:244) writes TraceEvents inline; the 437-line `progress-stage` god-handler embeds authority checks + an 11-way stage dispatch table.
- **15 policies read the DB inline** instead of receiving facts (P12) — couples them to the schema, breaks unit-testability.
- **Doc/code drift, user-facing** — [overview-router.ts:21](Backend_Revamp-main/back_end/src/routes/admin/overview-router.ts:21) hardcodes `services: 26`, but `src/services/admin/` has **22** files. The `/admin` dashboard shows a wrong number CLAUDE.md calls "exact, not approximate."
- **Test suite is broken/absent** — all 9 `test:revamp:s*` scripts point at a gitignored `Test_ReVamp/` that doesn't exist; there is **no unit-test framework** (0 `*.test.ts`, no vitest/jest config) — only `tsx` integration scripts that require a live seeded DB.

## 5. Cosmetic & housekeeping (post-production haunts)

- **No lockfiles + all-floating `^` deps + zod v3 (backend) vs v4 (frontend)** — non-reproducible installs; the biggest supply-chain risk for a production PMS.
- **300 `as any` + 60 `: any`** concentrated in the hottest operational services/workers (Prisma JSON access) — silent type holes where `strict` can't help. (Upside: `strict: true` both tsconfigs, **zero** `@ts-ignore`, frontend has zero `any`.)
- **Loose one-off surgical scripts** named after production record IDs (`unstick-FOL-20260529-0003.ts`) and an **unguarded `wipe-operational-data.ts`** sitting in `scripts/` next to ordinary tooling — a wrong-`DATABASE_URL` footgun.
- **CLAUDE.md is Windows-coupled** — memory path `C:\Users\ASUS\...` and a whole "Prisma EPERM on Windows" section, but this checkout is macOS; the `docs/` "source of truth" it cites is absent here.
- **Observability is thin** — `/health` is a static `{ok:true}` stub (no DB/queue probe); workers trace that they fired but report no duration/items/failures (night-audit is the lone good model).
- **Minor data-integrity edges** — rate registries edited in place with no effective dates (P8, known); quotation `applyDiscount` and reservation frozen-terms overwrite in place (P5/P9); W6 night-audit derives operating-date from wall-clock on retry (P15); W33 notice not idempotent (P16); cancellation flow triplicated across 3 functions despite CLAUDE.md claiming a "shared engine" (P17).
- **Clean bill** on several fronts worth noting: no committed secrets, `.env` gitignored, near-zero TODO/dead code, disciplined `src/` naming, append-only ledgers genuinely append-only, strong P6 attribution and P15 determinism.

## 6. Recommended order of attack

1. **C1 auth** — wire `jwt.verify` / session validation into the global middleware; remove the hardcoded secret fallback; call `requireGmRole` at the service layer. _Nothing else matters until this is closed._
2. **C2 double-booking** — add a date-ranged booking table with a Postgres `EXCLUDE USING gist` overlap constraint.
3. **C4 dispute audit** + **C3 engine/policy purity** — move the writes into services, in-transaction.
4. High-tier: credit-ceiling config wiring, schedule/doc-gen out of core tx, `@@index([folioId])`, fix the `26`→`22` count, stand up a real test runner.
5. Housekeeping sweep: lockfiles, zod alignment, guard/relocate destructive scripts, refresh CLAUDE.md for macOS.

---

I verified every Critical and the load-bearing High findings by opening the files myself (auth, JWT, service count, engine/policy writes, RoomAssignment schema all confirmed). Want me to:

- **(a)** write this up as a persisted `REVIEW.md` in the repo (with the full per-principle P1–P22 scorecard from the six audit tracks), and/or
- **(b)** start fixing the Criticals, beginning with the auth regression (C1)?
