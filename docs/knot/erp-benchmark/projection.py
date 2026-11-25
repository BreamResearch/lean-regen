"""Transactional migration of a local Knot projection of native Odoo analytic lines."""

from contextlib import contextmanager
from pathlib import Path
import time

import psycopg2

HERE = Path(__file__).resolve().parent
CLOCK = time.perf_counter
WIDE = "knot_bench.wide"
NORMALIZED = "knot_bench.normalized_lines"
ERP = "knot_bench.erp_lines"
CURRENT = "knot_bench.current_lines"
RELATIONS = {WIDE, NORMALIZED, ERP, CURRENT}


def connect(label):
    db = psycopg2.connect(
        application_name="knot-benchmark-" + label, connect_timeout=10
    )
    return db


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


@contextmanager
def cursor(db):
    with db:
        with db.cursor() as cur:
            cur.execute(
                "SET LOCAL lock_timeout='45s'; SET LOCAL statement_timeout='120s'"
            )
            yield cur


def scalar(cur, sql, args=()):
    cur.execute(sql, args or None)
    return cur.fetchone()[0]


def ms(seconds):
    return round(seconds * 1000, 3)


def state_digest(cur, relation, high):
    assert relation in RELATIONS
    # Hash projected business fields in native id order. Integer and decimal encodings are stable.
    cur.execute(
        f"""
      SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(
        encode(sha256(convert_to(jsonb_build_array(id,name,company_id,account_id,
          trim_scale(budget),trim_scale(hours))::text,'UTF8')),'hex'),'' ORDER BY id),''),'UTF8')),'hex')
      FROM {relation} WHERE id<=%s""",
        (high,),
    )
    count, digest = cur.fetchone()
    return {"rows": count, "sha256": digest}


def differences(cur, other):
    assert other in RELATIONS
    return scalar(
        cur,
        f"""SELECT count(*) FROM {ERP} e FULL JOIN {other} p USING(id)
      WHERE e.id IS NULL OR p.id IS NULL OR
        (e.name,e.company_id,e.account_id,e.budget,e.hours)
        IS DISTINCT FROM (p.name,p.company_id,p.account_id,p.budget,p.hours)""",
    )


def native_digest(cur, high):
    cur.execute(
        """SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(
        encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),'' ORDER BY id),''),'UTF8')),'hex')
      FROM public.account_analytic_line a WHERE id<=%s AND name LIKE 'KNOTBENCH:%%'""",
        (high,),
    )
    count, digest = cur.fetchone()
    return {"rows": count, "sha256": digest}


def pairs(cur):
    return scalar(
        cur,
        f"""SELECT count(*) FROM (
      SELECT left(name,-2) FROM {ERP} GROUP BY left(name,-2)
      HAVING count(*) <> 2 OR count(DISTINCT account_id) <> 2 OR count(DISTINCT company_id) <> 1
        OR count(*) FILTER(WHERE right(name,2)=':D') <> 1 OR count(*) FILTER(WHERE right(name,2)=':C') <> 1
        OR sum(budget) <> 0 OR sum(hours) <> 0 OR min(budget) >= 0 OR min(hours) >= 0
        OR count(budget) <> 2 OR count(hours) <> 2
      ) unbalanced""",
    )


def install(db):
    with cursor(db) as cur:
        cur.execute((HERE / "install.sql").read_text())


def backfill(db, high, size):
    position = total = 0
    chunks = []
    sql = (HERE / "backfill.sql").read_text()
    while position < high:
        started = CLOCK()
        with cursor(db) as cur:
            phase = scalar(
                cur, "SELECT phase FROM knot_bench.control WHERE singleton FOR SHARE"
            )
            check(phase == "dual", "Backfill requires dual mode")
            cur.execute(sql, (position, high, size))
            position, count = cur.fetchone()
        if not count:
            break
        total += count
        chunks.append(ms(CLOCK() - started))
    return {
        "rowsCopied": total,
        "committedChunks": len(chunks),
        "longestChunkMs": max(chunks, default=0),
    }


class Refused(Exception):
    pass


