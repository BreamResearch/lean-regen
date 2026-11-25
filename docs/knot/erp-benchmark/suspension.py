#!/usr/bin/env python3
"""Compare cutover control under the same open-loop Odoo workload and fixed SQL gates."""

import argparse
from collections import Counter
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import re
import secrets
import statistics
import threading
import time

import psycopg2
from psycopg2 import sql

from benchmark import verify_native_receipts
from erp import adapter
from policy_gate import POLICY_HASH
import projection as pg
import suspension_model as model
from suspension_workload import (
    CLOCK,
    Traffic,
    digest,
    distribution,
    milliseconds,
    schedule,
    structured_advice,
)

HERE = Path(__file__).resolve().parent
ARMS = ["fixed", "adaptive", "llm"]
NOTE = (
    "Quarter close will produce a burst of postings. Prefer the published quiet window. "
    "If more than 8 submissions are queued or the recent scheduled-to-ack p95 exceeds 500 ms, "
    "prefer a short deferral. Once the window has opened, proceed when both measures are within budget. "
    "The readiness checks are mandatory even after a deferral deadline."
)


@contextmanager
def seed_template(base):
    admin = psycopg2.connect(
        dbname="postgres", application_name="knot-suspension-clones", connect_timeout=10
    )
    admin.autocommit = True
    name = sql.Identifier(base)
    frozen = False
    try:
        with admin.cursor() as cur:
            cur.execute(
                "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=%s",
                (base,),
            )
            owner = cur.fetchone()[0]
            pg.check(owner == "knot_odoo", "Unexpected disposable ERP database owner")
            cur.execute(
                sql.SQL("ALTER DATABASE {} ALLOW_CONNECTIONS false").format(name)
            )
            frozen = True
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()",
                (base,),
            )
        yield admin
    finally:
        if frozen:
            with admin.cursor() as cur:
                cur.execute(
                    sql.SQL("ALTER DATABASE {} ALLOW_CONNECTIONS true").format(name)
                )
        admin.close()


@contextmanager
def clone(admin, base):
    name = base[:-4] + secrets.token_hex(2)
    pg.check(name != base, "Unexpected generated database name collision")
    ident = sql.Identifier(name)
    with admin.cursor() as cur:
        # Refuse existing names. DROP in finally is reached only after this CREATE actually succeeds.
        cur.execute(
            sql.SQL("CREATE DATABASE {} OWNER knot_odoo TEMPLATE {}").format(
                ident, sql.Identifier(base)
            )
        )
    original = {key: os.environ.get(key) for key in ("PGDATABASE", "KNOT_ODOO_DB")}
    try:
        os.environ.update(PGDATABASE=name, KNOT_ODOO_DB=name)
        with closing(pg.connect("clone-marker")) as db, pg.cursor(db) as cur:
            cur.execute(
                "UPDATE public.ir_config_parameter SET value=%s WHERE key='knotbench.fresh_db' AND value=%s",
                (name, base),
            )
            pg.check(cur.rowcount == 1, "Copied database missing disposable marker")
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        with admin.cursor() as cur:
            cur.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(ident))


