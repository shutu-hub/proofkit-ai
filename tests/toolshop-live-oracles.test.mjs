import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceAcceptance } from "./toolshop-live-oracles.mjs";

const billing = { street: "ProofKit Demo Street", city: "San Francisco", state: "California", country: "US", postal_code: "94105" };
const items = [{ id: "product-1", quantity: 2 }, { id: "product-2", quantity: 1 }];
const record = { id: "invoice-1", invoice_number: "INV-1", total: 40.88, invoicelines: items.map((item) => ({ product_id: item.id, quantity: item.quantity })),
  ...Object.fromEntries(Object.entries(billing).map(([field, value]) => ["billing_" + field, value])) };
const expectedRequest = { cartId: "cart-1", paymentMethod: "cash-on-delivery" };
const captured = { fields: { invoiceId: "invoice-1", invoiceNumber: "INV-1", total: 40.88 }, requestFields: { ...billing, cartId: "cart-1", method: "cash-on-delivery" } };

test("independent invoice acceptance checks identity, exact product set, quantity, total and every requested billing field", () => {
  assert.equal(invoiceAcceptance(record, captured, items, 40.88, billing, expectedRequest).passed, true);
  for (const changed of [{ ...record, id: "another-invoice" }, { ...record, total: 41 },
    { ...record, invoicelines: [record.invoicelines[0]] }, { ...record, invoicelines: [{ product_id: "product-1", quantity: 3 }, record.invoicelines[1]] }]) {
    assert.equal(invoiceAcceptance(changed, captured, items, 40.88, billing, expectedRequest).passed, false);
  }
});
test("matching totals and items cannot hide asynchronously overwritten billing fields", () => {
  const changed = { ...record, billing_street: "Saved profile street", billing_city: "Saved profile city" };
  const result = invoiceAcceptance(changed, { ...captured, requestFields: { ...captured.requestFields, street: changed.billing_street, city: changed.billing_city } }, items, 40.88, billing, expectedRequest);
  assert.equal(result.passed, false); assert.equal(result.matchedItems, 2); assert.equal(result.totalMatches, true);
  assert.deepEqual(result.billingMismatches, ["street", "city"]);
  assert.throws(() => invoiceAcceptance(record, captured, items, 40.88, undefined), /expected billing/);
});
test("correct final records cannot hide a different submitted cart, payment method or response total", () => {
  for (const changed of [
    { ...captured, requestFields: { ...captured.requestFields, cartId: "another-cart" } },
    { ...captured, requestFields: { ...captured.requestFields, method: "credit-card" } },
    { ...captured, fields: { ...captured.fields, total: 1 } },
  ]) assert.equal(invoiceAcceptance(record, changed, items, 40.88, billing, expectedRequest).passed, false);
  assert.equal(invoiceAcceptance(record, captured, items, 40.88, billing).passed, false);
});
