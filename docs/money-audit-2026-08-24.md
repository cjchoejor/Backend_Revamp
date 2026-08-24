# Money audit — 2026-08-24

Full-ledger money audit of the dev DB (`legphel`), run with the new read-only diagnostic
[`back_end/scripts/audit-money.ts`](../back_end/scripts/audit-money.ts) (re-run any time:
`npx tsx scripts/audit-money.ts`, `--verbose` lists every INFO row). This file records what was
checked, what passed, and every finding with its explanation and the decision it awaits.

## Scope and method

Money lives in four layers that must agree, and the audit walks all of them, exhaustively
(127 folios · 331 folio lines · 34 payments · 54 invoices · 21 frozen assignments · 13 interim
requests · 6 credit extensions):

| Layer | Invariants checked |
|---|---|
| Ledger & balance | stored `outstandingBalance` = `max(0, Σlines − ΣIN + ΣOUT − Σwrite-offs)` (the `recomputeFolioOutstandingBalance` rule); SETTLED ⇒ 0; LIVE folios on dead entries; payments exceeding charges (the clamp hides credits) |
| Tax lines | every SC/GST companion re-derived from its base charge **at the rate its own description states** (family-level — several same-description charges on one day each post their own companions, so only the sums are well-defined); compound GST on (net + SC); orphan companions; corrected families re-summed (original + corrections + all tax lines); duplicate room-nights; sign anomalies; audit-stamped room lines with no companions on active folios (backfill gap) |
| Frozen layer | `frozenTotal` vs `frozenSubtotal` × era-correct multipliers (flags-aware: SC/GST/FOC toggles); audited per-night posts vs `frozenSubtotal ÷ nights`; over-posting beyond the frozen figure; null-dated frozen rows |
| Coverage & derived surfaces | completed stays (S8/S9/CLOSED) missing a room charge for a stay night; interim requests (`dueNow = max(0, ask − received)`, INTERIM invoice amount = the request's figure, PAID backed by linked payments); broken invoice supersede chains; orphan credit-extension / interim-payment links; `buildEntryBillingSummary` re-reconciled for every ACTIVE entry (billed = Σ lines; base+SC+GST = total; per-room buckets + unassigned = whole) |

## Verdict

**0 critical.** Every system-produced ledger reconciles to the chetrum. The warnings split
into two genuine (small) ledger residues from an already-fixed bug, one stranded test cluster,
one refund-decision list, and one structural property of the legacy import that needs a ruling.

What passed **with zero findings**: companion math on all 78 tax companions (family-level, to
the chetrum) · no orphan companions · no duplicate room-nights · no negative-line anomalies ·
no untaxed audit-stamped room lines on active folios (the 2026-08-18 backfill is complete) ·
all payments positive, no refund exceeding receipts · all 21 frozen rows' `frozenTotal` =
`frozenSubtotal × 1.155` under their flags · every audited night posted at exactly
`frozenSubtotal ÷ nights` · no over-posted room · night coverage complete on all
system-produced completed stays (2 exceptions below, both stranded test bookings) · all 13
interim requests and their INTERIM invoices consistent, every PAID state backed by linked
payments · no broken supersede chains · no orphan cross-links · the billing summary
re-reconciles for all 37 ACTIVE entries.

Folio tallies at audit time (count · Σ lines · Σ paid in · Σ stored outstanding):

| State | Count | Σ lines | Σ paid in | Σ outstanding |
|---|---:|---:|---:|---:|
| LIVE | 5 | 124,607.48 | 43,509.29 | 83,531.29 |
| OUTSTANDING | 54 | 574,083.90 | 40,600.06 | 12,242.00 |
| SETTLED | 26 | 214,073.53 | 34,897.69 | 0.00 |
| NO_SHOW_CLOSED | 24 | 267,405.19 | 1,670.00 | 0.00 |
| PROVISIONAL | 18 | 0.00 | 13,012.00 | 0.00 |

## Findings

### 1. Two folios over-taxed by Nu 5.25 each — residue of the pre-2026-08-21 correction bug (WARN, real money)

Before 2026-08-21, `correctCharge` posted the charge delta plus a GST correction computed on
the **bare** delta, and **no service-charge correction at all**. That bug is fixed, but two
corrections posted under the old rule left their residue on the ledger:

| Folio | Family | Net after correction | SC on ledger | SC should be | GST drift |
|---|---|---:|---:|---:|---:|
| FOL-20260821-0001 (Tashi, LIVE) | "okay" (10,000 → −50) | 9,950.00 | 1,000.00 | 995.00 | +0.25 |
| FOL-20260814-0001 (S9, OUTSTANDING) | "Room-service dinner (501)" (500 → −50) | 450.00 | 50.00 | 45.00 | +0.25 |

Each folio charges the guest **Nu 5.25 too much** (SC +5.00, GST +0.25 — the GST correction
`−2.50` was 5% of −50 instead of 5% of −55). Total over-collection on the books: **Nu 10.50**.
**Repair** (not applied — changes guest balances): post a `Service charge correction on:` −5.00
and a `Sales tax correction on:` −0.25 per family, then recompute — the exact write the fixed
`correctCharge` would have made.

### 2. Stranded July test cluster (WARN)

`ENT-20260702-0003` and `ENT-20260702-0004` are EXPIRED at S8 with **LIVE** folios — the
pre-rules era the early-departure work closed (a dead booking must not keep an open ledger).
One claims 1,458.44 outstanding from a guest who never existed; the other holds a 100.00
advance against zero charges. Both also show a never-billed stay night (their single night was
never audited). Being July test data, the clean fix is sealing both folios (OUTSTANDING → or
simply deleting the two test bookings).

### 3. Advances held on dead bookings — Nu 312.00 (WARN, refund-or-write-off decision)

Five EXPIRED bookings hold advances with no (or fewer) charges: 100 + 100 + 100 + 10 + 2
= **312.00** across FOL-20260702-0001/-0002/-0005, FOL-20260708-0001/-0002. The
`max(0, ·)` balance clamp makes these invisible on every surface — the folio just reads 0.
Real-world meaning: money taken for stays that never happened. Needs a ruling: refund path
(OUT payment) or write-off. (Six more folios where payments exceed charges are **normal** and
listed as INFO: provisional folios holding advances pre-stay, and ENT-20260819-0001's mid-stay
prepay credit of 2,333.10.)

### 4. The legacy import's balance shape — 96 folios (WARN as a class, needs a ruling)

The legacy importer brought the old system's **charges** across but not its **payments**, and
pinned each folio's `outstandingBalance` to what the legacy data said (usually 0, states
SETTLED/OUTSTANDING/NO_SHOW_CLOSED per the legacy word). Result: on 96 imported folios the
stored balance does **not** equal the recompute rule (`Σlines − payments`). This is import
shape, not corruption — but it is a **standing hazard**: any future write that triggers
`recomputeFolioOutstandingBalance` on such a folio (a post-stay charge, a payment event, a
correction) will **resurrect the full phantom balance** (3,000–26,000 per folio; Σ ≈ 800k).
Options for a ruling: (a) importer backfills a synthetic `PaymentRecord` ("settled in legacy
system") so the ledgers balance; (b) a guard that refuses recompute on imported folios;
(c) accept and never touch imported folios operationally.

### 5. Render-time tax on imported documents — Nu 136,376.28 across 102 folios (INFO, by design)

Imported room lines carry no SC/GST companions, so documents add their tax **at render time**
(the ledger-view legacy rule) — the printed tax invoice/master bill totals exceed the ledger's
own billed figure by **136,376.28** in aggregate. Known, deliberate (2026-08-18 ruling: an old
folio's documents keep their room tax). Side-effect worth knowing: on such folios the printed
"total − payments" does not equal "payable" (payable is the ledger's balance, which never
charged that tax).

### 6. Known singletons (INFO)

- `RA-20260821-0006` (Tashi, room 201): `frozenSubtotal` 45,000 on a null-`startDate` row —
  the audit falls back to `frozenRate` for it (same figure, 4,500/night); flagged 2026-08-24,
  backfill offered.
- Companion-rate histogram: every companion on the books states 10.00% SC / 5.00% GST — no
  odd-rate eras in the data.

## Re-running

```bash
cd back_end
npx tsx scripts/audit-money.ts            # summary (INFO capped at 8 rows/class)
npx tsx scripts/audit-money.ts --verbose  # every row
```

The script is read-only and safe on a live system. Findings are graded CRITICAL (money wrong)
/ WARN (needs a decision or repair) / INFO (known design, quantified).
