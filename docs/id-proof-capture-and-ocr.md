# Guest ID capture — uploads, phone handoff, and the OCR roadmap

**Status (2026-08-12):** everything in §1 is **built and verified live**. Everything in §2 (OCR)
is a **discussed-and-agreed plan, not yet built** — it is written down here so a future session
can implement it without re-deriving the decisions.

Related reading: the operating notes in `CLAUDE.md` (sections "Guest ID proof capture on
Arrival", "Phone capture handoff", "Guest-detail table on S6") are the terse running record;
this file is the narrative reference.

---

## 1. What exists today

### 1.1 Storage & data model

- **Bytes** go to the write-once document store under `STORAGE_ROOT_DIR` (default `./storage`),
  key shape `documents/YYYY/MM/identity-proof/<entryId>-<stamp>-<rand>.<ext>`, SHA-256
  checksummed, S3-swappable. Never in Postgres. **No delete endpoint by design** — a stored
  proof is evidence; the retention purge is the only disposal path (purge worker still open).
- **Metadata** lives on `GuestIdentityDocument` — shared with the S6 typed verification so one
  table answers "what do we hold about this guest's identity" and one retention story governs
  both (`identity.retentionPeriodDays` per docType → `retentionExpiresAt`, DEFAULT 2555 days).
- **Two row kinds per party slot** (`subjectKey` = guest-board keys `A0…/K0…`):
  - **DETAIL row** (`storageKey IS NULL`) — typed document type/number/name/DOB/gender.
    Upserted in place; working data. `PUT /api/entries/:id/identity-details`.
  - **PHOTO rows** (`storageKey` set) — write-once evidence files.
- Service: [guest-identity-proof-service.ts](../back_end/src/services/domain/guest-identity-proof-service.ts)
  (`storeIdentityProof`, `saveGuestIdentityDetail`, `listIdentityProofsForEntry`,
  `guestDetailsCoverageForEntry`, `phoneCaptureRoster`, `readIdentityProofFile`).
- Party slots come from ONE derivation — `derivePartySlots` (adults + per-child ages off the
  intake breakdown, `guestCount` anonymous fallback). The desk table, the S6 coverage gate and
  the phone roster all share it, so no two surfaces can disagree about who is in the party.
  Labels are generic ("Adult 1") because the booking's guest profile is the CONTACT PERSON,
  not necessarily anyone sleeping in the rooms; typed names overlay where recorded.

### 1.2 The guest-detail table (desk, S5 + S6)

[identity-proof.tsx](../front_end/src/components/desk/workspace/identity-proof.tsx)
(`IdentityProofBlock`) renders on Arrival (collapsible, collapsed by default) and Check-in
(always open, gate surface). Columns: Document type · Document no · Name · DOB · Gender ·
ID photo. Details save on field blur; a typed name replaces the generic label live.

- **Grouped BY ROOM**: each room is a cream band row ("**Room 205** · Twin · Deluxe Double ·
  3/4 IDs", count green when all covered) with its guests beneath. Unseated guests gather
  under "No room assigned yet"; a booking with no composition keeps a flat table. Seating is
  re-derived (compositions store counts, never who) with the S2 board's deterministic
  algorithm — see §1.4 for the backend mirror.
- **Document type vocabulary** is config-driven (`identity.documentTypes`), served on the list
  response — never hardcoded client-side. As of 2026-08-12 the seeded list is:
  `PASSPORT` · `CID` ("CID (National ID)") · `AADHAAR_CARD` · `VOTER_CARD` ·
  `BIRTH_CERTIFICATE`. Widening it again = supersede the config
  ([set-identity-document-types.ts](../back_end/scripts/set-identity-document-types.ts) is the
  pattern); every dropdown moves on the next fetch, p16 enforces the allowlist server-side.
- **Returning-guest pull**: the profile-holder's most recent document number from an earlier
  booking auto-fills the first adult row (number only, persisted, "confirm it belongs to this
  guest" note).

### 1.3 One ID per guest (2026-08-12 ruling)

- Each guest has **one** operative ID photo. Only the **newest** photo per slot renders; a new
  capture/upload **replaces** it on screen. Older bytes stay in the write-once store as
  evidence but are no longer "the ID". Display semantics only — no backend change; the
  coverage gate's "has any photo" test is untouched.
- The desk row has **upload + phone-QR buttons only** (single-file input). The desk camera
  button was removed — photographing happens on the QR-handoff phone.
- Phone page wording follows: covered rows read "ID on file" with a **Retake** button.

### 1.4 Phone capture handoff (QR)

One tap on the desk mints a **scoped capture token** and shows a QR; a phone scans it and
photographs IDs with no staff login. Verified end-to-end (API + Puppeteer as a simulated phone).

**Token** ([identity-capture-token.ts](../back_end/src/lib/identity-capture-token.ts)):
signed JWT, same `JWT_SECRET` as staff sessions but a `purpose: "IDENTITY_PROOF_UPLOAD"`
discriminator means neither token kind can ever pass as the other. ~15 min TTL. Grants
**upload-only, one entry**, attributed to the minting operator. Worst case for a leaked QR:
a junk image lands on one booking, traced to the operator.

**Routes**:

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/entries/:id/identity-proofs/phone-token` | L1+ session | Mint. Body `{subjectKey?, subjectLabel?}` for one guest, or `{allSlots: true}` for the whole party. Returns `token`, `expiresAt`, `lanIps` (backend machine's IPv4s — the desk swaps them in for localhost so the QR is phone-reachable). |
| `GET /api/identity-capture/context?token=` | token only | What the phone shows: entry id, pinned guest or the full `roster`, per-slot photo counts, the guest's seated `room`. |
| `POST /api/identity-capture/upload?token=&subjectKey=&fileName=` | token only | Raw file bytes as the body. Funnels into the SAME `storeIdentityProof` (caps, store, trace) as the desk route. |

The token routes live on
[identity-capture/router.ts](../back_end/src/routes/identity-capture/router.ts), mounted
**before `parseActorHeaders()`** in the API router — the phone has no Bearer token and the
global auth middleware would 401 it otherwise.

**Slot mapping is server-enforced**: a single-guest token pins its slot (a query `subjectKey`
is ignored); an all-guests token requires `subjectKey` per photo and validates it against the
entry's derived party roster — no key or a non-party key 400s, and the stored label is
server-resolved, never trusted from the phone. Photos land on the right desk row **by
construction**.

**Phone page** ([capture/page.tsx](../front_end/src/app/capture/page.tsx), `/capture#<token>`):
- Token travels in the URL **hash** (never reaches server logs). Public route — the token is
  the whole credential; invalid/expired shows "ask the desk for a fresh code".
- Native camera via `<input capture="environment">` — **deliberately not getUserMedia**, which
  requires a secure context and black-screens over plain-HTTP LAN IPs. Preview + Retake happen
  before anything uploads; gallery upload as fallback.
- **All-guests mode** renders the party **grouped by room** — the room is the card ("Room 205"
  + bed/type + covered/total, green when complete) with its guests inside; per-guest
  Photo/Retake + gallery buttons; "Sent for Adult 5" receipts; counts resync from the server
  after each upload.
- Rooms come from the roster: `seatPartyByCompositionServer` in the identity-proof service is
  a **deliberate mirror** of the desk's `seatPartyByComposition`
  ([party-rooms.ts](../front_end/src/lib/desk/party-rooms.ts)) — operative comps-bearing quote
  (ACCEPTED > SENT/DRAFT > newest), band pools in party order via the live child-policy age
  bands, rooms in sealed order, adults → 6–10s → under-6s. **Keep the two in step** or the
  phone and desk would disagree about who sleeps where.

**Desk side**: per-row phone button + a "Use a phone for all guests" button above the table
(shown when the party has >1 slot). The QR modal shows the link text, expiry time, and a live
"N received" receipt — while it is open the shared `["identity-proofs", entryId]` query polls
every 3 s, so photos appear in the table the moment the phone sends them (the app-wide 5-min
`staleTime` would otherwise sit on the cache).

**Network reality (dev)**: the phone must reach the frontend on port 3001 —
`npm run dev:lan` / `npm run dev:firewall` in `front_end/` already cover binding + Windows
firewall. The Next proxy forwards `/api` to the backend server-side, so the phone only ever
talks to :3001.

### 1.5 S6 identity verification (dissolved into the table)

No boxed section. The **verification-path select sits above the table** (First-time /
Returning valid / Returning expired / VIP; defaults to VIP for VIP-tiered profiles, never
locked) and **"Record verification" is the table's bottom action**. Recording stamps
`identityVerifiedAt/By/Path` on the guest profile (trace `GUEST.IDENTITY_VERIFIED`) — the
vouching act that a human checked the documents against the guests; S6 readiness requires it
before "Check in & go live".

Locks on the button, in order:
1. **Coverage** — every guest needs a typed number OR an ID photo (the same server-computed
   verdict as the check-in gate). Amber hint counts progress. Exempt when the profile is
   VIP-tiered, **and skipped outright when the VIP path is selected** ("VIP path — no guest
   details needed" note). Note: selecting the VIP path only unlocks the *verification*; the
   check-in coverage gate itself stays keyed to the profile's `vipTier`.
2. **Path document** — FIRST_TIME needs the MAIN guest's (A0) document type + number in the
   table; RETURNING_EXPIRED needs the type. The panel has **no document fields of its own**
   (the table is the only place documents are typed); the hint names exactly what will be
   recorded ("Records Adult 1's document from the table above (Passport · T-99887)").

Backend `recordVerification` is unchanged — the desk sources required fields from the table.

### 1.6 What's traced

`GUEST.IDENTITY_PROOF_CAPTURED` (every photo, incl. phone uploads — note "Captured on a phone
via QR handoff"), `GUEST.IDENTITY_DETAIL_RECORDED` (every detail save),
`GUEST.IDENTITY_VERIFIED` (the vouching act). All carry entry/stage context and the acting
staff user (phone uploads attribute to the token's minting operator).

---

## 2. OCR roadmap (agreed 2026-08-12 — NOT yet built)

**Goal**: a stored ID photo auto-fills the guest-detail table (document type, number, name,
DOB, gender) as **suggestions the operator confirms**.

### 2.1 Hard rules (non-negotiable, agreed in discussion)

1. **OCR output is a suggestion, never a direct write.** The desk shows "Detected from photo:
   … — Apply"; Apply writes through the existing `saveGuestIdentityDetail`, so the coverage
   gate, p16 docType validation and traces work unchanged. Amber "detected — confirm" styling
   so machine output can't be mistaken for verified data. Precedent: the returning-guest pull.
2. **OCR never touches `identityVerifiedAt`** — evidence, not verification.
3. **OCR runs in the backend** (business-logic-in-backend rule — the production frontend gets
   it for free). Async/best-effort, never in the upload request path.
4. **Detected document types must map into the `identity.documentTypes` vocabulary** (p16
   allowlist) — never invented codes.
5. **No guest ID leaves the hotel's server without an explicit privacy ruling** (see §2.4).

### 2.2 Phase A — passports via MRZ (build first)

The MRZ (two OCR-B lines at the bottom of every passport) is machine-readable by design and
carries **check digits**: `tesseract.js` (or native tesseract) + an MRZ parser yields document
number, full name, DOB, sex, nationality, expiry with *verifiable* confidence — a passing
check digit proves the field. Local, free, no cloud. Given the guest mix (Indian/foreign
passports), this alone covers a lot. A transformer model adds nothing here — don't use one
for MRZ.

### 2.3 Phase B — non-MRZ documents (CID, Aadhaar, voter card…) via a local VLM

Bhutanese CID cards (and most of the newly-added types) have no MRZ; plain-layout tesseract
is hit-or-miss. The agreed default is a **small vision-language model run locally** through
**`@huggingface/transformers` (transformers.js)** — ONNX models in Node via
`onnxruntime-node`, no Python sidecar. Candidates: Florence-2 (light), quantized Qwen2-VL
2B, SmolVLM. Prompted zero-shot: "read this ID card, return name / ID number / DOB as JSON".

- **Not TrOCR** (line recognizer only — needs a detector + layout logic and still returns
  unmapped strings) and **not Donut** (needs fine-tuning on a labeled CID dataset).
- **Runs as a pg-boss worker** (a "W39 OCR worker"): picks up new photo rows, extracts,
  stores suggestions. CPU-only inference (5–30 s/image, 2–4 GB RAM, one-time model download)
  is fine because it is background prefill, never blocking.
- **Mandatory spike before committing**: run the candidate models over 10–15 real CID photos
  (glare, skew, desk conditions) and count usable fields. If a small VLM only gets 4/10
  right, ship MRZ-only and leave CID manual. CID cards carry Dzongkha + English; only the
  English fields are expected to extract.
- A VLM can hallucinate a plausible number — which is exactly why rule §2.1.1 exists.

### 2.4 Cloud option — explicitly gated

AWS Textract AnalyzeID / Azure Document Intelligence / Claude vision would all extract more
accurately, but they mean **sending guests' government IDs to a third-party cloud**. This
system stores everything locally by design (photos never even enter Postgres), so cloud OCR
is a deliberate hotel-level privacy decision, not a default. If it is ever approved, it slots
in as an accuracy upgrade behind the same suggestions-only contract.

### 2.5 Implementation sketch (when built)

- Suggestions storage: a JSON column or sibling row keyed to the photo's
  `GuestIdentityDocument` id (`{fields, confidence, engine, extractedAt}`), exposed on the
  list response per slot.
- Trigger: post-upload hook enqueues the worker job; also a manual
  `POST /api/identity-proofs/:id/ocr` for re-runs.
- Desk UX: under a guest row with an unapplied suggestion, an amber strip "Detected: Passport
  · E1234567 · TENZIN DORJI · 1990-01-01 — Apply / Dismiss". Apply = `saveGuestIdentityDetail`.
- HEIC caveat: iPhones may store HEIC; tesseract/ONNX pipelines need JPEG/PNG — convert
  server-side (libheif) or have the phone page request JPEG (Safari transcodes on file input).
- MRZ fields that pass check digits can be marked high-confidence (green instead of amber);
  VLM fields always amber.

---

## 3. Live-verification log (2026-08-12)

All exercised against the running app (API suites + Puppeteer driving the desk and the
capture page as a simulated phone):

- Phone flow: mint → QR context → upload → desk table + live "received" receipt; auth-less
  mint refused; garbage/expired tokens 403 on both routes; stored bytes round-trip
  checksum-verified; LAN-IP substitution produced a phone-reachable QR from a localhost desk.
- All-guests mode: roster renders grouped by room; an upload picked for "Adult 6" filed under
  slot A5 server-side; keyless/non-party uploads 400; single-slot tokens ignore a query
  subjectKey.
- Rooms: server seating matched the desk table exactly (A0→205 on both).
- One-ID rule: desk camera button gone; at most one thumbnail per guest; phone shows
  "ID on file"/"Retake".
- Verification: panel dissolved (select above / button below the table); locked at 7/12
  coverage; VIP path unlocks directly; switching back re-locks.
- Document types: five codes served; `AADHAAR_CARD` saves; unknown codes 409 via p16.
