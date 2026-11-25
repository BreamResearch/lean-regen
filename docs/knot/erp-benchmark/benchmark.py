#!/usr/bin/env python3
"""Measure a reversible Knot projection migration while concurrent Odoo ORM clients post."""

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import platform
import threading
import time

import psycopg2

from erp import adapter
from policy_gate import POLICY_HASH
import projection as pg

HERE = Path(__file__).resolve().parent
CLOCK = time.perf_counter


class Clients:
    def __init__(self, fixture, workers, observed_id):
        self.fixture = fixture
        self.workers = workers
        self.observed_id = observed_id
        self.stop = threading.Event()
        self.changed = threading.Condition()
        self.samples = []
        self.reads = []
        self.failures = []
        self.threads = []

    def posting(self, index):
        client = adapter.writer(self.fixture, index)
        sequence = 0
        while not self.stop.is_set():
            started = CLOCK()
            identifiers = client.post(sequence)
            ended = CLOCK()
            pg.check(
                isinstance(identifiers, (tuple, list))
                and len(identifiers) == 2
                and all(type(i) is int and i > 0 for i in identifiers)
                and identifiers[0] != identifiers[1],
                "ERP acknowledgement must identify two native records",
            )
            with self.changed:
                self.samples.append((index, started, ended, *identifiers))
                self.changed.notify_all()
            sequence += 1

    def reading(self):
        with closing(pg.connect("reader")) as db:
            while not self.stop.is_set():
                started = CLOCK()
                with pg.cursor(db) as cur:
                    cur.execute(
                        "SELECT id,budget,hours FROM knot_bench.current_lines WHERE id=%s",
                        (self.observed_id,),
                    )
                    row = cur.fetchone()
                    pg.check(
                        row is not None
                        and row[0] == self.observed_id
                        and row[1]
                        and row[2],
                        "Projection reader lost reference row",
                    )
                self.reads.append((started, CLOCK()))
                self.stop.wait(0.025)

    def guard(self, fn, name, *args):
        try:
            fn(*args)
        except Exception as exc:
            with self.changed:
                self.failures.append((name, type(exc).__name__, str(exc)[:1000]))
                self.stop.set()
                self.changed.notify_all()

    def __enter__(self):
        for index in range(self.workers):
            self.threads.append(
                threading.Thread(
                    target=self.guard,
                    args=(self.posting, "writer-" + str(index), index),
                    daemon=True,
                )
            )
        self.threads.append(
            threading.Thread(
                target=self.guard, args=(self.reading, "projection-reader"), daemon=True
            )
        )
        for thread in self.threads:
            thread.start()
        return self

    def healthy(self):
        if self.failures:
            role, kind, text = self.failures[0]
            for k in ("KNOT_ODOO_PASSWORD", "PGPASSWORD"):
                if os.environ.get(k):
                    text = text.replace(os.environ[k], "<redacted>")
            raise RuntimeError(f"{role} failed ({kind}): {text}")

    def sustain(self, seconds):
        begin = CLOCK()
        deadline = begin + max(60, seconds * 4)
        with self.changed:
            offset = len(self.samples)
            while True:
                self.healthy()
                complete = {row[0] for row in self.samples[offset:] if row[1] >= begin}
                if CLOCK() - begin >= seconds and len(complete) == self.workers:
                    return
                pg.check(
                    CLOCK() < deadline,
                    "Some ERP workers did not complete a request in the sustained window",
                )
                self.changed.wait(timeout=0.15)

    def __exit__(self, exc_type, exc, trace):
        self.stop.set()
        for thread in self.threads:
            thread.join(timeout=65)
        pg.check(
            all(not t.is_alive() for t in self.threads),
            "Client did not drain before reconciliation",
        )
        if exc is None:
            self.healthy()


def latency(values):
    a = sorted(values)

    def rank(p):
        return pg.ms(a[max(0, math.ceil(len(a) * p) - 1)]) if a else None

    return {"p50": rank(0.50), "p95": rank(0.95), "p99": rank(0.99), "max": rank(1)}


