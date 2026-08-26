import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputPath = resolve("demo/comprehensive-complex.jsonl");
const recordCount = 1000;

const recordTypes = [
  "enterprise_customer_case",
  "commerce_fulfillment_report",
  "distributed_system_event",
  "security_investigation",
  "scientific_observation",
  "multimedia_catalog_entry",
  "financial_reconciliation",
  "infrastructure_incident",
  "knowledge_base_article",
  "regulatory_audit_record",
];

const organizations = [
  "Northstar Research Cooperative",
  "Meridian Urban Systems",
  "Blue Harbor Logistics Group",
  "Redwood Clinical Analytics",
  "Atlas Renewable Infrastructure",
  "Silverline Public Media",
  "Cedar Valley Manufacturing",
  "Horizon Education Network",
  "Keystone Financial Services",
  "Orchard Aerospace Laboratories",
];

const regions = [
  ["Seattle", "Washington", "US", "America/Los_Angeles"],
  ["Toronto", "Ontario", "CA", "America/Toronto"],
  ["London", "England", "GB", "Europe/London"],
  ["Berlin", "Berlin", "DE", "Europe/Berlin"],
  ["Singapore", "Singapore", "SG", "Asia/Singapore"],
  ["Sydney", "New South Wales", "AU", "Australia/Sydney"],
  ["Dublin", "Leinster", "IE", "Europe/Dublin"],
  ["Tokyo", "Tokyo", "JP", "Asia/Tokyo"],
  ["Cape Town", "Western Cape", "ZA", "Africa/Johannesburg"],
  ["Sao Paulo", "Sao Paulo", "BR", "America/Sao_Paulo"],
];

const narrativeParagraphs = [
  "The review began after operators noticed a subtle mismatch between the dashboard summary and the underlying event stream. The visible totals were internally consistent, yet a narrow interval around the regional failover contained repeated delivery attempts, delayed acknowledgments, and several records whose processing timestamps preceded their storage timestamps. Engineers preserved the original evidence, created a read-only snapshot, and compared application logs with broker offsets before proposing any corrective action. This cautious sequence mattered because an early replay could have hidden the timing relationship that ultimately explained the discrepancy.",
  "The working group included application engineers, security analysts, support specialists, data stewards, and representatives from the affected business unit. Each participant documented assumptions in plain language so that decisions could be reviewed by people outside the immediate technical team. The group distinguished confirmed facts from plausible interpretations, assigned an owner to every open question, and recorded what evidence would be sufficient to close it. Daily updates emphasized customer impact, containment status, data integrity, and the remaining uncertainty rather than presenting a single premature conclusion.",
  "Testing covered routine requests, unusually large payloads, empty collections, optional fields, expired credentials, reordered messages, network interruption, partial dependency failure, and recovery after a cold restart. The team also exercised daylight-saving transitions, leap-day dates, high-precision decimal values, identifiers larger than the safe integer range in some programming languages, and strings containing quotation marks, backslashes, tabs, embedded newline escapes, symbols, and emoji. Results were captured with stable correlation identifiers so that every observation could be traced across gateway, service, worker, database, and archive logs.",
  "The proposed design keeps business identity separate from transport identity. A stable event identifier follows the business fact through retries and replays, while a distinct delivery identifier describes each attempt to move that fact between systems. Consumers persist the stable identifier in the same transactional boundary as the business mutation whenever possible. Short-lived caches reduce unnecessary work but never serve as the only correctness mechanism, because cache eviction, deployment, disaster recovery, and historical replay can reintroduce older events at any time.",
  "Operational safeguards include bounded exponential backoff, randomized retry delay, circuit breaking, bulkhead isolation, admission control, and a quarantine queue for records that cannot be processed safely. Alert thresholds use both rate and duration to avoid paging on harmless transient noise. Runbooks name the exact dashboards, queries, rollback criteria, and communication channels required during an incident. They also describe when automation must stop and request human review, particularly when a remediation could delete data, broaden access, change financial balances, or notify external parties.",
  "After the immediate issue was contained, the organization scheduled a retrospective focused on system conditions rather than individual blame. Follow-up work included improving documentation, adding invariant checks near ingestion, expanding synthetic monitoring, clarifying ownership boundaries, and rehearsing recovery with realistic traffic. The final report retained enough technical detail for independent verification while providing an executive summary that explained impact and risk without specialized jargon. No evidence was discarded merely because it complicated the preferred explanation.",
  "Long-term measurement will compare error rates, latency percentiles, duplicate suppression, queue age, manual intervention, customer contacts, and time to confident diagnosis. A successful outcome is not simply the absence of another alert; it is a system whose behavior remains understandable during stress and whose operators can make safe decisions with incomplete information. Metrics therefore include leading indicators such as saturation and retry amplification as well as lagging indicators such as failed transactions, missed objectives, and support escalations.",
  "The record intentionally contains substantial narrative detail because realistic data is rarely composed only of short labels and convenient scalar values. Search tools should find terms deep inside nested objects, preview interfaces should wrap or truncate long passages predictably, exporters should preserve every escaped character, and parsers should process one physical line as one complete JSON value. Systems that infer columns should tolerate shape variation without losing access to uncommon fields that appear in only a small percentage of records.",
];

