# Policy wiring audit — explained in plain language

**Date of audit:** 2026-06-27
**For:** anyone reviewing the "unwired policy" audit results who wants to understand what the numbers and edge cases actually mean.
**Purpose:** the audit output uses shorthand that assumes background knowledge of the codebase. This doc unpacks each finding one at a time.

---

## 1. What the two policy systems are

The Legphel PMS codebase has **two separate places policies live**. Any audit has to look at both.

### System A — TypeScript policy files ("compiled guards")

These are code files under `back_end/src/policies/`. Each one is a small function that enforces a business rule at runtime — for example, "you cannot check out an entry that has an unpaid balance," or "a group booking above 10 guests needs FOM approval." There are 149 of these files total.

They're called "compiled" because they're baked into the code — you cannot change them from the admin console. To change one, a developer edits the `.ts` file and redeploys.

Think of these as **wall-mounted guards**: they either fire on every request or don't, but you can't move them or turn them off without a code change.

### System B — Admin-editable registry policies

These live in a Postgres table called `policy_registry`. Each row is one policy the L4 admin can turn on/off or adjust from the admin console at `/admin/policies`. There are 24 seeded rows.

Think of these as **dials on a control panel**: the admin can twist them without waiting for a developer. Values include things like the S1 inquiry expiry timeout, the child age bands, the credit ceiling percentages, etc.

---

## 2. What "wired" and "unwired" mean

A policy is **wired** when actual operational code (services, workers, state-machines, routes) calls it. If a booking flows through the code and the policy's rule fires, it's wired.

A policy is **unwired** when the policy exists — the file is in the tree, the row is in the DB — but no operational code path ever consults it. If a booking flows through the code, the policy sits there doing nothing.

Unwired policies are essentially **dead code from a business perspective**. The rule is implemented but never enforced.

---

## 3. What the counts table means

Here's the table from the audit:

| System | Definitions found | Wired at runtime | Unwired |
|---|---|---|---|
| A – TS policy files | 149 | 126 | 23 |
| B – DB registry policies | 24 | 23 | 1 |

Plain-language reading:

- We have **149 TS policy files** total. **126 of them are actively enforcing rules** (some service imports them and calls them on every booking). **23 of them are dead** — the code is written but nothing calls it.
- We have **24 registry policies** seeded in the DB. **23 of them are actively consulted** by some operational code. **1 of them is dead** — the row exists but no live code path reads it.

### The line "Search corpus for consumers"

The audit had to decide *where* to look for callers of each policy. It looked in these directories:

```
back_end/src/services/**
back_end/src/workers/**
back_end/src/state-machines/**
back_end/src/routes/**
back_end/src/lib/**
back_end/src/db.ts
```

That's the "search corpus" — the set of files considered as potential consumers of a policy. If the policy's function name shows up in any of those files (via an `import` statement), it's counted as wired.

The audit also noted "no test files exist in `back_end/src`" — meaning there are no `.test.ts` files that might be masking a real caller. Only `node_modules` (third-party dependencies) had test files hitting the policy names, and those don't count.

---

## 4. What "24 policyIds have a matching `getRegistryPolicy` call" means

This one requires knowing the code convention.

Every registry policy is read at runtime via a helper function called `getRegistryPolicy(db, "registry.<name>")`. For example:

```ts
const policy = await getRegistryPolicy(prisma, "registry.child.ageBands");
```

The audit did a text search for every `getRegistryPolicy` call in the codebase, then compared the policy IDs used against the 24 seeded policy IDs.

**Result:** every single one of the 24 seeded IDs shows up in at least one `getRegistryPolicy(...)` call somewhere. So if you just count "does the policy ID appear in a getRegistryPolicy call?", the answer is 24 out of 24 — no dead policies.

But that count is misleading — and that's what the audit is warning about. Just because the policy ID is *mentioned* in a call doesn't mean that call actually runs during normal operation. The file containing the call might itself be dead code (unimported by anything). That's where the naive count lies.

Which brings us to...

---

## 5. What the `registry.shadowInventory.l4Only` case is

Here's the audit's finding:

| policyId | Seeded in | Consumer call site | Live? |
|---|---|---|---|
| `registry.shadowInventory.l4Only` | `prisma/seed.ts:363` | `policies/05-shadow-inventory/p14-shadow-inventory-visibility.ts` only | **NO** |

Plain-language walkthrough:

