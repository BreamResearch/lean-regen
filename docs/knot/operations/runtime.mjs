import {evaluatePolicy} from '../engine.mjs';

const actors = ['a','b','controller','planner','auditor','foreign','v1','v2'];
const tracks = ['race','auth','migration'];
const seats = {a:'delivery', b:'renewal'};
const fallbacks = ['delivery','renewal'];
const schema = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, phase TEXT NOT NULL);
  CREATE TABLE pool (
    id TEXT PRIMARY KEY, center TEXT NOT NULL, budget INTEGER NOT NULL CHECK(budget>=0),
    hours INTEGER NOT NULL CHECK(hours>=0), committed_budget INTEGER NOT NULL, committed_hours INTEGER NOT NULL,
    max_budget INTEGER NOT NULL, max_hours INTEGER NOT NULL
  );
  CREATE TABLE principal (id TEXT PRIMARY KEY, role TEXT NOT NULL, tenant TEXT NOT NULL);
  CREATE TABLE scope (actor TEXT REFERENCES principal(id), center TEXT, PRIMARY KEY(actor,center));
  CREATE TABLE batch (id TEXT PRIMARY KEY, actor TEXT REFERENCES principal(id), revision INTEGER NOT NULL UNIQUE);
  CREATE TABLE journal (
    batch TEXT NOT NULL REFERENCES batch(id), pool TEXT NOT NULL REFERENCES pool(id),
    budget_units INTEGER NOT NULL, hours INTEGER NOT NULL, PRIMARY KEY (batch,pool)
  );
  INSERT INTO meta VALUES (1,1,'legacy');
  INSERT INTO pool VALUES ('analysis','DATA',1000,420,630,260,1500,600),
    ('delivery','PLAT',440,180,210,90,1300,600),
    ('renewal','OPS',350,130,155,60,1200,600),
    ('risk','RISK',700,230,410,150,1400,600);
  INSERT INTO principal VALUES ('a','controller','demo'),('b','controller','demo'),
    ('controller','controller','demo'),('planner','planner','demo'),('auditor','auditor','demo'),
    ('foreign','controller','other'),('v1','controller','demo'),('v2','controller','demo');
  INSERT INTO scope VALUES ('a','DATA'),('a','PLAT'),('b','DATA'),('b','OPS'),
    ('controller','DATA'),('controller','PLAT'),('planner','DATA'),('planner','PLAT'),
    ('auditor','DATA'),('auditor','PLAT'),('auditor','OPS'),('auditor','RISK'),('foreign','RISK'),
    ('v1','DATA'),('v1','PLAT'),('v2','DATA'),('v2','PLAT');
