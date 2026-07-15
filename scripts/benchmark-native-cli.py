#!/usr/bin/env python3
"""Benchmark the native Fig four-operation lifecycle against catalog IGs.

This is a host benchmark, not a second build implementation.  Each measured
operation invokes the release `fig` binary in a new process and uses only the
public prepare/outputs/render/finalize commands.  Inputs and the package cache
are copied into an isolated run directory under vendor/sushi-rs/target; the
user's ~/.fhir tree is never read or written.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tarfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


SCHEMA = "native-cli-benchmark/v1"
TARGET = "publisher-site/v1"
DEFAULT_TEMPLATE = "hl7.fhir.template#1.0.0"
DEFAULT_EPOCH = 1_783_555_200
PROJECTS = {
    "tiny": {
        "kind": "manifest",
        "input": "app/public/data/tiny/manifest.json",
        "page": "en/StructureDefinition-editor-user.html",
    },
    "ips": {
        "kind": "tgz",
        "input": "app/public/data/ips/source.tgz",
        "metadata": "app/public/data/ips/source.json",
        "page": "en/StructureDefinition-IPSSectionsLM-mappings.html",
    },
    "uscore": {
        "kind": "tgz",
        "input": "app/public/data/uscore/source.tgz",
        "metadata": "app/public/data/uscore/source.json",
        "page": "en/StructureDefinition-us-core-careplan.html",
    },
    "mcode": {
        "kind": "tgz",
        "input": "app/public/data/mcode/source.tgz",
        "metadata": "app/public/data/mcode/source.json",
        "page": "en/StructureDefinition-mcode-cancer-patient.html",
    },
}


class BenchmarkFailure(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def relative(path: Path, root: Path) -> str:
    return str(path.relative_to(root))


def command_text(args: list[str]) -> str:
    import shlex

    return " ".join(shlex.quote(value) for value in args)


def checked_output(args: list[str], cwd: Path) -> str:
    completed = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


def git_state(repo: Path) -> dict[str, Any]:
    status = checked_output(["git", "status", "--porcelain=v1"], repo)
    diff = subprocess.run(
        ["git", "diff", "--binary", "HEAD"],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    untracked_raw = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    untracked = []
    for raw in untracked_raw.split(b"\0"):
        if not raw:
            continue
        name = raw.decode("utf-8")
        path = repo / name
        if path.is_file():
            untracked.append(
                {"path": name, "bytes": path.stat().st_size, "sha256": sha256_file(path)}
            )
    return {
        "path": str(repo),
        "head": checked_output(["git", "rev-parse", "HEAD"], repo),
        "status": status.splitlines(),
        "trackedDiffSha256": sha256_bytes(diff),
        "untracked": untracked,
    }


def host_provenance() -> dict[str, Any]:
    cpu_model = None
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        for line in cpuinfo.read_text(errors="replace").splitlines():
            if line.lower().startswith("model name") and ":" in line:
                cpu_model = line.split(":", 1)[1].strip()
                break
    memory_bytes = None
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        for line in meminfo.read_text(errors="replace").splitlines():
            if line.startswith("MemTotal:"):
                memory_bytes = int(line.split()[1]) * 1024
                break
    return {
        "platform": platform.platform(),
        "uname": " ".join(platform.uname()),
        "cpuCount": os.cpu_count(),
        "cpuModel": cpu_model,
        "memoryBytes": memory_bytes,
        "python": platform.python_version(),
        "rustc": shutil.which("rustc") and subprocess.run(
            ["rustc", "--version"], capture_output=True, text=True
        ).stdout.strip(),
        "cargo": shutil.which("cargo") and subprocess.run(
            ["cargo", "--version"], capture_output=True, text=True
        ).stdout.strip(),
    }


def safe_archive_member(name: str) -> None:
    value = PurePosixPath(name)
    if value.is_absolute() or ".." in value.parts:
        raise BenchmarkFailure(f"archive contains unsafe path {name!r}")


def extract_tgz(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            safe_archive_member(member.name)
            if not (member.isfile() or member.isdir()):
                raise BenchmarkFailure(
                    f"archive {archive} contains unsupported member {member.name!r}"
                )
        bundle.extractall(destination, filter="data")


def safe_source_path(root: Path, name: str) -> Path:
    relative_path = PurePosixPath(name)
    if relative_path.is_absolute() or ".." in relative_path.parts or not relative_path.parts:
        raise BenchmarkFailure(f"source manifest contains unsafe path {name!r}")
    path = root.joinpath(*relative_path.parts)
    if not path.resolve().is_relative_to(root.resolve()):
        raise BenchmarkFailure(f"source manifest path escapes fixture root: {name!r}")
    return path


def extract_manifest(manifest_path: Path, destination: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    destination.mkdir(parents=True, exist_ok=False)
    files = manifest.get("files", {})
    binary_files = manifest.get("binaryFiles", {})
    if not isinstance(files, dict) or not isinstance(binary_files, dict):
        raise BenchmarkFailure(f"invalid source manifest {manifest_path}")
    for name, text in files.items():
        if not isinstance(text, str):
            raise BenchmarkFailure(f"source manifest text is not a string: {name}")
        path = safe_source_path(destination, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    for name, encoded in binary_files.items():
        if not isinstance(encoded, str):
            raise BenchmarkFailure(f"source manifest binary is not a string: {name}")
        path = safe_source_path(destination, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(encoded, validate=True))
    expected = manifest.get("fileCount")
    actual = len(files) + len(binary_files)
    if expected != actual:
        raise BenchmarkFailure(
            f"source manifest count mismatch for {manifest_path}: {expected} != {actual}"
        )
    return manifest


def tree_identity(root: Path) -> dict[str, Any]:
    rows = []
    total = 0
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise BenchmarkFailure(f"fixture contains a symlink: {path}")
        if not path.is_file():
            continue
        name = path.relative_to(root).as_posix()
        size = path.stat().st_size
        total += size
        rows.append((name, size, sha256_file(path)))
    encoded = "".join(f"{name}\t{size}\t{digest}\n" for name, size, digest in rows)
    return {
        "fileCount": len(rows),
        "bytes": total,
        "treeSha256": sha256_bytes(encoded.encode()),
        "files": [
            {"path": name, "bytes": size, "sha256": digest}
            for name, size, digest in rows
        ],
    }


def prepare_fixtures(
    editor: Path, run_root: Path, projects: list[str]
) -> dict[str, Any]:
    source_root = run_root / "sources"
    source_root.mkdir()
    fixtures: dict[str, Any] = {}
    for project in projects:
        descriptor = PROJECTS[project]
        source = editor / descriptor["input"]
        destination = source_root / project
        if descriptor["kind"] == "manifest":
            manifest = extract_manifest(source, destination)
            origin = {
                "kind": "manifest",
                "path": str(source),
                "bytes": source.stat().st_size,
                "sha256": sha256_file(source),
                "declaredFileCount": manifest["fileCount"],
            }
        else:
            metadata_path = editor / descriptor["metadata"]
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            digest = sha256_file(source)
            size = source.stat().st_size
            if metadata.get("sha256") != digest or metadata.get("bytes") != size:
                raise BenchmarkFailure(
                    f"catalog metadata disagrees with {source}: "
                    f"{metadata.get('sha256')}/{metadata.get('bytes')} != {digest}/{size}"
                )
            extract_tgz(source, destination)
            origin = {
                "kind": "tgz",
                "path": str(source),
                "metadataPath": str(metadata_path),
                "catalogRef": metadata.get("ref"),
                "bytes": size,
                "sha256": digest,
                "declaredFileCount": metadata.get("files"),
            }
        identity = tree_identity(destination)
        if origin.get("declaredFileCount") != identity["fileCount"]:
            raise BenchmarkFailure(
                f"extracted {project} file count disagrees with catalog: "
                f"{identity['fileCount']} != {origin.get('declaredFileCount')}"
            )
        if not (destination / "sushi-config.yaml").is_file():
            raise BenchmarkFailure(f"{project} fixture has no sushi-config.yaml")
        fixtures[project] = {
            "sourceDir": str(destination),
            "renderPath": descriptor["page"],
            "origin": origin,
            "identity": identity,
        }
    return fixtures


def cache_inventory(cache: Path) -> dict[str, Any]:
    rows = []
    invalid = []
    for path in sorted(cache.iterdir(), key=lambda item: item.name):
        if not path.is_dir():
            continue
        package_json = path / "package" / "package.json"
        if not package_json.is_file():
            invalid.append(path.name)
            continue
        rows.append(
            {
                "label": path.name,
                "packageJsonBytes": package_json.stat().st_size,
                "packageJsonSha256": sha256_file(package_json),
            }
        )
    canonical = "".join(
        f"{row['label']}\t{row['packageJsonBytes']}\t{row['packageJsonSha256']}\n"
        for row in rows
    )
    return {
        "coordinateCount": len(rows),
        "inventorySha256": sha256_bytes(canonical.encode()),
        "coordinates": rows,
        "directoriesWithoutPackageJson": invalid,
    }


def create_cache_overlay(
    editor: Path, engine: Path, run_root: Path, source_cache: Path
) -> dict[str, Any]:
    source_cache = source_cache.resolve()
    user_fhir = (Path.home() / ".fhir").resolve()
    if source_cache == user_fhir or source_cache.is_relative_to(user_fhir):
        raise BenchmarkFailure("refusing to read or copy the user's ~/.fhir tree")
    if not source_cache.is_dir():
        raise BenchmarkFailure(
            f"explicit source package cache does not exist: {source_cache}"
        )
    overlay = run_root / "package-cache"
    if overlay.parent.stat().st_dev != source_cache.stat().st_dev:
        raise BenchmarkFailure(
            "source package cache and engine target are on different filesystems; "
            "the benchmark requires an isolated hardlinked overlay"
        )
    overlay.mkdir()
    copy_log = run_root / "cache-hardlink.log"
    with copy_log.open("wb") as log:
        completed = subprocess.run(
            ["cp", "-al", f"{source_cache}/.", f"{overlay}/"],
            cwd=engine,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    if completed.returncode != 0:
        raise BenchmarkFailure(f"hardlink cache overlay failed; see {copy_log}")

    bundles = []
    replaced = set()
    for archive in sorted((editor / "app/public/data/bundles").glob("*.tgz")):
        label = archive.name.removesuffix(".tgz")
        if not label or "/" in label or "\\" in label or label in {".", ".."}:
            raise BenchmarkFailure(f"unsafe baked package label {label!r}")
        destination = overlay / label
        if destination.exists():
            shutil.rmtree(destination)
        extract_tgz(archive, destination)
        package_json = destination / "package" / "package.json"
        if not package_json.is_file():
            raise BenchmarkFailure(f"baked bundle {archive} has no package/package.json")
        replaced.add(label)
        bundles.append(
            {
                "label": label,
                "path": str(archive),
                "bytes": archive.stat().st_size,
                "sha256": sha256_file(archive),
            }
        )

    hardlink_verified = False
    for package in sorted(source_cache.iterdir(), key=lambda item: item.name):
        if package.name in replaced:
            continue
        before = package / "package" / "package.json"
        after = overlay / package.name / "package" / "package.json"
        if before.is_file() and after.is_file():
            left, right = before.stat(), after.stat()
            hardlink_verified = left.st_dev == right.st_dev and left.st_ino == right.st_ino
            break
    if not hardlink_verified:
        raise BenchmarkFailure("cache overlay did not preserve a verifiable hardlink")

    return {
        "sourcePath": str(source_cache),
        "overlayPath": str(overlay),
        "underEngineTarget": overlay.resolve().is_relative_to((engine / "target").resolve()),
        "hardlinkVerified": hardlink_verified,
        "hardlinkLog": relative(copy_log, run_root),
        "bakedBundles": bundles,
        "sourceInventory": cache_inventory(source_cache),
        "overlayInventory": cache_inventory(overlay),
    }


def parse_envelope(path: Path, expected_op: str, expected_api: int) -> dict[str, Any]:
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise BenchmarkFailure(f"invalid JSON receipt {path}: {error}") from error
    if envelope.get("apiVersion") != expected_api:
        raise BenchmarkFailure(
            f"{path} API version {envelope.get('apiVersion')} != {expected_api}"
        )
    if envelope.get("op") != expected_op:
        raise BenchmarkFailure(f"{path} operation {envelope.get('op')!r} != {expected_op!r}")
    if envelope.get("ok") is not True:
        raise BenchmarkFailure(f"{expected_op} failed: {envelope.get('error')}")
    if "result" not in envelope:
        raise BenchmarkFailure(f"{expected_op} returned no result")
    return envelope


def run_json_operation(
    *,
    args: list[str],
    op: str,
    output: Path,
    stderr: Path,
    cwd: Path,
    expected_api: int,
    environment: dict[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    started_epoch_ms = time.time_ns() / 1_000_000
    started = time.perf_counter_ns()
    env = os.environ.copy()
    if environment:
        env.update(environment)
    with output.open("wb") as stdout_stream, stderr.open("wb") as stderr_stream:
        completed = subprocess.run(
            args,
            cwd=cwd,
            env=env,
            stdout=stdout_stream,
            stderr=stderr_stream,
        )
    duration_ms = (time.perf_counter_ns() - started) / 1_000_000
    record = {
        "operation": op,
        "command": args,
        "commandText": command_text(args),
        "startedEpochMs": round(started_epoch_ms, 3),
        "wallMs": round(duration_ms, 3),
        "exitCode": completed.returncode,
        "stdout": str(output),
        "stderr": str(stderr),
    }
    if completed.returncode != 0:
        raise BenchmarkFailure(
            f"{op} exited {completed.returncode}; see {output} and {stderr}"
        )
    envelope = parse_envelope(output, op, expected_api)
    record["envelopeOk"] = True
    return envelope, record


def require_string(value: Any, description: str, prefix: str | None = None) -> str:
    if not isinstance(value, str) or not value:
        raise BenchmarkFailure(f"{description} is missing")
    if prefix and not value.startswith(prefix):
        raise BenchmarkFailure(f"{description} does not start with {prefix}: {value}")
    return value


def validate_run(
    project: str,
    page: str,
    run_dir: Path,
    prepare: dict[str, Any],
    outputs: dict[str, Any],
    render: dict[str, Any],
    finalize: dict[str, Any],
) -> dict[str, Any]:
    prepared = prepare["result"]
    catalog = outputs["result"]
    rendered = render["result"]
    finalized = finalize["result"]
    build_id = require_string(prepared.get("buildId"), "prepare buildId", "sb1-sha256:")
    if prepared.get("target") != TARGET:
        raise BenchmarkFailure(f"{project} prepared unexpected target {prepared.get('target')}")
    if catalog.get("buildId") != build_id or finalized.get("inputBuildId") != build_id:
        raise BenchmarkFailure(f"{project} build identity changed across operations")
    output_id = require_string(finalized.get("outputId"), "final outputId", "so1-sha256:")

    declared = catalog.get("outputs")
    if not isinstance(declared, list) or not declared:
        raise BenchmarkFailure(f"{project} output catalog is empty")
    declared_paths = [item.get("path") for item in declared]
    if len(declared_paths) != len(set(declared_paths)):
        raise BenchmarkFailure(f"{project} output catalog contains duplicate paths")
    if page not in declared_paths:
        raise BenchmarkFailure(f"{project} catalog does not declare representative page {page}")

    rendered_sha = require_string(rendered.get("sha256"), "render sha256")
    if len(rendered_sha) != 64:
        raise BenchmarkFailure(f"{project} render returned malformed sha256 {rendered_sha}")
    page_file = run_dir / "rendered-page.html"
    page_bytes = page_file.read_bytes()
    if rendered.get("byteLength") != len(page_bytes) or rendered_sha != sha256_bytes(page_bytes):
        raise BenchmarkFailure(f"{project} rendered ContentRef does not match rendered bytes")

    files = finalized.get("files")
    if not isinstance(files, list) or len(files) != len(declared):
        raise BenchmarkFailure(
            f"{project} finalized {len(files) if isinstance(files, list) else 'invalid'} "
            f"files for {len(declared)} declared outputs"
        )
    file_map = {item.get("path"): item.get("content") for item in files}
    if len(file_map) != len(files) or file_map.get(page) != rendered:
        raise BenchmarkFailure(f"{project} finalized page differs from standalone render")

    site = run_dir / "site"
    receipt_path = site / "site-output.json"
    if not receipt_path.is_file():
        raise BenchmarkFailure(f"{project} final publication has no site-output.json")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt != finalized:
        raise BenchmarkFailure(f"{project} final JSON and canonical site receipt disagree")
    published_page = site / Path(*PurePosixPath(page).parts)
    if not published_page.is_file() or published_page.read_bytes() != page_bytes:
        raise BenchmarkFailure(f"{project} published page differs from standalone render")

    closed_manifest = run_dir / "build" / "site-build.json"
    if not closed_manifest.is_file():
        raise BenchmarkFailure(f"{project} prepare emitted no closed site-build.json")
    shutil.copy2(closed_manifest, run_dir / "closed-site-build.json")
    shutil.copy2(receipt_path, run_dir / "site-output.json")
    return {
        "buildId": build_id,
        "outputId": output_id,
        "catalogFiles": len(declared),
        "finalFiles": len(files),
        "finalBytes": sum(
            int(item.get("content", {}).get("byteLength", 0)) for item in files
        ),
        "renderPath": page,
        "renderBytes": len(page_bytes),
        "renderSha256": rendered_sha,
        "closedManifest": "closed-site-build.json",
        "siteOutputReceipt": "site-output.json",
    }


def stats(values: list[float]) -> dict[str, Any]:
    return {
        "count": len(values),
        "medianMs": round(statistics.median(values), 3),
        "minMs": round(min(values), 3),
        "maxMs": round(max(values), 3),
    }


def summarize(runs: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    all_values: dict[str, list[float]] = {
        name: [] for name in ("prepare", "outputs", "render", "finalize", "total")
    }
    for project, project_runs in runs.items():
        project_summary = {}
        for operation in ("prepare", "outputs", "render", "finalize"):
            values = [run["operations"][operation]["wallMs"] for run in project_runs]
            project_summary[operation] = stats(values)
            all_values[operation].extend(values)
        totals = [
            sum(run["operations"][name]["wallMs"] for name in ("prepare", "outputs", "render", "finalize"))
            for run in project_runs
        ]
        project_summary["total"] = stats(totals)
        all_values["total"].extend(totals)
        summary[project] = project_summary
    summary["allProjects"] = {
        operation: stats(values) for operation, values in all_values.items() if values
    }
    return summary


def parse_projects(raw: str) -> list[str]:
    projects = []
    for value in raw.split(","):
        project = value.strip().lower()
        if not project or project in projects:
            continue
        if project not in PROJECTS:
            raise argparse.ArgumentTypeError(
                f"unknown project {project!r}; choose from {','.join(PROJECTS)}"
            )
        projects.append(project)
    if not projects:
        raise argparse.ArgumentTypeError("select at least one project")
    return projects


def main() -> int:
    editor = Path(__file__).resolve().parent.parent
    engine = editor / "vendor/sushi-rs"
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark independent native Fig prepare/outputs/render/finalize "
            "processes; build the current release binary by default."
        )
    )
    parser.add_argument(
        "--projects",
        type=parse_projects,
        default=parse_projects("tiny,ips,uscore,mcode"),
        help="comma-separated catalog IDs (default: tiny,ips,uscore,mcode)",
    )
    parser.add_argument("--repeats", type=int, default=3, help="repeats per project (default: 3)")
    parser.add_argument(
        "--source-cache",
        type=Path,
        default=engine / "temp/fhir-home/.fhir/packages",
        help="explicit full materialized package cache; ~/.fhir is refused",
    )
    parser.add_argument("--template", default=DEFAULT_TEMPLATE)
    parser.add_argument("--build-epoch", type=int, default=DEFAULT_EPOCH)
    parser.add_argument(
        "--fig-binary",
        type=Path,
        help=(
            "use an explicitly frozen Fig binary instead of rebuilding; requires "
            "--expected-fig-sha256 and records that current source was not built"
        ),
    )
    parser.add_argument(
        "--expected-fig-sha256",
        help="required exact SHA-256 authorization for --fig-binary",
    )
    parser.add_argument(
        "--keep-artifacts",
        action="store_true",
        help="retain closed object stores and fully published sites",
    )
    parser.add_argument(
        "--keep-cache",
        action="store_true",
        help="retain the isolated hardlinked package overlay after success",
    )
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be at least 1")
    if bool(args.fig_binary) != bool(args.expected_fig_sha256):
        parser.error("--fig-binary and --expected-fig-sha256 must be supplied together")
    if args.expected_fig_sha256 and (
        len(args.expected_fig_sha256) != 64
        or any(character not in "0123456789abcdef" for character in args.expected_fig_sha256)
    ):
        parser.error("--expected-fig-sha256 must be a lowercase 64-digit SHA-256")
    if not engine.is_dir():
        parser.error(f"engine worktree is missing: {engine}")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_root = engine / "target/native-cli-benchmarks" / f"{stamp}-{os.getpid()}"
    run_root.mkdir(parents=True, exist_ok=False)
    receipt_path = run_root / "receipt.json"
    partial_path = run_root / "receipt.partial.json"
    state: dict[str, Any] = {
        "schemaVersion": SCHEMA,
        "status": "running",
        "startedAt": utc_now(),
        "runRoot": str(run_root),
        "configuration": {
            "projects": args.projects,
            "repeats": args.repeats,
            "target": TARGET,
            "template": args.template,
            "buildEpochSecs": args.build_epoch,
            "independentProcesses": True,
            "keepArtifacts": args.keep_artifacts,
            "keepCache": args.keep_cache,
            "figMode": "frozen-exact-binary" if args.fig_binary else "build-current-release",
            "expectedFigSha256": args.expected_fig_sha256,
        },
        "host": host_provenance(),
        "runs": {project: [] for project in args.projects},
        "resolutions": {},
    }
    atomic_json(partial_path, state)

    try:
        print(f"[native-cli] run root: {run_root}", flush=True)
        build_log = run_root / "build-fig.log"
        if args.fig_binary:
            fig = args.fig_binary.resolve()
            build_ms = 0.0
            built_current = False
        else:
            build_started = time.perf_counter_ns()
            build_env = os.environ.copy()
            build_env["CARGO_TARGET_DIR"] = str(engine / "target")
            with build_log.open("wb") as stream:
                build = subprocess.run(
                    ["cargo", "build", "--release", "-p", "fig"],
                    cwd=engine,
                    env=build_env,
                    stdout=stream,
                    stderr=subprocess.STDOUT,
                )
            build_ms = (time.perf_counter_ns() - build_started) / 1_000_000
            if build.returncode != 0:
                raise BenchmarkFailure(f"release Fig build failed; see {build_log}")
            fig = engine / "target/release/fig"
            built_current = True
        if not fig.is_file() or not os.access(fig, os.X_OK):
            raise BenchmarkFailure(f"release Fig binary is missing: {fig}")
        fig_sha256 = sha256_file(fig)
        if args.expected_fig_sha256 and fig_sha256 != args.expected_fig_sha256:
            raise BenchmarkFailure(
                f"frozen Fig SHA-256 {fig_sha256} != authorized {args.expected_fig_sha256}"
            )

        version_file = run_root / "fig-version.json"
        with version_file.open("wb") as stdout, (run_root / "fig-version.stderr").open("wb") as stderr:
            version_command = subprocess.run(
                [str(fig), "version", "--json"], cwd=editor, stdout=stdout, stderr=stderr
            )
        if version_command.returncode != 0:
            raise BenchmarkFailure("fig version failed")
        version_raw = json.loads(version_file.read_text(encoding="utf-8"))
        if version_raw.get("ok") is not True or version_raw.get("op") != "version":
            raise BenchmarkFailure(f"fig version envelope failed: {version_raw}")
        api_version = version_raw.get("apiVersion")
        if not isinstance(api_version, int):
            raise BenchmarkFailure("fig version has no integer apiVersion")

        state["provenance"] = {
            "editor": git_state(editor),
            "engine": git_state(engine),
            "fig": {
                "path": str(fig),
                "bytes": fig.stat().st_size,
                "sha256": fig_sha256,
                "versionReceipt": relative(version_file, run_root),
                "version": version_raw["result"],
                "builtCurrentSource": built_current,
                "releaseBuildWallMs": round(build_ms, 3),
                "releaseBuildLog": relative(build_log, run_root) if built_current else None,
            },
        }
        print(f"[native-cli] release Fig: {state['provenance']['fig']['sha256'][:12]}", flush=True)

        fixtures = prepare_fixtures(editor, run_root, args.projects)
        state["fixtures"] = fixtures
        cache = create_cache_overlay(editor, engine, run_root, args.source_cache)
        state["cache"] = cache
        cache_path = Path(cache["overlayPath"])
        atomic_json(partial_path, state)

        for project in args.projects:
            project_dir = run_root / "raw" / project
            project_dir.mkdir(parents=True)
            resolve_out = project_dir / "resolve.json"
            resolve_err = project_dir / "resolve.stderr"
            resolved, resolve_record = run_json_operation(
                args=[
                    str(fig),
                    "resolve",
                    "--cache",
                    str(cache_path),
                    "--project",
                    fixtures[project]["sourceDir"],
                    "--json",
                ],
                op="resolve",
                output=resolve_out,
                stderr=resolve_err,
                cwd=editor,
                expected_api=api_version,
            )
            resolution = resolved["result"]
            if resolution.get("satisfied") is not True or resolution.get("missing") != []:
                raise BenchmarkFailure(f"{project} package resolution is incomplete: {resolution}")
            state["resolutions"][project] = {
                **resolve_record,
                "stdout": relative(resolve_out, run_root),
                "stderr": relative(resolve_err, run_root),
                "compileCount": len(resolution.get("compile_set", [])),
                "contextCount": len(resolution.get("context_closure", [])),
                "supportCount": len(resolution.get("resolution_support", [])),
            }
            print(
                f"[native-cli] {project}: resolved "
                f"{state['resolutions'][project]['compileCount']}/"
                f"{state['resolutions'][project]['contextCount']}/"
                f"{state['resolutions'][project]['supportCount']}",
                flush=True,
            )
            atomic_json(partial_path, state)

        timing_path = run_root / "timings.tsv"
        with timing_path.open("w", newline="", encoding="utf-8") as timing_stream:
            timing_writer = csv.writer(timing_stream, delimiter="\t")
            timing_writer.writerow(
                ["project", "repeat", "operation", "wall_ms", "exit_code", "stdout", "stderr"]
            )
            for project in args.projects:
                fixture = fixtures[project]
                for iteration in range(1, args.repeats + 1):
                    run_dir = run_root / "raw" / project / f"run-{iteration:03d}"
                    run_dir.mkdir()
                    operations: dict[str, Any] = {}

                    operation_args = {
                        "prepare": [
                            str(fig),
                            "prepare",
                            fixture["sourceDir"],
                            "--target",
                            TARGET,
                            "--template",
                            args.template,
                            "--cache",
                            str(cache_path),
                            "--out",
                            str(run_dir / "build"),
                            "--build-date",
                            str(args.build_epoch),
                            "--json",
                        ],
                        "outputs": [str(fig), "outputs", str(run_dir / "build"), "--json"],
                        "render": [
                            str(fig),
                            "render",
                            str(run_dir / "build"),
                            fixture["renderPath"],
                            "--out",
                            str(run_dir / "rendered-page.html"),
                            "--json",
                        ],
                        "finalize": [
                            str(fig),
                            "finalize",
                            str(run_dir / "build"),
                            "--out",
                            str(run_dir / "site"),
                            "--json",
                        ],
                    }
                    envelopes = {}
                    for operation in ("prepare", "outputs", "render", "finalize"):
                        stdout_path = run_dir / f"{operation}.json"
                        stderr_path = run_dir / f"{operation}.stderr"
                        envelope, record = run_json_operation(
                            args=operation_args[operation],
                            op=operation,
                            output=stdout_path,
                            stderr=stderr_path,
                            cwd=editor,
                            expected_api=api_version,
                            environment={"SOURCE_DATE_EPOCH": str(args.build_epoch)},
                        )
                        record["stdout"] = relative(stdout_path, run_root)
                        record["stderr"] = relative(stderr_path, run_root)
                        operations[operation] = record
                        envelopes[operation] = envelope
                        timing_writer.writerow(
                            [
                                project,
                                iteration,
                                operation,
                                record["wallMs"],
                                record["exitCode"],
                                record["stdout"],
                                record["stderr"],
                            ]
                        )
                        timing_stream.flush()
                        print(
                            f"[native-cli] {project} {iteration}/{args.repeats} "
                            f"{operation}: {record['wallMs']:.3f} ms",
                            flush=True,
                        )

                    validation = validate_run(
                        project,
                        fixture["renderPath"],
                        run_dir,
                        envelopes["prepare"],
                        envelopes["outputs"],
                        envelopes["render"],
                        envelopes["finalize"],
                    )
                    validation["artifactsRetained"] = args.keep_artifacts
                    run_record = {
                        "iteration": iteration,
                        "runDir": relative(run_dir, run_root),
                        "operations": operations,
                        "validation": validation,
                    }
                    state["runs"][project].append(run_record)
                    atomic_json(run_dir / "validation.json", validation)
                    atomic_json(partial_path, state)
                    if not args.keep_artifacts:
                        shutil.rmtree(run_dir / "build")
                        shutil.rmtree(run_dir / "site")

        state["summary"] = summarize(state["runs"])
        state["timingsTsv"] = relative(timing_path, run_root)
        state["status"] = "pass"
        state["completedAt"] = utc_now()
        if not args.keep_cache:
            shutil.rmtree(cache_path)
            state["cache"]["overlayRemovedAfterSuccess"] = True
        else:
            state["cache"]["overlayRemovedAfterSuccess"] = False
        atomic_json(receipt_path, state)
        partial_path.unlink(missing_ok=True)
        print(f"[native-cli] PASS receipt: {receipt_path}", flush=True)
        for project in args.projects:
            line = state["summary"][project]
            print(
                f"[native-cli] {project}: "
                + ", ".join(
                    f"{operation} median {line[operation]['medianMs']:.3f} ms"
                    for operation in ("prepare", "outputs", "render", "finalize")
                ),
                flush=True,
            )
        return 0
    except Exception as error:
        state["status"] = "fail"
        state["completedAt"] = utc_now()
        state["failure"] = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }
        atomic_json(run_root / "failure.json", state)
        atomic_json(partial_path, state)
        print(f"[native-cli] FAIL: {error}", file=sys.stderr)
        print(f"[native-cli] diagnostics preserved at {run_root}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
