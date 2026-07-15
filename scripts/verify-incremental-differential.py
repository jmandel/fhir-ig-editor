#!/usr/bin/env python3
"""Exhaustively compare fresh and retained SiteEngine execution on catalog IGs.

The corpus driver owns only fixture extraction and deterministic A->B edits.
The Rust test owns compilation, preparation, rendering, ContentStore reads, and
finalization through the canonical SiteEngine API.  No browser/product hook or
alternate build representation is involved.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import shutil
import signal
import stat
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CASE_SCHEMA = "fig-incremental-differential-case/v1"
RECEIPT_SCHEMA = "fig-incremental-differential-receipt/v1"
AGGREGATE_SCHEMA = "fig-incremental-differential-aggregate/v1"
DEFAULT_TEMPLATE = "hl7.fhir.template#1.0.0"
DEFAULT_EPOCH = 1_783_555_200
FROZEN_CONTEXT_ENV = "FIG_DIFFERENTIAL_FROZEN_CONTEXT"

# These are test-corpus descriptors, not production specialization.  Each is
# the same representative edit already exercised by benchmark-project.mjs.
CASES = {
    "tiny": {
        "path": "input/fsh/00-EditorUser.fsh",
        "before": "Name used while exploring the editor",
        "after": "Name used while benchmarking the editor",
        "output": "en/StructureDefinition-editor-user.html",
        "compilation": True,
        "snapshotPartial": True,
    },
    "ips": {
        "path": "input/fsh/profiles/PatientUvIps.fsh",
        "before": 'Title: "Patient (IPS)"',
        "after": 'Title: "Patient (IPS) Benchmark Edit"',
        "output": "en/StructureDefinition-Patient-uv-ips.html",
        "compilation": True,
        "snapshotPartial": True,
    },
    "uscore": {
        "path": "input/resources/structuredefinition-us-core-patient.json",
        "before": '"title": "US Core Patient Profile"',
        "after": '"title": "US Core Patient Profile Benchmark Edit"',
        "output": "en/StructureDefinition-us-core-patient.html",
        # Predefined resources participate in PreparedGuide/site preparation,
        # but are not duplicated in the compiler inspection result.
        "compilation": False,
        "snapshotPartial": True,
    },
    "mcode": {
        "path": "input/pagecontent/StructureDefinition-mcode-cancer-patient-intro.md",
        "before": "### Conformance",
        "after": "### Conformance Benchmark Edit",
        "output": "en/StructureDefinition-mcode-cancer-patient.html",
        "compilation": False,
        "snapshotPartial": False,
    },
}


class DifferentialFailure(RuntimeError):
    pass


class TerminationRequested(RuntimeError):
    def __init__(self, signum: int):
        self.signum = signum
        super().__init__(f"received signal {signum}")


class KeyboardInterruptRequested(KeyboardInterrupt):
    def __init__(self, signum: int):
        self.signum = signum
        super().__init__(f"received signal {signum}")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_native_helpers(path: Path):
    spec = importlib.util.spec_from_file_location("fhir_native_benchmark_helpers", path)
    if spec is None or spec.loader is None:
        raise DifferentialFailure(f"cannot load fixture helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def stable_capture_file(source: Path, destination: Path) -> dict[str, Any]:
    """Capture one coherent regular file without trusting a path-level copy."""
    if source.is_symlink() or not source.is_file():
        raise DifferentialFailure(f"input is not a regular file: {source}")
    attempts = []
    for attempt in range(1, 13):
        try:
            before = source.read_bytes()
            after = source.read_bytes()
        except OSError as error:
            attempts.append(
                {
                    "attempt": attempt,
                    "accepted": False,
                    "readRace": f"{type(error).__name__}: {error}",
                }
            )
            continue
        before_sha = hashlib.sha256(before).hexdigest()
        after_sha = hashlib.sha256(after).hexdigest()
        accepted = before == after
        attempts.append(
            {
                "attempt": attempt,
                "beforeSha256": before_sha,
                "afterSha256": after_sha,
                "accepted": accepted,
            }
        )
        if not accepted:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(before)
        frozen = destination.read_bytes()
        if frozen != before:
            raise DifferentialFailure(f"frozen input differs after write: {destination}")
        destination.chmod(stat.S_IMODE(destination.stat().st_mode) & ~0o222)
        return {
            "sourcePath": str(source),
            "frozenPath": str(destination),
            "bytes": len(frozen),
            "sha256": before_sha,
            "attempts": attempts,
        }
    raise DifferentialFailure(f"input did not remain byte-identical: {source}")


def verify_captured_file(capture: dict[str, Any]) -> None:
    path = Path(capture["frozenPath"])
    if not path.is_file() or path.is_symlink():
        raise DifferentialFailure(f"frozen input is absent or replaced: {path}")
    body = path.read_bytes()
    if len(body) != capture["bytes"] or hashlib.sha256(body).hexdigest() != capture["sha256"]:
        raise DifferentialFailure(f"frozen input changed during the run: {path}")


def freeze_orchestrator_inputs(editor: Path, run_root: Path) -> dict[str, Any]:
    root = run_root / "orchestrator-inputs"
    runner = stable_capture_file(Path(__file__).resolve(), root / "runner.py")
    helper = stable_capture_file(
        editor / "scripts/benchmark-native-cli.py", root / "benchmark-native-cli.py"
    )
    return {"root": str(root), "runner": runner, "helper": helper}


def exec_frozen_runner(editor: Path, run_root: Path) -> None:
    orchestrator = freeze_orchestrator_inputs(editor, run_root)
    context_path = run_root / "frozen-runner-context.json"
    atomic_json(
        context_path,
        {
            "editorRoot": str(editor),
            "runRoot": str(run_root),
            "orchestratorInputs": orchestrator,
        },
    )
    environment = os.environ.copy()
    environment[FROZEN_CONTEXT_ENV] = str(context_path)
    runner = orchestrator["runner"]["frozenPath"]
    os.execve(sys.executable, [sys.executable, runner, *sys.argv[1:]], environment)


def frozen_runner_context() -> dict[str, Any] | None:
    raw = os.environ.get(FROZEN_CONTEXT_ENV)
    if not raw:
        return None
    path = Path(raw).resolve()
    try:
        context = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise DifferentialFailure(f"invalid frozen runner context {path}: {error}") from error
    required = {"editorRoot", "runRoot", "orchestratorInputs"}
    if not isinstance(context, dict) or set(context) != required:
        raise DifferentialFailure(f"invalid frozen runner context fields in {path}")
    return context


def freeze_catalog_inputs(
    editor: Path, run_root: Path, projects: list[str], helpers
) -> dict[str, Any]:
    """Freeze every live catalog byte before extraction or metadata checks."""
    root = run_root / "catalog-inputs"
    bundle_root = editor / "app/public/data/bundles"
    fixed_paths = set()
    for project in projects:
        descriptor = helpers.PROJECTS[project]
        fixed_paths.add(descriptor["input"])
        if descriptor.get("metadata"):
            fixed_paths.add(descriptor["metadata"])
    attempts = []
    for attempt in range(1, 13):
        bundle_paths = {
            archive.relative_to(editor).as_posix()
            for archive in bundle_root.glob("*.tgz")
        }
        paths = sorted(fixed_paths | bundle_paths)
        artifacts = [
            stable_capture_file(editor / relative, root / relative)
            for relative in paths
        ]
        after_bundle_paths = {
            archive.relative_to(editor).as_posix()
            for archive in bundle_root.glob("*.tgz")
        }
        stable = bundle_paths == after_bundle_paths
        if stable:
            for capture in artifacts:
                source = Path(capture["sourcePath"])
                before = source.read_bytes()
                after = source.read_bytes()
                stable = (
                    before == after
                    and len(before) == capture["bytes"]
                    and hashlib.sha256(before).hexdigest() == capture["sha256"]
                )
                if not stable:
                    break
        attempts.append(
            {
                "attempt": attempt,
                "artifactCount": len(artifacts),
                "accepted": stable,
            }
        )
        if stable:
            return {
                "editorRoot": str(root),
                "artifactCount": len(artifacts),
                "attempts": attempts,
                "artifacts": artifacts,
            }
        shutil.rmtree(root)
    raise DifferentialFailure(
        "catalog fixture and baked bundle inputs did not remain byte-identical"
    )


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def run_managed_process(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Run one child group and reap it before propagating an interruption."""
    process = subprocess.Popen(command, start_new_session=True, **kwargs)
    try:
        return_code = process.wait()
    except BaseException:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        raise
    return subprocess.CompletedProcess(command, return_code)


