/** Integration checks. Execute the shipped WASM engine, then read exported data with native SQLite. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {createLab} from './engine.mjs';
import {backgroundId} from './scenarios.mjs';

const tables = [
  'batch', 'commitment', 'cost_center', 'dependency', 'fiscal_period', 'journal',
  'meta', 'opening', 'pool', 'project', 'route', 'skill',
];
const digest = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

function readExport(lab, file) {
  const bytes = lab.exportDatabase();
  assert.equal(Buffer.from(bytes.subarray(0, 16)).toString('latin1'), 'SQLite format 3\0');
  writeFileSync(file, bytes);
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
    assert.deepEqual(names.map(row => row.name), tables);
    const counts = {}, hashes = {}, records = {};
    for (const name of tables) {
      // The name is from a fixed allowlist. Composite primary keys give each snapshot a stable order.
      const columns = db.prepare('SELECT name, pk FROM pragma_table_info(?) ORDER BY pk').all(name);
      const keys = columns.filter(column => column.pk > 0).map(column => '"' + column.name.replaceAll('"','""') + '"');
      assert(keys.length > 0, 'missing primary key for ' + name);
      const rows = db.prepare('SELECT * FROM "' + name + '" ORDER BY ' + keys.join(', ')).all();
      counts[name] = rows.length;
      hashes[name] = digest(rows);
      records[name] = rows;
    }
    return {counts, hashes, records, digest:digest(hashes), bytes:bytes.length,
      nativeSQLite:db.prepare('SELECT sqlite_version() AS version').get().version};
  } finally {
    db.close();
  }
}

function sameState(left, right, why) {
  assert.deepEqual(right.hashes, left.hashes, why);
}

function unchangedExcept(left, right, allowed, why) {
  for (const name of tables) {
    if (!allowed.includes(name)) assert.equal(right.hashes[name], left.hashes[name], why + ': ' + name);
  }
}

function expectCode(result, code, ok) {
  assert.equal(result.code, code);
  assert.equal(result.ok, ok, code);
  return result;
}

function audit(lab) {
  const a = lab.audit();
  assert.equal(a.ok, true, JSON.stringify(a));
  for (const key of ['foreignKeyViolations','ledgerUnbalanced','projectionMismatches']) {
    assert.equal(a[key], 0, key);
  }
}

function rejection(lab, capture, eventId, reason) {
  lab.reset();
  const before = capture();
  const p = lab.prepare(eventId);
  const preview = expectCode(lab.inspect(p), 'blocked', false);
  assert(preview.issues.some(item => item.code === reason), JSON.stringify(preview.issues));
  expectCode(lab.apply(p), 'blocked', false);
  sameState(before, capture(), eventId + ' rejection changed a table');
  lab.reopen();
  sameState(before, capture(), eventId + ' reopened after rejection');
  audit(lab);
  return {case:eventId, before:before.digest, persistedAfter:before.digest, issues:preview.issues};
}

function drifted(lab, capture) {
  lab.reset();
  const before = capture();
  const proposal = lab.prepare('stale');
  expectCode(lab.inspect(proposal), 'ready', true);
  lab.drift(proposal);
  const booked = capture();
  unchangedExcept(before, booked, ['meta','commitment'], 'booking the intervening commitment');
  assert.equal(booked.counts.commitment, before.counts.commitment + 1);
  assert.notEqual(booked.hashes.meta, before.hashes.meta);
  expectCode(lab.apply(proposal), 'stale', false);
  lab.reopen();
  sameState(booked, capture(), 'the stale plan must preserve the newly booked commitment');
  audit(lab);
  return {case:'stale', before:before.digest, afterCommitment:booked.digest, persistedAfterRejection:booked.digest};
}

function routing(lab, capture) {
  lab.reset();
  const before = capture();
  const proposal = lab.prepare('deadline');
  for (const destination of ['02-PLAT-ENG', '01-PLAT-QA']) {
    const candidate = {...proposal, lines:[{...proposal.lines[0],to:destination}]};
    const result = expectCode(lab.apply(candidate), 'blocked', false);
    assert(result.issues.some(issue => issue.code === 'route'));
    sameState(before, capture(), 'cross-period or cross-skill movement altered rows');
  }
  return {case:'routing', blockedDestinations:['02-PLAT-ENG','01-PLAT-QA'], allTablesUnchanged:before.digest};
}

function elapsed(task) {
  const start = performance.now();
  const value = task();
  return {value, ms:Math.round((performance.now() - start) * 10)/10};
}

const deadlineLines = [
  {from:'01-DATA-ENG', to:'01-PLAT-ENG', budget:220, hours:80},
  {from:'01-DATA-QA', to:'01-PLAT-QA', budget:100, hours:40},
];

function commitAndRetry(lab, capture, eventId) {
  const before = capture();
  const p = lab.prepare(eventId);
  const preview = expectCode(lab.inspect(p), 'ready', true);
  sameState(before, capture(), 'preview changed a table');
  if (eventId === 'deadline') assert.deepEqual(p.lines, deadlineLines);
  if (eventId === 'rollback') {
    expectCode(lab.apply(p, {fault:true}), 'rolled-back', false);
    sameState(before, capture(), 'injected failure left partial postings');
    lab.reopen();
    sameState(before, capture(), 'reopen after injected failure');
  }
  const applied = elapsed(() => lab.apply(p));
  expectCode(applied.value, 'committed', true);
  const after = capture();
  assert.equal(after.counts.batch, before.counts.batch + 1);
  assert.equal(after.counts.journal, before.counts.journal + 2 * p.lines.length);
  assert.deepEqual(after.records.batch.filter(row => row.id !== p.id), before.records.batch, 'prior batches changed');
  assert.deepEqual(after.records.journal.filter(row => row.batch !== p.id), before.records.journal, 'prior postings changed');
  unchangedExcept(before, after, ['meta','project','pool','batch','journal'], 'commit altered another table');
  assertPosted(before, after, p);
  lab.reopen();
  sameState(after, capture(), 'reopen lost committed state');
  expectCode(lab.apply(p), 'duplicate', true);
  sameState(after, capture(), 'replaying the same id changed rows');
  const different = structuredClone(p);
  different.lines[0].budget += 1;
  expectCode(lab.apply(different), 'id-conflict', false);
  sameState(after, capture(), 'another payload with the same id changed rows');
  audit(lab);
  return {case:eventId, before:before.digest, after:after.digest, beforeCounts:before.counts,
    afterCounts:after.counts, lines:p.lines, checkedPools:preview.rows.length, commitMilliseconds:applied.ms};
}

function shared(lab, capture) {
  lab.reset();
  const before = capture();
  const p = lab.prepare('shared-pool');
  assert.equal(p.lines.length, 2);
  for (const line of p.lines) {
    assert.equal(line.from, '01-DATA-ENG');
    assert.equal(line.budget, 220);
    assert.equal(line.hours, 90);
    const receiver = before.records.pool.find(pool => pool.id === line.to);
    expectCode(lab.inspect({...p, project:receiver.project, lines:[line]}), 'ready', true);
  }
  const preview = expectCode(lab.inspect(p), 'blocked', false);
  const reasons = preview.issues.map(x => x.code);
  assert(reasons.includes('budget-floor') && reasons.includes('hours-floor'), JSON.stringify(reasons));
  expectCode(lab.apply(p), 'blocked', false);
  sameState(before, capture(), 'shared overcommit changed committed data');
  const exact = lab.revise(p, 1, 150, 70);
  const exactRow = expectCode(lab.inspect(exact), 'ready', true).rows.find(row => row.pool === '01-DATA-ENG');
  assert.deepEqual([exactRow.budgetAfter, exactRow.hoursAfter], [630, 260]);
  assert.deepEqual([exactRow.committedBudget, exactRow.committedHours], [630, 260]);
  for (const [budget,hours,code] of [[151,70,'budget-floor'],[150,71,'hours-floor']]) {
    const extra = lab.revise(p,1,budget,hours);
    const rejection = expectCode(lab.apply(extra), 'blocked', false);
    assert.deepEqual(rejection.issues.map(item => item.code), [code]);
    sameState(before, capture(), 'one extra unit accepted against '+code);
  }
  const corrected = lab.revise(p, 1, 140, 60);
  expectCode(lab.apply(corrected), 'committed', true);
  const after = capture();
  assertPosted(before, after, corrected);
  const donor = after.records.pool.find(row => row.id === '01-DATA-ENG');
  assert.deepEqual([donor.budget, donor.hours], [640, 270]);
  return {case:'shared-pool', individuallyEligible:2, combinedIssues:preview.issues, unchangedOnRejection:before.digest,
    exactBoundary:[630,260], singleUnitRejections:['budget-floor','hours-floor'],
    corrected:{spent:[360,150],remaining:[donor.budget,donor.hours],committedDigest:after.digest}};
}

// Compute the expected database image directly from the request and the previous records.
function assertPosted(before, after, proposal) {
  const deltas = new Map();
  const expectedJournal = [];
  for (const [index,line] of proposal.lines.entries()) {
    for (const [pool,sign] of [[line.from,-1],[line.to,1]]) {
      const budget = sign * line.budget, hours = sign * line.hours;
      expectedJournal.push({batch:proposal.id, item:index+1, sign, pool, budget, hours});
      const change = deltas.get(pool) || {budget:0, hours:0};
      deltas.set(pool, {budget:change.budget+budget, hours:change.hours+hours});
    }
  }
  const journal = after.records.journal.filter(row => row.batch === proposal.id);
  assert.deepEqual(journal.map(row => ({...row})), expectedJournal, 'signed postings differ from proposed lines');
  const byPool = new Map(before.records.pool.map(row => [row.id, row]));
  for (const current of after.records.pool) {
    const original = byPool.get(current.id);
    assert(original, 'unexpected pool ' + current.id);
    const delta = deltas.get(current.id) || {budget:0, hours:0};
    assert.deepEqual({...current}, {...original, budget:original.budget+delta.budget, hours:original.hours+delta.hours});
  }
  assert.equal(after.counts.pool, before.counts.pool);
  assert.equal(after.counts.project, before.counts.project);
  const oldProjects = new Map(before.records.project.map(row => [row.id,row]));
  for (const row of after.records.project) {
    const original = oldProjects.get(row.id);
    const priority = row.id === proposal.project ? proposal.priority : original.priority;
    assert.deepEqual({...row}, {...original,priority});
  }
  const batch = after.records.batch.find(row => row.id === proposal.id);
  assert.equal(batch.project, proposal.project);
  assert.equal(batch.revision, before.records.meta[0].revision+1);
  assert.equal(after.records.meta[0].revision, batch.revision);
  assert.equal(batch.items, proposal.lines.length);
  assert.equal(batch.budget, proposal.lines.reduce((sum,line) => sum+line.budget,0));
  assert.equal(batch.hours, proposal.lines.reduce((sum,line) => sum+line.hours,0));
  assertReconciled(after);
}

// Independently reconstruct every final pool, including untouched periods and centres.
function assertReconciled(after) {
  const opening = new Map(after.records.opening.map(row => [row.pool,{budget:row.budget,hours:row.hours}]));
  for (const row of after.records.journal) {
    const balance = opening.get(row.pool);
    assert(balance);
    balance.budget += row.budget;
    balance.hours += row.hours;
  }
  assert.equal(opening.size, after.counts.pool);
  for (const row of after.records.pool) {
    assert.deepEqual(opening.get(row.id), {budget:row.budget,hours:row.hours}, 'opening-to-ledger mismatch on '+row.id);
  }
}

function repeatedPostings(lab, capture) {
  const seeded = elapsed(() => lab.reset(10000));
  const first = capture();
  const expected = [];
  const priorities = new Map();
  const posted = elapsed(() => {
    for (let batch = 0; batch < 100; batch += 1) {
      const proposal = lab.prepare('portfolio-wave');
      proposal.project = backgroundId(16*batch+2);
      proposal.lines = proposal.lines.map((line,index) => {
        const recipient = 16*batch+2*(1+Math.floor(index/2));
        const suffix = index%2===0?'-01-ENG':'-01-QA';
        return {...line,from:backgroundId(recipient-1)+suffix,to:backgroundId(recipient)+suffix};
      });
      if (batch===50) {
        const beforeFault = capture();
        const failed = expectCode(lab.apply(proposal,{fault:true}),'rolled-back',false);
        assert.equal(failed.state.counts.ledgerLines,batch*32);
        sameState(beforeFault,capture(),'interrupted batch 51 changed the persistent database');
      }
      const outcome = expectCode(lab.apply(proposal),'committed',true);
      assert.equal(outcome.state.counts.ledgerLines,(batch+1)*32);
      if (batch%10===0) expectCode(lab.apply(proposal),'duplicate',true);
      for (const [index,line] of proposal.lines.entries()) {
        for (const [pool,sign] of [[line.from,-1],[line.to,1]]) {
          expected.push({batch:proposal.id,item:index+1,sign,pool,budget:sign*line.budget,hours:sign*line.hours});
        }
      }
      priorities.set(proposal.project,proposal.priority);
    }
  });
  const finalState = lab.reopen();
  const final = capture();
  unchangedExcept(first,final,['pool','project','batch','journal','meta'],'extended load');
  assert.equal(final.counts.project,10004);
  assert.equal(final.counts.pool,60012);
  assert.equal(final.counts.commitment,120008);
  assert.equal(final.counts.dependency,30000);
  assert.equal(final.counts.batch,100);
  assert.deepEqual(final.records.journal.map(row=>({...row})),expected);
  assert.equal(final.records.meta[0].revision,101);
  assert.deepEqual(finalState.totals,seeded.value.totals);
  assertReconciled(final);
  audit(lab);
  assert.deepEqual(final.records.project.map(row=>({...row})),first.records.project.map(row=>(
    {...row,priority:priorities.get(row.id) ?? row.priority})));
  return {counts:final.counts, finalRevision:101, batches:100, signedJournalRows:expected.length,
    checkedPools:final.counts.pool, duplicateChecks:10, rolledBackBatch:51,
    sourceStateSHA256:first.digest, reconciledStateSHA256:final.digest,
    seedMilliseconds:seeded.ms, exerciseMilliseconds:posted.ms,
    timingScope:'local observations including one independent snapshot-based rollback check'};
}

async function main() {
  const {values:options} = parseArgs({options:{out:{type:'string'},native:{type:'string'}}});
  const scratch = mkdtempSync(join(tmpdir(), 'knot-sqlite-check-'));
  try {
    const lab = await createLab();
    const capture = () => readExport(lab, join(scratch, 'export.sqlite'));
    const initial = capture();
    const cases = [commitAndRetry(lab, capture, 'deadline'), shared(lab,capture), drifted(lab,capture)];
    lab.reset();
    cases.push(commitAndRetry(lab,capture,'rollback'));
    cases.push(rejection(lab,capture,'closed-period','closed'));
    cases.push(rejection(lab,capture,'dependency','dependency'), routing(lab,capture));

    const large = elapsed(() => lab.reset(2000));
    const grown = capture();
    assert.equal(grown.counts.project, initial.counts.project+2000);
    assert.equal(grown.counts.pool, initial.counts.pool+12000);
    assert.equal(grown.counts.commitment, initial.counts.commitment+24000);
    assert.equal(grown.counts.dependency, 6000);
    const largeCase = commitAndRetry(lab,capture,'portfolio-wave');
    assert.equal(largeCase.afterCounts.journal,32);
    assert.equal(largeCase.checkedPools,32);
    assert.equal(largeCase.lines.length,16);
    const owners = new Map(grown.records.pool.map(row=>[row.id,row.project]));
    assert.equal(new Set(largeCase.lines.map(line=>owners.get(line.to))).size,8);
    assert.deepEqual(largeCase.lines.reduce(([b,h],line)=>[b+line.budget,h+line.hours],[0,0]),[560,240]);
    // Posting another batch must preserve the complete first batch and its 32 ledger rows.
    const following = commitAndRetry(lab,capture,'deadline');
    assert.equal(following.afterCounts.batch,2);
    assert.equal(following.afterCounts.journal,36);
    const report = {
      result:'PASS', node:process.version, nativeSQLite:initial.nativeSQLite, platform:process.platform, arch:process.arch,
      method:'sql.js executes the application. A separate native SQLite reader checks exported records in primary-key order, foreign keys, integrity, signed postings and each pool against the opening balance and journal.',
      sources:Object.fromEntries(['check.mjs','engine.mjs','schema.sql','scenarios.mjs','recorded-plans.json','sql-wasm.js','sql-wasm.wasm']
        .map(name => [name,createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex')])),
      baseline:{counts:initial.counts, tableRowSHA256:initial.hashes}, cases,
      scale:{addedProjects:2000, seedMilliseconds:large.ms, exportedBytes:grown.bytes, ...largeCase, subsequentCommit:following.after,
        measured:'One local in-process seed and one commit call. Export, verification and setup are outside commit timing.'},
    };
    if (options.native) report.nativeComparison = compareNative(lab, capture, resolve(options.native));
    report.extendedLoad = repeatedPostings(lab,capture);
    const formatted = JSON.stringify(report,null,2)+'\n';
    if (options.out) writeFileSync(options.out, formatted, {flag:'wx'});
    process.stdout.write(formatted);
  } finally {
    rmSync(scratch, {recursive:true,force:true});
  }
}


const fields = ['budget','hours','budgetIn','hoursIn','budgetOut','hoursOut','minBudget','minHours',
  'maxBudget','maxHours','committedBudget','committedHours','closed','locked'];
const numericRules = ['closed','locked','budget-floor','hours-floor','budget-ceiling','hours-ceiling'];

// Reconstruct the formal input from a different SQLite reader. The planner's displayed rows
// are tested against this frame; a mistake in the app's join cannot supply both sides.
function nativeRows(records, proposal) {
  const pools = new Map(records.pool.map(x => [x.id,x]));
  const closed = new Map(records.fiscal_period.map(x => [x.id,x.closed]));
  const committed = new Map();
  for (const row of records.commitment) {
    if (row.status !== 'approved') continue;
    const sum = committed.get(row.pool) || {budget:0,hours:0};
    sum.budget += row.budget;
    sum.hours += row.hours;
    committed.set(row.pool,sum);
  }
  const rows = new Map();
  for (const line of proposal.lines) {
    for (const [id,side] of [[line.from,'Out'],[line.to,'In']]) {
      const p = pools.get(id);
      assert(p);
      if (!rows.has(id)) {
        rows.set(id,{pool:id,budget:p.budget,hours:p.hours,budgetIn:0,hoursIn:0,budgetOut:0,hoursOut:0,
          minBudget:p.min_budget,minHours:p.min_hours,maxBudget:p.max_budget,maxHours:p.max_hours,
          committedBudget:committed.get(id)?.budget || 0,committedHours:committed.get(id)?.hours || 0,
          closed:closed.get(p.period),locked:p.locked});
      }
      const row = rows.get(id);
      row['budget'+side] += line.budget;
      row['hours'+side] += line.hours;
    }
  }
  return [...rows.values()];
}

function compareNative(lab, capture, binary) {
  const run = (args) => execFileSync(binary,args,{timeout:15000});
  const nativePolicy = run(['policy']);
  const policies = ['./policy.json', '../formal/policy.json', './formal/policy.json']
    .map(name => new URL(name,import.meta.url)).filter(url => existsSync(url));
  assert(policies.length > 0, 'no shipped Lean policy');
  for (const url of policies) assert(nativePolicy.equals(readFileSync(url)), 'native policy differs from ' + url.pathname);
  const cases = [];
  for (const event of ['deadline','shared-pool','shared-revised','stale','rollback','closed-period','dependency','portfolio-wave']) {
    lab.reset(event==='portfolio-wave' ? 2000 : 0);
    let p = lab.prepare(event==='shared-revised' ? 'shared-pool' : event);
    if (event==='shared-revised') p = lab.revise(p,1,140,60);
    if (event==='stale') lab.drift(p);
    const before = capture();
    const preview = lab.inspect(p);
    const rows = nativeRows(before.records,p);
    const appRows = new Map(preview.rows.map(row => [row.pool,row]));
    assert.equal(appRows.size, rows.length);
    const vectors = [];
    for (const row of rows) {
      const values = fields.map(field => row[field]);
      assert(values.every(Number.isSafeInteger));
      assert.deepEqual(fields.map(field => appRows.get(row.pool)[field]), values, event+' SQL join '+row.pool);
      const native = JSON.parse(run(['row',...values.map(String)]));
      const reasons = preview.issues.filter(i => i.pool===row.pool && numericRules.includes(i.code)).map(i=>i.code);
      assert.deepEqual(native.reasons,reasons);
      assert.equal(native.accepted,reasons.length===0);
      const expected = native.accepted ? [row.budget+row.budgetIn-row.budgetOut,row.hours+row.hoursIn-row.hoursOut] : [row.budget,row.hours];
      assert.deepEqual([native.budget,native.hours],expected);
      vectors.push(...values.map(String));
    }
    const oldRevision = before.records.meta[0].revision;
    const model = JSON.parse(run(['batch',String(oldRevision),String(p.revision),...vectors]));
    const relationalIssues = preview.issues.filter(i => !numericRules.includes(i.code));
    const sql = lab.apply(p);
    assert.equal(sql.ok, model.accepted && relationalIssues.length===0, event+' acceptance');
    if (event==='dependency') {
      assert.equal(model.accepted,true);
      assert(relationalIssues.some(i => i.code==='dependency'));
    }
    const after = capture();
    if (sql.ok) {
      assertPosted(before,after,p);
      const stored = new Map(after.records.pool.map(row => [row.id,row]));
      const balances = rows.map(row => ({budget:stored.get(row.pool).budget,hours:stored.get(row.pool).hours}));
      assert.deepEqual(balances,model.balances,event+' persisted values vs native Lean');
      assert.equal(after.records.meta[0].revision,model.version);
    } else {
      sameState(before,after,event+' changed a rejected transaction');
      if (!model.accepted) {
        assert.deepEqual(model.balances,rows.map(row=>({budget:row.budget,hours:row.hours})));
        assert.equal(model.version,oldRevision);
      }
    }
    cases.push({case:event, joinedRows:rows.length, nativeBatchAccepted:model.accepted,
      relationalIssues:[...new Set(relationalIssues.map(i=>i.code))], applicationCode:sql.code, storedDigest:after.digest});
  }
  return {policySHA256:createHash('sha256').update(nativePolicy).digest('hex'),
    binarySHA256:createHash('sha256').update(readFileSync(binary)).digest('hex'), cases,
    scope:'Separate native SQLite reads reconstruct each participating row. The compiled Lean CLI checks each row and assembled batch. Additional relational restrictions are enforced in the application.'};
}

await main();
