import assert from "node:assert/strict";
import test from "node:test";
import { bookingAcceptance, expectedBooking } from "./booker-live-oracles.mjs";

const expected = { roomId: 1, firstName: "Proofkit", lastName: "CrossSiteOctober", email: "booker@example.invalid", contactNumber: "00000000000",
  depositPaid: false, checkIn: "2026-11-10", checkOut: "2026-11-12" };
const body = { bookingid: 123, roomid: 1, firstname: expected.firstName, lastname: expected.lastName, email: expected.email,
  phone: expected.contactNumber, depositpaid: false, bookingdates: { checkin: expected.checkIn, checkout: expected.checkOut } };
const capture = () => ({ fields: { bookingId: "123", ...expected }, requestFields: { ...expected } });
test("independent booking acceptance requires identity, dates and every reviewed field on all three sides", () => {
  assert.equal(bookingAcceptance(body, capture(), expected).passed, true);
  for (const key of Object.keys(expected)) {
    const captured = capture(); captured.requestFields[key] = key === "depositPaid" ? true : "changed";
    assert.equal(bookingAcceptance(body, captured, expected).passed, false);
    const changed = capture(); changed.fields[key] = key === "depositPaid" ? true : "changed";
    assert.equal(bookingAcceptance(body, changed, expected).passed, false);
  }
  assert.equal(bookingAcceptance({ ...body, bookingid: 124 }, capture(), expected).passed, false);
  assert.equal(bookingAcceptance({ ...body, bookingdates: { ...body.bookingdates, checkout: "2026-11-13" } }, capture(), expected).passed, false);
  assert.equal(bookingAcceptance({ ...body, firstname: "OtherGuest" }, capture(), expected).passed, false);
});
test("matching response and backend cannot hide a checkout date outside the original intent", () => {
  const captured = capture(); captured.fields.checkOut = "2026-11-13"; captured.requestFields.checkOut = "2026-11-13";
  const result = bookingAcceptance({ ...body, bookingdates: { checkin: expected.checkIn, checkout: "2026-11-13" } }, captured, expected);
  assert.equal(result.passed, false); assert.deepEqual(result.mismatches, ["checkOut"]);
});
test("missing independent contact fields cannot become either a pass or an invented business mismatch", () => {
  const { email, phone, ...withoutContact } = body;
  const result = bookingAcceptance(withoutContact, capture(), expected);
  assert.equal(result.passed, null); assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.missingIndependentFields, ["email", "contactNumber"]);
  const identityOnly = capture(); identityOnly.fields = { bookingId: "123" };
  assert.equal(bookingAcceptance(withoutContact, identityOnly, expected).passed, null);
});
test("expected booking requires all fields and ordered dates before execution", () => {
  assert.deepEqual(expectedBooking({ metadata: { expectedBooking: JSON.stringify(expected) } }), expected);
  for (const change of [{ checkOut: expected.checkIn }, { roomId: 0 }, { email: undefined }, { depositPaid: undefined }]) {
    assert.throws(() => expectedBooking({ metadata: { expectedBooking: JSON.stringify({ ...expected, ...change }) } }));
  }
});
