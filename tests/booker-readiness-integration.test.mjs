import assert from "node:assert/strict";
import test from "node:test";
import { bookingObservability, createBookerReadinessIntegration } from "./booker-readiness-integration.mjs";

const expected = { roomId: 1, firstName: "Proofkit", lastName: "ExpectedGuest", email: "expected@example.invalid", contactNumber: "00000000000",
  depositPaid: false, checkIn: "2026-11-10", checkOut: "2026-11-12" };
const charter = { oracles: ["booker-current-booking"], metadata: { expectedBooking: JSON.stringify(expected) } };
const sample = { roomid: 1, firstname: "Other", lastname: "ExistingFixture", depositpaid: false,
  bookingdates: { checkin: "2026-11-01", checkout: "2026-11-03" } };
test("a sample without independent contact fields does not meet the full observation prerequisites", () => {
  assert.deepEqual(bookingObservability(charter, sample), { passed: false, missingFields: ["email", "contactNumber"], invalidFields: [] });
  assert.deepEqual(bookingObservability(charter, { ...sample, email: "fixture@example.invalid", phone: 1234 }),
    { passed: false, missingFields: [], invalidFields: ["contactNumber"] });
  assert.equal(bookingObservability(charter, { ...sample, email: "fixture@example.invalid", phone: "00000000000" }).passed, true);
});
test("readiness refuses a missing observation fixture without contacting the network", async () => {
  const requests = [];
  const integration = createBookerReadinessIntegration({ origin: "http://127.0.0.1:1", observeRequest: (request) => requests.push(request) });
  const result = await integration.readiness({ charter, signal: AbortSignal.timeout(1000) });
  assert.equal(result.passed, false); assert.equal(result.issues[0].code, "observation-fixture-required"); assert.equal(requests.length, 0);
});
