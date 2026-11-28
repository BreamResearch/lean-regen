"""Measure the ERP transfer API and a separate contiguous account-row batch API."""

import argparse
from array import array
import ctypes
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import random
import resource
import shutil
import statistics
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import policy_gate  # noqa: E402

FIELDS = (
    "budget",
    "hours",
    "budgetIn",
    "hoursIn",
    "budgetOut",
    "hoursOut",
    "minBudget",
    "minHours",
    "maxBudget",
    "maxHours",
    "committedBudget",
    "committedHours",
    "closed",
    "locked",
)
UINT_MAX = (1 << 32) - 1
TRANSFER_SEED = 837209
ROW_SEED = 941103
ARMS = (
    "python-transfer",
    "native-transfer",
    "native-batch",
    "numpy-batch",
    "numpy-columnar-batch",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n"
    )


def settings(quick):
    if quick:
        return dict(
            transfers=256, transferPasses=2, rows=1024, batchPasses=32, repeats=3
        )
    return dict(
        transfers=4096, transferPasses=3, rows=16384, batchPasses=128, repeats=7
    )


def transfers(n):
    rng = random.Random(TRANSFER_SEED)
    cap = policy_gate.MAX_AMOUNT
    opening = (900_000, 700_000)
    for i in range(n):
        b, h = rng.randint(1, 500), rng.randint(1, 250)
        other = (rng.randint(800, 1_900_000), rng.randint(800, 1_900_000))
        # Equality at both floors, single failures, compound failures and wide Python inputs.
        cases = (
            (opening, other, b, h),
            ((100 + b, 40 + h), other, b, h),
            ((99 + b, 40 + h), other, b, h),
            ((100 + b, 39 + h), other, b, h),
            (opening, (cap - b, cap - h), b, h),
            (opening, (cap - b + 1, cap - h), b, h),
            (opening, (cap - b, cap - h + 1), b, h),
            ((100, 40), (cap, cap), b, h),
        )
        if i % 97 == 0:
            yield (opening, other, 2**53 + 1, UINT_MAX + 1)
        else:
            yield cases[i % len(cases)]


