# Guest ID capture — uploads, phone handoff, and OCR / QR extraction

**Status (2026-08-18):** everything in §1 is **built and verified live**. §2 Phase A —
passport MRZ + Aadhaar QR extraction, on the phone AND server-side, suggestions the desk
applies — is **built and verified live**; §2.3 Phase B (CID / voter card / birth certificate
via Florence-2 layout OCR + label anchoring, in an isolated child process) is **built and
verified on synthetic cards** — its ship-or-not for real CIDs waits on the spike over real
photos (`scripts/ocr-spike.ts`).

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

### 1.2 The guest-detail table (desk, S5 + S6 + S7)

[identity-proof.tsx](../front_end/src/components/desk/workspace/identity-proof.tsx)
(`IdentityProofBlock`) renders on Arrival (collapsible, collapsed by default), Check-in
(always open, gate surface) and — since 2026-08-21 — the **Stay** step (collapsible; a
correction surface for details captured earlier, per the operator's "sometimes guest detail
can be put in S5 and later made changes in S7 or S6"). Columns: Document type · Document no · Name · DOB · Gender ·
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
- **Confirm / Make changes (2026-08-21 ruling)**: a guest's row is CONFIRMED by the operator
  and becomes read-only — every input disables (values stay readable: dashed, cream, full
  contrast) and the backend refuses writes to it (`GUEST_DETAILS_CONFIRMED`, 409) — until it
  is explicitly unlocked with **Make changes**. Durable on the detail row itself
  (`GuestIdentityDocument.detailsConfirmedAt/By`), so a guest confirmed at Arrival is still
  locked at Check-in and during the Stay, on any terminal. **One control for the whole table,
  below it** (same-day second ruling — no per-row buttons): **Confirm guest details** locks
  every row with something on file; once locked the same spot offers **Make changes**, which
  unlocks them all. Locked rows carry a 🔒 glyph by the name. The S6 **Record identity
  verification** button beneath it is a different act (stamps `identityVerifiedAt`, the p16
  check-in gate) and locks nothing — but its **guest type (verification path) select is part
  of the same edit mode**: visible whenever the table is unlocked, seeded from the recorded
  path, and a different pick offers **Update identity verification** (re-stamps the path;
  the backend has no already-verified guard).
  Confirming FLUSHES the row's unsaved inputs first, so the last keystroke and the lock can't
  race. A locked row also blocks the OCR strip's **Apply** (with the reason) and the
  returning-guest pull. Photo capture stays available — a new photo is evidence, not a change
  to the typed details. Endpoint `POST /api/entries/:id/identity-details/confirm` (L1+, body
  `{subjectKeys[], confirmed}`) → `setGuestIdentityDetailConfirmation`; slots with nothing on
  file are SKIPPED and named back (`NOTHING_RECORDED`) rather than confirmed empty, and a
  photo-only slot gets a bare detail row minted to carry the confirmation. Traces
  `GUEST.IDENTITY_DETAILS_CONFIRMED` / `_UNLOCKED`.

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

## 2. OCR / QR extraction — Phase A BUILT 2026-08-18 (passports + Aadhaar); Phase B open

**Goal**: a stored ID photo auto-fills the guest-detail table (document type, number, name,
DOB, gender) as **suggestions the operator confirms**.

### 2.1 Hard rules (non-negotiable, agreed in discussion — all enforced by the build)

1. **OCR output is a suggestion, never a direct write.** The desk shows an amber "Detected
   from the passport strip / the card's QR … — Apply / Dismiss" strip under the guest's row;
   Apply writes through the existing `saveGuestIdentityDetail`, so the coverage gate, p16
   docType validation and traces work unchanged. Precedent: the returning-guest pull.
2. **OCR never touches `identityVerifiedAt`** — evidence, not verification.
3. **The server is the brain.** Every interpretation — MRZ parse + check digits, Aadhaar QR
   unpack, document-type mapping — runs in the backend (business-logic-in-backend rule; the
   production frontend gets it for free). The PHONE is a sensor: it may decode the QR / OCR
   the MRZ on the device, but it sends the RAW payload and the server re-parses it. Server-side
   reading of stored bytes is async (W39 worker), never in the upload request path.
4. **Detected document types must map into the `identity.documentTypes` vocabulary** (p16
   allowlist) — an unmapped code is dropped, never invented. Enforced in `sanitiseFields`.
5. **No guest ID leaves the hotel's server without an explicit privacy ruling** (see §2.4).
   Traces carry field NAMES + confidence, never the values.

### 2.2 Phase A — passports via MRZ + Aadhaar via QR (BUILT 2026-08-18)

- **Schema**: `IdentityOcrSuggestion` (migration `20260818100000`) — one row per photo
  (`photoDocumentId @unique`, cascades with the photo so the retention purge disposes of
  both), `engine` (PHONE_QR · PHONE_MRZ · PHONE_MANUAL · SERVER_QR · SERVER_MRZ), `status`
  (PENDING · READY · EMPTY · FAILED · APPLIED · DISMISSED), `fields` JSON, `fieldConfidence`
  JSON per field (**VERIFIED** = proven by the document — an MRZ field whose check digit
  passed; **READ** = decoded/recognised/typed, not provable), `raw` (the MRZ lines / QR text
  the server parsed — reproducible), `error`, applied/dismissed stamps. Deliberately a
  sibling of the write-once photo row, not a JSON column on it.
- **Parsers** ([back_end/src/lib/identity-ocr/](../back_end/src/lib/identity-ocr/)):
  `mrz.ts` — line cleaning (MRZ charset only), `extractMrzLines` (pulls the 2×44 / 2×36 /
  3×30 zone out of free OCR text), `parseMrzLines` via the `mrz` package (ICAO 9303, per-field
  check digits), 2-digit-year pivot, title-cased name; `aadhaar-qr.ts` — legacy XML
  (`PrintLetterBarcodeData`, full number) and **Secure QR** (big-integer → bytes → gzip →
  0xFF-separated fields; V1–V4 markers; carries only the LAST FOUR digits, surfaced as
  `documentNumberLast4`); `server-extract.ts` — jsQR over sharp's raw pixels (two sizes),
  then tesseract.js over a preprocessed lower-45% crop (grayscale/normalise/threshold, MRZ
  whitelist, PSM single block), full-page fallback. **OCR-B model**: `ocrb.traineddata` in
  `OCR_TESSDATA_DIR` (default `./storage/tessdata`) is used automatically (fetch it with
  [fetch-ocrb-traineddata.ts](../back_end/scripts/fetch-ocrb-traineddata.ts) — the generic
  `eng` model confuses the `<` filler with K/L and reads Z as 2; OCR-B reads the specimen
  perfectly in ~1 s), else `eng` auto-downloads once. Local only — no cloud.
- **Service** [identity-ocr-service.ts](../back_end/src/services/domain/identity-ocr-service.ts):
  `previewPhoneExtraction` (parse-only, nothing stored — what the phone shows before send),
  `ingestPhoneExtraction` (raw payload re-parsed server-side; the phone's own edits layered on
  as READ — an edited MRZ field loses its VERIFIED mark), `runServerExtractionForPhoto` (W39;
  skips photos that already carry a phone READY / APPLIED / DISMISSED suggestion unless forced;
  `OCR_DISABLE=true` switches it off), `applyOcrSuggestion` (→ `saveGuestIdentityDetail`,
  gender M/F/X → MALE/FEMALE/OTHER, optional operator overrides), `dismissOcrSuggestion`,
  `listOcrSuggestionsForEntry`. Traces `GUEST.IDENTITY_OCR_SUGGESTED / _APPLIED / _DISMISSED`.
- **Worker**: `IDENTITY_OCR_W39` queue ([w39-identity-ocr-worker.ts](../back_end/src/workers/w39-identity-ocr-worker.ts),
  batchSize 1 — tesseract + sharp are heavy and this is background prefill). Enqueued by the
  desk upload route immediately, by the phone upload route with a 45 s head start when the
  phone says `extractionFollows=1` (so the colder server pass never overwrites the phone's
  live-camera reading), and by the manual re-run route.
- **Routes**: staff (L1) — `GET /api/entries/:id/identity-proofs` now carries `suggestions`;
  `POST /api/identity-proofs/:id/ocr` (re-run, 202); `POST /api/identity-ocr-suggestions/:id/apply`
  (`{overrides?}`) · `/dismiss`. Phone (capture token, no session) —
  `POST /api/identity-capture/parse` (`{ocrText?, mrzLines?, qrText?}` → fields, no storage),
  `POST /api/identity-capture/extraction` (`{photoDocumentId, mrzLines?, qrText?, fields?}`;
  the photo must belong to the token's booking and, on a single-slot token, its slot);
  the context response gained `documentTypes` for the phone's form.
- **Phone page** ([capture/page.tsx](../front_end/src/app/capture/page.tsx) +
  [lib/phone-id-reader.ts](../front_end/src/lib/phone-id-reader.ts)): after a photo is taken the
  page decodes it to a canvas (≤1800 px; the downscaled JPEG is what uploads), runs jsQR, and if
  no QR OCRs the lower part with tesseract.js **in the browser** (worker + SIMD-LSTM core served
  from `/tesseract`, `/tesseract-core` — copied from node_modules by the `postinstall`
  script [copy-tesseract-assets.mjs](../front_end/scripts/copy-tesseract-assets.mjs); OCR-B model
  from `/tessdata` when present, else CDN `eng`), posts the raw text to `/parse`, and shows a
  **"Read from the passport strip / the card's QR"** card with editable Document / Number /
  Name / DOB / Gender and green **✓ verified** marks on check-digit-proven fields; nothing
  readable → "Type the details" so the phone can still fill the row by hand. Send = upload
  (`extractionFollows`) then `/extraction` with raw + confirmed fields. The tesseract worker is
  warmed while the person frames the shot. All best-effort — a phone that can't read simply
  sends the photo and the server pass reads it. (Auto-pick of the relaxed-SIMD core aborted in
  headless Chromium — the plain SIMD-LSTM build is pinned.)
- **Desk** ([identity-proof.tsx](../front_end/src/components/desk/workspace/identity-proof.tsx)):
  the strip under a guest's row for the NEWEST photo's suggestion — amber, "Detected from the
  passport strip (read on the phone): Passport ✓ · L898902C3 ✓ · Anna Maria Eriksson ✓ · DOB … ·
  Female ✓ — Apply / Dismiss"; a muted "Reading the ID photo…" while PENDING (the list polls
  every 3 s while anything is pending); a scan-line button on each covered row re-queues the
  server read. Apply refreshes the row from the saved detail (touched-guard reset).
- **Verified live 2026-08-18** (API + Puppeteer, ICAO specimen passport rendered to JPEG):
  phone parse → upload → extraction → desk list READY PHONE_MRZ, all six fields VERIFIED →
  Apply → detail row PASSPORT / L898902C3 / FEMALE / 1974-08-12; desk upload with no phone
  reading → W39 → READY SERVER_MRZ within seconds; garbage token 403; another slot's photo
  403; a bogus `documentType` from the phone is dropped; in-browser tesseract on the phone
  page reads the specimen ("Read from the passport strip", 5 ✓ verified) and the desk strip
  renders + applies.

### 2.3 Phase B — non-MRZ documents (CID, voter card, birth certificate) — BUILT 2026-08-18, spike PENDING real photos

The pipeline is built and runs behind the QR/MRZ passes; what is still open is the **spike
verdict on real CID photos** (none are in `storage/` yet — the only phone capture on file is a
BPC-bill test shot). Ship-or-not for CID auto-fill is decided by `scripts/ocr-spike.ts` the
day 10–15 real cards are photographed at the desk (rule §2.3.3 below).

- **Engine: Florence-2** (`onnx-community/Florence-2-base-ft`, ~0.23 B, task
  `<OCR_WITH_REGION>`) through `@huggingface/transformers` + onnxruntime-node —
  [lib/identity-ocr/layout-ocr.ts](../back_end/src/lib/identity-ocr/layout-ocr.ts). Chosen over
  a VLM per the 2026-08-18 review: the card prints English labels, so OCR-with-regions plus
  anchoring is enough, and it is an order of magnitude lighter. Probe on the one real phone
  photo we have (a 4032×3024 receipt, rotated 90°): every line read correctly in 4.3 s;
  a photo-like synthetic CID (rotated, blurred): all six fields (ID No, name, DOB, sex,
  dzongkhag, expiry) read and anchored, ~5–7 s end-to-end including the QR + MRZ passes.
  dtype: fp32 vision encoder + embeddings (fp16 fails to initialise on CPU onnxruntime),
  q4 text encoder/decoder. Model (~800 MB) downloads ONCE into `OCR_MODELS_DIR`
  (default `./storage/models`, gitignored) — the first-ever run needs internet and minutes;
  every later load is seconds. **sharp is pinned to 0.34.5** so transformers.js and the app
  share ONE libvips — two sharp versions in one process clash ("colourspace: parameter space
  not set"); the RawImage is built from our sharp's raw RGB rather than transformers' own
  decoder for the same reason.
- **Process isolation**: the model runs in a forked child
  ([layout-ocr-child.ts](../back_end/src/lib/identity-ocr/layout-ocr-child.ts)) — lazily
  started, killed after 10 min idle, restarted on the next photo, 180 s per-request timeout,
  crash → FAILED suggestion, never a dead API. Verified: child ~1.46 GB resident, API process
  ~290 MB. `OCR_LAYOUT_INPROCESS=true` runs inline (spike script / tests).
- **Fallback**: `OCR_LAYOUT_ENGINE=tesseract` (or Florence unavailable) → tesseract `eng`
  whole-page OCR into the same parser — noticeably worse on photographed cards.
  `OCR_LAYOUT_ENGINE=off` disables the layout pass entirely.
- **Parser** [lib/identity-ocr/layout-parse.ts](../back_end/src/lib/identity-ocr/layout-parse.ts):
  document kind by weighted keyword vote (title phrases weigh 2 — "CITIZENSHIP IDENTITY CARD",
  "ELECTOR'S PHOTO IDENTITY", "BIRTH CERTIFICATE", "AADHAAR", "PASSPORT"; issuer words 1;
  "GOVERNMENT OF INDIA" 0.3; ties → unknown), then per-kind **label anchors** — the value is
  the remainder of the label's line, else the next non-label line (Florence often returns
  label and value as separate regions) — with **loose** patterns accepted without a label
  where the shape is distinctive (11-digit CID number, EPIC `ABC1234567`). Dates tolerate
  OCR spaces ("12/08 /2030"), day-month-year words, ISO; gender M/F/X; names title-cased and
  label fragments ("of the Child") rejected. Every value is READ (never VERIFIED). A desk row
  that already names the type is passed as `kindHint` (skips detection). Regions are sorted
  into reading order (rows by centre-y within half a line height, then x).
- **Wiring**: `extractIdentityFromImage` = QR → MRZ → layout; engine `SERVER_LAYOUT`,
  `raw.source = "LAYOUT CID via FLORENCE2 (5466 ms)"`, `raw.ocrLines` (first 60) kept for
  reproducibility; the desk strip reads "Detected by reading the card". Verified live: desk
  upload of the synthetic CID → W39 → READY SERVER_LAYOUT (all fields) → Apply → detail row
  CID / 11410001234 / Tenzin Dorji / MALE / 1990-08-12.
- **Spike script** [scripts/ocr-spike.ts](../back_end/scripts/ocr-spike.ts):
  `npx tsx scripts/ocr-spike.ts <folder-or-file> [--tesseract] [--json out.json]` — runs the
  full pipeline over a folder, prints per file the engine, fields, confidence and the OCR
  lines the parser saw, and a tally (files with ≥2 / all 3 of number+name+DOB). Nothing is
  written to the DB. **Gate (rule §2.3.3): on 10–15 real CID photos, fewer than half with
  ≥2 usable fields → keep CID manual (set `OCR_LAYOUT_ENGINE=off`)** — the desk still types.
  Also compare `--tesseract` on the same photos.
- **Not done / next**: (a) the real-photo spike itself; (b) Dzongkha text is ignored by design
  (only the English fields are expected to extract); (c) if the spike fails on glare/skew,
  the next lever is a perspective de-warp before OCR (find the card quadrilateral, warp to
  a rectangle) — not a bigger model; (d) a VLM (Qwen2-VL 2B / SmolVLM) stays the last resort.

**Widened 2026-08-17 (operator report: a Bhutanese work permit read "nothing"):**

- **Work permit is a first-class layout kind.** `LayoutDocKind` gained `WORK_PERMIT`
  (keywords "WORK PERMIT" 2 / Job Category / Employer / Dept. of Immigration 1 each —
  "KINGDOM OF BHUTAN" weighs 1 on BOTH it and CID, the title phrase separates them; verified
  the CID text still detects as CID). Anchors: Name / DoB / Nationality (new `cleanNationality`)
  / Sex / "Valid Date" → expiryDate, and the **12-digit permit number printed without a label**
  via a loose `\d{11,13}`. `WORK_PERMIT` was added to `identity.documentTypes` +
  `identity.retentionPeriodDays` (seed + `set-identity-document-types.ts`, applied to the live
  DB 2026-08-17), so the type survives `sanitiseFields`, appears in every dropdown, and passes
  p16 on apply. Verified end-to-end: a synthetic work-permit photo → Florence-2 →
  `WORK_PERMIT` + number + name + DOB + nationality.
- **Any ID's QR code now yields what it can** (operator ruling: "shouldn't be limited to
  Aadhaar and passports"). `aadhaar-qr.ts` gained `parseGenericQrText` — JSON payloads,
  XML attributes, key:value text, verification-URL query params, or a bare identifier, mapped
  through a key-alias table (name/dob/sex/permitNo/epic/…), all READ. `parseIdentityQrText` =
  Aadhaar first, then generic. In `extractIdentityFromImage` an **Aadhaar QR still
  early-returns** (it is the whole record) but a **generic QR is held and MERGED over the
  layout pass** — QR values win on overlap (exact decode beats OCR) except `documentType`,
  which the layout's keyword vote knows better; a generic QR alone (no readable layout) is
  still suggested as `SERVER_QR`.
- **The phone tells the truth about QRs it can't interpret**: `previewPhoneExtraction` returns
  `raw.source = "QR_UNRECOGNISED"` when a QR was decoded but carried nothing recognisable, and
  the capture page says "QR code found — no guest details inside it" instead of the flat
  "nothing readable" (plus: an "Analysing the document…" spinner during the read, and a
  standing tip card before the first shot explaining that QR codes and passport strips read
  automatically — the reader was invisible until it fired).
- **The phone auto-fills for EVERY document type — server analyze before send** (operator
  ruling: "the phone should act like an OCR machine"). The phone's own pass covers only QR +
  MRZ; when it yields nothing, the capture page now POSTs the previewed (downscaled) photo to
  `POST /api/identity-capture/analyze` (token-scoped, raw bytes, **nothing stored**) →
  `analyzeIdentityImage` in [identity-ocr-service.ts](../back_end/src/services/domain/identity-ocr-service.ts)
  runs the full `extractIdentityFromImage` pipeline (QR → MRZ → Florence-2 layout, same kind
  hint as W39) and returns sanitised fields — the phone form fills in (~8–20 s, spinner subtext
  "reading the printed text — takes a moment") for the person to confirm BEFORE sending.
  Fallbacks preserved: analyze fails/offline/`OCR_DISABLE` → the old type-or-send flow, and
  the W39 pass still covers every uploaded photo (skipped only when the phone's confirmed
  suggestion already landed). The concurrent-phone case is safe — the layout child queues
  requests by id. After an analyze that found nothing, the page says so honestly ("The QR,
  passport strip and printed text were all tried") instead of promising the desk will do
  better. Verified live: token mint → analyze with a synthetic work permit → all six fields in
  ~8 s; bogus token 403.
- **Kind hint no longer overrides detection** (found live via the analyze test: a work permit
  analysed under a CID-named desk row parsed as CID). `parseLayoutText` now runs
  `detectLayoutDocKind` FIRST and uses `kindHint` only when detection fails — the document's
  own title outranks what the desk row happens to say.
- **Bilingual certificates anchor value-above-label** (operator report: a real Karnataka
  Form-5 birth certificate read wrong). Form-5 prints the value beside the KANNADA label with
  the English label alone BELOW it, so `anchorField` now scans candidates rest → next 2 lines
  (stop at another label) → **previous 3 lines** (skip other labels' lines). Hardened
  alongside: `cleanIdNumber` rejects digit-less words ("REGISTRATION") and date-shaped values;
  `cleanName` cuts at a following label word (merged OCR rows) and rejects stray MALE/FEMALE;
  the BC number anchor lost its bare "No." label (it matched "Flat **No** E-006" in the
  parents' address) and gained a loose slash-separated shape
  (`613357/V/B/2015/001334`-style); the generic Name anchor no longer fires on "Name of
  Mother/Father". Verified: parse-level on both plausible Florence reading orders (all four
  fields exact) + CID/WP/voter regressions, and image-level through Florence-2 on a synthetic
  Form-5 (kind + DOB + gender right; name/number fidelity tracks OCR quality of the photo).

### 2.4 Cloud option — explicitly gated

AWS Textract AnalyzeID / Azure Document Intelligence / Claude vision would all extract more
accurately, but they mean **sending guests' government IDs to a third-party cloud**. This
system stores everything locally by design (photos never even enter Postgres), so cloud OCR
is a deliberate hotel-level privacy decision, not a default. If it is ever approved, it slots
in as an accuracy upgrade behind the same suggestions-only contract.

### 2.5 Operational notes

- **HEIC**: the phone page decodes via `createImageBitmap` and uploads a JPEG; iPhones hand
  JPEG to a file input by default. A HEIC that reaches the server is stored (write-once) but
  sharp without libheif can't read it — the suggestion lands FAILED and the desk types.
- **Model files are gitignored** (11 MB OCR-B + the WASM cores): run
  `npx tsx scripts/fetch-ocrb-traineddata.ts` from `back_end/` once per machine (writes both
  `back_end/storage/tessdata/` and `front_end/public/tessdata/`); `npm install` in
  `front_end/` copies the tesseract worker/cores into `public/`.
- **Env**: `OCR_DISABLE`, `OCR_TESSDATA_DIR`, `OCR_MRZ_LANG` — see `.env.example`.
- Aadhaar Secure QR signature verification (UIDAI certificate) is NOT performed — hence READ,
  not VERIFIED, on QR fields.

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
