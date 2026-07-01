# LEGPHEL PMS — DEV-SPEC-001
# Part 9 — Controllers and Routes
# §9.1 through §9.4

| Attribute | Value |
|---|---|
| Document | DEV-SPEC-001 |
| Part | 9 — Controllers and Routes |
| Version | 1.0-DRAFT |
| Date | 08 April 2026 |
| Status | DRAFT — Pending Architect Review |
| Declared sources | DEV-SPEC-001_ToC_FINAL.md (§§9.1–9.4); DEV-SPEC-001-Part1.md; DEV-SPEC-001-Part2.md; DEV-SPEC-001-Part3.md; DEV-SPEC-001-Part5.md; DEV-SPEC-001-Part6.md; DEV-SPEC-001-Part7.md |

---

## §9.1 — Controller Design Principles

### 9.1.1 The Controller's Role

Controllers are thin HTTP adapters. Their function is limited to three operations in strict sequence:

1. Parse and extract the inbound HTTP request (path parameters, query parameters, request body).
2. Invoke the correct service method with the extracted parameters.
3. Format the service response into the standard response envelope and return it.

No other code belongs in a controller. No business rule evaluation. No policy invocation. No state machine logic. No financial computation. No authority decision. No direct database access. Every one of these concerns lives in the service layer, where it is independently testable and consistently enforced regardless of how the service is called.

A controller that contains a conditional implementing a business rule is an architectural violation. The rule belongs in the service or policy layer.

### 9.1.2 The Invariant Pattern

Every controller method follows this pattern without exception:

```
HTTP Request
    ↓
Auth middleware  (validates session, extracts actor identity and level)
    ↓
Validation middleware  (validates DTO shape, required fields, type constraints)
    ↓
Controller handler  (extracts params → calls service → formats response)
    ↓
Service (enforces all business logic, policies, state machines)
    ↓
Standard response envelope returned
```

No endpoint may bypass either middleware. No middleware may be registered out of order. Auth executes before validation; validation executes before the controller handler. The controller handler never receives an unauthenticated request. The controller handler never receives unvalidated input.

### 9.1.3 Controller-Level Forbidden Patterns

The following patterns are absolutely forbidden in controller code. Each, if found in the codebase, is an architectural defect requiring correction.

**Business logic in controllers.** Controllers do not contain conditionals that implement business rules, policy checks, state machine logic, financial calculations, or authority decisions. Any conditional in a controller that is not purely about request parsing or response formatting belongs in the service layer.

**Bypassing auth middleware.** Every endpoint passes through auth middleware before the controller handler executes. No `router.get()`, `router.post()`, or equivalent registration may omit the auth middleware from its middleware chain. An endpoint exposed without auth middleware is a security and audit violation.

**Bypassing validation middleware.** Input validation executes before the controller handler. No controller handler may receive unvalidated input. Ad-hoc validation checks inside the controller handler — checking for the presence of a field that validation middleware should have already verified — indicate that the validation middleware is incomplete, not that inline validation is acceptable.

**Non-standard response envelope.** All API responses follow the standard response envelope defined in §9.3.1. No controller may return a raw object, a naked array, or an error message without the typed error envelope. Inconsistent response shapes break the mechanical derivation chain from this spec to consumer code.

**Controller managing transactions.** Database transaction management belongs in the service layer. A controller that opens, commits, or rolls back a Prisma `$transaction` is violating layer separation. The service layer ensures that trace events and state changes are committed atomically.

### 9.1.4 Service Method Naming Convention

Every route entry in §9.4 states the exact service method name. These names are derived from Part 6 (§§6.5–6.7) and must be used verbatim in implementation. A controller that calls a service method by a different name than what is stated in §9.4 has introduced a naming inconsistency that breaks the audit trail.

---

## §9.2 — Middleware

### 9.2.1 Auth Middleware

**Purpose:** Validates that every incoming request carries a valid authenticated session and extracts the actor identity and authority level for downstream use.

**Implementation:**

The auth middleware chain consists of two steps, executed in order:

1. **PIN-session validation.** The request must carry a valid JWT token issued by `SessionService.authenticate()`. The middleware validates the token signature, checks the `SessionRecord.status` (must be `ACTIVE`; `IDLE_LOCKED` and `MANUALLY_LOCKED` sessions reject the request with `401 Unauthorized`), and confirms the token has not expired.

