import {label} from './strings.mjs';

const tabs = ['race', 'auth', 'migration'];
const phaseNames = {legacy:'legacy', expanded:'expandedPhase', cutover:'cutoverPhase', retired:'retiredPhase', contracted:'contractedPhase'};
const accepted = new Set(['posted', 'read-ok']);
const refusals = new Set(['stale', 'capacity-denied', 'role-denied', 'scope-denied', 'cutover-blocked', 'phase-denied', 'version-denied']);
const guideBase = 'https://github.com/BreamResearch/lean-regen/blob/main/docs/knot/operations/';
const url = new URL(location.href);
let lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ja';
let track = tabs.includes(url.hash.slice(1)) ? url.hash.slice(1) : 'race';
let order = 'a', identity = 'controller';
const opened = new Map();
let lab, state, runtime;
const id = key => document.getElementById(key);
const t = key => label(lang,key);
const fmt = value => typeof value === 'number' ? value.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US') : '—';

function element(tag,text,cls) {
  const node = document.createElement(tag);
  if(text !== undefined && text !== null) node.textContent = text;
  if(cls) node.className = cls;
  return node;
}
function showError(message) {
  id('error').textContent = message;
  id('error').hidden = !message;
}
function actionButton(key,operation,actor,primary=false) {
  const button = element('button',t(key),'action'+(primary?' primary':''));
  button.type = 'button';
  button.dataset.operation = operation;
  button.addEventListener('click',() => run(operation,typeof actor === 'function' ? actor() : actor));
  return button;
}
function group(title,help,...controls) {
  const section = element('div',null,'control-block');
  section.append(element('h4',t(title)),element('p',t(help),'helper'));
  const row = element('div',null,'buttons');
  row.append(...controls); section.append(row);
  return section;
}
function choice(title,names,value,setter) {
  const field = element('label',t(title),'field');
  const select = element('select');select.id = title+'-choice';
  for(const key of names) {
    const opt = element('option',t(key));opt.value=key;select.append(opt);
  }
  select.value=value;select.addEventListener('change',()=>setter(select.value));
  field.append(select);return field;
}
function controls() {
  const box=id('controls');
  if(!lab) { box.replaceChildren(element('p',t('loading'),'helper')); return; }
  if(track === 'race') {
    const read = group('readSnap','captureHint',actionButton('capture','capture',undefined,true));
    const sequence = element('div',null,'control-block');
    sequence.append(choice('order',['a','b'],order,v=>{order=v}),element('p',t('orderHint'),'helper'),actionButton('raceRun','race',()=>order,true));
    const retry = element('div',null,'control-block');
    retry.append(element('p',t('retryHint'),'helper'), actionButton('retry','retry'));
    box.replaceChildren(read,sequence,retry);
  } else if(track === 'auth') {
    const role = choice('actor',['controller','planner','auditor','foreign'],identity,v=>{identity=v});
    const actions = element('div',null,'buttons');
    actions.append(actionButton('read','read',()=>identity),actionButton('submit','submit',()=>identity,true));
    box.replaceChildren(role,element('p',t('identityHint'),'helper'),actions);
  } else {
    box.replaceChildren(group('migrateDesc','phaseHelp',...['expand','backfill','cutover','rollback','retire','contract'].map(key=>actionButton(key,key,undefined,key==='expand'))),
      group('writers','writeHelp',actionButton('write-v1','write-v1'),actionButton('write-v2','write-v2')));
  }
}
function table(headers,rows) {
  const wrap = element('div',null,'table-wrap'), tab=element('table'), thead=element('thead'), tr=element('tr'), tbody=element('tbody');
  for(const header of headers) {const th=element('th',t(header));th.scope='col';tr.append(th);}
  thead.append(tr);
  for(const cells of rows) {const row=element('tr');for(const cell of cells) row.append(element('td',cell));tbody.append(row);}
  tab.append(thead,tbody);wrap.append(tab);return wrap;
}
function metrics(items) {
  const dl=element('dl',null,'kpis');
  for(const [key,value] of items) {const cell=element('div');cell.append(element('dt',t(key)),element('dd',value));dl.append(cell);}
  return dl;
}
function actorName(value) {
  if(value == null || value === '') return t('system');
  const raw=String(value), known=['a','b','controller','planner','auditor','foreign','system'];
  if(raw==='migration') return t('migrationActor');
  return known.includes(raw.toLowerCase()) ? t(raw.toLowerCase()) : raw;
}
function ledger() {
  const box=id('state');
  if(!state) {box.replaceChildren();return;}
  const counts=state.counts;
  const read=track==='auth' && state.last?.operation==='read' ? state.last : null;
  const visible=read ? state.pools.filter(pool=>read.visibleCenters.includes(pool.center)) : state.pools;
  const poolIds=new Set(visible.map(pool=>pool.id));
  const postings=(state.postings || []).filter(row=>!read || poolIds.has(row.pool));
  const batches=read ? new Set(postings.map(row=>row.batch)).size : counts.batches;
  const cells=[['revision',fmt(state.revision)],['batches',fmt(batches)],['postings',fmt(read ? postings.length : counts.postings)]];
  if(track==='migration') cells.push(['phase',t(phaseNames[state.phase]||state.phase)],['remaining',fmt(counts.remaining)],['mismatches',fmt(counts.mismatches)]);
  box.replaceChildren(metrics(cells));
  id('state-title').textContent=t(read?'actorView':track==='auth'?'observerView':'state');
  const balances=visible.map(pool=>[pool.id,pool.center,fmt(pool.budget),fmt(pool.hours)]);
  const sum=key=>visible.reduce((total,pool)=>total+pool[key],0);
  balances.push([t('totals'),'—',fmt(sum('budget')),fmt(sum('hours'))]);
  box.append(element('h4',read ? t('actorPools')+' · '+actorName(read.actor) : t('poolTitle')),table(['pool','center','budget','hours'],balances));
  if(track==='race'){
    const seats=state.seats.map(seat=>[actorName(seat.actor),seat.proposalRevision==null ? t('noCapture') : fmt(seat.proposalRevision)]);
    if(seats.length) box.append(element('h4',t('seatTitle'),'subsection'),table(['by','capturedRev'],seats));
  }
  if(track==='migration' && state.migrationRows?.length){
    const samples=state.migrationRows.map(row=>[row.id,fmt(row.budgetUnits),fmt(row.budgetYen)]);
    box.append(element('h4',t('storedRows'),'subsection'),table(['txn','oldColumn','newColumn'],samples));
  }
  if(postings.length) {
    const details=element('details');
    details.append(element('summary',t('moreRows')+' · '+fmt(postings.length)));
    const rows=[...postings].reverse().map(p=>[p.batch,p.pool,fmt(p.budgetYen),fmt(p.hours)]);
    details.append(table(['txn','pool','yen','hours'],rows));
    box.append(details);
  }
}
function resultText(record) {
  const code=record.code==='cutover'?'cutoverDone':record.code==='phase-denied'&&track!=='migration'?'orderDenied':record.code;
  let message=t(code);
  if(record.reasons?.length) message+=' ('+record.reasons.join(', ')+')';
  if(Array.isArray(record.visibleCenters)) message+=' '+t('visible')+' · '+(record.visibleCenters.join(', ')||'—');
  return message;
}
function trace() {
  const box=id('trace'), history=state?.results||[];
  id('trace-count').textContent=fmt(history.length);
  const decision=id('outcome'), latest=state?.last;
  decision.hidden=!latest;
  if(latest) {
    decision.className='outcome';
    const recent=track==='race' && latest.code==='stale' ? history.slice(-2) : [latest];
    decision.replaceChildren(...recent.map(record=>{
      const part=element('div',null,refusals.has(record.code)?'refused':'');
      part.append(element('strong',resultText(record)),element('small',actorName(record.actor)+' · v'+fmt(record.revision)+' · '+record.code));
      return part;
    }));
  }
  if(track==='race' && state) {
    const sinceCapture=history.slice(history.map(entry=>entry.code).lastIndexOf('captured')+1);
    const tried=sinceCapture.some(entry=>entry.operation==='submit');
    document.querySelector('[data-operation="race"]').disabled=state.seats.length!==2 || tried;
    document.querySelector('[data-operation="retry"]').disabled=!tried;
  }
  if(!history.length) {box.replaceChildren(element('p',t('empty'),'empty'));return;}
  const list=element('ol',null,'log');
  for(const record of [...history].reverse()) {
    const refused=refusals.has(record.code), pass=accepted.has(record.code);
    const row=element('li');
    const badge=element('span',t(refused?'denied':pass?'yes':'step'),'result'+(refused?' stop':pass?'':' neutral'));
    const title=element('div');
    const operation=record.operation==='submit' && ['v1','v2'].includes(record.actor) ? 'write-'+record.actor : record.operation==='race'?'raceOp':record.operation==='retry'?'retryOp':record.operation;
    title.append(element('strong',t(operation)),element('div',actorName(record.actor)+' · v'+fmt(record.revision),'small'));
    const note=element('div',null,'note');
    note.append(element('span',resultText(record)),element('code',record.code));
    row.append(badge,title,note);list.append(row);
  }
  box.replaceChildren(list);
}
function run(name,actor) {
  if(!lab) return;
  try {
    state = actor===undefined ? lab.action(name) : lab.action(name,actor);
    showError('');ledger();trace();
    const latest=state.last;
    if(latest) id('announcer').textContent=resultText(latest)+' · v'+fmt(latest.revision);
  } catch(e) {showError(t('error')+' '+e.message);}
}
function render() {
  document.documentElement.lang=lang;
  document.title='Knot · '+t('title');
  document.querySelectorAll('[data-t]').forEach(node=>{node.textContent=t(node.dataset.t)});
  document.querySelectorAll('[data-lang]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.lang===lang)));
  for(const key of tabs) {
    const tab=id('tab-'+key), active=key===track;
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
  }
  id('case-panel').setAttribute('aria-labelledby','tab-'+track);
  id('case-title').textContent=t(track+'Title');id('case-detail').textContent=t(track+'Intro');
  id('brand').href=id('back').href='../'+(lang==='en'?'?lang=en':'');
  id('guide').href=guideBase+'README.md';
  id('erp-benchmark').href='../erp-benchmark/'+(lang==='en'?'?lang=en':'');
  id('reset').disabled=!lab;
  controls();ledger();trace();
}
async function openTrack(next) {
  track=next;lab=undefined;state=undefined;showError('');render();
  if(!opened.has(next)) {
    const promise=(async()=>{
      runtime ??= import('./runtime.mjs');
      const {createOperations}=await runtime;
      const instance=await createOperations();instance.reset(next);return instance;
    })();
    opened.set(next,promise);
  }
  try{
    const instance=await opened.get(next);
    if(track!==next) return;
    lab=instance;state=lab.state();render();
  } catch(e) {opened.delete(next);if(track===next) showError(t('storage')+' '+e.message);}
}
function selectTrack(next) {
  if(next===track) return;
  const current=new URL(location.href);current.hash=next;history.replaceState(null,'',current);
  openTrack(next);
}
for(const key of tabs) {
  const tab=id('tab-'+key);
  tab.addEventListener('click',()=>selectTrack(key));
  tab.addEventListener('keydown',event=>{
    const i=tabs.indexOf(key);
    const adjacent={ArrowLeft:tabs[(i+2)%3],ArrowRight:tabs[(i+1)%3],Home:tabs[0],End:tabs[2]}[event.key];
    if(adjacent){event.preventDefault();selectTrack(adjacent);id('tab-'+adjacent).focus();}
  });
}
for(const button of document.querySelectorAll('[data-lang]')) button.addEventListener('click',()=>{
  lang=button.dataset.lang;
  const current=new URL(location.href);current.searchParams.set('lang',lang);history.replaceState(null,'',current);render();
});
id('reset').addEventListener('click',()=>{
  if(!lab) return;
  try{lab.reset(track);state=lab.state();showError('');id('announcer').textContent='';render();}
  catch(e){showError(t('error')+' '+e.message);}
});
openTrack(track);