def copy_pages(db, high, strategy, traffic):
    start = CLOCK()
    position = total = healthy_streak = 0
    size = 4000
    pages = []
    sleep_total = 0
    size_counts = Counter()
    changes = []
    query = (HERE / "backfill.sql").read_text()
    while position < high:
        loop = CLOCK()
        with pg.cursor(db) as cur:
            pg.check(
                pg.scalar(
                    cur,
                    "SELECT phase FROM knot_bench.control WHERE singleton FOR SHARE",
                )
                == "dual",
                "Wrong backfill phase",
            )
            cur.execute(query, (position, high, size))
            next_position, count = cur.fetchone()
        cost = milliseconds(CLOCK() - loop)
        if not count:
            break
        pg.check(next_position > position, "Page made no progress")
        position = next_position
        total += count
        pages.append(cost)
        size_counts[size] += 1
        if strategy == "fixed" or position >= high:
            continue
        health = traffic.telemetry()
        old = size
        pause = 0
        pressured = (
            cost > 125
            or health["queuedRequests"] >= 8
            or (health["recentP95Ms"] or 0) > 500
        )
        if pressured:
            size = max(500, size // 2)
            healthy_streak = 0
            pause = 15
        elif cost < 65 and health["queuedRequests"] == 0:
            healthy_streak += 1
            if healthy_streak >= 2:
                size = min(4000, size * 2)
                healthy_streak = 0
        else:
            healthy_streak = 0
        if old != size:
            changes.append([len(pages), old, size])
        if pause:
            before = CLOCK()
            time.sleep(pause / 1000)
            sleep_total += milliseconds(CLOCK() - before)
    return {
        "rowsCopied": total,
        "chunks": len(pages),
        "chunkSizeCounts": dict(sorted(size_counts.items())),
        "chunkLatencyMs": distribution([v / 1000 for v in pages]),
        "sleepMs": round(sleep_total, 3),
        "changeCount": len(changes),
        "firstChanges": changes[:8],
        "allChangesSha256": digest(changes),
        "elapsedMs": milliseconds(CLOCK() - start),
    }


def decide(strategy, traffic, smoke):
    quiet = traffic.segments[2]
    deadline = traffic.segments[3]["endMs"]
    model_deadline = quiet["endMs"] + (1000 if smoke else 3000)
    attempts = []
    total_model = 0
    model_deferrals = 0
    fallback = None
    late_call = None
    outcome = "retain-dual"

    def snapshot():
        return dict(
            traffic.telemetry(),
            phase="cutover",
            eligible=True,
            attempt=len(attempts) + 1,
            windowStartMs=quiet["startMs"],
            windowEndMs=quiet["endMs"],
            schedule=traffic.segments,
            operationsNote=NOTE,
        )

    while True:
        obs = snapshot()
        if obs["elapsedMs"] >= deadline:
            fallback = "no-eligible-live-window"
            break
        structured = structured_advice(obs)
        raw = None
        duration = 0
        effective = structured
        if structured["action"] == "proceed" and strategy == "llm":
            if model_deferrals >= 2 or late_call or obs["elapsedMs"] >= model_deadline:
                if obs["elapsedMs"] < quiet["endMs"]:
                    effective = {
                        "action": "defer",
                        "reason": "await-authorized-fallback-window",
                    }
                else:
                    fallback = "structured-approved-live-fallback-window"
            else:
                output = {}
                done = threading.Event()

                def infer():
                    try:
                        output.update(model.choose(obs))
                    except Exception as exc:
                        output.update(
                            action="defer",
                            status="exception",
                            reason=type(exc).__name__,
                        )
                    finally:
                        done.set()

                started = CLOCK()
                worker = threading.Thread(target=infer, daemon=True)
                worker.start()
                if done.wait(max(0, (model_deadline - obs["elapsedMs"]) / 1000)):
                    raw = dict(output)
                else:
                    late_call = (worker, done, output, started)
                    raw = {
                        "action": "defer",
                        "reason": "bounded-supervisor-timeout",
                        "status": "timeout",
                    }
                duration = milliseconds(CLOCK() - started)
                total_model += duration
                # Pressure can change during inference. The language model may add a delay;
                # neither PROCEED nor the deadline can bypass the deterministic condition.
                refreshed = structured_advice(snapshot())
                if refreshed["action"] == "defer":
                    effective = refreshed
                elif raw.get("status") != "ok" or raw.get("action") != "proceed":
                    model_deferrals += 1
                    effective = {
                        "action": "defer",
                        "reason": "model-deferred-or-unavailable",
                    }
                else:
                    effective = {
                        "action": "proceed",
                        "reason": "both-controllers-permit",
                    }
        now = traffic.telemetry()["elapsedMs"]
        if now >= deadline:
            effective = {"action": "defer", "reason": "outside-live-execution-window"}
        attempts.append(
            {
                "observation": obs,
                "structuredAlternative": structured,
                "modelAdvice": raw,
                "advice": effective,
                "modelWaitMs": duration,
            }
        )
        if effective["action"] == "proceed":
            outcome = "submit-to-immutable-cutover-gate"
            break
        if now >= deadline:
            fallback = "no-eligible-live-window"
            break
        next_time = max(now + (350 if smoke else 1000), quiet["startMs"])
        if effective["reason"] == "await-authorized-fallback-window":
            next_time = max(next_time, quiet["endMs"])
        traffic.until(min(deadline, next_time))
    return {
        "attempts": attempts,
        "deferrals": sum(a["advice"]["action"] == "defer" for a in attempts),
        "modelDeferrals": model_deferrals,
        "deadlineMs": deadline,
        "modelDeadlineMs": model_deadline,
        "fallbackWindowMs": [quiet["endMs"], deadline],
        "boundedFallback": fallback,
        "effectiveAction": outcome,
        "modelWaitMs": round(total_model, 3),
        "decisionAtMs": traffic.telemetry()["elapsedMs"],
    }, late_call


def await_late_model(late, decision):
    if late:
        worker, event, out, started = late
        pg.check(
            event.wait(120),
            "Local model did not terminate; stop before another strategy",
        )
        worker.join()
        decision["lateResultAfterDecision"] = {
            k: v
            for k, v in out.items()
            if k in ("action", "status", "reason", "inferenceMs")
        }


def drive(args, fixture, segments, lanes, baseline, native, high, strategy):
    with closing(pg.connect("trial")) as db:
        with pg.cursor(db) as cur:
            pg.check(
                pg.native_digest(cur, high) == native,
                "Trial did not start from identical native ERP rows",
            )
            pg.check(
                pg.scalar(cur, "SELECT count(*) FROM knot_bench.erp_lines")
                == args.rows,
                "Unexpected trial seed size",
            )
        before = pg.observe(db, "legacy", high, baseline, [pg.WIDE])
        migration = {}
        traffic = Traffic(fixture, lanes, segments)
        with traffic:
            traffic.until(500 if args.smoke else 2200)
            begin = CLOCK()
            migration["expand"] = pg.fence(db, "expand")
            migration["earlyCutover"] = pg.fence(db, "early-cutover", baseline, high)
            watermark = migration["expand"]["legacyRowsAtExpansion"]
            pg.check(
                watermark > args.rows
                and migration["earlyCutover"]["newDifferences"] >= args.rows,
                "Incomplete live backfill gate failed",
            )
            migration["backfill"] = copy_pages(
                db, migration["expand"]["backfillHighId"], strategy, traffic
            )
            pg.check(
                migration["backfill"]["rowsCopied"] >= watermark,
                "Committed legacy rows missing from copy",
            )
            migration["failedCutover"] = pg.fence(db, "failed-cutover", baseline, high)
            pg.check(
                migration["failedCutover"]["transaction"] == "rolled-back"
                and migration["failedCutover"]["newDifferences"] == 1,
                "Injected discrepancy crossed the gate",
            )
            repaired = pg.observe(
                db, "dual", high, baseline, [pg.WIDE, pg.NORMALIZED, pg.CURRENT]
            )
            pg.check(
                repaired["widePhysicalTable"], "Refused switch destroyed the old ledger"
            )
            decision, late = decide(strategy, traffic, args.smoke)
            # The exclusive, independently enforcing SQL gate verifies current state again.
            submit = decision["effectiveAction"] == "submit-to-immutable-cutover-gate"
            if submit:
                switch_start = CLOCK()
                migration["cutover"] = pg.fence(db, "cutover", baseline, high)
                switched = CLOCK()
                seen = pg.observe(
                    db, "normalized", high, baseline, [pg.NORMALIZED, pg.CURRENT]
                )
                pg.check(
                    not seen["widePhysicalTable"],
                    "Old physical ledger survived cutover",
                )
                post_workers = traffic.wait_post_cutover(switched)
                migration["rollback"] = pg.fence(db, "rollback", baseline, high)
                restored = pg.observe(
                    db, "dual", high, baseline, [pg.WIDE, pg.NORMALIZED, pg.CURRENT]
                )
                pg.check(
                    restored["widePhysicalTable"],
                    "Rollback failed to rebuild old ledger",
                )
            else:
                switch_start = None
                migration.update(cutover=None, rollback=None)
                seen = restored = repaired
                post_workers = 0
            finished = CLOCK()
            await_late_model(late, decision)
        end = pg.observe(
            db, "dual", high, baseline, [pg.WIDE, pg.NORMALIZED, pg.CURRENT]
        )
        with pg.cursor(db) as cur:
            observed_native = pg.native_digest(cur, high)
            pg.check(observed_native == native, "Full native history changed")
            matches = verify_native_receipts(
                cur,
                fixture,
                [(r[0], r[3], r[4], r[5], r[6]) for r in traffic.samples],
                high,
            )
            pg.check(
                matches == 2 * sum(map(len, lanes))
                and end["erpRows"] == args.rows + matches,
                "Offered and persisted native legs differ",
            )
        workload = traffic.metrics()
        cut_ms = milliseconds(switch_start - traffic.t0) if submit else None
        ended_under_load = (
            submit and cut_ms < segments[-1]["endMs"] and post_workers == args.writers
        )
        return {
            "strategy": strategy,
            "workload": workload,
            "migration": migration,
            "decision": decision,
            "cutoverStartedAtMs": cut_ms,
            "migrationThroughRollbackAuditMs": milliseconds(finished - begin),
            "workersPostingAfterCutover": post_workers,
            "cutoverDuringOfferedLoad": ended_under_load,
            "integrity": {
                "initialErpRows": before["erpRows"],
                "fullNativeHistoryAfter": observed_native,
                "projectedHistoryAfter": end["activeHistory"],
                "finalErpRows": end["erpRows"],
                "exactLiveLegs": matches,
                "finalProjectionDifferences": end["projectionDifferences"],
                "unbalancedRequestPairs": end["unbalancedRequestPairs"],
                "oldTableRetainedOnRefusal": repaired["widePhysicalTable"],
                "oldTableRemovedOnCutover": not seen["widePhysicalTable"],
                "oldTableRestored": restored["widePhysicalTable"],
            },
        }


def aggregate(trials):
    result = {}
    for arm in ARMS:
        rows = [t for t in trials if t["strategy"] == arm]
        metrics = {
            "scheduledP95Ms": [r["workload"]["scheduledToAckMs"]["p95"] for r in rows],
            "scheduledP99Ms": [r["workload"]["scheduledToAckMs"]["p99"] for r in rows],
            "cutoverMs": [
                r["migration"]["cutover"]["totalMs"]
                for r in rows
                if r["migration"]["cutover"]
            ],
            "migrationThroughRollbackAuditMs": [
                r["migrationThroughRollbackAuditMs"] for r in rows
            ],
            "effectiveRequestsPerSecond": [
                r["workload"]["achievedPerSecond"] for r in rows
            ],
            "modelWaitMs": [r["decision"]["modelWaitMs"] for r in rows],
        }
        result[arm] = {
            k: {
                "median": round(statistics.median(v), 3) if v else None,
                "min": min(v) if v else None,
                "max": max(v) if v else None,
                "trials": v,
            }
            for k, v in metrics.items()
        }
    return result


def run(args):
    base = os.environ["KNOT_ODOO_DB"]
    pg.check(
        re.fullmatch(r"knotbench_[0-9a-f]{12}", base)
        and os.environ.get("PGDATABASE") == base,
        "Expected one generated ERP database",
    )
    host = os.environ.get("PGHOST", "")
    pg.check(
        host in ("127.0.0.1", "localhost", "::1") or host.startswith("/"),
        "Use the disposable local ERP appliance",
    )
    pg.check(
        sha256((HERE.parent / "formal/policy.json").read_bytes()).hexdigest()
        == POLICY_HASH,
        "Wrong frozen Knot policy",
    )
    with closing(pg.connect("bootstrap")) as db, pg.cursor(db) as cur:
        pg.check(
            160000 <= db.server_version < 170000
            and pg.scalar(cur, "SELECT to_regnamespace('knot_bench') IS NULL"),
            "Expected a fresh PostgreSQL 16 ERP database",
        )
        pg.check(
            pg.scalar(
                cur,
                "SELECT value FROM public.ir_config_parameter WHERE key='knotbench.fresh_db'",
            )
            == base,
            "Missing disposable ERP marker",
        )
        pg_version = pg.scalar(cur, "SHOW server_version")
    started = datetime.now(timezone.utc).isoformat()
    segments, lanes = schedule(args.writers, args.smoke)
    fixture = adapter.setup(args.writers)
    seed = adapter.seed(fixture, args.rows)
    with closing(pg.connect("seed")) as db:
        pg.install(db)
        with pg.cursor(db) as cur:
            high = pg.scalar(cur, "SELECT max(id) FROM knot_bench.erp_lines")
            history = pg.state_digest(cur, pg.ERP, high)
            native = pg.native_digest(cur, high)
            pg.check(
                history["rows"] == args.rows == native["rows"],
                "Native seed count disagrees",
            )
    trials = []
    try:
        model_meta = model.warmup()
        with seed_template(base) as admin:
            for repeat in range(args.repeats):
                order = ARMS[repeat % 3 :] + ARMS[: repeat % 3]
                for pos, strategy in enumerate(order):
                    print(f"Repeat {repeat + 1}/{args.repeats}: {strategy}", flush=True)
                    with clone(admin, base):
                        trial = drive(
                            args,
                            fixture,
                            segments,
                            lanes,
                            history,
                            native,
                            high,
                            strategy,
                        )
                    trial.update(repeat=repeat + 1, position=pos + 1)
                    trials.append(trial)
    finally:
        model.close()
    files = [
        "benchmark.py",
        "projection.py",
        "policy_gate.py",
        "backfill.sql",
        "expand.sql",
        "install.sql",
        "requirements.txt",
        "suspension.py",
        "suspension_workload.py",
        "suspension_model.py",
        "suspension_model_lock.json",
        "suspension_model_cases.json",
        "suspension_launcher.py",
        "erp/adapter.py",
        "erp/run.py",
        "erp/images.json",
        "../formal/policy.json",
    ]
    return {
        "format": "knot-suspension-comparison-v1",
        "status": "PASS"
        if all(t["cutoverDuringOfferedLoad"] for t in trials)
        else "INCONCLUSIVE_TIMING",
        "profile": "smoke" if args.smoke else "100k-plus",
        "allCutoversDuringOfferedLoad": all(
            t["cutoverDuringOfferedLoad"] for t in trials
        ),
        "startedUtc": started,
        "parameters": {
            "rows": args.rows,
            "writers": args.writers,
            "repeats": args.repeats,
        },
        "runtime": {
            "odoo": fixture["odoo_version"],
            "postgresql": pg_version,
            "python": platform.python_version(),
            "architecture": platform.machine(),
            "visibleLogicalCpu": len(os.sched_getaffinity(0))
            if hasattr(os, "sched_getaffinity")
            else os.cpu_count(),
            "driver": psycopg2.__version__,
            "deployment": json.loads(os.getenv("KNOT_ERP_IMAGES", "{}")),
        },
        "seed": seed,
        "schedule": {
            "sha256": digest(lanes),
            "requests": sum(map(len, lanes)),
            "durationMs": segments[-1]["endMs"],
            "segments": segments,
        },
        "baseline": {
            "nativeHistory": native,
            "projectionHistory": history,
            "policySha256": POLICY_HASH,
            "refusedOutOfBoundsTransfer": fixture["policyChallenge"],
        },
        "model": model_meta,
        "trials": trials,
        "aggregate": aggregate(trials),
        "sourceSha256": {n: sha256((HERE / n).read_bytes()).hexdigest() for n in files},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--rows", type=int, default=100000)
    p.add_argument("--writers", type=int, default=8)
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--smoke", action="store_true")
    args = p.parse_args()
    if (
        args.out.exists()
        or args.rows < 100
        or args.rows % 2
        or not 1 <= args.writers <= 32
        or not 1 <= args.repeats <= 9
    ):
        p.error(
            "Expected fresh output, even history >=100, 1–32 writers and 1–9 repeats"
        )
    if not args.smoke and (args.rows < 100000 or args.writers != 8 or args.repeats % 3):
        p.error(
            "Full comparison requires >=100k lines, eight writers, and complete three-repeat counterbalance blocks"
        )
    result = run(args)
    args.out.parent.mkdir(exist_ok=True, parents=True)
    with args.out.open("x", encoding="utf8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False, allow_nan=False)
        f.write("\n")
    print(
        f"{result['status']}: {len(result['trials'])} Odoo trials, {result['schedule']['requests']} identical offered intents per trial",
        flush=True,
    )


if __name__ == "__main__":
    main()