2. **Actor extraction.** From the validated token, the middleware extracts: `actorId` (the individual staff member's `StaffUser.id`), `actorLevel` (the `ActorLevel` enum value from `StaffUser.actorLevel`), and `terminalId`. These values are attached to the request context object and made available to the controller handler and all downstream service calls.

**Enforcement rules:**

Every router registration in the Express application must include the auth middleware in its chain before any controller handler function. No exception is permitted for any route. A route registered without auth middleware is a security and audit violation regardless of the handler's intent.

The `SYSTEM` actor (`ActorLevel.SYSTEM`) is an internal identity used by workers and automated processes. No HTTP endpoint accepts a request asserting `ActorLevel.SYSTEM` as the caller's identity — system actors do not make inbound HTTP requests.

The `EXTERNAL` actor level has no system access. No HTTP endpoint is accessible to external actors (coordinators, agents, guests). All external-actor requests are initiated by operational staff as system actors.

**Error response:** `AuthorizationError` with `statusCode: 401`.

### 9.2.2 Validation Middleware

**Purpose:** Validates the shape, required fields, and type constraints of every inbound request before the controller handler executes.

**Implementation:**

Validation middleware executes after auth middleware and before the controller handler. For every route, a named Request DTO is declared. The validation middleware validates the inbound request body, path parameters, and query parameters against that DTO's schema.

Schema-level validation uses the Prisma-generated enum types from Part 2 §2.1.3 as the authoritative source for enum field validation. A request body containing an enum value not defined in the Prisma schema is rejected with `ValidationError` before reaching the controller handler.

**Validation failures** produce `ValidationError` with field-level detail: `{ field, value, constraint, message }` per field that failed validation. A request with multiple invalid fields produces a single `ValidationError` listing all failed fields — validation does not short-circuit on the first failure.

**No controller-level ad-hoc validation.** If a controller handler contains validation logic (presence checks, type checks, format checks), that logic belongs in the validation middleware for that route. The controller handler receives a validated request and must not redundantly re-validate it.

### 9.2.3 Concurrent Editing Middleware

**B4-001 — Category 1 Clarification Request (blocks §9.2.3 finalisation)**

> **This section is incomplete and blocked.** The concurrent editing protection mechanism is a Category 1 open item registered in the Spec Ambiguity Register as B4-001. The doctrine is stated below; the technical mechanism requires Architect deliberation before implementation proceeds. This section is written up to the point of mechanism selection and stops there.

**The doctrine (non-negotiable, mechanism-independent):**

When two authenticated sessions attempt to edit the same operational record simultaneously, the system must guarantee three invariants:

1. **No silent data loss.** One edit must not silently overwrite the other without either editor being informed.
2. **No silent override.** The second editor must not see a stale version of the record and commit changes on top of it without knowing the record has changed since they opened it.
3. **No ambiguous composite state.** The system must never end up in a state that combines partial changes from two concurrent edits in a way that is internally incoherent.

When a concurrent edit conflict is detected, the system throws `ConcurrentEditingError` with the context payload: `{ entityType, entityId, currentEditorSession, conflictDetectedAt, resolution }`. The error is surfaced to the actor who encounters the conflict. No conflict may result in silent data loss.

**The three candidate mechanisms — tradeoffs for Architect deliberation:**

**Candidate A — Optimistic Locking**

A `version` integer field is added to frequently-edited records (at minimum: `Entry`, `WorkOrder`, `Quotation`). When a client reads a record, the current `version` is returned in the response. When the client submits an update, the current `version` is included in the request body. The service constructs the Prisma update as:

```javascript
await prisma.entry.update({
  where: { id: entryId, version: suppliedVersion },
  data: { ...updates, version: { increment: 1 } }
});
// If count === 0: version mismatch → throw ConcurrentEditingError
```

If no rows are updated (the record's version has advanced since the client read it), `ConcurrentEditingError` is thrown. The client must re-read the record and re-apply their changes.

Tradeoffs: Simple to implement; works natively with Prisma; no additional infrastructure. Requires all clients to carry and supply the version on update. Conflict is detected at commit time — the second editor discovers the conflict only when they attempt to save. No real-time awareness that another editor is present.

**Candidate B — Presence Indicator**

A lightweight session-presence table records which staff member is currently viewing or editing which record. When a second staff member opens the same record for editing, the system informs them: "Staff X is currently editing this record." Neither editor is blocked — the presence indicator is advisory, not a hard lock.

If both editors commit, the conflict is detected either by an underlying optimistic lock (Candidate A) or by a server-side merge evaluation. Without an underlying lock, this candidate alone does not satisfy the no-silent-override invariant.

Tradeoffs: Provides real-time awareness before the conflict arises. Requires a real-time channel (WebSocket or polling) to keep presence state current. More infrastructure complexity. Does not independently satisfy the doctrine without a complementary locking mechanism.

**Candidate C — Micro-Hold**

When a staff member opens a record for editing, a short-duration pessimistic lock is placed (analogous to a `ProcessingLockRecord` but scoped to record-level editing, not inventory booking). Other authenticated actors who attempt to open the same record for editing during the lock period receive an informational message: "Staff X is currently editing this record." They may view it read-only; they may not open it for editing until the lock expires or is released.

On lock expiry (configurable short TTL — e.g., 5 minutes of inactivity releases the lock), the record becomes editable by other actors. The lock is released on save, cancel, or navigation away from the edit view.

Tradeoffs: Prevents the conflict entirely — the second editor cannot begin an edit that would conflict. Requires TTL management and a lock-release signal from the client. Adds latency to multi-user editing scenarios. Most robust guarantee of the three candidates against composite state.

**Category 1 flag:** The Architect must deliberate and select one of Candidates A, B, or C (or a hybrid combination) before §9.2.3 is considered final and before concurrent-editing protection is implemented. The gate writer does not choose. Implementation proceeds without concurrent editing middleware until this decision is locked.

When the mechanism is selected, this section will be amended to specify: the middleware name, its position in the middleware chain (after auth, before the controller handler, on all write routes), the exact schema changes required (if any), the DTO fields carrying the version or lock token, and the `ConcurrentEditingError` throwing condition.

### 9.2.4 Rate Limiting Middleware

**Purpose:** Protects individual endpoints from request flooding and enforces per-actor and per-endpoint request rate limits.

**Implementation:**

Rate limiting is applied at the Express middleware layer, before the controller handler. The middleware evaluates the inbound request's authenticated actor identity (extracted by auth middleware) and the endpoint path. If the actor's request rate for the endpoint exceeds the configured limit, the middleware returns `429 Too Many Requests` before the controller handler executes.

Rate limits are configured per endpoint category:

| Category | Default Limit | Notes |
|---|---|---|
| Standard operational endpoints | 120 requests/minute per actor | Entry, folio, handoff, dispute operations |
| Search and list endpoints | 60 requests/minute per actor | Availability search, entry list, profile search |
| Night audit trigger | 5 requests/minute per actor | Prevents accidental multiple runs |
| Auth endpoints | 10 requests/minute per terminal | Prevents PIN brute force; applies before actor extraction |
| AI draft action endpoints | 30 requests/minute per actor | Approve, reject, edit-and-approve |

Rate limit configuration is managed through `ConfigurationEntry` — it is not hardcoded. Default values are defined in Appendix C (Seed Data Specification).

### 9.2.5 CORS Middleware

**Purpose:** Restricts cross-origin resource access to the configured front-end origin.

**Implementation:**

The CORS middleware is registered as the first middleware in the Express application, before auth and before all route handlers. It allows requests only from the configured front-end origin (Next.js application host). All other origins receive a `403 Forbidden` response before reaching any route handler.

CORS configuration values (allowed origins, allowed methods, allowed headers) are loaded from `.env`. No CORS configuration is hardcoded. The wildcard origin (`*`) is prohibited — the origin list must be explicit.

Preflight `OPTIONS` requests for credentialed cross-origin requests are handled by the CORS middleware and return appropriate headers. Controller handlers never see a preflight request.

---

## §9.3 — API Contract Architecture

### 9.3.1 Standard Response Envelope

Every API response from every endpoint follows one of two shapes — success or error — with no exceptions. Controllers that return raw objects, naked arrays, or unstructured error messages are architectural violations.

**Success envelope:**

```json
{
  "success": true,
  "data": { },
  "meta": null,
  "requestId": "uuid-v4"
}
```

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `true` for success responses. |
| `data` | `object \| array \| null` | The response payload. Object for single-resource responses; array for list responses; null for action-only endpoints (e.g., lock, park). |
| `meta` | `object \| null` | Metadata for paginated responses (see §9.3.3). `null` for non-paginated responses. |
| `requestId` | `string` | A UUID generated per request, used for audit trail linkage. Every inbound request receives a `requestId` at the auth middleware layer; it travels through the request lifecycle and is returned in every response. |

**Error envelope (from Part 1 §1.5.4):**

```json
{
  "success": false,
  "error": {
    "type": "ErrorClassName",
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable description",
    "context": { }
  },
  "requestId": "uuid-v4"
}
```

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `false` for error responses. |
| `error.type` | `string` | The error class name (e.g., `PolicyGateBlockedError`, `StageGateBlockedError`). |
| `error.code` | `string` | Machine-readable error code for programmatic handling. |
| `error.message` | `string` | Human-readable description of what failed. |
| `error.context` | `object` | Typed context payload per error class (Part 1 §1.5). Never an empty object for controlled operational errors. |
| `requestId` | `string` | Same UUID as the success envelope. Enables correlating error responses in logs and audit records. |

### 9.3.2 Error Contract

All error types follow the typed error class hierarchy from Part 1 §1.5. Every controlled operational error carries a structured context payload. Generic error messages without typed context are not acceptable outputs for any controlled condition.

**Error classes in scope for Part 9:**

The following table states each error class, its HTTP status code, and the context payload shape. The full payload definitions are in Part 1 §§1.5.2–1.5.3.

| Class | HTTP Status | When Thrown |
|---|---|---|
| `ValidationError` | 400 | Request body, path parameter, or query parameter fails schema validation. |
| `AuthorizationError` | 401/403 | Session invalid, expired, or actor lacks authority for the requested action. |
| `NotFoundError` | 404 | Requested entity does not exist. |
| `StateTransitionError` | 409 | State machine transition attempted in an invalid source state. |
| `PolicyViolationError` | 422 | A business rule was violated in a way that cannot be escalated. |
| `PolicyGateBlockedError` | 403 | A policy evaluation returned DENIED or ESCALATE and the escalation was not satisfied. Carries `policyName`, `policySection`, `blockingCondition`, `currentActorLevel`, `requiredActorLevel`, `escalationPath`, `entryId`. |
| `StageGateBlockedError` | 409 | A stage exit was attempted with one or more blocking evidence conditions unsatisfied. Carries `stage`, `attemptedTransition`, `unsatisfiedConditions[]`, `guardOutcome`, `overrideRequires`. |
| `ConcurrentEditingError` | 409 | Concurrent editing conflict detected (mechanism TBD — B4-001). Carries `entityType`, `entityId`, `currentEditorSession`, `conflictDetectedAt`, `resolution`. |
| `OverbookingDetectedError` | 409 | Overbooking detected at S4 confirmation. Carries `triggerType`, `entryId`, `conflictingEntries[]`, `requiresGmApproval`, `mitigation`. |
| `MissingConfigurationError` | 503 | Required configuration value absent at runtime. Carries `configurationKey`, `configuredBy`, `affectedOperation`, `stage`, `resolutionPath`. |
| `AppError` | 500 | Base class for unclassified internal errors. All unhandled exceptions are wrapped in this class before returning — raw stack traces are never exposed to the caller. |

**`PolicyGateBlockedError` context — `policy_id` field note:**

The ToC §9.3 requires `policy_id` in the `PolicyGateBlockedError` context. Part 1 §1.5.3 defines the context field as `policyName` (canonical policy class name). The two are harmonised: `policyName` carries the canonical name from Part 5 §5.2.34 (e.g., `"Dispute Gate Stage Progression Policy"`), and `policySection` carries the section reference (e.g., `"§5.2.21.54"`). Together these satisfy the `policy_id` and `blocking_condition` and `escalation_path` requirements in the ToC. No additional `policy_id` integer field is introduced.

### 9.3.3 Pagination Contract

All list endpoints use cursor-based pagination. Offset-based pagination is not used anywhere in this system.

**Cursor shape:**

The cursor is an opaque base64-encoded string encoding the last record's `id` and the sort field value at that position. The client does not parse the cursor — it passes it back verbatim in the next request.

**Request parameters for paginated endpoints:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cursor` | `string \| undefined` | (absent = first page) | Opaque cursor from the previous page's `meta.nextCursor`. |
| `limit` | `integer` | 20 | Number of records to return. Maximum: 100. |

**Meta extension for paginated responses:**

When `data` is an array (list response), the `meta` field carries:

```json
{
  "meta": {
    "totalCount": 142,
    "limit": 20,
    "hasNextPage": true,
    "nextCursor": "eyJpZCI6IjEyMyIsInNvcnRWYWx1ZSI6IjIwMjYtMDQtMDgifQ==",
    "hasPreviousPage": false
  }
}
```

`totalCount` is the count of records matching the query filter, not the count on this page. `nextCursor` is `null` when `hasNextPage` is `false`. `hasPreviousPage` is derived from whether a cursor was supplied in the request.

---

## §9.4 — Route Catalogue

### 9.4.1 Derivation Method

This catalogue is derived systematically from the Part 6 service catalogue. Every externally invokable service method in §§6.5–6.7 of Part 6 maps to one or more routes. Internal-only operations — timer-fired workers, infrastructure service methods not callable through HTTP, and system actor operations — are excluded.

Four mandatory endpoint groups from the ToC (§70A, §70B, §70C, v2.3) are added beyond the service catalogue derivation.

**Route entry format:**

Each route entry states:
- HTTP method and path
- Auth requirement (minimum actor level to call this endpoint)
- Request DTO (name only — full DTO definitions are Part 10)
- Response DTO (name only)
- Service method invoked (exact name from Part 6)
- Policies enforced (exact names from Part 5 §5.2.34)
- Error responses (typed error classes from Part 1 §1.5 that this endpoint may return)
- Pagination (`Yes` — cursor-based, or `No`)

**Auth level notation:**

| Notation | Meaning |
|---|---|
| `L1+` | Minimum `ActorLevel.FRONT_DESK`; any authenticated staff member |
| `L2+` | Minimum `ActorLevel.FOM` |
| `L3` | `ActorLevel.GM` only |
| `L4` | `ActorLevel.ADMIN` only |
| `PIN` | Pre-auth (PIN validation only — used for auth endpoints before session is established) |

---

### 9.4.2 Domain Group: Session and Authentication

---

**Route: Authenticate (Initial Login)**

| Field | Value |
|---|---|
| Method + Path | `POST /auth/authenticate` |
| Auth | `PIN` (pre-auth — JWT not required; PIN and terminalId in request body) |
| Request DTO | `AuthenticateRequestDTO` |
| Response DTO | `SessionResponseDTO` |
| Service method | `SessionService.authenticate(pin, terminalId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError` (PIN invalid), `AppError` |
| Pagination | No |

---

**Route: PIN Switch**

| Field | Value |
|---|---|
| Method + Path | `POST /auth/switch` |
| Auth | `L1+` (outgoing actor's session must be active) |
| Request DTO | `PinSwitchRequestDTO` |
| Response DTO | `SessionResponseDTO` |
| Service method | `SessionService.switchUser(outgoingActorId, incomingPin, terminalId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError` (incoming PIN invalid), `AppError` |
| Pagination | No |

---

**Route: Manual Lock**

| Field | Value |
|---|---|
| Method + Path | `POST /auth/lock` |
| Auth | `L1+` |
| Request DTO | `ManualLockRequestDTO` |
| Response DTO | `SessionStatusResponseDTO` |
| Service method | `SessionService.manualLock(sessionId, actorId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | No |

---

**Route: Hard Logout**

| Field | Value |
|---|---|
| Method + Path | `POST /auth/logout` |
| Auth | `L1+` |
| Request DTO | `LogoutRequestDTO` |
| Response DTO | `SessionStatusResponseDTO` |
| Service method | `SessionService.hardLogout(sessionId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | No |

---

### 9.4.3 Domain Group: Inquiries

---

**Route: Create Inquiry**

| Field | Value |
|---|---|
| Method + Path | `POST /inquiries` |
| Auth | `L1+` |
| Request DTO | `CreateInquiryRequestDTO` |
| Response DTO | `InquiryResponseDTO` |
| Service method | `InquiryService.create()` |
| Policies | Policy 3 — Initial Custodian Assignment Policy; Policy 12 — Duplicate Inquiry and Entry Creation Gate Policy; Policy 15 — Guest Identity Capture Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `PolicyGateBlockedError` (duplicate detected), `MissingConfigurationError` (no custodian rule resolves), `AppError` |
| Pagination | No |

---

**Route: List Inquiries**

| Field | Value |
|---|---|
| Method + Path | `GET /inquiries` |
| Auth | `L1+` |
| Request DTO | `ListInquiriesRequestDTO` (query params: cursor, limit, status, custodianId, guestProfileId) |
| Response DTO | `InquiryListResponseDTO` |
| Service method | `InquiryService.list()` |
| Policies | None (read-only; auth middleware enforces session) |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes |

---

**Route: Get Inquiry**

| Field | Value |
|---|---|
| Method + Path | `GET /inquiries/:id` |
| Auth | `L1+` |
| Request DTO | `GetInquiryRequestDTO` (path param: id) |
| Response DTO | `InquiryResponseDTO` |
| Service method | `InquiryService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Park Inquiry (Inquiry-Level Park)**

| Field | Value |
|---|---|
| Method + Path | `POST /inquiries/:id/park` |
| Auth | `L1+` |
| Request DTO | `ParkInquiryRequestDTO` (path param: id; body: reason) |
| Response DTO | `InquiryStatusResponseDTO` |
| Service method | `InquiryService.park()` |
| Policies | None (parking authority is L1+ for entry-level; inquiry-level cascade follows entry authority) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Unpark Inquiry (Inquiry-Level Unpark)**

| Field | Value |
|---|---|
| Method + Path | `POST /inquiries/:id/unpark` |
| Auth | `L1+` |
| Request DTO | `UnparkInquiryRequestDTO` (path param: id) |
| Response DTO | `InquiryStatusResponseDTO` |
| Service method | `InquiryService.unpark()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Assign Custodian**

| Field | Value |
|---|---|
| Method + Path | `POST /inquiries/:id/assign-custodian` |
| Auth | `L1+` (L2+ for high-value entries per Policy 4) |
| Request DTO | `AssignCustodianRequestDTO` (path param: id; body: newCustodianId) |
| Response DTO | `InquiryResponseDTO` |
| Service method | `InquiryService.assignCustodian()` |
| Policies | Policy 3 — Initial Custodian Assignment Policy; Policy 4 — Custodian Reassignment Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |
| Pagination | No |

---

### 9.4.4 Domain Group: Entries

---

**Route: Create Entry**

| Field | Value |
|---|---|
| Method + Path | `POST /entries` |
| Auth | `L1+` |
| Request DTO | `CreateEntryRequestDTO` |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.create()` |
| Policies | Policy 15 — Guest Identity Capture Policy; Policy 64 — Group Detection Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError` (inquiry not found), `PolicyGateBlockedError`, `AppError` |
| Pagination | No |

---

**Route: List Entries**

| Field | Value |
|---|---|
| Method + Path | `GET /entries` |
| Auth | `L1+` |
| Request DTO | `ListEntriesRequestDTO` (query params: cursor, limit, inquiryId, stage, status, useType, custodianId) |
| Response DTO | `EntryListResponseDTO` |
| Service method | `EntryService.list()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes |

---

**Route: Get Entry**

| Field | Value |
|---|---|
| Method + Path | `GET /entries/:id` |
| Auth | `L1+` |
| Request DTO | `GetEntryRequestDTO` (path param: id) |
| Response DTO | `EntryDetailResponseDTO` |
| Service method | `EntryService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Progress Stage**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` (specific transitions require L2+ or L3 per §3.2.2 authority column) |
| Request DTO | `ProgressStageRequestDTO` (path param: id; body: targetStage, transitionData) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` |
| Policies | Policy 9 — Pre-Arrival Period Policy (S4→S5); Policy 16 — Guest Identity Verification Policy (S5→S6); Policy 28 — Advance Payment Reconciliation Policy (S5→S6); Policy 29 — Advance Payment Balance Verification Policy (S5→S6); Policy 31 — Billing Model Activation Policy (S5→S6); Policy 33 — Billing Model Settlement Policy (S7→S8); Policy 51 — DEFICIENT Inspection Review Policy (S8→S9); Policy 54 — Dispute Gate Stage Progression Policy (S7→S8, S8→S9); Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError`, `PolicyGateBlockedError`, `StateTransitionError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

---

**Route: Park Entry**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/park` |
| Auth | `L1+` |
| Request DTO | `ParkEntryRequestDTO` (path param: id; body: reason) |
| Response DTO | `EntryStatusResponseDTO` |
| Service method | `EntryService.park()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Unpark Entry**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/unpark` |
| Auth | `L1+` |
| Request DTO | `UnparkEntryRequestDTO` (path param: id) |
| Response DTO | `EntryStatusResponseDTO` |
| Service method | `EntryService.unpark()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Reassign Custodian on Entry**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/reassign-custodian` |
| Auth | `L1+` (L2+ for high-value entries per Policy 4) |
| Request DTO | `ReassignCustodianRequestDTO` (path param: id; body: newCustodianId, reason) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.reassignCustodian()` |
| Policies | Policy 4 — Custodian Reassignment Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |
| Pagination | No |

---

### 9.4.5 Domain Group: Availability

---

**Route: Availability Search**

| Field | Value |
|---|---|
| Method + Path | `POST /availability/search` |
| Auth | `L1+` |
| Request DTO | `AvailabilitySearchRequestDTO` |
| Response DTO | `AvailabilityResultResponseDTO` |
| Service method | `AvailabilityService.query()` |
| Policies | Policy 1 — Availability Query Policy; Policy 2 — DEFICIENT Condition Surface Policy; Policy 14 — Shadow Inventory Visibility Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

---

**Route: Get Availability Configuration**

| Field | Value |
|---|---|
| Method + Path | `GET /availability/configurations/:id` |
| Auth | `L1+` |
| Request DTO | `GetAvailabilityConfigRequestDTO` (path param: id) |
| Response DTO | `AvailabilityConfigResponseDTO` |
| Service method | `AvailabilityService.getConfiguration()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Recall Stale Availability Configuration**

| Field | Value |
|---|---|
| Method + Path | `POST /availability/configurations/:id/recall` |
| Auth | `L1+` |
| Request DTO | `RecallAvailabilityConfigRequestDTO` (path param: id) |
| Response DTO | `AvailabilityResultResponseDTO` |
| Service method | `AvailabilityService.recallConfiguration()` |
| Policies | Policy 1 — Availability Query Policy; Policy 2 — DEFICIENT Condition Surface Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

---

### 9.4.6 Domain Group: Quotations and Holds

---

**Route: Create Quotation**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/quotations` |
| Auth | `L1+` |
| Request DTO | `CreateQuotationRequestDTO` |
| Response DTO | `QuotationResponseDTO` |
| Service method | `QuotationService.createQuotation()` |
| Policies | Policy 19 — Rate Plan Resolution Policy; Policy 23 — Discount Approval Policy; Policy 37 — FOC Entitlement Calculation Policy (GROUP use type) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (discount escalation not satisfied; rate below MSR), `MissingConfigurationError` (no rate plan), `AppError` |
| Pagination | No |

---

**Route: Send Quotation**

| Field | Value |
|---|---|
| Method + Path | `POST /quotations/:id/send` |
| Auth | `L1+` |
| Request DTO | `SendQuotationRequestDTO` (path param: id; body: channel, recipient) |
| Response DTO | `QuotationResponseDTO` |
| Service method | `QuotationService.sendQuotation()` |
| Policies | Policy 52 — Communication Acknowledgement Tracking Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Accept Quotation**

| Field | Value |
|---|---|
| Method + Path | `POST /quotations/:id/accept` |
| Auth | `L1+` |
| Request DTO | `AcceptQuotationRequestDTO` (path param: id) |
| Response DTO | `QuotationResponseDTO` |
| Service method | `QuotationService.acceptQuotation()` |
| Policies | None (acceptance is a state transition — guard conditions are in Part 3 §3.14) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Place Speculative Hold**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/holds/speculative` |
| Auth | `L1+` (volume thresholds may require L2+ per Policy 25) |
| Request DTO | `PlaceSpeculativeHoldRequestDTO` |
| Response DTO | `SpeculativeHoldResponseDTO` |
| Service method | `HoldService.placeSpeculativeHold()` |
| Policies | Policy 25 — Speculative Hold Placement Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (inventory not available; volume threshold requires FOM), `MissingConfigurationError`, `AppError` |
| Pagination | No |

---

**Route: Place Committed Hold**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/holds/committed` |
| Auth | `L1+` |
| Request DTO | `PlaceCommittedHoldRequestDTO` |
| Response DTO | `CommittedHoldResponseDTO` |
| Service method | `HoldService.placeCommittedHold()` |
| Policies | Policy 26 — Committed Hold Placement Policy; Policy 27 — Advance Payment Collection Policy; Policy 30 — Billing Model Initial Fix Policy; Policy 34 — Cancellation Terms Disclosure Policy; Policy 38 — FOC Validation Policy (GROUP use type) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (advance payment not satisfied; FOC validation failed), `MissingConfigurationError`, `StageGateBlockedError`, `AppError` |
| Pagination | No |

---

### 9.4.7 Domain Group: Reservations

---

**Route: Confirm Reservation (S4)**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/confirm` |
| Auth | `L1+` (L2+ for conference and high-value per Policy 40) |
| Request DTO | `ConfirmReservationRequestDTO` |
| Response DTO | `ReservationResponseDTO` |
| Service method | `ReservationService.confirm()` |
| Policies | Policy 13 — Multi-Booking Detection Policy; Policy 20 — Commitment Rate Freeze Policy; Policy 39 — FOC Verification Policy; Policy 40 — Confirmation Authority Policy; Policy 41 — Overbooking Detection and Trigger Typing Policy; Policy 42 — Credit Ceiling Mandatory Set Policy; Policy 43 — Credit Ceiling Commitment Snapshot Carry Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError`, `PolicyGateBlockedError` (confirmation authority not satisfied), `OverbookingDetectedError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

---

**Route: Get Reservation**

| Field | Value |
|---|---|
| Method + Path | `GET /reservations/:id` |
| Auth | `L1+` |
| Request DTO | `GetReservationRequestDTO` (path param: id) |
| Response DTO | `ReservationResponseDTO` |
| Service method | `ReservationService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

### 9.4.8 Domain Group: Folios

---

**Route: Get Folio**

| Field | Value |
|---|---|
| Method + Path | `GET /folios/:id` |
| Auth | `L1+` |
| Request DTO | `GetFolioRequestDTO` (path param: id) |
| Response DTO | `FolioDetailResponseDTO` |
| Service method | `FolioService.getFolio()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Record Advance Payment**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/payments` |
| Auth | `L1+` |
| Request DTO | `RecordPaymentRequestDTO` |
| Response DTO | `PaymentRecordResponseDTO` |
| Service method | `FolioService.recordPayment()` |
| Policies | Policy 27 — Advance Payment Collection Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (below minimum advance payment), `StateTransitionError` (folio not in expected state), `AppError` |
| Pagination | No |

---

**Route: Post Charge to Live Folio**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/charges` |
| Auth | `L1+` |
| Request DTO | `PostChargeRequestDTO` |
| Response DTO | `FolioLineResponseDTO` |
| Service method | `FolioService.postCharge()` |
| Policies | Policy 45 — Credit Ceiling Active Monitoring Policy; Policy 60 — Night Audit Charge Posting and Completeness Policy (audit seal check) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (folio not LIVE; sealed audit date), `PolicyGateBlockedError` (credit ceiling 100% gate), `AppError` |
| Pagination | No |

---

**Route: Initiate Settlement**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/settle` |
| Auth | `L1+` |
| Request DTO | `InitiateSettlementRequestDTO` |
| Response DTO | `FolioResponseDTO` |
| Service method | `FolioService.initiateSettlement()` |
| Policies | Policy 22 — Settlement Rate Policy; Policy 33 — Billing Model Settlement Policy; Policy 46 — Credit Ceiling Final Balance Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `PolicyGateBlockedError` (balance exceeds ceiling — FOM acknowledgement required), `AppError` |
| Pagination | No |

---

**Route: Add Credit Note**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/credit-notes` |
| Auth | `L2+` |
| Request DTO | `AddCreditNoteRequestDTO` |
| Response DTO | `CreditNoteResponseDTO` |
| Service method | `FolioService.addCreditNote()` |
| Policies | Policy 24 — Mid-Stay Discount Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |
| Pagination | No |

---

**Route: Issue Invoice**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/invoices` |
| Auth | `L1+` |
| Request DTO | `IssueInvoiceRequestDTO` |
| Response DTO | `InvoiceResponseDTO` |
| Service method | `FolioService.issueInvoice()` |
| Policies | Policy 52 — Communication Acknowledgement Tracking Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: List Invoices for Folio**

| Field | Value |
|---|---|
| Method + Path | `GET /folios/:id/invoices` |
| Auth | `L1+` |
| Request DTO | `ListInvoicesRequestDTO` (path param: id; query: cursor, limit) |
| Response DTO | `InvoiceListResponseDTO` |
| Service method | `FolioService.listInvoices()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | Yes |

---

### 9.4.9 Domain Group: Amendments

---

**Route: Initiate Amendment**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/amend` |
| Auth | `L2+` (Path 1: L2+; Path 2: L2+ or L3 per Policy 21; Path 3: L3 for rate; L2+ for inclusions) |
| Request DTO | `AmendmentRequestDTO` |
| Response DTO | `AmendmentResponseDTO` |
| Service method | `AmendmentService.amend()` |
| Policies | Policy 21 — Mid-Stay Rate Amendment Policy; Policy 24 — Mid-Stay Discount Policy; Policy 32 — Billing Model Mid-Stay Transition Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (rate below MSR; authority insufficient), `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 9.4.10 Domain Group: Cancellations

---

**Route: Cancel Entry**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/cancel` |
| Auth | `L1+` (L2+ post-S3; L3 at S7 early departure — see Policy 35, Policy 36) |
| Request DTO | `CancelEntryRequestDTO` |
| Response DTO | `EntryStatusResponseDTO` |
| Service method | `CancellationService.cancel()` |
| Policies | Policy 34 — Cancellation Terms Disclosure Policy; Policy 35 — Cancellation Enforcement Policy; Policy 36 — Early Departure Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (penalty waiver exceeds authority), `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 9.4.11 Domain Group: No-Show

---

**Route: Determine No-Show**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/no-show` |
| Auth | `L2+` |
| Request DTO | `NoShowDeterminationRequestDTO` |
| Response DTO | `NoShowDeterminationResponseDTO` |
| Service method | `NoShowService.determineNoShow()` |
| Policies | Policy 56 — No-Show Detection and Determination Policy; Policy 57 — No-Show Folio Financial Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (cutoff period not reached; contact attempts insufficient), `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 9.4.12 Domain Group: Handoffs

---

**Route: List Handoffs**

| Field | Value |
|---|---|
| Method + Path | `GET /handoffs` |
| Auth | `L1+` |
| Request DTO | `ListHandoffsRequestDTO` (query params: cursor, limit, entryId, type, state) |
| Response DTO | `HandoffListResponseDTO` |
| Service method | `HandoffService.list()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes |

---

**Route: Get Handoff**

| Field | Value |
|---|---|
| Method + Path | `GET /handoffs/:id` |
| Auth | `L1+` |
| Request DTO | `GetHandoffRequestDTO` (path param: id) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Accept Handoff**

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/accept` |
| Auth | `L1+` |
| Request DTO | `AcceptHandoffRequestDTO` (path param: id; body: checklistCompletion) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.accept()` |
| Policies | Policy 5 — H1 Handoff Custodian Transfer Policy (H1 only); Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (checklist incomplete), `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Fulfil Handoff**

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/fulfil` |
| Auth | `L1+` |
| Request DTO | `FulfilHandoffRequestDTO` (path param: id; body: fulfilmentEvidence) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.fulfil()` |
| Policies | Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (fulfilment evidence incomplete), `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Reject Handoff**

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/reject` |
| Auth | `L1+` |
| Request DTO | `RejectHandoffRequestDTO` (path param: id; body: rejectionReason) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.reject()` |
| Policies | Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 9.4.13 Domain Group: Disputes

---

**Route: Open Dispute**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes` |
| Auth | `L1+` |
| Request DTO | `OpenDisputeRequestDTO` |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.open()` |
| Policies | Policy 53 — Active Dispute Management Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Get Dispute**

| Field | Value |
|---|---|
| Method + Path | `GET /disputes/:id` |
| Auth | `L1+` |
| Request DTO | `GetDisputeRequestDTO` (path param: id) |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: List Disputes**

| Field | Value |
|---|---|
| Method + Path | `GET /disputes` |
| Auth | `L1+` |
| Request DTO | `ListDisputesRequestDTO` (query params: cursor, limit, entryId, state) |
| Response DTO | `DisputeListResponseDTO` |
| Service method | `DisputeService.list()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes |

---

**Route: Progress Dispute**

| Field | Value |
|---|---|
| Method + Path | `PATCH /disputes/:id` |
| Auth | `L2+` |
| Request DTO | `ProgressDisputeRequestDTO` (path param: id; body: newState, resolutionNote) |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.progress()` |
| Policies | Policy 53 — Active Dispute Management Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Close Dispute**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/close` |
| Auth | `L3` |
| Request DTO | `CloseDisputeRequestDTO` (path param: id; body: closureReason — mandatory) |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.close()` |
| Policies | Policy 55 — Dispute Closure Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (closure reason missing; not in closeable state), `AppError` |
| Pagination | No |

---

**Route: Reopen Dispute**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/reopen` |
| Auth | `L2+` |
| Request DTO | `ReopenDisputeRequestDTO` (path param: id; body: reopenReason — mandatory) |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.reopen()` |
| Policies | Policy 53 — Active Dispute Management Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Create Resolution Bundle**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/resolution-bundles` |
| Auth | `L2+` (L3 for GM-authority actions within bundle) |
| Request DTO | `CreateResolutionBundleRequestDTO` |
| Response DTO | `ResolutionBundleResponseDTO` |
| Service method | `DisputeService.createResolutionBundle()` |
| Policies | Policy 53 — Active Dispute Management Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Dispute Gate Override — GM Override Path (mandatory addition from v2.3)**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/gate-override` |
| Auth | `L3` |
| Request DTO | `DisputeGateOverrideRequestDTO` (path param: id; body: freeTextReason — mandatory; targetStage) |
| Response DTO | `DisputeGateOverrideResponseDTO` |
| Service method | `DisputeService.createGateOverride()` |
| Policies | Policy 54 — Dispute Gate Stage Progression Policy |
| Error responses | `ValidationError`, `AuthorizationError` (actor not GM), `NotFoundError`, `PolicyGateBlockedError` (gate does not return BLOCKED_WITH_OVERRIDE_AVAILABLE at this transition; override not available at S8→S9), `AppError` |
| Pagination | No |

Notes on this endpoint: The free-text reason is mandatory — the service rejects the request if `freeTextReason` is absent or empty. The `DisputeGateOverrideRecord` is immutable from creation. This endpoint is only valid when the dispute gate returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` (S7→S8 transition). At S8→S9, the gate returns `BLOCKED` (no override path) — a request to this endpoint at S8→S9 is rejected with `PolicyGateBlockedError`.

---

### 9.4.14 Domain Group: Work Orders

---

**Route: Create Work Order**

| Field | Value |
|---|---|
| Method + Path | `POST /work-orders` |
| Auth | `L1+` |
| Request DTO | `CreateWorkOrderRequestDTO` |
| Response DTO | `WorkOrderResponseDTO` |
| Service method | `WorkOrderService.create()` |
| Policies | Policy 67 — Work Order Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Get Work Order**

| Field | Value |
|---|---|
| Method + Path | `GET /work-orders/:id` |
| Auth | `L1+` |
| Request DTO | `GetWorkOrderRequestDTO` (path param: id) |
| Response DTO | `WorkOrderDetailResponseDTO` |
| Service method | `WorkOrderService.getWorkOrder()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Amend Work Order**

| Field | Value |
|---|---|
| Method + Path | `POST /work-orders/:id/amend` |
| Auth | `L1+` |
| Request DTO | `AmendWorkOrderRequestDTO` |
| Response DTO | `WorkOrderResponseDTO` |
| Service method | `WorkOrderService.amend()` |
| Policies | Policy 67 — Work Order Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (work order not OPEN), `AppError` |
| Pagination | No |

---

**Route: Close Work Order**

| Field | Value |
|---|---|
| Method + Path | `POST /work-orders/:id/close` |
| Auth | `L1+` |
| Request DTO | `CloseWorkOrderRequestDTO` (path param: id; body: closureNote — mandatory) |
| Response DTO | `WorkOrderResponseDTO` |
| Service method | `WorkOrderService.close()` |
| Policies | Policy 67 — Work Order Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (open to-do items not all completed or cancelled), `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Create To-Do Item**

| Field | Value |
|---|---|
| Method + Path | `POST /work-orders/:id/todo-items` |
| Auth | `L1+` |
| Request DTO | `CreateToDoItemRequestDTO` |
| Response DTO | `WorkOrderToDoItemResponseDTO` |
| Service method | `WorkOrderService.createToDoItem()` |
| Policies | Policy 67 — Work Order Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (work order not OPEN), `AppError` |
| Pagination | No |

---

**Route: Update To-Do Item**

| Field | Value |
|---|---|
| Method + Path | `PATCH /work-orders/:id/todo-items/:itemId` |
| Auth | `L1+` (cancellation requires L2+) |
| Request DTO | `UpdateToDoItemRequestDTO` |
| Response DTO | `WorkOrderToDoItemResponseDTO` |
| Service method | `WorkOrderService.updateToDoItem()` |
| Policies | Policy 67 — Work Order Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 9.4.15 Domain Group: Guest Profiles

---

**Route: Create or Link Guest Profile**

| Field | Value |
|---|---|
| Method + Path | `POST /guest-profiles` |
| Auth | `L1+` |
| Request DTO | `CreateGuestProfileRequestDTO` |
| Response DTO | `GuestProfileResponseDTO` |
| Service method | `GuestProfileService.createOrLink()` |
| Policies | Policy 12 — Duplicate Inquiry and Entry Creation Gate Policy (duplicate profile check); Policy 15 — Guest Identity Capture Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `PolicyGateBlockedError` (duplicate detected), `AppError` |
| Pagination | No |

---

**Route: Get Guest Profile**

| Field | Value |
|---|---|
| Method + Path | `GET /guest-profiles/:id` |
| Auth | `L1+` |
| Request DTO | `GetGuestProfileRequestDTO` (path param: id) |
| Response DTO | `GuestProfileDetailResponseDTO` |
| Service method | `GuestProfileService.getProfile()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Search Guest Profiles**

| Field | Value |
|---|---|
| Method + Path | `GET /guest-profiles` |
| Auth | `L1+` |
| Request DTO | `SearchGuestProfilesRequestDTO` (query params: cursor, limit, search, clientTier) |
| Response DTO | `GuestProfileListResponseDTO` |
| Service method | `GuestProfileService.search()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes |

---

**Route: Update Guest Profile**

| Field | Value |
|---|---|
| Method + Path | `PATCH /guest-profiles/:id` |
| Auth | `L1+` |
| Request DTO | `UpdateGuestProfileRequestDTO` |
| Response DTO | `GuestProfileResponseDTO` |
| Service method | `GuestProfileService.update()` |
| Policies | None (field-level updates to contact info, preferences — governed fields follow their own policies) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `ConcurrentEditingError` (B4-001 — mechanism TBD), `AppError` |
| Pagination | No |

---

**Route: Record Tier Change**

| Field | Value |
|---|---|
| Method + Path | `POST /guest-profiles/:id/tier-change` |
| Auth | `L2+` |
| Request DTO | `TierChangeRequestDTO` (path param: id; body: toTier, reason — mandatory) |
| Response DTO | `GuestProfileResponseDTO` |
| Service method | `GuestProfileService.tierChange()` |
| Policies | None (tier change is an additive layered event; authority is L2+ by design) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

**Route: Verify Guest Identity (S6)**

| Field | Value |
|---|---|
| Method + Path | `POST /guest-profiles/:id/verify-identity` |
| Auth | `L1+` |
| Request DTO | `VerifyIdentityRequestDTO` (path param: id; body: documentType, documentNumber, capturedBy, entryId) |
| Response DTO | `IdentityVerificationResponseDTO` |
| Service method | `GuestProfileService.verifyIdentity()` |
| Policies | Policy 16 — Guest Identity Verification Policy; Policy 17 — Guest Data Capture Governance Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (document type not accepted; required fields missing), `AppError` |
| Pagination | No |

---

### 9.4.16 Domain Group: Night Audit

---

**Route: Trigger Night Audit**

| Field | Value |
|---|---|
| Method + Path | `POST /night-audit/run` |
| Auth | `L2+` |
| Request DTO | `RunNightAuditRequestDTO` (body: operatingDate) |
| Response DTO | `NightAuditResponseDTO` |
| Service method | `NightAuditService.runNightAudit()` |
| Policies | Policy 59 — Night Audit Countdown Policy; Policy 60 — Night Audit Charge Posting and Completeness Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

Notes: The night audit is primarily timer-fired by the `NightAuditSchedulerWorker`. This endpoint enables staff-triggered execution (e.g., if the scheduler fails). The service's idempotency guard prevents double-execution. Rate limiting (5 requests/minute per actor) applies.

---

**Route: Get Night Audit Record**

| Field | Value |
|---|---|
| Method + Path | `GET /night-audit/:date` |
| Auth | `L2+` |
| Request DTO | `GetNightAuditRequestDTO` (path param: date in ISO format YYYY-MM-DD) |
| Response DTO | `NightAuditDetailResponseDTO` |
| Service method | `NightAuditService.getRecord()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

### 9.4.17 Domain Group: Incidents and Lost & Found

---

**Route: Create Incident**

| Field | Value |
|---|---|
| Method + Path | `POST /incidents` |
| Auth | `L1+` |
| Request DTO | `CreateIncidentRequestDTO` |
| Response DTO | `IncidentResponseDTO` |
| Service method | `IncidentService.create()` |
| Policies | None at creation (FOM escalation for major incidents is an automatic downstream consequence, not a gate condition on creation) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError` (entry or room not found), `AppError` |
| Pagination | No |

---

**Route: Close Incident**

| Field | Value |
|---|---|
| Method + Path | `POST /incidents/:id/close` |
| Auth | `L2+` |
| Request DTO | `CloseIncidentRequestDTO` (path param: id; body: closureNotes) |
| Response DTO | `IncidentResponseDTO` |
| Service method | `IncidentService.close()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

**Route: Report Lost and Found**

| Field | Value |
|---|---|
| Method + Path | `POST /lost-and-found` |
| Auth | `L1+` |
| Request DTO | `ReportLostFoundRequestDTO` |
| Response DTO | `LostFoundResponseDTO` |
| Service method | `IncidentService.reportLostFound()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | No |

---

### 9.4.18 Domain Group: Communications

---

**Route: Send Communication**

| Field | Value |
|---|---|
| Method + Path | `POST /communications` |
| Auth | `L1+` |
| Request DTO | `SendCommunicationRequestDTO` |
| Response DTO | `CommunicationRecordResponseDTO` |
| Service method | `CommunicationService.send()` |
| Policies | Policy 52 — Communication Acknowledgement Tracking Policy; Policy 74 — AI Authority Boundary Policy (enforced internally when aiDraftId is present — human decision record verified before send proceeds) |
| Error responses | `ValidationError`, `AuthorizationError`, `PolicyViolationError` (AI communication without human approval event), `AppError` |
| Pagination | No |

---

**Route: Inbound Webhook (Email / WhatsApp)**

| Field | Value |
|---|---|
| Method + Path | `POST /communications/inbound` |
| Auth | `PIN` (webhook secret validation, not staff PIN — the HMAC signature of the inbound payload verifies the webhook source; no staff session required) |
| Request DTO | `InboundCommunicationWebhookDTO` |
| Response DTO | `WebhookAcknowledgementResponseDTO` |
| Service method | `CommunicationService.receiveInbound()` |
| Policies | Policy 76 — Voice Note Routing Policy (routing layer; VOICE_NOTE type is detected here and routed to VoiceNoteRoutingService before AI processing) |
| Error responses | `ValidationError`, `AppError` |
| Pagination | No |

Notes: This endpoint is called by the inbound email processor (IMAP poll handler) and the WhatsApp BSP webhook. It is not called by staff via the front-end. The auth mechanism is webhook HMAC signature validation rather than staff PIN — the webhook secret is configured in `.env`. VOICE_NOTE type detection and routing occurs within `CommunicationService.receiveInbound()` before any AI processing path is reached.

---

**Route: Supersede Communication**

| Field | Value |
|---|---|
| Method + Path | `POST /communications/:id/supersede` |
| Auth | `L1+` |
| Request DTO | `SupersedeCommunicationRequestDTO` (path param: id; body: reason, sendInvalidationNotification) |
| Response DTO | `CommunicationRecordResponseDTO` |
| Service method | `CommunicationService.supersede()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 9.4.19 Domain Group: Processing Locks (§70A — Mandatory Endpoint Group)

---

**Route: Place Processing Lock**

| Field | Value |
|---|---|
| Method + Path | `POST /processing-locks` |
| Auth | `L1+` |
| Request DTO | `PlaceProcessingLockRequestDTO` (body: inventoryReference, channel, entryContext) |
| Response DTO | `ProcessingLockResponseDTO` |
| Service method | `ProcessingLockService.placeLock()` |
| Policies | Policy 71 — Processing Lock TTL Policy; Policy 72 — Processing Lock Priority Queue Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `MissingConfigurationError` (TTL configuration missing), `AppError` |
| Pagination | No |

Notes: If a prior lock exists on the same inventory configuration, the endpoint returns `200 OK` with the new lock record AND a `meta.priorityNotice` field informing the caller that another actor holds a prior lock. The second actor is not blocked from placing their lock — they receive informational awareness. No error is thrown for a second lock on the same inventory.

---

**Route: Confirm Reconfirmation (Triggers Revalidation)**

| Field | Value |
|---|---|
| Method + Path | `POST /processing-locks/:id/reconfirm` |
| Auth | `L1+` |
| Request DTO | `ReconfirmProcessingLockRequestDTO` (path param: id — the EXPIRED lock record) |
| Response DTO | `ProcessingLockReconfirmResponseDTO` |
| Service method | `ProcessingLockService.reconfirm()` |
| Policies | Policy 71 — Processing Lock TTL Policy; Policy 72 — Processing Lock Priority Queue Policy; Policy 1 — Availability Query Policy (revalidation re-runs availability check); Policy 19 — Rate Plan Resolution Policy (pricing re-verified at reconfirmation) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (lock not in EXPIRED state — cannot reconfirm an ACTIVE or RELEASED lock), `MissingConfigurationError`, `AppError` |
| Pagination | No |

Notes: Reconfirmation creates a **new** `ProcessingLockRecord` with a new TTL. The EXPIRED record is preserved. The response includes the new lock record and a `revalidationDelta` showing what changed (availability, DEFICIENT status, pricing) during the TTL window. If conditions changed materially, the response surfaces the delta before the caller proceeds.

---

**Route: Check Processing Lock Status**

| Field | Value |
|---|---|
| Method + Path | `GET /processing-locks/:id` |
| Auth | `L1+` |
| Request DTO | `GetProcessingLockRequestDTO` (path param: id) |
| Response DTO | `ProcessingLockResponseDTO` |
| Service method | `ProcessingLockService.status()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

### 9.4.20 Domain Group: AI Agent — Draft Management (§70B — Mandatory Endpoint Group)

---

**Route: Get Pending Drafts (Review Queue)**

| Field | Value |
|---|---|
| Method + Path | `GET /ai-drafts` |
| Auth | `L1+` |
| Request DTO | `ListAiDraftsRequestDTO` (query params: cursor, limit, status — defaults to `PENDING_REVIEW`) |
| Response DTO | `AiDraftListResponseDTO` |
| Service method | `AIAgentApprovalService.getPendingDrafts()` |
| Policies | Policy 73 — AI Trust Level Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes |

Notes: This endpoint returns `AiDraftRecord` entries in `PENDING_REVIEW` status for the authenticated actor's review queue. Filtering by `status` allows FOM to also retrieve `REJECTED` or `APPROVED` drafts for audit inspection.

---

**Route: Approve Draft**

| Field | Value |
|---|---|
| Method + Path | `POST /ai-drafts/:id/approve` |
| Auth | `L1+` |
| Request DTO | `ApproveDraftRequestDTO` (path param: id) |
| Response DTO | `AiDraftDecisionResponseDTO` |
| Service method | `AIAgentApprovalService.recordHumanDecision()` with `decisionType: APPROVE` |
| Policies | Policy 73 — AI Trust Level Policy; Policy 74 — AI Authority Boundary Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyViolationError` (AI actor attempting self-approval — blocked unconditionally), `StateTransitionError` (draft not in PENDING_REVIEW), `AppError` |
| Pagination | No |

Notes: The AI agent actor identity check is enforced unconditionally within `AIAgentApprovalService.recordHumanDecision()`. No trust level configuration and no operational condition creates an exception. After a successful approve action, `CommunicationService.send()` is called internally to dispatch the approved draft content.

---

**Route: Edit-and-Approve Draft**

| Field | Value |
|---|---|
| Method + Path | `POST /ai-drafts/:id/edit-and-approve` |
| Auth | `L1+` |
| Request DTO | `EditAndApproveDraftRequestDTO` (path param: id; body: editedContent — mandatory; reason — mandatory) |
| Response DTO | `AiDraftDecisionResponseDTO` |
| Service method | `AIAgentApprovalService.recordHumanDecision()` with `decisionType: EDIT_AND_APPROVE` |
| Policies | Policy 73 — AI Trust Level Policy; Policy 74 — AI Authority Boundary Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyViolationError` (AI self-approval attempt), `StateTransitionError`, `AppError` |
| Pagination | No |

Notes: Both `editedContent` and `reason` are mandatory fields in the request body. The service rejects a request with either absent or empty. The `HumanDecisionRecord.finalContent` carries the content that was actually sent. A `CorrectionRecord` is created if the edit changes the intent category interpretation.

---

**Route: Reject Draft**

| Field | Value |
|---|---|
| Method + Path | `POST /ai-drafts/:id/reject` |
| Auth | `L1+` |
| Request DTO | `RejectDraftRequestDTO` (path param: id; body: reason — mandatory) |
| Response DTO | `AiDraftDecisionResponseDTO` |
| Service method | `AIAgentApprovalService.recordHumanDecision()` with `decisionType: REJECT` |
| Policies | Policy 73 — AI Trust Level Policy; Policy 74 — AI Authority Boundary Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyViolationError` (AI self-approval attempt), `StateTransitionError`, `AppError` |
| Pagination | No |

Notes: `reason` is mandatory on rejection. The service rejects a request with an absent or empty reason. After rejection, the human handles the response manually — no outbound communication is sent by the system.

---

### 9.4.21 Domain Group: Voice Notes (§70C — Mandatory Endpoint Group)

---

**Route: List Unprocessed Voice Notes**

| Field | Value |
|---|---|
| Method + Path | `GET /voice-notes/unprocessed` |
| Auth | `L1+` |
| Request DTO | `ListUnprocessedVoiceNotesRequestDTO` (query params: cursor, limit, entryId, slaBreachOnly) |
| Response DTO | `VoiceNoteListResponseDTO` |
| Service method | `VoiceNoteRoutingService.listUnprocessed()` |
| Policies | Policy 76 — Voice Note Routing Policy; Policy 77 — Voice Note Review SLA Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes |

Notes: Returns `CommunicationRecord` entries with `messageType = VOICE_NOTE` and `VOICE_NOTE_UNPROCESSED` status. The `slaBreachOnly` query parameter filters to entries where `voiceNoteSlaBreach = true`, enabling FOM to quickly identify overdue reviews. No AI processing records are returned — this is a human-only review queue.

---

**Route: Submit Staff Listening Summary**

| Field | Value |
|---|---|
| Method + Path | `POST /voice-notes/:id/summary` |
| Auth | `L1+` |
| Request DTO | `StaffListeningSummaryRequestDTO` (path param: id; body: callerIntent, commitmentsMentioned, datesAndNumbers, languageUsed, noActionRequired, actionItems[]) |
| Response DTO | `VoiceNoteReviewResponseDTO` |
| Service method | `CommunicationService.completeVoiceNoteReview()` |
| Policies | Policy 76 — Voice Note Routing Policy; Policy 77 — Voice Note Review SLA Policy |
| Error responses | `ValidationError` (required structured fields absent — all summary fields are mandatory), `AuthorizationError`, `NotFoundError`, `PolicyViolationError` (summary submitted without all required structured fields), `AppError` |
| Pagination | No |

Notes: The request body must carry all required structured fields of the `StaffListeningSummaryRecord`: `callerIntent`, `commitmentsMentioned`, `datesAndNumbers`, `languageUsed`. If no action is required, `noActionRequired` must be `true` with a reason — the system does not accept a summary submission that omits all structured fields. A status-only update without a logged summary is rejected. After successful submission, the SLA timer registered at voice note receipt is cancelled via `TimerManagementService`.

---

## Appendix A — Category 1 Clarification Requests (Gate 9)

| ID | Section | Item | Impact |
|---|---|---|---|
| B4-001 | §9.2.3 | Concurrent editing technical mechanism — Architect must select one of: optimistic locking (Candidate A), presence indicator (Candidate B), or micro-hold (Candidate C). Tradeoffs are stated in §9.2.3. | Blocks §9.2.3 finalisation. Blocks implementation of concurrent editing protection on all write endpoints. Routes referencing `ConcurrentEditingError` are complete in structure; the error-throwing condition is defined in Part 1 §1.5.3 — only the detection mechanism requires the Architect's decision. Until locked: implement write endpoints without concurrent editing middleware. Do not invent a mechanism. |

---

## Appendix B — Open Items Not Actioned at Gate 9

The following items from the Spec Ambiguity Register are carried forward. None required Gate 9 action — no route parameter or endpoint design depends on these items.

| Item | Status |
|---|---|
| B9-001 — Amendment routing algorithm (Path 1/2/3 classification basis) | Resolved in MOM-ARCH-2026-015 (Model C hybrid). Applied in Part 6 §6.6.2. No further Gate 9 action required. |
| B9-003 — S9-equivalent processing for cancelled entries | Not a Gate 9 concern. No endpoint directly exposes the S9-equivalent path as a separate route — it is an internal service consequence of cancellation. |
| B2-005, B9-005 — AWAITING_WRITTEN_CONFIRMATION completeness | Not a Gate 9 concern. No route parameter depends on this state — the no-show determination endpoint operates at the FOM determination level, not the sub-state level. |
| B3-001 — QUOTED displacement threshold | Not a Gate 9 concern. |
| B11-001 — Commission-due guard at CLOSED | Not a Gate 9 concern. |

---

## Backfill Registry — Carry-Forward Items

### Doctrine

All backfill items are deferred to a single coordinated backfill session after all gates are complete. No gate is re-opened mid-sequence to action a backfill item. Gates that depend on unresolved backfill items carry acknowledged gaps — written from what is known, with the gap explicitly flagged — rather than blocking the gate sequence.

Backfill items are classified as:

- **Category A — Non-blocking.** Additions or corrections to already-written parts that no subsequent gate derives from. Defer freely.
- **Category B — Blocking.** Gaps that a subsequent gate actively derives from. The dependent gate is written with an acknowledged gap; the backfill session closes it via a targeted verification pass.

---

### Item Register

| # | Category | Target | Location | Change Required | Downstream Impact |
|---|---|---|---|---|---|
| P4 | A — Non-blocking | DEV-SPEC-001-Part2.md | §2.17.3 | Add configuration key: `ai.correctionLog.maximumSize` / All stages / Integer / Maximum number of correction log entries analysed per aggregation cycle for AI confidence threshold tuning | None. No gate reads this field. No verification pass required. |
| P5 | B — Blocking | DEV-SPEC-001-Part6.md | §6.5 | Write missing stage-specific domain service sections for: `QuotationService`, `HoldService`, `PaymentService`, `PreArrivalService`, `CheckInService`, `CheckOutService`, `RoomAssignmentService`, `DuplicateDetectionService`. Root cause: Gate 6 declared Canon sources were Blocks 9–11 only; Blocks 5–8 (stage charters S1–S9) were not loaded; stage-specific services derived from those blocks were omitted. Backfill declared sources: Block 5 (§§42–43, S1–S2), Block 6 (§§44–45, S3–S4), Block 7 (§§46–47, S5–S6), Block 8 (§§48–50, S7–S9). Each section follows the §6.5.X domain service pattern: primary entity, responsibilities, §71 mutation rules enforced, policy enforcement points (cross-reference existing Part 5 policy names), engine invocations, forbidden acts. | Blocks Gate 10 (Workers). Gate 10 carries acknowledged gaps for workers that fire against these services. Triggers verification passes for Part 9 and Part 10 after backfill. |
| B4-001 | B — Blocking (Part 9 only) | DEV-SPEC-001-Part9.md | §9.2.3 | Update the concurrent editing middleware section with the Architect-locked mechanism once deliberated. Three candidates are stated in §9.2.3: optimistic locking (Candidate A), presence indicator (Candidate B), micro-hold (Candidate C). Chosen mechanism must specify: middleware name, position in chain, schema changes required (if any), DTO fields carrying version or lock token, `ConcurrentEditingError` throwing condition. | Blocks Part 9 finalisation only. No subsequent gate depends on the concurrent editing mechanism — workers do not interact with the editing layer. Gate 10 is not blocked by this item. |

---

### Backfill Session Execution Order

All items are actioned in a single session after all gates are complete. The session is not order-free — internal sequencing applies:

```
Step 1 — P5: Write missing Part 6 sections
          Declared sources: Blocks 5–8
          Output: eight new §6.5.X sections appended to Part 6
                    ↓
Step 2 — Part 9 verification pass
          Load new Part 6 sections.
          Check all affected route entries in §9.4 against the new service contracts.
          Confirm: method signatures match; no additional policies surface from
          Blocks 5–8; no additional error types required.
          Expected outcome: no structural changes to Part 9 routes —
          method names were derived from Part 5 and are already correct.
                    ↓
Step 3 — Part 10 verification pass
          Load new Part 6 sections.
          Close acknowledged gaps in Gate 10 worker specifications for the
          eight P5 services.
                    ↓
Step 4 — B4-001: Update Part 9 §9.2.3
          Architect decision on concurrent editing mechanism must be locked
          before this step. Update §9.2.3 with the locked mechanism.
          No other part is affected.
                    ↓
Step 5 — P4: Add config key to Part 2 §2.17.3
          Trivial addition. No verification pass required.
```

---

### Gate 10 Approach for P5-Gap Services

Gate 10 (Workers) is written with Part 6 as a declared source. Where a worker fires against a P5-gap service, Gate 10 states the worker's trigger, the service method it calls (known from Part 5 enforcement points), and flags the entry with:

> `[P5 — Part 6 service contract pending backfill. Method name confirmed from Part 5. Full contract verification deferred to backfill verification pass.]`

This keeps Gate 10 structurally complete — no invented service behaviour, no omitted workers — while acknowledging the gap explicitly. The backfill verification pass at Step 3 removes the flags and confirms or corrects each entry against the written Part 6 sections.

---

*End of DEV-SPEC-001-Part9.md*
*Gate 9 — Controllers and Routes*
*Prepared by: Claude (AI Architectural Partner)*
*Date: 08 April 2026*
*Authority: MOM-ARCH-2026-016*
*Status: DRAFT — nothing is locked until Architect confirms*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
