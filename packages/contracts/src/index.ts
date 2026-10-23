import { z } from "zod";

export const VerdictSchema = z.enum(["passed", "failed", "blocked", "cancelled", "inconclusive"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const RunModeSchema = z.enum(["deterministic", "guided", "explore"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const SideEffectPolicySchema = z.enum(["deny", "confirm", "allow"]);
export type SideEffectPolicy = z.infer<typeof SideEffectPolicySchema>;

/** An observable prerequisite for reconnaissance, not a business assertion. */
export const SurfaceReadinessSchema = z.object({
  text: z.string().trim().min(1).max(512),
  timeoutMs: z.number().int().min(100).max(15_000).default(5_000),
}).strict();
export type SurfaceReadiness = z.infer<typeof SurfaceReadinessSchema>;

/** Offsets refer to sanitized rendered text, not source HTML or backend records. */
export const SurfaceTextReadRequestSchema = z.object({
  selector: z.string().min(1).max(512),
  offset: z.number().int().min(0).max(200_000).default(0),
  limit: z.number().int().min(1).max(8_000).default(4_000),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((value) => value.offset === 0 || value.expectedSourceSha256 !== undefined,
  "Continuing a text read requires the previous sourceSha256; restart if the rendered region changes");
export type SurfaceTextReadRequest = z.infer<typeof SurfaceTextReadRequestSchema>;

export const SurfaceTextReadObservationSchema = z.object({
  scope: z.literal("rendered-main-frame-region"),
  text: z.string().max(8_000),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().min(0).max(200_000),
  limit: z.number().int().min(1).max(8_000),
  totalChars: z.number().int().min(0).max(200_000),
  returnedChars: z.number().int().min(0).max(8_000),
  nextOffset: z.number().int().min(0).max(200_000).nullable(),
}).strict().refine((value) => value.offset <= value.totalChars
  && value.returnedChars === value.text.length
  && value.returnedChars === Math.min(value.limit, value.totalChars - value.offset)
  && value.nextOffset === (value.offset + value.returnedChars < value.totalChars ? value.offset + value.returnedChars : null),
  "Text read counts and continuation must match the returned sanitized window");
export type SurfaceTextReadObservation = z.infer<typeof SurfaceTextReadObservationSchema>;

/** A row window from one rendered table page; pagination must be checked separately. */
export const SurfaceTableReadRequestSchema = z.object({
  selector: z.string().min(1).max(512),
  offset: z.number().int().min(0).max(500).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  columns: z.array(z.number().int().min(0).max(31)).min(1).max(16)
    .refine((value) => new Set(value).size === value.length, "Column indices must be distinct").optional(),
  expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((value) => value.offset === 0 || value.expectedSourceSha256 !== undefined,
  "Continuing a table read requires the previous sourceSha256");
export type SurfaceTableReadRequest = z.infer<typeof SurfaceTableReadRequestSchema>;

export const SurfaceTableReadObservationSchema = z.object({
  scope: z.literal("rendered-current-page-table"),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  columns: z.array(z.object({ index: z.number().int().nonnegative(), header: z.string().max(512) }).strict()).min(1).max(16),
  rows: z.array(z.array(z.string().max(512))).max(50),
  offset: z.number().int().min(0).max(500),
  limit: z.number().int().min(1).max(50),
  totalRows: z.number().int().min(0).max(500),
  returnedRows: z.number().int().min(0).max(50),
  nextOffset: z.number().int().min(0).max(500).nullable(),
  /** Exhausting rows here never proves that other pages or virtualized rows were read. */
  allPagesVerified: z.literal(false),
}).strict().refine((value) => value.offset <= value.totalRows
  && value.returnedRows === value.rows.length
  && value.returnedRows === Math.min(value.limit, value.totalRows - value.offset)
  && value.rows.every((row) => row.length === value.columns.length)
  && value.nextOffset === (value.offset + value.returnedRows < value.totalRows ? value.offset + value.returnedRows : null),
  "Table row counts and continuation must match the returned window");
export type SurfaceTableReadObservation = z.infer<typeof SurfaceTableReadObservationSchema>;

/** Persist an environment variable name, never its runtime value, for credential fields. */
export const FillValueSchema = z.union([
  z.string(),
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
]);

/** Controls the breadth and evidence gate of an AI-directed test mission. */
export const TestLevelSchema = z.enum(["quick", "core", "release"]);
export type TestLevel = z.infer<typeof TestLevelSchema>;

export const TestLevelSelectionSchema = z.object({
  requested: TestLevelSchema.optional(),
  resolved: TestLevelSchema,
  source: z.enum(["explicit", "inferred", "default"]),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type TestLevelSelection = z.infer<typeof TestLevelSelectionSchema>;

/** Portable, workspace-relative references to explicitly prepared test fixtures. */
export const FixturePathSchema = z.string().max(1024).refine((value) => {
  const parts = value.split("/");
  return parts[0] === ".proofkit" && parts[1] === "fixtures" && parts.length >= 3
    && !/[\\:\x00-\x1f]/.test(value)
    && parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !/[. ]$/.test(part));
}, "Use a normalized .proofkit/fixtures/<file> path within the test workspace");

export const InputFileFactSchema = z.object({
  fixture: FixturePathSchema, name: z.string().min(1), sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string().min(1),
});
export type InputFileFact = z.infer<typeof InputFileFactSchema>;

/** Exact HTTP endpoint; query values and credentials never enter this contract. */
export const ResponseEndpointSchema = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Use an HTTP(S) endpoint without credentials, query or fragment");
const ResponseFieldNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine((value) => !["constructor", "prototype", "__proto__"].includes(value));
export const ResponsePointerSchema = z.string().min(1).max(256).refine((value) => value.startsWith("/") && !/~(?![01])/.test(value)
    && value.split("/").length <= 9
    && value.split("/").slice(1).every((part) => !["__proto__", "prototype", "constructor"].includes(part.replace(/~1/g, "/").replace(/~0/g, "~"))),
    "Use an RFC 6901 pointer with at most eight safe segments");
export const ResponseIdentifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const ResponseProjectionSchema = z.record(ResponseFieldNameSchema, z.object({
  pointer: ResponsePointerSchema,
  type: z.enum(["id", "identifier", "string", "number", "boolean"]),
}).strict()).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 16, "Select 1-16 scalar response fields");
export const RequestQueryProjectionSchema = ResponseProjectionSchema.refine((fields) => {
  const pointers = Object.values(fields).map((field) => field.pointer);
  return pointers.every((pointer) => pointer.slice(1).split("/").length === 1)
    && Object.values(fields).every((field) => ["string", "id", "identifier"].includes(field.type))
    && new Set(pointers).size === pointers.length;
}, "Select distinct single-segment string-like query parameters");
export const SurfaceTargetIdentitySchema = z.object({
  tag: z.string().min(1).max(64),
  role: z.string().min(1).max(64),
  name: z.string().max(120),
  groupName: z.string().max(120),
  inputType: z.string().max(64).optional(),
}).strict();
export type SurfaceTargetIdentity = z.infer<typeof SurfaceTargetIdentitySchema>;

export const SurfaceTargetExpectationSchema = SurfaceTargetIdentitySchema.extend({
  observedAt: z.string().min(1).max(64),
  observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  origin: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  }).optional(),
}).strict();
export type SurfaceTargetExpectation = z.infer<typeof SurfaceTargetExpectationSchema>;

export function changedSurfaceTargetFields(expected: SurfaceTargetExpectation, actual: SurfaceTargetIdentity, actualOrigin?: string): Array<"tag" | "role" | "name" | "groupName" | "inputType" | "origin"> {
  const changed: Array<"tag" | "role" | "name" | "groupName" | "inputType" | "origin"> = (["tag", "role", "name", "groupName", "inputType"] as const)
    .filter((field) => expected[field] !== actual[field]);
  if (expected.origin && expected.origin !== actualOrigin) changed.push("origin");
  return changed;
}

export const SurfaceTargetCheckSchema = z.object({
  selector: z.string().min(1).max(4096),
  observedAt: z.string().datetime(),
  expected: SurfaceTargetExpectationSchema,
  actual: SurfaceTargetIdentitySchema,
  actualOrigin: SurfaceTargetExpectationSchema.shape.origin,
  status: z.enum(["matched", "changed"]),
  changedFields: z.array(z.enum(["tag", "role", "name", "groupName", "inputType", "origin"])).max(6),
}).strict().superRefine((check, context) => {
  const changed = changedSurfaceTargetFields(check.expected, check.actual, check.actualOrigin);
  if (check.status !== (changed.length ? "changed" : "matched") || JSON.stringify([...check.changedFields].sort()) !== JSON.stringify(changed.sort())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Target check status must match the observed control identity differences" });
  }
});
export type SurfaceTargetCheck = z.infer<typeof SurfaceTargetCheckSchema>;

export const CaptureResponseActionSchema = z.object({
  kind: z.literal("captureResponse"),
  name: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  trigger: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("click"), selector: z.string().min(1), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional() }).strict(),
    z.object({ kind: z.literal("press"), selector: z.string().min(1), key: z.string().min(1), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional() }).strict(),
  ]),
  /** One reviewed optional click while the same response listener remains active. */
  followUp: z.object({ kind: z.literal("clickIfVisible"), selector: z.string().min(1).max(1024), waitMs: z.number().int().min(1).max(5000), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional() }).strict().optional(),
  response: z.object({
    url: ResponseEndpointSchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    statuses: z.array(z.number().int().min(200).max(599)).min(1).max(10).default([200, 201]),
    fields: ResponseProjectionSchema,
    /** Optional reviewed JSON or UTF-8 form request fields; raw request bodies never leave the adapter. */
    requestFields: ResponseProjectionSchema.optional(),
    /** Opt in to every request query key; only these reviewed scalar values may be retained. */
    queryFields: RequestQueryProjectionSchema.optional(),
    errorFields: ResponseProjectionSchema.optional(),
  }).strict(),
  /** In legacy mode, observe requests this long after the trigger. In delayed mode, guard against duplicates this long after the first request. */
  requestWindowMs: z.number().int().min(1).max(5000).default(500),
  /** Opt in to waiting for a request after the trigger. The total timeout still bounds the entire action. */
  requestStartTimeoutMs: z.number().int().min(1).max(300000).optional(),
  timeoutMs: z.number().int().positive().max(600000).default(10000),
}).strict();
export type CaptureResponseAction = z.infer<typeof CaptureResponseActionSchema>;
export const ResponseObservationSchema = z.object({
  name: z.string().min(1).max(64),
  association: z.literal("action-window"),
  url: ResponseEndpointSchema,
  method: z.string().min(1),
  status: z.number().int().min(200).max(599),
  requestCount: z.literal(1),
  windowStartedAt: z.string(),
  requestStartedAt: z.string().datetime().optional(),
  followUp: z.enum(["clicked", "skipped"]).optional(),
  windowEndedAt: z.string(),
  capturedAt: z.string(),
  bodyBytes: z.number().int().min(1).max(65536),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  fields: z.record(ResponseFieldNameSchema, z.union([z.string().max(256), z.number().finite(), z.boolean()])),
  requestBodyBytes: z.number().int().nonnegative().max(65536).optional(),
  requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestFields: z.record(ResponseFieldNameSchema, z.union([z.string().max(256), z.number().finite(), z.boolean()])).optional(),
  queryFields: z.record(ResponseFieldNameSchema, z.string().max(256)).optional(),
}).strict();
export type ResponseObservation = z.infer<typeof ResponseObservationSchema>;

export const ResponseErrorObservationSchema = ResponseObservationSchema.omit({ bodyBytes: true, bodySha256: true }).extend({
  kind: z.enum(["unexpected-status", "incomplete-fields"]), acceptance: z.literal("not-established"),
  expectedStatuses: z.array(z.number().int().min(200).max(599)).min(1).max(10),
  windowStartedAt: z.string().datetime(), windowEndedAt: z.string().datetime(), capturedAt: z.string().datetime(),
  bodyBytes: ResponseObservationSchema.shape.bodyBytes.optional(), bodySha256: ResponseObservationSchema.shape.bodySha256.optional(),
  bodyGap: z.enum(["not-requested", "content-type", "body-bound", "body-unavailable", "json-invalid"]).optional(),
  fields: ResponseObservationSchema.shape.fields.refine((fields) => Object.keys(fields).length <= 16, "At most 16 selected diagnostic fields"),
  fieldGaps: z.array(z.object({ name: ResponseFieldNameSchema, code: z.enum(["missing", "invalid"]) }).strict()).max(16),
  requestGap: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.status >= 300 && value.status < 400 || (value.kind === "unexpected-status") === value.expectedStatuses.includes(value.status)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Diagnostic kind must match the declared status relation and cannot redirect" });
  if (value.kind === "incomplete-fields" && (value.bodyGap || !value.fieldGaps.length && !value.requestGap)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Incomplete fields require a complete body and at least one projection gap" });
  if ((value.bodyBytes === undefined) !== (value.bodySha256 === undefined)
    || (value.requestBodyBytes === undefined) !== (value.requestBodySha256 === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Body size and digest must be retained together" });
  if (!value.bodyGap && value.bodyBytes === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "A complete diagnostic body or an explicit gap is required" });
  if (value.bodyGap && (Object.keys(value.fields).length || value.fieldGaps.length)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Unobserved diagnostic bodies cannot contain selected fields" });
  if (new Set(value.fieldGaps.map((gap) => gap.name)).size !== value.fieldGaps.length
    || value.fieldGaps.some((gap) => Object.hasOwn(value.fields, gap.name))) context.addIssue({ code: z.ZodIssueCode.custom, message: "Diagnostic fields and missing-field gaps must be distinct" });
  if (value.requestFields && (value.requestBodyBytes === undefined || value.requestGap)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Projected request facts require a complete request observation" });
});
export type ResponseErrorObservation = z.infer<typeof ResponseErrorObservationSchema>;

export const OracleResponseBindingSchema = z.object({ source: z.literal("response"),
  stepId: z.string().regex(/^step-\d{3}$/), field: ResponseFieldNameSchema,
  matchPointer: ResponsePointerSchema }).strict();
export const HttpFieldValueSchema = z.union([z.string().max(256).refine((value) => !/[\x00-\x1f]/.test(value)), z.number().finite(), z.boolean(), z.null()]);
export const HttpFieldExpectationSchema = z.object({
  name: ResponseFieldNameSchema, pointer: ResponsePointerSchema,
  expected: HttpFieldValueSchema, retainValue: z.boolean().optional(),
}).strict();
export type HttpFieldExpectation = z.infer<typeof HttpFieldExpectationSchema>;
export const HttpFieldCheckSchema = z.object({
  name: ResponseFieldNameSchema, pointer: ResponsePointerSchema,
  result: z.enum(["matched", "missing", "type-mismatch", "mismatch", "not-evaluated"]),
  observed: HttpFieldValueSchema.optional(),
}).strict();
export type HttpFieldCheck = z.infer<typeof HttpFieldCheckSchema>;
export const ConfiguredHttpOracleSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  query: z.record(z.discriminatedUnion("source", [
    z.object({ source: z.literal("runId") }),
    z.object({ source: z.literal("step"), stepId: z.string().regex(/^step-\d{3}$/), field: z.string().min(1) }),
    OracleResponseBindingSchema,
  ])).default({}),
  statusPointer: z.string().startsWith("/"),
  successValues: z.array(z.string().min(1)).min(1),
  failureValues: z.array(z.string().min(1)).default([]),
  expectFields: z.array(HttpFieldExpectationSchema).min(1).max(16).refine((fields) =>
    new Set(fields.map((field) => field.name)).size === fields.length && new Set(fields.map((field) => field.pointer)).size === fields.length,
  "Use distinct independent field names and pointers").optional(),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  intervalMs: z.number().int().positive().default(500),
  deadlineMs: z.number().int().positive().default(30_000),
});
/** Agent-authored business readers must be bounded and tied to this Run's captured response. */
export const InlineHttpOracleSchema = ConfiguredHttpOracleSchema.extend({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/),
  url: ResponseEndpointSchema,
  query: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), OracleResponseBindingSchema)
    .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8,
      "Bind 1-8 query parameters to fields captured in the current Run"),
  statusPointer: ResponsePointerSchema,
  successValues: z.array(z.string().min(1).max(128)).min(1).max(16),
  failureValues: z.array(z.string().min(1).max(128)).max(16).default([]),
  expectedStatus: z.number().int().min(200).max(299).default(200),
  intervalMs: z.number().int().min(100).max(10_000).default(500),
  deadlineMs: z.number().int().min(100).max(300_000).default(30_000),
}).strict().refine((value) => value.failureValues.every((item) => !value.successValues.includes(item)),
  "Success and failure values must not overlap");
