/** Contract checks for the actual in-browser SQLite runtime, from the published layout. */
import assert from 'node:assert/strict';
import {createOperations} from './runtime.mjs';

const lab=await createOperations();
function summary(state) {
  return {revision:state.revision,phase:state.phase,counts:state.counts,pools:state.pools,postings:state.postings};
}
function step(action, expected, actor) {
  const state=lab.action(action,actor);
  assert.equal(state.last.code,expected);
  assert.equal(state.postings.reduce((sum,row)=>sum+row.budgetYen,0),0);
  assert.equal(state.postings.reduce((sum,row)=>sum+row.hours,0),0);
  return state;
}
function unchanged(action, expected, actor) {
  const before=summary(lab.state());
  const output=step(action,expected,actor);
  assert.deepEqual(summary(output),before);
  return output;
}
for (const first of ['a','b']) {
  lab.reset('race');
  const captured=step('capture','captured').seats;
  assert.deepEqual(captured,[{actor:'a',proposalRevision:1},{actor:'b',proposalRevision:1}]);
  const done=step('race','stale',first);
  assert.deepEqual(done.results.slice(-2).map(({actor,code})=>[actor,code]),
    [[first,'posted'],[first==='a'?'b':'a','stale']]);
  assert.equal(done.counts.batches,1);
  assert.equal(done.counts.postings,2);
  const retried=unchanged('retry','capacity-denied');
  assert.deepEqual(retried.last.reasons,['budget-floor','hours-floor']);
}
lab.reset('auth');
unchanged('submit','role-denied','planner');
unchanged('submit','role-denied','auditor');
unchanged('submit','scope-denied','foreign');
assert.deepEqual(unchanged('read','read-ok','foreign').last.visibleCenters,['RISK']);
assert.deepEqual(unchanged('read','read-ok','controller').last.visibleCenters,['DATA','PLAT']);
assert.equal(step('submit','posted','controller').counts.batches,1);

const initial=lab.reset('migration');
assert.equal(initial.counts.remaining,6);
assert.equal(initial.phase,'legacy');
unchanged('write-v2','version-denied');
step('expand','expanded');
unchanged('cutover','cutover-blocked');
assert.equal(step('write-v1','posted').counts.remaining,6);
assert.equal(step('write-v2','posted').counts.remaining,6);
for (const remaining of [4,2,0]) {
  const state=step('backfill','backfilled');
  assert.equal(state.counts.remaining,remaining);
  assert.equal(state.counts.mismatches,0);
  for (const row of state.migrationRows) {
    if (row.budgetYen!==null) assert.equal(row.budgetYen,row.budgetUnits*10000);
  }
}
const beforeSwitch=lab.state().postings;
const cutover=step('cutover','cutover');
assert.deepEqual(cutover.postings,beforeSwitch);
assert.deepEqual(step('rollback','rolled-back').postings,beforeSwitch);
unchanged('contract','phase-denied');
step('cutover','cutover');
step('retire','retired');
unchanged('write-v1','version-denied');
const finished=step('contract','contracted');
assert.equal(finished.counts.mismatches,0);
assert(finished.migrationRows.every(row=>row.budgetUnits===null && Number.isInteger(row.budgetYen)));
const after=step('write-v2','posted');
assert.deepEqual(after.postings.slice(0,beforeSwitch.length),beforeSwitch);
assert.equal(after.counts.postings,12);
assert.deepEqual(after.totals,initial.totals);
console.log('Knot operations browser engine: both race orders, role and scope, phased migration, rollback and continued writes passed.');
