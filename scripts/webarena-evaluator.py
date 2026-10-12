"""Optional benchmark sidecar. Scoring stays in the pinned upstream evaluator."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text("utf-8"))
    # Verify the installed wheel against tracked upstream source, rather than
    # trusting a matching package version or the caller's Python search path.
    import webarena_verified
    from webarena_verified.api import WebArenaVerified
    from webarena_verified.types.config import WebArenaVerifiedConfig

    installed = Path(webarena_verified.__file__).resolve().parent
    files = subprocess.check_output(
        ["git", "ls-files", "src/webarena_verified"], cwd=args.upstream, text=True
    ).splitlines()
    if not files:
        raise ValueError("Pinned evaluator source inventory is empty")
    for name in files:
        if not name.endswith(".py"):
            continue
        relative = Path(name).relative_to("src/webarena_verified")
        source = (args.upstream / name).read_bytes().replace(b"\r\n", b"\n")
        wheel = (installed / relative).read_bytes().replace(b"\r\n", b"\n")
        if source != wheel:
            raise ValueError(f"Installed evaluator differs from pinned source: {relative}")
    dataset = args.upstream / "assets/dataset/webarena-verified.json"
    if digest(dataset) != request["datasetSha256"]:
        raise ValueError("Dataset changed before evaluation")
    runtime = {
        "python": sys.version.split()[0],
        "evaluatorVersion": importlib.metadata.version("webarena-verified"),
        "installedSourceMatches": True,
        "packages": sorted(
            [{"name": package.metadata["Name"], "version": package.version}
             for package in importlib.metadata.distributions()], key=lambda package: package["name"].lower()
        ),
    }
    if request["operation"] == "probe":
        print(json.dumps({"runtime": runtime}))
        return
    config = WebArenaVerifiedConfig(
        test_data_file=dataset, environments=request["environments"]
    )
    evaluator = WebArenaVerified(config=config)
    results = []
    for case in request["cases"]:
        # Missing traces are handled by the controller, never invented here.
        response = Path(case["response"])
        trace = Path(case["trace"])
        if digest(response) != case["responseSha256"] or digest(trace) != case["traceSha256"]:
            raise ValueError("Submission changed before evaluation")
        result = evaluator.evaluate_task(
            task_id=case["taskId"], agent_response=response, network_trace=trace
        )
        results.append({"caseId": case["caseId"], "result": result.model_dump(mode="json")})
        if digest(response) != case["responseSha256"] or digest(trace) != case["traceSha256"]:
            raise ValueError("Submission changed during evaluation")
    if digest(dataset) != request["datasetSha256"]:
        raise ValueError("Dataset changed during evaluation")
    print(json.dumps({"runtime": runtime, "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
