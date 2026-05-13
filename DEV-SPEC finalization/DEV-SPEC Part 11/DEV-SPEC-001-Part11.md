# LEGPHEL PMS — DEV-SPEC-001
# Part 11 — Integration Interfaces
# §11.1 through §11.8

| Attribute | Value |
|---|---|
| Document | DEV-SPEC-001 |
| Part | 11 — Integration Interfaces |
| Version | 1.0-DRAFT |
| Date | 08 April 2026 |
| Status | DRAFT — Pending Architect Review |
| Declared sources | DEV-SPEC-001_ToC_FINAL.md (§§11.1–11.8); Canon_Block9 (§33 via knowledge search — §33 physically located in Canon_Block3); Canon_Block10 (§§58, 64, 70A, 70B, 70C); DEV-SPEC-001-Part1.md (§1.8); DEV-SPEC-001-Part6.md (§§6.5.13, 6.5.14, 6.6.6, 6.7.4) |

---

## §11.1 — Integration Design Principles

Three governing principles apply to every interface defined in this part. No exception to any principle may be implemented without Architect deliberation.

### 11.1.1 Abstraction Over Implementation

Every integration interface in this part is a named contract. The service layer calls the interface. The interface's concrete implementation is swappable.

When an underlying provider changes — the email provider, the cloud storage vendor, the LLM API provider, the document generation library — the interface contract does not change and no service code changes. Implementation details live behind the interface. They never leak into the service layer.

A service that imports and calls a provider SDK directly is an architectural violation of this principle, regardless of how the import is structured. The interface is the only permitted call site for external system interaction.

### 11.1.2 Export Model, Not Integration Model

The PMS is the system of record. External systems (accounting, OTA platforms, government portals, reporting tools) receive exports from the PMS. They do not write to PMS tables.

Inbound data from external systems — OTA confirmation emails, WhatsApp messages, phone call log entries — is received by the interface and converted into governed PMS records. External systems do not create, modify, or delete PMS operational records. The conversion is the interface's responsibility. The record is the PMS's.

No integration interface exposes a write path into PMS tables for an external system. Any interface method that accepts data from an external system must convert that data into a typed PMS payload and route it through the appropriate service layer, which applies the normal state machine, policy, and authority model. External data entering through an interface is not pre-authorised data. It is raw input awaiting PMS governance.

### 11.1.3 Connection Points, Not Coupling Points

Every integration seam is designed so that the underlying provider can be replaced without touching service code. The interface contract is the seam boundary. Below the contract: implementation, which changes. Above the contract: service code, which does not.

This principle governs future evolution. File-based financial export becomes API-based when the accounting system provides an API endpoint — the export structure does not change, only the delivery mechanism. IMAP-based inbound email becomes webhook-based when the infrastructure supports it — the interface method signature does not change, only the polling mechanism beneath it. OTA email parsing becomes direct API consumption when the channel manager is connected — the interface surface presented to the service layer does not change.

Hardcoding a provider's SDK method name, import path, or connection string into a service is an architectural violation of this principle. The provider detail belongs inside the interface implementation, never in the service layer.

---

## §11.2 — Email Interface (SES)

### 11.2.1 Interface Name

`EmailInterface`

### 11.2.2 Purpose

Manages all outbound email dispatch, inbound email receipt, and dedicated OTA inbox monitoring through a single abstraction boundary; no service dispatches or polls email through any other path.

### 11.2.3 Methods

#### `EmailInterface.sendOutbound(params: OutboundEmailParams): OutboundEmailResult`

