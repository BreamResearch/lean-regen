"""Predeclared arrivals, supervised advice and measurements for concurrent ERP clients."""

from bisect import bisect_right
from collections import Counter
from hashlib import sha256
import json
import math
import threading
import time


CLOCK = time.perf_counter


def digest(value):
    return sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def milliseconds(seconds):
    return round(1000 * seconds, 3)


def distribution(seconds):
    s = sorted(seconds)
    return {
        k: milliseconds(s[max(0, math.ceil(q * len(s)) - 1)]) if s else None
        for k, q in (("p50", 0.50), ("p95", 0.95), ("p99", 0.99), ("max", 1.0))
    }


def schedule(writers, smoke):
    # Every burst offers one independent transaction per principal. Arrival times and payload
    # sequence are precomputed; slow writers queue every subsequent intent in their own lane.
    windows = [(0, 4, 16), (4, 16, 32), (16, 23, 8), (23, 32, 32), (32, 44, 16)]
    if smoke:
        windows = [(0, 1, 8), (1, 3, 16), (3, 6, 8), (6, 9, 16), (9, 13, 8)]
    segments = []
    lanes = [[] for _ in range(writers)]
    for start, end, rate in windows:
        segments.append(
            {"startMs": 1000 * start, "endMs": 1000 * end, "requestsPerSecond": rate}
        )
        for group in range(math.ceil((end - start) * rate / writers)):
            offset = 1000 * start + round(group * 1000 * writers / rate)
            if offset >= 1000 * end:
                break
            for lane in lanes:
                lane.append(offset)
    return segments, lanes


def structured_advice(obs):
    if not obs["eligible"]:
        return {"action": "defer", "reason": "gate-ineligible"}
    if obs["recentP95Ms"] is None:
        return {"action": "defer", "reason": "missing-live-latency-observation"}
    if obs["elapsedMs"] < obs["windowStartMs"]:
        return {"action": "defer", "reason": "scheduled-quiet-window-ahead"}
    if obs["queuedRequests"] > 8 or (obs["recentP95Ms"] or 0) > 500:
        return {"action": "defer", "reason": "observed-queue-or-tail-over-budget"}
    return {"action": "proceed", "reason": "window-open-or-past-within-pressure-budget"}


