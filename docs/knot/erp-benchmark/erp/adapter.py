"""Native Odoo Community project accounting through authenticated XML-RPC."""

import hashlib
import hmac
import http.client
import os
import re
from urllib.parse import urlsplit
from xmlrpc.client import ServerProxy, Transport

from policy_gate import POLICY_HASH, check_transfer

MODEL = "account.analytic.line"
PREFIX = "KNOTBENCH:"
BATCH_LINES = 500


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class LocalTransport(Transport):
    """One request per call. An ambiguous write must not be replayed by the client."""

    def request(self, host, handler, request_body, verbose=False):
        return self.single_request(host, handler, request_body, verbose)

    def make_connection(self, host):
        if self._connection and self._connection[0] == host:
            return self._connection[1]
        connection = http.client.HTTPConnection(host, timeout=180)
        self._connection = host, connection
        return connection


class Odoo:
    def __init__(self, login, password):
        self.db = os.environ["KNOT_ODOO_DB"]
        require(
            re.fullmatch(r"knotbench_[a-f0-9]{12}", self.db),
            "Expected a fresh benchmark database",
        )
        url = os.environ["KNOT_ODOO_URL"]
        target = urlsplit(url)
        require(
            target.scheme == "http"
            and target.hostname == "127.0.0.1"
            and target.port
            and target.username is None
            and not target.path
            and not target.query
            and not target.fragment,
            "Expected a loopback benchmark endpoint",
        )
        self.password = password
        self.common = ServerProxy(url + "/xmlrpc/2/common", transport=LocalTransport())
        self.models = ServerProxy(url + "/xmlrpc/2/object", transport=LocalTransport())
        self.uid = self.common.authenticate(self.db, login, password, {})
        require(type(self.uid) is int and self.uid > 0, "Odoo authentication failed")
        self.context = {
            "tracking_disable": True,
            "no_reset_password": True,
            "mail_create_nosubscribe": True,
        }

    def call(self, model, method, args, **kwargs):
        kwargs.setdefault("context", self.context)
        return self.models.execute_kw(
            self.db, self.uid, self.password, model, method, args, kwargs
        )

    def external_id(self, full_name):
        module, name = full_name.split(".")
        rows = self.call(
            "ir.model.data",
            "search_read",
            [[("module", "=", module), ("name", "=", name)]],
            fields=["res_id"],
            limit=2,
        )
        require(len(rows) == 1, "Missing Odoo record " + full_name)
        return rows[0]["res_id"]


def admin():
    return Odoo(os.environ["KNOT_ODOO_LOGIN"], os.environ["KNOT_ODOO_PASSWORD"])


def worker_password(index):
    secret = os.environ["KNOT_ODOO_PASSWORD"].encode()
    return hmac.new(
        secret, f"analytic-writer-{index}".encode(), hashlib.sha256
    ).hexdigest()


def setup(workers):
    """Provision synthetic projects, accounts and distinct internal analytic users once per database."""
    require(
        type(workers) is int and 1 <= workers <= 128,
        "Expected between 1 and 128 writers",
    )
    api = admin()
    version = api.common.version()
    require(version["server_version_info"][0] == 18, "Odoo 18 is required")
    marker = api.call("ir.config_parameter", "get_param", ["knotbench.fresh_db"])
    require(marker == api.db, "Expected a benchmark-provisioned disposable database")
    require(
        not api.call(MODEL, "search_count", [[("name", "=like", PREFIX + "%")]]),
        "Existing benchmark lines",
    )
    require(
        not api.call(
            "res.company", "search_count", [[("name", "=", "Knot benchmark")]]
        ),
        "Existing benchmark company",
    )
    company = api.call("res.company", "create", [{"name": "Knot benchmark"}])
    admin_company_ids = api.call(
        "res.users", "read", [[api.uid]], fields=["company_ids"]
    )[0]["company_ids"]
    if company not in admin_company_ids:
        api.call("res.users", "write", [[api.uid], {"company_ids": [[4, company]]}])
    api.context["allowed_company_ids"] = [company]
    plan = api.external_id("analytic.analytic_plan_projects")
    hour = api.external_id("uom.product_uom_hour")
    groups = [
        api.external_id(x)
        for x in ("base.group_user", "analytic.group_analytic_accounting")
    ]
    accounts = api.call(
        "account.analytic.account",
        "create",
        [
            [
                {
                    "name": f"Knot account {n + 1}",
                    "code": f"KNOT-{n + 1:03}",
                    "company_id": company,
                    "plan_id": plan,
                }
                for n in range(max(4, workers * 2))
            ]
        ],
    )
    projects = api.call(
        "project.project",
        "create",
        [
            [
                {
                    "name": f"Knot project {n + 1}",
                    "account_id": a,
                    "company_id": company,
                }
                for n, a in enumerate(accounts)
            ]
        ],
    )
    project_read = api.call(
        "project.project", "read", [projects], fields=["account_id", "company_id"]
    )
    require(
        {(r["id"], r["company_id"][0], r["account_id"][0]) for r in project_read}
        == set(zip(projects, [company] * len(accounts), accounts)),
        "Project-account linkage mismatch",
    )
    logins = [f"knot-analytic-{i}" for i in range(workers)]
    users = api.call(
        "res.users",
        "create",
        [
            [
                {
                    "name": f"Knot analytic writer {i + 1}",
                    "login": login,
                    "password": worker_password(i),
                    "company_id": company,
                    "company_ids": [[6, 0, [company]]],
                    "groups_id": [[6, 0, groups]],
                }
                for i, login in enumerate(logins)
            ]
        ],
    )
    currency = api.call("res.company", "read", [[company]], fields=["currency_id"])[0][
        "currency_id"
    ]
    return {
        "odoo_version": version["server_version"],
        "odoo_version_info": version["server_version_info"],
        "company_id": company,
        "currency": currency[1],
        "hour_uom_id": hour,
        "accounts": accounts,
        "projects": projects,
        "workers": users,
        "logins": logins,
        "source_model": MODEL,
    }