**What it does (from the service layer's perspective):** Dispatches an outbound email to the specified recipient using the configured outbound email provider. Applies domain authentication headers. Returns a delivery reference.

**Input type — `OutboundEmailParams`:**
- `to: string` — recipient email address
- `subject: string` — pre-constructed subject line (including prefix: QUOTATION, CONFIRMATION, AMENDED, CANCELLED)
- `body: string` — email body content (HTML or plain text as configured)
- `attachments?: AttachmentRef[]` — references to documents stored via `FileStorageInterface`
- `replyTo?: string` — reply-to address for threading
- `inReplyToMessageId?: string` — message-id of prior email for thread continuity

**Output type — `OutboundEmailResult`:**
- `providerMessageId: string` — provider-assigned message identifier
- `dispatchedAt: DateTime`
- `status: 'DISPATCHED' | 'FAILED'`
- `failureReason?: string`

**What it guarantees:** The caller may assume that a `DISPATCHED` result means the email was accepted by the outbound provider and is in transit. The interface does not guarantee delivery — delivery confirmation is an acknowledgement loop concern handled at the service layer.

---

#### `EmailInterface.pollInbound(): InboundEmailBatch`

**What it does:** Polls the configured inbound mailbox via IMAP for new messages since the last poll. For each new message, converts the raw email into a structured `InboundEmailPayload` and calls `CommunicationService.receiveInbound()` with the payload and `channel = EMAIL`. Returns a batch summary.

**Output type — `InboundEmailBatch`:**
- `polledAt: DateTime`
- `messagesReceived: number`
- `messagesRouted: number`
- `failedParsing: number`
- `rawFailures: RawEmailFailureRecord[]` — emails that could not be parsed are logged and surfaced as pending items; they are never silently discarded

**What it guarantees:** Every email retrieved from the mailbox is either successfully routed to `CommunicationService.receiveInbound()` or recorded as a parse failure in `rawFailures`. No email is discarded silently. Parse failures remain as visible pending items until manually resolved.

**Content storage enforcement:** Every inbound email's full raw content and all attachments are stored via `FileStorageInterface` before routing proceeds. The stored reference is included in the `InboundEmailPayload`. This is not optional — inbound email content that is not stored before routing is a contract violation.

---

#### `EmailInterface.pollOTAInbox(): OTAInboxBatch`

**What it does:** Polls the dedicated OTA inbox at the configurable interval (default 5 minutes). For each email from a known OTA sender domain, runs the OTA email parser to extract provisional booking data. Surfaces extracted data as a structured `OTAProvisionalRecord` for staff verification. Calls the OTA sync service with the provisional record. Does not auto-confirm any booking — staff verification is mandatory before any parsed booking enters inventory.

**Output type — `OTAInboxBatch`:**
- `polledAt: DateTime`
- `otaEmailsReceived: number`
- `successfullyParsed: number`
- `parseFailures: number`
- `provisionalRecordsCreated: OTAProvisionalRecord[]`
- `parseFailureItems: OTAParseFailureRecord[]`

**What it guarantees:** Every email from a known OTA sender domain is parsed or recorded as a parse failure. Parsed data is structured and surfaces for staff verification — it does not enter confirmed inventory. Parse failures are visible pending items. Non-OTA emails received at the OTA inbox are logged and ignored (not routed as standard inbound).

**Polling interval:** Configurable from the Admin Console configuration table. Default: 5 minutes. The interval is a configuration value — not a constant in code.

### 11.2.4 Contract Requirements

The service layer may assume:

1. All outbound email passes through `EmailInterface.sendOutbound()`. No other outbound email path exists. `CommunicationService.send()` calls this interface — it does not call the email provider SDK directly.
2. Inbound email is received and routed to `CommunicationService.receiveInbound()` automatically via the polling mechanism. Services do not implement their own polling logic.
3. OTA inbox polling produces provisional records for staff verification. OTA data never auto-enters confirmed inventory through this interface.
4. Domain authentication (SPF, DKIM, DMARC) is applied by the interface implementation. The service layer does not manage authentication headers.
5. Every inbound email's raw content and attachments are stored before routing. The service layer may reference the stored content via the storage reference in the payload.

### 11.2.5 Forbidden Patterns

- Any service importing or calling the email provider SDK directly.
- Any service implementing its own email polling loop.
- Any code path that auto-confirms a parsed OTA booking without a human verification event.
- Discarding a parse failure silently — all failures surface as visible pending items.
- Dispatching outbound email without constructing a `CommunicationRecord` through `CommunicationService.send()` first. `EmailInterface.sendOutbound()` is called by `CommunicationService.send()`, not by any other service directly.

### 11.2.6 Technology Note

The email interface implementation uses Amazon SES for outbound dispatch with domain authentication (SPF/DKIM/DMARC). IMAP polling is the inbound mechanism; the polling seam is designed for future upgrade to webhook-based real-time receipt when the infrastructure supports it. These are locked implementation choices. The interface contract is independent of these choices — a different outbound provider or a webhook-based inbound mechanism could satisfy the same contract without changing any service code.

---

## §11.3 — WhatsApp Interface (BSP)

### 11.3.1 Interface Name

`WhatsAppInterface`

### 11.3.2 Purpose

Manages bidirectional WhatsApp communication through the WhatsApp Business API via a BSP, including inbound webhook receipt with HMAC validation, message type detection, and outbound dispatch; all WhatsApp traffic passes through this interface.

### 11.3.3 Methods

#### `WhatsAppInterface.receiveWebhook(rawPayload: RawWebhookPayload, hmacSignature: string): WebhookReceiptResult`

**What it does:** Receives an inbound webhook from the BSP. Validates the HMAC signature before processing any payload content. On successful validation, parses the raw payload to extract the structured message content. Detects `messageType` from the payload metadata — `STANDARD` or `VOICE_NOTE`. Constructs the `InboundWhatsAppPayload` with `messageType` set. Calls `CommunicationService.receiveInbound()` with the structured payload and `channel = WHATSAPP`. Returns a receipt result.

**Input types:**
- `rawPayload: RawWebhookPayload` — the raw BSP webhook body
- `hmacSignature: string` — the HMAC signature from the webhook header

**Output type — `WebhookReceiptResult`:**
- `receivedAt: DateTime`
- `messageType: 'STANDARD' | 'VOICE_NOTE'`
- `routedTo: 'COMMUNICATION_SERVICE'`
- `validationStatus: 'PASSED' | 'FAILED'`

**HMAC validation:** Validation occurs before any payload processing. If validation fails, the webhook is rejected with a `400` response and the failure is logged. No content from a failed-validation webhook is processed. The HMAC key is an environment configuration value.

**`VOICE_NOTE` detection:** The interface detects `VOICE_NOTE` from the BSP payload's message type field and sets `messageType = VOICE_NOTE` on the `InboundWhatsAppPayload`. The interface does not itself route differently based on `messageType` — it delivers the typed payload to `CommunicationService.receiveInbound()` which applies the routing logic. The interface's responsibility is accurate detection and typed delivery. The audio file for a VOICE_NOTE message is stored via `FileStorageInterface` before routing.

**Threading:** The `from` phone number is set as the thread identifier. All messages from the same contact are threaded by phone number.

---

#### `WhatsAppInterface.sendOutbound(params: OutboundWhatsAppParams): OutboundWhatsAppResult`

**What it does:** Dispatches an outbound WhatsApp message to the specified phone number via the BSP. Returns a delivery reference.

**Input type — `OutboundWhatsAppParams`:**
- `to: string` — recipient phone number (E.164 format)
- `content: string` — message text content
- `mediaRef?: StorageReference` — reference to a file stored via `FileStorageInterface` to be attached
- `threadId?: string` — phone number for threading continuity

**Output type — `OutboundWhatsAppResult`:**
- `bspMessageId: string`
- `dispatchedAt: DateTime`
- `status: 'DISPATCHED' | 'FAILED'`
- `failureReason?: string`

**What it guarantees:** A `DISPATCHED` result means the message was accepted by the BSP. Delivery confirmation (read receipts, delivered status) is a BSP callback concern managed at the `CommunicationService` acknowledgement layer.

### 11.3.4 Contract Requirements

The service layer may assume:

1. All outbound WhatsApp messages pass through `WhatsAppInterface.sendOutbound()`. `CommunicationService.send()` calls this interface — no service calls the BSP SDK directly.
2. Every inbound WhatsApp webhook is HMAC-validated before any content is processed. A webhook that fails HMAC validation is rejected and logged; no payload data from it enters the system.
3. `messageType` is accurately set in the delivered payload — `VOICE_NOTE` detection is the interface's responsibility, not the caller's.
4. Voice note audio files are stored via `FileStorageInterface` before routing. The storage reference is in the delivered payload.
5. Threading is by contact phone number. The interface maintains the thread identifier consistently.

### 11.3.5 Forbidden Patterns

- Any service calling the BSP SDK directly.
- Processing webhook payload content before HMAC validation completes.
- The interface itself routing differently based on `messageType` — it delivers typed payloads; routing decisions belong to `CommunicationService.receiveInbound()`.
- Outbound WhatsApp dispatch from any code path other than `CommunicationService.send()` → `WhatsAppInterface.sendOutbound()`.

### 11.3.6 Technology Note

The WhatsApp interface implementation uses the WhatsApp Business API through a BSP (Business Solution Provider). Bidirectional messaging is via the BSP's webhook delivery for inbound and the BSP's send API for outbound. This is a locked implementation choice. The interface contract is independent of the specific BSP — a different BSP satisfying the same webhook and send API conventions could be substituted without changing service code.

---

## §11.4 — AI Agent Interface (LLM API)

### 11.4.1 Interface Name

`AIAgentInterface`

### 11.4.2 Purpose

Exposes three governed methods — context assembly, intent classification, and draft generation — against the external LLM API, while enforcing the FULL_AUTO scope boundary and voice note exclusion as contract-level properties, not runtime checks.

### 11.4.3 Methods

#### `AIAgentInterface.assembleContext(input: ContextAssemblyInput): ContextAssemblyOutput`

**What it does:** Assembles the full engagement context required before any LLM API call for a given inbound message. This method is entirely deterministic — it reads from the database through the Prisma client and returns a structured context object. It does not call the LLM API.

**Input type — `ContextAssemblyInput`:**
- `inboundCommunicationRecordId: string`
- `entryId?: string` — linked entry if available
- `inquiryId?: string` — linked inquiry if available

**Output type — `ContextAssemblyOutput`:**
- `inboundMessage: InboundMessageSummary` — the full inbound `CommunicationRecord`
- `entryCurrentStage?: StageIdentifier` — the entry's current stage
- `entryCurrentState?: EntryStatus` — the entry's current status
- `guestProfile?: GuestProfileSummary` — the linked guest profile if available
- `activeQuotation?: QuotationSummary` — the active quotation if in S2
- `activeReservation?: ReservationSummary` — the confirmed reservation if in S4+
- `communicationThreadHistory: CommunicationRecord[]` — ordered history of the thread

**What it guarantees:** Context assembly is side-effect-free. It reads; it does not write. It produces no records. The returned context is a point-in-time snapshot. The method is independently callable for testing without any LLM API connection being present.

**Why it is a named interface method:** Context assembly must be independently exercisable — it is tested separately from classification and draft generation. Defining it as an interface method enforces this separation at the contract level.

---

#### `AIAgentInterface.classifyIntent(context: ContextAssemblyOutput, messageContent: string): IntentClassificationResult`

**What it does:** Passes the assembled context and message content to the LLM API for intent classification. Returns the classified intent category and confidence score. Does not make any decision about what to do with the classification — that belongs to `AIAgentApprovalService`.

**Input types:**
- `context: ContextAssemblyOutput` — the output of `assembleContext()`
- `messageContent: string` — the text content of the inbound message

**Output type — `IntentClassificationResult`:**
- `intentCategory: IntentCategory` — one of the six categories below
- `confidenceScore: number` — value between 0 and 1

**The six intent categories (`IntentCategory` enum):**

| Category | Covers |
|---|---|
| `BOOKING` | New reservation requests, availability inquiries, quotation requests |
| `LIFECYCLE` | Amendment requests, cancellation requests, date change requests, stage progression actions |
| `FINANCIAL` | Payment confirmations, invoice queries, billing disputes, refund requests |
| `OPERATIONAL` | Mid-stay service requests, housekeeping requests, complaints, F&B requests |
| `OTA_SPECIFIC` | Booking confirmations from OTA platforms, OTA amendment notifications, OTA cancellations |
| `UNCLASSIFIABLE` | Message content that the LLM cannot confidently assign to any of the above categories |

**What it guarantees:** Exactly one `intentCategory` is returned. The `confidenceScore` is always present. For `UNCLASSIFIABLE` results, the confidence score reflects the LLM's certainty that no other category applies. No classification logic resides in this interface — the interface passes the input to the LLM and returns the typed result.

**Escalation note:** Whether to escalate based on low confidence is not this interface's decision. That evaluation belongs to `AIAgentApprovalService.processInbound()` per Policy 75.

---

#### `AIAgentInterface.generateDraft(input: DraftGenerationInput): DraftGenerationResult`

**What it does:** Passes the classified intent and assembled context to the LLM API for draft generation. Returns the draft content and any proposed system actions the LLM has identified. Does not evaluate, approve, or act on the draft — returning the LLM's output is the complete responsibility of this method.

**Input type — `DraftGenerationInput`:**
- `context: ContextAssemblyOutput` — the output of `assembleContext()`
- `intentCategory: IntentCategory` — the classification result
- `confidenceScore: number`

**Output type — `DraftGenerationResult`:**
- `draftContent: string` — the draft response text
- `proposedSystemActions: ProposedSystemAction[]` — each action the LLM proposes (e.g., stage transition, rate proposal, profile field update); proposals only — none are executed by this interface

**What it guarantees:** `draftContent` is the LLM's draft, unmodified. `proposedSystemActions` is the LLM's proposal set, unmodified. This interface evaluates neither. Execution of any proposed action requires a human approval event recorded by `AIAgentApprovalService`.

---

### 11.4.4 FULL_AUTO Scope Boundary — Enforced at Contract Level

The `AIAgentInterface` contract explicitly distinguishes between two classes of action based on FULL_AUTO applicability.

**Internal system actions — FULL_AUTO trust level may apply:**

The following action types are internal to the PMS and do not produce outbound communications to guests or agents. When the Admin Console trust level configuration permits FULL_AUTO for these categories, the interface's outputs for these actions may be acted upon without a human approval event:

- Intent classification (the classification result itself, not the draft it informs)
- Engagement tagging based on classified intent
- Guest profile field updates derived from confirmed inbound content
- Correction log aggregation entries
- AI audit supplement generation (invoked from `NightAuditService`)

**Outbound communication drafts — FULL_AUTO never applies:**

`draftContent` returned by `generateDraft()` is always an outbound communication draft. FULL_AUTO trust level does not apply to outbound communication drafts regardless of how the Admin Console trust level is configured. Every `draftContent` result requires a human approval event (`HumanDecisionType.APPROVE` or `HumanDecisionType.EDIT_AND_APPROVE`) before the content is sent.

This boundary is not implemented as a runtime check inside the LLM API call. It is enforced by what this interface exposes and what it refuses to expose. There is no `generateDraft()` variant that bypasses human approval. The enforcement is structural — `AIAgentApprovalService` holds the human approval gate, and `CommunicationService.send()` verifies the gate was passed before executing dispatch.

### 11.4.5 Voice Note Exclusion — Enforced at Contract Level

This interface has no method that accepts audio content, voice note file references, or unreviewed voice note transcriptions as input. The exclusion is a contract-level property, not a runtime guard inside any method.

Voice note content never reaches this interface. The routing block is implemented in `VoiceNoteRoutingService.route()`, which intercepts `MessageType.VOICE_NOTE` before any AI processing call is initiated. If a voice note payload were to reach `AIAgentApprovalService.processInbound()`, it throws a `PolicyViolationError` identifying a routing layer failure. This second-layer check is a defence-in-depth measure; the primary enforcement is the contract-level absence of any method capable of accepting voice note content.

### 11.4.6 Contract Requirements

The service layer may assume:

1. `assembleContext()` is side-effect-free, independently callable, and does not require an LLM API connection.
2. `classifyIntent()` always returns exactly one `IntentCategory` and a `confidenceScore`. The interface never returns an empty or ambiguous result — if the LLM cannot classify, it returns `UNCLASSIFIABLE`.
3. `generateDraft()` returns the LLM's output unmodified. The caller (`AIAgentApprovalService`) applies all evaluation, gating, and approval logic.
4. No method on this interface accepts voice note content. If voice note content is presented to this interface, the call fails with a `PolicyViolationError`.
5. FULL_AUTO trust level never bypasses human approval for `draftContent`. The interface provides no mechanism by which outbound drafts bypass the human decision gate.

### 11.4.7 Forbidden Patterns

- Any service calling the LLM API provider SDK directly.
- Any method on this interface that accepts audio content, unreviewed transcriptions, or voice note payloads.
- Classification logic or draft evaluation logic residing inside this interface.
- Returning a `draftContent` result in a form that bypasses the `AIAgentApprovalService` review gate.
- This interface deciding whether to escalate based on confidence score — that decision belongs to `AIAgentApprovalService`.

### 11.4.8 Technology Note

The AI agent interface implementation connects to an external LLM API. The specific provider is a locked implementation choice managed through environment configuration. The provider name and API endpoint are implementation details behind the interface — they do not appear in service code. The interface contract is independent of the specific LLM provider: any provider satisfying the classification and draft generation contracts could be substituted without changing service code or method signatures.

---

## §11.5 — File Storage Interface

### 11.5.1 Interface Name

`FileStorageInterface`

### 11.5.2 Purpose

Provides a storage abstraction for all governed documents and received files; no service accesses file storage through any path other than this interface.

### 11.5.3 Methods

#### `FileStorageInterface.store(content: FileContent, metadata: StorageMetadata): StorageReference`

**What it does:** Stores a file with the provided content and metadata. Returns a stable `StorageReference` that is used for all subsequent operations on this file. The underlying storage location (local path, S3 key, Azure Blob URI) is resolved by the implementation — it is not visible to the caller.

**Input types:**
- `content: FileContent` — the raw file content (buffer or stream)
- `metadata: StorageMetadata`:
  - `filename: string`
  - `mimeType: string`
  - `documentType: DocumentType` — e.g., `CONFIRMATION_VOUCHER`, `PROFORMA_INVOICE`, `FINAL_INVOICE`, `QUOTATION_DOCUMENT`, `REGISTRATION_FORM`, `OTA_RECEIPT`, `PORTAL_RECEIPT`, `INBOUND_ATTACHMENT`, `VOICE_NOTE_AUDIO`
  - `uploadedBy?: string` — actor identity if manually uploaded

**Output type — `StorageReference`:**
- `storageId: string` — system-generated stable identifier
- `storedAt: DateTime`
- `sizeBytes: number`

---

#### `FileStorageInterface.retrieve(storageReference: StorageReference): RetrievedFile`

**What it does:** Retrieves the file content for the given storage reference. Returns the file content and its metadata.

**Output type — `RetrievedFile`:**
- `content: FileContent`
- `metadata: StorageMetadata`
- `storageReference: StorageReference`

---

#### `FileStorageInterface.link(storageReference: StorageReference, targetType: LinkTargetType, targetId: string): LinkRecord`

**What it does:** Attaches a stored file to a PMS record. Creates a `LinkRecord` that associates the stored file with the target record.

**`LinkTargetType` values:**
- `COMMUNICATION_RECORD` — attaches the file to a `CommunicationRecord` (a document that is transmitted in a communication)
- `ENTRY` — attaches as supporting evidence to an `Entry`
- `FOLIO_LINE` — attaches as evidence to a `FolioLine`
- `PORTAL_RECEIPT_RECORD` — attaches as evidence to a government portal receipt record

**Output type — `LinkRecord`:**
- `linkId: string`
- `storageId: string`
- `targetType: LinkTargetType`
- `targetId: string`
- `linkedAt: DateTime`

---

#### `FileStorageInterface.storePortalReceipt(content: FileContent, portalReference: string, receiptAt: DateTime, metadata: StorageMetadata): PortalReceiptStorageResult`

**What it does:** Typed store method for government portal receipts. Stores the receipt file and creates a `PortalReceiptRecord` carrying `portalReference` and `receiptAt` alongside the storage reference.

**Additional fields over standard store:**
- `portalReference: string` — the portal-assigned reference number
- `receiptAt: DateTime` — the timestamp from the portal receipt

**Output type — `PortalReceiptStorageResult`:**
- `storageReference: StorageReference`
- `portalReceiptRecordId: string`
- `portalReference: string`
- `receiptAt: DateTime`

### 11.5.4 Contract Requirements

The service layer may assume:

1. A returned `StorageReference` is stable — it can be stored in a database column and retrieved later regardless of what happens to the underlying storage provider.
2. The underlying storage provider (local disk, S3, Azure Blob, or any future provider) is invisible to the caller. Provider-specific identifiers, paths, or credentials never appear in service code.
3. `link()` creates a durable association between a stored file and a PMS record. The association is queryable: given a `CommunicationRecord`, all linked files are retrievable via their `LinkRecord` associations.
4. `storePortalReceipt()` creates a `PortalReceiptRecord` in addition to storing the file. The service layer does not need to create the `PortalReceiptRecord` separately.

### 11.5.5 Forbidden Patterns

- Any service importing a storage SDK (AWS SDK S3 client, Azure Blob client, `fs` module for production file writes) directly.
- Storing a generated document without subsequently calling `link()` to associate it with the `CommunicationRecord` that transmits it.
- Service-level management of storage paths, bucket names, or container references.
- The `DocumentGenerationInterface` generating and returning raw file bytes to the service layer — it calls `FileStorageInterface.store()` and `link()` internally; the service layer receives a document reference, not raw bytes.

### 11.5.6 Technology Note

The file storage interface implementation abstracts the underlying storage provider. The current implementation target is defined in the deployment configuration. The interface contract is stable across local disk, S3, Azure Blob, or any other provider that can satisfy the store, retrieve, and link operations. Provider migration requires only an implementation change — no service code changes.

---

## §11.6 — Phone Call Log Interface

### 11.6.1 Interface Name

`PhoneCallLogInterface`

### 11.6.2 Purpose

Captures call records from the Android device call log and converts them into `CommunicationRecord` entries with `channel = PHONE`, including a de-duplication guard that ensures the same call never produces two records.

### 11.6.3 Methods

#### `PhoneCallLogInterface.pollCallLog(): CallLogBatch`

**What it does:** Retrieves new call records from the Android device's call log since the last poll timestamp. Returns the raw call records for processing.

**Output type — `CallLogBatch`:**
- `polledAt: DateTime`
- `lastPollTimestamp: DateTime` — the watermark used to exclude already-processed records
- `callRecords: RawCallLogEntry[]`
- `recordCount: number`

**Polling watermark:** The last-poll timestamp is persisted between polls. On each poll, only call records with a call timestamp after the watermark are returned. The watermark advances on successful processing.

---

#### `PhoneCallLogInterface.convertToCommunicationRecord(callLogEntry: RawCallLogEntry): CommunicationRecordPayload`

**What it does:** Maps a raw Android call log entry to the `CommunicationRecord` structure. Returns a typed payload ready for handoff to `CommunicationService.receiveInbound()`.

**Field mapping:**

| Android Call Log Field | `CommunicationRecord` Field | Notes |
|---|---|---|
| `NUMBER` | `fromAddress` | Caller phone number |
| `DATE` | `sentAt` / `receivedAt` | Call timestamp |
| `DURATION` | `callDuration` | Seconds |
| `TYPE` (INCOMING, OUTGOING, MISSED) | `direction`, `callType` | INCOMING → `INBOUND`; OUTGOING → `OUTBOUND`; MISSED → `INBOUND` with `callType = MISSED` |
| — | `channel` | Always `PHONE` |
| — | `messageType` | Always `STANDARD` for phone records |

---

#### `PhoneCallLogInterface.isDuplicate(callLogEntry: RawCallLogEntry): boolean`

**What it does:** Checks whether a `CommunicationRecord` already exists for this call log entry, identified by the combination of phone number, call timestamp, and call duration. Returns `true` if a duplicate is detected.

**De-duplication key:** `(phoneNumber, callTimestamp, callDuration)` — this three-field combination is treated as the call's natural key. A `CommunicationRecord` matching all three fields is a duplicate.

**When called:** `isDuplicate()` is called for every `RawCallLogEntry` before `convertToCommunicationRecord()` proceeds. A `true` result terminates processing for that entry — no record is created and no error is raised. The duplicate is logged at DEBUG level.

### 11.6.4 Contract Requirements

The service layer may assume:

1. Every call record returned by `pollCallLog()` that passes the de-duplication check has not previously been processed. Processing a non-duplicate entry will not create a duplicate `CommunicationRecord`.
2. `convertToCommunicationRecord()` produces a payload that is valid for handoff to `CommunicationService.receiveInbound()` without further field transformation.
3. `channel = PHONE` is always set by this interface. The service layer never sets it manually.
4. Missed calls produce an INBOUND `CommunicationRecord` with `callType = MISSED` — they are not silently discarded.

### 11.6.5 Forbidden Patterns

- Creating a `CommunicationRecord` for a call without first calling `isDuplicate()`.
- Any external system writing phone call records directly to PMS tables — all call records enter through this interface and then through `CommunicationService.receiveInbound()`.
- Discarding missed call entries — they are valid `CommunicationRecord` candidates.
- Advancing the poll watermark before successful processing completes — the watermark advances only after records have been successfully handed to `CommunicationService`.

### 11.6.6 Technology Note

The phone call log interface implementation integrates with the Android device call log. The integration mechanism (polling via a local agent, ADB bridge, or device-side application) is an implementation detail behind the interface. The interface contract — retrieve records, convert fields, enforce de-duplication — is independent of the specific integration mechanism. The locked implementation approach is Android call log integration, as defined in the technology stack.

---

## §11.7 — Financial Export Interface

### 11.7.1 Interface Name

`FinancialExportInterface`

### 11.7.2 Purpose

Produces structured exports of PMS financial records for the accounting system under the export model: the PMS produces, the accounting system consumes independently; PMS tables are never queried directly by the accounting system.

### 11.7.3 Methods

#### `FinancialExportInterface.triggerExport(trigger: ExportTrigger): ExportBatch`

**What it does:** Compiles the financial export data set for the trigger scope. Produces a structured `ExportBatch` — not raw SQL results, not a database dump, not a live query result. The export is a typed, schema-versioned structure that the accounting system can consume without any knowledge of the PMS's internal table structure.

**Input type — `ExportTrigger`:**
- `triggerType: 'INTERVAL' | 'EVENT'`
- `triggerScope: ExportScope` — date range or event reference
- `requestedBy?: string` — actor identity if manually triggered

**Output type — `ExportBatch`:**
- `batchId: string`
- `exportedAt: DateTime`
- `triggerType: ExportTrigger['triggerType']`
- `scope: ExportScope`
- `records: FinancialExportRecord[]`
- `schemaVersion: string` — identifies the export format version; the accounting system pins to a schema version
- `recordCount: number`

**`FinancialExportRecord` structure:** Each record includes the folio line data, payment records, invoice references, guest/entry references, and any relevant tax fields. The exact field set is defined in the Admin Console export configuration and is stable across delivery mechanism changes.

**Trigger types:**
- `INTERVAL` — fires on the configured schedule (daily, weekly, or per Admin Console configuration)
- `EVENT` — fires on specific events (folio closure, invoice finalization) when configured

---

#### `FinancialExportInterface.deliver(exportBatch: ExportBatch, mechanism: DeliveryMechanism): DeliveryRecord`

**What it does:** Delivers the export batch to the accounting system using the configured delivery mechanism. Returns a delivery record.

**`DeliveryMechanism` values:**
- `FILE` — writes the export to the configured output location (SFTP, shared directory, or other file drop point) as a file in the configured format (CSV, JSON, or structured XML)
- `API` — posts the export to the accounting system's API endpoint when the accounting system provides one

**Output type — `DeliveryRecord`:**
- `deliveryId: string`
- `batchId: string`
- `mechanism: DeliveryMechanism`
- `deliveredAt: DateTime`
- `status: 'DELIVERED' | 'FAILED'`
- `failureReason?: string`

**Export structure stability:** The `ExportBatch` structure and the `FinancialExportRecord` field set do not change when the delivery mechanism changes from `FILE` to `API`. Only the `deliver()` implementation beneath the interface changes. Service code that calls `triggerExport()` and `deliver()` does not change when the accounting system adds an API endpoint.

### 11.7.4 Contract Requirements

The service layer may assume:

1. The export structure is stable — the schema version in `ExportBatch` is the accounting system's pin point. Schema version changes require deliberate migration, not incidental delivery mechanism changes.
2. The accounting system never queries PMS tables directly. All financial data the accounting system receives comes from `ExportBatch` records produced by this interface.
3. Changing from `FILE` to `API` delivery requires only an implementation change to `deliver()` — no `ExportBatch` content changes, no service code changes.
4. Every `DeliveryRecord` is persisted. Failed deliveries are retryable by calling `deliver()` again with the same `ExportBatch`.

### 11.7.5 Forbidden Patterns

- Accounting system holding a connection string to the PMS database.
- Any mechanism by which the accounting system reads PMS tables directly, including read-only replicas exposed to external systems.
- Changing the `FinancialExportRecord` field set in response to a delivery mechanism change — field set changes are schema changes requiring deliberate versioning.
- Services bypassing this interface to produce ad-hoc financial reports for the accounting system.

### 11.7.6 Technology Note

The financial export interface currently implements `FILE`-based delivery. The export format is configured in the Admin Console. When the accounting system provides an API endpoint, the `deliver()` implementation adds `API` as a delivery mechanism — no interface contract changes. The `ExportBatch` structure is the stable contract between the two systems.

---

## §11.8 — Document Generation Interface

### 11.8.1 Interface Name

`DocumentGenerationInterface`

### 11.8.2 Purpose

Generates all governed documents — confirmation vouchers, proforma invoices, final invoices, quotation documents, and registration forms — storing each via `FileStorageInterface` and linking it to the transmitting `CommunicationRecord`; the service layer receives a document reference, not raw file bytes.

### 11.8.3 Methods

#### `DocumentGenerationInterface.generate(documentType: DocumentType, input: DocumentGenerationInput): DocumentGenerationResult`

**What it does:** Generates a governed document of the specified type using the template for that type (retrieved from Admin Console-managed template storage). Stores the generated file via `FileStorageInterface.store()`. Links the stored file to the transmitting `CommunicationRecord` via `FileStorageInterface.link()`. Returns a `DocumentGenerationResult` carrying the storage reference and link confirmation.

**Input type — `DocumentType` values:**

| Value | Document |
|---|---|
| `CONFIRMATION_VOUCHER` | Guest confirmation voucher issued at S4 |
| `PROFORMA_INVOICE` | Proforma invoice issued at S3 |
| `FINAL_INVOICE` | Final invoice issued at S8 |
| `QUOTATION_DOCUMENT` | Quotation document issued at S2 |
| `REGISTRATION_FORM` | Registration form issued at S6 for guest completion |

**Input type — `DocumentGenerationInput`:**
- `entryId: string`
- `segmentId?: string`
- `communicationRecordId: string` — the `CommunicationRecord` to which the document will be linked
- `actorId: string`
- `templateOverride?: string` — explicit template reference if the default template is not to be used (requires FOM authority in calling context)

**Output type — `DocumentGenerationResult`:**
- `documentId: string` — system-generated document identifier
- `storageReference: StorageReference` — stable reference to the stored file
- `linkRecordId: string` — confirms the link to the `CommunicationRecord`
- `generatedAt: DateTime`
- `documentType: DocumentType`
- `templateVersion: string` — the version of the template used (for audit trail)

**Internal call sequence (not visible to service caller):**
1. `getTemplate(documentType)` — retrieves the current template
2. Populates template with data from `DocumentGenerationInput`
3. `FileStorageInterface.store(generatedContent, metadata)` — stores the document
4. `FileStorageInterface.link(storageReference, 'COMMUNICATION_RECORD', communicationRecordId)` — links to the transmitting `CommunicationRecord`
5. Returns `DocumentGenerationResult`

---

#### `DocumentGenerationInterface.getTemplate(documentType: DocumentType): DocumentTemplate`

**What it does:** Retrieves the current active template for the specified document type from Admin Console-managed template storage. Templates are managed by GM through the Admin Console.

**Output type — `DocumentTemplate`:**
- `templateId: string`
- `templateVersion: string`
- `documentType: DocumentType`
- `content: string` — the template body with placeholder markers
- `requiredFields: string[]` — fields that must be populated before generation proceeds
- `lastUpdatedAt: DateTime`

**Bhutanese regulatory compliance:** Invoice templates (PROFORMA_INVOICE, FINAL_INVOICE) carry the following fields, populated from Admin Console configuration:
- Invoice number format (sequential numbering per regulatory requirement)
- Required disclosure text (per regulatory mandate)
- Tax registration number (BTN/TPN as applicable)

These fields are present in the template managed through the Admin Console. They are not hardcoded in this interface or its implementation. When regulatory requirements change, the template is updated through the Admin Console without any code change.

### 11.8.4 Contract Requirements

The service layer may assume:

1. `generate()` handles all storage and linking internally. The service layer calls `generate()` once and receives a document reference. It does not call `FileStorageInterface.store()` or `link()` separately for generated documents.
2. The returned `storageReference` is immediately usable for `FileStorageInterface.retrieve()` or for inclusion in a `CommunicationService.send()` call as an attachment reference.
3. Bhutanese regulatory fields (invoice number, disclosure text, tax registration number) are present and correctly populated in invoice documents. The service layer does not manage these fields.
4. The underlying document generation library (PDF generator, document renderer) is an implementation detail. The method signature and output types are stable regardless of which library produces the file.
5. Template version is recorded in `DocumentGenerationResult` for full audit traceability — the exact template used for any generated document is reconstructable.

### 11.8.5 Forbidden Patterns

- Any service calling `FileStorageInterface.store()` or `FileStorageInterface.link()` directly for documents that are generated by this interface.
- Hardcoding invoice number format, regulatory disclosure text, or tax registration numbers in this interface's implementation.
- Services receiving raw file bytes from this interface — the return value is always a `DocumentGenerationResult` with a storage reference.
- Generating a document without linking it to the transmitting `CommunicationRecord` — the link is mandatory and is performed internally by this interface.
- Using a template that does not carry the required regulatory fields on invoice document types.

### 11.8.6 Technology Note

The document generation interface implementation uses an abstracted document generation library. The specific library is an implementation detail. The interface contract — `generate()`, `getTemplate()`, typed input/output — is stable regardless of the underlying renderer. Swapping the document generation library requires only an implementation change; the interface contract and all service code that calls it are unaffected.

---

## Backfill Registry (Carry-Forward)

The following items are carried forward from prior gates. No action is taken on any of them at Gate 11.

| # | Category | Target | Location | Change Required | Blocking? |
|---|---|---|---|---|---|
| P4 | A — Non-blocking | DEV-SPEC-001-Part2.md | §2.17.3 | Add `ai.correctionLog.maximumSize` config key | No |
| P5 | B — Blocking | DEV-SPEC-001-Part6.md | §6.5 | Write 8 missing domain service sections; triggers verification passes for Parts 9 and 10 | Blocks Part 10 full lock; Gate 12 not blocked |
| B4-001 (remainder) | B — Blocking (Parts 2 and 9 only) | Part 2 four models; Part 9 §9.2.3 | Add `version Int @default(1)` to `Entry`, `GuestProfile`, `Quotation`, `WorkOrderToDoItem`; complete §9.2.3 concurrent editing middleware section | Does not block Gates 11–13 |

---

*End of DEV-SPEC-001 Part 11 — Integration Interfaces*

*Gate 11 complete — Pending Architect Review*
