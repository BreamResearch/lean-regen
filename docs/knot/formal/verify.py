#!/usr/bin/env python3
"""Check the frozen challenge, Lean-generated policy, native examples and incorrect implementations."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
LOCK_SHA256 = '362af276a453c4ede940f4079a56d2a51792d0a0a914d2e751f150a3720f4918'
CANDIDATE = ('Knot.lean', 'Knot/Policy.lean', 'Knot/Batch.lean', 'Knot/Proofs.lean')
MUTATIONS = (
    ('ignore-committed-budget', 'Knot/Policy.lean', '(max (f .minBudget) (f .committedBudget))', '(f .minBudget)'),
    ('allow-unbalanced-journal', 'Knot/Batch.lean', ' && decide (Balanced rows)', ''),
    ('reuse-stale-revision', 'Knot/Batch.lean', 'decide (current = expected)', 'true'),
)


def checked(args, cwd):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=150)
    if result.returncode:
        raise ValueError(f'{args[0]} failed: {result.stdout}\n{result.stderr}')
    return result.stdout


def write_snapshot(root, files):
    for name, body in files.items():
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)


def check_cases(binary, cases):
    fields = cases['fields']
    passed = {'rows': [], 'batches': []}
    for item in cases['rows']:
        values = [str(item['row'][k]) for k in fields]
        result = json.loads(checked([binary, 'row', *values], binary.parent))
        if result != item['expected']:
            raise ValueError(f"Unexpected row decision for {item['name']}: {result}")
        passed['rows'].append(item['name'])
    for item in cases['batches']:
        values = [str(row[k]) for row in item['rows'] for k in fields]
        args = [binary, 'batch', str(item['current']), str(item['expectedRevision']), *values]
        result = json.loads(checked(args, binary.parent))
        if result != item['expected']:
            raise ValueError(f"Unexpected batch decision for {item['name']}: {result}")
        passed['batches'].append(item['name'])
    return passed


def parse_audit(text, lock):
    axioms = {}
    for line in text.splitlines():
        match = re.fullmatch(r"'([^']+)' depends on axioms: \[(.*?)\]", line)
        if not match:
            raise ValueError('Unexpected axiom audit line: ' + line)
        name, raw = match.groups()
        used = raw.split(', ') if raw else []
        if name in axioms or set(used) - set(lock['allowed_axioms']):
            raise ValueError('Unexpected theorem or axiom: ' + line)
        axioms[name] = used
    if set(axioms) != set(lock['theorems']):
        raise ValueError('The audit did not cover all required theorem names')
    return axioms


def verify(bindir, out):
    if out.exists() or out.is_symlink():
        raise ValueError('Choose a fresh evidence output filename')
    lock_bytes = (ROOT / 'contract-lock.json').read_bytes()
    if sha256(lock_bytes).hexdigest() != LOCK_SHA256:
        raise ValueError('Changed contract lock')
    lock = json.loads(lock_bytes)
    files = {n:(ROOT/n).read_bytes() for n in (*lock['files'], *CANDIDATE)}
    hashes = {n:sha256(b).hexdigest() for n,b in files.items()}
    if not all(hashes[n] == digest for n,digest in lock['files'].items()):
        raise ValueError('Changed frozen input')
    lean, lake = bindir / 'lean', bindir / 'lake'
    version = checked([lean,'--version'], ROOT).strip()
    lake_version = checked([lake,'--version'], ROOT).strip()
    if not version.startswith('Lean (version 4.19.0,') or not lake_version.endswith('(Lean version 4.19.0)'):
        raise ValueError('The official stable Lean/Lake 4.19.0 toolchain is required')
    with tempfile.TemporaryDirectory(prefix='knot-verifier-') as temporary:
        work = Path(temporary)
        clean = work / 'original'
        write_snapshot(clean, files)
        checked([lake, 'build'], clean)
        checked([lake, 'env', lean, '-DwarningAsError=true', 'Contract.lean'], clean)
        axiom_text = checked([lake, 'env', lean, '-DwarningAsError=true', 'Audit.lean'], clean)
        axioms = parse_audit(axiom_text, lock)
        binary = clean / '.lake/build/bin/knotCheck'
        generated = checked([binary,'policy'], clean).encode('utf-8')
        if generated != (ROOT/'policy.json').read_bytes():
            raise ValueError('policy.json differs from the verified native export')
        cases = check_cases(binary, json.loads(files['cases.json']))
        mutations = []
        for name, file, before, after in MUTATIONS:
            mutant = work / name
            modified = files[file].decode()
            if modified.count(before) != 1:
                raise ValueError(f'Original mutation site missing or ambiguous: {name}')
            write_snapshot(mutant, {**files, file: modified.replace(before,after).encode()})
            proc = subprocess.run([lake, 'build', 'Knot'], cwd=mutant, text=True, capture_output=True, timeout=150)
            output = proc.stdout + proc.stderr
            diagnostics = re.findall(r'^error: .*?Knot/Proofs\.lean:(\d+:\d+: [^\n]+)', output, re.M)
            if proc.returncode == 0 or not diagnostics:
                raise ValueError(f'{name}: expected the unchanged proof to fail\n{output}')
            mutations.append({'name':name,'modified_file':file,'rejected_by_original_proof':True,
                              'first_proof_diagnostic':diagnostics[0]})
        report = {'format':'knot-proof-evidence-v1','status':'CORE_KERNEL_CHECKED','theorem_count':len(axioms),
                  'toolchain_version':version,'contract_sha256':LOCK_SHA256,'source_files':hashes,
                  'theorem_axioms':axioms,'policy_sha256':sha256(generated).hexdigest(),
                  'policy_bytes_match_native_export':True,'native_cases':cases,'mutations':mutations,
                  'scope':'Joined per-account inputs, all-or-nothing balanced posting and revision model. Browser interpreter, SQL aggregation, live ERP and approval identity are separate.'}
        if any((ROOT / n).read_bytes() != body for n,body in files.items()):
            raise ValueError('Source changed during verification')
        out.parent.mkdir(parents=True,exist_ok=True)
        with out.open('x',encoding='utf-8') as file:
            json.dump(report,file,ensure_ascii=False,indent=2)
            file.write('\n')
    print(f"{len(axioms)} theorem obligations, {len(cases['rows'])} row cases, {len(cases['batches'])} batch cases, {len(mutations)} rejected mutations")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tool-bin',required=True,type=Path)
    parser.add_argument('--out',required=True,type=Path)
    args = parser.parse_args()
    try:
        verify(args.tool_bin.resolve(strict=True),args.out.resolve())
    except (OSError,ValueError,subprocess.TimeoutExpired) as error:
        parser.exit(2,str(error)+'\n')
