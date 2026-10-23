import assert from "node:assert/strict";
import { test } from "node:test";
import { noteAcceptance } from "./notes-live-oracles.mjs";
const expected = { title: "Reviewed private note", description: "Synthetic complete record", category: "Personal", completed: true };
const note = { ...expected, id: "current-note", user_id: "owner" };
test("notes acceptance requires current identity, owner, content, category and completion", () => {
  assert.equal(noteAcceptance(note, expected, note.id, note.user_id).passed, true);
  for (const changed of [{ ...note, id: "historical-note" }, { ...note, user_id: "other-user" }, { ...note, title: "Changed" },
    { ...note, description: "Overwritten" }, { ...note, category: "Work" }, { ...note, completed: false }]) assert.equal(noteAcceptance(changed, expected, note.id, note.user_id).passed, false);
});
test("missing or wrong-type note observations cannot silently pass", () => {
  for (const changed of [{ ...note, description: undefined }, { ...note, completed: "true" }, { ...note, id: undefined }, { ...note, user_id: undefined }]) {
    const checked = noteAcceptance(changed, expected, note.id, note.user_id); assert.equal(checked.passed, null); assert.ok(checked.missing.length > 0);
  }
});
test("a definite business difference is not hidden by a second missing observation", () => {
  const checked = noteAcceptance({ ...note, category: "Work", description: undefined }, expected, note.id, note.user_id);
  assert.equal(checked.passed, false); assert.deepEqual(checked.mismatches, ["category"]); assert.deepEqual(checked.missing, ["description"]);
});
