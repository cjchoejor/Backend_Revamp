import * as fs from "node:fs";
import * as path from "node:path";

type Step = {
  title: string;
  method: string;
  apiPath: string;
  actorLevel: string;
  actorId: string;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
};

function safeJson(v: unknown) {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
}

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/^e2e-/, "")
    .replace(/^e2e_/, "")
    .replace(/^e2e/, "")
    .replace(/\.no-db\.md$/i, "")
    .replace(/\.md$/i, "")
    .replace(/-test-report$/i, "")
    .replace(/-report$/i, "")
    .replace(/-no-db$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parseHeader(md: string) {
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "E2E report";
  const ranAt = md.match(/^- \*\*Ran at\*\*:\s+(.+)$/m)?.[1]?.trim() ?? null;
  const baseUrl = md.match(/^- \*\*Base URL\*\*:\s+`([^`]+)`/m)?.[1]?.trim() ?? null;
  const entryId = md.match(/^- \*\*Entry ID\*\*:\s+`([^`]+)`/m)?.[1]?.trim() ?? null;
  const inquiryId = md.match(/^- \*\*Inquiry ID\*\*:\s+`([^`]+)`/m)?.[1]?.trim() ?? null;
  return { title, ranAt, baseUrl, entryId, inquiryId };
}

function parseSteps(md: string): Step[] {
  const lines = md.split(/\r?\n/);
  const steps: Step[] = [];

  for (let i = 0; i < lines.length; i++) {
    const h = lines[i];
    if (!h.startsWith("### ")) continue;
    const title = h.slice(4).trim();

    // Find request line
    let method = "";
    let apiPath = "";
    let actorLevel = "";
    let actorId = "";
    let requestBody: unknown = null;
    let status = -1;
    let responseBody: unknown = null;

    // request bullet usually within next ~10 lines
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      const l = lines[j];
      const m = l.match(/^- \*\*Request\*\*:\s+`([^`]+)`\s+`([^`]+)`\s+\(actor\s+`([^`]+)`\s+\/\s+`([^`]+)`\)/);
      if (m) {
        method = m[1];
        apiPath = m[2];
        actorLevel = m[3];
        actorId = m[4];
        break;
      }
    }

    // request body code fence
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "```json" && lines[j - 1]?.trim() === "") {
        // this is either request body or response body; we detect by looking back a bit for "Request" or "Response"
        const prev = lines.slice(Math.max(i, j - 10), j).join("\n");
        const end = lines.indexOf("```", j + 1);
        if (end === -1) break;
        const payload = lines.slice(j + 1, end).join("\n").trim();
        let parsed: unknown = payload;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // keep as string
        }
        if (prev.includes("**Request**")) {
          requestBody = (parsed as any)?.body ?? parsed;
        } else if (prev.includes("**Response**")) {
          responseBody = parsed;
        }
        j = end;
      }

      const rs = lines[j].match(/^- \*\*Response\*\*:\s+HTTP\s+(\d+)/);
      if (rs) status = Number(rs[1]);

      // stop after next step heading
      if (j > i + 1 && lines[j].startsWith("### ")) break;
    }

    steps.push({
      title,
      method,
      apiPath,
      actorLevel,
      actorId,
      requestBody: safeJson(requestBody),
      status,
      responseBody: safeJson(responseBody),
    });
  }

  return steps;
}