export type InlineHttpOracle = z.infer<typeof InlineHttpOracleSchema>;

/** One exact native option; indices and ambiguous value/label combinations are not portable. */
export const NativeOptionSchema = z.union([
  z.object({ value: z.string().max(4096) }).strict(),
  z.object({ label: z.string().min(1).max(4096) }).strict(),
]).describe('An object with exactly one key: {"value":"exact option value"} or {"label":"exact visible label"}. A plain string or numeric index is invalid.');
export const SelectOptionActionSchema = z.object({
  kind: z.literal("selectOption"), selector: z.string().min(1).max(512),
  observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  expectedTarget: SurfaceTargetExpectationSchema.optional(),
  option: NativeOptionSchema,
}).strict();
/** Replace the complete native multiple-select set; an explicit empty set clears it. */
export const SelectOptionsActionSchema = z.object({
  kind: z.literal("selectOptions"), selector: z.string().min(1).max(512),
  observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  expectedTarget: SurfaceTargetExpectationSchema.optional(),
  options: z.array(NativeOptionSchema).max(32).refine((options) =>
    new Set(options.map((option) => "value" in option ? `value:${option.value}` : `label:${option.label}`)).size === options.length,
  "Requested options must be distinct").describe('The complete replacement selection, for example [{"label":"First"},{"value":"second"}]. Use [] to clear. Every item must be an object, never a string.'),
}).strict();
export const SetCheckedActionSchema = z.object({
  kind: z.literal("setChecked"), selector: z.string().min(1).max(512), checked: z.boolean(),
  observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  expectedTarget: SurfaceTargetExpectationSchema.optional(),
}).strict();

export const WaitForValueActionSchema = z.object({
  kind: z.literal("waitForValue"), selector: z.string().min(1).max(512), value: FillValueSchema.refine((value) => typeof value !== "string" || value.length <= 4096, "Expected value exceeds its bound"),
  observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(5000),
  stableForMs: z.number().int().min(100).max(5000).default(750),
}).strict();

export const FieldValueObservationSchema = z.object({
  matched: z.literal(true), stableForMs: z.number().int().min(100).max(30_000), polls: z.number().int().min(2).max(10_000),
  observedForMs: z.number().int().min(100).max(30_000), actualValueRetained: z.literal(false),
  scope: z.literal("sampled-native-control-value"), businessAcceptance: z.literal(false),
}).strict().refine((value) => value.stableForMs <= value.observedForMs && value.stableForMs <= (value.polls - 1) * 250,
  "Matching window must fit the total observation time and a bounded sampling cadence");

export const SwitchPageActionSchema = z.object({ kind: z.literal("switchPage"), title: z.string().trim().min(1).max(200),
  timeoutMs: z.number().int().min(100).max(15000).default(5000) }).strict()
  .describe("Owned Web contexts only: select one currently open same-origin page by its exact observed eligible title; duplicate titles stop without selecting a page. This action does not navigate or submit the page.");

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), url: z.string().url() }),
  SwitchPageActionSchema,
  z.object({ kind: z.literal("click"), selector: z.string().min(1), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional() }),
  z.object({ kind: z.literal("fill"), selector: z.string().min(1), value: FillValueSchema, observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional() }),
  z.object({ kind: z.literal("setInputFiles"), selector: z.string().min(1), files: z.array(FixturePathSchema).min(1).max(10), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional() }).strict(),
  z.object({ kind: z.literal("press"), selector: z.string().min(1), key: z.string().min(1), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), expectedTarget: SurfaceTargetExpectationSchema.optional() }),
  SelectOptionActionSchema,
  SelectOptionsActionSchema,
  SetCheckedActionSchema,
  WaitForValueActionSchema,
  z.object({ kind: z.literal("waitForText"), text: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("screenshot"), name: z.string().min(1).optional() }),
  z.object({ kind: z.literal("capability"), name: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ kind: z.literal("observe"), readText: SurfaceTextReadRequestSchema.optional(),
    readTable: SurfaceTableReadRequestSchema.optional(), controlOffset: z.number().int().min(0).max(500).optional() }).strict(),
  CaptureResponseActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;

export const PlanningObservationRequestSchema = z.object({
  status: z.literal("needs-observation"),
  reason: z.string().trim().min(1).max(1000),
  expectedObservation: z.string().trim().min(1).max(1000),
  action: ActionSchema.refine((action) => ["goto", "switchPage", "click", "fill", "press", "selectOption", "selectOptions", "setChecked", "waitForText", "waitForValue"].includes(action.kind), "Request only one supported exploratory action")
    .refine((action) => !("selector" in action) || action.selector.length <= 512, "Exploratory selectors are bounded")
    .refine((action) => action.kind !== "fill" || (typeof action.value === "string" && action.value.length <= 4096), "Exploratory fill proposals require bounded literal input")
    .refine((action) => action.kind !== "waitForValue" || typeof action.value === "string", "Exploratory value proposals require literal expected values")
    .refine((action) => action.kind !== "press" || action.key.length <= 64, "Exploratory key is too long")
    .refine((action) => action.kind !== "waitForText" || (action.text.length <= 512 && (action.timeoutMs === undefined || (action.timeoutMs >= 100 && action.timeoutMs <= 30_000))), "Exploratory wait exceeds its bounds")
    .refine((action) => JSON.stringify(action).length <= 8192, "Exploratory proposal exceeds its context bound").optional(),
}).strict();
export type PlanningObservationRequest = z.infer<typeof PlanningObservationRequestSchema>;

export function actionSurfaceTargets(action: Action): Array<{ selector: string; observationId?: string; expectedTarget?: SurfaceTargetExpectation }> {
  if ("selector" in action) return [action];
  if (action.kind === "captureResponse") return [action.trigger, ...(action.followUp ? [action.followUp] : [])];
  return [];
}

