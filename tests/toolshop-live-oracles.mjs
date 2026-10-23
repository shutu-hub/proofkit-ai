import { createHash } from "node:crypto";

const api = "https://api.practicesoftwaretesting.com";
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
async function readJson(path, options = {}) {
  const response = await fetch(api + path, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Independent endpoint unavailable: " + response.status);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Independent response exceeds bound");
  return { body: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") };
}
function observation(name, passed, facts) {
  return { name, verificationKind: "business", passed, message: "Independent current-record GET after the UI operation; no claim about source/deployment identity",
    observedAt: new Date().toISOString(), evidence: [JSON.stringify(facts)] };
}
function expectedItems(charter) {
  const items = JSON.parse(charter.metadata.expectedItems ?? "null");
  if (!Array.isArray(items) || items.length < 1 || items.length > 4 || new Set(items.map((item) => item.id)).size !== items.length
    || items.some((item) => !identifier.test(item.id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) {
    throw new Error("Specify reviewed product IDs and quantities in expectedItems");
  }
  return items;
}
export function invoiceAcceptance(body, captured, expected, expectedTotal, expectedBilling, expectedRequest) {
  const fields = ["street", "city", "state", "country", "postal_code"];
  if (!expectedBilling || fields.some((field) => typeof expectedBilling[field] !== "string" || !expectedBilling[field] || expectedBilling[field].length > 128)) {
    throw new Error("Invoice acceptance requires reviewed expected billing fields");
  }
  const matched = Array.isArray(body.invoicelines) ? expected.filter((item) => body.invoicelines.some((line) => line.product_id === item.id && line.quantity === item.quantity)).length : 0;
  const totalMatches = Number.isFinite(expectedTotal) && Math.abs(Number(body.total) - expectedTotal) < 0.005;
  const responseTotalMatches = Number.isFinite(captured.fields.total) && Math.abs(captured.fields.total - expectedTotal) < 0.005;
  const requestMatches = typeof expectedRequest?.cartId === "string" && identifier.test(expectedRequest.cartId)
    && expectedRequest.cartId === captured.requestFields?.cartId && typeof expectedRequest.paymentMethod === "string"
    && expectedRequest.paymentMethod === captured.requestFields?.method;
  const billingMismatches = fields.filter((field) => body["billing_" + field] !== expectedBilling[field]
    || captured.requestFields?.[field] !== expectedBilling[field]);
  return { passed: body.id === captured.fields.invoiceId && body.invoice_number === captured.fields.invoiceNumber && matched === expected.length
    && body.invoicelines?.length === expected.length && totalMatches && responseTotalMatches && requestMatches && billingMismatches.length === 0,
  matchedItems: matched, observedItems: body.invoicelines?.length ?? -1, totalMatches, responseTotalMatches, requestMatches, billingMismatches };
}
const cartOracle = { name: "toolshop-current-cart", async check(context) {
  const captured = context.steps.filter((step) => step.response?.name.startsWith("cart-")).at(-1)?.response;
  const cartId = captured?.fields.cartId ?? (captured && new URL(captured.url).pathname.split("/")[2]);
  if (typeof cartId !== "string" || !identifier.test(cartId)) return observation(this.name, null, { gap: "No current captured cart identity" });
  try {
    const expected = expectedItems(context.charter);
    const { body, sha256 } = await readJson("/carts/" + encodeURIComponent(cartId));
    const lines = body.cart_items;
    const matched = Array.isArray(lines) ? expected.filter((item) => lines.some((line) => line.product_id === item.id && line.quantity === item.quantity)).length : 0;
    return observation(this.name, body.id === cartId && lines?.length === expected.length && matched === expected.length,
      { cartId, expectedItems: expected.length, observedItems: lines?.length ?? -1, matchedItems: matched, bodySha256: sha256,
        quantities: Array.isArray(lines) ? lines.map((line) => ({ productId: line.product_id, quantity: line.quantity })) : [] });
  } catch { return observation(this.name, null, { cartId, gap: "Independent cart observation unavailable" }); }
} };
const invoiceOracle = { name: "toolshop-current-invoice", async check(context) {
  const captured = context.steps.find((step) => step.response?.name === "invoice-created")?.response;
  const invoiceId = captured?.fields.invoiceId;
  if (typeof invoiceId !== "string" || !identifier.test(invoiceId)) return observation(this.name, null, { gap: "No current captured invoice identity" });
  try {
    const expected = expectedItems(context.charter);
    const auth = await readJson("/users/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: process.env.PROOFKIT_TOOLSHOP_EMAIL ?? "customer@practicesoftwaretesting.com", password: process.env.PROOFKIT_TOOLSHOP_PASSWORD ?? "welcome01" }) });
    if (typeof auth.body.access_token !== "string") throw new Error("Independent authentication unavailable");
    const { body, sha256 } = await readJson("/invoices/" + encodeURIComponent(invoiceId), { headers: { authorization: "Bearer " + auth.body.access_token } });
    const expectedTotal = Number(context.charter.metadata.expectedTotal);
    const expectedBilling = JSON.parse(context.charter.metadata.expectedBilling ?? "null");
    const expectedRequest = JSON.parse(context.charter.metadata.expectedInvoiceRequest ?? "null");
    const acceptance = invoiceAcceptance(body, captured, expected, expectedTotal, expectedBilling, expectedRequest);
    return observation(this.name, acceptance.passed,
    { invoiceId, invoiceNumber: body.invoice_number, total: body.total, expectedTotal, ...acceptance, status: body.status, bodySha256: sha256 });
  } catch { return observation(this.name, null, { invoiceId, gap: "Independent invoice observation unavailable" }); }
} };

export default { name: "toolshop-reviewed-current-record-readers", oracles: [cartOracle, invoiceOracle] };
