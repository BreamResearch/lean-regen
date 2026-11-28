"""Compare the compiled guard with the original Knot policy and the Lean word oracle."""

import argparse
import ctypes
from hashlib import sha256
from itertools import chain
import json
from pathlib import Path
import random
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

import policy_gate
from native.bridge import NativeGuard, RULE_ORDER

HERE = Path(__file__).resolve().parent
KNOT = HERE.parents[1]
FORMAL = KNOT / "formal"
FIELDS = ("budget", "hours", "budgetIn", "hoursIn", "budgetOut", "hoursOut",
          "minBudget", "minHours", "maxBudget", "maxHours", "committedBudget",
          "committedHours", "closed", "locked")
WORD_MAX = 2**32 - 1
ROW = ctypes.c_uint32 * len(FIELDS)
SEED = 0x241128


def digest_file(path):
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def equal(actual, expected, context):
    if actual != expected:
        raise ValueError(f"{context}: expected {expected!r}, got {actual!r}")


def integer_mask(row):
    # Signed, unbounded post-state arithmetic gives an independent formulation
    # of the floor and ceiling tests, including transfers exceeding all stock.
    b, h, bi, hi, bo, ho, mb, mh, xb, xh, cb, ch, closed, locked = row
    budget, hours = b + bi - bo, h + hi - ho
    failed = (closed == 1, locked == 1 and (bo > 0 or ho > 0),
              budget < max(mb, cb), hours < max(mh, ch), budget > xb, hours > xh)
    return sum(int(flag) << bit for bit, flag in enumerate(failed))


def ast_mask(row):
    values = dict(zip(FIELDS, row))
    return sum(int(policy_gate.evaluate(rule["fail"], values)) << bit
               for bit, rule in enumerate(policy_gate.rules()))


def word(rng):
    return rng.choice((0, 1, 2, 2**31 - 1, 2**31, WORD_MAX - 1, WORD_MAX,
                       rng.randrange(WORD_MAX + 1)))


def row_corpus(rng):
    rows = []
    for mask in range(64):
        # Commitments can exceed a ceiling even when the minimum is zero.
        row = (10, 10, 0, 0, 5, 5, 0, 0, 4 if mask & 16 else 5, 4 if mask & 32 else 5,
               6 if mask & 4 else 0, 6 if mask & 8 else 0, mask & 1, (mask >> 1) & 1)
        equal(integer_mask(row), mask, "Constructed six-bit mask")
        rows.append(row)
    u = WORD_MAX
    rows.extend(((u, u, u, u, u, u, u, u, u, u, u, u, 0, 1),
                 (u, u, 1, 1, 0, 0, 0, 0, u, u, 0, 0, 0, 1),
                 (u, u, 0, 0, u, u, u, u, u, u, u, u, 1, 1),
                 (0, 0, 0, 0, 0, 0, 0, 0, u, u, 0, 0, 0, 1),
                 (u, 0, 0, u, 0, 0, u, u, u, u, 0, 0, 1, 1)))
    fixtures = json.loads((FORMAL / "cases.json").read_text())
    equal(tuple(fixtures["fields"]), FIELDS, "Frozen field order")
    outside = []
    for case in fixtures["rows"]:
        row = tuple(case["row"][field] for field in FIELDS)
        mask = integer_mask(row)
        equal(ast_mask(row), mask, case["name"])
        b, h, bi, hi, bo, ho = row[:6]
        expected = {"accepted": mask == 0, "budget": b if mask else b + bi - bo,
                    "hours": h if mask else h + hi - ho,
                    "reasons": [r for bit, r in enumerate(RULE_ORDER) if mask & (1 << bit)]}
        equal(expected, case["expected"], case["name"])
        if max(row) > WORD_MAX:
            outside.append(row)
        else:
            rows.append(row)
    for _ in range(8192):
        rows.append(tuple(word(rng) for _ in range(12)) + (rng.randrange(2), rng.randrange(2)))
    return rows, outside, len(fixtures["rows"])