def parse_projects(raw: str) -> list[str]:
    projects: list[str] = []
    for item in raw.split(","):
        project = item.strip().lower()
        if not project or project in projects:
            continue
        if project not in CASES:
            raise argparse.ArgumentTypeError(
                f"unknown project {project!r}; choose from {','.join(CASES)}"
            )
        projects.append(project)
    if not projects:
        raise argparse.ArgumentTypeError("select at least one project")
    return projects


def mutate_fixture(a: Path, b: Path, descriptor: dict[str, Any], helpers) -> dict[str, Any]:
    shutil.copytree(a, b, symlinks=False)
    target = b.joinpath(*Path(descriptor["path"]).parts)
    if not target.is_file() or target.is_symlink():
        raise DifferentialFailure(f"mutation target is not a regular file: {target}")
    before = descriptor["before"].encode()
    after = descriptor["after"].encode()
    body = target.read_bytes()
    count = body.count(before)
    if count != 1:
        raise DifferentialFailure(
            f"{target} contains mutation source {count} times instead of exactly once"
        )
    if after in body:
        raise DifferentialFailure(f"{target} already contains mutation destination bytes")
    changed = body.replace(before, after, 1)
    if changed == body or changed.count(after) != 1:
        raise DifferentialFailure(f"mutation did not produce one exact replacement in {target}")
    target.write_bytes(changed)
    return {
        "path": descriptor["path"],
        "before": descriptor["before"],
        "after": descriptor["after"],
        "beforeFileBytes": len(body),
        "afterFileBytes": len(changed),
        "beforeFileSha256": helpers.sha256_bytes(body),
        "afterFileSha256": helpers.sha256_bytes(changed),
    }