export const AssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text-visible"), text: z.string().min(1) }),
  z.object({ kind: z.literal("text-not-visible"), text: z.string().min(1) }),
  z.object({ kind: z.literal("url-matches"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("title-contains"), text: z.string().min(1) }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

/** An absence check alone cannot establish that the intended page or flow loaded. */
export function hasPositiveSurfaceAssertion(assertions: readonly Assertion[]): boolean {
  return assertions.some((assertion) => assertion.kind !== "text-not-visible");
}

/**
 * A declared negative or recovery scenario. The scenario is intentionally
 * explicit: ProofKit never invents destructive actions from a category label.
 * Its assertions/oracles describe the expected safe rejection or recovery.
 */
export const NegativeCaseSchema = z.object({
  caseId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().min(1),
  actions: z.array(ActionSchema).default([]),
  assertions: z.array(AssertionSchema).default([]),
  oracles: z.array(z.string().min(1)).default([]),
  /** Prefer passed with positive rejection proof. Failed needs an evidenced business Oracle; other values never certify. */
  expectedVerdict: VerdictSchema.optional(),
  sideEffectPolicy: SideEffectPolicySchema.default("deny"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type NegativeCase = z.infer<typeof NegativeCaseSchema>;

/**
 * Structured planning metadata. These fields describe what the planner knows
 * and what it still needs; they are deliberately separate from execution
 * evidence so a confident-sounding model response cannot masquerade as proof.
 */
export const TestCoverageSchema = z.enum(["declared", "project"]);
export type TestCoverage = z.infer<typeof TestCoverageSchema>;
/** Static discovery is not evidence of complete business workflow coverage. */
export const PlanningCoverageSchema = z.object({
  requested: TestCoverageSchema,
  source: z.enum(["explicit", "inferred", "default"]),
  reason: z.string().min(1),
  inventory: z.enum(["not-scanned", "bounded", "partial"]),
  workflowCoverage: z.literal("unmeasured"),
  gaps: z.array(z.string().min(1)).default([]),
});
export type PlanningCoverage = z.infer<typeof PlanningCoverageSchema>;

export const PlanningQualitySchema = z.object({
  source: z.enum(["catalog", "workflow-inventory", "deterministic", "model", "submitted"]).default("deterministic"),
  confidence: z.number().min(0).max(1).default(0),
  assumptions: z.array(z.string().min(1)).default([]),
  missingInputs: z.array(z.string().min(1)).default([]),
  evidenceGaps: z.array(z.string().min(1)).default([]),
  coverage: PlanningCoverageSchema.optional(),
});
export type PlanningQuality = z.infer<typeof PlanningQualitySchema>;
export function normalizePlanningQuality(value?: PlanningQuality): PlanningQuality {
  return PlanningQualitySchema.parse(value ?? {});
}

export const PlanReviewSchema = z.object({
  schemaVersion: z.literal("1"), scope: z.literal("plan-structure"),
  sessionId: z.string().uuid().optional(),
  status: z.enum(["needs-input", "ready-for-review"]),
  testVerdict: z.literal("not-asserted"), executionStarted: z.literal(false),
  reason: z.string().min(1), plannerSource: z.enum(["deterministic", "model", "submitted", "catalog", "workflow-inventory", "unassessed"]),
  level: TestLevelSchema,
  counts: z.object({ actions: z.number().int().nonnegative(), surfaceChecks: z.number().int().nonnegative(),
    independentChecks: z.number().int().nonnegative(), negativeScenarios: z.number().int().nonnegative() }).strict(),
  gaps: z.array(z.string().min(1)), missingInputs: z.array(z.string().min(1)),
  next: z.array(z.object({ action: z.enum(["author-workflow", "define-surface-outcome", "connect-business-check", "observe-target", "define-negative-scenario", "review-project-scope", "review-missing-inputs", "review-plan"]),
    reason: z.string().min(1) }).strict()),
  notEstablished: z.array(z.enum(["environment", "authentication", "test-data", "business-outcome", "requested-evidence", "intent-completeness"])),
}).strict();
export type PlanReview = z.infer<typeof PlanReviewSchema>;

export const PlanningInspectionPinSchema = z.object({
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PlanningInspectionPin = z.infer<typeof PlanningInspectionPinSchema>;
export const PlanningContinuationPinSchema = z.object({
  id: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PlanningContinuationPin = z.infer<typeof PlanningContinuationPinSchema>;
export const PlanningObservationSourceSchema = PlanningInspectionPinSchema.extend({
  snapshotPath: z.string().regex(/^[a-zA-Z0-9_-]{1,128}\/artifacts\/step-\d{3}-after\.json$/),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const PlanningObservedSourceSchema = z.object({
  capturedAt: z.string().min(1).max(64), controlsTruncated: z.boolean(), source: PlanningObservationSourceSchema,
}).strict();
export const PlanningSurfaceObservationSchema = z.object({
  capturedAt: z.string().min(1).max(64),
  controlsTruncated: z.boolean(),
  sessionId: z.string().uuid().optional(),
  source: PlanningObservationSourceSchema.optional(),
  sources: z.array(PlanningObservedSourceSchema).min(1).max(10).refine((sources) => new Set(sources.map((item) => item.source.runId)).size === sources.length).optional(),
}).strict().refine((observation) => !observation.source || !observation.sources, "Use one source or a bounded list of observed sources")
  .refine((observation) => !observation.sources || (observation.capturedAt === observation.sources[0]?.capturedAt
    && observation.controlsTruncated === observation.sources.some((state) => state.controlsTruncated)), "Multi-state observation metadata must describe its original sources");
export type PlanningSurfaceObservation = z.infer<typeof PlanningSurfaceObservationSchema>;

export function planningObservationSources(observation: PlanningSurfaceObservation): Array<z.infer<typeof PlanningObservedSourceSchema>> {
  return observation.sources ?? (observation.source ? [{ capturedAt: observation.capturedAt, controlsTruncated: observation.controlsTruncated, source: observation.source }] : []);
}

export const TestCharterSchema = z.object({
  intent: z.string().min(1),
  level: TestLevelSchema.default("core"),
  /** Explicit platform claim for direct workspace candidates; catalog entries retain their own surface matrix. */
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1).max(3).refine((items) => new Set(items).size === items.length).optional(),
  levelSelection: TestLevelSelectionSchema.optional(),
  planning: PlanningQualitySchema.optional(),
  surfaceObservation: PlanningSurfaceObservationSchema.optional(),
  mode: RunModeSchema.default("guided"),
  preconditions: z.array(z.string()).default([]),
  actions: z.array(ActionSchema).default([]),
  assertions: z.array(AssertionSchema).default([]),
  oracles: z.array(z.string().min(1)).optional(),
  httpOracles: z.array(InlineHttpOracleSchema).max(8).optional(),
  // Optional for backward compatibility with existing charters. The planner
  // normalizes an omitted value to an empty list before creating tasks.
  negativeCases: z.array(NegativeCaseSchema).optional(),
  sideEffectPolicy: SideEffectPolicySchema.default("confirm"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
/** Existing workspace Charters may omit planning metadata. New plans populate it explicitly. */
export type TestCharter = z.infer<typeof TestCharterSchema>;

export const SurfaceControlSchema = z.object({
  tag: z.string().min(1),
  role: z.string().min(1),
  name: z.string().max(120).optional(),
  /** Nearest fieldset legend when a form control has a broader field group. */
  groupName: z.string().max(120).optional(),
  selector: z.string().min(1).optional(),
  selectorKind: z.enum(["test-id", "id", "role", "css"]).optional(),
  alternateSelectors: z.array(z.string().min(1).max(512)).max(2).optional(),
  inputType: z.string().optional(),
  visible: z.boolean().optional(),
  disabled: z.boolean(),
  /** Live native state only; no option labels, values or arbitrary input values. */
  nativeForm: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("select"), multiple: z.boolean(), optionCount: z.number().int().nonnegative(), selectedCount: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("checkable"), checked: z.boolean() }),
  ]).optional(),
  /** Advisory native action hints, never authorization or guaranteed actionability. */
  nativeActions: z.array(z.enum(["selectOption", "selectOptions", "setChecked"])).max(1).optional(),
});
export type SurfaceControl = z.infer<typeof SurfaceControlSchema>;

export const SurfaceControlWindowSchema = z.object({
  scope: z.literal("rendered-main-frame-controls"), offset: z.number().int().min(0).max(500), limit: z.literal(60),
  total: z.number().int().min(0).max(50_000), returned: z.number().int().min(0).max(60),
  nextOffset: z.number().int().min(1).max(500).nullable(), allControlsObserved: z.boolean(),
}).strict().refine((value) => value.offset <= value.total && value.returned === Math.min(60, value.total - value.offset)
  && value.nextOffset === (value.offset + value.returned < value.total && value.offset + value.returned <= 500 ? value.offset + value.returned : null)
  && value.allControlsObserved === (value.offset === 0 && value.total <= 60), "Control window counts and completeness must match the visible control list");

export const SurfaceSnapshotSchema = z.object({
  capturedAt: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  textRead: SurfaceTextReadObservationSchema.optional(),
  tableRead: SurfaceTableReadObservationSchema.optional(),
  controls: z.array(SurfaceControlSchema).max(60).optional(),
  controlsTruncated: z.boolean().optional(),
  controlWindow: SurfaceControlWindowSchema.optional(),
  frameCount: z.number().int().positive().optional(),
  pages: z.array(z.object({ title: z.string().max(200), url: z.string(), active: z.boolean(), eligibleForSwitch: z.boolean() }).strict()).max(16).optional(),
  pagesTruncated: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, context) => {
  if (value.controlWindow && (value.controls?.length !== value.controlWindow.returned || value.controlsTruncated !== !value.controlWindow.allControlsObserved)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Control window must describe the exact observed controls and omissions" });
  }
});
export type SurfaceSnapshot = z.infer<typeof SurfaceSnapshotSchema>;

export const SurfaceObservedStateSchema = z.object({ observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), snapshot: SurfaceSnapshotSchema }).strict();
export type SurfaceObservedState = z.infer<typeof SurfaceObservedStateSchema>;

export const ActionReceiptSchema = z.object({
  actionId: z.string(),
  kind: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().nonnegative(),
  urlBefore: z.string().optional(),
  urlAfter: z.string().optional(),
  titleAfter: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

export const AssertionResultSchema = z.object({
  assertion: AssertionSchema,
  passed: z.boolean(),
  message: z.string(),
  evidence: z.array(z.string()).default([]),
  /** Runner-owned time when this assertion result was received. */
  recordedAt: z.string().datetime().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const OracleResultSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean().nullable(),
  /** Status-only checks establish an HTTP contract, not an independent business outcome. */
  verificationKind: z.enum(["business", "http-contract"]).optional(),
  message: z.string(),
  /** Connector-declared differing field names, never raw expected or observed values. */
  fieldMismatches: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/)).min(1).max(8)
    .refine((fields) => new Set(fields).size === fields.length).optional(),
  evidence: z.array(z.string()).default([]),
  /** Evidence supplied by the Oracle before ProofKit adds its own result artifact. */
  sourceEvidenceCount: z.number().int().nonnegative().optional(),
  /** Run-scoped artifacts containing the Oracle's observed source facts, separate from its verdict report. */
  sourceEvidenceArtifacts: z.array(z.string()).optional(),
  /** Unverified repository path hints from a project integration; they are not root-cause evidence. */
  sourceLocations: z.array(z.string().min(1)).optional(),
  observedAt: z.string().optional(),
  /** Runner-owned time when this Oracle result was received. */
  recordedAt: z.string().datetime().optional(),
}).superRefine((result, context) => {
  if (result.fieldMismatches && (result.passed !== false || result.verificationKind !== "business")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Field mismatches require a failing independent business check" });
  }
});
export type OracleResult = z.infer<typeof OracleResultSchema>;

export const RuntimeFindingSchema = z.object({
  findingId: z.string().min(1),
  kind: z.enum(["console", "pageerror", "response", "requestfailed"]),
  category: z.enum(["product", "environment", "test", "unknown"]),
  status: z.enum(["confirmed", "suspected", "unverified"]),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  message: z.string().min(1),
  eventType: z.string().min(1),
  url: z.string().optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  consoleLevel: z.string().optional(),
  affectsVerdict: z.boolean().default(false),
  evidence: z.array(z.string()).default([]),
  observedAt: z.string(),
});
export type RuntimeFinding = z.infer<typeof RuntimeFindingSchema>;

export const StepResultSchema = z.object({
  stepId: z.string(),
  action: ActionSchema,
  status: z.enum(["passed", "failed", "blocked"]),
  receipt: ActionReceiptSchema.optional(),
  /** Selected facts from one request observed within this step's action window. */
  response: ResponseObservationSchema.optional(),
  responseError: ResponseErrorObservationSchema.optional(),
  inputFiles: z.array(InputFileFactSchema).optional(),
  /** Present only when replay checks the selected bytes against its source Run. */
  replayInputMatched: z.boolean().optional(),
  beforeSnapshot: SurfaceSnapshotSchema.optional(),
  afterSnapshot: SurfaceSnapshotSchema.optional(),
  targetChecks: z.array(SurfaceTargetCheckSchema).max(2).optional(),
  artifacts: z.array(z.string()).default([]),
  capabilityOutput: z.unknown().optional(),
  /** Stable non-sensitive failure category; older saved Runs may omit it. */
  failureCode: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const SurfaceReplanProposalSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("needs-approval"),
  requiresApproval: z.literal(true),
  reason: z.literal("surface-selector-drift"),
  sourceStepId: z.string().regex(/^step-\d{3}$/),
  originalSelector: z.string().min(1).max(512),
  observedAt: z.string(),
  observedUrl: z.string().optional(),
  candidates: z.array(z.object({
    selector: z.string().min(1).max(512),
    tag: z.string().min(1).max(64).optional(),
    role: z.string().min(1).max(128),
    inputType: z.string().max(64).optional(),
    name: z.string().max(120).optional(),
    groupName: z.string().max(120).optional(),
  }).strict()).max(8),
  next: z.literal("inspect_surface"),
  message: z.string().min(1).max(512),
}).strict();
export type SurfaceReplanProposal = z.infer<typeof SurfaceReplanProposalSchema>;

export const SurfaceReplanStabilityAnalysisSchema = z.object({
  sourceRunId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  replacementRunIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1).max(20),
  approvedSelectors: z.array(z.string().min(1).max(512)),
  total: z.number().int().positive(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  repeatedSelectorCount: z.number().int().nonnegative(),
  meanApprovalLatencyMs: z.number().finite().nonnegative().optional(),
  status: z.enum(["uniform-pass", "uniform-failure", "variable-outcome", "inconclusive"]),
  gaps: z.array(z.string().min(1)).max(20),
  omittedGaps: z.number().int().nonnegative(),
  analyzedAt: z.string(),
}).strict();
export type SurfaceReplanStabilityAnalysis = z.infer<typeof SurfaceReplanStabilityAnalysisSchema>;

/** A process-path association is useful evidence, but does not attest served bytes. */
export const TargetBindingSchema = z.object({
  status: z.enum(["matching-process-path", "different-project", "unverified"]),
  method: z.enum(["windows-listener-process", "linux-proc-listener", "unavailable"]),
  expectedProjectRoot: z.string().min(1),
  targetOrigin: z.string().url().optional(),
  observedProjectRoot: z.string().min(1).optional(),
  processId: z.number().int().positive().optional(),
  reason: z.string().min(1),
  observedAt: z.string(),
});
export type TargetBinding = z.infer<typeof TargetBindingSchema>;
export const TargetContinuitySchema = z.enum(["stable", "changed", "unverified"]);
export type TargetContinuity = z.infer<typeof TargetContinuitySchema>;

export const HttpEndpointObservationSchema = z.object({
  endpoint: z.string(),
  status: z.enum(["reachable", "unexpected-status", "unreachable", "invalid"]),
  expectedStatus: z.number().int().min(100).max(599),
  observedStatus: z.number().int().min(100).max(599).optional(),
  reason: z.enum(["invalid-url", "timeout", "network-error"]).optional(),
  durationMs: z.number().nonnegative(),
});
export type HttpEndpointObservation = z.infer<typeof HttpEndpointObservationSchema>;

export const EnvironmentInspectionInputSchema = z.object({
  surface: z.enum(["web", "electron", "mobile"]).default("web"),
  url: z.string().url().optional(),
  timeoutMs: z.number().int().min(100).max(15_000).default(10_000),
});
export type EnvironmentInspectionInput = z.input<typeof EnvironmentInspectionInputSchema>;

export const EnvironmentInspectionSchema = z.object({
  inspectionId: z.string().regex(/^environment-[a-zA-Z0-9_-]+$/),
  projectRoot: z.string(),
  workspaceRoot: z.string(),
  surface: z.enum(["web", "electron", "mobile"]),
  observedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  status: z.enum(["checks-passed", "blocked", "incomplete"]),
  testVerdict: z.literal("not-asserted"),
  checks: z.array(z.object({
    id: z.string(),
    kind: z.enum(["configuration", "http", "source-binding"]),
    status: z.enum(["passed", "blocked", "unverified"]),
    message: z.string(),
    http: HttpEndpointObservationSchema.optional(),
    targetBinding: TargetBindingSchema.optional(),
  })).max(16),
  omittedHealthChecks: z.number().int().nonnegative(),
  notChecked: z.array(z.enum(["browser-session", "device-session", "authentication", "fixtures", "integration-preflight", "business-terminal", "project-coverage"])),
  next: z.array(z.object({
    action: z.enum(["configure-surface", "check-surface-endpoint", "configure-browser", "check-cdp", "check-webdriver", "check-health", "declare-health", "confirm-source", "retry-inspection", "inspect-surface"]),
    basedOn: z.array(z.string()).min(1).max(16),
    guidance: z.string().min(1).max(240),
  })).max(9),
});
export type EnvironmentInspection = z.infer<typeof EnvironmentInspectionSchema>;

const IntegrationFactSchema = z.record(z.string().min(1).max(128), z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]))
  .refine((facts) => Object.keys(facts).length <= 32, "At most 32 scalar facts are allowed");
const IntegrationResourceIdSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);
export const IntegrationResourceSchema = z.object({
  resourceId: IntegrationResourceIdSchema,
  kind: z.string().trim().min(1).max(64),
  scope: IntegrationResourceIdSchema,
  /** Trusted connector observations; never credentials or arbitrary payloads. */
  evidence: IntegrationFactSchema,
}).strict();
export type IntegrationResource = z.infer<typeof IntegrationResourceSchema>;
export const IntegrationResourceCleanupSchema = z.object({
  resourceId: IntegrationResourceIdSchema,
  status: z.enum(["removed", "retained", "unverified"]),
  /** A removal acknowledgement alone is insufficient; read back the resource state. */
  evidence: IntegrationFactSchema,
  readback: z.object({
    reader: z.string().regex(/^[a-zA-Z0-9._:/-]{1,128}$/),
    scope: IntegrationResourceIdSchema,
    observedAt: z.string().datetime(),
    exists: z.boolean(),
  }).strict().optional(),
}).strict();
export type IntegrationResourceCleanup = z.infer<typeof IntegrationResourceCleanupSchema>;
export const IntegrationSetupPolicySchema = z.object({
  sideEffect: z.enum(["none", "read", "write"]),
  environments: z.array(z.enum(["test", "staging", "local"])).min(1),
  cleanupTimeoutMs: z.number().int().min(100).max(5000).default(5000),
}).strict();
export type IntegrationSetupPolicy = z.infer<typeof IntegrationSetupPolicySchema>;
/** Durable registration for connector-owned resources; contains no executable cleanup code. */
export const IntegrationResourceJournalSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  projectRoot: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  integration: z.object({ name: z.string().min(1).max(128), version: z.string().min(1).max(128).optional() }).strict().optional(),
  environment: z.enum(["test", "staging", "local"]),
  cleanupTimeoutMs: z.number().int().min(100).max(5000),
  registeredAt: z.string().datetime(),
  resources: z.array(IntegrationResourceSchema).max(32),
}).strict().refine((journal) => new Set(journal.resources.map((resource) => resource.resourceId)).size === journal.resources.length, "Duplicate registered resource");
export type IntegrationResourceJournal = z.infer<typeof IntegrationResourceJournalSchema>;
export const IntegrationCleanupSchema = z.object({
  status: z.enum(["not-required", "completed", "verified", "failed", "unverified"]),
  declaredResources: z.number().int().min(0).max(32),
  verifiedResources: z.number().int().min(0).max(32),
  artifact: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict().superRefine((cleanup, context) => {
  if (cleanup.verifiedResources > cleanup.declaredResources) context.addIssue({ code: "custom", message: "Verified resources exceed declared resources" });
  if (cleanup.status === "verified" && (cleanup.declaredResources === 0 || cleanup.verifiedResources !== cleanup.declaredResources || !cleanup.artifact || !cleanup.sha256)) {
    context.addIssue({ code: "custom", message: "Verified cleanup requires complete resource evidence" });
  }
  if (cleanup.status === "completed" && cleanup.declaredResources > 0 && (cleanup.verifiedResources !== cleanup.declaredResources || !cleanup.artifact || !cleanup.sha256)) {
    context.addIssue({ code: "custom", message: "Legacy cleanup must not hide incomplete resource cleanup" });
  }
  if (cleanup.status === "not-required" && cleanup.declaredResources !== 0) context.addIssue({ code: "custom", message: "Declared resources require cleanup" });
});
export type IntegrationCleanup = z.infer<typeof IntegrationCleanupSchema>;
/** A connector environment check is evidence about test provenance, not a product Oracle. */
export const IntegrationCheckResultSchema = z.object({
  passed: z.boolean(),
  message: z.string().min(1),
  evidence: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type IntegrationCheckResult = z.infer<typeof IntegrationCheckResultSchema>;
export const IntegrationCleanupArtifactSchema = z.object({
  runId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  status: z.enum(["not-required", "completed", "verified", "failed", "unverified"]),
  declaredResources: z.number().int().min(0).max(32),
  verifiedResources: z.number().int().min(0).max(32),
  resources: z.array(IntegrationResourceSchema).max(32),
  observations: z.array(IntegrationResourceCleanupSchema.extend({
    /** Runner-owned boundary; the connector cannot supply an earlier release time. */
    releaseStartedAt: z.string().datetime(),
  })).max(32),
  issues: z.array(z.string().min(1).max(256)).max(32),
}).strict();
export function hasIncompleteIntegrationCleanup(cleanup: unknown): boolean {
  if (cleanup === undefined) return false; // Saved Runs before this protocol remain readable.
  const parsed = IntegrationCleanupSchema.safeParse(cleanup);
  return !parsed.success || parsed.data.status === "failed" || parsed.data.status === "unverified";
}

export const VideoRecordingBudgetSchema = z.object({
  maxDurationMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  maxBytes: z.number().int().min(1024 * 1024).max(64 * 1024 * 1024).default(64 * 1024 * 1024),
}).strict();
export type VideoRecordingBudget = z.infer<typeof VideoRecordingBudgetSchema>;

export const VideoRecordingStopReasonSchema = z.enum(["duration-limit", "size-limit", "page-limit", "inspection-failed"]);
export type VideoRecordingStopReason = z.infer<typeof VideoRecordingStopReasonSchema>;

export const RunRecordingSchema = z.object({
  status: z.enum(["recorded", "partial", "unavailable"]),
  artifact: z.string().max(512).optional(),
  stopReason: VideoRecordingStopReasonSchema.optional(),
  budget: VideoRecordingBudgetSchema.optional(),
  selectedPages: z.object({ observed: z.number().int().min(1).max(16), artifacts: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}\/artifacts\/selected-page-0(?:0[1-9]|1[0-6])\.webm$/)).max(16),
    omitted: z.number().int().nonnegative().max(16) }).strict()
    .refine((value) => value.artifacts.length + value.omitted === value.observed && new Set(value.artifacts).size === value.artifacts.length
      && value.artifacts.every((path) => Number(path.match(/selected-page-(\d+)\.webm$/)?.[1]) <= value.observed),
    "Selected page coverage must account for every distinct selected window").optional(),
}).strict().refine((recording) => !recording.stopReason || recording.status !== "recorded", "A stopped recording cannot be complete")
  .refine((recording) => recording.status !== "partial" || Boolean(recording.artifact && recording.stopReason && recording.stopReason !== "inspection-failed"), "Partial footage needs a saved artifact and a verified budget stop")
  .refine((recording) => !recording.selectedPages?.artifacts.length || (recording.status !== "unavailable" && Boolean(recording.artifact)), "Selected-page video requires a saved primary recording");

export const RunSummarySchema = z.object({
  runId: z.string(),
  /** Saved by the Runner; optional only so pre-provenance Runs remain readable. */
  execution: z.object({
    adapter: z.string().min(1).max(64),
    kind: z.enum(["test", "session-network-capture", "session-resource-preparation"]).optional(),
    /** headful/headless are owned browser contexts; external is an attached or borrowed surface. */
    visibility: z.enum(["headful", "headless", "external"]).optional(),
    sessionId: z.string().uuid().optional(),

    sessionCaptureRunId: z.string().regex(/^session-network-[a-f0-9-]{36}$/).optional(),
    sessionNetworkEnabled: z.boolean().optional(),
    sessionRecordingRequested: z.boolean().optional(),
    replayOfRunId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  }).strict().optional(),
  projectRoot: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: z.enum(["running", "completed"]),
  verdict: VerdictSchema.optional(),
  eventLog: z.object({ status: z.enum(["sealed", "unavailable"]), bytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
    .refine((value) => value.status === "sealed" ? value.bytes !== undefined && value.sha256 !== undefined
      : value.bytes === undefined && value.sha256 === undefined, "Only a sealed event log can claim pinned bytes").optional(),
  recording: RunRecordingSchema.optional(),
  charter: TestCharterSchema,
  steps: z.array(StepResultSchema).default([]),
  assertions: z.array(AssertionResultSchema).default([]),
  oracles: z.array(OracleResultSchema).default([]),
  /** Runtime signals are kept separate from surface assertions and business facts. */
  // Optional on read so older run.json files remain valid. New runs always write both fields.
  runtimeHealth: z.enum(["passed", "failed", "ignored"]).optional(),
  runtimeFindings: z.array(RuntimeFindingSchema).optional(),
  targetBinding: TargetBindingSchema.optional(),
  targetBindingAfterRun: TargetBindingSchema.optional(),
  targetContinuity: TargetContinuitySchema.optional(),
  /** Electron's CDP listener, separate from an HTTP page server. */
  applicationBinding: TargetBindingSchema.optional(),
  applicationBindingAfterRun: TargetBindingSchema.optional(),
  applicationContinuity: TargetContinuitySchema.optional(),
  integrationPostRunCheck: IntegrationCheckResultSchema.optional(),
  integrationCleanup: IntegrationCleanupSchema.optional(),
  artifacts: z.array(z.string()).default([]),
  findings: z.array(z.string()).default([]),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RuntimeQualityPolicySchema = z.object({
  /** ignore keeps raw adapter events but does not classify runtime findings. */
  mode: z.enum(["ignore", "record", "fail"]).default("record"),
  pageErrors: z.boolean().default(true),
  requestFailures: z.boolean().default(false),
  consoleLevels: z.array(z.enum(["debug", "error", "info", "log", "warning", "warn", "assert", "trace"])).default(["error"]),
  failedResponses: z.object({
    enabled: z.boolean().default(true),
    include4xx: z.boolean().default(false),
  }).default({}),
  /** Regular expressions matched against event URLs. An allow list takes precedence over collection. */
  allowUrlPatterns: z.array(z.string().min(1)).default([]),
  ignoreUrlPatterns: z.array(z.string().min(1)).default([]),
  /** Explicit console signatures that invalidate the test environment, such as missing authentication. */
  blockConsolePatterns: z.array(z.string().min(1)).default([]),
});
export type RuntimeQualityPolicy = z.infer<typeof RuntimeQualityPolicySchema>;

export const RunEventSchema = z.object({
  runId: z.string(),
  timestamp: z.string(),
  type: z.enum(["run.started", "run.completed", "step.started", "step.completed", "assertion.completed", "oracle.completed", "adapter.event", "artifact.created", "finding.created", "target.binding"]),
  stepId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

/** A bounded, read-only fingerprint of the tested repository at Mission execution time. */
export const SourceStateSchema = z.object({
  method: z.enum(["git", "unavailable"]),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  worktreeSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  complete: z.boolean(),
  trackedDiffBytes: z.number().int().nonnegative().default(0),
  untrackedFiles: z.number().int().nonnegative().default(0),
  reason: z.string().optional(),
  capturedAt: z.string(),
});
export type SourceState = z.infer<typeof SourceStateSchema>;

export const ProjectEntryPointSchema = z.object({
  kind: z.enum(["web", "electron", "backend", "test", "script"]),
  path: z.string().min(1),
  reason: z.string().min(1),
});
export const ProjectRouteHintSchema = z.object({
  kind: z.enum(["web", "api"]),
  path: z.string().min(1),
  source: z.string().min(1),
  line: z.number().int().positive(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
  /** Static extraction provenance, never runtime coverage. Older maps omit it. */
  discovery: z.enum(["literal", "gin"]).optional(),
});
export const RouteDiscoveryDiagnosticSchema = z.object({
  extractor: z.literal("gin"),
  source: z.string().min(1),
  line: z.number().int().positive(),
  reason: z.enum(["dynamic-path", "unknown-router-prefix", "unsupported-router-operation"]),
});

export const ProjectMapSchema = z.object({
  root: z.string(),
  packageManager: z.string().optional(),
  packageName: z.string().optional(),
  scripts: z.record(z.string(), z.string()).default({}),
  workspaces: z.array(z.string()).default([]),
  packages: z.array(z.object({
    path: z.string(),
    name: z.string().optional(),
    scripts: z.record(z.string(), z.string()).default({}),
  })).default([]),
  detected: z.object({
    electron: z.boolean(),
    web: z.boolean(),
    backend: z.boolean(),
  }),
  /** Bounded path-level signals used to plan tests without changing the source project. */
  inventory: z.object({
    filesScanned: z.number().int().nonnegative().default(0),
    truncated: z.boolean().default(false),
    /** Why a bounded scan cannot support complete inventory claims. Older maps omit this. */
    truncationReasons: z.array(z.enum(["file-count-cap", "source-read-incomplete", "entry-point-cap", "route-hint-cap"])).max(4).optional(),
    source: z.enum(["git", "filesystem"]).default("filesystem"),
    sourceFiles: z.number().int().nonnegative().default(0),
    testFiles: z.number().int().nonnegative().default(0),
    configFiles: z.number().int().nonnegative().default(0),
    testFrameworks: z.array(z.string().min(1)).default([]),
    entryPoints: z.array(ProjectEntryPointSchema).default([]),
    routeHints: z.array(ProjectRouteHintSchema).default([]),
    /** Unresolved static declarations are separate from scan truncation. */
    routeDiagnostics: z.object({
      total: z.number().int().nonnegative(),
      items: z.array(RouteDiscoveryDiagnosticSchema).max(20),
      omitted: z.number().int().nonnegative(),
    }).optional(),
    /** One bounded path/line hint per matching source file; no source text is returned. */
    sourceTextMatches: z.object({
      total: z.number().int().nonnegative(),
      items: z.array(z.object({
        source: z.string().min(1).max(512).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..")),
        line: z.number().int().positive(),
      })).max(50),
      omitted: z.number().int().nonnegative(),
    }).optional(),
    /** Literal focus prioritizes retention before inventory caps; it is not semantic coverage. */
    retentionFocus: z.string().min(1).max(128).optional(),
  }).default({}),
  generatedAt: z.string(),
});
export type ProjectMap = z.infer<typeof ProjectMapSchema>;

/** A curated test case in the external workspace, selected by explicit aliases. */
export const RouteHttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type RouteHttpMethod = z.infer<typeof RouteHttpMethodSchema>;
const RoutePathSchema = z.string().min(1).max(256).refine((value) => value.startsWith("/") && !/[?#\s{}$]/.test(value), "Use a static route path without a query or fragment");
/** Repository-relative source path, useful when the same route appears in multiple files. */
const RouteSourceSchema = z.string().min(1).max(512).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "Use a repository-relative source path");
export const RouteCoverageTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), path: RoutePathSchema, source: RouteSourceSchema.optional() }),
  z.object({
    kind: z.literal("api"), path: RoutePathSchema, source: RouteSourceSchema.optional(),
    method: RouteHttpMethodSchema,
    /** Exact origin of the test gateway; path-only matches are not sufficient. */
    origin: z.string().url().refine((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value.replace(/\/$/, "") === url.origin;
      } catch { return false; }
    }, "Use an HTTP(S) origin without a path, credentials, query or fragment"),
  }),
]);
export type RouteCoverageTarget = z.infer<typeof RouteCoverageTargetSchema>;

export const CharterCatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  path: z.string().min(1),
  aliases: z.array(z.string().trim().min(2)).min(1),
  level: TestLevelSchema,
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1),
  routeTargets: z.array(RouteCoverageTargetSchema).optional(),
});
export type CharterCatalogEntry = z.infer<typeof CharterCatalogEntrySchema>;

const CatalogIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/);

/** A release suite names its workflows explicitly; discovery never expands it implicitly. */
export const SuiteCatalogEntrySchema = z.object({
  id: CatalogIdSchema,
  aliases: z.array(z.string().trim().min(2)).min(1),
  level: z.literal("release"),
  charterIds: z.array(CatalogIdSchema).min(2),
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1),
}).superRefine((suite, ctx) => {
  if (new Set(suite.charterIds).size !== suite.charterIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charterIds"], message: "Suite Charter IDs must be unique" });
  if (new Set(suite.surfaces).size !== suite.surfaces.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["surfaces"], message: "Suite surfaces must be unique" });
});
export type SuiteCatalogEntry = z.infer<typeof SuiteCatalogEntrySchema>;

/** A reviewed candidate inventory, never evidence that its workflows actually passed. */
const WorkflowSourcePathSchema = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes(":")
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
"Use a repository-relative source path without traversal");
export const WorkflowInventorySchema = z.object({
  schemaVersion: z.literal(1),
  /** The complete Git source fingerprint captured when the inventory was prepared. */
  source: z.object({
    headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    worktreeSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }).strict(),
  /** Human review is a declaration unless an external-key attestation authenticates it. */
  review: z.object({ by: z.string().trim().min(1).max(120), at: z.string().datetime({ offset: true }), method: z.string().trim().min(1).max(500) }).strict().optional(),
  workflows: z.array(z.object({
    id: CatalogIdSchema,
    title: z.string().trim().min(1).max(200),
    sourcePaths: z.array(WorkflowSourcePathSchema).min(1).max(12),
    /** Shorthand: every Charter is required on every declared workflow surface. */
    charterIds: z.array(CatalogIdSchema).min(1).max(16).optional(),
    /** Explicit Charter × surface obligations for platform-specific scenarios. */
    checks: z.array(z.object({
      charterId: CatalogIdSchema,
      surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1).max(3),
    }).strict()).min(1).max(16).optional(),
    surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1).max(3),
  }).strict()).min(1).max(150),
  /** Exclusions are visible gaps for project-wide acceptance. */
  exclusions: z.array(z.object({
    id: CatalogIdSchema,
    reason: z.string().trim().min(1).max(500),
    sourcePaths: z.array(WorkflowSourcePathSchema).min(1).max(12),
  }).strict()).max(150).default([]),
}).strict().superRefine((inventory, ctx) => {
  const ids = [...inventory.workflows.map((item) => item.id), ...inventory.exclusions.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows"], message: "Workflow and exclusion IDs must be unique" });
  for (const [index, workflow] of inventory.workflows.entries()) {
    if (Boolean(workflow.charterIds) === Boolean(workflow.checks)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", index], message: "Declare charterIds or checks, but not both" });
    if (new Set(workflow.sourcePaths).size !== workflow.sourcePaths.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", index, "sourcePaths"], message: "Source paths must be unique" });
    if (workflow.charterIds && new Set(workflow.charterIds).size !== workflow.charterIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", index, "charterIds"], message: "Charter IDs must be unique" });
    if (workflow.checks && new Set(workflow.checks.map((check) => check.charterId)).size !== workflow.checks.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", index, "checks"], message: "Check Charter IDs must be unique" });
    if (new Set(workflow.surfaces).size !== workflow.surfaces.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", index, "surfaces"], message: "Surfaces must be unique" });
    const checks = workflow.checks ?? workflow.charterIds?.map((charterId) => ({ charterId, surfaces: workflow.surfaces })) ?? [];
    const assigned = new Set(checks.flatMap((check) => check.surfaces));
    for (const surface of workflow.surfaces) if (!assigned.has(surface)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", index, "surfaces"], message: `No Charter check covers ${surface}` });
    for (const [checkIndex, check] of checks.entries()) {
      if (new Set(check.surfaces).size !== check.surfaces.length || check.surfaces.some((surface) => !workflow.surfaces.includes(surface))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", index, "checks", checkIndex, "surfaces"], message: "Check surfaces must be unique and within the workflow surface set" });
      }
    }
  }
});
export type WorkflowInventory = z.infer<typeof WorkflowInventorySchema>;
export function workflowChecks(workflow: WorkflowInventory["workflows"][number]): Array<{ charterId: string; surfaces: Array<"web" | "electron" | "mobile"> }> {
  return workflow.checks ?? workflow.charterIds?.map((charterId) => ({ charterId, surfaces: workflow.surfaces })) ?? [];
}

/** Read-only inventory diagnostics; no field grants a product verdict. */
export const WorkflowCandidateAuditSchema = z.object({
  status: z.enum(["scanned", "partial"]),
  routeCandidates: z.number().int().nonnegative(),
  entryCandidates: z.number().int().nonnegative(),
  sourceOwned: z.number().int().nonnegative(),
  routeLinked: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  unclaimed: z.number().int().nonnegative(),
  unlinkedRoutes: z.number().int().nonnegative(),
  overlappingExclusions: z.number().int().nonnegative(),
  unresolvedRouteDeclarations: z.number().int().nonnegative(),
  skippedCandidates: z.number().int().nonnegative(),
  gaps: z.array(z.object({
    kind: z.enum(["web-route", "api-route", "entry-point"]),
    source: WorkflowSourcePathSchema,
    path: z.string().min(1).optional(),
    method: RouteHttpMethodSchema.optional(),
    reason: z.enum(["unclaimed-source", "unlinked-route", "overlapping-exclusion"]),
  })).max(20),
  omittedGaps: z.number().int().nonnegative(),
  limitations: z.array(z.string().min(1)).max(5),
});
export type WorkflowCandidateAudit = z.infer<typeof WorkflowCandidateAuditSchema>;

/** A signature over the normalized inventory and the exact candidate audit presented to its reviewer. */
export const WorkflowReviewAttestationSchema = z.object({
  schemaVersion: z.literal(2),
  algorithm: z.literal("Ed25519"),
  keyId: CatalogIdSchema,
  inventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidateSetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  charterManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export type WorkflowReviewAttestation = z.infer<typeof WorkflowReviewAttestationSchema>;

export const WorkflowReviewAuthenticationSchema = z.object({
  status: z.enum(["missing", "untrusted", "invalid", "verified"]),
  keyId: CatalogIdSchema.optional(),
  /** This authenticates the declaration only; semantic completeness still requires review judgment. */
  candidateSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  candidateSetSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  charterManifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type WorkflowReviewAuthentication = z.infer<typeof WorkflowReviewAuthenticationSchema>;

export const WorkflowReviewMaterialsSchema = z.object({
  candidateSetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  charterManifest: z.array(z.object({
    id: CatalogIdSchema,
    catalog: CharterCatalogEntrySchema,
    fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    executionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(256),
}).strict();
export type WorkflowReviewMaterials = z.infer<typeof WorkflowReviewMaterialsSchema>;

export const WorkflowReviewSnapshotSchema = z.object({
  attestation: WorkflowReviewAttestationSchema,
  materials: WorkflowReviewMaterialsSchema,
}).strict();
export type WorkflowReviewSnapshot = z.infer<typeof WorkflowReviewSnapshotSchema>;

/** Frozen proof that a new Mission was admitted against the reviewed scope before execution. */
export const WorkflowReviewAdmissionSchema = z.object({
  keyId: CatalogIdSchema,
  candidateSetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.literal("reviewed-source-workflows"),
}).strict();
export type WorkflowReviewAdmission = z.infer<typeof WorkflowReviewAdmissionSchema>;

export const WorkflowReviewAuditSchema = z.object({
  status: z.enum(["not-applicable", "unverified", "verified"]),
  reason: z.enum(["missing-frozen-review", "inventory-gaps", "review-untrusted", "review-invalid", "candidate-mismatch",
    "charter-mismatch", "suite-mismatch", "source-mismatch", "execution-incomplete", "surface-only", "missing-admission",
    "route-coverage-incomplete"]).optional(),
  keyId: CatalogIdSchema.optional(),
  /** Verified means the reviewed source snapshot and required Run slots passed the current audit. */
  scope: z.literal("reviewed-source-workflows").optional(),
});
export type WorkflowReviewAudit = z.infer<typeof WorkflowReviewAuditSchema>;

export const WorkflowInventoryInspectionSchema = z.object({
  status: z.enum(["missing", "invalid", "loaded"]),
  path: z.literal(".proofkit/workflows.yaml"),
  sourceMatch: z.enum(["not-checked", "matching", "changed", "unverified"]),
  reviewDeclared: z.boolean(),
  reviewAuthentication: WorkflowReviewAuthenticationSchema.optional(),
  workflowCount: z.number().int().nonnegative(),
  linkedWorkflowCount: z.number().int().nonnegative(),
  exclusionCount: z.number().int().nonnegative(),
  missingCharterIds: z.array(CatalogIdSchema).max(20),
  omittedMissingCharterIds: z.number().int().nonnegative(),
  uncoveredSurfaces: z.array(z.object({ workflowId: CatalogIdSchema, surface: z.enum(["web", "electron", "mobile"]) })).max(20),
  omittedUncoveredSurfaces: z.number().int().nonnegative(),
  missingSourcePaths: z.array(WorkflowSourcePathSchema).max(20),
  omittedMissingSourcePaths: z.number().int().nonnegative(),
  candidateAudit: WorkflowCandidateAuditSchema.optional(),
  issues: z.array(z.string().min(1)).max(20),
  omittedIssues: z.number().int().nonnegative(),
});
export type WorkflowInventoryInspection = z.infer<typeof WorkflowInventoryInspectionSchema>;

/** Evidence measured against a saved inventory; even full declared coverage cannot prove inventory completeness. */
export const WorkflowExecutionCoverageSchema = z.object({
  status: z.enum(["not-measured", "partial", "all-declared-evidenced"]),
  /** The proof required for each declared check; surface proof cannot claim a business terminal state. */
  requiredProof: z.enum(["surface", "business"]).optional(),
  workflowCount: z.number().int().nonnegative(),
  evidencedWorkflowCount: z.number().int().nonnegative(),
  requiredChecks: z.number().int().nonnegative(),
  evidencedChecks: z.number().int().nonnegative(),
  sourceBinding: z.enum(["matching", "changed", "unverified"]),
  reviewDeclared: z.boolean(),
  exclusionCount: z.number().int().nonnegative(),
  suiteId: CatalogIdSchema.optional(),
  gaps: z.array(z.object({
    workflowId: CatalogIdSchema,
    charterId: CatalogIdSchema,
    surface: z.enum(["web", "electron", "mobile"]),
    reason: z.enum(["no-suite", "not-scheduled", "failed", "blocked", "cancelled", "inconclusive"]),
    primaryRunId: z.string().optional(),
    replayRunId: z.string().optional(),
  })).max(40),
  omittedGaps: z.number().int().nonnegative(),
  limitations: z.array(z.string().min(1)).max(8),
});
export type WorkflowExecutionCoverage = z.infer<typeof WorkflowExecutionCoverageSchema>;

export const TestSuiteSchema = z.object({
  suiteId: CatalogIdSchema,
  origin: z.enum(["catalog", "workflow-inventory"]).default("catalog"),
  level: TestLevelSchema,
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1),
  charters: z.array(z.object({
    charterId: CatalogIdSchema,
    charter: TestCharterSchema,
    /** Omitted for a catalog suite: every Charter runs on every suite surface. */
    surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1).optional(),
    routeTargets: z.array(RouteCoverageTargetSchema).optional(),
  })).min(1),
  uncoveredCharterIds: z.array(CatalogIdSchema).default([]),
}).superRefine((suite, ctx) => {
  if (new Set(suite.charters.map((item) => item.charterId)).size !== suite.charters.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters"], message: "Suite Charter IDs must be unique" });
  if (new Set(suite.surfaces).size !== suite.surfaces.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["surfaces"], message: "Suite surfaces must be unique" });
  if (suite.origin === "catalog" && suite.level !== "release") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["level"], message: "Catalog suites require release level" });
  if (suite.origin === "catalog" && suite.charters.length < 2) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters"], message: "Catalog suites require at least two Charters" });
  if (new Set(suite.uncoveredCharterIds).size !== suite.uncoveredCharterIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["uncoveredCharterIds"], message: "Uncovered Charter IDs must be unique" });
  if (suite.uncoveredCharterIds.some((id) => suite.charters.some((item) => item.charterId === id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["uncoveredCharterIds"], message: "Included Charters cannot be uncovered" });
  for (const [index, item] of suite.charters.entries()) {
    if (item.charter.level !== suite.level) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters", index, "charter", "level"], message: "Suite Charter level must match the suite" });
    if (suite.origin === "catalog" && item.surfaces) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters", index, "surfaces"], message: "Catalog suites use the complete surface matrix" });
    if (suite.origin === "workflow-inventory" && !item.surfaces) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters", index, "surfaces"], message: "Workflow suites require explicit Charter surfaces" });
    if (item.surfaces && (new Set(item.surfaces).size !== item.surfaces.length || item.surfaces.some((surface) => !suite.surfaces.includes(surface)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters", index, "surfaces"], message: "Charter surfaces must be unique and within the suite matrix" });
    }
  }
  if (suite.origin === "workflow-inventory" && suite.surfaces.some((surface) => !suite.charters.some((item) => (item.surfaces ?? []).includes(surface)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["surfaces"], message: "Every project surface requires a Charter" });
  }
});
export type TestSuite = z.infer<typeof TestSuiteSchema>;
export function suiteChecks(suite: TestSuite): Array<{ charterId: string; charter: TestCharter; surface: "web" | "electron" | "mobile" }> {
  return suite.charters.flatMap(({ charterId, charter, surfaces }) => (surfaces ?? suite.surfaces).map((surface) => ({ charterId, charter, surface })));
}

export const TestScopeInputSchema = z.object({
  level: TestLevelSchema.default("core"),
  surface: z.enum(["web", "electron", "mobile"]).default("web"),
  /** Literal, case-insensitive substring; this is not semantic workflow selection. */
  focus: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  /** Request a bounded Git fingerprint for authoring a version-bound workflow inventory. */
  includeSourceState: z.boolean().default(false),
});
export type TestScopeInput = z.input<typeof TestScopeInputSchema>;
const ScopePlanCheckSchema = z.object({
  eligible: z.boolean(),
  planReady: z.boolean(),
  issues: z.array(z.string()),
});
const ScopeCountSchema = z.number().int().nonnegative();
/** Static planning observations have no execution or product verdict. */
export const TestScopeSchema = z.object({
  schemaVersion: z.literal(1),
  testVerdict: z.literal("not-asserted"),
  executionChecks: z.literal("not-run"),
  projectRoot: z.string(),
  workspaceRoot: z.string(),
  sourceState: SourceStateSchema.optional(),
  workflowInventory: WorkflowInventoryInspectionSchema.optional(),
  selection: TestScopeInputSchema.extend({ requiredSurfaces: z.array(z.enum(["web", "electron", "mobile"])) }),
  inventory: ProjectMapSchema.shape.inventory.removeDefault().omit({ entryPoints: true, routeHints: true }),
  entryPoints: z.object({ total: ScopeCountSchema, matched: ScopeCountSchema, items: z.array(ProjectEntryPointSchema), omitted: ScopeCountSchema }),
  routes: z.object({
    total: ScopeCountSchema,
    matched: ScopeCountSchema,
    declaredTargets: ScopeCountSchema,
    mapped: ScopeCountSchema,
    unmapped: ScopeCountSchema,
    items: z.array(ProjectRouteHintSchema.extend({ charterIds: z.array(z.string()), omittedCharterIds: ScopeCountSchema, status: z.enum(["declared", "unmapped"]), runtimeSourceAmbiguous: z.boolean() })),
    omitted: ScopeCountSchema,
    unresolvedTargets: z.array(RouteCoverageTargetSchema.and(z.object({ charterId: z.string(), reason: z.enum(["absent", "ambiguous"]) }))),
    omittedUnresolvedTargets: ScopeCountSchema,
  }),
  catalog: z.object({
    total: ScopeCountSchema, eligible: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({
      id: z.string(), path: z.string(), aliases: z.array(z.string()), omittedAliases: ScopeCountSchema,
      level: TestLevelSchema, surfaces: z.array(z.enum(["web", "electron", "mobile"])),
      check: ScopePlanCheckSchema,
    })),
  }),
  suites: z.object({
    total: ScopeCountSchema, eligible: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({ id: z.string(), charterIds: z.array(z.string()), omittedCharterIds: ScopeCountSchema, check: ScopePlanCheckSchema })),
  }),
  integration: z.object({ name: z.string(), version: z.string().optional(), preflightRegistered: z.boolean(), setupRegistered: z.boolean() }).optional(),
  capabilities: z.object({
    total: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({
      name: z.string(), description: z.string(), sideEffect: z.enum(["none", "read", "write"]),
      environments: z.array(z.enum(["test", "staging", "local"])), environmentAllowed: z.boolean(), operatorWriteOptIn: z.boolean(),
      inputShape: z.object({ hint: z.record(z.unknown()).optional(), partial: z.boolean(), limitations: z.array(z.string()) }),
    })),
  }),
  oracles: z.object({
    total: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({ name: z.string(), kind: z.enum(["registered", "configured-http"]) })),
  }),
  /** Additive planning guidance; older saved scope snapshots remain readable. */
  planningReadiness: z.object({
    status: z.enum(["catalog-ready", "candidate-review-needed", "authoring-needed", "inspection-incomplete"]),
    compatibleMatched: ScopeCountSchema,
    compatibleChecked: ScopeCountSchema,
    compatibleReady: ScopeCountSchema,
    compatibleOmitted: ScopeCountSchema,
    gaps: z.array(z.object({
      code: z.enum(["no-compatible-plan", "intensity-mismatch", "surface-mismatch", "plan-invalid", "catalog-omitted", "source-focus-unresolved", "oracle-name-unmatched", "no-registered-oracle", "unregistered-workspace-charters", "candidate-endpoint-binding-unavailable"]),
      relatedIds: z.array(CatalogIdSchema).max(5),
      guidance: z.string().min(1).max(240),
    })).max(9),
  }).optional(),
  /** Configuration hints only; endpoint reachability and app identity need environment inspection. */
  targetConfiguration: z.object({
    required: z.array(z.object({
      surface: z.enum(["web", "electron", "mobile"]),
      status: z.enum(["configured", "missing", "default-driver"]),
    })).min(1).max(2),
    runtimeChecked: z.literal(false),
  }).optional(),
  /** Candidate files are hints only; catalog registration and normal Run validation are separate. */
  workspaceCandidates: z.object({
    scanStatus: z.enum(["complete", "partial"]),
    scanTruncated: z.boolean(),
    total: ScopeCountSchema,
    matched: ScopeCountSchema,
    selection: z.enum(["all", "focused", "fallback-unmatched"]),
    omitted: ScopeCountSchema,
    items: z.array(z.object({
      path: z.string().min(1).max(512),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      focusMatched: z.boolean(),
      parseStatus: z.enum(["valid", "invalid", "oversized", "unreadable"]),
      level: TestLevelSchema.optional(),
      surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1).max(3).optional(),
      sideEffectPolicy: SideEffectPolicySchema.optional(),
      actionCount: ScopeCountSchema.optional(),
      assertionCount: ScopeCountSchema.optional(),
      oracleCount: ScopeCountSchema.optional(),
      issues: z.array(z.enum(["invalid-charter", "endpoint-binding-unavailable", "file-too-large", "file-unavailable", "missing-positive-assertion", "missing-business-oracle", "unregistered-capability", "unregistered-oracle", "capability-environment-mismatch", "write-opt-in-required", "scenario-side-effect-policy-conflict", "mcp-workspace-policy-conflict", "inline-oracle-name-conflict", "inline-oracle-binding-invalid", "inline-oracle-current-id-missing", "oracle-origin-disallowed", "web-origin-disallowed", "surface-unspecified", "surface-mismatch"])).max(18),
    })).max(50),
  }).optional(),
  limitations: z.array(z.string()),
  next: z.array(z.string()),
  generatedAt: z.string(),
});
export type TestScope = z.infer<typeof TestScopeSchema>;

/** Read-only connector readiness is provenance, not a product verdict. */
export const IntegrationReadinessInputSchema = z.object({
  charterId: CatalogIdSchema.optional(),
  charterPath: z.string().min(1).max(512).optional(),
  charterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  charter: TestCharterSchema.optional(),
}).strict().superRefine((value, context) => {
  const catalog = value.charterId !== undefined;
  const candidate = value.charterPath !== undefined || value.charterSha256 !== undefined;
  const draft = value.charter !== undefined;
  if (Number(catalog) + Number(candidate) + Number(draft) !== 1 || candidate && (value.charterPath === undefined || value.charterSha256 === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Select either charterId, charterPath with charterSha256, or a submitted draft charter; use exactly one selection form" });
  }
  if (draft && !value.charter!.surfaces) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["charter", "surfaces"], message: "Draft readiness requires declared surfaces" });
  }
});
export type IntegrationReadinessInput = z.input<typeof IntegrationReadinessInputSchema>;
export const IntegrationReadinessCheckSchema = IntegrationCheckResultSchema.extend({
  message: z.string().min(1).max(1024),
  evidence: z.record(z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()])).default({}),
  issues: z.array(z.object({ code: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), guidance: z.string().min(1).max(240) }).strict()).max(32).optional(),
}).refine((check) => Object.keys(check.evidence).length <= 32
  && Object.entries(check.evidence).every(([key, value]) => key.length <= 128 && (typeof value !== "string" || value.length <= 1024)),
"Connector readiness check exceeds output limits");
export type IntegrationReadinessCheck = z.infer<typeof IntegrationReadinessCheckSchema>;
export const IntegrationReadinessSchema = z.object({
  schemaVersion: z.literal(1),
  testVerdict: z.literal("not-asserted"),
  projectRoot: z.string(),
  workspaceRoot: z.string(),
  charterId: CatalogIdSchema.optional(),
  charterPath: z.string().min(1).max(512).optional(),
  charterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  draftSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  level: TestLevelSchema,
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1).max(3),
  environment: z.enum(["test", "staging", "local"]),
  status: z.enum(["ready", "blocked", "unavailable"]),
  integration: z.object({ name: z.string().min(1).max(128), version: z.string().min(1).max(128).optional() }).optional(),
  check: IntegrationReadinessCheckSchema.optional(),
  next: z.array(z.string().min(1).max(240)).max(8),
  checkedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.draftSha256 !== undefined ? value.charterId !== undefined || value.charterPath !== undefined || value.charterSha256 !== undefined
    : !IntegrationReadinessInputSchema.safeParse({ charterId: value.charterId, charterPath: value.charterPath, charterSha256: value.charterSha256 }).success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Readiness must identify one catalog Charter, digest-pinned candidate or normalized draft digest" });
  }
  if (value.status === "ready" && value.check?.passed !== true) context.addIssue({ code: z.ZodIssueCode.custom, path: ["check"], message: "Ready status requires a passing connector check" });
  if (value.status === "blocked" && value.check?.passed !== false) context.addIssue({ code: z.ZodIssueCode.custom, path: ["check"], message: "Blocked status requires a failing connector check" });
  if (value.status === "unavailable" && value.check !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["check"], message: "Unavailable status cannot include a verified connector check" });
});
export type IntegrationReadiness = z.infer<typeof IntegrationReadinessSchema>;

