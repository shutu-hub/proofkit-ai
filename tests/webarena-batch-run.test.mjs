import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { assertPinnedContainer, inspectContainer, removePinnedContainer, selectBatchTasks, startPinnedContainer, withSiteLock } from "../scripts/webarena-batch-run.mjs";

const known = { Id: "a".repeat(64), Name: "/webarena_verified_shopping_admin",
  Image: "sha256:d0531dd27ed98d0c459ff9e88118bf2ed8b660b0ed99c38837db46c065a5be13",
  Mounts: [], HostConfig: { Binds: null, PortBindings: {
    "8877/tcp": [{ HostIp: "127.0.0.1", HostPort: "7781" }],
    "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "7780" }],
  } } };

test("development subsets preserve frozen task identity and profile order", () => {
  const tasks = [{ taskId: 0 }, { taskId: 41 }, { taskId: 62 }, { taskId: 704 }];
  assert.equal(selectBatchTasks(tasks), tasks);
  assert.deepEqual(selectBatchTasks(tasks, "704,41"), [tasks[1], tasks[3]]);
  for (const input of ["", "41,", "41,41", "041", "-1", "41,999", "41 62", "9007199254740993"]) {
    assert.throws(() => selectBatchTasks(tasks, input), /Task selection/);
  }
});

test("the batch reset recognizes only the pinned disposable container", () => {
  assert.equal(assertPinnedContainer(known), known.Id);
  for (const changed of [
    { Name: "/production_admin" },
    { Image: "sha256:" + "b".repeat(64) },
    { Mounts: [{ Type: "volume" }] },
    { HostConfig: { ...known.HostConfig, Binds: ["/data:/var/lib/mysql"] } },
    { HostConfig: { ...known.HostConfig, PortBindings: {
      ...known.HostConfig.PortBindings, "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "7780" }] } } },
  ]) {
    assert.throws(() => assertPinnedContainer({ ...known, ...changed }), /unrecognized benchmark container/);
  }
});

test("read-only container inspection retries transient Docker failures without treating them as absence", async () => {
  let calls = 0;
  const found = await inspectContainer({}, async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("temporary Docker inspect failure"), { stderr: "daemon temporarily unavailable" });
    return { stdout: JSON.stringify([known]) };
  });
  assert.equal(found.Id, known.Id);
  assert.equal(calls, 3);
  calls = 0;
  const absent = await inspectContainer({}, async () => {
    calls++;
    throw Object.assign(new Error("missing"), { stderr: "No such container" });
  });
  assert.equal(absent, undefined);
  assert.equal(calls, 1);
  await assert.rejects(inspectContainer({}, async () => ({ stdout: "[]" })), /Ambiguous benchmark container/);
});

test("reset reconciles Docker writes against the pinned container identity before retrying", async () => {
  let removals = 0;
  await removePinnedContainer({}, known.Id, async () => {
    if (++removals === 1) throw new Error("lost removal response");
  }, async () => known);
  assert.equal(removals, 2);
  removals = 0;
  await removePinnedContainer({}, known.Id, async () => {
    removals++;
    throw new Error("lost removal response");
  }, async () => undefined);
  assert.equal(removals, 1);
  await assert.rejects(removePinnedContainer({}, known.Id, async () => {
    throw new Error("failed");
  }, async () => ({ ...known, Id: "b".repeat(64) })), /identity changed/);

  let starts = 0;
  const recovered = await startPinnedContainer({}, async () => {
    starts++;
    throw new Error("lost start response");
  }, async () => known);
  assert.equal(recovered.Id, known.Id);
  assert.equal(starts, 1);
  starts = 0;
  const started = await startPinnedContainer({}, async () => { starts++; }, async () =>
    starts === 1 ? undefined : known);
  assert.equal(started.Id, known.Id);
  assert.equal(starts, 2);
  await assert.rejects(startPinnedContainer({}, async () => {}, async () =>
    ({ ...known, Image: "sha256:" + "b".repeat(64) })), /unrecognized benchmark container/);
});

test("one batch owns a Docker site's reset window and releases it afterward", async () => {
  await assert.rejects(withSiteLock("../escape", "test-output", async () => {}), /Invalid Docker instance/);
  const site = `test-${randomUUID()}`;
  let release;
  let entered;
  const active = withSiteLock(site, "test-output", async () => {
    entered?.();
    await new Promise((resolve) => { release = resolve; });
  });
  await new Promise((resolve) => { entered = resolve; });
  // Ensure the first action has acquired the lock before testing contention.
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(withSiteLock(site, "other-output", async () => {}), /Another shopping-admin batch owns/);
  release();
  await active;
  assert.equal(await withSiteLock(site, "next-output", async () => "released"), "released");
});
