import { backgroundId, basePools, baselineCommitments, dependencies, events, projects, wavePlan } from './scenarios.mjs';

const eventById = new Map(events.map(event => [event.id,event]));
const MAX_LINE = 1_000_000;
const revisionQuery = 'SELECT revision FROM meta WHERE id=1';
const projectFilter = 'instr(lower(p.id),lower(?)) OR instr(p.name_ja,?) OR instr(lower(p.name_en),lower(?))';
const projectSummary = `SELECT p.*,COUNT(q.id) poolCount,SUM(q.budget) budget,SUM(q.hours) hours
  FROM project p JOIN pool q ON q.project=p.id`;

function summarizeProject({id,name_ja,name_en,priority,status,budget,hours,poolCount}) {
  return {id,name:{ja:name_ja,en:name_en},priority,status,budget,hours,poolCount};
}

async function readAsset(name) {
  const url = new URL(name, import.meta.url);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(url, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT' || name !== 'policy.json') throw error;
      return readFile(new URL('../formal/policy.json', import.meta.url), 'utf8');
    }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(name + ' could not be loaded');
  return response.text();
}

async function loadSQLite() {
  if (typeof globalThis.initSqlJs === 'function') {
    return globalThis.initSqlJs({locateFile: name => new URL(name, import.meta.url).href});
  }
  const { default: init } = await import('./sql-wasm.js');
  return init();
}