def fence(db, action, baseline=None, high=None):
    start = CLOCK()
    result = {"action": action}
    refused = False
    acquired = None
    try:
        with cursor(db) as cur:
            phase = scalar(
                cur, "SELECT phase FROM knot_bench.control WHERE singleton FOR UPDATE"
            )
            acquired = CLOCK()
            expected = {
                "expand": "legacy",
                "early-cutover": "dual",
                "failed-cutover": "dual",
                "cutover": "dual",
                "rollback": "normalized",
            }[action]
            check(phase == expected, "Wrong migration phase")
            if action == "expand":
                cur.execute((HERE / "expand.sql").read_text())
            elif action in ("early-cutover", "failed-cutover", "cutover"):
                # Challenge exactly the live gate; the modification and attempted switch share one transaction.
                if action == "failed-cutover":
                    cur.execute(
                        "UPDATE knot_bench.line_unit SET amount=amount+1 WHERE id=(SELECT min(id) FROM knot_bench.line_key) AND unit='budget'"
                    )
                    check(cur.rowcount == 1, "Missing negative-control row")
                result["legacyDifferences"] = differences(cur, WIDE)
                result["newDifferences"] = differences(cur, NORMALIZED)
                if result["legacyDifferences"] or result["newDifferences"]:
                    raise Refused()
                check(
                    state_digest(cur, ERP, high) == baseline,
                    "Immutable history changed before cutover",
                )
                cur.execute(
                    "CREATE OR REPLACE VIEW knot_bench.current_lines AS SELECT * FROM knot_bench.normalized_lines"
                )
                cur.execute("DROP TABLE knot_bench.wide")
                cur.execute(
                    "UPDATE knot_bench.control SET phase='normalized' WHERE singleton"
                )
            else:
                # The old physical table is already gone. Rebuild it from current v2, including later ERP writes.
                check(differences(cur, NORMALIZED) == 0, "Drift before rollback")
                cur.execute("""CREATE TABLE knot_bench.wide (
                  id integer PRIMARY KEY, name text UNIQUE NOT NULL, company_id integer NOT NULL,
                  account_id integer NOT NULL,budget numeric NOT NULL,hours numeric NOT NULL)""")
                cur.execute(
                    "INSERT INTO knot_bench.wide SELECT * FROM knot_bench.normalized_lines"
                )
                result["rebuiltLegacyRows"] = cur.rowcount
                result["legacyDifferences"] = differences(cur, WIDE)
                check(
                    result["legacyDifferences"] == 0,
                    "Rollback reconstruction disagrees with Odoo",
                )
                cur.execute(
                    "CREATE OR REPLACE VIEW knot_bench.current_lines AS SELECT * FROM knot_bench.wide"
                )
                cur.execute(
                    "UPDATE knot_bench.control SET phase='dual' WHERE singleton"
                )
    except Refused:
        if action not in ("early-cutover", "failed-cutover"):
            raise RuntimeError("Cutover rejected divergent live projections")
        refused = True
    finish = CLOCK()
    check(
        acquired is not None
        and refused == (action in ("early-cutover", "failed-cutover")),
        "Cutover challenge did not fail closed",
    )
    result.update(
        gateAcquisitionMs=ms(acquired - start),
        gateHeldThroughCommitOrRollbackMs=ms(finish - acquired),
        totalMs=ms(finish - start),
        transaction="rolled-back" if refused else "committed",
    )
    return result


def observe(db, phase, high, baseline, projections):
    with cursor(db) as cur:
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        active = scalar(cur, "SELECT phase FROM knot_bench.control WHERE singleton")
        check(active == phase, "Unexpected active representation")
        witness = {
            "mode": active,
            "erpHistory": state_digest(cur, ERP, high),
            "activeHistory": state_digest(cur, CURRENT, high),
            "erpRows": scalar(cur, "SELECT count(*) FROM knot_bench.erp_lines"),
            "widePhysicalTable": scalar(
                cur, "SELECT to_regclass('knot_bench.wide') IS NOT NULL"
            ),
            "unbalancedRequestPairs": pairs(cur),
            "projectionDifferences": {p: differences(cur, p) for p in projections},
        }
        check(
            witness["erpHistory"] == baseline and witness["activeHistory"] == baseline,
            "Historical row digest mismatch",
        )
        check(
            not any(witness["projectionDifferences"].values())
            and witness["unbalancedRequestPairs"] == 0,
            "ERP reconciliation failed",
        )
    return witness