def validate_case_receipt(path: Path, project: str) -> dict[str, Any]:
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise DifferentialFailure(f"invalid case receipt {path}: {error}") from error
    if not isinstance(receipt, dict):
        raise DifferentialFailure(f"{project} receipt is not an object")
    if receipt.get("schemaVersion") != RECEIPT_SCHEMA:
        raise DifferentialFailure(f"{project} returned an unsupported receipt schema")
    if receipt.get("status") != "pass" or receipt.get("caseId") != project:
        raise DifferentialFailure(f"{project} differential failed: {receipt}")
    expected_receipt_fields = {
        "schemaVersion",
        "status",
        "caseId",
        "fixture",
        "comparisons",
        "packageCorpus",
        "executions",
    }
    if project == "tiny":
        expected_receipt_fields.add("failedSuccessor")
    if set(receipt) != expected_receipt_fields:
        raise DifferentialFailure(f"{project} receipt has an unexpected top-level shape")
    package_corpus = receipt.get("packageCorpus")
    if not isinstance(package_corpus, dict):
        raise DifferentialFailure(f"{project} receipt has no package corpus provenance")
    attempts = package_corpus.get("captureAttempts")
    carriers = package_corpus.get("carriers")
    if not isinstance(attempts, int) or not 1 <= attempts <= 12:
        raise DifferentialFailure(f"{project} has invalid package capture attempts")
    if not isinstance(carriers, list) or not carriers:
        raise DifferentialFailure(f"{project} has no exact package carrier identities")
    labels = set()
    for carrier in carriers:
        if not isinstance(carrier, dict) or not isinstance(carrier.get("label"), str):
            raise DifferentialFailure(f"{project} has malformed package carrier provenance")
        label = carrier["label"]
        content = carrier.get("content")
        if label in labels or not isinstance(content, dict):
            raise DifferentialFailure(f"{project} repeats or malforms package carrier {label}")
        labels.add(label)
        digest = content.get("sha256")
        length = content.get("byteLength")
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or not isinstance(length, int)
            or length <= 0
        ):
            raise DifferentialFailure(f"{project} has invalid carrier ContentRef for {label}")
    executions = receipt.get("executions")
    required = {
        "freshAForward",
        "retainedSeedA",
        "retainedBForward",
        "retainedReturnAReverse",
        "freshBReverse",
    }
    if not isinstance(executions, dict) or set(executions) != required:
        raise DifferentialFailure(f"{project} receipt lacks the exact execution set")
    expected_render_orders = {
        "freshAForward": "forward",
        "retainedSeedA": "not-rendered",
        "retainedBForward": "forward",
        "retainedReturnAReverse": "reverse",
        "freshBReverse": "reverse",
    }
    for name, execution in executions.items():
        if not str(execution.get("buildId", "")).startswith("sb1-sha256:"):
            raise DifferentialFailure(f"{project}/{name} has no canonical build id")
        if name != "retainedSeedA" and not str(execution.get("outputId", "")).startswith(
            "so1-sha256:"
        ):
            raise DifferentialFailure(f"{project}/{name} has no canonical output id")
        if not isinstance(execution.get("outputPaths"), int) or execution["outputPaths"] <= 0:
            raise DifferentialFailure(f"{project}/{name} has an empty output catalog")
        if execution.get("renderOrder") != expected_render_orders[name]:
            raise DifferentialFailure(f"{project}/{name} has the wrong render traversal")

    def count_value(metrics: Any, scope: str, key: str) -> float:
        value = metrics.get(key) if isinstance(metrics, dict) else None
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value < 0
            or not float(value).is_integer()
        ):
            raise DifferentialFailure(
                f"{project}/{scope} has invalid count metric {key}={value!r}"
            )
        return float(value)

    def metric(execution_name: str, key: str) -> float:
        metrics = executions[execution_name].get("metrics")
        return count_value(metrics, execution_name, key)

    retained_hits = metric("retainedBForward", "snapshotResourceCacheHits")
    retained_misses = metric("retainedBForward", "snapshotResourceCacheMisses")
    fresh_hits = metric("freshBReverse", "snapshotResourceCacheHits")
    fresh_misses = metric("freshBReverse", "snapshotResourceCacheMisses")
    if metric("freshBReverse", "snapshotCompletedLocalCacheHit") != 0:
        raise DifferentialFailure(f"{project} fresh B incorrectly reported snapshot reuse")
    if CASES[project]["snapshotPartial"]:
        if not (
            metric("retainedBForward", "snapshotCompletedLocalCacheHit") == 0
            and retained_hits > 0
            and retained_misses > 0
            and fresh_hits == 0
            and fresh_misses > 0
            and retained_hits + retained_misses == fresh_misses
            and metric("retainedBForward", "snapshotDerivationAdmitted") == 1
            and metric("freshBReverse", "snapshotDerivationAdmitted") == 1
        ):
            raise DifferentialFailure(
                f"{project} did not prove partial snapshot reuse: retained "
                f"{retained_hits}/{retained_misses}, fresh {fresh_hits}/{fresh_misses}"
            )
    elif not (
        metric("retainedBForward", "snapshotCompletedLocalCacheHit") == 1
        and retained_hits == 0
        and retained_misses == 0
        and fresh_hits == 0
        and fresh_misses > 0
        and metric("freshBReverse", "snapshotDerivationAdmitted") == 1
    ):
        raise DifferentialFailure(f"{project} did not prove exact whole-snapshot reuse")

    fresh_catalog_entries = metric("freshBReverse", "renderPackageCatalogEntries")
    fresh_catalog_packages = metric("freshBReverse", "renderPackageCatalogPackages")
    fresh_catalog_bytes = metric("freshBReverse", "renderPackageCatalogApproxBytes")
    fresh_own_resources = metric("freshBReverse", "renderOwnResourcesPreparsed")
    if not (
        metric("freshBReverse", "renderSemanticsCacheHit") == 0
        and metric("freshBReverse", "renderPackageCatalogCacheHit") == 0
        and metric("freshBReverse", "renderPackageCatalogBuilt") == 1
        and metric("freshBReverse", "renderOwnContextBuilt") == 1
        and metric("freshBReverse", "renderPackageCatalogAdmitted") == 1
        and fresh_catalog_packages > 0
        and fresh_catalog_entries > 0
        and fresh_catalog_bytes > 0
        and fresh_own_resources > 0
    ):
        raise DifferentialFailure(
            f"{project} fresh B did not prove canonical render package-catalog construction"
        )
    if CASES[project]["snapshotPartial"]:
        retained_catalog_generations = metric(
            "retainedBForward", "renderPackageCatalogRetainedGenerations"
        )
        if not (
            metric("retainedBForward", "renderSemanticsCacheHit") == 0
            and metric("retainedBForward", "renderPackageCatalogCacheHit") == 1
            and metric("retainedBForward", "renderPackageCatalogBuilt") == 0
            and metric("retainedBForward", "renderOwnContextBuilt") == 1
            and metric("retainedBForward", "renderOwnResourcesPreparsed")
            == fresh_own_resources
            and metric("retainedBForward", "renderPackageCatalogAdmitted") == 1
            and metric("retainedBForward", "renderPackageCatalogPackages")
            == fresh_catalog_packages
            and metric("retainedBForward", "renderPackageCatalogEntries")
            == fresh_catalog_entries
            and metric("retainedBForward", "renderPackageCatalogApproxBytes")
            == fresh_catalog_bytes
            and 1 <= retained_catalog_generations <= 2
        ):
            raise DifferentialFailure(
                f"{project} retained B did not prove bounded package-catalog-only reuse"
            )
    elif not (
        metric("retainedBForward", "renderSemanticsCacheHit") == 1
        and metric("retainedBForward", "renderPackageCatalogCacheHit") == 0
        and metric("retainedBForward", "renderPackageCatalogBuilt") == 0
        and metric("retainedBForward", "renderOwnContextBuilt") == 0
        and metric("retainedBForward", "renderOwnResourcesPreparsed") == 0
        and metric("retainedBForward", "renderPackageCatalogAdmitted") == 0
    ):
        raise DifferentialFailure(
            f"{project} site-only retained B did not use exact RenderSemantics"
        )
    if (
        metric("retainedReturnAReverse", "semanticCompilationCacheHit") != 1
        or metric("retainedReturnAReverse", "siteBuildCacheHit") != 1
        or metric("retainedReturnAReverse", "snapshotResourceCacheHits") != 0
        or metric("retainedReturnAReverse", "snapshotResourceCacheMisses") != 0
        or metric("retainedReturnAReverse", "renderPackageCatalogCacheHit") != 0
        or metric("retainedReturnAReverse", "renderPackageCatalogBuilt") != 0
        or metric("retainedReturnAReverse", "renderOwnContextBuilt") != 0
        or metric("retainedReturnAReverse", "renderOwnResourcesPreparsed") != 0
        or metric("retainedReturnAReverse", "renderPackageCatalogAdmitted") != 0
    ):
        raise DifferentialFailure(
            f"{project} return-A exact reuse was misclassified as incremental derivation proof"
        )
    failed_successor = receipt.get("failedSuccessor")
    if project == "tiny":
        required_failure = {
            "operation",
            "phase",
            "code",
            "retryable",
            "successfulCompilation",
            "injectedBodySha256",
            "recovery",
        }
        if not isinstance(failed_successor, dict) or set(failed_successor) != required_failure:
            raise DifferentialFailure(f"{project} lacks the exact failed-successor proof")
        if (
            failed_successor["operation"] != "prepare"
            or failed_successor["phase"] != "preparation"
            or failed_successor["code"] != "renderer-failed"
            or failed_successor["retryable"] is not False
            or failed_successor["successfulCompilation"] is not True
        ):
            raise DifferentialFailure(f"{project} has malformed failed-successor semantics")
        injected_digest = failed_successor["injectedBodySha256"]
        if (
            not isinstance(injected_digest, str)
            or len(injected_digest) != 64
            or any(character not in "0123456789abcdef" for character in injected_digest)
        ):
            raise DifferentialFailure(f"{project} has an invalid failed-successor body digest")
        recovery = failed_successor["recovery"]
        fresh_b = executions["freshBReverse"]
        if (
            not isinstance(recovery, dict)
            or set(recovery) != set(fresh_b)
            or recovery.get("buildId") != fresh_b.get("buildId")
            or recovery.get("outputId") != fresh_b.get("outputId")
            or recovery.get("outputPaths") != fresh_b.get("outputPaths")
            or recovery.get("outputBytes") != fresh_b.get("outputBytes")
            or recovery.get("renderOrder") != "forward"
        ):
            raise DifferentialFailure(f"{project} failed-successor recovery is not canonical B")
        for key in (
            "compiledResources",
            "compilationDiagnostics",
            "closureReferences",
            "closureObjects",
        ):
            if recovery.get(key) != fresh_b.get(key):
                raise DifferentialFailure(
                    f"{project} failed-successor recovery differs at summary field {key}"
                )
        recovery_metrics = recovery.get("metrics")
        recovery_hits = count_value(
            recovery_metrics, "failedSuccessor", "snapshotResourceCacheHits"
        )
        recovery_misses = count_value(
            recovery_metrics, "failedSuccessor", "snapshotResourceCacheMisses"
        )
        if (
            count_value(
                recovery_metrics, "failedSuccessor", "snapshotCompletedLocalCacheHit"
            )
            != 0
            or recovery_hits <= 0
            or recovery_misses <= 0
            or recovery_hits + recovery_misses != fresh_misses
            or fresh_hits != 0
            or count_value(
                recovery_metrics, "failedSuccessor", "snapshotDerivationAdmitted"
            )
            != 1
            or count_value(
                recovery_metrics, "failedSuccessor", "renderSemanticsCacheHit"
            )
            != 0
            or count_value(
                recovery_metrics, "failedSuccessor", "renderPackageCatalogCacheHit"
            )
            != 1
            or count_value(
                recovery_metrics, "failedSuccessor", "renderPackageCatalogBuilt"
            )
            != 0
            or count_value(
                recovery_metrics, "failedSuccessor", "renderOwnContextBuilt"
            )
            != 1
            or count_value(
                recovery_metrics, "failedSuccessor", "renderPackageCatalogEntries"
            )
            != fresh_catalog_entries
            or count_value(
                recovery_metrics, "failedSuccessor", "renderPackageCatalogPackages"
            )
            != fresh_catalog_packages
            or count_value(
                recovery_metrics, "failedSuccessor", "renderPackageCatalogApproxBytes"
            )
            != fresh_catalog_bytes
            or count_value(
                recovery_metrics, "failedSuccessor", "renderPackageCatalogAdmitted"
            )
            != 1
            or count_value(
                recovery_metrics, "failedSuccessor", "renderOwnResourcesPreparsed"
            )
            != fresh_own_resources
        ):
            raise DifferentialFailure(
                f"{project} recovery did not retain safe incremental derivations"
            )
    elif "failedSuccessor" in receipt:
        raise DifferentialFailure(f"{project} unexpectedly emitted a failed-successor proof")
    return receipt


