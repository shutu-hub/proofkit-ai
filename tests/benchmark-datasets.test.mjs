import assert from "node:assert/strict";
import { test } from "node:test";
import { readDatasetLock, verifyBytes } from "../scripts/fetch-benchmark-datasets.mjs";
import { buildTaskActions, classifyEpisode } from "./datasets/miniwob-cases.mjs";
import { createHash } from "node:crypto";

test("the public corpus pins commits, checksums and upstream licenses", async () => {
  const lock = await readDatasetLock();
  assert.deepEqual(Object.keys(lock.datasets), ["miniwob", "webarena-verified"]);
  assert.equal(lock.datasets.miniwob.taskIds.length, 6);
});

test("same-size cache tampering fails its checksum", () => {
  const bytes = Buffer.from("original");
  const file = { path: "fixture.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  verifyBytes(file, bytes);
  assert.throws(() => verifyBytes(file, Buffer.from("modified")), /SHA-256 mismatch/);
  assert.throws(() => verifyBytes(file, Buffer.from("truncated")), /Size mismatch/);
});

test("positive partial reward, missing terminal state and previous episodes cannot pass", () => {
  const completed = { done: true, episodeId: 1, rawReward: 1 };
  assert.equal(classifyEpisode(completed), true);
  for (const rawReward of [-1, 0, 0.5, 0.999]) assert.equal(classifyEpisode({ ...completed, rawReward }), false);
  assert.equal(classifyEpisode({ ...completed, done: false }), null);
  assert.equal(classifyEpisode({ ...completed, episodeId: 0 }), null);
  assert.equal(classifyEpisode({ ...completed, episodeId: 2 }), null);
  assert.equal(classifyEpisode({ ...completed, rawReward: NaN }), null);
});

test("incorrect checkbox submission flips one bit while preserving the visible target choices", () => {
  const observation = { query: "Select beta, gamma and click Submit.",
    choices: [{ id: "ch0", text: "alpha" }, { id: "ch1", text: "beta" }, { id: "ch2", text: "gamma" }, { id: "ch3", text: "delta" }] };
  const actions = buildTaskActions("click-checkboxes", observation, "incorrect");
  assert.deepEqual(actions.map((action) => action.selector), ["#ch1", "#ch2", "#ch0", "#subbtn"]);
  assert.equal(classifyEpisode({ done: true, episodeId: 1, rawReward: 0.5 }), false);
});

test("ambiguous public task targets are rejected before execution", () => {
  const observation = { query: "Select duplicate and click Submit.", choices: [{ id: "ch0", text: "duplicate" }, { id: "ch1", text: "duplicate" }] };
  assert.throws(() => buildTaskActions("click-option", observation, "correct"), /unique/);
  assert.throws(() => buildTaskActions("click-checkboxes", observation, "correct"), /unique/);
});
