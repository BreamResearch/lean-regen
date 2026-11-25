import {label} from './strings.mjs';
import {present} from './report.mjs';

let lang = new URL(location.href).searchParams.get('lang')==='en'?'en':'ja';
let evidence, selected=0, step=null, failed=false, activeEvents=[];
const byId=id=>document.getElementById(id);
const t=key=>label(lang,key);
const isNumber=value=>typeof value==='number'&&Number.isFinite(value);
const number=(value,digits=2)=>isNumber(value) ? new Intl.NumberFormat(lang==='en'?'en-US':'ja-JP',{maximumFractionDigits:digits}).format(value) : '—';
const words=(ja,en)=>lang==='ja'?ja:en;
const ms=value=>isNumber(value)?number(value,3)+' ms':null;
const seconds=value=>isNumber(value)?number(value,3)+' s':null;
const yesNo=value=>value===true?words('はい','Yes'):value===false?words('いいえ','No'):null;
function node(tag,text,cls) {
  const el=document.createElement(tag);
  if (text!==undefined && text!==null) el.textContent=String(text);
  if (cls) el.className=cls;
  return el;
}
function option(value,title) {
  const result=node('option',title);result.value=String(value);return result;
}
function definition(pairs) {
  const dl=node('dl',null,'details-list');
  for(const [key,value] of pairs) {
    if(value===null || value===undefined) continue;
    const dd=node('dd');
    if(value instanceof Node) dd.append(value);else dd.textContent=String(value);
    dl.append(node('dt',key),dd);
  }
  return dl;
}
function table(headers, rows) {
  const wrap=node('div',null,'bench-table'), tab=node('table'), head=node('thead'), title=node('tr'), body=node('tbody');
  for(const header of headers){const th=node('th',header);th.scope='col';title.append(th);}
  head.append(title);
  for(const values of rows){
    const tr=node('tr');for(const v of values)tr.append(node('td',v));body.append(tr);
  }
  tab.append(head,body);wrap.append(tab);return wrap;
}
function metric(title,value,note) {
  const section=node('article',null,'metric');
  section.append(node('h3',title),node('strong',value));
  if(note) section.append(node('span',note,'metric-note'));
  return section;
}
function translate() {
  document.documentElement.lang=lang;document.title='Knot · '+t('title');
  document.querySelectorAll('[data-t]').forEach(el=>{el.textContent=t(el.dataset.t)});
  document.querySelectorAll('[data-lang]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.lang===lang)));
  byId('brand').href='../'+(lang==='en'?'?lang=en':'');
  byId('back').href='../operations/'+(lang==='en'?'?lang=en':'');
  byId('prev').setAttribute('aria-label',t('previous'));byId('next').setAttribute('aria-label',t('next'));
  byId('status').textContent=t(failed?'unavailable':'loading');
}
function showError() {
  failed=true;byId('report').hidden=true;
  byId('status').hidden=false;byId('status').classList.add('failed');byId('status').textContent=t('unavailable');
}
function changeStep(value) { step=value;renderEvents(activeEvents); }
function renderEvents(events) {
  if(!events.length) throw new Error('Missing event trace');
  if(step===null) step=Math.max(0,events.findIndex(event=>event.key==='cutover'));
  step=Math.min(Math.max(0,step),events.length-1);
  const current=events[step];
  byId('trace-index').textContent=number(step+1)+' / '+number(events.length);
  byId('step').replaceChildren(...events.map((entry,index)=>option(index,number(index+1)+' · '+entry.title)));
  byId('step').value=String(step);byId('prev').disabled=step===0;byId('next').disabled=step===events.length-1;
  const jumps=[['failedCutover',words('不一致を検出','Refused switch')],['cutover',words('切替に成功','Successful switch')],['rollback',words('切り戻し','Rollback')]];
  byId('jump').replaceChildren(...jumps.flatMap(([key,title])=>{
    const target=events.findIndex(event=>event.key===key);if(target<0)return [];
    const button=node('button',title,'jump-button');button.type='button';button.setAttribute('aria-pressed',String(step===target));
    button.dataset.checkpoint=key;
    button.addEventListener('click',()=>{changeStep(target);byId('jump').querySelector('[data-checkpoint="'+key+'"]').focus();});return [button];
  }));
  const detail=byId('trace-detail');
  detail.classList.toggle('refusal',Boolean(current.refusal));
  detail.replaceChildren(node('h3',current.title+(current.duration?' · '+current.duration:'')));
  if(current.detail) detail.append(node('p',current.detail));
  if(current.facts?.length) detail.append(definition(current.facts));
}
function blocks(parent,sections) {
  const root=byId(parent);root.replaceChildren();
  for(const section of sections) {
    let target=root;
    if(section.disclosure) {
      target=node('details',null,'data-details');target.append(node('summary',section.disclosure));root.append(target);
    }
    if(section.title) target.append(node('h3',section.title,'subhead'));
    if(section.facts?.length) target.append(definition(section.facts));
    if(section.chart?.length) {
      const chart=node('div',null,'bars');
      const maximum=Math.max(...section.chart.map(item=>item.value),1);
      for(const item of section.chart) {
        const row=node('div',null,'bar-row'), bar=node('meter');
        bar.min=0;bar.max=maximum;bar.value=item.value;bar.setAttribute('aria-label',item.label);
        row.append(node('span',item.label),bar,node('strong',ms(item.value)));chart.append(row);
      }
      target.append(chart);
    }
    if(section.columns && section.rows) target.append(table(section.columns,section.rows));
    if(section.note) target.append(node('p',section.note,'inspect-note'));
  }
}
function render() {
  translate();if(!evidence) return;
  const view=present(evidence,{words,number,ms,seconds,yesNo});
  if(selected>=view.runs.length) selected=0;
  const run=view.runs[selected];if(!run) throw new Error('Missing measured run');
  byId('product').textContent=run.product;byId('product').hidden=!run.product;
  byId('scenario').replaceChildren(...view.runs.map((item,index)=>option(index,item.name)));
  byId('scenario').value=String(selected);
  const single=view.runs.length===1;
  byId('scenario').hidden=single;byId('single-run').hidden=!single;byId('single-run').textContent=run.name;
  if(single) byId('scenario-label').textContent=words('測定プロファイル','Workload profile');
  byId('scenario-note').textContent=run.note||t('replayOnly');
  const ci=byId('ci-run');
  const trusted=typeof run.runUrl==='string' && /^https:\/\/github\.com\/BreamResearch\/lean-regen\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?\/?$/i.test(run.runUrl);
  ci.hidden=!trusted;if(trusted) ci.href=run.runUrl;else ci.removeAttribute('href');
  byId('metrics').replaceChildren(...run.metrics.map(item=>metric(item.title,item.value,item.note)));
  byId('summary-note').textContent=run.summary||'';byId('summary-note').hidden=!run.summary;
  activeEvents=run.events;renderEvents(activeEvents);blocks('load',run.load);blocks('audit',run.audit);blocks('setup',[run.setup]);
  for(const key of ['audit','setup']) byId(key+'-card').hidden=!byId(key).childElementCount;
  byId('status').hidden=true;byId('report').hidden=false;
}
byId('scenario').addEventListener('change',event=>{selected=Number(event.target.value);step=null;render();});
byId('step').addEventListener('change',event=>changeStep(Number(event.target.value)));
byId('prev').addEventListener('click',()=>changeStep(step-1));
byId('next').addEventListener('click',()=>changeStep(step+1));
document.querySelectorAll('[data-lang]').forEach(button=>button.addEventListener('click',()=>{
  lang=button.dataset.lang;const url=new URL(location.href);url.searchParams.set('lang',lang);history.replaceState(null,'',url);render();
}));
translate();
try {
  const response=await fetch('./evidence.json',{credentials:'omit'});
  if (!response.ok) throw new Error(String(response.status));
  evidence=await response.json();render();
} catch {evidence=null;showError();}