def check_rows(guard, oracle, rows, outside, lean_scalar):
    scalar = guard.library.knot_word_mask
    scalar.argtypes = [ctypes.POINTER(ctypes.c_uint32)]
    scalar.restype = ctypes.c_uint8
    data = (ctypes.c_uint32 * (len(rows) * len(FIELDS)))(*chain.from_iterable(rows))
    output = (ctypes.c_uint8 * len(rows))()
    guard.batch_masks(data, len(rows), output)
    guard.batch_masks((ctypes.c_uint32 * 0)(), 0, (ctypes.c_uint8 * 0)())
    text = "".join(" ".join(map(str, row)) + "\n" for row in rows).encode("ascii")
    process = subprocess.run([oracle], input=text, capture_output=True, check=True, timeout=180)
    masks = [int(line) for line in process.stdout.splitlines()]
    equal(len(masks), len(rows), "Number of Lean answers")
    for index, row in enumerate(rows):
        mask = integer_mask(row)
        answers = (ast_mask(row), scalar(ROW(*row)), output[index], masks[index])
        equal(answers, (mask,) * 4, f"Row {index} {row} (AST, scalar C, batch C, Lean)")
        if lean_scalar is not None:
            equal(lean_scalar(*row), mask, f"Direct compiled Lean scalar at row {index} {row}")
    equal(set(masks), set(range(64)), "Six-bit reason mask coverage")
    bad = [*outside, (WORD_MAX + 1,) + (0,) * 13, (0,) * 12 + (2, 0),
           (0,) * 13 + (2,), (-1,) + (0,) * 13, (0,) * 13, (0,) * 15]
    for row in bad:
        proc = subprocess.run([oracle], input=" ".join(map(str, row)) + "\n",
                              text=True, capture_output=True, timeout=30)
        equal((proc.returncode, proc.stdout), (2, ""), "Out-of-domain Lean input")
    return {"guardRows": len(rows), "allReasonMasks": len(set(masks)),
            "directLeanScalarRows": len(rows) if lean_scalar is not None else 0,
            "corpusSha256": sha256(text).hexdigest(),
            "masksSha256": sha256(bytes(masks)).hexdigest(), "oracleRefusals": len(bad)}


def test_specialization(guard, rng):
    """Check the two-account C entry point independently of the adapter's fixed limits."""
    count = 8192
    for i in range(count):
        args = tuple(word(rng) for _ in range(10))
        db, dh, rb, rh, b, h, mb, mh, xb, xh = args
        donor = (db, dh, 0, 0, b, h, mb, mh, xb, xh, mb, mh, 0, 0)
        recipient = (rb, rh, b, h, 0, 0, mb, mh, xb, xh, mb, mh, 0, 0)
        expected = ast_mask(donor) | (ast_mask(recipient) << 8)
        equal(guard.library.knot_transfer_masks(*args), expected, f"Paired row {i}")
    return count


