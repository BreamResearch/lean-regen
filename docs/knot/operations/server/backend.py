"""Local, authenticated ERP ledger service for the Knot operational exercise."""

from collections import defaultdict
from contextlib import closing, contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3

from migration import inspect, migrate, MigrationBlocked, statements

HERE = Path(__file__).resolve().parent
DEFAULT_POLICY = HERE.parents[1] / "formal/policy.json"
POLICY_SHA = "13386006f5808a6c287db5ce430de2c6190c0a75fc24ba088571e73cc18994aa"
LIMIT = 1_000_000_000


class Denied(Exception):
    def __init__(self, status, code, detail=None):
        self.status, self.code, self.detail = status, code, detail


def connect(path):
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA recursive_triggers=ON")
    db.execute("PRAGMA synchronous=FULL")
    return db


def bootstrap(path):
    """Create an exclusive synthetic database; bearer secrets are returned only in memory."""
    with path.open("xb"):
        pass
    path.chmod(0o600)
    tokens = {}
    with closing(connect(path)) as db:
        if db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
            raise RuntimeError("SQLite WAL is required")
        db.execute("BEGIN IMMEDIATE")
        statements(db, (HERE / "schema.sql").read_text())
        for actor, role, scopes in [
            ("finance", "poster", ["HQ", "FIELD"]),
            ("planning", "poster", ["HQ", "FIELD"]),
            ("limited", "poster", ["HQ"]),
            ("viewer", "reader", ["HQ", "FIELD"]),
            ("operations", "operator", ["HQ", "FIELD"]),
        ]:
            token = secrets.token_urlsafe(32)
            tokens[actor] = token
            db.execute(
                "INSERT INTO principal VALUES(?,?,?)",
                (actor, sha256(token.encode()).digest(), role),
            )
            db.executemany(
                "INSERT INTO grant_scope VALUES(?,?)", [(actor, s) for s in scopes]
            )
        db.executemany("INSERT INTO period VALUES(?,?)", [("Q1", 0), ("Q0", 1)])
        fixtures = [
            ("A", "A", "Q1", "HQ", "dev", 750, 600, 180, 100, 1000, 900, 0),
            ("B", "B", "Q1", "FIELD", "dev", 300, 250, 50, 40, 700, 600, 0),
            ("C", "C", "Q1", "HQ", "dev", 180, 150, 30, 20, 500, 450, 0),
            ("D", "D", "Q0", "HQ", "dev", 120, 80, 10, 10, 200, 200, 0),
            ("E", "E", "Q1", "HQ", "audit", 120, 80, 10, 10, 200, 200, 0),
            ("F", "F", "Q1", "FIELD", "dev", 150, 100, 10, 10, 200, 200, 1),
            ("G", "G", "Q1", "HQ", "dev", 100, 50, 10, 10, 200, 200, 0),
            ("H", "H", "Q0", "HQ", "dev", 120, 80, 10, 10, 200, 200, 0),
        ]
        for (
            pool,
            project,
            period,
            center,
            skill,
            b,
            h,
            mb,
            mh,
            xb,
            xh,
            locked,
        ) in fixtures:
            db.execute(
                "INSERT INTO project VALUES(?,?,?)", (project, 1, int(project != "E"))
            )
            db.execute(
                "INSERT INTO pool VALUES(?,?,?,?,?,?,?,?,?,?)",
                (pool, project, period, center, skill, mb, mh, xb, xh, locked),
            )
            db.execute("INSERT INTO opening VALUES(?,?,?)", (pool, b, h))
            db.execute("INSERT INTO balance_v1 VALUES(?,?,?)", (pool, b, h))
        db.execute("INSERT INTO dependency VALUES('G','E')")
        db.executemany(
            "INSERT INTO route VALUES(?,?,?)",
            [("HQ", "HQ", "dev"), ("HQ", "FIELD", "dev"), ("FIELD", "FIELD", "dev")],
        )
        db.execute("INSERT INTO commitment VALUES('order-A','A',270,170,1)")
        db.commit()
    return tokens