export const ProofkitConfigSchema = z.object({
  project: z.object({
    root: z.string().default("."),
    start: z.string().optional(),
    cwd: z.string().optional(),
    stop: z.string().optional(),
    health: z.array(z.union([
      z.string(),
      z.object({ url: z.string().url(), expectedStatus: z.number().int().min(100).max(599).default(200) }),
    ])).default([]),
    startupTimeoutMs: z.number().int().positive().default(60_000),
  }).default({}),
  surfaces: z.object({
    web: z.object({
      baseUrl: z.string().url().optional(),
      apiOrigins: z.array(z.string().url().max(2048).refine((value) => {
        try {
          const parsed = new URL(value);
          return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hostname.includes("*") && parsed.origin === value;
        } catch { return false; }
      }, "Use an exact HTTP(S) origin without credentials, path, query or fragment")).max(8)
        .refine((origins) => new Set(origins).size === origins.length, "API origins must be unique").optional(),
      cdpUrl: z.string().url().optional(),
      targetUrlPrefix: z.string().min(1).optional(),
      targetTitleContains: z.string().min(1).optional(),
      executablePath: z.string().min(1).optional(),
      screenshotMaskSelectors: z.array(z.string().trim().min(1).max(256)).max(16).optional(),
      readyWhen: SurfaceReadinessSchema.optional(),
    }).optional(),
    electron: z.object({
      cdpUrl: z.string().optional(),
      devtoolsActivePort: z.string().optional(),
      targetUrlPrefix: z.string().min(1).optional(),
      targetTitleContains: z.string().min(1).optional(),
      readyWhen: SurfaceReadinessSchema.optional(),
    }).optional(),
    mobile: z.object({
      serverUrl: z.string().url().default("http://127.0.0.1:4723"),
      readyWhen: SurfaceReadinessSchema.optional(),
      platformName: z.string().min(1).optional(),
      deviceName: z.string().min(1).optional(),
      automationName: z.string().min(1).optional(),
      app: z.string().min(1).optional(),
      appPackage: z.string().min(1).optional(),
      appActivity: z.string().min(1).optional(),
      noReset: z.boolean().optional(),
      capabilities: z.record(z.string(), z.unknown()).default({}),
    }).optional(),
  }).default({}),
  planning: z.object({
    provider: z.enum(["deterministic", "openai-compatible"]).default("deterministic"),
    baseUrl: z.string().url().optional(),
    model: z.string().min(1).optional(),
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  }).default({}),
  integration: z.object({
    path: z.string().min(1).optional(),
  }).default({}),
  charters: z.array(CharterCatalogEntrySchema).default([]),
  suites: z.array(SuiteCatalogEntrySchema).default([]),
  run: z.object({
    timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
    recordVideo: z.boolean().optional(),
    videoBudget: VideoRecordingBudgetSchema.optional(),
  }).default({}),
  sessions: z.object({
    recordNetwork: z.boolean().optional(),
    recordVideo: z.boolean().optional(),
    videoBudget: VideoRecordingBudgetSchema.optional(),
    /** Disabled by default because browser storage state contains credentials and cookies. */
    persistence: z.enum(["disabled", "encrypted"]).default("disabled"),
    keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  }).optional(),
  oracles: z.array(ConfiguredHttpOracleSchema).default([]),
  policies: z.object({
    environment: z.enum(["test", "staging", "local"]).default("test"),
    sideEffects: SideEffectPolicySchema.default("confirm"),
    saveSensitivePayloads: z.boolean().default(false),
    runtime: RuntimeQualityPolicySchema.default({}),
    /** Block only an evidenced different Git checkout; keep unknown targets explicit. */
    targetBinding: z.enum(["record", "block-different"]).default("block-different"),
  }).default({}),
}).superRefine((config, context) => {
  const sessions = config.sessions;
  if (sessions?.persistence === "encrypted" && !sessions.keyEnv) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sessions", "keyEnv"], message: "Encrypted session persistence requires keyEnv" });
  }
  if (sessions?.persistence !== "encrypted" && sessions?.keyEnv !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sessions", "keyEnv"], message: "keyEnv is only valid when session persistence is encrypted" });
  }
});
export type ProofkitConfig = z.infer<typeof ProofkitConfigSchema>;