class Traffic:
    def __init__(self, fixture, lanes, segments):
        from erp import adapter

        self.lanes = lanes
        self.segments = segments
        self.sessions = [adapter.writer(fixture, i) for i in range(len(lanes))]
        self.condition = threading.Condition()
        self.stop = threading.Event()
        self.samples = []
        self.launched = 0
        self.errors = []
        self.threads = []

    def __enter__(self):
        self.t0 = CLOCK() + 0.1
        for i in range(len(self.lanes)):
            t = threading.Thread(target=self._worker, args=(i,), daemon=True)
            self.threads.append(t)
            t.start()
        self.until(0)
        return self

    def _worker(self, i):
        try:
            for sequence, due in enumerate(self.lanes[i]):
                if self.stop.wait(max(0, self.t0 + due / 1000 - CLOCK())):
                    return
                start = CLOCK()
                with self.condition:
                    self.launched += 1
                ids = self.sessions[i].post(sequence)
                finish = CLOCK()
                if (
                    len(ids) != 2
                    or any(type(v) is not int or v <= 0 for v in ids)
                    or ids[0] == ids[1]
                ):
                    raise RuntimeError("Invalid Odoo receipt")
                with self.condition:
                    self.samples.append((i, sequence, due, start, finish, *ids))
                    self.condition.notify_all()
        except Exception as exc:
            with self.condition:
                self.errors.append((i, type(exc).__name__))
                self.stop.set()
                self.condition.notify_all()

    def healthy(self):
        if self.errors:
            raise RuntimeError(f"ERP request failed in lane {self.errors[0]}")

    def until(self, offset_ms):
        if self.stop.wait(max(0, self.t0 + offset_ms / 1000 - CLOCK())):
            self.healthy()

    def __exit__(self, exc_type, exc, trace):
        if exc is not None:
            self.stop.set()
        deadline = self.t0 + self.segments[-1]["endMs"] / 1000 + 120
        for t in self.threads:
            t.join(max(0, deadline - CLOCK()))
        if any(t.is_alive() for t in self.threads):
            self.stop.set()
            raise RuntimeError("Offered requests did not drain")
        if exc is None:
            self.healthy()

    def telemetry(self):
        with self.condition:
            self.healthy()
            now = CLOCK()
            age = milliseconds(now - self.t0)
            offered = sum(bisect_right(lane, age) for lane in self.lanes)
            recent = [r for r in self.samples if now - 2 <= r[4] <= now]
            ends = [max(self.t0, now - 2), *sorted(r[4] for r in recent), now]
            return {
                "elapsedMs": age,
                "queuedRequests": max(0, offered - self.launched),
                "outstandingRequests": self.launched - len(self.samples),
                "recentP95Ms": distribution(
                    [r[4] - self.t0 - r[2] / 1000 for r in recent]
                )["p95"],
                "recentGapMs": milliseconds(max(b - a for a, b in zip(ends, ends[1:]))),
                "scheduledRate": next(
                    (
                        s["requestsPerSecond"]
                        for s in self.segments
                        if s["startMs"] <= age < s["endMs"]
                    ),
                    0,
                ),
            }

    def wait_post_cutover(self, start):
        deadline = CLOCK() + 20
        with self.condition:
            while CLOCK() < deadline:
                self.healthy()
                lanes = {r[0] for r in self.samples if r[3] >= start}
                if len(lanes) == len(self.lanes) or len(self.samples) == sum(
                    map(len, self.lanes)
                ):
                    return len(lanes)
                self.condition.wait(0.05)
        return len(lanes)

    def metrics(self):
        ordered = sorted(self.samples, key=lambda r: r[4])
        offered = sum(map(len, self.lanes))
        if len(ordered) != offered:
            raise RuntimeError("Some offered intents disappeared")
        offered_end = self.t0 + self.segments[-1]["endMs"] / 1000
        last = max(offered_end, ordered[-1][4])
        lag = [r[3] - (self.t0 + r[2] / 1000) for r in ordered]
        spans = [r[4] - r[3] for r in ordered]
        sojourn = [r[4] - (self.t0 + r[2] / 1000) for r in ordered]
        ends = [self.t0, *[r[4] for r in ordered], last]
        endpoints = sorted(
            (t, change) for r in ordered for t, change in ((r[3], 1), (r[4], -1))
        )
        concurrent = peak = 0
        for _, change in endpoints:
            concurrent += change
            peak = max(peak, concurrent)
        # Group tail by SCHEDULED interval so migration-delayed requests remain in their offered cohort.
        windows = []
        for s in self.segments:
            cohort = [r for r in ordered if s["startMs"] <= r[2] < s["endMs"]]
            windows.append(
                {
                    **s,
                    "offered": len(cohort),
                    "scheduledToAckMs": distribution(
                        [r[4] - self.t0 - r[2] / 1000 for r in cohort]
                    ),
                }
            )
        return {
            "offered": offered,
            "acknowledged": len(ordered),
            "failed": len(self.errors),
            "peakInFlight": peak,
            "perWriter": dict(sorted(Counter(str(r[0]) for r in ordered).items())),
            "scheduledToAckMs": distribution(sojourn),
            "serviceMs": distribution(spans),
            "queueMs": distribution(lag),
            "maxResponseGapMs": milliseconds(
                max(b - a for a, b in zip(ends, ends[1:]))
            ),
            "achievedPerSecond": round(len(ordered) / (last - self.t0), 3),
            "drainBeyondOfferedEndMs": milliseconds(last - offered_end),
            "segments": windows,
        }
