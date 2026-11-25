"""Online migration between legacy columns and normalized unit balances."""

from hashlib import sha256
import json
import sqlite3


def statements(db, sql):
    # executescript implicitly commits an open transaction in Python's sqlite3.
    pending = ""
    for line in sql.splitlines(keepends=True):
        pending += line
        if sqlite3.complete_statement(pending):
            db.execute(pending)
            pending = ""
    if pending.strip():
        raise ValueError("Incomplete schema statement")


LEGACY = """CREATE TABLE balance_v1(pool TEXT PRIMARY KEY REFERENCES pool(id),
 budget INTEGER NOT NULL CHECK(budget>=0),hours INTEGER NOT NULL CHECK(hours>=0)) STRICT"""
MIRRORS = """
CREATE TRIGGER legacy_mirror AFTER UPDATE OF budget,hours ON balance_v1 BEGIN
 INSERT INTO balance_v2(pool,unit,amount) VALUES(NEW.pool,'budget',NEW.budget),(NEW.pool,'hours',NEW.hours)
 ON CONFLICT(pool,unit) DO UPDATE SET amount=excluded.amount WHERE balance_v2.amount!=excluded.amount;
END;
CREATE TRIGGER normalized_insert AFTER INSERT ON balance_v2 BEGIN
 UPDATE balance_v1 SET budget=NEW.amount WHERE pool=NEW.pool AND NEW.unit='budget' AND budget!=NEW.amount;
 UPDATE balance_v1 SET hours=NEW.amount WHERE pool=NEW.pool AND NEW.unit='hours' AND hours!=NEW.amount;
END;
CREATE TRIGGER normalized_update AFTER UPDATE OF amount ON balance_v2 BEGIN
 UPDATE balance_v1 SET budget=NEW.amount WHERE pool=NEW.pool AND NEW.unit='budget' AND budget!=NEW.amount;
 UPDATE balance_v1 SET hours=NEW.amount WHERE pool=NEW.pool AND NEW.unit='hours' AND hours!=NEW.amount;
END;
"""
COMPATIBILITY = """
CREATE VIEW balance_v1 AS SELECT pool,
 MAX(CASE WHEN unit='budget' THEN amount END) AS budget,
 MAX(CASE WHEN unit='hours' THEN amount END) AS hours FROM balance_v2 GROUP BY pool;
CREATE TRIGGER legacy_compat INSTEAD OF UPDATE OF budget,hours ON balance_v1 BEGIN
 UPDATE balance_v2 SET amount=NEW.budget WHERE pool=OLD.pool AND unit='budget';
 UPDATE balance_v2 SET amount=NEW.hours WHERE pool=OLD.pool AND unit='hours';
END;
"""


def inspect(db):
    phase, revision = db.execute("SELECT phase,revision FROM control").fetchone()
    pools = db.execute("SELECT COUNT(*) FROM pool").fetchone()[0]
    missing = mismatches = 0
    if phase != "v1":
        missing = db.execute(
            "SELECT 2*(SELECT COUNT(*) FROM pool)-COUNT(*) FROM balance_v2"
        ).fetchone()[0]
        mismatches = db.execute("""SELECT COUNT(*) FROM balance_v2 n JOIN balance_v1 old USING(pool)
          WHERE n.amount != CASE n.unit WHEN 'budget' THEN old.budget ELSE old.hours END""").fetchone()[
            0
        ]
    drift = db.execute("""SELECT COUNT(*) FROM opening o LEFT JOIN balance_v1 b USING(pool)
      LEFT JOIN (SELECT pool,SUM(leg*budget) delta_b,SUM(leg*hours) delta_h FROM journal GROUP BY pool) j USING(pool)
      WHERE b.budget IS NULL OR b.hours IS NULL OR b.budget != o.budget+COALESCE(j.delta_b,0)
         OR b.hours != o.hours+COALESCE(j.delta_h,0)""").fetchone()[0]
    unbalanced = db.execute("""SELECT COUNT(*) FROM (SELECT revision,item FROM journal GROUP BY revision,item
      HAVING COUNT(*)!=2 OR SUM(leg*budget)!=0 OR SUM(leg*hours)!=0)""").fetchone()[0]
    receipts = db.execute("SELECT COUNT(*) FROM receipt").fetchone()[0]
    empty = db.execute(
        "SELECT COUNT(*) FROM receipt r WHERE NOT EXISTS(SELECT 1 FROM journal j WHERE j.revision=r.revision)"
    ).fetchone()[0]
    first, last = db.execute(
        "SELECT MIN(revision),MAX(revision) FROM receipt"
    ).fetchone()
    contiguous = (
        revision == 1
        if receipts == 0
        else first == 2 and last == revision and receipts == revision - 1
    )
    bad_refs = len(db.execute("PRAGMA foreign_key_check").fetchall())
    return {
        "phase": phase,
        "revision": revision,
        "pools": pools,
        "missingUnitRows": missing,
        "divergentBalances": mismatches,
        "openingJournalMismatches": drift,
        "unbalancedItems": unbalanced,
        "receiptCount": receipts,
        "emptyReceipts": empty,
        "contiguousRevisions": contiguous,
        "foreignKeyErrors": bad_refs,
        "clean": not (
            missing
            or mismatches
            or drift
            or unbalanced
            or empty
            or bad_refs
            or not contiguous
        ),
    }


