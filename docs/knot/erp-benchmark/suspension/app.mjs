import {present} from './report.mjs';

const copy={
  ja:{run:'計測記録',title:'LLMは台帳の切替判断に役立つか',back:'← ERP切替の実測',intro:'Odooへの書き込み中に台帳を移行します。自動調整の2方式で転記の制御は同じです。LLMに切替時点を相談すると、利用者の待ち時間や判断はどう変わるでしょうか。',ci:'公開CIの実行記録 ↗',guide:'再現手順 ↗',raw:'実測値のJSON ↗',findings:'今回の結果',arrival:'要求の到着時間帯',live:'業務負荷中の切替判断',trial:'試行を選ぶ',repeat:'表示する試行',compare:'3方式の実測比較',metric:'比較する指標',base:'差の基準',decisions:'判断の記録',case:'状況を選ぶ',scope:'測定条件と適用範囲',load:'実測記録を読み込んでいます。',error:'実測記録を読み込めませんでした。上のリンクからJSONを開けます。',noData:'測定値なし',same:'基準',runs:'実行',record:'保存した実測記録を表示しています。',details:'各実行の実測値',method:'方式',observed:'観測値'},
  en:{run:'Hosted measurement',title:'Does LLM advice improve cutover timing?',back:'← ERP cutover benchmark',intro:'Odoo continues to receive analytic lines during migration. Both adaptive approaches use the same backfill controller. What changes when an LLM also advises on when to switch?',ci:'Public CI run ↗',guide:'Reproduction guide ↗',raw:'Evidence JSON ↗',findings:'What happened in this run',arrival:'Scheduled arrival window',live:'Cutover decisions during the workload',trial:'Select a trial',repeat:'Show trials',compare:'Three approaches under load',metric:'Compare metric',base:'Difference from',decisions:'Decision records',case:'Select a case',scope:'Conditions and scope',load:'Loading recorded measurements…',error:'The record could not be loaded. Open the evidence JSON above.',noData:'Not measured',same:'Reference',runs:'runs',record:'This page displays recorded measurements.',details:'Per-run measurements',method:'Method',observed:'Observed'}
};
const el=(tag,value,cls)=>{const n=document.createElement(tag);if(value!==undefined&&value!==null)n.textContent=String(value);if(cls)n.className=cls;return n};
const $=id=>document.getElementById(id);
let lang=new URL(location.href).searchParams.get('lang')==='en'?'en':'ja', evidence=null, failed=false;
const searchParams=new URL(location.href).searchParams;
let runId=searchParams.get('run')==='replication'?'replication':'primary';
const selectedRecord=()=>runId==='replication'&&evidence.replication?evidence.replication:evidence;
let metricId=null, baseline='adaptive', caseId=null, liveId=null, selectedRepeat='all', arrival='all';
const viewOf=()=>present(selectedRecord(),{lang,w,num,fmt},selectedRepeat,arrival);
const t=key=>copy[lang][key]||key;
const w=(ja,en)=>lang==='ja'?ja:en;
const num=(value,digits=2)=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString(lang==='ja'?'ja-JP':'en-US',{maximumFractionDigits:digits}):'—';
const fmt=(value,unit,digits=2)=>typeof value==='number'&&Number.isFinite(value)?num(value,digits)+(unit?' '+unit:''):t('noData');
function options(select,items,value) {
  select.replaceChildren(...items.map(entry=>{const opt=el('option',entry.label);opt.value=entry.id;return opt;}));select.value=value;
}
function facts(entries){
  const dl=el('dl',null,'details-list');for(const [key,value] of entries){if(value===null||value===undefined)continue;dl.append(el('dt',key),el('dd',value));}return dl;
}
function table(headers,rows){
  const wrapper=el('div',null,'bench-table'),table=el('table'),head=el('thead'),heading=el('tr'),body=el('tbody');
  for(const word of headers){const th=el('th',word);th.scope='col';heading.append(th);}
  for(const values of rows){const tr=el('tr');for(const v of values)tr.append(el('td',v));body.append(tr);}
  head.append(heading);table.append(head,body);wrapper.append(table);return wrapper;
}
function localize(){
  document.documentElement.lang=lang;document.title='Knot · '+t('title');
  document.querySelectorAll('[data-i18n]').forEach(n=>{n.textContent=t(n.dataset.i18n)});
  document.querySelectorAll('[data-lang]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.lang===lang)));
  $('brand').href='../../'+(lang==='en'?'?lang=en':'');$('back').href='../'+(lang==='en'?'?lang=en':'');
  $('loading').textContent=t(failed?'error':'load');
}
function renderChart(view) {
  if(!view.metrics.some(m=>m.id===metricId)) metricId=view.metrics[0].id;
  if(!view.arms.some(a=>a.id===baseline)) baseline=view.arms[0].id;
  $('arrival-controls').hidden=!['p95','p99'].includes(metricId)||!view.windows.length;
  options($('arrival'),[{id:'all',label:w('全時間帯','Full schedule')},...view.windows],arrival);
  options($('metric'),view.metrics,metricId);options($('base'),view.arms,baseline);
  const metric=view.metrics.find(m=>m.id===metricId), reference=metric.values[baseline];
  const limit=Math.max(...Object.values(metric.values).filter(Number.isFinite),0);
  const comparison=$('chart');comparison.replaceChildren();
  for(const arm of view.arms) {
    const value=metric.values[arm.id], row=el('div',null,'arm-row '+arm.id);
    const track=el('span',null,'track'), bar=el('i');bar.style.width=(limit>0&&Number.isFinite(value)?Math.max(0,value/limit*100):0)+'%';track.append(bar);track.setAttribute('aria-hidden','true');
    const delta=typeof value==='number'&&typeof reference==='number'?value-reference:null;
    const relative=delta!==null&&reference!==0?delta/reference*100:null;
    const change=arm.id===baseline?t('same'):delta===null?'—':(delta>0?'+':'')+fmt(delta,metric.unit,metric.digits)+(relative!==null?' ('+(relative>0?'+':'')+num(relative,1)+'%)':'');
    row.append(el('span',arm.label),track,el('strong',fmt(value,metric.unit,metric.digits)),el('small',change));comparison.append(row);
  }
  $('metric-note').textContent=metric.note;
}
function renderCase(view) {
  const picker=$('case').parentElement,record=$('decision');
  $('decisions-intro').textContent=view.caseIntro;
  const scores=$('scores');scores.replaceChildren();if(view.caseScores)scores.append(table(view.caseScores.headers,view.caseScores.rows),el('p',view.caseScores.note,'basis'));
  picker.hidden=!view.cases.length;record.replaceChildren();
  if(!view.cases.length)return;
  if(!view.cases.some(c=>c.id===caseId))caseId=view.cases[0].id;
  options($('case'),view.cases,caseId);const choice=view.cases.find(c=>c.id===caseId);
  const summary=el('div',null,'decision-case');summary.append(el('h3',choice.label));if(choice.detail)summary.append(el('p',choice.detail));
  record.append(summary,facts(choice.facts));
  if(lang==='ja' && choice.original && choice.original!==choice.detail){
    const original=el('details',null,'data-details'), quote=el('p',choice.original,'basis');quote.lang='en';
    original.append(el('summary','運用メモの原文（英語）'),quote);record.append(original);
  }
  if(choice.note)record.append(el('p',choice.note,'basis'));
}
function renderLive(view) {
  const root=$('live'), items=view.live||[];
  if(!items.some(row=>row.id===liveId))liveId=items.find(row=>row.strategy==='llm')?.id||items[0]?.id;
  options($('trial'),items,liveId);root.replaceChildren();
  const row=items.find(row=>row.id===liveId);if(!row)return;
  root.append(facts(row.facts));
  if(row.headers&&row.rows?.length)root.append(table(row.headers,row.rows));
  if(row.note)root.append(el('p',row.note,'basis'));
}
function render(){
  localize();if(!evidence)return;
  const records=[{id:'primary',data:evidence,letter:'A'}];
  if(evidence.replication?.benchmark?.trials?.length)records.push({id:'replication',data:evidence.replication,letter:'B'});
  if(!records.some(record=>record.id===runId))runId='primary';
  $('run-picker').hidden=records.length<2;
  if(records.length>1){
    options($('run'),records.map(({id,data,letter})=>{
      const trials=data.benchmark.trials.filter(trial=>trial.strategy==='adaptive');
      const changed=trials.filter(trial=>trial.migration.backfill.changeCount>0).length;
      return {id,label:w('実行 '+letter+' · 転記サイズが変化 '+changed+'/'+trials.length+' 回','Run '+letter+' · chunk size changed in '+changed+'/'+trials.length+' adaptive trials')};
    }),runId);
    $('run-note').textContent=w('同じ到着予定と開始データを使った、独立した2件の公開CI実行です。切り戻しを実行しなかった場合の記録形式だけが異なります。各図は選択した実行の測定値を表示します。','Two independent public CI jobs used the same arrival schedule and starting data. Their source revisions differ only in how they report a rollback that was never executed. Each chart shows the selected job.');
  }
  const view=viewOf(), record=selectedRecord();
  const source=record.provenance?.runUrl;
  const verified=typeof source==='string' && /^https:\/\/github\.com\/BreamResearch\/lean-regen\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?\/?$/i.test(source);
  $('ci').hidden=!verified;if(verified)$('ci').href=source;else $('ci').removeAttribute('href');
  options($('repeat'),[{id:'all',label:w('全試行の中央値','Medians across repeats')},...view.repeats.map(r=>({id:String(r),label:w('試行 ','Repeat ')+num(r)}))],selectedRepeat);
  $('finding').textContent=view.finding;$('finding-note').textContent=view.findingNote;$('controller-note').textContent=view.controllerNote;
  const b=record.benchmark;
  const name=typeof b.model?.name==='string'?b.model.name.split('/').pop():null;
  $('context').textContent=[b.runtime?.odoo?'Odoo Community '+b.runtime.odoo:null,name].filter(Boolean).join(' · ');$('context').hidden=!$('context').textContent;
  $('run-count').textContent=num(b.parameters.rows)+w(' 行 · ',' rows · ')+num(b.parameters.writers)+w(' 書き手 · ',' writers · ')+num(view.runCount)+' '+t('runs');
  renderChart(view);renderCase(view);renderLive(view);
  const results=$('results');results.replaceChildren();
  if(view.results?.rows.length){const details=el('details',null,'data-details');details.append(el('summary',t('details')),table(view.results.headers,view.results.rows));results.append(details);}
  const scope=$('scope');scope.replaceChildren(facts(view.conditions));
  const limits=el('ul',null,'scope-list');for(const item of view.limits)limits.append(el('li',item));scope.append(limits);
  $('report').hidden=false;$('loading').hidden=true;
}
for(const button of document.querySelectorAll('[data-lang]'))button.addEventListener('click',()=>{lang=button.dataset.lang;const url=new URL(location.href);url.searchParams.set('lang',lang);history.replaceState(null,'',url);render()});
$('run').addEventListener('change',()=>{
  runId=$('run').value;
  const url=new URL(location.href);
  if(runId==='primary')url.searchParams.delete('run');else url.searchParams.set('run',runId);
  history.replaceState(null,'',url);render();
});
$('repeat').addEventListener('change',()=>{selectedRepeat=$('repeat').value;render()});
$('metric').addEventListener('change',()=>{metricId=$('metric').value;renderChart(viewOf())});
$('arrival').addEventListener('change',()=>{arrival=$('arrival').value;renderChart(viewOf())});
$('base').addEventListener('change',()=>{baseline=$('base').value;renderChart(viewOf())});
$('trial').addEventListener('change',()=>{liveId=$('trial').value;renderLive(viewOf())});
$('case').addEventListener('change',()=>{caseId=$('case').value;renderCase(viewOf())});
localize();
try{
  const response=await fetch('./evidence.json',{credentials:'omit'});if(!response.ok)throw new Error('Missing report');
  evidence=await response.json();render();
}catch{
  failed=true;evidence=null;$('loading').textContent=t('error');$('loading').classList.add('failed');$('loading').hidden=false;$('report').hidden=true;
}
