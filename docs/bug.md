number 8 mandatory in travel agent
folio line, id to be human readable

calculation mistake in Q2 frontend, but in quotation is correct

what is acknlwoledgement multibooking overlap is s4
s7 stay not being able to add to folio after
what is post final charge

we will add one more cancellation policy where they will stay in and then cancel said by boss.

night audit gi list chi lo, ani dhe hamago jamtsho lu dresh, what things are need like money, room bill check once.

stage 9 feedback no have, w28 gi dhen lu

for timer configs sir and madam will tell.

---

## OPEN — S3→S2 backflow leaves the accepted quotation ACCEPTED (logged 2026-09-01)

Going back from Set-up to Quote to renegotiate does not retire the quote that was
already accepted, so a booking can end up carrying two live ACCEPTED quotations.
`s3-reentry-state-machine.ts` never touches quotations at all.

**Largely defused on this branch, which is why it is not urgent.**
`resolveOperativeQuotation` is segment-scoped (`q.segmentId === segmentId`), so a
stale accepted quote from a sealed segment is invisible to every gate. It cannot
misprice a booking the way it did on `integration-prod-frontend`, where the
symptom was "Only DRAFT quotations can be sent" after a backflow.

Checked 2026-09-01 on legphel_pms_dev2: 0 bookings with >1 ACCEPTED quotation
(28 bookings have >1 segment, but those segments came from the legacy import,
not from real backflows — so the data does not prove the bug absent, only unhit).

The fix on the other branch is `lib/supersede-accepted-quotation-on-backflow.ts`
(commits de027da, edb98fb) plus `scripts/fix-stale-accepted-quotations.ts`. The
cleanup script would have nothing to clean here today.