def check_adapter(guard, rng):
    maximum = policy_gate.MAX_AMOUNT
    mb, mh = policy_gate.MIN_BUDGET, policy_gate.MIN_HOURS
    cases = [
        ((mb + 1, mh + 1), (maximum - 1, maximum - 1), 1, 1),
        ((mb, mh), (maximum, maximum), 1, 1),
        ((mb + 1, mh), (maximum - 1, maximum), 1, 1),
        ((maximum, maximum), (0, 0), WORD_MAX, WORD_MAX),
    ]
    for _ in range(1024):
        balances = [rng.randrange(maximum + 1) for _ in range(4)]
        cases.append((balances[:2], balances[2:], rng.randint(1, maximum), rng.randint(1, maximum)))
    fallback_cases = [((maximum, maximum), (0, 0), b, h)
                      for b, h in ((WORD_MAX + 1, 1), (1, WORD_MAX + 1),
                                   (WORD_MAX + 1, WORD_MAX + 1), (1 << 96, 1 << 107))]
    accepted = 0
    for index, args in enumerate(cases + fallback_cases):
        donor_before, recipient_before = list(args[0]), list(args[1])
        expected = policy_gate.check_transfer(*args)
        with patch.object(policy_gate, "check_transfer", wraps=policy_gate.check_transfer) as fallback:
            equal(guard.check_transfer(*args), expected, f"Full adapter result {index}")
            equal(fallback.call_count, int(index >= len(cases)), f"Arbitrary-precision fallback {index}")
        equal((list(args[0]), list(args[1])), (donor_before, recipient_before), "Input mutation")
        accepted += int(expected["accepted"])
    invalid = [([], [0, 0], 1, 1), ([0, 0], [0], 1, 1), ([False, 0], [0, 0], 1, 1),
               ([0, 0], [-1, 0], 1, 1), ([maximum + 1, 0], [0, 0], 1, 1),
               ([0, 0], [0, 0], 0, 1), ([0, 0], [0, 0], 1, -1),
               ([0, 0], [0, 0], True, 1), ([0, 0], [0, 0], 1, 1.0)]
    for args in invalid:
        errors = []
        for operation in (policy_gate.check_transfer, guard.check_transfer):
            try:
                operation(*args)
            except ValueError as error:
                errors.append(str(error))
        if len(errors) != 2 or errors[0] != errors[1]:
            raise ValueError(f"Input rejections differ for {args}: {errors}")
    total = len(cases) + len(fallback_cases)
    return {"transferCases": total, "acceptedTransfers": accepted,
            "rejectedTransfers": total - accepted, "arbitraryPrecisionFallbacks": len(fallback_cases),
            "invalidTransferInputs": len(invalid)}


def verify(library, oracle, scalar_library):
    guard = NativeGuard(library)
    binaries = {"guardSha256": digest_file(library), "oracleSha256": digest_file(oracle)}
    lean_scalar = None
    if scalar_library is not None:
        compiled_lean = ctypes.CDLL(str(scalar_library))
        if hasattr(compiled_lean, "knot_word_masks"):
            raise ValueError("--lean-scalar requires the 14-argument Lean export. This library supplies the row-pointer C interface.")
        lean_scalar = compiled_lean.knot_word_mask
        lean_scalar.argtypes = [ctypes.c_uint32] * 12 + [ctypes.c_uint8] * 2
        lean_scalar.restype = ctypes.c_uint8
        binaries["leanScalarSha256"] = digest_file(scalar_library)
    rng = random.Random(SEED)
    rows, outside, fixtures = row_corpus(rng)
    results = check_rows(guard, oracle, rows, outside, lean_scalar)
    results["specializedPairs"] = test_specialization(guard, rng)
    results.update(check_adapter(guard, rng))
    files = [HERE / name for name in ("guard.c", "guard.h", "bridge.py", "check.py", "WordOracle.lean")]
    files += [HERE.parent / "policy_gate.py"]
    files += [FORMAL / name for name in ("policy.json", "cases.json", "lean-toolchain",
                                         "Knot/Specification.lean", "Knot/Policy.lean", "Knot/Batch.lean",
                                         "Knot/Proofs.lean", "Knot/Machine.lean")]
    return {"format": "knot-native-conformance-v1", "status": "PASS", "seed": SEED,
            **results, "frozenRowCases": fixtures, "frozenRowsBeyondUInt32": len(outside),
            "sources": {path.relative_to(KNOT).as_posix(): digest_file(path) for path in files},
            "binaries": binaries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("library", "oracle", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--lean-scalar", type=Path,
                        help="Also test the direct scalar shared library emitted by the Lean toolchain")
    args = parser.parse_args()
    try:
        report = verify(args.library.resolve(strict=True), args.oracle.resolve(strict=True),
                        args.lean_scalar.resolve(strict=True) if args.lean_scalar else None)
    except (OSError, ValueError, RuntimeError, AttributeError, ctypes.ArgumentError,
            subprocess.SubprocessError) as error:
        report = {"format": "knot-native-conformance-v1", "status": "FAIL", "error": str(error)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=args.out.parent) as scratch:
        temp = Path(scratch) / "report.json"
        temp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        temp.replace(args.out)
    if report["status"] == "FAIL":
        print(report["error"], file=sys.stderr)
        return 1
    print(f"Verified {report['guardRows']} rows, {report['specializedPairs']} pairs "
          f"and {report['transferCases']} adapter calls.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