const pad = (value, width = 6) => String(value).padStart(width, "0");
const iso = (recordIndex, minuteOffset = 0) =>
  new Date(Date.UTC(2026, 7, 1 + (recordIndex % 25), 8 + (recordIndex % 10), (recordIndex * 7 + minuteOffset) % 60, (recordIndex * 13) % 60, recordIndex % 1000)).toISOString();

function makeNarrative(index) {
  const rotated = narrativeParagraphs.map((_, offset) => narrativeParagraphs[(index + offset) % narrativeParagraphs.length]);
  return rotated.join("\n\n");
}

function makeTimeline(index) {
  const actions = ["received", "validated", "classified", "assigned", "investigated", "contained", "verified", "documented", "reviewed", "closed"];
  return actions.map((action, step) => ({
    sequence: step + 1,
    action,
    at: iso(index, step * 4),
    actor: step % 3 === 0 ? "automation/orchestrator" : `user/operator-${pad((index + step) % 97, 3)}`,
    source_ip: `198.51.100.${1 + ((index * 11 + step) % 253)}`,
    outcome: step === 5 && index % 7 === 0 ? "completed_with_warning" : "completed",
    duration_ms: Number((12.5 + ((index * 17 + step * 31) % 4800) / 10).toFixed(3)),
    note: `${action[0].toUpperCase()}${action.slice(1)} step ${step + 1} completed for record ${pad(index + 1)} with preserved evidence and an auditable decision trail.`,
  }));
}

function makeLineItems(index) {
  return Array.from({ length: 8 }, (_, itemIndex) => {
    const quantity = 1 + ((index + itemIndex) % 12);
    const unitPrice = Number((19.95 + ((index * 37 + itemIndex * 113) % 180000) / 100).toFixed(2));
    const discountRate = [0, 0.05, 0.1, 0.125, 0.2][(index + itemIndex) % 5];
    return {
      line_id: `line_${pad(index + 1)}_${pad(itemIndex + 1, 2)}`,
      sku: `SKU-${pad((index * 8 + itemIndex) % 999999)}-${["ALPHA", "BRAVO", "CHARLIE", "DELTA"][itemIndex % 4]}`,
      name: ["Precision Monitoring Module", "Encrypted Storage Gateway", "Adjustable Laboratory Platform", "High-Density Network Adapter"][itemIndex % 4],
      description: "A configurable component supplied with installation guidance, serialized traceability, environmental limits, maintenance requirements, and a three-year standard warranty.",
      quantity,
      unit_price: unitPrice,
      discount_rate: discountRate,
      extended_price: Number((quantity * unitPrice * (1 - discountRate)).toFixed(2)),
      taxable: itemIndex % 5 !== 0,
      dimensions_cm: { length: 12.4 + itemIndex, width: 8.1 + itemIndex / 2, height: 2.5 + itemIndex / 3 },
      weight_kg: Number((0.42 + itemIndex * 0.87).toFixed(3)),
      attributes: { color: ["graphite", "silver", "navy", "white"][itemIndex % 4], material: ["aluminum", "steel", "polycarbonate"][itemIndex % 3], serialized: true },
    };
  });
}