`;

async function dependencies() {
  const loadPolicy = async () => {
    const url = new URL('../policy.json',import.meta.url);
    if (url.protocol==='file:') {
      const {readFile} = await import('node:fs/promises');
      try { return JSON.parse(await readFile(url,'utf8')); }
      catch (error) {
        if (error.code!=='ENOENT') throw error;
        return JSON.parse(await readFile(new URL('../../formal/policy.json',import.meta.url),'utf8'));
      }
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error('Cannot load exported policy');
    return response.json();
  };
  const loadSql = async () => {
    if (typeof globalThis.initSqlJs==='function')
      return globalThis.initSqlJs({locateFile:name=>new URL('../'+name,import.meta.url).href});
    const {default:init} = await import('../sql-wasm.js');
    return init();
  };
  return Promise.all([loadSql(),loadPolicy()]);
}

function rows(db,query,args=[]) {
  const statement=db.prepare(query,args);
  try {
    const output=[];
    while (statement.step()) output.push(statement.getAsObject());
    return output;
  } finally { statement.free(); }
}

function atomic(db,mutation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result=mutation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readMeta(db) { return rows(db,'SELECT revision,phase FROM meta WHERE id=1')[0]; }
function hasYen(phase) { return phase!=='legacy'; }
function hasUnits(phase) { return phase!=='contracted'; }

function audit(db) {
  const {phase}=readMeta(db);
  const count=rows(db,'SELECT COUNT(*) count FROM journal')[0].count;
  if (phase==='legacy') return {remaining:count,mismatches:0};
  const remaining=rows(db,'SELECT COUNT(*) count FROM journal WHERE budget_yen IS NULL')[0].count;
  const mismatches=hasUnits(phase)?rows(db,
    'SELECT COUNT(*) count FROM journal WHERE budget_yen IS NOT NULL AND budget_yen <> budget_units*10000')[0].count:0;
  return {remaining,mismatches};
}

function policyRow(pool,budget,hours,isSource) {
  return {budget:pool.budget,hours:pool.hours,budgetIn:isSource?0:budget,budgetOut:isSource?budget:0,
    hoursIn:isSource?0:hours,hoursOut:isSource?hours:0,minBudget:0,minHours:0,maxBudget:pool.max_budget,
    maxHours:pool.max_hours,committedBudget:pool.committed_budget,committedHours:pool.committed_hours,closed:0,locked:0};
}

function scopedCenters(db,actor) {
  return rows(db,'SELECT center FROM scope WHERE actor=? ORDER BY center',[actor]).map(row=>row.center);
}

function post(db,policy,actor,{id,revision,from='analysis',to='delivery',budget,hours}) {
  return atomic(db,()=>{
    const owner=rows(db,'SELECT role,tenant FROM principal WHERE id=?',[actor])[0];
    if (!owner || owner.role!=='controller') return {code:'role-denied'};
    const source=rows(db,'SELECT * FROM pool WHERE id=?',[from])[0];
    const destination=rows(db,'SELECT * FROM pool WHERE id=?',[to])[0];
    const scope=new Set(scopedCenters(db,actor));
    if (!source || !destination || owner.tenant!=='demo'||!scope.has(source.center)||!scope.has(destination.center))
      return {code:'scope-denied'};
    const current=readMeta(db);
    if ((actor==='v1' && ['retired','contracted'].includes(current.phase)) ||
        (actor==='v2' && current.phase==='legacy')) return {code:'version-denied'};
    if (current.revision!==revision) return {code:'stale'};
    const reasons=[...evaluatePolicy(policy,policyRow(source,budget,hours,true)),
      ...evaluatePolicy(policy,policyRow(destination,budget,hours,false))];
    if (reasons.length) return {code:'capacity-denied',reasons:[...new Set(reasons)]};
    const next=current.revision+1;
    db.run('INSERT INTO batch VALUES (?,?,?)',[id,actor,next]);
    for (const [pool,sign] of [[source,-1],[destination,1]]) {
      const signedBudget=sign*budget;
      const signedHours=sign*hours;
      db.run('UPDATE pool SET budget=budget+?,hours=hours+? WHERE id=?',[signedBudget,signedHours,pool.id]);
      if (hasYen(current.phase) && !hasUnits(current.phase))
        db.run('INSERT INTO journal(batch,pool,budget_yen,hours) VALUES (?,?,?,?)',[id,pool.id,signedBudget*10000,signedHours]);
      else if (hasYen(current.phase) && actor==='v2')
        db.run('INSERT INTO journal(batch,pool,budget_units,budget_yen,hours) VALUES (?,?,?,?,?)',
          [id,pool.id,signedBudget,signedBudget*10000,signedHours]);
      else db.run('INSERT INTO journal(batch,pool,budget_units,hours) VALUES (?,?,?,?)',[id,pool.id,signedBudget,signedHours]);
    }
    db.run('UPDATE meta SET revision=? WHERE id=1',[next]);
    return {code:'posted'};
  });
}

function migrate(db,action) {
  return atomic(db,()=>{
    const {phase}=readMeta(db);
    let next=phase;
    let code='phase-denied';
    if (action==='expand' && phase==='legacy') {
      db.exec(`ALTER TABLE journal ADD COLUMN budget_yen INTEGER;
        CREATE TRIGGER journal_units_agree BEFORE INSERT ON journal
          WHEN NEW.budget_yen IS NOT NULL AND NEW.budget_yen<>NEW.budget_units*10000 BEGIN
          SELECT RAISE(ABORT,'budget units disagree');
        END;
        CREATE TRIGGER journal_units_bridge AFTER INSERT ON journal
          WHEN NEW.budget_yen IS NULL BEGIN
          UPDATE journal SET budget_yen=NEW.budget_units*10000 WHERE batch=NEW.batch AND pool=NEW.pool;
        END`);
      next='expanded'; code='expanded';
    } else if (action==='backfill' && phase==='expanded') {
      db.exec(`UPDATE journal SET budget_yen=budget_units*10000 WHERE rowid IN (
        SELECT rowid FROM journal WHERE budget_yen IS NULL ORDER BY rowid LIMIT 2)`);
      code='backfilled';
    } else if (action==='cutover' && phase==='expanded') {
      const {remaining,mismatches}=audit(db);
      if (remaining || mismatches) return {code:'cutover-blocked'};
      next='cutover'; code='cutover';
    } else if (action==='rollback' && phase==='cutover') {
      next='expanded'; code='rolled-back';
    } else if (action==='retire' && phase==='cutover') {
      next='retired'; code='retired';
    } else if (action==='contract' && phase==='retired') {
      const {remaining,mismatches}=audit(db);
      if (remaining || mismatches) return {code:'cutover-blocked'};
      db.exec(`DROP TRIGGER journal_units_bridge; DROP TRIGGER journal_units_agree;
        ALTER TABLE journal DROP COLUMN budget_units;
        CREATE TRIGGER journal_yen_required BEFORE INSERT ON journal
          WHEN NEW.budget_yen IS NULL BEGIN SELECT RAISE(ABORT,'budget yen is required'); END`);
      next='contracted'; code='contracted';
    }
    db.run('UPDATE meta SET phase=? WHERE id=1',[next]);
    return {code};
  });
}

export async function createOperations() {
  const [SQL,policy]=await dependencies();
  let db, track, sequence, decisions, captured, loser;
  function record(code,actor,operation,details={}) {
    decisions.push({...details,code,actor,operation,revision:readMeta(db).revision});
  }
  function state() {
    const meta=readMeta(db);
    const totals=rows(db,'SELECT SUM(budget) budget,SUM(hours) hours FROM pool')[0];
    const counts={...audit(db),batches:rows(db,'SELECT COUNT(*) count FROM batch')[0].count,
      postings:rows(db,'SELECT COUNT(*) count FROM journal')[0].count};
    const activeBudget=['cutover','retired','contracted'].includes(meta.phase)?'budget_yen':'budget_units*10000';
    const postings=rows(db,`SELECT j.batch,j.pool,${activeBudget} budgetYen,j.hours FROM journal j
      JOIN batch b ON b.id=j.batch ORDER BY b.revision,j.pool`);
    const units=hasUnits(meta.phase)?'budget_units':'NULL';
    const yen=hasYen(meta.phase)?'budget_yen':'NULL';
    const migrationRows=rows(db,`SELECT batch||' / '||pool id,${units} budgetUnits,${yen} budgetYen
      FROM journal ORDER BY rowid DESC LIMIT 8`);
    return {...meta,track,totals,counts,pools:rows(db,'SELECT id,center,budget,hours FROM pool ORDER BY id'),
      postings,migrationRows,results:decisions.map(entry=>({...entry})),seats:Object.entries(captured).map(([actor,proposalRevision])=>({actor,proposalRevision})),
      last:decisions.at(-1) || null};
  }
  function transact(actor,revision=readMeta(db).revision) {
    const small=actor!=='a' && actor!=='b';
    const outcome=post(db,policy,actor,{id:'OP-'+String(++sequence).padStart(3,'0'),revision,
      to:seats[actor] || fallbacks[0],budget:small?20:220,hours:small?10:90});
    record(outcome.code,actor,'submit',outcome);
  }
  function reset(next='race') {
    if (!tracks.includes(next)) throw new Error('Unexpected lab scenario');
    db?.close();
    db=new SQL.Database();
    db.exec(schema);
    track=next; sequence=0; decisions=[]; captured={}; loser=null;
    if (track==='migration') {
      transact('v1'); transact('v1'); transact('v1');
      decisions=[];
    }
    return state();
  }
  function action(name,actorOrOrder) {
    if (track==='race' && name==='capture') {
      captured={a:readMeta(db).revision,b:readMeta(db).revision}; loser=null;
      record('captured','a','capture'); record('captured','b','capture');
    } else if (track==='race' && name==='race' && ['a','b'].includes(actorOrOrder) && !loser && captured.a!==undefined) {
      const first=actorOrOrder;
      loser=first==='a'?'b':'a';
      transact(first,captured[first]); transact(loser,captured[loser]);
    } else if (track==='race' && name==='retry' && loser) {
      transact(loser);
    } else if (track==='auth' && name==='read' && actors.includes(actorOrOrder)) {
      const visibleCenters=scopedCenters(db,actorOrOrder);
      record('read-ok',actorOrOrder,'read',{visibleCenters});
    } else if (track==='auth' && name==='submit' && ['controller','planner','auditor','foreign'].includes(actorOrOrder)) {
      transact(actorOrOrder);
    } else if (track==='migration' && ['write-v1','write-v2'].includes(name)) {
      transact(name.slice(-2));
    } else if (track==='migration' && ['expand','backfill','cutover','rollback','retire','contract'].includes(name)) {
      const outcome=migrate(db,name);
      record(outcome.code,'migration',name);
    } else record('phase-denied','system',name);
    return state();
  }
  reset();
  return {state,reset,action};
}