def workspace_identity(root: Path) -> dict[str, Any]:
    """Hash every Cargo workspace input used by the Fig library build."""
    paths = [root / "Cargo.toml", root / "Cargo.lock"]
    cargo_config = root / ".cargo"
    if cargo_config.exists():
        paths.append(cargo_config)
    paths.append(root / "crates")

    files: list[Path] = []
    for path in paths:
        if path.is_symlink():
            raise DifferentialFailure(f"workspace input may not be a symlink: {path}")
        if path.is_file():
            files.append(path)
        elif path.is_dir():
            for candidate in path.rglob("*"):
                if candidate.is_symlink():
                    raise DifferentialFailure(
                        f"workspace input may not be a symlink: {candidate}"
                    )
                if candidate.is_file():
                    files.append(candidate)
        else:
            raise DifferentialFailure(f"workspace input is absent: {path}")

    digest = hashlib.sha256()
    total_bytes = 0
    inventory = []
    for path in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        body = path.read_bytes()
        mode = stat.S_IMODE(path.stat().st_mode)
        body_digest = hashlib.sha256(body).hexdigest()
        total_bytes += len(body)
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(str(mode).encode())
        digest.update(b"\0")
        digest.update(str(len(body)).encode())
        digest.update(b"\0")
        digest.update(body_digest.encode())
        digest.update(b"\n")
        inventory.append(
            {
                "path": relative,
                "bytes": len(body),
                "mode": oct(mode),
                "sha256": body_digest,
            }
        )
    return {
        "treeSha256": digest.hexdigest(),
        "fileCount": len(inventory),
        "totalBytes": total_bytes,
        "files": inventory,
    }


