import {decisionCases} from './cases.mjs';

const strategies=['fixed','adaptive','llm'];
const finite=Number.isFinite;
function median(values) {
  const sorted=values.filter(finite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
const compact=entries=>entries.filter(([,value])=>value!==null&&value!==undefined&&value!=='');
const first=(...values)=>values.find(value=>value!==undefined&&value!==null);

export function present(bundle,{lang,w,num,fmt},selectedRepeat='all',arrival='all') {
  const bench=bundle.benchmark, battery=bundle.decisionCases;
  if(!Array.isArray(bench?.trials)||!bench.trials.length)throw new TypeError('Missing measured trials');
  const arms=[
    {id:'fixed',label:w('固定方式','Fixed')},{id:'adaptive',label:w('自動調整','Adaptive')},{id:'llm',label:w('自動調整＋LLM','Adaptive + LLM')}
  ];
  const names=Object.fromEntries(arms.map(arm=>[arm.id,arm.label]));
  const repeats=[...new Set(bench.trials.map(trial=>trial.repeat))].sort((a,b)=>a-b);
  const trials=selectedRepeat==='all'?bench.trials:bench.trials.filter(trial=>String(trial.repeat)===String(selectedRepeat));
  const armValues=(rows,read)=>Object.fromEntries(strategies.map(key=>[key,median(rows.filter(row=>row.strategy===key).map(read))]));
  const windows=(bench.schedule?.segments||[]).map((x,i)=>({id:String(i),label:num(x.startMs/1000)+'–'+num(x.endMs/1000)+' s · '+num(x.requestsPerSecond)+w(' 要求/秒',' req/s')}));
  const sojourn=row=>arrival==='all'?row.workload?.scheduledToAckMs:row.workload?.segments?.[Number(arrival)]?.scheduledToAckMs;
  const descriptions=[
    ['p99',w('予定時刻から応答まで p99','Scheduled arrival to ack · p99'),'ms',3,row=>sojourn(row)?.p99,w('各要求の到着予定時刻から、Odooが応答した時刻まで。クライアント側の待ち時間を含みます。','Time from scheduled arrival to Odoo acknowledgement, including client-side queueing.')],
    ['p95',w('予定時刻から応答まで p95','Scheduled arrival to ack · p95'),'ms',3,row=>sojourn(row)?.p95,w('到着予定の時刻を基準にした利用者側の待ち時間です。','Latency measured from the scheduled arrival time.')],
    ['backfill',w('既存データの転記時間','Historical backfill elapsed'),'s',3,row=>{const value=first(row.migration?.backfill?.elapsedMs,row.migration?.backfill?.totalMs);return finite(value)?value/1000:null;},w('既存の分析明細を新形式へ転記する区間にかかった時間です。','Elapsed time for the phase that copied existing analytic lines into the new layout.')],
    ['cutover',w('切替操作の経過時間','Cutover transaction elapsed'),'ms',3,row=>row.migration?.cutover?.totalMs,w('書き込みの排他ゲートが空くまでの待機と、切替トランザクションを含みます。','Includes waiting for the write gate and completing the cutover transaction.')],
    ['service',w('リクエストの応答時間 p95','ERP service latency · p95'),'ms',3,row=>row.workload?.serviceMs?.p95,w('実際にOdooへ送信してから応答を受け取るまでです。','From the actual request to its Odoo acknowledgement.')],
    ['queue',w('送信待ち時間 p95','Client queueing · p95'),'ms',3,row=>row.workload?.queueMs?.p95,w('到着予定時刻から、書き手が実際に送信するまでの待ち時間です。','From scheduled arrival until the writer actually issued the request.')],
    ['modelWait',w('切替判断中のモデル待ち時間','Model wait during cutover decision'),'ms',3,row=>row.decision?.modelWaitMs,w('各試行の切替判断でモデルを待った合計です。','Total time waiting for the model during each trial’s cutover decision.')],
    ['migration',w('移行開始から切り戻し照合まで','Migration through rollback audit'),'s',3,row=>finite(row.migrationThroughRollbackAuditMs)?row.migrationThroughRollbackAuditMs/1000:null,w('新形式の追加、転記、切替、切り戻しと事後照合を含みます。','Includes expansion, backfill, cutover, rollback and its audit.')],
    ['gap',w('最大応答間隔','Maximum response gap'),'ms',3,row=>row.workload?.maxResponseGapMs,w('負荷試験で成功応答がなかった最長の間隔です。','Longest observed interval without a successful response during this workload.')]
  ];
  const metrics=descriptions.map(([id,label,unit,digits,read,note])=>({id,label,unit,digits,values:armValues(trials,read),note})).filter(m=>Object.values(m.values).some(finite));
  if(!metrics.length)throw new TypeError('Missing comparable measured metrics');
  for(const metric of metrics)metric.note+=' '+(selectedRepeat==='all'?w('各方式について、各回の測定値の中央値を表示します。','Values are medians of the per-run measurements for each approach.'):w('選択した回の測定値を表示します。','Values are for the selected repeat.'));
  const tableRows=bench.trials.map(row=>[num(row.repeat),names[row.strategy]||row.strategy,num(row.workload?.acknowledged),num(row.workload?.failed),fmt(row.workload?.scheduledToAckMs?.p99,'ms',3),
    fmt(row.migration?.cutover?.totalMs,'ms',3),num(row.migration?.backfill?.rowsCopied),num(row.integrity?.exactLiveLegs)]);
  const results={headers:[w('反復','Repeat'),w('方式','Approach'),w('成功応答','Acknowledged'),w('失敗','Failed'),w('利用者のp99','End-to-end p99'),w('切替','Cutover'),w('転記行数','Rows copied'),w('照合した新規明細','New Odoo lines matched')],rows:tableRows};
  const conditions=compact([[w('開始時の分析明細','Opening analytic lines'),num(bench.parameters?.rows)],[w('書き手','Writers'),num(bench.parameters?.writers)],[w('各方式の実行回数','Runs per arm'),num(repeats.length)],
    [w('実測記録にある方式数','Approaches in this record'),num(new Set(bench.trials.map(trial=>trial.strategy)).size)],[w('到着予定の要求数','Scheduled requests per trial'),num(first(bench.schedule?.requests,bench.schedule?.count))],
    [w('負荷パターンのSHA-256','Arrival schedule SHA-256'),bench.schedule?.sha256]]);
  const limits=[w('このページは登録不要で実測記録を再生します。再現手順では固定したモデルをローカルCPUで動かします。','This page replays the recorded experiments without an account. The reproduction guide runs the pinned model on a local CPU.'),
    w('業務書き込みの実験と、正解を設定した判断例の試験は、別々に評価します。','The workload comparison and the labelled decision cases are separate experiments.')];
  const probe=decisionCases(battery,{lang,w,num,fmt});
  const modelTrials=bench.trials.filter(trial=>trial.strategy==='llm');
  const attempts=modelTrials.flatMap(trial=>trial.decision.attempts).filter(entry=>entry.modelAdvice!=null);
  const active=attempts.filter(entry=>entry.modelAdvice.status==='ok' && entry.modelAdvice.rawAction);
  const different=active.filter(entry=>entry.modelAdvice.rawAction!==entry.structuredAlternative?.action);
  const fallbackCount=modelTrials.filter(trial=>trial.decision.boundedFallback==='structured-approved-live-fallback-window').length;
  const retained=modelTrials.filter(trial=>trial.decision.effectiveAction==='retain-dual').length;
  const med=armValues(bench.trials,trial=>trial.workload?.scheduledToAckMs?.p99);
  const measuredDiff=med.llm-med.adaptive;
  const paired=repeats.flatMap(repeat=>{
    const rows=bench.trials.filter(row=>row.repeat===repeat);
    const p99=arm=>rows.find(row=>row.strategy===arm)?.workload?.scheduledToAckMs?.p99;
    return finite(p99('llm'))&&finite(p99('adaptive'))?[p99('llm')-p99('adaptive')]:[];
  });
  const lower=paired.filter(delta=>delta<0).length;
  const pairedText=paired.length?w('同じ回どうしでは、LLM併用側が短かったのは '+num(lower)+' / '+num(paired.length)+' 組です。',
    'The LLM arm had the lower p99 in '+num(lower)+' of '+num(paired.length)+' matched repeats.'):'';
  const outcome=measuredDiff===0?w('同じ','the same'):measuredDiff<0?w('短い','lower'):w('長い','higher');
  const s=battery?.scores;
  const timings=w('各試行のp99の中央値は、LLM併用で '+fmt(med.llm,'ms',1)+'。自動調整だけの '+fmt(med.adaptive,'ms',1)+' と比べて'+(measuredDiff===0?'同じです。':fmt(Math.abs(measuredDiff),'ms',1)+' '+outcome+'結果でした。'),
    'With LLM advice, median end-to-end p99 was '+fmt(med.llm,'ms',1)+', compared with '+fmt(med.adaptive,'ms',1)+' for adaptive control alone'+(measuredDiff===0?' (the same).':' ('+fmt(Math.abs(measuredDiff),'ms',1)+' '+outcome+').'));
  const scoreText=s?.model&&s?.structured&&s?.keyword?w('運用メモの判断が期待と一致したのは、LLM併用 '+s.model.correct+'/'+s.model.total+'、構造化規則 '+s.structured.correct+'/'+s.structured.total+'、キーワード規則 '+s.keyword.correct+'/'+s.keyword.total+' でした。','In the labelled notes, the LLM-assisted policy matched '+s.model.correct+'/'+s.model.total+' expected actions, the structured rule '+s.structured.correct+'/'+s.structured.total+' and the keyword rule '+s.keyword.correct+'/'+s.keyword.total+'.'):'';
  let finding;
  if(bench.status==='INCONCLUSIVE_TIMING'){
    finding=w('一部の試行で負荷中の切替を確認できず、LLMの効果は判定できませんでした。','Some trials missed the live execution window. This run cannot establish the LLM’s effect under load.');
  } else if(!active.length) {
    finding=w('業務負荷中に有効なモデル応答が得られず、切替判断への寄与は確認できませんでした。','No valid model response was available during the workload. Its contribution to cutover decisions could not be established.');
  } else if(!different.length){
    finding=w('業務負荷中に取得できたLLMの助言は '+active.length+' 回すべて、同じ観測に対する規則の判断と一致しました。','All '+active.length+' usable LLM recommendations during the workload matched the structured rule on the same observation.');
  } else {
    finding=w('業務負荷中にLLMが規則と異なる助言を返したのは '+different.length+' / '+active.length+' 回でした。','The LLM gave a different recommendation from the structured rule on '+different.length+' of '+active.length+' usable responses during the workload.');
  }
  const findingNote=timings+' '+pairedText+' '+scoreText;
  const resizeTally=arm=>{
    const rows=bench.trials.filter(row=>row.strategy===arm);
    return num(rows.filter(row=>row.migration.backfill.changeCount>0).length)+'/'+num(rows.length);
  };
  const wait=fmt(median(modelTrials.map(trial=>trial.decision.modelWaitMs/1000)),'s',3);
  const controllerNote=w('転記サイズが変わった試行は、自動調整だけで '+resizeTally('adaptive')+' 回、LLM併用で '+resizeTally('llm')+' 回。切替判断でモデルを待った時間の中央値は '+wait+' でした。',
    'Chunk size changed in '+resizeTally('adaptive')+' adaptive-only trials and '+resizeTally('llm')+' LLM-assisted trials. The median time spent waiting for advice was '+wait+'.');
  conditions.push(...compact([['Odoo Community',bench.runtime?.odoo],['PostgreSQL',bench.runtime?.postgresql],
    [w('上限到達後に通常規則で再検査したLLM試行','LLM trials using the authorised fallback'),num(fallbackCount)+' / '+num(modelTrials.length)],
    [w('新旧併存で終了したLLM試行','LLM trials that retained both layouts'),num(retained)+' / '+num(modelTrials.length)],
    [w('モデル','Model'),bench.model?.name],[w('量子化','Quantization'),bench.model?.quantization],[w('推論環境','Inference environment'),[bench.model?.platform,bench.model?.device].filter(Boolean).join(' · ')],
    [w('運用中の有効なモデル応答','Usable model replies under load'),num(active.length)+' / '+num(attempts.length)],[w('推論スレッド','Inference threads'),num(bench.model?.threads)],[w('判断例を評価したモデル環境','Model environment for labelled cases'),[battery?.model?.platform,battery?.model?.device].filter(Boolean).join(' · ')],
    [w('負荷中に切替・後続書き込みを確認した試行','Trials with cutover and later writes under offered load'),num(bench.trials.filter(x=>x.cutoverDuringOfferedLoad).length)+' / '+num(bench.trials.length)]]));
  limits.unshift(w('同じOdoo原本から各試行のデータベースを複製し、同じ時刻表で要求を投入しました。固定方式は4,000行ずつ転記し、自動調整の2方式は同じ規則で転記量を決めます。3方式とも同じ切替規則を使い、LLMへの相談は規則が許可した時点だけです。','Every trial starts from a clone of the same Odoo data and uses the same arrival schedule. Fixed copies 4,000 rows at a time. Both adaptive arms use the same chunk controller. All three arms share a cutover rule. Only the LLM arm asks for advice, and only when that rule permits a switch.'));
  limits.push(w('モデルサーバーは試行の前に起動しました。待ち時間には初回ダウンロードやサーバー起動を含みません。各方式の実行順は反復ごとに入れ替えています。','The model server was started before the trials. The reported decision wait excludes initial download and server startup. Execution order rotates by repeat.'),
    w('1種類の小型モデルと合成負荷を使った比較です。反復ごとのばらつきは、同一負荷でも方式間の差に影響します。','This comparison uses one small model and a generated workload. Run-to-run variation can affect the observed difference even with matched arrivals.'));
  const action=value=>({proceed:w('切替を試す','Proceed'),defer:w('待機','Defer')}[value] || '—');
  const live=bench.trials.map(row=>{
    const d=row.decision,bf=row.migration.backfill;
    const eligible=Boolean(row.cutoverDuringOfferedLoad);
    const fields=[
      [w('実行順','Position in repeat'),num(row.position)],[w('切替開始まで','Time to cutover start'),fmt(row.cutoverStartedAtMs,'ms',1)],
      [w('延期回数','Deferrals'),num(d.deferrals)],[w('助言を待った時間','Time awaiting advice'),fmt(d.modelWaitMs,'ms',1)],
      [w('判断後に届いたモデル応答（未使用）','Late model response (unused)'),d.lateResultAfterDecision?action(d.lateResultAfterDecision.action):null],
      [w('最終判断','Final decision'),d.effectiveAction==='retain-dual'?w('新旧併存を維持','Retain dual writes'):w('変更できない照合条件で切替を試行','Submit to the fixed cutover checks')],
      [w('上限到達時の処理','Fallback at the decision bound'),d.boundedFallback==='no-eligible-live-window'?w('有効な変更枠なし','No eligible execution window'):d.boundedFallback?w('規則が許可した枠で再検査','Recheck in a rule-approved window'):w('なし','Unused')],
      [w('転記処理','Backfill'),num(bf.rowsCopied)+w(' 行 / ',' rows / ')+num(bf.chunks)+w(' 回に分割',' chunks')],
      [w('転記サイズ変更・休止','Chunk-size changes and pause'),num(bf.changeCount)+w(' 回 · ',' · ')+fmt(bf.sleepMs,'ms',1)],
      [w('負荷中の切替と後続書き込み','Cutover and subsequent posts under load'),eligible?w('確認','Confirmed'):w('条件を満たさず','Condition not met')],
      [w('安全条件の確認','Safe cutover and restore'),row.integrity.oldTableRetainedOnRefusal&&row.integrity.oldTableRemovedOnCutover&&row.integrity.oldTableRestored?w('不一致で旧表保持 → 切替で削除 → 切り戻しで復元','Old table retained on refusal, removed at cutover and restored on rollback'):d.effectiveAction==='retain-dual'&&row.integrity.oldTableRetainedOnRefusal?w('切替を見送り、旧表を保持','Cutover deferred. Old table retained.'):w('記録を確認','Inspect the raw record')],
      [w('Odooで再読して照合した新規明細','New native Odoo lines verified'),num(row.integrity.exactLiveLegs)],
      [w('開始時の全列履歴と終了後の照合','Historical Odoo full-row digest'),row.integrity.fullNativeHistoryAfter?.sha256===bench.baseline?.nativeHistory?.sha256?w('一致','Match'):w('不一致','Mismatch')]];
    const rows=d.attempts.map((attempt,index)=>{
      const obs=attempt.observation,adv=attempt.advice||{},raw=attempt.modelAdvice;
      const reply=!raw?'—':raw.status==='ok'?action(raw.rawAction):raw.status==='timeout'?w('時間切れ','Timeout'):raw.status==='unavailable'?w('使用不可','Unavailable'):raw.status;
      return [num(index+1),fmt(obs.elapsedMs,'ms',1),num(obs.queuedRequests),fmt(obs.recentP95Ms,'ms',1),action(attempt.structuredAlternative?.action),reply,action(adv.action)];
    });
    return {id:String(row.repeat)+'-'+row.strategy,label:w('試行 ','Repeat ')+num(row.repeat)+' · '+names[row.strategy],strategy:row.strategy,facts:fields,
      headers:[w('判断','Attempt'),w('経過','Elapsed'),w('送信待ち','Queued'),w('直近p95','Recent p95'),w('同じ観測での規則','Rule on same input'),w('モデルの応答','Model response'),w('実際の判断','Effective decision')],rows,
      note:w('「切替を試す」で進んだ後も、データベースは現在の状態で照合をやり直します。','After a proceed decision the database checks its current state again before committing the switch.')};
  });
  return {arms,repeats,windows,runCount:bench.trials.length,metrics,results,conditions,limits,finding,findingNote,controllerNote,live,...probe};
}
