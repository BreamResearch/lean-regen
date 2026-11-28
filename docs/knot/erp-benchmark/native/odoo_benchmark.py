"""Run the existing migration exercise with each implementation of the Odoo guard."""

import argparse
from contextlib import closing, contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
from statistics import median
from time import perf_counter_ns

from erp import adapter
import policy_gate
import projection as pg
from suspension import clone, drive, seed_template
from suspension_workload import schedule

from .bridge import NativeGuard

HERE = Path(__file__).resolve().parent


@contextmanager
def use_adapter_guard(check):
    """Select the guard only for this disposable benchmark process, before clients start."""
    original = adapter.check_transfer
    adapter.check_transfer = check
    try:
        yield
    finally:
        adapter.check_transfer = original


def trial(args, fixture, segments, lanes, history, native_history, high, check):
    durations = []

    def timed(*args):
        start = perf_counter_ns()
        outcome = check(*args)
        durations.append(perf_counter_ns() - start)
        return outcome

    with use_adapter_guard(check):
        writer = adapter.writer(fixture, 0)
        refused = writer.submit('NATIVE-PROBE', 0, writer.balances[0][0], 1)
        pg.check(not refused['accepted'] and 'budget-floor' in refused['reasons']['donor'],
                 'The selected guard did not refuse the out-of-bounds live probe')
    with use_adapter_guard(timed):
        result = drive(args, fixture, segments, lanes, history, native_history, high, 'fixed')
    pg.check(len(durations) == result['workload']['acknowledged'], 'Unexpected number of real guard calls')
    pg.check(result['workload']['peakInFlight'] == args.writers, 'Expected all writer requests to overlap')
    pg.check(result['cutoverDuringOfferedLoad'], 'Expected cutover, later writes and rollback in this load profile')
    durations.sort()
    result['guard'] = {
        'calls': len(durations),
        'latencyUs': {f'p{p}': round(durations[(len(durations) * p + 99) // 100 - 1] / 1000, 3)
                      for p in (50, 95, 99)},
        'totalMs': round(sum(durations) / 1e6, 3),
        'refusedProbe': True,
    }
    del result['strategy']
    return result


def run(args):
    gate = NativeGuard(args.library)
    base = os.environ['KNOT_ODOO_DB']
    pg.check(base == os.environ['PGDATABASE'] and os.environ['PGHOST'] == '127.0.0.1',
             'Use the disposable loopback Odoo launcher')
    with closing(pg.connect('native-bootstrap')) as db, pg.cursor(db) as cur:
        pg.check(pg.scalar(cur, 'SELECT current_database()') == base
                 and 160000 <= db.server_version < 170000
                 and pg.scalar(cur, "SELECT to_regnamespace('knot_bench') IS NULL"),
                 'Expected a fresh PostgreSQL 16 Odoo database')
        postgres = pg.scalar(cur, 'SHOW server_version')
    fixture = adapter.setup(args.writers)
    adapter.seed(fixture, args.rows)
    with closing(pg.connect('native-baseline')) as db:
        pg.install(db)
        with pg.cursor(db) as cur:
            high = pg.scalar(cur, 'SELECT max(id) FROM knot_bench.erp_lines')
            history = pg.state_digest(cur, pg.ERP, high)
            native_history = pg.native_digest(cur, high)
            pg.check(history['rows'] == native_history['rows'] == args.rows, 'Unexpected opening history')

    segments, lanes = schedule(args.writers, args.smoke)
    checks = {'python': policy_gate.check_transfer, 'native': gate.check_transfer}
    trials = []
    with seed_template(base) as admin:
        for repeat in range(args.repeats):
            arms = ('python', 'native') if repeat % 2 == 0 else ('native', 'python')
            for arm in arms:
                print(f'Odoo repeat {repeat + 1}: {arm}', flush=True)
                with clone(admin, base):
                    result = trial(args, fixture, segments, lanes, history, native_history, high, checks[arm])
                result.update(repeat=repeat + 1, implementation=arm)
                trials.append(result)
    sources = ('guard.c', 'guard.h', 'bridge.py', 'odoo_benchmark.py', '../policy_gate.py',
               '../erp/adapter.py', '../suspension.py', '../suspension_workload.py', '../suspension_launcher.py',
               '../projection.py', '../benchmark.py', '../install.sql', '../expand.sql', '../backfill.sql',
               '../erp/run.py', '../erp/images.json', '../../formal/policy.json')
    return {
        'format': 'knot-native-odoo-comparison-v1',
        'status': 'PASS',
        'runtime': {'odoo': fixture['odoo_version'], 'postgresql': postgres,
                    'python': platform.python_version(), 'architecture': platform.machine(),
                    'deployment': json.loads(os.environ['KNOT_ERP_IMAGES'])},
        'parameters': {'rows': args.rows, 'writers': args.writers, 'repeats': args.repeats},
        'schedule': {'offered': sum(map(len, lanes)), 'segments': segments},
        'openingNativeHistory': native_history,
        'policySha256': policy_gate.POLICY_HASH,
        'binarySha256': sha256(args.library.read_bytes()).hexdigest(),
        'sourceSha256': {name: sha256((HERE / name).read_bytes()).hexdigest() for name in sources},
        'medians': {arm: {
            'guardP50Us': median([t['guard']['latencyUs']['p50'] for t in trials if t['implementation'] == arm]),
            'guardTotalMs': median([t['guard']['totalMs'] for t in trials if t['implementation'] == arm]),
            'e2eP95Ms': median([t['workload']['scheduledToAckMs']['p95'] for t in trials if t['implementation'] == arm]),
        } for arm in checks},
        'trials': trials,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--rows', type=int, default=100000)
    parser.add_argument('--writers', type=int, default=8)
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    if (args.out.exists() or args.rows < 100 or args.rows % 2 or not 1 <= args.writers <= 8
            or not 1 <= args.repeats <= 6 or (not args.smoke and (args.rows < 100000 or args.writers != 8))):
        parser.error('Choose a new output, even history and valid writer/repeat counts')
    report = run(args)
    with args.out.open('x', encoding='utf-8') as out:
        json.dump(report, out, indent=2, ensure_ascii=False, allow_nan=False)
        out.write('\n')
    print(f"PASS: {len(report['trials'])} Odoo trials, {report['schedule']['offered']} offers per trial", flush=True)


if __name__ == '__main__':
    main()