function makeMeasurements(index) {
  const names = ["request_rate", "error_rate", "latency_p50_ms", "latency_p95_ms", "latency_p99_ms", "cpu_utilization", "memory_utilization", "cache_hit_ratio", "queue_depth", "oldest_message_age_s", "network_receive_mbps", "network_transmit_mbps"];
  return names.map((name, measurementIndex) => ({
    name,
    value: Number((((index + 1) * (measurementIndex + 3) * 1.61803398875) % 10000).toFixed(6)),
    unit: name.includes("latency") ? "milliseconds" : name.includes("rate") || name.includes("ratio") || name.includes("utilization") ? "ratio_or_rate" : "count_or_capacity",
    quality: measurementIndex === 9 && index % 13 === 0 ? "estimated" : "observed",
    sample_count: 300 + ((index * 19 + measurementIndex * 7) % 50000),
    window: { start: iso(index, -5), end: iso(index, 0), duration_seconds: 300 },
    thresholds: { warning: 70 + measurementIndex, critical: 90 + measurementIndex, direction: measurementIndex === 7 ? "below" : "above" },
  }));
}

function makeAttachments(index) {
  const extensions = ["json", "csv", "txt", "png", "pdf"];
  return extensions.map((extension, attachmentIndex) => ({
    attachment_id: `att_${pad(index + 1)}_${attachmentIndex + 1}`,
    filename: `record-${pad(index + 1)}-evidence-${attachmentIndex + 1}.${extension}`,
    content_type: ["application/json", "text/csv", "text/plain", "image/png", "application/pdf"][attachmentIndex],
    size_bytes: 4821 + ((index * 982451653 + attachmentIndex * 104729) % 19000000),
    sha256: `${pad(index + 1, 8)}${pad(attachmentIndex + 1, 8)}${"abcdef0123456789".repeat(3)}`.slice(0, 64),
    encrypted: true,
    retention: { policy: "seven_years", expires_at: `2033-${String(1 + (index % 12)).padStart(2, "0")}-28T00:00:00.000Z` },
    scan: { status: "clean", engine: "content-safety-scanner", scanned_at: iso(index, attachmentIndex) },
  }));
}