def copy_workspace_inputs(source: Path, destination: Path) -> None:
    destination.mkdir()
    shutil.copy2(source / "Cargo.toml", destination / "Cargo.toml")
    shutil.copy2(source / "Cargo.lock", destination / "Cargo.lock")
    if (source / ".cargo").exists():
        shutil.copytree(source / ".cargo", destination / ".cargo")
    shutil.copytree(source / "crates", destination / "crates")


def freeze_workspace(engine: Path, run_root: Path) -> dict[str, Any]:
    """Copy one coherent source image even while unrelated work continues.

    A concurrent edit can invalidate an attempt, but it cannot leak into the
    accepted image: the live tree must match both sides of the copy and the
    copied tree byte-for-byte.  Once accepted, later edits are irrelevant.
    """
    destination = run_root / "engine-source-snapshot"
    attempts = []
    for attempt in range(1, 13):
        candidate = run_root / f".engine-source-snapshot-{attempt}"
        try:
            before = workspace_identity(engine)
            copy_workspace_inputs(engine, candidate)
            copied = workspace_identity(candidate)
            after = workspace_identity(engine)
        except OSError as error:
            if candidate.exists():
                shutil.rmtree(candidate)
            attempts.append(
                {
                    "attempt": attempt,
                    "accepted": False,
                    "copyRace": f"{type(error).__name__}: {error}",
                }
            )
            continue
        stable = (
            before["treeSha256"]
            == copied["treeSha256"]
            == after["treeSha256"]
        )
        attempts.append(
            {
                "attempt": attempt,
                "before": before["treeSha256"],
                "copied": copied["treeSha256"],
                "after": after["treeSha256"],
                "accepted": stable,
            }
        )
        if stable:
            candidate.replace(destination)
            for path in sorted(destination.rglob("*"), reverse=True):
                if path.is_file():
                    path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o222)
                elif path.is_dir():
                    path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o222)
            destination.chmod(stat.S_IMODE(destination.stat().st_mode) & ~0o222)
            frozen = workspace_identity(destination)
            return {
                "path": str(destination),
                "treeSha256": frozen["treeSha256"],
                "capturedTreeSha256": copied["treeSha256"],
                "fileCount": frozen["fileCount"],
                "totalBytes": frozen["totalBytes"],
                "attempts": attempts,
                "inventory": "engine-source-inventory.json",
                "identity": frozen,
            }
        shutil.rmtree(candidate)
    raise DifferentialFailure(
        "could not capture one coherent engine source image after 12 immediate attempts"
    )


