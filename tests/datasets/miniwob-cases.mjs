import assert from "node:assert/strict";

// The scripted driver uses only the task's visible instruction and controls.
// It must not inspect genProblem closures or write the upstream reward globals.
export function buildTaskActions(task, observation, variant) {
  const { query, choices } = observation;
  const wrong = variant === "incorrect";
  if (variant === "unfinished") return [{ kind: "observe" }];
  const fill = (selector, value) => ({ kind: "fill", selector, value });
  const click = (selector) => ({ kind: "click", selector });
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  switch (task) {
    case "click-test-2":
      return [click(wrong ? "#subbtn2" : "#subbtn")];
    case "enter-text":
      assert.equal(quoted.length, 1);
      return [fill("#tt", wrong ? `${quoted[0]}-incorrect` : quoted[0]), click("#subbtn")];
    case "enter-password":
      assert.equal(quoted.length, 1);
      return [fill("#password", quoted[0]), fill("#verify", wrong ? `${quoted[0]}-incorrect` : quoted[0]), click("#subbtn")];
    case "login-user":
      assert.equal(quoted.length, 2);
      return [fill("#username", quoted[0]), fill("#password", wrong ? `${quoted[1]}-incorrect` : quoted[1]), click("#subbtn")];
    case "click-option": {
      const match = /^Select (.+) and click Submit\.$/.exec(query);
      assert.ok(match, "Unexpected radio instruction");
      const correct = choices.filter((choice) => choice.text === match[1]);
      assert.equal(correct.length, 1, "Radio target must be unique");
      const target = wrong ? choices.find((choice) => choice.id !== correct[0].id) : correct[0];
      assert.ok(target);
      return [click(`#${target.id}`), click("#subbtn")];
    }
    case "click-checkboxes": {
      const match = /^Select (.+) and click Submit\.$/.exec(query);
      assert.ok(match, "Unexpected checkbox instruction");
      const names = match[1] === "nothing" ? [] : match[1].split(", ");
      const targets = names.map((name) => {
        const matches = choices.filter((choice) => choice.text === name);
        assert.equal(matches.length, 1, "Checkbox target must be unique");
        return matches[0];
      });
      const actions = targets.map((choice) => click(`#${choice.id}`));
      // One wrong checkbox can still yield a positive partial reward. Exact
      // completion, rather than reward > 0, is required by our Oracle.
      if (wrong) { assert.ok(choices[0]); actions.push(click(`#${choices[0].id}`)); }
      return [...actions, click("#subbtn")];
    }
    default: throw new Error(`Unsupported MiniWoB task: ${task}`);
  }
}

export function classifyEpisode(state) {
  if (state.done !== true || state.episodeId !== 1 || !Number.isFinite(state.rawReward)) return null;
  return state.rawReward === 1;
}