def rows(n):
    rng = random.Random(ROW_SEED)
    for i in range(n):
        row = [rng.getrandbits(32) for _ in range(12)] + [i % 2, (i // 2) % 2]
        if i % 8 == 0:
            row[:12] = [UINT_MAX] * 12  # Equality even though all sums exceed uint32.
        elif i % 8 == 1:
            row[:12] = [0] * 12
        elif i % 8 == 2:
            row[:12] = [UINT_MAX, 0, 1, 0, 0, 1, 0, 0, UINT_MAX, UINT_MAX, 0, 0]
        yield row


def compact_rows(n):
    data = array("I")
    if data.itemsize != 4:
        raise RuntimeError("Expected four-byte native unsigned int")
    for row in rows(n):
        data.extend(row)
    return data


def row_digest(data):
    if sys.byteorder != "little":
        data = array(data.typecode, data)
        data.byteswap()
    return digest(data)


def reference_mask(values):
    row = dict(zip(FIELDS, values))
    return sum(
        1 << pos
        for pos, rule in enumerate(policy_gate.rules())
        if policy_gate.evaluate(rule["fail"], row)
    )


def numpy_kernel(data, output, columnar):
    import numpy as np

    n = len(output)
    mat = np.frombuffer(data, dtype=np.uint32).reshape(n, 14)
    columns = mat.T
    layout_bytes = layout_ns = 0
    if columnar:
        start = time.perf_counter_ns()
        columns = np.ascontiguousarray(columns)
        layout_ns = time.perf_counter_ns() - start
        layout_bytes = columns.nbytes
    out = np.frombuffer(output, dtype=np.uint8)
    left, right = (np.empty(n, dtype=np.uint64) for _ in range(2))
    failed = np.empty(n, dtype=np.bool_)
    bit = np.empty(n, dtype=np.uint8)

    def append(mask):
        np.multiply(failed, mask, out=bit, dtype=np.uint8)
        np.bitwise_or(out, bit, out=out)

    def run():
        np.equal(columns[12], 1, out=failed)
        np.copyto(out, failed, casting="unsafe")
        np.logical_or(columns[4], columns[5], out=failed)
        np.logical_and(failed, columns[13], out=failed)
        append(2)
        for k in (0, 1):
            np.add(columns[k], columns[k + 2], out=left, dtype=np.uint64)
            np.maximum(columns[k + 6], columns[k + 10], out=right)
            np.add(right, columns[k + 4], out=right)
            np.less(left, right, out=failed)
            append(4 << k)
            np.add(columns[k + 4], columns[k + 8], out=right, dtype=np.uint64)
            np.greater(left, right, out=failed)
            append(16 << k)

    scratch = sum(x.nbytes for x in (left, right, failed, bit))
    return run, np.__version__, scratch, layout_bytes, layout_ns


def elapsed(operation):
    cpu = time.process_time_ns()
    wall = time.perf_counter_ns()
    value = operation()
    return value, time.perf_counter_ns() - wall, time.process_time_ns() - cpu


def worker(arm, library, cfg):
    version = None
    scratch = layout_bytes = layout_ns = None
    if arm.startswith("native"):
        from bridge import NativeGuard

        native = NativeGuard(library)
    if arm.endswith("transfer"):
        check = (
            policy_gate.check_transfer
            if arm == "python-transfer"
            else native.check_transfer
        )
        inputs = list(transfers(cfg["transfers"]))

        def replay():
            accepted = 0
            for args in inputs:
                accepted += check(*args)["accepted"]
            return accepted

        expected_accepted = replay()
        passes = cfg["transferPasses"]

        def timed():
            return sum(replay() for _ in range(passes))

        accepted, wall, cpu = elapsed(timed)
        if accepted != expected_accepted * passes:
            raise RuntimeError("Timed accepted count changed")
        # Outside timing, include all ordered reasons, both balances and the decision.
        sha = hashlib.sha256()
        for args in inputs:
            sha.update(encoded(check(*args)))
        output_sha = sha.hexdigest()
        calls = passes * len(inputs)
    else:
        n = cfg["rows"]
        data = compact_rows(n)
        output = bytearray(n)
        if arm.startswith("numpy-"):
            run, version, scratch, layout_bytes, layout_ns = numpy_kernel(
                data, output, arm == "numpy-columnar-batch"
            )
        else:
            input_view = (ctypes.c_uint32 * len(data)).from_buffer(data)
            output_view = (ctypes.c_uint8 * n).from_buffer(output)

            def run():
                native.batch_masks(input_view, n, output_view)

        run()
        passes = cfg["batchPasses"]

        def timed():
            for _ in range(passes):
                run()

        _, wall, cpu = elapsed(timed)
        output_sha = digest(output)
        calls = passes * n
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "wallNs": wall,
        "cpuNs": cpu,
        "operations": calls,
        "peakRssBytes": rss if sys.platform == "darwin" else rss * 1024,
        "resultSha256": output_sha,
        "numpyVersion": version,
        "numpyReusableScratchBytes": scratch,
        "numpyAdditionalLayoutBytes": layout_bytes,
        "numpyLayoutConversionWallNs": layout_ns,
    }


def overview(samples):
    def stats(vals):
        return {"min": min(vals), "median": statistics.median(vals), "max": max(vals)}

    return {
        "wallNsPerOperation": stats([s["wallNs"] / s["operations"] for s in samples]),
        "cpuNsPerOperation": stats([s["cpuNs"] / s["operations"] for s in samples]),
        "operationsPerSecond": stats(
            [1e9 * s["operations"] / s["wallNs"] for s in samples]
        ),
        "peakRssBytes": stats([s["peakRssBytes"] for s in samples]),
        "samples": samples,
    }


def tool(command, cwd=None):
    if not shutil.which(command[0]):
        return None
    p = subprocess.run(command, capture_output=True, cwd=cwd, check=False)
    return p.stdout.decode(errors="replace").strip() if p.returncode == 0 else None


def inspect_library(library):
    darwin = sys.platform == "darwin"
    disasm = tool(
        ["otool", "-tvV", library.name] if darwin else ["objdump", "-d", library.name],
        cwd=library.parent,
    )
    deps = tool(
        ["otool", "-L", library.name] if darwin else ["readelf", "-d", library.name],
        cwd=library.parent,
    )
    sizes = tool(["size", "-m" if darwin else "-A", library.name], cwd=library.parent)
    arch = tool(["file", "-b", library.name], cwd=library.parent)
    text_bytes = None
    for line in (sizes or "").splitlines():
        fields = line.split()
        if darwin and line.strip().startswith(
            ("Section __text:", "Section (__TEXT, __text):")
        ):
            text_bytes = int(fields[-1])
        elif not darwin and fields and fields[0] == ".text":
            text_bytes = int(fields[1])
    return {
        "fileName": library.name,
        "bytes": library.stat().st_size,
        "sha256": digest(library.read_bytes()),
        "format": arch,
        "machineTextBytes": text_bytes,
        "dynamicDependencies": [
            line.strip()
            for line in (deps or "").splitlines()[2 if darwin else 0 :]
            if ("(compatibility version" in line if darwin else "(NEEDED)" in line)
        ],
        "disassemblyTextBytes": len(disasm.encode()) if disasm else None,
        "disassemblyTextSha256": digest(disasm.encode()) if disasm else None,
        "disassemblyCommand": "otool -tvV" if darwin else "objdump -d",
    }


def cpu_description():
    if sys.platform == "darwin":
        return tool(["sysctl", "-n", "machdep.cpu.brand_string"]) or platform.machine()
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.is_file():
        for line in cpuinfo.read_text().splitlines():
            key, _, value = line.partition(":")
            if key.strip() in ("model name", "Hardware"):
                return value.strip()
    return platform.processor()


def measure(args):
    cfg = settings(args.quick)
    lib = args.library.resolve(strict=True)
    available = importlib.util.find_spec("numpy") is not None
    if args.numpy == "required" and not available:
        raise RuntimeError("Required NumPy is unavailable in this Python")
    arms = [
        arm
        for arm in ARMS
        if not arm.startswith("numpy-") or (available and args.numpy != "off")
    ]
    samples = {arm: [] for arm in arms}
    transfer_input = hashlib.sha256()
    transfer_out = hashlib.sha256()
    accepted = fallback = 0
    for args_in in transfers(cfg["transfers"]):
        transfer_input.update(encoded(args_in))
        full = policy_gate.check_transfer(*args_in)
        transfer_out.update(encoded(full))
        accepted += full["accepted"]
        fallback += int(max(args_in[2:]) > UINT_MAX)
    words = compact_rows(cfg["rows"])
    masks = bytes(reference_mask(row) for row in rows(cfg["rows"]))
    expected = {"transfer": transfer_out.hexdigest(), "batch": digest(masks)}
    orders = []
    for repeat in range(cfg["repeats"]):
        order = arms[repeat % len(arms) :] + arms[: repeat % len(arms)]
        orders.append(order)
        for arm in order:
            cmd = [
                sys.executable,
                "-B",
                str(Path(__file__).resolve()),
                "--worker",
                arm,
                "--library",
                str(lib),
            ]
            if args.quick:
                cmd.append("--quick")
            result = json.loads(subprocess.check_output(cmd))
            if result["resultSha256"] != expected[arm.rsplit("-", 1)[1]]:
                raise ValueError(f"{arm} result digest differs from the frozen policy")
            samples[arm].append(result)

    results = {key: overview(value) for key, value in samples.items()}

    def paired_ratio(a, b):
        ratios = [x["wallNs"] / y["wallNs"] for x, y in zip(samples[a], samples[b])]
        return {
            "median": statistics.median(ratios),
            "min": min(ratios),
            "max": max(ratios),
            "byRound": ratios,
        }

    source = (
        HERE / "measure.py",
        HERE / "bridge.py",
        HERE / "guard.c",
        HERE / "guard.h",
        HERE.parent / "policy_gate.py",
    )
    compiler = tool([os.environ.get("CC", "cc"), "--version"])
    return {
        "schema": "knot-native-local-measurement-v1",
        "completedUtc": datetime.now(timezone.utc).isoformat(),
        "mode": "quick" if args.quick else "full",
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu": cpu_description(),
            "logicalCpus": os.cpu_count(),
            "affinityCpus": len(os.sched_getaffinity(0))
            if hasattr(os, "sched_getaffinity")
            else None,
            "python": platform.python_version(),
            "pythonImplementation": platform.python_implementation(),
            "visibleCompiler": compiler.splitlines()[0] if compiler else None,
        },
        "library": inspect_library(lib),
        "source": {
            p.name: {"bytes": p.stat().st_size, "sha256": digest(p.read_bytes())}
            for p in source
        },
        "method": {
            "config": cfg,
            "orderByRound": orders,
            "policySha256": policy_gate.POLICY_HASH,
            "scalar": "One complete ERP Python call produces the full dictionary; the timed consumer counts acceptances. Canonical JSON of every full result is checked outside timing.",
            "batch": "One call for the whole warmed, contiguous uint32 row-major input and reusable uint8 output. NumPy widens sums to uint64 and reuses scratch arrays. numpy-batch views the same interleaved rows. numpy-columnar-batch makes one contiguous transposed copy outside timing and reports the copy cost and storage. Division by row count gives per-account throughput.",
            "memory": "Fresh subprocess for each backend and round; process-lifetime peak RSS includes interpreter, imports, constructed inputs and warmed execution. Scratch is an explicit array-byte count.",
            "timing": "One complete dataset warm-up before each sample. Each round rotates backend order. Wall and process CPU exclude startup, preparation and output verification. Corpus and outputs are reused across passes.",
            "scope": "Transfer latency and independent batch throughput; excludes database, RPC, UI, compile and cold-start time.",
            "ratio": "Median, min and max of paired elapsed wall-time ratios for the same round.",
        },
        "corpus": {
            "transfer": {
                "generatorSeed": TRANSFER_SEED,
                "count": cfg["transfers"],
                "accepted": accepted,
                "rejected": cfg["transfers"] - accepted,
                "wideFallbackCount": fallback,
                "inputSha256": transfer_input.hexdigest(),
                "fullResultSha256": expected["transfer"],
            },
            "batch": {
                "generatorSeed": ROW_SEED,
                "count": len(masks),
                "fieldOrder": FIELDS,
                "canonicalInput": "little-endian uint32 in row-major order, two flags encoded 0 or 1",
                "inputSha256": row_digest(words),
                "maskSha256": expected["batch"],
                "accepted": masks.count(0),
                "distinctMasks": len(set(masks)),
            },
        },
        "backends": results,
        "numpyStatus": "measured"
        if "numpy-batch" in arms
        else ("disabled" if args.numpy == "off" else "unavailable"),
        "ratios": {
            "pythonOverNativeTransferWall": paired_ratio(
                "python-transfer", "native-transfer"
            ),
            "numpyColumnarOverNativeBatchWall": paired_ratio(
                "numpy-columnar-batch", "native-batch"
            )
            if "numpy-columnar-batch" in arms
            else None,
            "numpyOverNativeBatchWall": paired_ratio("numpy-batch", "native-batch")
            if "numpy-batch" in arms
            else None,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--numpy", choices=("auto", "off", "required"), default="auto")
    parser.add_argument("--worker", choices=ARMS, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker, args.library, settings(args.quick))))
        return
    if not args.out:
        parser.error("--out is required")
    result = measure(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(result["ratios"]))


if __name__ == "__main__":
    main()
