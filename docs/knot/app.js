import {term} from './strings.js';

const $ = id => document.getElementById(id);
const palette = ['var(--p0)','var(--p1)','var(--p2)','var(--p3)'];
const resultKeys = {ready:'readyTxn',committed:'committedTxn',duplicate:'duplicateTxn',stale:'staleTxn',blocked:'blockedTxn','rolled-back':'rolledBackTxn','id-conflict':'conflictTxn'};
const ruleKeys = {closed:'capClosed',locked:'capLocked','budget-floor':'budgetFloor','hours-floor':'hoursFloor','budget-ceiling':'budgetCeiling','hours-ceiling':'hoursCeiling',route:'route',dependency:'dependency',invalid:'invalid'};
const param = new URL(location.href).searchParams.get('lang');
let lang = (param === 'en' || param === 'ja') ? param : 'ja';
let lab, state, currentEvent = 'deadline', plan = null, outcome = null, revisionChanged = false, edited = false;
let page = 0, requestedScale = null, openProject = null, noticeTimer;
const pageSize = 6;
const t = key => term(lang,key);
const local = value => typeof value === 'object' && value !== null ? (value[lang] ?? value.en ?? value.ja ?? '') : (value ?? '');
const num = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(lang === 'en' ? 'en-US' : 'ja-JP') : '—';
function el(tag,text,cls) {
  const result = document.createElement(tag);
  if (text !== undefined && text !== null) result.textContent = String(text);
  if (cls) result.className = cls;
  return result;
}
function btn(label,action,cls='secondary-button',id) {
  const button=el('button',label,cls); button.type='button';
  if(id) button.id=id;
  button.addEventListener('click',action);
  return button;
}
function project(id) { return state.projects.find(row=>row.id===id); }
function projectName(id) { return local(project(id)?.name) || String(id); }
function rank(value) { return t(['normal','high','urgent'][value] ?? String(value)); }
function event() { return state.events.find(item=>item.id===currentEvent); }
function error(message) {
  $('error').hidden=!message;
  $('error').textContent=message || '';
}
function notify(message) {
  clearTimeout(noticeTimer);
  $('notification').textContent=message;
  $('notification').hidden=false;
  noticeTimer=setTimeout(()=>{$('notification').hidden=true},4500);
}
function sectionAnchor(section) {
  const link=el('a',t('checkRows'),'link-button'); link.href='#'+section; return link;
}
function describe(list) {
  const dl=el('dl');
  list.forEach(([term,value])=>dl.append(el('dt',term),el('dd',value)));
  return dl;
}
function localizedUI() {
  document.documentElement.lang=lang;
  document.title='Knot · '+t('title');
  document.querySelectorAll('[data-i18n]').forEach(item=>{item.textContent=t(item.dataset.i18n)});
  document.querySelectorAll('[data-lang]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.lang===lang)));
  document.querySelectorAll('[data-close].close').forEach(button=>button.setAttribute('aria-label',t('close')));
  $('filter').placeholder=t('findHint');
  $('back').href=lang==='en'?'../#en':'../#ja';
  $('operations-link').href='./operations/?lang='+lang;
  $('operations-link').textContent=lang==='en'?'Operations lab':'運用デモ';
  const guide=el('a',t('guide'));
  guide.href='https://github.com/BreamResearch/lean-regen/blob/main/docs/knot/README.md';
  const design=el('a',t('design'));
  design.href='https://github.com/BreamResearch/lean-regen/blob/main/'+(lang==='en'?'DESIGN.md':'DESIGN.ja.md');
  $('source-links').replaceChildren(guide,design);
  if(state) render();
  if(openProject) showDetailContent(openProject);
}
function switchLanguage(next) {
  if(next===lang) return;
  lang=next; const url=new URL(location.href); url.searchParams.set('lang',next);
  window.history.replaceState(null,'',url);
  $('notification').hidden=true; error('');localizedUI();
}
function renderMetrics() {
  const counts=state.counts;
  $('budget').textContent=num(state.totals.budget);
  $('hours').textContent=num(state.totals.hours);
  $('budget-caption').textContent=t('centers')+' · '+num(counts.centers);
  $('hours-caption').textContent=t('pools')+' · '+num(counts.pools);
  $('priority-count').textContent=num(counts.commitments);
  $('projects-count').textContent='';
  $('priority-summary').textContent=t('ledgerLines')+' · '+num(counts.ledgerLines);
  $('revision').textContent=t('revision')+num(state.revision); $('revision').hidden=false;
  $('scale').value=String(state.scale);
  $('relations').replaceChildren(...['projects','pools','periods','dependencies','tables'].map(key=>{
    const item=el('span'); item.append(el('strong',num(counts[key])),document.createTextNode(' '+t(key))); return item;
  }));
}
function showDetailContent(p) {
  $('detail-title').textContent=local(p.name);
  const info=describe([['ID',p.id],[t('priority'),rank(p.priority)],[t('projectStatus'),t(p.status)],
    [t('poolCount'),num(p.poolCount)],[t('budgetCol'),num(p.budget)],[t('hoursCol'),num(p.hours)]]);
  $('project-detail').replaceChildren(info);
  const detail=lab.projectDetail(p.id);
  if(detail.pools.length){
    $('project-detail').append(el('h3',t('pools'),'detail-section'));
    detail.pools.forEach(row=>{
      const section=el('div',null,'inspect-pool');
      section.append(el('strong',row.id,'pool-code'),
        el('span',row.period+' · '+row.center+' · '+row.skill,'allocation-delta'),
        el('span',t('amount')+' '+num(row.budget)+' '+t('unitLabel')+' / '+num(row.hours)+' h','allocation-delta'),
        el('span',t('committed')+' '+num(row.committedBudget)+' '+t('unitLabel')+' / '+num(row.committedHours)+' h','allocation-delta'));
      if(row.locked || row.closed) section.append(el('small',t(row.closed?'capClosed':'capLocked'),'problem-text'));
      $('project-detail').append(section);
    });
  }
  if(detail.dependencies.length){
    $('project-detail').append(el('h3',t('dependencies'),'detail-section'));
    detail.dependencies.forEach(row=>{
      $('project-detail').append(el('p',local(row.name)+' · '+row.period+' · '+t(row.status),'dependency-line'));
    });
  }
}
function inspectProject(p) {
  openProject=p; showDetailContent(p); $('project-dialog').showModal();
}
function renderProjects() {
  const query=$('filter').value.trim().toLocaleLowerCase();
  let result=lab.findProjects(query,page*pageSize,pageSize);
  const pages=Math.max(1,Math.ceil(result.total/pageSize));
  if(page>=pages){page=pages-1;result=lab.findProjects(query,page*pageSize,pageSize)}
  $('portfolio-count').textContent=num(result.total)+' '+(lang==='en' && result.total===1 ? 'project' : t('projects'));
  const rows=result.rows.map((p,index)=>{
    const row=el('tr'); const name=el('td'); const open=btn('',()=>inspectProject(p),'project-button');
    const swatch=el('i',null,'project-swatch'); swatch.style.setProperty('--project-color',palette[(page*pageSize+index)%palette.length]);
    const label=el('span',null,'project-copy'); label.append(el('strong',local(p.name)),el('small',p.id));
    open.append(swatch,label); name.append(open);
    const level=el('td'); level.append(el('span',rank(p.priority),'priority level-'+p.priority));
    row.append(name,level,el('td',t(p.status)),el('td',num(p.budget),'num'),el('td',num(p.hours),'num'));return row;
  });
  if(!rows.length){const row=el('tr'),td=el('td',t('noProjects'));td.colSpan=5;row.append(td);rows.push(row)}
  $('projects').replaceChildren(...rows);
  $('pages').replaceChildren();
  if(pages>1){
    const prev=btn(t('previousPage'),()=>{page--;renderProjects()},'');
    const next=btn(t('nextPage'),()=>{page++;renderProjects()},''); prev.disabled=page===0; next.disabled=page+1>=pages;
    $('pages').append(prev,el('span',num(page+1)+' / '+num(pages)),next);
  }
  $('pages').hidden=pages===1;
}
function renderHistory() {
  const list=[...state.history].sort((a,b)=>b.revision-a.revision);
  $('history-count').textContent=num(list.length);
  if(!list.length) {
    const empty=el('div',null,'empty');const glyph=el('i','≡');glyph.setAttribute('aria-hidden','true');
    empty.append(glyph,el('span',t('noHistory')));$('history').replaceChildren(empty);return;
  }
  $('history').replaceChildren(...list.map(entry=>{
    const row=el('div',null,'history-row'), name=el('div');
    const inspect=btn(local(entry.title) || entry.id,()=>{
      openProject=null;$('detail-title').textContent=t('viewRecord');
      $('project-detail').replaceChildren(describe([[t('id'),entry.id],[t('postedRevision'),num(entry.revision)],
        [t('entries'),num(Array.isArray(entry.items)?entry.items.length:entry.items)],
        [t('budgetCol'),num(entry.budget)],[t('hoursCol'),num(entry.hours)]]));
      const postings=lab.journal(entry.id);
      const table=el('table'), head=el('thead'), labels=el('tr'), body=el('tbody');
      for(const key of ['line','pool','budgetCol','hoursCol']){
        const th=el('th',t(key)); th.scope='col'; labels.append(th);
      }
      head.append(labels);
      for(const posting of postings){
        const tr=el('tr'), pool=el('td'), prefix=posting.sign===1?'+':'';
        pool.append(el('span',posting.pool,'pool-code'),el('small',posting.period+' · '+posting.center+' · '+posting.skill,'allocation-delta'));
        tr.append(el('td',num(posting.item)),pool,el('td',prefix+num(posting.budget),'num'),el('td',prefix+num(posting.hours),'num'));
        body.append(tr);
      }
      table.append(head,body);
      const scroll=el('div',null,'journal-scroll table-scroll');scroll.append(table);
      $('project-detail').append(el('h3',t('ledgerLines')+' · '+num(postings.length),'detail-section'),scroll);
      $('project-dialog').showModal();
    },'history-label');
    name.append(inspect,el('small',t('revision')+num(entry.revision)+' · '+num(Array.isArray(entry.items)?entry.items.length:entry.items)+' '+t('entries')));
    row.append(name,el('div',num(entry.budget)+' '+t('unitLabel')+' / '+num(entry.hours)+' h','history-amount'));return row;
  }));
}
function clearPlan() {plan=null;outcome=null;revisionChanged=false;edited=false}
function updateEventOptions() {
  $('event-select').replaceChildren(...state.events.map(e=>{const opt=el('option',local(e.title));opt.value=e.id;return opt}));
  $('event-select').value=currentEvent;
  $('event-context').textContent=local(event()?.detail);
  $('event-meta').textContent=t('fresh')+' · '+t('noLive');
  $('generate').disabled=!event();
}
function runAction(action) {
  error('');
  try{action();}catch(e){error(t('operationError')+' '+e.message)}
}
function prepare() {
  runAction(()=>{plan=lab.prepare(currentEvent);outcome=null;revisionChanged=false;edited=false;render()});
}
function apply(fault=false) {
  runAction(()=>{outcome=lab.apply(plan,fault?{fault:true}:{});refresh();});
}
function drift() {
  runAction(()=>{lab.drift(plan);revisionChanged=true;outcome=null;refresh();notify(t('driftDone'))});
}
function editPlan() {
  const entries=[...$('edit-values').querySelectorAll('.edit-line')].map(field=>{
    const budget=Number(field.querySelector('[data-unit="budget"]').value);
    const hours=Number(field.querySelector('[data-unit="hours"]').value);
    return {index:Number(field.dataset.index),budget,hours};
  });
  if(!entries.every(l=>Number.isSafeInteger(l.budget)&&l.budget>0&&Number.isSafeInteger(l.hours)&&l.hours>0)) {
    error(t('invalidEdit'));return;
  }
  runAction(()=>{
    let next=plan,changed=false;
    entries.forEach(({index,budget,hours})=>{
      const last=next.lines[index];
      if(last.budget!==budget || last.hours!==hours){next=lab.revise(next,index,budget,hours);changed=true}
    });
    if(changed){plan=next;edited=true;outcome=null;render();notify(t('newPreview'))}
  });
}
function renderEditor() {
  const editor=el('details',null,'plan-editor');editor.id='edit-values';
  editor.append(el('summary',t('edit')),el('p',t('adjustmentHelp'),'note'));
  plan.lines.forEach((line,index)=>{
    const field=el('fieldset',null,'edit-line');field.dataset.index=String(index);
    field.append(el('legend',t('line')+' '+(index+1)+' · '+line.from+' → '+line.to));
    ['budget','hours'].forEach(key=>{
      const label=el('label',t(key==='budget'?'budgetCol':'hoursCol'));
      const input=el('input');input.type='number';input.min='1';input.step='1';input.value=String(line[key]);input.dataset.unit=key;
      label.append(input);field.append(label);
    });
    editor.append(field);
  });
  editor.append(btn(t('saveEdits'),editPlan,'secondary-button','save-edits'));return editor;
}
function displayIssues(result) {
  const wrapper=el('div',null,'problems');
  (result.issues || []).forEach(({code,pool})=>{
    const p=el('p',t(ruleKeys[code] || code)); if(pool)p.append(document.createTextNode(' · '),el('span',pool,'pool-code'));wrapper.append(p);
  });
  return wrapper;
}
function renderJoined(result) {
  const panel=$('affected');const rows=result?.rows || []; panel.hidden=!plan;
  if(!plan) return;
  if(!rows.length){$('affected-rows').replaceChildren(el('p',t('emptyRows'),'note'));return}
  const scroll=el('div',null,'table-scroll');const table=el('table');const head=el('thead'),tr=el('tr');
  ['pool','initial','incoming','outgoing','committed','after'].forEach(key=>{const th=el('th',t(key));th.scope='col';tr.append(th)});
  head.append(tr);const body=el('tbody');
  rows.forEach(r=>{
    const row=el('tr');const id=el('td');
    if(result.issues?.some(issue=>issue.pool===r.pool)) row.classList.add('affected-failure');
    id.append(el('span',r.pool,'pool-code'));
    if(r.project) id.append(el('span',projectName(r.project),'allocation-delta'));
    row.append(id);
    [[r.budget,r.hours],[r.budgetIn,r.hoursIn],[r.budgetOut,r.hoursOut],[r.committedBudget,r.committedHours],[r.budgetAfter,r.hoursAfter]].forEach(([budget,hours])=>{
      const td=el('td');td.append(el('strong',num(budget)),el('span',num(hours)+' h','allocation-delta'));row.append(td);
    });
    body.append(row);
  });
  table.append(head,body);scroll.append(table);
  $('affected-rows').replaceChildren(scroll,el('p',t('compareRows'),'note'));
}
function renderProposal() {
  const panel=$('proposal');panel.replaceChildren();panel.hidden=!plan;
  if(!plan){renderJoined(null);return}
  const proposalCheck=plan.preview || lab.inspect(plan);
  const result=outcome || (revisionChanged ? lab.inspect(plan) : proposalCheck);
  const success=['committed','duplicate'].includes(outcome?.code);
  const head=el('div',null,'proposal-head');
  head.append(el('h3',t('proposed')),el('span',t(success?'applied':result.ok?'accepted':'refused'),'verdict '+(result.ok?'ok':'blocked')));
  panel.append(head);
  const mode=plan.ai?.mode;
  const source=el('p',t(mode==='recorded'?'ai':'template')+(edited?' · '+t('edited'):'')+' · '+t('proposalVersion')+' '+num(plan.revision),'provenance');
  panel.append(source);
  const lines=el('ul',null,'lines-list');
  plan.lines.forEach(line=>{
    const li=el('li');li.append(el('span',line.from+' → '+line.to,'line-route'),el('strong',num(line.budget)+' '+t('unitLabel')+' / '+num(line.hours)+' h'));lines.append(li);
  });panel.append(lines);
  if(plan.project)panel.append(el('p',projectName(plan.project)+' · '+t('priorityLabel')+' '+rank(plan.priority),'small'));
  if(plan.ai?.reason){const details=el('details',null,'validation-details');details.append(el('summary',t('rationale')),el('p',local(plan.ai.reason)));panel.append(details)}
  if(currentEvent==='shared-pool' && !success)panel.append(renderEditor());
  if(result.issues?.length)panel.append(displayIssues(result));
  if(outcome)panel.append(el('p',t(resultKeys[outcome.code] || outcome.code),'results-note'+(outcome.ok?'':' failed')));
  if(revisionChanged&&!outcome)panel.append(el('p',t('driftDone'),'results-note'));
  const actions=el('div',null,'operation-controls');
  const action=event()?.action;
  if(action==='drift' && !revisionChanged && !success){
    actions.append(btn(t('drift'),drift,'primary-button','drift'));
  }else if(action==='fault' && !outcome){
    actions.append(btn(t('fault'),()=>apply(true),'primary-button','inject-fault'));
  }else if(!outcome || success || outcome.code==='rolled-back'){
    const label=success?'replay':outcome?.code==='rolled-back'?'retry':revisionChanged?'staleApply':result.ok?'apply':'testRefusal';
    actions.append(btn(t(label),()=>apply(false),success?'secondary-button':'primary-button','apply'));
  }
  if(outcome && !outcome.ok && outcome.code!=='rolled-back')actions.append(btn(t('evaluate'),prepare,'secondary-button','reload-plan'));
  if(actions.childNodes.length)panel.append(actions);
  if((result.rows?.length || proposalCheck.rows?.length))panel.append(sectionAnchor('affected'));
  renderJoined(result.rows?.length ? result : proposalCheck);
}
function render() {
  renderMetrics();renderProjects();renderHistory();updateEventOptions();renderProposal();
}
function refresh() {state=lab.state();render()}
function requestReset(value) {
  requestedScale=value;
  if(state.history.length || plan) $('reset-dialog').showModal();
  else doReset();
}
function doReset() {
  const scale=requestedScale ?? state.scale;requestedScale=null;
  runAction(()=>{lab.reset(scale);clearPlan();page=0;$('filter').value='';currentEvent='deadline';refresh();notify(t('resetDone'))});
  if($('reset-dialog').open) $('reset-dialog').close();
}
function markNav() {
  const active=location.hash.slice(1)||'overview';
  document.querySelectorAll('[data-nav]').forEach(a=>{const selected=a.dataset.nav===active;a.classList.toggle('active',selected);if(selected)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current')});
}
document.querySelectorAll('[data-lang]').forEach(button=>button.addEventListener('click',()=>switchLanguage(button.dataset.lang)));
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$('project-dialog').addEventListener('close',()=>{openProject=null});
$('reset-dialog').addEventListener('close',()=>{requestedScale=null;if(state)$('scale').value=String(state.scale)});
$('event-select').addEventListener('change',()=>{currentEvent=$('event-select').value;clearPlan();error('');render()});
$('generate').addEventListener('click',prepare);
$('filter').addEventListener('input',()=>{page=0;if(state)renderProjects()});
$('scale').addEventListener('change',()=>{if(state)requestReset(Number($('scale').value))});
$('reset-open').addEventListener('click',()=>{if(state)requestReset(state.scale)});
$('reset-confirm').addEventListener('click',doReset);
$('reopen').addEventListener('click',()=>{if(lab)runAction(()=>{lab.reopen();refresh();notify(t('repl'))})});
window.addEventListener('hashchange',markNav); markNav();
localizedUI();
try{
  const {createLab}=await import('./engine.mjs');
  lab=await createLab();refresh();
}catch(e){error(t('storageError')+' '+e.message)}