def eval_expr(node, values):
    if type(node) is int:
        return node
    if isinstance(node, str):
        return values[node]
    op, a, b = node
    x, y = eval_expr(a, values), eval_expr(b, values)
    if op == "add":
        return x + y
    if op == "max":
        return max(x, y)
    if op == "gt":
        return x > y
    if op == "lt":
        return x < y
    if op == "eq":
        return x == y
    if op == "and":
        return x and y
    if op == "or":
        return x or y
    raise ValueError("Unknown published policy operation")


class Ledger:
    def __init__(self, path, policy=DEFAULT_POLICY, on_contention=None):
        body = Path(policy).read_bytes()
        if sha256(body).hexdigest() != POLICY_SHA:
            raise ValueError("Wrong Lean policy export")
        self.policy = json.loads(body)["rules"]
        self.path = path
        self.on_contention = on_contention

    @contextmanager
    def transaction(self, write, tag=""):
        with closing(connect(self.path)) as db:
            if write:
                # Probe for operational contention, then use SQLite's normal bounded wait.
                db.execute("PRAGMA busy_timeout=50")
                try:
                    db.execute("BEGIN IMMEDIATE")
                except sqlite3.OperationalError as error:
                    if (
                        "locked" not in str(error).lower()
                        and "busy" not in str(error).lower()
                    ):
                        raise
                    if self.on_contention:
                        self.on_contention(tag)
                    db.execute("PRAGMA busy_timeout=10000")
                    db.execute("BEGIN IMMEDIATE")
            else:
                db.execute("BEGIN")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    @staticmethod
    def principal(db, token):
        row = db.execute(
            "SELECT id,role FROM principal WHERE token_hash=?",
            (sha256(token.encode()).digest(),),
        ).fetchone()
        if not row:
            raise Denied(401, "unauthenticated")
        scopes = {
            r[0]
            for r in db.execute(
                "SELECT center FROM grant_scope WHERE principal=?", (row["id"],)
            )
        }
        return row, scopes

    def view(self, token):
        with self.transaction(False) as db:
            actor, scopes = self.principal(db, token)
            phase, revision = db.execute(
                "SELECT phase,revision FROM control"
            ).fetchone()
            pools = [
                dict(r)
                for r in db.execute(
                    "SELECT p.id,p.center,b.budget,b.hours FROM pool p JOIN balance_v1 b ON b.pool=p.id ORDER BY p.id"
                )
                if r["center"] in scopes
            ]
            return {
                "actor": actor["id"],
                "phase": phase,
                "revision": revision,
                "pools": pools,
            }

    def admin(self, token, action):
        with self.transaction(action != "inspect") as db:
            actor, _ = self.principal(db, token)
            if actor["role"] != "operator":
                raise Denied(403, "role-denied")
            if action == "inspect":
                return inspect(db)
            try:
                return migrate(db, action)
            except MigrationBlocked as error:
                raise Denied(409, str(error))

    @staticmethod
    def validate(body):
        if not isinstance(body, dict) or set(body) != {
            "key",
            "revision",
            "project",
            "priority",
            "lines",
        }:
            raise Denied(400, "invalid-shape")
        if (
            not isinstance(body["key"], str)
            or not 1 <= len(body["key"]) <= 100
            or not isinstance(body["project"], str)
        ):
            raise Denied(400, "invalid-shape")
        if (
            type(body["revision"]) is not int
            or not 1 <= body["revision"] <= 2**63 - 1
            or type(body["priority"]) is not int
            or not 0 <= body["priority"] <= 2
        ):
            raise Denied(400, "invalid-shape")
        if not isinstance(body["lines"], list) or not 1 <= len(body["lines"]) <= 20:
            raise Denied(400, "invalid-shape")
        for line in body["lines"]:
            if (
                not isinstance(line, dict)
                or set(line) != {"from", "to", "budget", "hours"}
                or any(
                    not isinstance(line[k], str) or not 1 <= len(line[k]) <= 80
                    for k in ("from", "to")
                )
                or line["from"] == line["to"]
                or any(
                    type(line[k]) is not int or not 1 <= line[k] <= LIMIT
                    for k in ("budget", "hours")
                )
            ):
                raise Denied(400, "invalid-line")

    @staticmethod
    def balances(db, pool, writer):
        if writer == 2:
            units = dict(
                db.execute("SELECT unit,amount FROM balance_v2 WHERE pool=?", (pool,))
            )
            if len(units) == 2:
                return units["budget"], units["hours"]
        return tuple(
            db.execute(
                "SELECT budget,hours FROM balance_v1 WHERE pool=?", (pool,)
            ).fetchone()
        )

    def post(self, token, writer, body):
        # Authenticate before taking a writer lock; authorize again inside the transaction.
        with self.transaction(False) as pre:
            actor, _ = self.principal(pre, token)
            if actor["role"] != "poster":
                raise Denied(403, "role-denied")
        self.validate(body)
        with self.transaction(True, body["key"]) as db:
            actor, scopes = self.principal(db, token)
            if actor["role"] != "poster":
                raise Denied(403, "role-denied")
            phase, revision = db.execute(
                "SELECT phase,revision FROM control"
            ).fetchone()
            if writer == 2 and phase == "v1":
                raise Denied(409, "schema-not-expanded")
            grouped = defaultdict(
                lambda: dict(budgetIn=0, hoursIn=0, budgetOut=0, hoursOut=0)
            )
            for line in body["lines"]:
                for direction, side in (("Out", "from"), ("In", "to")):
                    for unit in ("budget", "hours"):
                        grouped[line[side]][unit + direction] += line[unit]
            pools = {}
            for name in grouped:
                pool = db.execute(
                    """SELECT p.*,f.closed,
                 COALESCE((SELECT SUM(budget) FROM commitment c WHERE c.pool=p.id AND c.approved=1),0) committedBudget,
                 COALESCE((SELECT SUM(hours) FROM commitment c WHERE c.pool=p.id AND c.approved=1),0) committedHours
                 FROM pool p JOIN period f ON f.id=p.period WHERE p.id=?""",
                    (name,),
                ).fetchone()
                if not pool or pool["center"] not in scopes:
                    raise Denied(403, "scope-denied")
                pools[name] = pool
            fingerprint = sha256(
                json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            old = db.execute(
                "SELECT revision,body_hash FROM receipt WHERE actor=? AND request_key=?",
                (actor["id"], body["key"]),
            ).fetchone()
            if old:
                if old["body_hash"] != fingerprint:
                    raise Denied(409, "key-conflict")
                return {
                    "result": "duplicate",
                    "revision": old["revision"],
                    "actor": actor["id"],
                }
            if body["revision"] != revision:
                raise Denied(409, "stale")
            recipients = {pools[v["to"]]["project"] for v in body["lines"]}
            if body["project"] not in recipients:
                raise Denied(422, "project-mismatch")
            if (
                db.execute(
                    "SELECT priority FROM project WHERE id=?", (body["project"],)
                ).fetchone()[0]
                > body["priority"]
            ):
                raise Denied(422, "priority")
            for project in recipients:
                if db.execute(
                    "SELECT 1 FROM dependency d JOIN project p ON d.prerequisite=p.id WHERE d.project=? AND p.ready=0",
                    (project,),
                ).fetchone():
                    raise Denied(422, "dependency")
            for line in body["lines"]:
                a, b = pools[line["from"]], pools[line["to"]]
                if (
                    a["period"] != b["period"]
                    or a["skill"] != b["skill"]
                    or not db.execute(
                        "SELECT 1 FROM route WHERE origin=? AND destination=? AND skill=?",
                        (a["center"], b["center"], a["skill"]),
                    ).fetchone()
                ):
                    raise Denied(422, "route")
            updates = {}
            issues = []
            for name, deltas in grouped.items():
                row = pools[name]
                budget, hours = self.balances(db, name, writer)
                values = dict(
                    deltas,
                    budget=budget,
                    hours=hours,
                    minBudget=row["min_budget"],
                    minHours=row["min_hours"],
                    maxBudget=row["max_budget"],
                    maxHours=row["max_hours"],
                    committedBudget=row["committedBudget"],
                    committedHours=row["committedHours"],
                    closed=row["closed"],
                    locked=row["locked"],
                )
                issues.extend(
                    {"pool": name, "code": r["code"]}
                    for r in self.policy
                    if eval_expr(r["fail"], values)
                )
                updates[name] = (
                    budget + deltas["budgetIn"] - deltas["budgetOut"],
                    hours + deltas["hoursIn"] - deltas["hoursOut"],
                )
            if issues:
                raise Denied(422, "policy", issues)
            new = revision + 1
            db.execute(
                "INSERT INTO receipt VALUES(?,?,?,?,?,?,?,?)",
                (
                    new,
                    actor["id"],
                    body["key"],
                    fingerprint,
                    writer,
                    phase,
                    body["project"],
                    body["priority"],
                ),
            )
            for name, (budget, hours) in updates.items():
                if writer == 1:
                    db.execute(
                        "UPDATE balance_v1 SET budget=?,hours=? WHERE pool=?",
                        (budget, hours, name),
                    )
                else:
                    for unit, amount in (("budget", budget), ("hours", hours)):
                        db.execute(
                            "INSERT INTO balance_v2 VALUES(?,?,?) ON CONFLICT(pool,unit) DO UPDATE SET amount=excluded.amount",
                            (name, unit, amount),
                        )
            for item, line in enumerate(body["lines"]):
                for leg, side in ((-1, "from"), (1, "to")):
                    db.execute(
                        "INSERT INTO journal VALUES(?,?,?,?,?,?)",
                        (new, item, leg, line[side], line["budget"], line["hours"]),
                    )
            db.execute(
                "UPDATE project SET priority=? WHERE id=?",
                (body["priority"], body["project"]),
            )
            db.execute("UPDATE control SET revision=?", (new,))
            return {"result": "committed", "revision": new, "actor": actor["id"]}


def serve(ledger, address=("127.0.0.1", 0)):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_request(self):
            parts = self.headers.get("Authorization", "").split()
            token = parts[1] if len(parts) == 2 and parts[0] == "Bearer" else ""
            if self.command == "GET" and self.path == "/state":
                return ledger.view(token)
            if self.command == "GET" and self.path == "/admin/reconcile":
                return ledger.admin(token, "inspect")
            if self.command == "POST" and self.path in ("/v1/post", "/v2/post"):
                try:
                    count = int(self.headers.get("Content-Length", "0"))
                    if not 0 < count <= 32768:
                        raise ValueError()
                    data = json.loads(self.rfile.read(count))
                except (UnicodeError, ValueError):
                    raise Denied(400, "invalid-json")
                return ledger.post(token, int(self.path[2]), data)
            if self.command == "POST" and self.path in (
                "/admin/expand",
                "/admin/backfill",
                "/admin/contract",
                "/admin/rollback",
            ):
                return ledger.admin(token, self.path.rsplit("/", 1)[1])
            raise Denied(404, "unknown-endpoint")

        def dispatch(self):
            try:
                status, body = 200, self.handle_request()
            except Denied as e:
                status, body = e.status, {"error": e.code, "issues": e.detail}
            except sqlite3.OperationalError as e:
                if "locked" not in str(e).lower() and "busy" not in str(e).lower():
                    raise
                status, body = 503, {"error": "storage-busy"}
            encoded = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        do_POST = dispatch
        do_GET = dispatch

    return ThreadingHTTPServer(address, Handler)
