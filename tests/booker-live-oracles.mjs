import { createHash } from "node:crypto";

const origin = "https://automationintesting.online";
const keys = ["roomId", "firstName", "lastName", "email", "contactNumber", "depositPaid", "checkIn", "checkOut"];
export function expectedBooking(charter) {
  const value = JSON.parse(charter.metadata.expectedBooking ?? "null");
  if (!value || !Number.isSafeInteger(value.roomId) || value.roomId < 1 || typeof value.depositPaid !== "boolean"
    || keys.filter((key) => !["roomId", "depositPaid"].includes(key)).some((key) => typeof value[key] !== "string" || !value[key] || value[key].length > 128)
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(value.checkOut) || value.checkOut <= value.checkIn) {
    throw new Error("Specify the reviewed room, guest, contact, deposit and stay dates before execution");
  }
  return value;
}
function projectBooking(body) {
  return { roomId: body.roomid, firstName: body.firstname, lastName: body.lastname, email: body.email, contactNumber: body.phone,
    depositPaid: body.depositpaid, checkIn: body.bookingdates?.checkin, checkOut: body.bookingdates?.checkout };
}
export function bookingAcceptance(body, captured, expected) {
  const observed = projectBooking(body);
  const missingIndependentFields = keys.filter((key) => observed[key] === undefined);
  const mismatches = keys.filter((key) => observed[key] !== undefined && observed[key] !== expected[key]
    || captured.requestFields?.[key] !== expected[key]
    || captured.fields[key] !== undefined && captured.fields[key] !== expected[key]);
  const identityMatches = String(body.bookingid) === captured.fields.bookingId && /^[1-9]\d{0,9}$/.test(captured.fields.bookingId ?? "");
  return { passed: !identityMatches || mismatches.length ? false : missingIndependentFields.length ? null : true, identityMatches, mismatches, missingIndependentFields,
    observedDates: { checkIn: observed.checkIn, checkOut: observed.checkOut },
    submittedDates: { checkIn: captured.requestFields?.checkIn, checkOut: captured.requestFields?.checkOut },
    responseDates: { checkIn: captured.fields.checkIn, checkOut: captured.fields.checkOut } };
}
async function acquire(path, options = {}) {
  const response = await fetch(origin + path, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 65536) throw new Error("Independent response exceeds its accepted size");
  return { response, bytes };
}
async function authenticate() {
  const { response, bytes } = await acquire("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: process.env.PROOFKIT_BOOKER_USERNAME ?? "admin", password: process.env.PROOFKIT_BOOKER_PASSWORD ?? "password" }) });
  let cookie = response.headers.getSetCookie().find((value) => /^token=/.test(value))?.split(";", 1)[0];
  if (!cookie && response.ok && bytes.length > 0) {
    const value = JSON.parse(bytes.toString("utf8")).token;
    if (typeof value === "string" && /^[A-Za-z0-9._~-]{1,2048}$/.test(value)) cookie = "token=" + value;
  }
  if (!response.ok || !cookie || cookie.length > 4096 || /[\r\n]/.test(cookie)) throw new Error("Independent demo authentication unavailable");
  return cookie;
}
function observation(passed, facts) {
  return { name: "booker-current-booking", verificationKind: "business", passed, observedAt: new Date().toISOString(),
    message: "Independent authenticated current-booking GET compared with frozen intent and the same Run's declared request/response fields",
    evidence: [JSON.stringify(facts)] };
}
export async function cleanupOwnedBooking(bookingId, expected) {
  if (!/^[1-9]\d{0,9}$/.test(String(bookingId))) throw new Error("Invalid owned booking identity");
  const cookie = await authenticate();
  const { response, bytes } = await acquire("/api/booking/" + bookingId, { headers: { cookie } });
  if (response.status === 404) return { bookingId: String(bookingId), ownershipVerified: false, deletionAttempted: false,
    readBeforeStatus: 404, passed: true, observedAt: new Date().toISOString(), scope: "Already absent before cleanup; no DELETE sent and absence cause is unproven" };
  if (response.status !== 200) throw new Error("Cannot verify booking ownership before cleanup: " + response.status);
  const body = JSON.parse(bytes.toString("utf8")); const observed = projectBooking(body);
  const ownershipFields = ["roomId", "firstName", "lastName", "checkIn", "checkOut"];
  if (String(body.bookingid) !== String(bookingId) || ownershipFields.some((key) => observed[key] !== expected[key])) throw new Error("Cleanup ownership mismatch");
  const removed = await acquire("/api/booking/" + bookingId, { method: "DELETE", headers: { cookie } });
  if (removed.response.status !== 202) throw new Error("Owned booking cleanup was not accepted");
  const after = await acquire("/api/booking/" + bookingId, { headers: { cookie } });
  return { bookingId: String(bookingId), ownershipVerified: true, deletionStatus: removed.response.status, readAfterStatus: after.response.status,
    passed: after.response.status === 404, observedAt: new Date().toISOString() };
}
const oracle = { name: "booker-current-booking", async check(context) {
  const captured = context.steps.find((step) => step.response?.name === "booking-created")?.response;
  const bookingId = captured?.fields.bookingId;
  if (typeof bookingId !== "string" || !/^[1-9]\d{0,9}$/.test(bookingId)) return observation(null, { gap: "Current booking identity unavailable" });
  const expected = expectedBooking(context.charter);
  try {
    const cookie = await authenticate();
    const { response, bytes } = await acquire("/api/booking/" + bookingId, { headers: { cookie } });
    if (response.status !== 200) return observation(null, { bookingId, gap: "Independent current booking unavailable", status: response.status });
    const acceptance = bookingAcceptance(JSON.parse(bytes.toString("utf8")), captured, expected);
    return observation(acceptance.passed, { bookingId, ...acceptance, bodyBytes: bytes.length,
      bodySha256: createHash("sha256").update(bytes).digest("hex"), scope: "Current demo booking only; no independent persisted total or deployment/source identity claim" });
  } catch { return observation(null, { bookingId, gap: "Independent authenticated booking observation unavailable" }); }
} };
export default { name: "booker-reviewed-current-record-reader", oracles: [oracle] };