def data_digest(db):
    tables = {
        "balances": "SELECT pool,budget,hours FROM balance_v1 ORDER BY pool",
        "projects": "SELECT id,priority,ready FROM project ORDER BY id",
        "receipts": "SELECT * FROM receipt ORDER BY revision",
        "journal": "SELECT * FROM journal ORDER BY revision,item,leg",
        "revision": "SELECT revision FROM control",
    }
    state = {
        name: [list(row) for row in db.execute(sql)] for name, sql in tables.items()
    }
    return sha256(
        json.dumps(state, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class MigrationBlocked(Exception):
    pass


def migrate(db, action, chunk=1):
    """Caller has authenticated the operator and holds BEGIN IMMEDIATE."""
    phase = db.execute("SELECT phase FROM control").fetchone()[0]
    before = data_digest(db) if action in ("contract", "rollback") else None
    if action == "expand" and phase == "v1":
        db.execute("""CREATE TABLE balance_v2(pool TEXT REFERENCES pool(id),unit TEXT CHECK(unit IN ('budget','hours')),
          amount INTEGER NOT NULL CHECK(amount>=0),PRIMARY KEY(pool,unit)) STRICT""")
        statements(db, MIRRORS)
        db.execute("UPDATE control SET phase='expanded'")
    elif action == "backfill" and phase == "expanded":
        ids = db.execute(
            """SELECT b.pool FROM balance_v1 b LEFT JOIN balance_v2 n USING(pool)
          GROUP BY b.pool HAVING count(n.unit)<2 ORDER BY b.pool LIMIT ?""",
            (chunk,),
        ).fetchall()
        for row in ids:
            for unit in ("budget", "hours"):
                db.execute(
                    f"""INSERT OR IGNORE INTO balance_v2(pool,unit,amount)
                  SELECT pool,?,{unit} FROM balance_v1 WHERE pool=?""",
                    (unit, row[0]),
                )
    elif action == "contract" and phase == "expanded":
        if not inspect(db)["clean"]:
            raise MigrationBlocked("reconciliation-failed")
        for name in ("legacy_mirror", "normalized_insert", "normalized_update"):
            db.execute("DROP TRIGGER " + name)
        db.execute("DROP TABLE balance_v1")
        statements(db, COMPATIBILITY)
        db.execute("UPDATE control SET phase='v2'")
    elif action == "rollback" and phase == "v2":
        if not inspect(db)["clean"]:
            raise MigrationBlocked("reconciliation-failed")
        db.execute("DROP VIEW balance_v1")
        db.execute(LEGACY)
        db.execute("""INSERT INTO balance_v1 SELECT b.pool,b.amount,h.amount FROM balance_v2 b
          JOIN balance_v2 h ON h.pool=b.pool AND h.unit='hours' WHERE b.unit='budget' """)
        statements(db, MIRRORS)
        db.execute("UPDATE control SET phase='expanded'")
    else:
        raise MigrationBlocked("wrong-migration-phase")
    result = inspect(db)
    if before is not None:
        after = data_digest(db)
        if not result["clean"] or after != before:
            raise MigrationBlocked("reconciliation-failed")
        result["beforeDataSha256"] = before
        result["afterDataSha256"] = after
    return result