OPENING = (1_000_000, 1_000_000)


def pair(fixture, key, donor, recipient, money, hours):
    return [
        {
            "name": f"{PREFIX}{key}:{suffix}",
            "date": "2026-11-25",
            "company_id": fixture["company_id"],
            "account_id": account,
            "amount": sign * money,
            "unit_amount": sign * hours,
            "product_uom_id": fixture["hour_uom_id"],
        }
        for suffix, account, sign in (("D", donor, -1), ("C", recipient, 1))
    ]


def seed(fixture, nlines):
    """Insert real native Odoo records in bounded model.create batches of complete pairs."""
    require(
        type(nlines) is int and nlines > 0 and nlines % 2 == 0,
        "Expected a positive even line count",
    )
    api = admin()
    api.context["allowed_company_ids"] = [fixture["company_id"]]
    batches = 0
    for start in range(0, nlines // 2, BATCH_LINES // 2):
        data = []
        for i in range(start, min(nlines // 2, start + BATCH_LINES // 2)):
            lane = (i // 2) % (len(fixture["accounts"]) // 2)
            a, b = fixture["accounts"][2 * lane : 2 * lane + 2]
            donor, recipient = (b, a) if i % 2 else (a, b)
            data.extend(
                pair(
                    fixture,
                    f"H{i:08d}",
                    donor,
                    recipient,
                    1 + (i // 2) % 17,
                    1 + (i // 2) % 5,
                )
            )
        ids = api.call(MODEL, "create", [data])
        require(len(ids) == len(data) == len(set(ids)), "Incomplete Odoo seed receipt")
        batches += 1
    reader = admin()
    reader.context["allowed_company_ids"] = [fixture["company_id"]]
    count = reader.call(
        MODEL,
        "search_count",
        [
            [
                ("company_id", "=", fixture["company_id"]),
                ("name", "=like", PREFIX + "H%"),
            ]
        ],
    )
    require(count == nlines, "Independent Odoo read-back count mismatch")
    # Exercise the same posting path with a deliberate floor violation. Observe before and after ERP counts.
    probe = Writer(fixture, 0)
    rejected = probe.submit("NEGATIVE", 0, probe.balances[0][0], 1)
    require(
        not rejected["accepted"] and "budget-floor" in rejected["reasons"]["donor"],
        "Expected policy refusal",
    )
    after = reader.call(
        MODEL,
        "search_count",
        [[("company_id", "=", fixture["company_id"]), ("name", "=like", PREFIX + "%")]],
    )
    require(after == count, "Rejected transfer generated an ERP record")
    fixture["policyChallenge"] = {
        "sha256": POLICY_HASH,
        "openingPerAccount": list(OPENING),
        "donor": probe.balances[0],
        "recipient": probe.balances[1],
        "requestedBudget": probe.balances[0][0],
        "requestedHours": 1,
        "outcome": rejected,
        "beforeErpLines": count,
        "afterErpLines": after,
    }
    return {"lines": count, "pairs": count // 2, "orm_create_calls": batches}


class Writer:
    def __init__(self, fixture, index):
        self.fixture = fixture
        self.index = index
        self.api = Odoo(fixture["logins"][index], worker_password(index))
        require(self.api.uid == fixture["workers"][index], "Unexpected writer identity")
        self.api.context["allowed_company_ids"] = [fixture["company_id"]]
        self.accounts = fixture["accounts"][2 * index : 2 * index + 2]
        totals = self.api.call(
            MODEL,
            "read_group",
            [
                [("name", "=like", PREFIX + "%"), ("account_id", "in", self.accounts)],
                ["amount:sum", "unit_amount:sum"],
                ["account_id"],
            ],
            lazy=False,
        )
        net = {r["account_id"][0]: (r["amount"], r["unit_amount"]) for r in totals}
        self.balances = []
        for account in self.accounts:
            delta = net.get(account, (0, 0))
            require(all(v == int(v) for v in delta), "Nonintegral benchmark balances")
            self.balances.append([OPENING[i] + int(delta[i]) for i in range(2)])

    def submit(self, key, direction, money, hours):
        other = 1 - direction
        decision = check_transfer(
            self.balances[direction], self.balances[other], money, hours
        )
        if not decision["accepted"]:
            return decision
        vals = pair(
            self.fixture,
            key,
            self.accounts[direction],
            self.accounts[other],
            money,
            hours,
        )
        ids = self.api.call(MODEL, "create", [vals])
        require(
            isinstance(ids, list) and len(ids) == 2 and ids[0] != ids[1],
            "Incomplete Odoo posting receipt",
        )
        self.balances[direction] = decision["donorAfter"]
        self.balances[other] = decision["recipientAfter"]
        return {"accepted": True, "ids": ids}

    def post(self, sequence):
        require(
            type(sequence) is int and sequence >= 0,
            "Expected a non-negative request sequence",
        )
        result = self.submit(
            f"L{self.index}-{sequence}",
            sequence % 2,
            1 + (sequence // 2) % 17,
            1 + (sequence // 2) % 5,
        )
        require(result["accepted"], "Unexpected live policy refusal")
        return result["ids"]


def writer(fixture, index):
    return Writer(fixture, index)