def build_frozen_test_binary(engine: Path, run_root: Path, helpers) -> dict[str, Any]:
    """Build once from an immutable source image and freeze one test image."""
    snapshot = freeze_workspace(engine, run_root)
    atomic_json(run_root / snapshot["inventory"], snapshot.pop("identity"))
    snapshot_root = Path(snapshot["path"])
    stdout_path = run_root / "build-test.jsonl"
    stderr_path = run_root / "build-test.stderr"
    # A shared Cargo target permits another build of the same package to
    # replace the hashed test executable between Cargo exiting and this runner
    # freezing it.  Keep the entire build output private to this receipt so the
    # binary can only have been produced from the source snapshot above.
    cargo_target = run_root / "cargo-target"
    cargo_target.mkdir()
    command = [
        "cargo",
        "test",
        "--locked",
        "--release",
        "-p",
        "fig",
        "--lib",
        "--no-run",
        "--message-format=json-render-diagnostics",
    ]
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(cargo_target)
    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            completed = run_managed_process(
                command, cwd=snapshot_root, env=environment, stdout=stdout, stderr=stderr
            )
        if completed.returncode != 0:
            raise DifferentialFailure(
                f"Fig differential test build exited {completed.returncode}; see {stderr_path}"
            )
        executables: list[Path] = []
        for line in stdout_path.read_text(encoding="utf-8").splitlines():
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                message.get("reason") == "compiler-artifact"
                and message.get("target", {}).get("name") == "fig"
                and "lib" in message.get("target", {}).get("kind", [])
                and message.get("profile", {}).get("test") is True
                and isinstance(message.get("executable"), str)
            ):
                executables.append(Path(message["executable"]).resolve())
        executables = list(dict.fromkeys(executables))
        if len(executables) != 1 or not executables[0].is_file():
            raise DifferentialFailure(
                f"expected one Fig library test executable, found {executables}"
            )
        built_executable = executables[0]
        binary_root = run_root / "bin"
        binary_root.mkdir()
        executable = binary_root / "fig-incremental-differential"
        shutil.copy2(built_executable, executable)
        executable.chmod(stat.S_IMODE(executable.stat().st_mode) & ~0o222)
        built_sha256 = helpers.sha256_file(built_executable)
        frozen_sha256 = helpers.sha256_file(executable)
        if built_sha256 != frozen_sha256:
            raise DifferentialFailure("frozen test executable differs from Cargo output")
    except BaseException:
        shutil.rmtree(cargo_target, ignore_errors=True)
        raise
    shutil.rmtree(cargo_target)
    return {
        "path": str(executable),
        "bytes": executable.stat().st_size,
        "sha256": frozen_sha256,
        "command": command,
        "stdout": str(stdout_path.relative_to(run_root)),
        "stderr": str(stderr_path.relative_to(run_root)),
        "cargoTarget": str(cargo_target),
        "cargoTargetRemovedAfterFreeze": True,
        "sourceSnapshot": snapshot,
    }


def verify_frozen_build(test_binary: dict[str, Any], helpers) -> None:
    executable = Path(test_binary["path"])
    if helpers.sha256_file(executable) != test_binary["sha256"]:
        raise DifferentialFailure("frozen test executable changed during the corpus run")
    snapshot = test_binary["sourceSnapshot"]
    current = workspace_identity(Path(snapshot["path"]))
    if current["treeSha256"] != snapshot["treeSha256"]:
        raise DifferentialFailure("frozen engine source snapshot changed during the corpus run")