// Mission contracts are deliberately independent from the surface adapter.
// The same task graph can drive Web, Electron, mobile or API tools.
export const MissionSurfaceSchema = z.enum(["web", "electron", "mobile", "api"]);
export type MissionSurface = z.infer<typeof MissionSurfaceSchema>;

/** Browser visibility is a reviewable Mission choice; Electron visibility is controlled by its external app process. */
export const MissionWebVisibilitySchema = z.enum(["headless", "headful"]);
export type MissionWebVisibility = z.infer<typeof MissionWebVisibilitySchema>;

/** The execution obligations selected by the test level. */
export const MissionExecutionProfileSchema = z.object({
  surfaceMatrix: z.array(MissionSurfaceSchema).min(1).default(["web"]),
  webVisibility: MissionWebVisibilitySchema.default("headless"),
  suiteId: CatalogIdSchema.optional(),
  charterIds: z.array(CatalogIdSchema).default([]),
  collectAllResults: z.boolean().default(false),
  negativeCases: z.array(z.string().min(1)).default([]),
  declaredNegativeCases: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/)).default([]),
  requireBusinessOracle: z.boolean().default(false),
  requireReplay: z.boolean().default(false),
  requireNegativeCases: z.boolean().default(false),
  minimumEvidence: z.number().int().positive().default(1),
});
/** Optional in the TypeScript view so legacy in-memory fixtures can still be read; schema parsing supplies headless. */
export type MissionExecutionProfile = Omit<z.infer<typeof MissionExecutionProfileSchema>, "webVisibility"> & {
  webVisibility?: MissionWebVisibility;
};

