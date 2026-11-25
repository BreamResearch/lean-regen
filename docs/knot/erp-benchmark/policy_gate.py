"""Evaluate the frozen Knot account guards for the benchmark's integer planning units."""

from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
POLICY_HASH = "13386006f5808a6c287db5ce430de2c6190c0a75fc24ba088571e73cc18994aa"
MAX_AMOUNT = 2_000_000
MIN_BUDGET = 100
MIN_HOURS = 40


@lru_cache(maxsize=1)
def rules():
    data = (HERE.parent / "formal/policy.json").read_bytes()
    if sha256(data).hexdigest() != POLICY_HASH:
        raise ValueError("Frozen Knot policy digest differs")
    return json.loads(data)["rules"]


def evaluate(node, row):
    if type(node) is int:
        return node
    if isinstance(node, str):
        return row[node]
    op, left, right = node
    a = evaluate(left, row)
    b = evaluate(right, row)
    if op == "eq":
        return a == b
    if op == "lt":
        return a < b
    if op == "gt":
        return a > b
    if op == "or":
        return a or b
    if op == "and":
        return a and b
    if op == "add":
        return a + b
    if op == "max":
        return max(a, b)
    raise ValueError("Unsupported frozen guard opcode")


def check_transfer(donor, recipient, budget, hours):
    if (
        len(donor) != 2
        or len(recipient) != 2
        or any(
            type(v) is not int or not 0 <= v <= MAX_AMOUNT for v in (*donor, *recipient)
        )
    ):
        raise ValueError(
            "Expected two nonnegative, bounded integer balances per account"
        )
    if type(budget) is not int or type(hours) is not int or min(budget, hours) <= 0:
        raise ValueError("Transfer amount and effort must be positive integers")
    failures = {}
    for label, balance, outgoing in [
        ("donor", donor, True),
        ("recipient", recipient, False),
    ]:
        row = {
            "budget": balance[0],
            "hours": balance[1],
            "budgetIn": 0 if outgoing else budget,
            "hoursIn": 0 if outgoing else hours,
            "budgetOut": budget if outgoing else 0,
            "hoursOut": hours if outgoing else 0,
            "minBudget": MIN_BUDGET,
            "minHours": MIN_HOURS,
            "maxBudget": MAX_AMOUNT,
            "maxHours": MAX_AMOUNT,
            "committedBudget": MIN_BUDGET,
            "committedHours": MIN_HOURS,
            "closed": 0,
            "locked": 0,
        }
        failures[label] = [
            rule["code"] for rule in rules() if evaluate(rule["fail"], row)
        ]
    accepted = not any(failures.values())
    return {
        "accepted": accepted,
        "reasons": failures,
        "donorAfter": [donor[0] - budget, donor[1] - hours]
        if accepted
        else list(donor),
        "recipientAfter": [recipient[0] + budget, recipient[1] + hours]
        if accepted
        else list(recipient),
    }
