import { createHash } from "node:crypto";

const api = "https://practice.expandtesting.com/notes/api";
const idPattern = /^[a-f0-9]{24}$/;
export function noteAcceptance(observed, expected, id, userId) {
  const fields = ["title", "description", "category", "completed"];
  const missing = fields.filter((name) => observed?.[name] === undefined || typeof observed[name] !== typeof expected[name]);
  const mismatches = fields.filter((name) => !missing.includes(name) && observed[name] !== expected[name]);
  const missingIdentity = typeof observed?.id !== "string" || typeof observed?.user_id !== "string";
  if (missingIdentity) missing.push("identity");
  else if (observed.id !== id || observed.user_id !== userId) mismatches.push("identity");
  return { passed: mismatches.length ? false : missing.length ? null : true, matched: fields.length - missing.filter((name) => name !== "identity").length - mismatches.filter((name) => name !== "identity").length, missing, mismatches };
}
async function read(path, token, signal) {
  if (!token) throw new Error("Read-only test authentication unavailable");
  const response = await fetch(api + path, { redirect: "error", headers: { "x-auth-token": token }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 1048576) throw new Error("Independent response exceeds bound");
  return { status: response.status, body: bytes.length ? JSON.parse(bytes.toString("utf8")) : null, bodySha256: createHash("sha256").update(bytes).digest("hex") };
}
function result(name, passed, facts) {
  return { name, passed, verificationKind: "business", message: "Independent authenticated current-note GET; source/deployment identity unverified", observedAt: new Date().toISOString(), evidence: [JSON.stringify(facts)] };
}
async function verify(context, deletion, isolation) {
  const name = deletion ? "notes-current-deleted" : isolation ? "notes-current-completed-isolated" : "notes-current-record";
  const captured = context.steps.filter((step) => step.response?.name.startsWith("note-")).at(-1)?.response;
  const id = captured?.fields.noteId ?? context.charter.metadata.noteId;
  const ownerId = process.env.PROOFKIT_NOTES_OWNER_ID, otherId = process.env.PROOFKIT_NOTES_OTHER_ID;
  if (!idPattern.test(id ?? "") || !idPattern.test(ownerId ?? "")) return result(name, null, { gap: "Current note or owner identity unavailable" });
  try {
    const profile = await read("/users/profile", process.env.PROOFKIT_NOTES_OWNER_TOKEN, context.signal);
    if (profile.status !== 200 || profile.body?.data?.id !== ownerId) return result(name, null, { id, gap: "Independent owner authentication is not established" });
    const record = await read("/notes/" + id, process.env.PROOFKIT_NOTES_OWNER_TOKEN, context.signal);
    if (deletion) {
      const list = await read("/notes", process.env.PROOFKIT_NOTES_OWNER_TOKEN, context.signal);
      if (list.status !== 200 || !Array.isArray(list.body?.data)) return result(name, null, { id, gap: "Independent owner list unavailable" });
      if (![200, 404].includes(record.status)) return result(name, null, { id, gap: "Independent deletion observation unavailable", observedStatus: record.status });
      return result(name, record.status === 404 && record.body?.success === false && !list.body.data.some((note) => note.id === id),
        { id, ownerId, deleteStatus: captured?.status, recordStatus: record.status, listStatus: list.status, remainingNotes: list.body.data.length, bodySha256: record.bodySha256, listBodySha256: list.bodySha256 });
    }
    if (record.status !== 200) return result(name, null, { id, gap: "Independent current note unavailable", observedStatus: record.status });
    const expected = JSON.parse(context.charter.metadata.expectedNote); const checked = noteAcceptance(record.body?.data, expected, id, ownerId);
    const request = captured?.requestFields ?? {};
    const submittedChecks = Object.fromEntries(Object.keys(request).map((field) => [field, expected[field] === request[field]]));
    let passed = Object.values(submittedChecks).some((matched) => !matched) ? false : checked.passed;
    const facts = { id, ownerId, ...checked, submittedChecks, observed: record.body.data, bodySha256: record.bodySha256 };
    if (isolation) {
      const profileOther = await read("/users/profile", process.env.PROOFKIT_NOTES_OTHER_TOKEN, context.signal);
      if (profileOther.status !== 200 || profileOther.body?.data?.id !== otherId || otherId === ownerId) return result(name, null, { id, gap: "Independent second account authentication unavailable" });
      const denied = await read("/notes/" + id, process.env.PROOFKIT_NOTES_OTHER_TOKEN, context.signal);
      const listOther = await read("/notes", process.env.PROOFKIT_NOTES_OTHER_TOKEN, context.signal);
      if (![200, 403, 404].includes(denied.status) || listOther.status !== 200 || !Array.isArray(listOther.body?.data)) return result(name, null, { id, gap: "Independent second-account record or list unavailable" });
      const isolated = [403, 404].includes(denied.status) && denied.body?.success === false && listOther.status === 200 && Array.isArray(listOther.body?.data)
        && !listOther.body.data.some((note) => note.id === id);
      Object.assign(facts, { otherId, otherReadStatus: denied.status, otherListStatus: listOther.status, isolated, deniedBodySha256: denied.bodySha256, otherListBodySha256: listOther.bodySha256 });
      if (!isolated) passed = false;
    }
    return result(name, passed, facts);
  } catch { return result(name, null, { id, gap: "Independent authenticated observation unavailable" }); }
}
export default { name: "notes-reviewed-private-record-readers", oracles: [
  { name: "notes-current-record", check: (context) => verify(context, false, false) },
  { name: "notes-current-completed-isolated", check: (context) => verify(context, false, true) },
  { name: "notes-current-deleted", check: (context) => verify(context, true, false) },
] };
