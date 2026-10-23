# Model planning receipt validation

Date: 2026-10-22

## Change

The external Web model evaluator now persists a bounded planning receipt for every reviewed external trial. The receipt records:

- planner source, which must be `model` for external-model completion;
- planning confidence and counts of actions, surface assertions, business Oracles and negative cases;
- `evidenceGaps` and `missingInputs`, which must both be empty before the trial can execute;
- the SHA-256 of the exact saved `planned-charter.json`.

The evaluator recomputes that Charter hash from the isolated trial workspace. A self-reported hash or a submitted/host-authored planning source cannot enter the external model completion rate. A pre-planning setup stop remains a valid non-completion receipt, so an already-satisfied baseline is not misclassified as a model failure or success.

## Acceptance evidence

- `node --test tests/model-web-evaluation.test.mjs`: 8 tests passed, including model-source enforcement, gap rejection, Charter-hash mismatch rejection, and generic `--require-model` fail-fast behavior.
- `node tests/external-web-evaluation-smoke.mjs`: passed with `outOfTreeTrials=3`, `evidencedCompletion=1`, `independentReaderGap=1`, `preexistingStateBlocked=1`, `falsePasses=0`.
- The smoke uses a local reviewed provider and a generated out-of-tree application. It exercises the real evaluator, external suite pinning, retained Web session, model-produced Charter, independent business read, session evidence sealing, and final Mission report.
- `node --check tests/external-web-trial.mjs`, `node --check tests/model-web-evaluation.mjs`, and `git diff --check` pass.

## Boundary

This proves that the evaluator cannot silently count a host-repaired or unverified plan as autonomous model success. It does not establish success on an unfamiliar production application, model generalization, defect recall, or end-user one-command usability. Those still require real provider runs against a frozen unseen holdout with repeated trials and preserved raw failures.

The same planning receipt and exact `planned-charter.json` hash contract now applies to synthetic generic Web model trials. A one-case `catalog-crud` smoke verified the persisted planning summary and intact evidence manifest; fixture results remain `fixture` scope and are not holdout evidence.

Each aggregate attempt row also carries the same `evaluationScope`, so exporting or reviewing a single trial cannot silently lose whether it came from a fixture, reviewed external suite or attested holdout.