export const MissionStatusSchema = z.enum([
  "draft",
  "planned",
  "awaiting-approval",
  "approved",
  "running",
  "paused",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MissionRecoveryInspectionSchema = z.object({
  missionId: z.string().min(1),
  status: z.enum(["active", "recoverable", "review-required", "deadline-expired", "not-needed"]),
  testVerdict: z.literal("not-asserted"),
  activeOwner: z.boolean(),
  tasks: z.array(z.object({
    taskId: z.string(),
    tool: z.string(),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    status: z.enum(["retry-safe", "review-required", "attempts-exhausted", "deadline-expired"]),
    reason: z.string().min(1).max(512),
  })).max(100),
  omittedTasks: z.number().int().nonnegative(),
  nextAction: z.enum(["wait", "start_mission", "review", "none"]),
}).strict();
export type MissionRecoveryInspection = z.infer<typeof MissionRecoveryInspectionSchema>;

export const MissionTaskStatusSchema = z.enum(["pending", "ready", "running", "passed", "failed", "blocked", "skipped"]);
export type MissionTaskStatus = z.infer<typeof MissionTaskStatusSchema>;

export const MissionPolicySchema = z.object({
  level: TestLevelSchema.default("core"),
  environment: z.enum(["test", "staging", "local"]).default("test"),
  sideEffectPolicy: SideEffectPolicySchema.default("confirm"),
  requireApproval: z.boolean().default(true),
  requireEvidence: z.boolean().default(true),
  maxSteps: z.number().int().positive().max(10_000).default(100),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
});
export type MissionPolicy = z.infer<typeof MissionPolicySchema>;

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1),
  kind: z.enum(["screenshot", "video", "snapshot", "network", "console", "process", "api", "business", "runtime", "log", "report", "other"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  description: z.string().min(1).optional(),
  capturedAt: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ResourceRecoveryResultSchema = z.object({
  attemptId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  runId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  projectRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  journalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  status: z.enum(["verified", "unverified"]),
  testVerdict: z.literal("not-asserted"),
  cleanup: IntegrationCleanupSchema,
  evidence: z.array(EvidenceRefSchema).max(2),
}).strict();
export type ResourceRecoveryResult = z.infer<typeof ResourceRecoveryResultSchema>;

export const ResourceRecoveryInspectionSchema = z.object({
  runId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  status: z.enum(["active", "recoverable", "cleaned", "not-required", "unverified"]),
  testVerdict: z.literal("not-asserted"),
  resources: z.array(IntegrationResourceSchema).max(32),
  issues: z.array(z.string().max(256)).max(8),
  latestRecovery: ResourceRecoveryResultSchema.optional(),
}).strict();
export type ResourceRecoveryInspection = z.infer<typeof ResourceRecoveryInspectionSchema>;

export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  charterId: CatalogIdSchema.optional(),
  source: z.enum(["surface", "network", "console", "process", "api", "business", "evidence", "planner"]),
  kind: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(EvidenceRefSchema).default([]),
  observedAt: z.string(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const ToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  taskId: z.string().min(1),
  charterId: CatalogIdSchema.optional(),
  tool: z.string().min(1),
  /** The declaration in force when this attempt started; absent on legacy receipts. */
  sideEffect: z.enum(["none", "read", "write"]).optional(),
  /** Opaque tool/version/context identity required for automatic crash retry. */
  recoveryKey: z.string().min(1).max(128).optional(),
  attempt: z.number().int().positive().default(1),
  input: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["started", "succeeded", "failed", "blocked", "cancelled"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * A durable control-loop step. AgentStep records the agent's decision and
 * lifecycle around a task; ToolCall records the concrete registered tool
 * invocation that implements that decision.
 */
export const AgentStepSchema = z.object({
  agentStepId: z.string().min(1),
  sequence: z.number().int().positive(),
  taskId: z.string().min(1),
  charterId: CatalogIdSchema.optional(),
  phase: z.enum(["execute", "recover", "verify"]).default("execute"),
  tool: z.string().min(1),
  decision: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["running", "succeeded", "failed", "blocked", "cancelled"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  toolCallIds: z.array(z.string().min(1)).default([]),
  observationIds: z.array(z.string().min(1)).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const FindingSchema = z.object({
  findingId: z.string().min(1),
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  category: z.enum(["product", "test", "environment", "security", "performance", "unknown"]),
  status: z.enum(["confirmed", "suspected", "unverified"]),
  title: z.string().min(1),
  message: z.string().min(1),
  evidence: z.array(EvidenceRefSchema).default([]),
  createdAt: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const DiagnosisSchema = z.object({
  diagnosisId: z.string().min(1),
  /** Explicit Finding ownership for new diagnoses; absent on historical Missions. */
  findingId: z.string().min(1).optional(),
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  likelyOwner: z.string().min(1).optional(),
  sourceLocations: z.array(z.string()).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  createdAt: z.string(),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

/** Exact current-checkout references supplied after the host has inspected source. No source text is retained. */
export const RepairSourceReferenceSchema = z.object({
  path: z.string().min(1).max(512).refine((path) => !path.includes("\\") && !path.includes(":") && !path.includes("\0")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."), "Use a portable repository-relative path"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  startLine: z.number().int().positive().max(1_000_000),
  endLine: z.number().int().positive().max(1_000_000),
  explanation: z.string().min(1).max(1000),
}).strict().refine((ref) => ref.endLine >= ref.startLine && ref.endLine - ref.startLine < 200, "Source range must contain 1–200 lines");
export type RepairSourceReference = z.infer<typeof RepairSourceReferenceSchema>;

export const RepairHypothesisInputSchema = z.object({
  missionId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  expectedRevision: z.number().int().nonnegative(),
  findingId: z.string().min(1).max(256),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(2000),
  changes: z.array(z.string().min(1).max(1000)).min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().min(1).max(256)).min(1).max(12),
  sourceReferences: z.array(RepairSourceReferenceSchema).min(1).max(8),
  regressionCheck: z.string().min(1).max(2000),
}).strict();
export type RepairHypothesisInput = z.infer<typeof RepairHypothesisInputSchema>;

export const RepairSourceAuditSchema = z.object({
  suggestionId: z.string().min(1),
  checkedAt: z.string(),
  sourceScope: z.literal("current-checkout"),
  causeStatus: z.literal("hypothesis"),
  references: z.array(z.object({
    path: z.string(), startLine: z.number().int(), endLine: z.number().int(),
    status: z.enum(["matching", "changed", "unavailable", "invalid-range"]),
  })).max(8),
});
export type RepairSourceAudit = z.infer<typeof RepairSourceAuditSchema>;

export const RepairSuggestionSchema = z.object({
  suggestionId: z.string().min(1),
  /** The observed Finding that motivated this proposal; absent on historical Missions. */
  findingId: z.string().min(1).optional(),
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  changes: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceRefSchema).default([]),
  status: z.enum(["proposed", "accepted", "rejected", "verified"]).default("proposed"),
  hypothesis: z.object({
    origin: z.literal("host-agent"),
    causeStatus: z.literal("hypothesis"),
    sourceScope: z.literal("current-checkout"),
    sourceReferences: z.array(RepairSourceReferenceSchema).min(1).max(8),
    regressionCheck: z.string().min(1).max(2000),
    submittedAt: z.string(),
  }).optional(),
});
export type RepairSuggestion = z.infer<typeof RepairSuggestionSchema>;

// The first failure is the earliest observable boundary that explains why a
// mission could not satisfy its success criteria. It is intentionally kept
// separate from Finding so a test failure cannot be mistaken for a product
// defect without an independent oracle or assertion evidence.
export const FailureBoundarySchema = z.object({
  kind: z.enum(["surface-action", "assertion", "business-oracle", "environment", "evidence"]),
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
  message: z.string().min(1),
  stepId: z.string().optional(),
  oracleName: z.string().optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
  observedAt: z.string(),
});
export type FailureBoundary = z.infer<typeof FailureBoundarySchema>;

export const TaskNodeSchema = z.object({
  taskId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  charterId: CatalogIdSchema.optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
  dependencyMode: z.enum(["passed", "settled"]).default("passed"),
  status: MissionTaskStatusSchema.default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().max(10).default(1),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskNodeSchema).min(1).max(10_000),
  terminalTaskIds: z.array(z.string()).min(1),
}).superRefine((graph, ctx) => {
  const tasks = new Map(graph.tasks.map((task) => [task.taskId, task]));
  const dependents = new Map(graph.tasks.map((task) => [task.taskId, 0]));
  const downstreamTasks = new Map(graph.tasks.map((task) => [task.taskId, [] as string[]]));
  const outstandingDependencies = new Map(graph.tasks.map((task) => [task.taskId, 0]));
  if (tasks.size !== graph.tasks.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "Task IDs must be unique" });
  }
  const terminals = new Set(graph.terminalTaskIds);
  if (terminals.size !== graph.terminalTaskIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds"], message: "Terminal task IDs must be unique" });
  }
  for (const [index, task] of graph.tasks.entries()) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "dependsOn"], message: `Task ${task.taskId} has duplicate dependencies` });
    }
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "dependsOn"], message: `Task ${task.taskId} depends on unknown task ${dependency}` });
      } else if (dependency === task.taskId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "dependsOn"], message: `Task ${task.taskId} cannot depend on itself` });
      } else {
        dependents.set(dependency, (dependents.get(dependency) ?? 0) + 1);
        downstreamTasks.get(dependency)?.push(task.taskId);
        outstandingDependencies.set(task.taskId, (outstandingDependencies.get(task.taskId) ?? 0) + 1);
      }
    }
  }
  for (const [index, terminalId] of graph.terminalTaskIds.entries()) {
    if (!tasks.has(terminalId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds", index], message: `Unknown terminal task ${terminalId}` });
    }
  }
  const ready = [...outstandingDependencies].filter(([, count]) => count === 0).map(([taskId]) => taskId);
  let processed = 0;
  for (let index = 0; index < ready.length; index++) {
    const taskId = ready[index]!;
    processed++;
    for (const downstream of downstreamTasks.get(taskId) ?? []) {
      const remaining = (outstandingDependencies.get(downstream) ?? 0) - 1;
      outstandingDependencies.set(downstream, remaining);
      if (remaining === 0) ready.push(downstream);
    }
  }
  if (processed !== tasks.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "Task graph contains a dependency cycle" });
  }
  for (const taskId of tasks.keys()) {
    const downstream = dependents.get(taskId) ?? 0;
    if (downstream === 0 && !terminals.has(taskId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds"], message: `Final task ${taskId} is not declared terminal` });
    }
    if (downstream > 0 && terminals.has(taskId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds"], message: `Terminal task ${taskId} still has dependents` });
    }
  }
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const MissionPlanSchema = z.object({
  planId: z.string().min(1),
  version: z.string().min(1),
  generatedBy: z.string().min(1),
  graph: TaskGraphSchema,
  successCriteria: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  planning: PlanningQualitySchema.optional(),
  level: TestLevelSchema.default("core"),
  executionProfile: MissionExecutionProfileSchema.default({
    surfaceMatrix: ["web"],
    negativeCases: [],
    declaredNegativeCases: [],
    requireBusinessOracle: false,
    requireReplay: false,
    requireNegativeCases: false,
    minimumEvidence: 1,
  }),
  createdAt: z.string(),
});
/** Existing persisted plans may omit planning metadata. New plans populate it explicitly. */
export type MissionPlan = z.infer<typeof MissionPlanSchema>;

/** Bounded, presentation-safe Mission plan facts for reports and MCP consumers. */
export const MissionPlanSummarySchema = z.object({
  planId: z.string().min(1),
  generatedBy: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).max(50),
  assumptions: z.array(z.string().min(1)).max(50),
  tasks: z.array(z.object({
    taskId: z.string().min(1),
    title: z.string().min(1),
    objective: z.string().min(1),
    tool: z.string().min(1),
    dependsOn: z.array(z.string()).max(100),
    status: MissionTaskStatusSchema,
    error: z.string().optional(),
  }).strict()).max(100),
}).strict();
export type MissionPlanSummary = z.infer<typeof MissionPlanSummarySchema>;

export const MissionSessionContextSchema = z.object({
  sessionId: z.string().uuid(),
  captureRunId: z.string().regex(/^session-network-[a-f0-9-]{36}$/).optional(),
  capturedAt: z.string().datetime(),
  runs: z.array(z.object({
    runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    startedAt: z.string(),
    evidence: z.array(EvidenceRefSchema).max(4),
  }).strict()).max(20),
  omittedRuns: z.number().int().nonnegative(),
}).strict();
export type MissionSessionContext = z.infer<typeof MissionSessionContextSchema>;

export const SessionCaptureSummarySchema = z.object({
  runId: z.string().regex(/^session-network-[a-f0-9-]{36}$/),
  status: z.enum(["sealed", "partial", "unavailable"]),
  closed: z.literal(true),
  events: z.number().int().nonnegative(),
  omittedEvents: z.number().int().nonnegative(),
  unresolvedRequests: z.number().int().nonnegative(),
  networkEnabled: z.boolean(),
  recording: RunRecordingSchema.optional(),
}).strict().refine((capture) => capture.status !== "sealed" || !capture.recording || (capture.recording.status === "recorded"
  && !capture.recording.selectedPages?.omitted), "A sealed capture cannot have an incomplete recording");
export type SessionCaptureSummary = z.infer<typeof SessionCaptureSummarySchema>;

export const SessionCaptureSealSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^session-network-[a-f0-9-]{36}$/),
  sessionId: z.string().uuid(),
  projectRoot: z.string().min(1).max(4096),
  workspaceRoot: z.string().min(1).max(4096),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const MissionSessionCapturesSchema = z.object({
  segments: z.array(z.object({
    runId: z.string().regex(/^session-network-[a-f0-9-]{36}$/),
    sessionId: z.string().uuid(),
    integrity: z.enum(["intact", "changed", "missing", "unverified", "not-sealed"]),
    reason: z.string().min(1).max(1024),
    capture: SessionCaptureSummarySchema.optional(),
    evidence: z.array(EvidenceRefSchema).max(22),
  }).strict()).max(10),
  omittedSegments: z.number().int().nonnegative(),
}).strict();