1. The registry policy `registry.shadowInventory.l4Only` was **seeded** by the file `prisma/seed.ts` at line 363 — meaning a row was inserted into the `policy_registry` DB table.
2. Exactly one file in the codebase calls `getRegistryPolicy(db, "registry.shadowInventory.l4Only")`. That file is `p14-shadow-inventory-visibility.ts`.
3. **But** `p14-shadow-inventory-visibility.ts` itself has no importer — no service, worker, state-machine, or route ever calls the function it exports.
4. So the sequence is: seed → row exists → consumer file exists → but consumer file is never invoked → therefore the policy is never actually read.

The chain of function calls is broken at the last step. The policy is **transitively dead** — dead because its consumer is dead.

Meanwhile the actual shadow-inventory feature *does* work in the running app — via a different code path. See the last section of this doc for what "shadow inventory" means and how the working path enforces it.

---

## 6. "Test-only imports: None" — what that means

The audit was watching out for a common pattern that fakes wiredness. Sometimes a policy is imported ONLY by a test file:

```ts
// somefile.test.ts
import { enforceXYZ } from "../policies/..../xyz.ts";  // ← counts as an import
```

If you naively grep for imports, this file makes the policy look wired. But at runtime, the test file never runs — it only runs during CI/testing. So the policy is effectively unwired in production.

The audit checked whether any of the 23 apparently-unwired System-A files were being imported by test files and thus incorrectly flagged. The answer was **none** — `back_end/src` has no `.test.ts` files at all. The only test files anywhere in the tree are inside `node_modules/` (third-party library tests), which don't count.

Bottom line: the audit's "unwired" count is honest — nothing is unwired-in-production-but-covered-only-by-tests.

---

## 7. "Policy-called-only-from-another-policy" — what that means

Another way a policy can look wired but actually be dead: it's called only by another policy file, and that other policy file is itself unwired.

The chain would look like:

```
policy A (unimported by any service)
    ↓ imports
policy B (only ever called from policy A)
```

Naive grep says policy B is imported. But policy A never runs — so policy B never runs either. Policy B is dead.

The audit found exactly one instance of this in System B: `registry.shadowInventory.l4Only` (the case in the previous section). Its consumer is `p14-shadow-inventory-visibility.ts` — and `p14` is itself an unwired policy file. So the registry key is dead because the policy that reads it is dead.

---

## 8. All the notable edge cases — decoded

The audit ended with a list of "notable edge cases." Here they are in plain language:

### "Test-only imports: None"

Covered above. No policy is imported only by tests.

### "Policy-called-only-from-another-policy"

Covered above. Only `registry.shadowInventory.l4Only` sits in this trap.

### "Registry key consumed from within a policy file that IS wired"

The opposite pattern from the shadow-inventory case. Sometimes a registry policy is read from within a policy FILE (not a service), but that policy file IS wired — some service does import it.

Example: `registry.duplicateInquiry.blockS1Exit` is read inside `p12-open-duplicate-flag-blocks-s1-exit.ts`. That policy file might sound like a leaf, but `s1-state-machine.ts` imports it. So the chain works:

```
s1-state-machine.ts
    ↓ imports
p12 policy file
    ↓ reads
registry.duplicateInquiry.blockS1Exit  ← LIVE, because the whole chain is intact
```

The audit is telling you: don't confuse this pattern with the dead one. What matters is whether the chain has an unbroken path back to some route/service that runs.

### "`policy-schemas.ts` (front-end) parity"

The frontend admin console has a file at `front_end/src/lib/admin/policy-schemas.ts` that describes what fields each policy has (so the `/admin/policies` page can render a typed editor). The audit checked that every seeded policy ID has a matching frontend schema entry.

Result: **24 seeded IDs = 24 frontend schema entries**. Perfect parity. The only frontend entry with no live backend consumer is (again) `registry.shadowInventory.l4Only` — the admin can edit it, but the value goes nowhere.

### "Multi-line named imports: captured"

Just a QA note on the audit itself. TypeScript imports can span multiple lines:

```ts
import {
  enforceAvailabilityQueryParamsForS1,
  isShadowInventoryVisible,
} from "../policies/...";
```

The audit confirmed its search picked up multi-line forms correctly — no policy was missed just because its import was formatted across lines.

### "`db.ts` Prisma-extension guards"

`back_end/src/db.ts` sets up the Prisma client and imports 9+ helper functions from `p01-prisma-extension-blocking-guards.ts`. Those helpers install Prisma-level query interception. The audit is noting: those guards *are* wired (imported by `db.ts` which is core infrastructure) — they didn't get miscounted as dead.

### "Auto-fulfil-S2-to-S3 & entry-progression stage gates"

Some policies are re-exported through a "barrel" file — a single index file that gathers many policy functions and re-exports them under one name. `p01-entry-progression-stage-gates.ts` is one of these barrel files.

Audit is confirming: it followed the re-export chains so policies exported via barrels weren't miscounted. Those guards are wired through the barrel to services + the entry lifecycle state machine.