function classifyFromSteps(steps: Step[]) {
  const services = new Set<string>();
  const workers = new Set<string>();
  const engines = new Set<string>();
  const timers = new Set<string>();
  const policies = new Set<string>();

  for (const s of steps) {
    const p = s.apiPath;

    if (s.method === "WORKER") {
      if (p.includes("PRE_ARRIVAL_COUNTDOWN_W4")) workers.add("W4 PreArrivalWindowActivationWorker");
      if (p.includes("POST_CHECKOUT_INSPECTION_W9")) workers.add("W9 PostCheckoutInspectionWorker");
      continue;
    }

    if (p === "/inquiries") services.add("s1-inquiry-service");
    if (p === "/entries") services.add("s1-entry-service");
    if (p.startsWith("/availability/")) {
      services.add("s1-availability-service");
      engines.add("availability-engine");
    }
    if (p.includes("/processing-locks")) services.add("s1-processing-lock-service");

    if (p.includes("/quotations")) services.add("s2-quotation-service");
    if (p.includes("/holds/speculative")) services.add("s2-hold-service");
    if (p.includes("/holds/committed")) services.add("s3-hold-service");

    if (p.includes("/folio/provisional")) services.add("s3-reservation-setup-service");
    if (p.includes("/folios/") && p.endsWith("/payments")) services.add("payment-record route (S3 payments)");
    if (p.includes("/advance-payment/reconcile")) services.add("s3-payment-service (advance payment reconcile)");
    if (p.includes("/credit-extension")) services.add("s3-payment-service (credit extension)");
    if (p.includes("/disclosures/cancellation")) services.add("s3-cancellation-disclosure-service");

    if (p.includes("/confirm")) services.add("s4-confirmation-service");

    if (p.includes("/pre-arrival-tasks/")) services.add("pre-arrival-service");
    if (p.includes("/room-assignments")) services.add("room-assignment-service");

    if (p.includes("/handoffs/") && (p.endsWith("/accept") || p.endsWith("/reject") || p.endsWith("/fulfil"))) services.add("handoff-service");
    if (p.includes("/handoffs/h2") || p.includes("/handoffs/h4")) services.add("handoff-service");

    if (p.includes("/progress-stage")) services.add("entry-service (+ check-in-service for S6->S7)");

    if (p === "/night-audit/run") services.add("s7-night-audit-service");

    if (p.includes("/key-return") || p.includes("/room-inspection")) services.add("s8-checkout-service");
    if (p.includes("/settle")) services.add("s8-settlement-service");

    if (p.includes("/folios/") && p.endsWith("/invoices")) services.add("s9-service (listInvoices)");
    if (p.includes("/invoices/") && p.endsWith("/dispatch")) services.add("s9-service (dispatchInvoice)");
    if (p.includes("/folios/") && p.endsWith("/write-off")) services.add("s9-service (writeOffOutstandingBalance)");
    if (p.includes("/entries/") && p.endsWith("/close")) services.add("s9-service (closeEntryAtS9)");

    if (p.includes("/entries/") && p.endsWith("/no-show")) services.add("no-show-service");
    if (p.includes("/entries/") && p.endsWith("/cancel")) services.add("cancellation-service");

    // Timers likely involved based on flows (conservative list)
    if (p.includes("/confirm")) {
      timers.add("ACKNOWLEDGEMENT_WINDOW_W22");
      timers.add("PRE_ARRIVAL_COUNTDOWN_W4");
    }
    if (p.includes("/holds/committed")) timers.add("COMMITTED_HOLD_EXPIRY_W3");
    if (p.includes("/room-inspection") && (s.requestBody as any)?.isDeferred === true) timers.add("POST_CHECKOUT_INSPECTION_W9");
  }

  // Policies / gates hinted by common step types
  if ([...services].some((x) => x.includes("entry-service"))) policies.add("Optimistic locking via Entry.version");
  if ([...services].some((x) => x.includes("handoff-service"))) policies.add("H1/H4/H5 checklist evidence completeness gates");
  if ([...services].some((x) => x.includes("s8-settlement-service"))) policies.add("Settlement method + billingModelConfirmation validation");
  if ([...services].some((x) => x.includes("s9-service"))) policies.add("S9 closure gates (invoices dispatched, inspection resolved, H5 not open, etc.)");

  return {
    services: [...services].sort(),
    workers: [...workers].sort(),
    engines: [...engines].sort(),
    timers: [...timers].sort(),
    policies: [...policies].sort(),
  };
}