export const TestMissionSchema = z.object({
  missionId: z.string().min(1),
  /** The direct source Mission when this Mission was created by replay. */
  replayOfMissionId: z.string().min(1).optional(),
  /** A deterministic slot in a persisted repeat series; slot zero is its pre-existing baseline. */
  repeatSeries: z.object({ seriesId: z.string().regex(/^repeat-[a-f0-9]{12}$/), ordinal: z.number().int().min(1).max(4) }).optional(),
  intent: z.string().min(1),
  projectRoot: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
  surface: MissionSurfaceSchema,
  level: TestLevelSchema.default("core"),
  levelSelection: TestLevelSelectionSchema.optional(),
  policy: MissionPolicySchema,
  status: MissionStatusSchema,
  verdict: VerdictSchema.optional(),
  charter: TestCharterSchema.optional(),
  suite: TestSuiteSchema.optional(),
  /** Frozen workspace declaration and diagnostic state for a project-scope request. */
  workflowInventory: WorkflowInventorySchema.optional(),
  workflowInventoryInspection: WorkflowInventoryInspectionSchema.optional(),
  workflowReview: WorkflowReviewSnapshotSchema.optional(),
  workflowReviewAdmission: WorkflowReviewAdmissionSchema.optional(),
  /** Process-local retained Web session selected for this Mission; missing after restart must block, not fall back. */
  surfaceSessionId: z.string().uuid().optional(),
  sessionContext: MissionSessionContextSchema.optional(),
  plan: MissionPlanSchema,
  agentSteps: z.array(AgentStepSchema).default([]),
  toolCalls: z.array(ToolCallSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  firstFailure: FailureBoundarySchema.optional(),
  /** All saved scenario diagnoses; singular diagnosis remains the Mission headline. */
  diagnoses: z.array(DiagnosisSchema).default([]),
  diagnosis: DiagnosisSchema.optional(),
  repairSuggestions: z.array(RepairSuggestionSchema).default([]),
  currentTaskId: z.string().optional(),
  /** First execution window; approval wait does not count toward the Mission deadline. */
  executionStartedAt: z.string().datetime().optional(),
  executionDeadlineAt: z.string().datetime().optional(),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestMission = z.infer<typeof TestMissionSchema>;

/** Immutable request. Progress is reconstructed from deterministic Mission slots after a process restart. */
export const MissionRepeatSeriesSchema = z.object({
  seriesId: z.string().regex(/^repeat-[a-f0-9]{12}$/),
  baselineMissionId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  projectRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  targetSamples: z.number().int().min(3).max(5),
  createdAt: z.string().datetime(),
});
export type MissionRepeatSeries = z.infer<typeof MissionRepeatSeriesSchema>;

export const MissionComparisonRunSchema = z.object({
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]),
  runKind: z.enum(["primary", "replay", "negative"]),
  negativeCaseId: z.string().optional(),
  baselineRunId: z.string().optional(),
  candidateRunId: z.string().optional(),
  baselineVerdict: VerdictSchema.optional(),
  candidateVerdict: VerdictSchema.optional(),
  baselineBusinessFacts: z.number().int().nonnegative(),
  candidateBusinessFacts: z.number().int().nonnegative(),
  baselineEvidence: z.array(EvidenceRefSchema).default([]),
  candidateEvidence: z.array(EvidenceRefSchema).default([]),
});
export type MissionComparisonRun = z.infer<typeof MissionComparisonRunSchema>;

export const MissionComparisonDefectSchema = z.object({
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]),
  oracleName: z.string().min(1),
  baselineRunId: z.string().min(1),
  candidateRunId: z.string().optional(),
  outcome: z.enum(["not-reproduced", "reproduced", "unverified"]),
  baselineEvidence: z.array(EvidenceRefSchema).min(1),
  candidateEvidence: z.array(EvidenceRefSchema).default([]),
});
export type MissionComparisonDefect = z.infer<typeof MissionComparisonDefectSchema>;

/** A comparison is a scoped observation, never proof of which source edit caused the change. */
export const MissionComparisonSchema = z.object({
  baselineMissionId: z.string().min(1),
  candidateMissionId: z.string().min(1),
  baselineVerdict: VerdictSchema.optional(),
  candidateVerdict: VerdictSchema.optional(),
  baselineScopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidateScopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopeMatched: z.boolean(),
  baselineSourceState: SourceStateSchema.optional(),
  candidateSourceState: SourceStateSchema.optional(),
  candidateFinalSourceState: SourceStateSchema.optional(),
  candidateCurrentSourceState: SourceStateSchema.optional(),
  candidateSourceFreshness: z.enum(["matching", "changed", "unavailable", "unverified"]).optional(),
  sourceChange: z.enum(["changed", "unchanged", "unknown"]),
  baselineSourceStability: z.enum(["stable", "changed-during-run", "unknown"]).optional(),
  candidateSourceStability: z.enum(["stable", "changed-during-run", "unknown"]),
  status: z.enum(["verified-in-scope", "defect-reproduced", "inconclusive"]),
  /** The saved-fact comparison before a current-source recheck withdrew its claim. */
  historicalStatus: z.enum(["verified-in-scope", "defect-reproduced", "inconclusive"]).optional(),
  reason: z.string().min(1),
  gaps: z.array(z.string()),
  runs: z.array(MissionComparisonRunSchema),
  omittedRuns: z.number().int().nonnegative(),
  defects: z.array(MissionComparisonDefectSchema),
  omittedDefects: z.number().int().nonnegative(),
  comparedAt: z.string(),
});
export type MissionComparison = z.infer<typeof MissionComparisonSchema>;