def phase_stats(clients, start, end):
    items = [r for r in clients.samples if start <= r[2] < end]
    ends = sorted(r[2] for r in items)
    boundaries = [start, *ends, end]
    endpoints = []
    for _, sent, finish, _, _ in clients.samples:
        if sent < end and finish > start:
            endpoints.extend([(max(sent, start), 1), (min(finish, end), -1)])
    active = peak = 0
    for _, change in sorted(endpoints):
        active += change
        peak = max(peak, active)
    return {
        "durationMs": pg.ms(end - start),
        "completedResponses": len(items),
        "distinctWriters": len({r[0] for r in items}),
        "peakInFlightErpRequests": peak,
        "requestsPerSecond": round(len(items) / (end - start), 2)
        if end > start
        else None,
        "latencyMs": latency([r[2] - r[1] for r in items]),
        "maxResponseGapMs": pg.ms(
            max(b - a for a, b in zip(boundaries, boundaries[1:]))
        ),
        "projectionReadResponses": sum(
            start <= finish < end for _, finish in clients.reads
        ),
    }


def verify_native_receipts(cur, fixture, samples, historical_high):
    """Check each acknowledged leg against the independently specified workload and authenticated Odoo user."""
    sequence = Counter()
    expected = {}
    for worker, _, _, debit_id, credit_id in samples:
        n = sequence[worker]
        sequence[worker] += 1
        accounts = fixture["accounts"][2 * worker : 2 * worker + 2]
        donor, recipient = (accounts[1], accounts[0]) if n % 2 else accounts
        money, hours = 1 + (n // 2) % 17, 1 + (n // 2) % 5
        actor = fixture["workers"][worker]
        prefix = f"KNOTBENCH:L{worker}-{n}"
        common = (fixture["company_id"], actor)
        expected[debit_id] = (prefix + ":D", donor, *common, -money, -hours)
        expected[credit_id] = (prefix + ":C", recipient, *common, money, hours)
    cur.execute(
        """SELECT id,name,account_id,company_id,create_uid,amount::numeric,unit_amount::numeric
      FROM public.account_analytic_line WHERE id>%s AND name LIKE 'KNOTBENCH:%%'""",
        (historical_high,),
    )
    actual = {row[0]: tuple(row[1:]) for row in cur}
    pg.check(
        len(expected) == 2 * len(samples) and actual == expected,
        "Native Odoo rows differ from intended signed legs, projects, company or authenticated writer",
    )
    return len(actual)


def run(args):
    host = os.getenv("PGHOST", "")
    expected_db = os.environ["KNOT_ODOO_DB"]
    pg.check(
        host in ("localhost", "127.0.0.1", "::1") or host.startswith("/"),
        "Expected local disposable Postgres host",
    )
    policy = HERE.parent / "formal/policy.json"
    pg.check(
        sha256(policy.read_bytes()).hexdigest() == POLICY_HASH,
        "Wrong frozen Knot policy",
    )
    start_utc = datetime.now(timezone.utc).isoformat()
    with closing(pg.connect("migration")) as db:
        with pg.cursor(db) as cur:
            pg.check(
                pg.scalar(cur, "SELECT current_database()") == expected_db,
                "ERP and PostgreSQL databases differ",
            )
            version = pg.scalar(cur, "SHOW server_version")
            pg.check(160000 <= db.server_version < 170000, "Expected PostgreSQL 16")
            pg.check(
                pg.scalar(cur, "SELECT to_regnamespace('knot_bench') IS NULL"),
                "Use a fresh isolated ERP database",
            )
        fixture = adapter.setup(args.writers)
        with pg.cursor(db) as cur:
            pg.check(
                pg.scalar(
                    cur,
                    "SELECT count(*) FROM public.account_analytic_line WHERE name LIKE 'KNOTBENCH:%'",
                )
                == 0,
                "Existing ERP sample rows refused",
            )
        seed_start = CLOCK()
        seed_result = adapter.seed(fixture, args.rows)
        seed_ms = pg.ms(CLOCK() - seed_start)
        pg.install(db)
        with pg.cursor(db) as cur:
            cur.execute("SELECT min(id),max(id) FROM knot_bench.erp_lines")
            first, high = cur.fetchone()
            history = pg.state_digest(cur, pg.ERP, high)
            native_history = pg.native_digest(cur, high)
            pg.check(
                history["rows"] == args.rows,
                "ERP seed returned the wrong number of native lines",
            )
        checks = {"initial": pg.observe(db, "legacy", high, history, [pg.WIDE])}
        stages = {}
        migrations = {}
        clock_zero = CLOCK()

        def act(name, fn, *values):
            started = CLOCK()
            result = fn(*values)
            stages[name] = (started, CLOCK())
            return result

        with Clients(fixture, args.writers, first) as clients:
            act("legacy", clients.sustain, args.phase_seconds)
            migrations["expand"] = act("expand", pg.fence, db, "expand")
            migrations["earlyCutover"] = act(
                "earlyCutover", pg.fence, db, "early-cutover", history, high
            )
            pg.check(
                migrations["earlyCutover"]["newDifferences"] > 0,
                "Unfilled projection escaped the early cutover check",
            )
            migrations["backfill"] = act("backfill", pg.backfill, db, high, args.chunk)
            pg.check(
                migrations["backfill"]["rowsCopied"] == args.rows,
                "Historical backfill count mismatch",
            )
            act("dual", clients.sustain, args.phase_seconds)
            migrations["failedCutover"] = act(
                "failedCutover", pg.fence, db, "failed-cutover", history, high
            )
            pg.check(
                migrations["failedCutover"]["newDifferences"] == 1,
                "Deliberate targeted divergence was not detected",
            )
            checks["afterRefusal"] = act(
                "refusalAudit",
                pg.observe,
                db,
                "dual",
                high,
                history,
                [pg.WIDE, pg.NORMALIZED, pg.CURRENT],
            )
            pg.check(
                checks["afterRefusal"]["widePhysicalTable"],
                "Legacy table lost after refusal",
            )
            migrations["cutover"] = act(
                "cutover", pg.fence, db, "cutover", history, high
            )
            checks["afterCutover"] = act(
                "cutoverAudit",
                pg.observe,
                db,
                "normalized",
                high,
                history,
                [pg.NORMALIZED, pg.CURRENT],
            )
            pg.check(
                not checks["afterCutover"]["widePhysicalTable"],
                "Old table still present after cutover",
            )
            act("normalized", clients.sustain, args.phase_seconds)
            migrations["rollback"] = act(
                "rollback", pg.fence, db, "rollback", history, high
            )
            checks["afterRollback"] = act(
                "rollbackAudit",
                pg.observe,
                db,
                "dual",
                high,
                history,
                [pg.WIDE, pg.NORMALIZED, pg.CURRENT],
            )
            pg.check(
                checks["afterRollback"]["widePhysicalTable"],
                "Rollback did not rebuild old table",
            )
            act("restored", clients.sustain, args.phase_seconds)
        finished = CLOCK()
        checks["final"] = pg.observe(
            db, "dual", high, history, [pg.WIDE, pg.NORMALIZED, pg.CURRENT]
        )
        erp_acks = [i for row in clients.samples for i in row[3:]]
        pg.check(
            len(set(erp_acks)) == len(erp_acks),
            "Native ERP acknowledgement IDs duplicated",
        )
        with pg.cursor(db) as cur:
            final_native = pg.native_digest(cur, high)
            matched = verify_native_receipts(cur, fixture, clients.samples, high)
        pg.check(
            final_native == native_history, "Full native ERP history digest changed"
        )
        pg.check(
            checks["final"]["erpRows"] == args.rows + len(erp_acks),
            "Native ERP row count does not match acknowledged pairs",
        )
    source_paths = [
        HERE / n
        for n in (
            "requirements.txt",
            "benchmark.py",
            "projection.py",
            "policy_gate.py",
            "install.sql",
            "expand.sql",
            "backfill.sql",
        )
    ]
    source_paths += sorted((HERE / "erp").glob("*.py")) + sorted(
        (HERE / "erp").glob("images.json")
    )
    sources = {
        str(path.relative_to(HERE)): sha256(path.read_bytes()).hexdigest()
        for path in source_paths
    }
    sources["../formal/policy.json"] = POLICY_HASH
    counts = Counter(r[0] for r in clients.samples)
    phases = {
        name: phase_stats(clients, *interval) for name, interval in stages.items()
    }
    reads = [end - start for start, end in clients.reads]
    return {
        "format": "knot-odoo-cutover-benchmark-v1",
        "status": "PASS",
        "profile": "smoke" if args.smoke else "100k-plus",
        "startedUtc": start_utc,
        "runtime": {
            "python": platform.python_version(),
            "loadGenerator": {
                "os": platform.system(),
                "architecture": platform.machine(),
                "logicalCpuCountVisible": len(os.sched_getaffinity(0))
                if hasattr(os, "sched_getaffinity")
                else os.cpu_count(),
                "physicalMemoryBytesVisible": os.sysconf("SC_PHYS_PAGES")
                * os.sysconf("SC_PAGE_SIZE"),
            },
            "postgresql": version,
            "driver": psycopg2.__version__,
            "odoo": fixture.get("odoo_version"),
            "images": json.loads(os.getenv("KNOT_ERP_IMAGES", "{}")),
        },
        "parameters": {
            "rows": args.rows,
            "writers": args.writers,
            "chunk": args.chunk,
            "minimumSteadyPhaseSeconds": args.phase_seconds,
        },
        "seed": {"elapsedMs": seed_ms, "adapter": seed_result},
        "history": history,
        "fullNativeHistory": {"before": native_history, "after": final_native},
        "checks": checks,
        "migration": migrations,
        "load": {
            "writers": args.writers,
            "successfulRequests": len(clients.samples),
            "failedRequests": len(clients.failures),
            "acknowledgedNativeLineIdsMatched": matched,
            "nativeSignedLegsAndCreatorsMatched": matched,
            "perWriter": {str(i): counts[i] for i in range(args.writers)},
            "phases": phases,
            "overall": phase_stats(clients, clock_zero, finished),
            "projectionReadLatencyMs": latency(reads),
        },
        "policySha256": POLICY_HASH,
        "policyChallenge": fixture.get("policyChallenge"),
        "sourceSha256": sources,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--rows", type=int, default=100000)
    ap.add_argument("--writers", type=int, default=8)
    ap.add_argument("--phase-seconds", type=float, default=6)
    ap.add_argument("--chunk", type=int, default=4000)
    ap.add_argument(
        "--smoke", action="store_true", help="Label a smaller integration run as smoke"
    )
    args = ap.parse_args()
    if (
        args.out.exists()
        or args.rows < 4
        or args.rows % 2
        or not 1 <= args.writers <= 64
        or not 0.1 <= args.phase_seconds <= 300
        or not 1 <= args.chunk <= args.rows
    ):
        ap.error("Choose fresh output, even row count, valid client/window/chunk sizes")
    if not args.smoke and (
        args.rows < 100000 or args.writers < 8 or args.phase_seconds < 2
    ):
        ap.error(
            "Full profile requires at least 100,000 native records, eight writers and two-second steady phases"
        )
    result = run(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False, allow_nan=False)
        f.write("\n")
    print(
        f"PASS: {result['profile']}, {result['history']['rows']} historical Odoo rows, {result['load']['successfulRequests']} live transactions",
        flush=True,
    )


if __name__ == "__main__":
    main()