function deriveGoal(fileBase: string) {
  const b = fileBase.toLowerCase();
  if (b.includes("basic")) return "Validate the baseline happy-path reservation flow from S1 to S9 closure.";
  if (b.includes("direct-bill")) return "Validate DIRECT_BILL billing model flow through S9 closure.";
  if (b.includes("voucher")) return "Validate VOUCHER settlement (partial coverage) leading to OUTSTANDING + H5 + closure.";
  if (b.includes("post-stay-charge")) return "Validate adding a post-stay charge after entry is closed at S9 (L2 authority).";
  if (b.includes("outstanding") && b.includes("writeoff")) return "Validate OUTSTANDING folio write-off then close at S9 (GM authority).";
  if (b.includes("cancel")) return "Validate S5 cancellation path.";
  if (b.includes("no-show-defer-reactivate")) return "Validate S5 no-show DEFER then REACTIVATE path.";
  if (b.includes("no-show") && b.includes("terminal")) return "Validate S5 no-show SUB_PATH_1 leading to TERMINAL and NO_SHOW_CLOSED folio.";
  if (b.includes("deferred-inspection")) return "Validate deferred inspection at S8 and W9 lapse trace allowing S9 closure.";
  return "Validate E2E flow correctness for this scenario.";
}

function bossMd(params: {
  sourcePath: string;
  header: ReturnType<typeof parseHeader>;
  steps: Step[];
}) {
  const { sourcePath, header, steps } = params;
  const ok = steps.length > 0 && steps.every((s) => s.status >= 200 && s.status < 500) && steps.some((s) => s.status >= 200 && s.status < 300);

  const finalStatus = steps[steps.length - 1]?.status ?? null;
  const goal = deriveGoal(path.basename(sourcePath));

  const stepBullets = steps.map((s) => {
    const body = s.requestBody ?? null;
    return [
      `### ${s.title}`,
      `- **Goal**: Execute \`${s.method}\` \`${s.apiPath}\` and advance scenario state.`,
      `- **Request**: actor \`${s.actorLevel}\`/\`${s.actorId}\``,
      "",
      "```json",
      JSON.stringify({ method: s.method, path: s.apiPath, body }, null, 2),
      "```",
      "",
      `- **Response**: HTTP ${s.status}`,
      "",
      "```json",
      JSON.stringify(s.responseBody ?? null, null, 2),
      "```",
      "",
      `- **Achieved**: ${s.status >= 200 && s.status < 300 ? "YES" : "NO"}`,
      "",
    ].join("\n");
  });

  return [
    "# Boss summary report",
    "",
    `- **Source report**: \`${sourcePath}\``,
    `- **Scenario title**: ${header.title}`,
    `- **Goal**: ${goal}`,
    `- **Base URL**: ${header.baseUrl ? `\`${header.baseUrl}\`` : "unknown"}`,
    `- **Entry ID**: ${header.entryId ? `\`${header.entryId}\`` : "unknown"}`,
    `- **Inquiry ID**: ${header.inquiryId ? `\`${header.inquiryId}\`` : "unknown"}`,
    `- **Result**: ${ok ? "**PASS (flow executed to end)**" : `**CHECK** (final HTTP ${finalStatus ?? "n/a"})`}`,
    "",
    "## API trace (request/response)",
    "",
    ...stepBullets,
    "",
  ].join("\n");
}

async function main() {
  const repoRoot = path.resolve(process.cwd(), "..");
  const outRoot = path.join(repoRoot, "Documentation_V2", "Boss");
  fs.mkdirSync(outRoot, { recursive: true });

  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    throw new Error("Pass one or more input report paths (relative to repo root).");
  }

  for (const rel of inputs) {
    const inPath = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    const md = fs.readFileSync(inPath, "utf8");
    const header = parseHeader(md);
    const steps = parseSteps(md);
    const outName = `${slugify(path.basename(inPath))}.md`;
    const outPath = path.join(outRoot, outName);
    fs.writeFileSync(outPath, bossMd({ sourcePath: rel, header, steps }), "utf8");
  }

  console.log(`Wrote Boss reports to ${outRoot}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

