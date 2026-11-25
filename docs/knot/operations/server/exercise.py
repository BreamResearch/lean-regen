#!/usr/bin/env python3
"""Exercise the local HTTP service with real clients and a temporary SQLite WAL database."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import queue
import sqlite3
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend import Ledger, bootstrap, connect, serve, POLICY_SHA


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def proposal(key, revision, source="A", target="B", budget=1, hours=1):
    return {
        "key": key,
        "revision": revision,
        "project": target,
        "priority": 1,
        "lines": [{"from": source, "to": target, "budget": budget, "hours": hours}],
    }


class Fixture:
    def __init__(self, directory):
        self.path = Path(directory) / "synthetic.sqlite"
        self.tokens = bootstrap(self.path)
        self.busy = queue.Queue()
        self.ledger = Ledger(
            self.path,
            on_contention=lambda tag: self.busy.put((tag, threading.get_ident())),
        )
        self.server = serve(self.ledger)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_address[1])

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def http(self, actor, path, body=None):
        headers = {
            "Authorization": "Bearer " + self.tokens.get(actor, "unissued-token"),
            "Content-Type": "application/json",
        }
        req = Request(
            self.url + path,
            data=None if body is None else json.dumps(body).encode(),
            headers=headers,
        )
        try:
            with urlopen(req, timeout=12) as response:
                return response.status, json.loads(response.read())
        except HTTPError as response:
            with response:
                return response.code, json.loads(response.read())

    def expect(self, actor, path, body=None, code=200, reason=None):
        status, data = self.http(actor, path, body)
        check(
            status == code and (reason is None or data.get("error") == reason),
            f"{path}: {status} {data}",
        )
        return data

    def audit(self):
        return self.expect("operations", "/admin/reconcile")

    def counts(self):
        with closing(connect(self.path)) as db:
            return {
                (r[0], r[1]): r[2]
                for r in db.execute(
                    "SELECT schema_phase,writer,COUNT(*) FROM receipt GROUP BY schema_phase,writer"
                )
            }


def run(f):
    evidence = {}
    initial = f.expect("finance", "/state")
    rev = initial["revision"]
    valid = proposal("attempt", rev)
    f.expect("missing", "/state", code=401, reason="unauthenticated")
    f.expect("viewer", "/v1/post", dict(valid, role="poster"), 403, "role-denied")
    f.expect(
        "finance", "/v1/post", dict(valid, actor="operations"), 400, "invalid-shape"
    )
    f.expect("limited", "/v1/post", valid, 403, "scope-denied")
    f.expect("finance", "/admin/expand", {}, 403, "role-denied")
    limited = f.expect("limited", "/state")
    check(all(p["center"] == "HQ" for p in limited["pools"]), "unscoped read")
    check(f.audit()["revision"] == rev, "denial changed revision")
    evidence["authorization"] = {
        "unissuedToken": 401,
        "readerForgedRole": 403,
        "posterForgedActor": 400,
        "crossCenterPoster": 403,
        "posterRequestedDDL": 403,
        "limitedReadCenters": ["HQ"],
        "revisionUnchanged": True,
    }
    rejected = {}
    for key, target, budget, hours, why in [
        ("ceiling", "B", 401, 1, "budget-ceiling"),
        ("floor", "B", 1, 501, "hours-floor"),
        ("commitment", "C", 481, 1, "budget-floor"),
        ("locked", "B", 1, 1, "locked"),
    ]:
        p = proposal(key, rev, "F" if key == "locked" else "A", target, budget, hours)
        data = f.expect("finance", "/v1/post", p, 422, "policy")
        codes = [r["code"] for r in data["issues"]]
        check(why in codes, key)
        rejected[key] = codes
    for key, target, why in [
        ("period", "D", "route"),
        ("skill", "E", "route"),
        ("dependency", "G", "dependency"),
    ]:
        f.expect("finance", "/v1/post", proposal(key, rev, target=target), 422, why)
        rejected[key] = why
    f.expect(
        "finance", "/v1/post", proposal("unapproved-route", rev, "B", "C"), 422, "route"
    )
    rejected["unapprovedCenterRoute"] = "route"
    closed = f.expect(
        "finance", "/v1/post", proposal("closed-period", rev, "D", "H"), 422, "policy"
    )["issues"]
    check(
        all({"pool": pool, "code": "closed"} in closed for pool in ("D", "H")),
        "closed accounting period accepted",
    )
    rejected["closedPeriod"] = closed
    f.expect(
        "finance", "/v1/post", proposal("zero", rev, budget=0), 400, "invalid-line"
    )
    rejected["zeroAmount"] = "invalid-line"
    grouped = proposal("aggregate", rev, target="B", budget=260, hours=5)
    grouped["lines"].append({"from": "A", "to": "C", "budget": 230, "hours": 5})
    issues = f.expect("finance", "/v1/post", grouped, 422, "policy")["issues"]
    check(
        {"pool": "A", "code": "budget-floor"} in issues, "aggregated donor not checked"
    )
    rejected["aggregate-commitment"] = issues
    check(f.expect("finance", "/state") == initial, "rejection changed state")
    evidence["rejectedWithoutPosting"] = rejected
    # Hold an independent writer transaction until both HTTP handlers have actually met SQLITE_BUSY.
    start = threading.Barrier(3)
    offer = {}
    for actor, target in [("finance", "B"), ("planning", "C")]:
        offer[actor] = proposal("race-" + actor, rev, "A", target, 5, 4)

    def race(actor):
        start.wait(timeout=5)
        return f.http(actor, "/v1/post", offer[actor])

    with ThreadPoolExecutor(max_workers=2) as racers, closing(connect(f.path)) as held:
        held.execute("BEGIN IMMEDIATE")
        tasks = {a: racers.submit(race, a) for a in offer}
        start.wait(timeout=5)
        observed = {f.busy.get(timeout=5) for _ in range(2)}
        check(
            {n for n, _ in observed} == {v["key"] for v in offer.values()}
            and len({i for _, i in observed}) == 2,
            "competing handlers did not both wait for the write lock",
        )
        held.commit()
        responses = {a: job.result(timeout=10) for a, job in tasks.items()}
    check(
        sorted(s for s, _ in responses.values()) == [200, 409],
        "race allowed two commits",
    )
    winner = next(a for a, (s, _) in responses.items() if s == 200)
    loser = next(a for a in offer if a != winner)
    check(responses[loser][1]["error"] == "stale", "loser was not stale")
    retry = f.expect(winner, "/v1/post", offer[winner])
    check(
        retry["result"] == "duplicate" and retry["revision"] == rev + 1,
        "retry duplicated",
    )
    altered = proposal(offer[winner]["key"], rev, "A", offer[winner]["project"], 4, 4)
    f.expect(winner, "/v1/post", altered, 409, "key-conflict")
    check(f.audit()["clean"] and f.audit()["receiptCount"] == 1, "race drift")
    with closing(connect(f.path)) as db:
        race_legs = db.execute("SELECT COUNT(*) FROM journal").fetchone()[0]
    check(race_legs == 2, "wrong race journal")
    evidence["race"] = {
        "overlappingPool": "A",
        "submittedRevision": rev,
        "concurrentHttpHandlersObservedSQLiteBusy": len(observed),
        "commits": 1,
        "stale": 1,
        "winner": winner,
        "loser": loser,
        "sameRequestReplay": "duplicate",
        "changedReplay": "key-conflict",
        "journalLegs": race_legs,
    }
    f.expect(
        "finance",
        "/v2/post",
        proposal("before-expansion", rev + 1),
        409,
        "schema-not-expanded",
    )
    state = f.expect("finance", "/state")
    multiple = proposal("approved-split", state["revision"], "A", "B", 2, 3)
    multiple["lines"].append({"from": "A", "to": "C", "budget": 4, "hours": 5})
    committed = f.expect("finance", "/v1/post", multiple)
    final_state = f.expect("finance", "/state")

    def balances(state):
        return {row["id"]: (row["budget"], row["hours"]) for row in state["pools"]}

    before, after = balances(state), balances(final_state)
    changes = {
        pool: [after[pool][n] - before[pool][n] for n in (0, 1)]
        for pool in ("A", "B", "C")
    }
    check(
        changes == {"A": [-6, -8], "B": [2, 3], "C": [4, 5]},
        "split did not post atomically",
    )
    with closing(connect(f.path)) as db:
        split_legs = db.execute(
            "SELECT COUNT(*) FROM journal WHERE revision=?", (committed["revision"],)
        ).fetchone()[0]
    check(split_legs == 4 and f.audit()["clean"], "split did not balance")
    evidence["acceptedSplit"] = {
        "revision": committed["revision"],
        "changesBudgetHours": changes,
        "journalLegs": split_legs,
    }
    stop = threading.Event()
    failures = queue.Queue()

    def writer(version, actor):
        idx = 0
        try:
            while not stop.is_set():
                state = f.expect(actor, "/state")
                p = proposal(f"live-{version}-{idx}", state["revision"], "A", "B")
                idx += 1
                status, res = f.http(actor, f"/v{version}/post", p)
                if status != 200 and (
                    status != 409
                    or res.get("error") not in ("stale", "schema-not-expanded")
                ):
                    raise RuntimeError((status, res))
                stop.wait(0.018 if version == 1 else 0.025)
        except Exception as ex:
            failures.put(str(ex))
            stop.set()

    def wait_writes(phase, base, versions):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if not failures.empty():
                raise RuntimeError(failures.get())
            counts = f.counts()
            if all(
                counts.get((phase, v), 0) >= base.get((phase, v), 0) + 2
                for v in versions
            ):
                return
            time.sleep(0.015)
        raise RuntimeError(f"writers did not progress in {phase}")

    def admin(action):
        return f.expect("operations", "/admin/" + action, {})

    def physical():
        with closing(connect(f.path)) as db:
            return db.execute(
                "SELECT type FROM sqlite_master WHERE name='balance_v1'"
            ).fetchone()[0]

    threads = [
        threading.Thread(target=writer, args=(1, "finance")),
        threading.Thread(target=writer, args=(2, "planning")),
    ]
    for thread in threads:
        thread.start()
    try:
        wait_writes("v1", f.counts(), [1])
        expanded = admin("expand")
        f.expect("operations", "/admin/contract", {}, 409, "reconciliation-failed")
        first = admin("backfill")
        after_first = f.counts()
        wait_writes("expanded", after_first, [1, 2])
        check(
            first["missingUnitRows"] > 0,
            "first chunk unexpectedly backfilled all pools",
        )
        observed_counts = f.counts()
        between = {
            f"v{v}": observed_counts.get(("expanded", v), 0)
            - after_first.get(("expanded", v), 0)
            for v in (1, 2)
        }
        chunks = [first["missingUnitRows"]]
        current = first
        while current["missingUnitRows"]:
            current = admin("backfill")
            chunks.append(current["missingUnitRows"])
        # Force a synthetic balance discrepancy in a private fork to check the independent journal fence.
        with tempfile.TemporaryDirectory() as dup:
            snapshot = Path(dup) / "negative.sqlite"
            with closing(connect(f.path)) as source, closing(connect(snapshot)) as bad:
                source.backup(bad)
            broken = Ledger(snapshot)
            with broken.transaction(True) as db:
                db.execute("UPDATE balance_v1 SET budget=budget+1 WHERE pool='A'")
            bad_audit = broken.admin(f.tokens["operations"], "inspect")
            check(
                not bad_audit["clean"]
                and bad_audit["divergentBalances"] == 0
                and bad_audit["openingJournalMismatches"] == 1,
                "negative control lost journal fence",
            )
            try:
                broken.admin(f.tokens["operations"], "contract")
            except Exception as exc:
                check(
                    getattr(exc, "code", None) == "reconciliation-failed",
                    "wrong mismatch rejection",
                )
            else:
                raise RuntimeError("divergent ledger cut over")
        cut = admin("contract")
        check(physical() == "view", "old table was not physically contracted")
        after_cut = f.counts()
        wait_writes("v2", after_cut, [1, 2])
        rolled = admin("rollback")
        check(physical() == "table", "legacy table not rebuilt")
        after_rollback = f.counts()
        wait_writes("expanded", after_rollback, [1, 2])
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=12)
    if not failures.empty():
        raise RuntimeError(failures.get())
    final = f.audit()
    check(final["clean"], "final ledger mismatch")
    with closing(connect(f.path)) as db:
        legs = db.execute("SELECT COUNT(*) FROM journal").fetchone()[0]
        mode = db.execute("PRAGMA journal_mode").fetchone()[0]
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    check(mode == "wal" and integrity == "ok", "storage integrity failure")
    counts = f.counts()
    evidence["migration"] = {
        "mode": "budget/hours columns to normalized budget/hour rows; amounts retain original units",
        "expandMissingUnits": expanded["missingUnitRows"],
        "incompleteCutover": "reconciliation-failed",
        "injectedCorruptionCutover": "reconciliation-failed",
        "injectedOpeningJournalMismatches": bad_audit["openingJournalMismatches"],
        "missingUnitRowsAfterBackfillChunks": chunks,
        "commitsBetweenBackfillChunks": between,
        "commitsBySchemaAndWriter": {
            f"{phase}/v{writer}": n for (phase, writer), n in sorted(counts.items())
        },
        "cutover": cut,
        "v1ObjectAfterCutover": "updatable-view",
        "rollback": rolled,
        "v1ObjectAfterRollback": "physical-table",
        "commitsAfterRollback": {
            f"v{v}": counts["expanded", v] - after_rollback["expanded", v]
            for v in (1, 2)
        },
    }
    evidence["finalReconciliation"] = {
        **final,
        "journalLegs": legs,
        "journalMode": mode,
        "integrityCheck": integrity,
    }
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="fresh evidence JSON")
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Use a fresh output path")
    with tempfile.TemporaryDirectory(prefix="knot-operations-") as directory:
        fixture = Fixture(directory)
        try:
            report = run(fixture)
        finally:
            fixture.close()
    report = {
        "format": "knot-http-sqlite-operations-v1",
        "result": "PASS",
        "observedUtc": datetime.now(timezone.utc).isoformat(),
        "sqliteVersion": sqlite3.sqlite_version,
        "pythonVersion": sys.version.split()[0],
        "policySha256": POLICY_SHA,
        **report,
    }
    report["sourceSha256"] = {
        n: sha256((Path(__file__).parent / n).read_bytes()).hexdigest()
        for n in ("schema.sql", "backend.py", "migration.py", "exercise.py")
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as fp:
        json.dump(report, fp, indent=2)
        fp.write("\n")
    print(
        f"PASS · two contending HTTP clients · both writer versions across cutover and rollback · {report['finalReconciliation']['receiptCount']} reconciled postings"
    )


if __name__ == "__main__":
    main()