def main() -> int:
    frozen_context = frozen_runner_context()
    editor = (
        Path(frozen_context["editorRoot"]).resolve()
        if frozen_context is not None
        else Path(__file__).resolve().parent.parent
    )
    engine = editor / "vendor/sushi-rs"
    parser = argparse.ArgumentParser(
        description="compare fresh A/B and retained A->B->A across every Publisher output"
    )
    parser.add_argument(
        "--projects",
        type=parse_projects,
        default=parse_projects("tiny,ips,uscore,mcode"),
    )
    parser.add_argument(
        "--source-cache",
        type=Path,
        default=engine / "temp/fhir-home/.fhir/packages",
        help="explicit materialized cache; the user's ~/.fhir tree is refused",
    )
    parser.add_argument("--template", default=DEFAULT_TEMPLATE)
    parser.add_argument("--build-epoch", type=int, default=DEFAULT_EPOCH)
    parser.add_argument(
        "--out",
        type=Path,
        help="new receipt directory below vendor/sushi-rs/target",
    )
    parser.add_argument(
        "--keep-cache",
        action="store_true",
        help="retain the isolated hardlinked package overlay after success",
    )
    args = parser.parse_args()

    target_root = (engine / "target").resolve()
    if frozen_context is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        run_root = (
            args.out
            or engine / "target/incremental-differential" / f"{stamp}-{os.getpid()}"
        ).resolve()
        if not run_root.is_relative_to(target_root):
            parser.error("--out must be below vendor/sushi-rs/target")
        if run_root.exists():
            parser.error(f"--out already exists: {run_root}")
        run_root.mkdir(parents=True)
        exec_frozen_runner(editor, run_root)
        raise AssertionError("exec of frozen differential runner returned")

    run_root = Path(frozen_context["runRoot"]).resolve()
    if not run_root.is_relative_to(target_root):
        parser.error("frozen run root must be below vendor/sushi-rs/target")
    if args.out is not None and args.out.resolve() != run_root:
        parser.error("--out differs from the authoritative frozen run root")
    if not run_root.is_dir():
        parser.error(f"authoritative frozen run root is absent: {run_root}")
    orchestrator = frozen_context["orchestratorInputs"]
    if Path(__file__).resolve() != Path(orchestrator["runner"]["frozenPath"]):
        parser.error("only the frozen runner may execute the differential gate")
    verify_captured_file(orchestrator["runner"])
    verify_captured_file(orchestrator["helper"])

    aggregate_path = run_root / "aggregate.json"
    partial_path = run_root / "aggregate.partial.json"
    state: dict[str, Any] = {
        "schemaVersion": AGGREGATE_SCHEMA,
        "status": "running",
        "startedAt": utc_now(),
        "runRoot": str(run_root),
        "configuration": {
            "projects": args.projects,
            "templateCoordinate": args.template,
            "buildEpochSecs": args.build_epoch,
            "sourceCache": str(args.source_cache.resolve()),
            "keepCache": args.keep_cache,
            "freshProcessesPerGuide": True,
            "canonicalApi": "prepare_project -> outputs/render/finalize",
        },
        "cases": {},
    }
    atomic_json(partial_path, state)

    def terminate(signum, _frame):
        raise TerminationRequested(signum)

    def interrupt(signum, _frame):
        raise KeyboardInterruptRequested(signum)

    previous_sigterm = signal.signal(signal.SIGTERM, terminate)
    previous_sigint = signal.signal(signal.SIGINT, interrupt)
    try:
        helpers = load_native_helpers(Path(orchestrator["helper"]["frozenPath"]))
        state["host"] = helpers.host_provenance()
        state["provenance"] = {
            "editorObserved": helpers.git_state(editor),
            "orchestratorInputs": orchestrator,
        }
        test_binary = build_frozen_test_binary(engine, run_root, helpers)
        state["provenance"]["testBinary"] = test_binary
        catalog_inputs = freeze_catalog_inputs(editor, run_root, args.projects, helpers)
        state["provenance"]["catalogInputs"] = catalog_inputs
        frozen_editor = Path(catalog_inputs["editorRoot"])
        fixtures = helpers.prepare_fixtures(frozen_editor, run_root, args.projects)
        state["fixtures"] = fixtures
        cache = helpers.create_cache_overlay(
            frozen_editor, engine, run_root, args.source_cache.resolve()
        )
        cache["resolverViewUsesHardlinks"] = True
        cache["consumedAsStableCarrierSnapshots"] = True
        state["cache"] = cache
        atomic_json(partial_path, state)

        mutations_root = run_root / "mutations"
        mutations_root.mkdir()
        cases_root = run_root / "case-inputs"
        cases_root.mkdir()
        reports_root = run_root / "receipts"
        reports_root.mkdir()
        logs_root = run_root / "logs"
        logs_root.mkdir()
        package_carrier_store = run_root / "package-carriers/sha256"
        package_carrier_store.mkdir(parents=True)
        package_carriers: dict[str, dict[str, Any]] = {}
        carrier_objects: dict[str, dict[str, Any]] = {}

        for project in args.projects:
            descriptor = CASES[project]
            source_a = Path(fixtures[project]["sourceDir"]).resolve()
            source_b = (mutations_root / project / "B").resolve()
            source_b.parent.mkdir(parents=True)
            if helpers.tree_identity(source_a) != fixtures[project]["identity"]:
                raise DifferentialFailure(f"{project} source A changed before mutation")
            mutation = mutate_fixture(source_a, source_b, descriptor, helpers)
            identity_b = helpers.tree_identity(source_b)
            if identity_b["treeSha256"] == fixtures[project]["identity"]["treeSha256"]:
                raise DifferentialFailure(f"{project} A/B source identities did not change")

            report = reports_root / f"{project}.json"
            case_file = cases_root / f"{project}.json"
            case_value = {
                "schemaVersion": CASE_SCHEMA,
                "caseId": project,
                "sourceA": str(source_a),
                "sourceB": str(source_b),
                "packageCache": cache["overlayPath"],
                "packageCarrierStore": str(package_carrier_store),
                "report": str(report),
                "expectedChangedOutput": descriptor["output"],
                "expectCompilationChange": descriptor["compilation"],
                "expectSnapshotPartialReuse": descriptor["snapshotPartial"],
                "templateCoordinate": args.template,
                "buildEpochSecs": args.build_epoch,
                "fixture": {
                    "origin": fixtures[project]["origin"],
                    "sourceA": fixtures[project]["identity"],
                    "sourceB": identity_b,
                    "mutation": mutation,
                },
            }
            atomic_json(case_file, case_value)

            command = [
                test_binary["path"],
                "prepare::incremental_differential::catalog_case",
                "--exact",
                "--ignored",
                "--nocapture",
            ]
            stdout_path = logs_root / f"{project}.stdout"
            stderr_path = logs_root / f"{project}.stderr"
            environment = os.environ.copy()
            environment["FIG_DIFFERENTIAL_CASE_JSON"] = str(case_file)
            print(f"[incremental-differential] {project}: running exhaustive comparison", flush=True)
            with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
                completed = run_managed_process(
                    command,
                    cwd=test_binary["sourceSnapshot"]["path"],
                    env=environment,
                    stdout=stdout,
                    stderr=stderr,
                )
            record: dict[str, Any] = {
                "case": str(case_file.relative_to(run_root)),
                "receipt": str(report.relative_to(run_root)),
                "stdout": str(stdout_path.relative_to(run_root)),
                "stderr": str(stderr_path.relative_to(run_root)),
                "exitCode": completed.returncode,
            }
            if completed.returncode != 0:
                if report.is_file():
                    record["result"] = json.loads(report.read_text(encoding="utf-8"))
                state["cases"][project] = record
                atomic_json(partial_path, state)
                raise DifferentialFailure(
                    f"{project} Rust differential exited {completed.returncode}; "
                    f"see {stdout_path} and {stderr_path}"
                )
            record["result"] = validate_case_receipt(report, project)
            if helpers.tree_identity(source_a) != fixtures[project]["identity"]:
                raise DifferentialFailure(f"{project} source A changed during comparison")
            if helpers.tree_identity(source_b) != identity_b:
                raise DifferentialFailure(f"{project} source B changed during comparison")
            for carrier in record["result"]["packageCorpus"]["carriers"]:
                label = carrier["label"]
                content = carrier["content"]
                prior = package_carriers.get(label)
                if prior is not None and prior != content:
                    raise DifferentialFailure(
                        f"package carrier {label} changed between guide processes"
                    )
                package_carriers[label] = content
                digest = content["sha256"]
                prior_object = carrier_objects.get(digest)
                if prior_object is not None and prior_object != content:
                    raise DifferentialFailure(
                        f"package carrier object {digest} has inconsistent metadata"
                    )
                object_path = package_carrier_store / digest
                if object_path.is_symlink() or not object_path.is_file():
                    raise DifferentialFailure(
                        f"retained package carrier object is absent: {object_path}"
                    )
                if (
                    object_path.stat().st_size != content["byteLength"]
                    or helpers.sha256_file(object_path) != digest
                ):
                    raise DifferentialFailure(
                        f"retained package carrier object fails ContentRef: {object_path}"
                    )
                carrier_objects[digest] = content
            state["cases"][project] = record
            atomic_json(partial_path, state)
            outputs = record["result"]["executions"]["freshAForward"]["outputPaths"]
            print(f"[incremental-differential] {project}: PASS ({outputs} outputs each direction)", flush=True)

        verify_frozen_build(test_binary, helpers)
        verify_captured_file(orchestrator["runner"])
        verify_captured_file(orchestrator["helper"])
        for capture in catalog_inputs["artifacts"]:
            verify_captured_file(capture)
        state["packageCarrierConsistency"] = {
            "coordinateCount": len(package_carriers),
            "sameLabelSameContentRef": True,
            "carriers": [
                {"label": label, "content": content}
                for label, content in sorted(package_carriers.items())
            ],
        }
        carrier_entries = list(package_carrier_store.iterdir())
        if any(path.is_symlink() or not path.is_file() for path in carrier_entries):
            raise DifferentialFailure(
                "retained package carrier store contains a non-regular object"
            )
        actual_carrier_objects = {path.name for path in carrier_entries}
        if actual_carrier_objects != set(carrier_objects):
            raise DifferentialFailure(
                "retained package carrier store does not exactly cover referenced objects"
            )
        for digest, content in carrier_objects.items():
            object_path = package_carrier_store / digest
            if (
                object_path.stat().st_size != content["byteLength"]
                or helpers.sha256_file(object_path) != digest
            ):
                raise DifferentialFailure(
                    f"retained package carrier changed before publication: {object_path}"
                )
            object_path.chmod(stat.S_IMODE(object_path.stat().st_mode) & ~0o222)
        state["packageCarrierObjects"] = {
            "path": str(package_carrier_store.relative_to(run_root)),
            "objectCount": len(carrier_objects),
            "referencedCoordinateCount": len(package_carriers),
            "totalBytes": sum(
                content["byteLength"] for content in carrier_objects.values()
            ),
            "allContentRefsVerified": True,
            "exactCoverage": True,
            "objectsPublishedReadOnly": True,
        }
        state["status"] = "pass"
        state["completedAt"] = utc_now()
        state["caseCount"] = len(args.projects)
        state["allComparisonsPassed"] = True
        if not args.keep_cache:
            shutil.rmtree(Path(cache["overlayPath"]))
            state["cache"]["overlayRemovedAfterSuccess"] = True
        else:
            state["cache"]["overlayRemovedAfterSuccess"] = False
        atomic_json(aggregate_path, state)
        partial_path.unlink(missing_ok=True)
        print(f"INCREMENTAL DIFFERENTIAL GATE: PASS ({aggregate_path})")
        return 0
    except (Exception, KeyboardInterrupt) as error:
        interrupted = isinstance(error, (KeyboardInterrupt, TerminationRequested))
        cargo_target = run_root / "cargo-target"
        cargo_target_removed = not cargo_target.exists()
        if not cargo_target_removed:
            shutil.rmtree(cargo_target, ignore_errors=True)
            cargo_target_removed = not cargo_target.exists()
        state["status"] = "fail"
        state["completedAt"] = utc_now()
        state["termination"] = {
            "interrupted": interrupted,
            "signal": getattr(error, "signum", None),
            "privateCargoTargetRemoved": cargo_target_removed,
        }
        state["failure"] = {
            "type": type(error).__name__,
            "message": str(error) or type(error).__name__,
            "traceback": traceback.format_exc(),
        }
        atomic_json(partial_path, state)
        atomic_json(run_root / "failure.json", state)
        print(f"[incremental-differential] FAIL: {error}", file=sys.stderr)
        print(f"[incremental-differential] evidence preserved at {run_root}", file=sys.stderr)
        if isinstance(error, KeyboardInterrupt):
            return 130
        if isinstance(error, TerminationRequested):
            return 128 + error.signum
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        signal.signal(signal.SIGINT, previous_sigint)


if __name__ == "__main__":
    raise SystemExit(main())