/** A bounded presentation of saved Mission facts, never a second verdict reducer. */
export const MissionRunResultSchema = z.object({
  taskId: z.string().optional(),
  charterId: CatalogIdSchema.optional(),
  title: z.string().min(1),
  surface: MissionSurfaceSchema.optional(),
  runKind: z.enum(["primary", "replay", "negative", "unknown"]),
  negativeCaseId: z.string().optional(),
  taskStatus: MissionTaskStatusSchema.optional(),
  runId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  /** Raw surface verdict; an expected failure is not a product defect. */
  verdict: VerdictSchema.optional(),
  expectedVerdict: VerdictSchema.optional(),
  outcomeMatched: z.boolean().optional(),
  executionVisibility: z.enum(["headful", "headless", "external"]).optional(),
  executionSessionId: z.string().uuid().optional(),
  assertions: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  oracles: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  businessFacts: z.number().int().nonnegative().optional(),
  targetBinding: TargetBindingSchema.optional(),
  targetBindingAfterRun: TargetBindingSchema.optional(),
  targetContinuity: TargetContinuitySchema.optional(),
  applicationBinding: TargetBindingSchema.optional(),
  applicationBindingAfterRun: TargetBindingSchema.optional(),
  applicationContinuity: TargetContinuitySchema.optional(),
  integrationPostRunCheck: IntegrationCheckResultSchema.optional(),
  integrationCleanup: IntegrationCleanupSchema.optional(),
  evidence: z.array(EvidenceRefSchema).max(8),
  omittedEvidence: z.number().int().nonnegative(),
  issue: z.string().optional(),
});
export type MissionRunResult = z.infer<typeof MissionRunResultSchema>;

/** Saved primary/replay verdict agreement; divergence alone does not establish flakiness. */
export const ReplayConsistencySchema = z.object({
  status: z.enum(["agree", "diverge", "unverified"]),
  expectedPairs: z.number().int().nonnegative(),
  comparedPairs: z.number().int().nonnegative(),
  divergentPairs: z.number().int().nonnegative(),
  unverifiedPairs: z.number().int().nonnegative(),
  pairs: z.array(z.object({
    charterId: CatalogIdSchema.optional(),
    surface: MissionSurfaceSchema,
    primaryRunId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
    replayRunId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
    primaryVerdict: VerdictSchema.optional(),
    replayVerdict: VerdictSchema.optional(),
    agreement: z.enum(["agree", "diverge", "unverified"]),
  })).max(20),
  omittedPairs: z.number().int().nonnegative(),
});
export type ReplayConsistency = z.infer<typeof ReplayConsistencySchema>;

/** A bounded, re-audited sequence of the same Mission scope. Variable outcomes are an investigation signal, not a diagnosed flaky test. */
export const MissionStabilityAnalysisSchema = z.object({
  status: z.enum(["uniform-pass", "uniform-failure", "variable-outcome", "inconclusive"]),
  missionIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(3).max(5),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHeadSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  sourceWorktreeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  passes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  samples: z.array(z.object({
    missionId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    replayOfMissionId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
    testVerdict: z.union([VerdictSchema, z.literal("not-asserted")]),
    expectedRuns: z.number().int().nonnegative(),
    observedRuns: z.number().int().nonnegative(),
    evidence: z.array(EvidenceRefSchema).max(4),
  })).min(3).max(5),
  gaps: z.array(z.string().min(1)).max(20),
  omittedGaps: z.number().int().nonnegative(),
  checkedAt: z.string().datetime(),
});
export type MissionStabilityAnalysis = z.infer<typeof MissionStabilityAnalysisSchema>;

export const MissionRepeatSeriesStatusSchema = z.object({
  series: MissionRepeatSeriesSchema,
  state: z.enum(["ready", "running", "awaiting-approval", "inconclusive", "complete"]),
  missionIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1).max(5),
  currentMissionId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  nextOrdinal: z.number().int().min(1).max(4).optional(),
  requiresApproval: z.boolean().optional(),
  reason: z.string().optional(),
  analysis: MissionStabilityAnalysisSchema.optional(),
});
export type MissionRepeatSeriesStatus = z.infer<typeof MissionRepeatSeriesStatusSchema>;

/** Current readability of the bounded Mission presentation, separate from its saved acceptance verdict. */
export const MissionEvidenceIntegritySchema = z.object({
  status: z.enum(["intact", "degraded", "partial", "no-evidence"]),
  scope: z.literal("presented-result"),
  checkedAt: z.string().datetime(),
  references: z.object({
    total: z.number().int().nonnegative(),
    intact: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    legacy: z.number().int().nonnegative(),
  }),
  visibleConfirmedFindings: z.object({
    saved: z.number().int().nonnegative(),
    supported: z.number().int().nonnegative(),
    unsupportedFindingIds: z.array(z.string()).max(20),
  }),
  diagnosticSupport: z.object({
    diagnosis: z.object({
      status: z.enum(["not-present", "supported", "unsupported"]),
      reason: z.enum(["missing-evidence", "unavailable-evidence", "cross-run-evidence", "run-not-present", "unlinked-failure"]).optional(),
    }),
    diagnoses: z.array(z.object({
      diagnosisId: z.string().min(1),
      status: z.enum(["supported", "unsupported"]),
      reason: z.enum(["missing-evidence", "unavailable-evidence", "cross-run-evidence", "run-not-present", "unlinked-failure"]).optional(),
    })).max(10).default([]),
    repairSuggestions: z.array(z.object({
      suggestionId: z.string().min(1),
      status: z.enum(["supported", "unsupported"]),
      reason: z.enum(["missing-evidence", "unavailable-evidence", "cross-run-evidence", "run-not-present", "unlinked-failure"]).optional(),
    })).max(10),
  }).optional(),
  comparison: z.enum(["not-present", "intact", "degraded"]),
  omittedEvidenceReferences: z.number().int().nonnegative(),
  omittedRunResults: z.number().int().nonnegative(),
  omittedFindings: z.number().int().nonnegative(),
  omittedDiagnoses: z.number().int().nonnegative().default(0),
  omittedRepairSuggestions: z.number().int().nonnegative(),
  omittedComparisonRuns: z.number().int().nonnegative(),
  omittedComparisonDefects: z.number().int().nonnegative(),
});
export type MissionEvidenceIntegrity = z.infer<typeof MissionEvidenceIntegritySchema>;

/** Current readability of all Mission acceptance references, bounded independently of the compact report. */
export const MissionAcceptanceIntegritySchema = z.object({
  status: z.enum(["intact", "degraded", "partial", "no-evidence"]),
  scope: z.literal("mission-evidence"),
  checkedAt: z.string().datetime(),
  references: z.object({
    total: z.number().int().nonnegative(),
    intact: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    legacy: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
  }),
});
export type MissionAcceptanceIntegrity = z.infer<typeof MissionAcceptanceIntegritySchema>;

/** Current classification of saved Oracle results; this does not rewrite a historical verdict. */
export const MissionProofClassificationSchema = z.object({
  status: z.enum(["explicit", "unverified", "not-applicable"]),
  checkedRuns: z.number().int().nonnegative(),
  classifiedOracles: z.number().int().nonnegative(),
  businessOracles: z.number().int().nonnegative().optional(),
  passedBusinessOracles: z.number().int().nonnegative().optional(),
  failedBusinessOracles: z.number().int().nonnegative().optional(),
  httpContractOracles: z.number().int().nonnegative().optional(),
  requiredBusinessRuns: z.number().int().nonnegative().optional(),
  requiredRunsWithPassingBusiness: z.number().int().nonnegative().optional(),
  confirmedProductFindings: z.number().int().nonnegative().optional(),
  findingsLinkedToFailingBusiness: z.number().int().nonnegative().optional(),
  unlinkedFindingIds: z.array(z.string()).max(10).optional(),
  omittedUnlinkedFindingIds: z.number().int().nonnegative().optional(),
  legacyOracles: z.number().int().nonnegative(),
  unavailableRuns: z.number().int().nonnegative(),
  omittedRuns: z.number().int().nonnegative(),
  legacyRunIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(10),
  unavailableRunIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(10),
});
export type MissionProofClassification = z.infer<typeof MissionProofClassificationSchema>;

/** Recomputed from the saved task graph and Run observations, without trusting the saved verdict. */
export const MissionExecutionAuditSchema = z.object({
  status: z.enum(["complete", "incomplete"]),
  /** A failure can leave later declared slots unexecuted; only observed Runs are certified. */
  scope: z.enum(["acceptance", "observed-failure"]).default("acceptance"),
  expectedSlots: z.number().int().nonnegative(),
  matchedSlots: z.number().int().nonnegative(),
  unexecutedSlots: z.number().int().nonnegative().default(0),
  unexpectedObservations: z.number().int().nonnegative(),
  issues: z.array(z.string().min(1)).max(20),
  omittedIssues: z.number().int().nonnegative(),
});
export type MissionExecutionAudit = z.infer<typeof MissionExecutionAuditSchema>;

/** Recomputed from the persisted AgentStep -> ToolCall -> Observation chain. */
export const MissionAgentTraceAuditSchema = z.object({
  status: z.enum(["complete", "incomplete", "unverified"]),
  checkedSteps: z.number().int().nonnegative(),
  checkedCalls: z.number().int().nonnegative(),
  checkedObservations: z.number().int().nonnegative(),
  issues: z.array(z.string().min(1)).max(20),
  omittedIssues: z.number().int().nonnegative(),
});
export type MissionAgentTraceAudit = z.infer<typeof MissionAgentTraceAuditSchema>;

export const MissionCheckOverviewSchema = z.object({
  scope: z.literal("saved-run-checks"),
  inspectedRuns: z.number().int().nonnegative(),
  unavailableRuns: z.array(z.object({ runId: z.string().optional(), title: z.string().max(256) }).strict()).max(200),
  omittedRuns: z.number().int().nonnegative(),
  counts: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(), "not-recorded": z.number().int().nonnegative(), unverified: z.number().int().nonnegative() }).strict(),
  items: z.array(z.object({
    runId: z.string(), title: z.string().max(256), runKind: z.enum(["primary", "replay", "negative", "unknown"]),
    kind: z.enum(["surface", "business", "http-contract", "unclassified"]),
    status: z.enum(["passed", "failed", "inconclusive", "not-recorded", "unverified"]),
    expected: z.string().max(256), observed: z.string().max(256),
    fieldMismatches: z.array(z.string().max(80)).max(8).optional(),
    summary: EvidenceRefSchema, report: EvidenceRefSchema.optional(),
    evidence: z.array(EvidenceRefSchema).max(3).default([]),
    unlinkedEvidence: z.number().int().nonnegative().default(0),
  }).strict()).max(100),
  omittedChecks: z.number().int().nonnegative(),
}).strict();
export type MissionCheckOverview = z.infer<typeof MissionCheckOverviewSchema>;

export const MissionResultSchema = z.object({
  schemaVersion: z.literal("1"),
  missionId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  replayOfMissionId: z.string().optional(),
  projectRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  intent: z.string().min(1),
  status: MissionStatusSchema,
  running: z.boolean(),
  verdict: VerdictSchema.optional(),
  /** Current audited claim; verdict above remains the saved historical result. */
  testVerdict: z.union([VerdictSchema, z.literal("not-asserted")]).optional(),
  testVerdictReason: z.string().optional(),
  level: TestLevelSchema,
  levelSelection: TestLevelSelectionSchema.optional(),
  executionProfile: MissionExecutionProfileSchema.optional(),
  planSummary: MissionPlanSummarySchema.optional(),
  planningObservation: z.object({
    observation: PlanningSurfaceObservationSchema,
    status: z.enum(["verified", "unverified", "caller-supplied"]),
    reason: z.string().min(1),
    evidence: z.array(EvidenceRefSchema).max(30),
  }).strict().optional(),
  sessionContext: MissionSessionContextSchema.optional(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  generatedAt: z.string(),
  sessionCaptures: MissionSessionCapturesSchema.optional(),
  planning: PlanningQualitySchema.optional(),
  scope: z.object({
    surfaces: z.array(MissionSurfaceSchema),
    charterCount: z.number().int().nonnegative(),
    /** Compare complete Git fingerprints captured before and after this Mission. */
    sourceStability: z.enum(["stable", "changed", "unverified"]).optional(),
    /** Compare the final tested Git fingerprint with a fresh read when this result was opened. */
    sourceFreshness: z.enum(["matching", "changed", "unavailable", "unverified"]).optional(),
    currentSourceState: SourceStateSchema.optional(),
    suiteId: CatalogIdSchema.optional(),
    uncoveredCharterIds: z.array(CatalogIdSchema),
    workflowInventory: WorkflowInventoryInspectionSchema.optional(),
    workflowExecution: WorkflowExecutionCoverageSchema.optional(),
    workflowReviewAudit: WorkflowReviewAuditSchema.optional(),
    routeCoverage: z.object({
      inventoryTruncated: z.boolean(),
      candidateRoutes: z.number().int().nonnegative(),
      mappedCandidates: z.number().int().nonnegative(),
      observedCandidates: z.number().int().nonnegative(),
      gapCount: z.number().int().nonnegative(),
      unresolvedTargetCount: z.number().int().nonnegative(),
    }).optional(),
  }),
  tasks: z.object({
    total: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  expectedRuns: z.number().int().nonnegative(),
  observedRuns: z.number().int().nonnegative(),
  checkOverview: MissionCheckOverviewSchema.optional(),
  executionAudit: MissionExecutionAuditSchema.optional(),
  agentTraceAudit: MissionAgentTraceAuditSchema.optional(),
  runs: z.array(MissionRunResultSchema).max(200),
  omittedRunResults: z.number().int().nonnegative(),
  replayConsistency: ReplayConsistencySchema.optional(),
  findings: z.array(FindingSchema).max(20),
  omittedFindings: z.number().int().nonnegative(),
  confirmedProductFindings: z.number().int().nonnegative(),
  evidenceIntegrity: MissionEvidenceIntegritySchema.optional(),
  acceptanceEvidenceIntegrity: MissionAcceptanceIntegritySchema.optional(),
  proofClassification: MissionProofClassificationSchema.optional(),
  firstFailure: FailureBoundarySchema.optional(),
  diagnosis: DiagnosisSchema.optional(),
  diagnoses: z.array(DiagnosisSchema).max(10).default([]),
  omittedDiagnoses: z.number().int().nonnegative().default(0),
  repairSuggestions: z.array(RepairSuggestionSchema).max(10),
  /** Fresh source-reference checks for visible host hypotheses; independent of the product verdict. */
  repairSourceAudits: z.array(RepairSourceAuditSchema).max(10).optional(),
  omittedRepairSuggestions: z.number().int().nonnegative(),
  comparison: MissionComparisonSchema.optional(),
  comparisonUnavailable: z.string().optional(),
});
export type MissionResult = z.infer<typeof MissionResultSchema>;
