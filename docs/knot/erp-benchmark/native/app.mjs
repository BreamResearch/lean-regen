const copy={
  back:['← ERP切替の実測','← ERP cutover benchmark'],title:['勘定の判定をどこまで速くできるか','How fast can an account check run?'],
  intro:['予算・工数の振替では、元と先の勘定がそれぞれ6条件を満たすか検査します。Pythonで規則を読み解く処理を、同じ理由で許可・拒否する整数演算に置き換え、判定とOdooの応答を測りました。','A budget and hours transfer checks six conditions on each account. We replaced a Python rule interpreter with integer operations that return the same decision and reasons, then measured both the check and the Odoo response.'],
  guide:['再現手順 ↗','Reproduction guide ↗'],ci:['公開CI ↗','Public CI run ↗'],json:['実測JSON ↗','Evidence JSON ↗'],host:['単体測定の環境','Microbenchmark host'],
  scalar:['振替1件の判定','One complete transfer'],batch:['勘定行の一括判定','Batch of account rows'],odoo:['Odooに書き込んだとき','What happens when Odoo posts the entries?'],
  memory:['作業配列とプロセスのメモリ','Working arrays and process memory'],proof:['Leanの証明とバイナリの照合','Lean proofs and binary checks']
};
const $=id=>document.getElementById(id);
const node=(tag,value,cls)=>{const n=document.createElement(tag);if(value!=null)n.textContent=value;if(cls)n.className=cls;return n};
let lang=new URL(location.href).searchParams.get('lang')==='en'?'en':'ja',record,host='micro',failed=false;
const w=(ja,en)=>lang==='en'?en:ja;
const n=(v,d=1)=>Number.isFinite(v)?v.toLocaleString(lang==='en'?'en-US':'ja-JP',{maximumFractionDigits:d}):'—';
const para=(s,cls)=>node('p',s,cls);
const mbytes=v=>Number.isFinite(v)?n(v/(1024*1024),1)+' MiB':'—';
const kib=v=>Number.isFinite(v)?n(v/1024,1)+' KiB':'—';
function table(head,rows){
  const t=node('table'),h=node('thead'),b=node('tbody'),r=node('tr');
  for(const label of head){const c=node('th',label);c.scope='col';r.append(c)}
  h.append(r);
  for(const row of rows){const r=node('tr');row.forEach((x,i)=>{const c=node(i===0?'th':'td',x);if(!i)c.scope='row';r.append(c)});b.append(r)}
  t.append(h,b);const wrap=node('div',null,'bench-table');wrap.append(t);return wrap;
}
function median(values){const vals=values.filter(Number.isFinite).sort((a,b)=>a-b),m=Math.floor(vals.length/2);return vals.length?(vals.length%2?vals[m]:(vals[m-1]+vals[m])/2):null}
function labels(){return {'python-transfer':w('Python 規則','Python rules'),'native-transfer':w('C＋Python呼出し','C + Python call'),'native-batch':w('C 一括','C batch'),'numpy-batch':w('NumPy 行配置','NumPy row-major'),'numpy-columnar-batch':w('NumPy 列配置','NumPy columnar')}}
function runMicro(micro){
  const {backends,ratios,method,corpus}=micro, names=labels();
  $('method').textContent=w('各方式を別プロセスで実行。ウォームアップ後の ','Separate processes, warmed up before timing. ')+n(method.config.repeats)+w(' 回の中央値です。',' rounds, reporting medians.');
  const scalarRows=['python-transfer','native-transfer'].map(k=>[names[k],n(backends[k].wallNsPerOperation.median/1000,3)+' µs',mbytes(backends[k].peakRssBytes.median)]);
  $('scalar').replaceChildren(para(w('Pythonの '+n(ratios.pythonOverNativeTransferWall.median,2)+' 倍の処理速度',n(ratios.pythonOverNativeTransferWall.median,2)+'× Python throughput'),'headline'),
    para(w('元と先の2勘定を調べ、許可・拒否の理由と判定後の残高をPythonに返すまで。','Checks both accounts and returns the full Python result, including reasons and resulting balances.')),
    table([w('実装','Implementation'),w('時間 / 振替','Time / transfer'),w('最大RSS¹','Peak RSS¹')],scalarRows),
    para(n(corpus.transfer.count)+w(' 件の入力のうち、任意精度のPythonに戻る入力も ',' inputs include ')+n(corpus.transfer.wideFallbackCount)+w(' 件含みます。',' that require the arbitrary-precision Python fallback.')));
  const batchKeys=['native-batch','numpy-batch','numpy-columnar-batch'].filter(k=>backends[k]);
  const batchRows=batchKeys.map(k=>[names[k],n(backends[k].wallNsPerOperation.median,3)+' ns',mbytes(backends[k].peakRssBytes.median)]);
  const perAccount=n(backends['native-batch'].wallNsPerOperation.median,3)+w(' ns / 勘定行',' ns / account row');
  $('batch').replaceChildren(para(perAccount,'headline'),
    para(w('準備済みの '+n(corpus.batch.count)+' 行を一度に渡し、各行の違反を1バイトに記録します。1行あたりの値はバッチ全体を行数で割った時間です。','A single call checks '+n(corpus.batch.count)+' prepared rows and writes one byte of reason bits per row. Per-row time is the batch duration divided by row count.')),
    table([w('実装','Implementation'),w('時間 / 行','Time / row'),w('最大RSS¹','Peak RSS¹')],batchRows));
  if(!backends['numpy-batch']){
    $('batch').append(para(w('この環境で測定した一括実装はCのみです。NumPyとの比較はローカルの測定にあります。','Only the C batch ran on this host. The local measurement includes both NumPy layouts.')));
  }
  const memoryRows=batchKeys.map(k=>{
    const samples=backends[k].samples;
    const scratch=k==='native-batch'?0:median(samples.map(s=>s.numpyReusableScratchBytes));
    const layout=k==='native-batch'?0:median(samples.map(s=>s.numpyAdditionalLayoutBytes));
    return [names[k],kib(scratch),kib(layout),mbytes(backends[k].peakRssBytes.median)];
  });
  $('memory').replaceChildren(para(w('Cは入力行を順に読み、加算の前に32ビット値を64ビットに拡張します。下限・上限などの判定結果を6ビットにまとめて同じ走査で出力するため、中間配列を確保しません。','C reads each input row once, widens 32-bit amounts before adding, and packs the six checks into one output byte. It needs no intermediate array.')),
    table([w('一括実装','Batch implementation'),w('中間配列','Scratch arrays'),w('追加の配置コピー','Extra layout copy'),w('最大RSS¹','Peak RSS¹')],memoryRows),
    para(w('¹ 各プロセスの生涯最大RSSの中央値。ランタイム、入力、出力、ウォームアップを含みます。中間配列はそれらを除いたバイト数です。列配置へのコピーは時間測定の前に行います。','¹ Median process-lifetime peak RSS, including the runtime, inputs, outputs and warm-up. Scratch counts only the additional work arrays. The columnar conversion runs before timing.')));
}
function runOdoo(data,repeat,repeatUrl){
  const root=$('odoo');
  if(!data?.trials?.length){root.replaceChildren(para(w('この記録にはOdooへの書き込み測定がありません。','This record contains no Odoo posting measurement.')));return}
  const {trials,medians,parameters,runtime}=data;
  const arms=['python','native'],name=k=>k==='native'?w('C＋Python呼出し','C + Python call'):w('Python 規則','Python rules');
  const rows=arms.map(k=>[name(k),n(medians[k].guardP50Us,3)+' µs',n(medians[k].guardTotalMs,3)+' ms',n(medians[k].e2eP95Ms,3)+' ms']);
  const ack=trials.reduce((x,t)=>x+t.workload.acknowledged,0),failed=trials.reduce((x,t)=>x+t.workload.failed,0),legs=trials.reduce((x,t)=>x+t.integrity.exactLiveLegs,0);
  root.replaceChildren(para(w('Odoo '+runtime.odoo+'。開始時 '+n(parameters.rows)+' 分析明細、同時に '+n(parameters.writers)+' 人が入力。各実装 '+n(parameters.repeats)+' 試行の中央値です。','Odoo '+runtime.odoo+' started with '+n(parameters.rows)+' analytic lines and '+n(parameters.writers)+' concurrent writers. Each entry is the median of '+n(parameters.repeats)+' trials per implementation.')),
    table([w('判定実装','Guard'),w('判定のみ p50','Guard p50'),w('試行内の判定合計','Total guard time / trial'),w('到着予定から応答 p95','Scheduled arrival to ack p95')],rows),
    para(w('この '+n(trials.length)+' 試行で成功した書き込みは '+n(ack)+' 件、失敗は '+n(failed)+' 件。Odooで再読した '+n(legs)+' 件の新規明細を、金額・工数の符号や登録者まで照合しました。','Across '+n(trials.length)+' trials, '+n(ack)+' writes were acknowledged and '+n(failed)+' failed. All '+n(legs)+' new Odoo lines were read back and checked, including signed amounts, hours and creator.')),
    para(w('応答時間には送信待ち、RPC、Odoo、PostgreSQLでの処理が含まれます。同じ到着予定で方式の実行順を入れ替えました。','End-to-end latency includes queuing, RPC, Odoo and PostgreSQL. The arms used the same arrival schedule and alternated execution order.')));
  const verified=trials.filter(t=>t.guard.refusedProbe&&t.migration.failedCutover?.transaction==='rolled-back'&&t.integrity.oldTableRestored&&t.integrity.fullNativeHistoryAfter?.sha256===data.openingNativeHistory?.sha256).length;
  root.append(para(w(n(verified)+' / '+n(trials.length)+' 試行で残高不足を拒否し、意図的にデータをずらした切替を停止。切り戻し後の旧表と開始時履歴のハッシュを確認しました。',n(verified)+' / '+n(trials.length)+' trials refused the insufficient-balance probe, blocked the deliberately inconsistent cutover, restored the old table, and matched the opening history digest.')));
  const delta=medians.native.e2eP95Ms-medians.python.e2eP95Ms;
  if(delta>0&&medians.native.guardP50Us<medians.python.guardP50Us&&medians.native.guardTotalMs>medians.python.guardTotalMs){
    root.prepend(para(w('判定1件の中央値は短くなりましたが、試行内の判定時間の合計と利用者のp95はともに長くなりました。各方式 '+n(parameters.repeats)+' 回の観測だけでは、全体の遅延差の原因は特定できません。','The median individual check was faster. Total time spent in checks and end-to-end p95 both rose. '+n(parameters.repeats)+' trials per arm cannot establish the cause of the difference.')));
  }
  if(repeat?.status==='PASS'&&repeat.medians?.native&&repeat.medians?.python){
    const a=repeat.medians.python.e2eP95Ms,b=repeat.medians.native.e2eP95Ms;
    const opposite=Math.sign(b-a)!==0&&Math.sign(b-a)===-Math.sign(delta);
    const summary=para(w('別の公開CI実行では、利用者のp95は '+n(a,1)+' ms から '+n(b,1)+' ms でした。','In an independent public CI run, end-to-end p95 went from '+n(a,1)+' to '+n(b,1)+' ms.')
      +(opposite?w(' 2件の実測で変化の方向が逆になり、全体の応答時間に一貫した改善は見られませんでした。',' The direction reversed between runs, so the end-to-end response showed no consistent improvement.'):''));
    if(validRun(repeatUrl)){const link=node('a',w('実行記録 ↗','CI record ↗'));link.href=repeatUrl;summary.append(' ',link)}
    root.prepend(summary);
  }
  root.prepend(para(w('利用者のp95は '+n(medians.python.e2eP95Ms,1)+' ms から '+n(medians.native.e2eP95Ms,1)+' ms','End-to-end p95 went from '+n(medians.python.e2eP95Ms,1)+' to '+n(medians.native.e2eP95Ms,1)+' ms')
    +' ('+(delta>0?'+':'')+n(100*delta/medians.python.e2eP95Ms,1)+'%)','headline'));
  const d=node('details');d.append(node('summary',w('各試行の結果','Individual trials')),table([w('試行・実装','Trial / guard'),w('成功','Acknowledged'),w('失敗','Failed'),w('利用者のp95','End-to-end p95'),w('照合した明細','Odoo lines matched')],trials.map(t=>[n(t.repeat)+' · '+name(t.implementation),n(t.workload.acknowledged),n(t.workload.failed),n(t.workload.scheduledToAckMs.p95,3)+' ms',n(t.integrity.exactLiveLegs)])));root.append(d);
}
function runProof(checks,generated){
  const root=$('proof'),heading=[w('実行環境','Run'),w('比較した行','Rows compared'),w('違反の組合せ','Reason masks'),w('Lean生成関数で照合','Direct Lean scalar'),w('振替の結果を照合','Transfer results')];
  const rows=checks.filter(([,c])=>c?.status==='PASS').map(([id,c])=>[id,n(c.guardRows),n(c.allReasonMasks),c.directLeanScalarRows?n(c.directLeanScalarRows):w('未実施','Not run'),n(c.transferCases)]);
  root.replaceChildren(para(w('Leanでは、32ビット範囲の全入力について64ビットへの拡張が和を保ち、許可・拒否と全違反の順序が元の自然数仕様と一致することを証明しました。','Lean proves for every input in the 32-bit domain that widening preserves the sum and the word-level result preserves acceptance and the ordered list of all violations in the natural-number specification.')),
    para(w('手書きCは差分試験で照合しています。単行処理と一括処理を、元の規則、任意精度演算、コンパイルしたLeanと比較しました。Leanの証明が対象とするのは固定幅のLean定義までです。','Differential tests compare the hand-written C, in scalar and batch forms, against the original rules, arbitrary-precision arithmetic and compiled Lean. The C compiler and binary remain outside the scope of the Lean proof.')),
    table(heading,rows));
  if(generated?.textBytes!=null){
    const details=node('details');details.append(node('summary',w('Leanから生成した機械語を読む','Inspect the Lean-generated machine code')),
      para(generated.entrypoint+' · '+generated.architecture+' · '+n(generated.textBytes)+w(' バイトの命令列',' bytes of machine text')),
      para(w('符号なし32ビットの値を拡張してから加算し、比較結果から違反ビットを選ぶ命令です。','These instructions widen unsigned inputs before adding, compare the totals and select reason bits.')));
    if(Number.isFinite(generated.instructionCount)&&Array.isArray(generated.undefinedSymbols)){
      details.append(para(generated.toolchain+' · '+n(generated.instructionCount)+w(' 命令',' instructions')+' · '+n(generated.undefinedSymbols.length)+w(' 未解決シンボル',' undefined symbols')));
    }
    const assembly=Array.isArray(generated.assembly)?generated.assembly:[];
    const lines=[/\badd\b.*uxtw/i,/\bcmp\b/i,/\bcsel\b/i].map(re=>assembly.find(line=>typeof line==='string'&&re.test(line))).filter(Boolean);
    if(lines.length)details.append(node('pre',lines.join('\n')));
    if(generated.sha256)details.append(para('SHA-256 · '+generated.sha256,'source-note'));
    root.append(details);
  }
}
function localize(){
  document.documentElement.lang=lang;document.title='Knot · '+w(...copy.title);
  document.querySelectorAll('[data-key]').forEach(el=>el.textContent=w(...copy[el.dataset.key]));
  document.querySelectorAll('[data-lang]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.lang===lang)));
  $('back').href='../'+(lang==='en'?'?lang=en':'');$('brand').href='../../'+(lang==='en'?'?lang=en':'');
  $('notice').textContent=failed?w('実測記録を読み込めませんでした。','The measurement record could not be loaded.'):w('実測記録を読み込んでいます。','Loading the measurement record…');
}
const validRun=url=>typeof url==='string'&&/^https:\/\/github\.com\/BreamResearch\/lean-regen\/actions\/runs\/[0-9]+\/?$/.test(url);
function render(){
  localize();if(!record)return;
  const machines=[['micro',record.micro],['ciMicro',record.ciMicro]].filter(([,m])=>m?.backends?.['native-transfer']);
  if(!machines.length)throw Error('Missing measurements');
  if(!machines.some(([k])=>k===host))host=machines[0][0];
  $('host').replaceChildren(...machines.map(([k,m])=>{const o=node('option',(k==='micro'?w('ローカル','Local'):w('公開CI','Public CI'))+' · '+m.host.platform);o.value=k;return o}));$('host').value=host;
  runMicro(record[host]);runOdoo(record.odoo,record.odooRepeat,record.provenance?.repeatRunUrl);runProof([[w('ローカル','Local'),record.correctness],[w('公開CI','Public CI'),record.ciCorrectness]],record.generated);
  const url=record.provenance?.runUrl;
  const allowed=validRun(url);
  $('ci').hidden=!allowed;if(allowed)$('ci').href=url;
  $('notice').hidden=true;$('content').hidden=false;
}
document.querySelectorAll('[data-lang]').forEach(b=>b.addEventListener('click',()=>{lang=b.dataset.lang;const u=new URL(location.href);u.searchParams.set('lang',lang);history.replaceState(null,'',u);render()}));
$('host').addEventListener('change',()=>{host=$('host').value;render()});
localize();
try{const response=await fetch('./evidence.json',{credentials:'omit'});if(!response.ok)throw Error('Record unavailable');record=await response.json();render()}
catch{record=null;failed=true;localize();$('content').hidden=true;$('notice').hidden=false}
