import original, { expectedBooking } from "./booker-live-oracles.mjs";

const fields = { roomId: ["roomid"], firstName: ["firstname"], lastName: ["lastname"], email: ["email"], contactNumber: ["phone"],
  depositPaid: ["depositpaid"], checkIn: ["bookingdates", "checkin"], checkOut: ["bookingdates", "checkout"] };
export function bookingObservability(charter, sample) {
  const expected = expectedBooking(charter);
  const missingFields = [], invalidFields = [];
  for (const [name, path] of Object.entries(fields)) {
    let value = sample;
    for (const segment of path) value = value && typeof value === "object" && Object.hasOwn(value, segment) ? value[segment] : undefined;
    if (value === undefined) missingFields.push(name);
    else if (typeof value !== typeof expected[name] || typeof value === "number" && !Number.isFinite(value)) invalidFields.push(name);
  }
  return { passed: missingFields.length === 0 && invalidFields.length === 0, missingFields, invalidFields };
}

export function createBookerReadinessIntegration(options = {}) {
  const origin = new URL(options.origin ?? "https://automationintesting.online").origin;
  const request = async (path, signal, init = {}) => {
    const response = await fetch(origin + path, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    options.observeRequest?.({ method: init.method ?? "GET", path, status: response.status });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 65536) throw new Error("Readiness sample exceeds its accepted size");
    return { status: response.status, body: bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined };
  };
  const check = async ({ charter, signal }) => {
    if (!charter.oracles?.includes("booker-current-booking")) return { passed: true, message: "No booking business verification requested", evidence: { bookingCheckRequested: false } };
    expectedBooking(charter);
    const bookingId = charter.metadata.readinessBookingId;
    if (typeof bookingId !== "string" || !/^[1-9]\d{0,9}$/.test(bookingId)) return { passed: false,
      message: "Declare an existing synthetic booking observation fixture before any product write", evidence: { observationFixtureDeclared: false },
      issues: [{ code: "observation-fixture-required", guidance: "Provide a reviewed existing synthetic readinessBookingId; do not create a booking just to make this check pass." }] };
    const auth = await request("/api/auth/login", signal, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: options.username ?? process.env.PROOFKIT_BOOKER_USERNAME ?? "admin",
        password: options.password ?? process.env.PROOFKIT_BOOKER_PASSWORD ?? "password" }) });
    if (auth.status !== 200 || typeof auth.body?.token !== "string" || !/^[A-Za-z0-9._~-]{1,2048}$/.test(auth.body.token)) throw new Error("Readiness sample authentication unavailable");
    signal.throwIfAborted();
    const observed = await request("/api/booking/" + bookingId, signal, { headers: { cookie: "token=" + auth.body.token } });
    if (observed.status !== 200) throw new Error("Declared observation fixture unavailable");
    const assessment = bookingObservability(charter, observed.body);
    return { passed: assessment.passed,
      message: assessment.passed ? "The declared sample exposes the required field types; this is not current booking acceptance or POST schema verification"
        : "Required independent field observations are unavailable in the declared sample: " + [...assessment.missingFields, ...assessment.invalidFields].join(", "),
      evidence: { observationFixtureDeclared: true, sampleReadStatus: observed.status, requiredFields: Object.keys(fields).length,
        missingFields: assessment.missingFields.join(","), invalidFields: assessment.invalidFields.join(","), responseSchemaVerified: false,
        scope: "One explicitly selected existing demo record; no product writes and no source/deployment identity claim" },
      issues: assessment.passed ? undefined : [{ code: "independent-fields-unavailable",
        guidance: "Keep all expected booking fields. Provide independent observations for missing or invalid fields before submitting a new booking; the sample is not POST schema proof." }] };
  };
  return { ...original, name: "booker-observability-readiness", readiness: check, preflight: check };
}
export default createBookerReadinessIntegration();