---

## 9. What "shadow inventory" means

Since shadow inventory came up multiple times, here's the concept in plain language.

**Shadow inventory = rooms that exist in the hotel but are deliberately hidden from lower-authority staff during availability searches.**

Some hotels keep a small pool of rooms in reserve — for VIP arrivals, for surprise walk-ins during a full night, for maintenance emergencies, or for corporate accounts with guarantee agreements. These rooms should not appear in a normal availability search that a receptionist (L1) runs, or they'd end up assigned to a walk-in guest by mistake.

But those rooms still exist physically. Housekeeping cleans them. Night audit counts them. The GM (L4) should see them in the availability search when they need to.

The `Room.isShadowInventory` column (Boolean, defaults to `false`) marks a room as shadow inventory. The rule around it — which actor levels can see shadow rooms in a search — is configurable.

### The two implementations that exist (and only one runs)

In this codebase there are TWO ways to enforce the shadow-inventory visibility rule:

**Path A (LIVE, actually runs):**
- A ConfigurationEntry row `availability.shadowInventory.visibilityRules` holds an array of `{ actorLevel, visible }` rules. Seeded to `[{L1: false}, {L2: true}, {L3: true}, {L4: true}]` — meaning L1 receptionists don't see shadow rooms; everyone else does.
- The availability engine reads this config directly. `s1-availability-service.ts` and `s1-processing-lock-service.ts` both fetch it and pass the rules into the engine as `shadowInventoryRules`.
- This IS what actually filters your rooms today.

**Path B (DEAD, never runs):**
- A registry policy `registry.shadowInventory.l4Only` with an `enabled` flag.
- A helper file `p14-shadow-inventory-visibility.ts` that reads that policy and computes visibility.
- No service, worker, state-machine, or route ever calls `p14`. So the policy is never read, and the registry row is inert.

Both paths were probably written at different times, and the older/simpler ConfigurationEntry path won. The registry-based one was left behind. That's why the audit flags it as dead.

### What that means for the L4 admin

- **You can safely delete** `registry.shadowInventory.l4Only` from the frontend schema and the seed, and remove `p14-shadow-inventory-visibility.ts` — no behavior changes.
- **Or you can leave it** but understand it does nothing. Editing it in `/admin/policies` won't change what receptionists see.
- **The knob that actually works** is `availability.shadowInventory.visibilityRules` in the ConfigurationEntry surface — that's what to change if you want to alter who can see shadow rooms.

---

## 10. Recap in a table

| Concept | Plain meaning |
|---|---|
| **System A** | TypeScript policy files under `src/policies/` — 149 total, developer-editable only. |
| **System B** | Admin-editable registry policy rows in the `policy_registry` DB table — 24 total. |
| **Wired** | Actually called by operational code that runs in production. |
| **Unwired** | File/row exists but no code path ever invokes it. Dead. |
| **Search corpus** | The directories the audit looked in to find callers. `back_end/src/{services,workers,state-machines,routes,lib,db.ts}`. |
| **`getRegistryPolicy(...)` call site** | Where in the code a specific registry policy is read from the DB. |
| **Test-only import** | A policy imported only by `.test.ts` files — would look wired but never runs in production. This audit found none. |
| **Policy-called-only-from-another-policy** | A dead-chain pattern where policy B is called by policy A, but A is itself unimported. Only `registry.shadowInventory.l4Only` sat in this trap. |
| **Barrel file / re-export chain** | A single file that gathers many policies and re-exports them under one name — the audit followed these correctly. |
| **Shadow inventory** | Rooms flagged with `isShadowInventory: true` — physically present but deliberately hidden from lower-authority staff during availability searches. |
| **Path A vs Path B (shadow inventory)** | Two implementations of the same rule; A (ConfigurationEntry-based) is live, B (registry-policy-based) is dead. |

---

## 11. Next steps (recommended, not prescribed)

- **Delete redundant unwired policies** — safest cleanup. Candidates: `p14-shadow-inventory-visibility.ts` (redundant with Path A) and the six spec placeholders (`p47`, `p73`–`p77`).
- **Also drop `registry.shadowInventory.l4Only`** from the seed and the frontend schema so `/admin/policies` doesn't show a knob that does nothing.
- **Wire the operational guards one at a time** — `p10-checkout-due`, `p15-guest-identity-capture`, `p21-mid-stay-rate-amendment`, `p66-group-foc-and-billing-split` (relevant to the group-billing conversation), etc. These are load-bearing rules from the SIG docs; they should fire.
- **Log the rest as tickets** — for each remaining unwired guard, decide "wire it" or "delete it" deliberately, not by drift.