function makeRecord(index) {
  const type = recordTypes[index % recordTypes.length];
  const organization = organizations[index % organizations.length];
  const [city, region, countryCode, timezone] = regions[index % regions.length];
  const recordNumber = pad(index + 1);
  const largeIdentifier = (9007199254740993n + BigInt(index) * 104729n).toString();
  const status = ["new", "active", "investigating", "monitoring", "resolved", "archived"][index % 6];

  return {
    schema_version: "3.0.0",
    record_id: `rec_${recordNumber}`,
    record_type: type,
    correlation_id: `corr_202608_${recordNumber}_${(index * 2654435761 >>> 0).toString(16).padStart(8, "0")}`,
    sequence: index + 1,
    created_at: iso(index),
    updated_at: iso(index, 19),
    status,
    active: !["resolved", "archived"].includes(status),
    priority: 1 + (index % 5),
    organization: {
      organization_id: `org_${pad((index % organizations.length) + 1, 4)}`,
      legal_name: organization,
      display_name: organization.replace(/ (Group|Cooperative|Network|Services|Laboratories)$/, ""),
      industry: ["research", "public infrastructure", "logistics", "healthcare analytics", "renewable energy"][index % 5],
      employee_count: 180 + ((index * 41) % 48000),
      annual_revenue: { amount: 12500000 + index * 918273, currency: ["USD", "CAD", "GBP", "EUR", "SGD"][index % 5] },
      regulated: index % 3 === 0,
      certifications: ["ISO 27001", "SOC 2 Type II", "ISO 22301"],
    },
    contact: {
      contact_id: `person_${recordNumber}`,
      name: { title: index % 4 === 0 ? "Dr." : null, first: ["Avery", "Morgan", "Jordan", "Taylor", "Cameron"][index % 5], middle: ["Lee", "Quinn", "Riley", "Sage"][index % 4], last: ["Bennett", "Okafor", "Chen", "Patel", "Martinez"][index % 5] },
      email: `contact.${recordNumber}+jsonl@example.org`,
      phone: `+1-555-${pad(1000 + (index % 9000), 4)}`,
      job_title: ["Principal Systems Architect", "Director of Operations", "Senior Security Analyst", "Research Program Manager"][index % 4],
      locale: "en-US",
      preferred_channel: ["email", "phone", "secure_portal"][index % 3],
      verified: true,
    },
    location: {
      address: { line1: `${100 + (index % 8800)} Innovation Avenue`, line2: `Building ${String.fromCharCode(65 + (index % 6))}, Floor ${1 + (index % 24)}`, city, region, postal_code: `${10000 + (index % 89999)}`, country_code: countryCode },
      timezone,
      coordinates: { latitude: Number((-60 + ((index * 7.123) % 120)).toFixed(6)), longitude: Number((-170 + ((index * 11.719) % 340)).toFixed(6)), accuracy_meters: 12.5 },
    },
    financials: {
      currency: ["USD", "EUR", "GBP", "CAD", "SGD", "AUD"][index % 6],
      subtotal: Number((1842.15 + index * 13.71).toFixed(2)),
      discount: Number((index % 7 === 0 ? 184.22 : 0).toFixed(2)),
      tax: Number((341.67 + (index % 31) * 2.19).toFixed(2)),
      total: Number((2183.82 + index * 13.71).toFixed(2)),
      balance: index % 4 === 0 ? 0 : Number((125.75 + index * 1.11).toFixed(2)),
      large_ledger_identifier: largeIdentifier,
      exchange_rate: Number((0.781234567891 + (index % 100) / 100000).toFixed(12)),
      reconciled: index % 9 !== 0,
    },
    line_items: makeLineItems(index),
    measurements: makeMeasurements(index),
    narrative: {
      title: `Comprehensive investigation and operational review for ${organization}, record ${recordNumber}`,
      executive_summary: "A multidisciplinary review verified the integrity of core business data, identified a bounded interval of degraded processing, and documented the controls required for safe recovery. Customer-facing service remained available, although a small percentage of operations experienced additional latency and repeated transport attempts.",
      full_text: makeNarrative(index),
      word_count_estimate: 1080,
      reading_time_minutes: 6,
      language: "en",
      sentiment: "neutral_and_factual",
    },
    timeline: makeTimeline(index),
    attachments: makeAttachments(index),
    technical_context: {
      environment: index % 11 === 0 ? "staging" : "production",
      cloud: { provider: ["aws", "azure", "gcp"][index % 3], region: ["us-west-2", "eu-central-1", "ap-southeast-1"][index % 3], account_id: `${100000000000 + index}` },
      runtime: { language: ["TypeScript", "Go", "Python", "Rust"][index % 4], version: ["24.6.0", "1.25.0", "3.14.0", "1.89.0"][index % 4], architecture: index % 2 ? "arm64" : "x86_64" },
      deployment: { cluster: `prod-cluster-${1 + (index % 8)}`, namespace: type.replaceAll("_", "-"), replicas_desired: 12 + (index % 20), replicas_ready: 12 + (index % 20) - (index % 17 === 0 ? 1 : 0), release: `2026.08.${pad(1 + (index % 26), 2)}+build.${1000 + index}` },
      request: { method: ["GET", "POST", "PUT", "PATCH"][index % 4], path: `/v3/records/${recordNumber}/operations`, status_code: index % 17 === 0 ? 503 : 200, duration_ms: Number((18.42 + (index % 101) * 3.17).toFixed(3)), retry_count: index % 17 === 0 ? 3 : 0 },
      trace: { trace_id: `${recordNumber}${"4bf92f3577b34da6a3ce929d"}`.slice(0, 32), span_id: `${recordNumber}0ba902b7`.slice(0, 16), sampled: true },
    },
    compliance: {
      classification: index % 4 === 0 ? "confidential" : "internal",
      contains_personal_data: true,
      frameworks: [{ name: "SOC 2", controls: ["CC6.1", "CC7.2", "CC8.1"] }, { name: "ISO 27001:2022", controls: ["A.5.24", "A.8.15", "A.8.16"] }],
      retention: { policy: "business_records_seven_years", legal_hold: index % 97 === 0, deletion_eligible_at: `2033-${String(1 + (index % 12)).padStart(2, "0")}-28T00:00:00.000Z` },
      consent: { required: true, granted: true, version: "2026-04-01", captured_at: iso(index, -30) },
    },
    edge_cases: {
      empty_string: "",
      whitespace_string: "  preserved whitespace  ",
      null_value: null,
      empty_array: [],
      empty_object: {},
      escaped_text: "Quoted text: \"valid JSON\"; path: C:\\Program Files\\Example\\config.json; embedded newline follows:\nSecond logical line with a tab\tand an em dash —.",
      unicode_english: "A café résumé mentions naïve cooperation, a façade, an Ångström measurement, 23.5 °C, copyright ©, trademark ™, and status symbols ✅ ⚠️ ❌.",
      html_fragment: "<section data-state=\"ready\"><h2>Evidence &amp; Review</h2><p>This remains plain text.</p></section>",
      markdown_fragment: "## Review notes\n\n- Evidence preserved\n- Assumptions documented\n- [Runbook](https://docs.example.org/runbooks/recovery?q=jsonl&lang=en)",
      serialized_json: "{\"embedded\":true,\"values\":[1,2,3],\"message\":\"JSON stored inside a string\"}",
      large_integer_as_string: largeIdentifier,
      scientific_values: { avogadro_constant: 6.02214076e23, elementary_charge_coulombs: 1.602176634e-19 },
    },
    labels: [type, status, countryCode.toLowerCase(), `priority-${1 + (index % 5)}`, index % 2 ? "odd-sequence" : "even-sequence"],
    custom_fields: {
      cost_center: `CC-${pad(1000 + (index % 9000), 4)}`,
      project_code: `PROJECT-${String.fromCharCode(65 + (index % 26))}${pad(index + 1, 5)}`,
      feature_flags: { advanced_search: true, experimental_renderer: index % 5 === 0, strict_validation: true, audit_export: index % 3 === 0 },
      arbitrary_key_map: { "key with spaces": "accepted", "dotted.key": "accepted", "slash/key": "accepted", "brackets[0]": "accepted" },
    },
    integrity: {
      algorithm: "sha256",
      digest: `${(index * 2654435761 >>> 0).toString(16).padStart(8, "0")}${"d07fa5d90a1880cb4430087b62e9161f1dc3d222242517b977909c15"}`.slice(0, 64),
      generated_by: "scripts/generate-comprehensive-jsonl.mjs",
      deterministic: true,
    },
  };
}

const jsonl = `${Array.from({ length: recordCount }, (_, index) => JSON.stringify(makeRecord(index))).join("\n")}\n`;
writeFileSync(outputPath, jsonl, "utf8");
console.log(`Generated ${recordCount} records at ${outputPath} (${Buffer.byteLength(jsonl).toLocaleString("en-US")} bytes).`);