function all(db, sql, args = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(args);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function scalar(db, sql, args = []) {
  return Object.values(all(db, sql, args)[0])[0];
}

function insertMany(db, sql, rows) {
  const statement = db.prepare(sql);
  try {
    for (const row of rows) statement.run(row);
  } finally {
    statement.free();
  }
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seed(db, schema, scale) {
  db.exec(schema);
  transaction(db, () => {
    db.run('INSERT INTO meta VALUES (1,1)');
    insertMany(db, 'INSERT INTO fiscal_period VALUES (?,?)', [['00',1],['01',0],['02',0]]);
    insertMany(db, 'INSERT INTO cost_center VALUES (?)', [['DATA'],['PLAT'],['OPS'],['RISK']]);
    insertMany(db, 'INSERT INTO skill VALUES (?)', [['ENG'],['QA']]);
    insertMany(db, 'INSERT INTO project VALUES (?,?,?,?,?)', projects);
    insertMany(db, 'INSERT INTO pool VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', basePools);
    insertMany(db, 'INSERT INTO commitment VALUES (?,?,?,?,?)', baselineCommitments);
    insertMany(db, 'INSERT INTO dependency VALUES (?,?,?)', dependencies);
    insertMany(db, 'INSERT INTO route VALUES (?,?,?)', ['PLAT','OPS','RISK'].flatMap(center =>
      ['ENG','QA'].map(skill => ['DATA',center,skill])));
    db.run("INSERT INTO route VALUES ('RISK','PLAT','QA')");
    const extraProjects = [];
    const extraPools = [];
    const extraCommitments = [];
    const extraDependencies = [];
    for (let i = 1; i <= scale; i += 1) {
      const id = backgroundId(i);
      const center = i%2===1?'DATA':i%4===0?'PLAT':'OPS';
      extraProjects.push([id,'追加案件 ' + i,'Background project ' + i,i%2===1?1:0,i%2===1?'ready':'planned']);
      for (const period of ['00','01','02']) {
        if (i>1) extraDependencies.push([id,backgroundId(i-1),period]);
        for (const skill of ['ENG','QA']) {
          const pool = [id,period,skill].join('-');
          extraPools.push([pool,id,period,center,skill,500+i%250,200+i%80,120,60,950,500,0]);
          extraCommitments.push([pool+'-1',pool,190,70,'approved'],[pool+'-2',pool,160,55,'approved']);
        }
      }
    }
    insertMany(db, 'INSERT INTO project VALUES (?,?,?,?,?)', extraProjects);
    insertMany(db, 'INSERT INTO pool VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', extraPools);
    insertMany(db, 'INSERT INTO commitment VALUES (?,?,?,?,?)', extraCommitments);
    insertMany(db, 'INSERT INTO dependency VALUES (?,?,?)', extraDependencies);
    db.exec('INSERT INTO opening SELECT id,budget,hours FROM pool');
  });
}

const operators = {
  eq:(left,right) => left === right,
  lt:(left,right) => left < right,
  gt:(left,right) => left > right,
  add:(left,right) => left + right,
  max:(left,right) => left > right ? left : right,
  and:(left,right) => left && right,
  or:(left,right) => left || right,
};

function runExpression(expression, values) {
  if (Number.isSafeInteger(expression)) return BigInt(expression);
  if (typeof expression === 'string' && Object.hasOwn(values,expression)) {
    const value = values[expression];
    if (Number.isSafeInteger(value) && value>=0) return BigInt(value);
    throw new Error('Invalid Lean policy input: '+expression);
  }
  if (!Array.isArray(expression) || expression.length !== 3 || !Object.hasOwn(operators,expression[0])) {
    throw new Error('Invalid Lean policy expression');
  }
  const [,left,right] = expression;
  return operators[expression[0]](runExpression(left,values),runExpression(right,values));
}

export function evaluatePolicy(policy, values) {
  return policy.rules.filter(rule => runExpression(rule.fail, values)).map(rule => rule.code);
}

function readPool(db, id) {
  return all(db, `SELECT p.*, f.closed,
       COALESCE((SELECT SUM(c.budget) FROM commitment c WHERE c.pool=p.id AND c.status='approved'),0) committedBudget,
       COALESCE((SELECT SUM(c.hours) FROM commitment c WHERE c.pool=p.id AND c.status='approved'),0) committedHours
    FROM pool p JOIN fiscal_period f ON f.id=p.period WHERE p.id=?`, [id])[0];
}

function result(code, issues = [], rows = []) {
  return {ok: ['ready','committed','duplicate'].includes(code), code, issues, rows};
}

function fingerprint(proposal) {
  const {eventId,revision,project,priority} = proposal;
  return JSON.stringify([eventId,revision,project,priority,proposal.lines.map(
    ({from,to,budget,hours}) => [from,to,budget,hours])]);
}

function validNumber(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_LINE;
}

function inspectPlan(db, policy, proposal) {
  if (!proposal || !eventById.has(proposal.eventId) || typeof proposal.project!=='string'
      || !all(db,'SELECT 1 FROM project WHERE id=?',[proposal.project]).length
      || !Number.isSafeInteger(proposal.priority) || proposal.priority < 0 || proposal.priority > 2
      || !Array.isArray(proposal.lines) || !proposal.lines.length || proposal.lines.length>20
      || proposal.lines.some(line => !line || typeof line.from !== 'string' || typeof line.to !== 'string'
        || line.from === line.to || !validNumber(line.budget) || !validNumber(line.hours))) {
    return result('blocked',[{code:'invalid'}]);
  }
  const grouped = new Map();
  const issues = [];
  const touchedProjects = new Set();
  function add(id, kind, line) {
    if (!grouped.has(id)) {
      const current = readPool(db,id);
      if (!current) return undefined;
      grouped.set(id,{...current,budgetIn:0,budgetOut:0,hoursIn:0,hoursOut:0});
    }
    const pool = grouped.get(id);
    pool['budget'+kind] += line.budget;
    pool['hours'+kind] += line.hours;
    return pool;
  }
  for (const line of proposal.lines) {
    const from = add(line.from,'Out',line);
    const to = add(line.to,'In',line);
    if (!from || !to || from.period !== to.period || from.skill !== to.skill
        || !all(db,'SELECT 1 FROM route WHERE origin=? AND destination=? AND skill=?',
          [from.center,to.center,from.skill]).length) {
      issues.push({code:'route',pool:line.from});
    }
    if (to) touchedProjects.add(to.project);
    if (to && all(db,`SELECT d.prerequisite FROM dependency d JOIN project p ON p.id=d.prerequisite
       WHERE d.project=? AND d.period=? AND p.status<>'ready'`,[to.project,to.period]).length) {
      issues.push({code:'dependency',pool:to.id});
    }
  }
  if (!touchedProjects.has(proposal.project)) issues.push({code:'invalid'});
  const rows = Array.from(grouped.values(), pool => {
    const {budget,hours,budgetIn,budgetOut,hoursIn,hoursOut,committedBudget,committedHours,closed,locked} = pool;
    const values = {budget,hours,budgetIn,budgetOut,hoursIn,hoursOut,committedBudget,committedHours,
      closed,locked,minBudget:pool.min_budget,minHours:pool.min_hours,maxBudget:pool.max_budget,maxHours:pool.max_hours};
    issues.push(...evaluatePolicy(policy,values).map(code => ({code,pool:pool.id})));
    return {...values,pool:pool.id,period:pool.period,center:pool.center,skill:pool.skill,project:pool.project,
      budgetAfter:budget+budgetIn-budgetOut,hoursAfter:hours+hoursIn-hoursOut};
  });
  const minimumPriority = scalar(db,'SELECT priority FROM project WHERE id=?',[proposal.project]);
  if (proposal.priority < minimumPriority) issues.push({code:'invalid'});
  if (proposal.revision !== scalar(db,revisionQuery)) return result('stale',issues,rows);
  return result(issues.length?'blocked':'ready',issues,rows);
}

function transactionAudit(db) {
  const foreignKeyViolations = all(db,'PRAGMA foreign_key_check').length;
  const ledgerUnbalanced = scalar(db,`SELECT COUNT(*) FROM (
    SELECT batch,item,COUNT(*) amount,SUM(budget) net_budget,SUM(hours) net_hours
    FROM journal GROUP BY batch,item
    HAVING amount<>2 OR net_budget<>0 OR net_hours<>0
  )`) + scalar(db,`SELECT COUNT(*) FROM batch b WHERE
    (SELECT COUNT(*) FROM journal j WHERE j.batch=b.id AND j.sign=1)<>b.items OR
    (SELECT COALESCE(SUM(budget),0) FROM journal j WHERE j.batch=b.id AND j.sign=1)<>b.budget OR
    (SELECT COALESCE(SUM(hours),0) FROM journal j WHERE j.batch=b.id AND j.sign=1)<>b.hours`);
  const projectionMismatches = scalar(db,`SELECT COUNT(*) FROM pool p LEFT JOIN opening o ON o.pool=p.id
    LEFT JOIN (SELECT pool,SUM(budget) budget,SUM(hours) hours FROM journal GROUP BY pool) j ON j.pool=p.id
    WHERE o.pool IS NULL OR p.budget<>o.budget+COALESCE(j.budget,0) OR p.hours<>o.hours+COALESCE(j.hours,0)`);
  return {ok:foreignKeyViolations===0&&ledgerUnbalanced===0&&projectionMismatches===0,
    foreignKeyViolations,ledgerUnbalanced,projectionMismatches};
}

const faultSignal = Symbol('demo fault after first posting');

export async function createLab() {
  const [SQL,schema,policyText,planText] = await Promise.all(
    [loadSQLite(),readAsset('schema.sql'),readAsset('policy.json'),readAsset('recorded-plans.json')]);
  const policy = JSON.parse(policyText);
  if (policy.version !== 1 || policy.rules.length !== 6) throw new Error('Unexpected Lean policy');
  const captured = JSON.parse(planText);
  let db;
  let scale = 0;
  let sequence = 0;
  const proposalIds = new Set();
  let driftNumber = 0;

  function state() {
    const counts = {};
    for (const [name,table] of [['projects','project'],['pools','pool'],['commitments','commitment'],
      ['ledgerLines','journal'],['periods','fiscal_period'],['centers','cost_center'],['dependencies','dependency']]) {
      counts[name] = scalar(db,'SELECT COUNT(*) FROM '+table);
    }
    counts.tables = scalar(db,`SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    const totals = all(db,'SELECT SUM(budget) budget,SUM(hours) hours FROM pool')[0];
    const portfolio = all(db,projectSummary+
      " WHERE p.id IN ('atlas','orbit','shield','pulse') GROUP BY p.id ORDER BY p.rowid").map(summarizeProject);
    const history = all(db,'SELECT id,event,items,budget,hours,revision FROM batch ORDER BY revision DESC').map(
      ({event,...entry}) => ({...entry,title:eventById.get(event).title}));
    return {revision:scalar(db,revisionQuery),scale,counts,totals,projects:portfolio,history,
      events:events.filter(event => !event.scaled || scale>=16)};
  }

  function findProjects(query='',offset=0,limit=12) {
    const term = String(query).trim().slice(0,100);
    if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>50) {
      throw new Error('Invalid portfolio page');
    }
    const args = [term,term,term];
    const total = scalar(db,'SELECT COUNT(*) FROM project p WHERE '+projectFilter,args);
    const rows = all(db,projectSummary+' WHERE '+projectFilter+' GROUP BY p.id ORDER BY p.rowid LIMIT ? OFFSET ?',
      [...args,limit,offset]).map(summarizeProject);
    return {rows,total};
  }

  function projectDetail(id) {
    const pools = all(db,'SELECT id FROM pool WHERE project=? ORDER BY period,center,skill',[id])
      .map(({id:pool}) => readPool(db,pool));
    const prerequisites = all(db,`SELECT p.id,p.name_ja,p.name_en,p.status,d.period FROM dependency d
      JOIN project p ON p.id=d.prerequisite WHERE d.project=? ORDER BY d.period,p.id`,[id]);
    return {pools,dependencies:prerequisites.map(({name_ja,name_en,...rest}) => (
      {...rest,name:{ja:name_ja,en:name_en}}))};
  }

  function journal(batchId) {
    return all(db,`SELECT j.item,j.sign,j.pool,j.budget,j.hours,p.project,p.period,p.center,p.skill
      FROM journal j JOIN pool p ON p.id=j.pool WHERE j.batch=? ORDER BY j.item,j.sign`,[batchId]);
  }

  function reset(sampleSize = 0) {
    if (!Number.isSafeInteger(sampleSize) || sampleSize<0 || sampleSize>10_000) throw new Error('Unsupported sample size');
    const fresh = new SQL.Database();
    try {
      seed(fresh,schema,sampleSize);
    } catch (error) {
      fresh.close();
      throw error;
    }
    if (db) db.close();
    db = fresh;
    scale = sampleSize;
    driftNumber = 0;
    proposalIds.clear();
    return state();
  }

  function draft(eventId, source, revision=scalar(db,revisionQuery)) {
    const id = 'K-' + String(++sequence).padStart(4,'0');
    const proposal = {id,eventId,revision,
      ai:{mode:source.mode || 'recorded',reason:{...source.reason}},
      project:source.project,priority:source.priority,lines:source.lines.map(line => ({...line}))};
    proposalIds.add(id);
    return {...proposal,preview:inspectPlan(db,policy,proposal)};
  }

  function prepare(eventId) {
    const event = eventById.get(eventId);
    if (!event || (event.scaled && scale<16)) throw new Error('Unknown scenario');
    if (event.scaled) return draft(eventId,wavePlan());
    return draft(eventId,captured[eventId]);
  }

  function revise(proposal,index,budget,hours) {
    if (!proposalIds.has(proposal.id) || proposal.eventId!=='shared-pool'
        || !Number.isSafeInteger(index) || !proposal.lines[index]) throw new Error('Invalid revision');
    const lines = proposal.lines.map((line,i) => i===index?{...line,budget,hours}:line);
    const amendment = draft(proposal.eventId,{...proposal,lines,reason:proposal.ai.reason},proposal.revision);
    return {...amendment,ai:{...amendment.ai,edited:true}};
  }

  function inspect(proposal) {
    return inspectPlan(db,policy,proposal);
  }

  function apply(proposal, options = {}) {
    if (!proposal || !proposalIds.has(proposal.id) || !Array.isArray(proposal.lines) || proposal.lines.some(line => !line)) {
      return {...result('blocked',[{code:'invalid'}]),state:state()};
    }
    let outcome;
    try {
      outcome = transaction(db, () => {
        const serialized = fingerprint(proposal);
        const prior = all(db,'SELECT proposal FROM batch WHERE id=?',[proposal.id])[0];
        if (prior) return result(prior.proposal===serialized?'duplicate':'id-conflict');
        const checked = inspect(proposal);
        if (!checked.ok) return checked;
        const revision = scalar(db,revisionQuery)+1;
        const budget = proposal.lines.reduce((sum,line) => sum+line.budget,0);
        const hours = proposal.lines.reduce((sum,line) => sum+line.hours,0);
        db.run('INSERT INTO batch VALUES (?,?,?,?,?,?,?,?)',
          [proposal.id,proposal.eventId,serialized,revision,proposal.project,budget,hours,proposal.lines.length]);
        const projected = new Map(checked.rows.map(row => [row.pool,row]));
        proposal.lines.forEach((line,index) => {
          for (const [pool,sign] of [[line.from,-1],[line.to,1]]) {
            db.run('INSERT INTO journal VALUES (?,?,?,?,?,?)',
              [proposal.id,index+1,sign,pool,sign*line.budget,sign*line.hours]);
            const balance = projected.get(pool);
            if (balance) {
              db.run('UPDATE pool SET budget=?,hours=? WHERE id=?',
                [balance.budgetAfter,balance.hoursAfter,pool]);
              projected.delete(pool);
            }
            if (options.fault && index===0 && sign===-1) throw faultSignal;
          }
        });
        db.run('UPDATE project SET priority=? WHERE id=?',[proposal.priority,proposal.project]);
        db.run('UPDATE meta SET revision=? WHERE id=1',[revision]);
        return result('committed',[],checked.rows);
      });
    } catch (error) {
      if (error!==faultSignal) throw error;
      outcome = result('rolled-back');
    }
    return {...outcome,state:state()};
  }

  function drift(proposal) {
    if (!proposal || proposal.eventId!=='stale' || proposal.revision!==scalar(db,revisionQuery)) return state();
    transaction(db, () => {
      db.run('INSERT INTO commitment VALUES (?,?,?,?,?)',
        ['external-purchase-'+(++driftNumber),'01-DATA-ENG',260,100,'approved']);
      db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
    });
    return state();
  }

  function exportDatabase() {
    const data = db.export();
    db.exec('PRAGMA foreign_keys=ON');
    return data;
  }

  function reopen() {
    const next = new SQL.Database(exportDatabase());
    try {
      next.exec('PRAGMA foreign_keys=ON');
      const integrity = scalar(next,'PRAGMA quick_check');
      if (integrity!=='ok' || !transactionAudit(next).ok) throw new Error('Reopened ledger failed its audit');
    } catch (error) {
      next.close();
      throw error;
    }
    db.close();
    db = next;
    return state();
  }

  reset();
  return {state,findProjects,projectDetail,journal,prepare,inspect,apply,drift,revise,reset,reopen,exportDatabase,
    audit:() => transactionAudit(db)};
}
