export function present(input,{words:w,number,ms,seconds,yesNo}) {
  const reports=Array.isArray(input.runs)?input.runs:[input];
  const elapsed=value=>typeof value==='number' && value>=50 ?
    (value/1000).toFixed(3)+' s' : ms(value);
  const title={
    legacy:w('移行前の書き込み','Writes before migration'),expand:w('新形式と並行書き込みを追加','Enable dual writes'),
    earlyCutover:w('未転記の状態で切替を試行','Attempt cutover before backfill'),backfill:w('既存行を分割転記','Backfill earlier rows'),
    failedCutover:w('1単位の不一致で切替を拒否','Refuse a one-unit discrepancy'),cutover:w('新版に切り替え、旧表を削除','Cut over and remove the old table'),
    normalized:w('新版で書き込みを継続','Continue on the new layout'),rollback:w('新版から旧表を復元','Rebuild the old table from the new layout'),
    restored:w('切り戻した台帳で書き込み','Continue on the restored ledger'),dual:w('新旧の両方に書き込み','Write to both projections'),
    refusalAudit:w('拒否後の照合','Reconcile after refusal'),cutoverAudit:w('切替後の照合','Reconcile after cutover'),rollbackAudit:w('切り戻し後の照合','Reconcile after rollback'),
    initial:w('開始時','At start'),afterRefusal:w('拒否後','After refusal'),
    afterCutover:w('切替後','After cutover'),afterRollback:w('切り戻し後','After rollback'),final:w('終了時','At end')
  };
  const detail={
    legacy:w('旧表を読む状態で、各クライアントからOdooに2行一組の振替を送ります。','With reads on the old table, each client posts two balancing Odoo analytic lines per transfer.'),
    dual:w('既存行の転記後も、書き手はOdooへ振替を送り続けます。','After historical backfill completes, clients continue sending transfers through Odoo.'),
    expand:w('旧形式の書き込みを維持したまま、予算と工数を個別の行に格納する新形式を追加します。','Add a representation with a separate row for each budget and hours amount while the old layout continues serving requests.'),
    earlyCutover:w('未転記の行がある状態で、業務レコードとの照合を通せるかを試します。','Check whether cutover is permitted while older rows are still missing from the new projection.'),
    backfill:w('既存の分析明細を、小さなトランザクションに分けて新版へ転記します。','Copy existing analytic lines to the new layout in separately committed chunks.'),
    failedCutover:w('同じトランザクション内で新形式の予算を1単位だけずらし、実際の切替条件で検出できるかを試します。','Introduce a one-unit budget discrepancy inside the switch transaction and exercise the actual reconciliation gate.'),
    cutover:w('Odooの分析明細と新旧表を照合し、Knotの読取先を新版へ切り替えます。','Reconcile the old and new projections against the ERP records, then switch the ledger read by Knot.'),
    normalized:w('旧表の削除後も、Odooの業務操作を書き込みます。','Post additional Odoo operations after the old projection table has been removed.'),
    rollback:w('移行後に追加された分析明細も含めて旧表を再構築し、読み取りを戻します。','Rebuild the old table from the current data, including entries created since cutover, and move reads back.'),
    restored:w('復元した台帳で追加書き込みを行い、履歴の件数・内容を照合します。','Exercise further writes on the restored ledger and reconcile its historical row count and content.')
  };
  function text(value) {
    if(value===null||value===undefined) return null;
    if(typeof value==='boolean') return yesNo(value);
    if(typeof value==='number') return number(value);
    if(typeof value==='string') return value;
    return null;
  }
  const sum=(values)=>values.filter(v=>typeof v==='number').reduce((a,b)=>a+b,0);
  const named=(key)=>title[key]||key.replace(/([a-z])([A-Z])/g,'$1 $2');
  function hashFact(key,value) {return value?.sha256 ? [key,value.sha256] : [key,null];}
  function forRun(r,index){
    const workload=r.load, migration=r.migration, checks=r.checks, history=r.history;
    if(!workload?.phases||!migration?.cutover||!checks?.final||!history) throw new TypeError('Incomplete benchmark');
    const phaseMap=workload.phases;
    const order=['legacy','expand','earlyCutover','backfill','dual','failedCutover','refusalAudit','cutover','cutoverAudit','normalized','rollback','rollbackAudit','restored'];
    const phaseList=[...new Set([...order,...Object.keys(phaseMap),...Object.keys(migration)])].filter(key=>phaseMap[key]||migration[key]);
    const events=phaseList.map(key=>{
      const command=migration[key]||{}, load=phaseMap[key]||{}, latency=load.latencyMs||{};
      const facts=[
        [w('取引の結果','Transaction'),command.transaction==='committed'?w('確定','Committed'):command.transaction==='rolled-back'?w('ロールバック','Rolled back'):text(command.transaction)],
        [w('切替操作の経過','Operation elapsed'),ms(command.totalMs)],
        [w('ゲートを待った時間','Wait to acquire gate'),ms(command.gateAcquisitionMs)],
        [w('ゲート取得から確定・中止まで','Gate acquisition to commit or abort'),ms(command.gateHeldThroughCommitOrRollbackMs)],
        [w('処理中に完了した応答','Completed responses in phase'),text(load.completedResponses)],
        [w('応答を完了した書き手','Writers with completed responses'),text(load.distinctWriters)],
        [w('同時に応答を待ったERP要求の最大数','Peak overlapping ERP requests'),text(load.peakInFlightErpRequests)],
        [w('書き込み処理率','Write responses / s'),text(load.requestsPerSecond)],
        [w('台帳の読取応答','Projection reads completed'),text(load.projectionReadResponses)],
        [w('応答時間 p95','Response latency p95'),ms(latency.p95)],
        [w('旧表の不一致','Old-layout differences'),text(command.legacyDifferences)],
        [w('新表の不一致','New-layout differences'),text(command.newDifferences)],
        [w('新形式追加時の旧表行数','Old rows at expansion'),text(command.legacyRowsAtExpansion)],
        [w('転記対象の最終ID','Backfill upper ID'),text(command.backfillHighId)],
        [w('転記行数','Rows copied'),text(command.rowsCopied)],
        [w('確定した分割数','Committed chunks'),text(command.committedChunks)],
        [w('最長の転記処理','Longest chunk'),ms(command.longestChunkMs)],
        [w('復元された旧表の行数','Rows rebuilt in old table'),text(command.rebuiltLegacyRows)],
        [w('負荷計測区間','Load measurement interval'),ms(load.durationMs)],
        [w('最大応答間隔','Maximum response gap'),ms(load.maxResponseGapMs)]
      ].filter(([,v])=>v!=null);
      const checkpoint=checks[({refusalAudit:'afterRefusal',cutoverAudit:'afterCutover',rollbackAudit:'afterRollback',failedCutover:'afterRefusal',cutover:'afterCutover',rollback:'afterRollback'})[key]];
      if(checkpoint) facts.push([w('事後照合で旧表が存在','Old table present at follow-up audit'),yesNo(checkpoint.widePhysicalTable)],
        [w('事後照合時のERP行数','ERP rows at follow-up'),number(checkpoint.erpRows)],[w('振替ペアの不一致','Unbalanced transfer pairs'),number(checkpoint.unbalancedRequestPairs)]);
      return {key,title:named(key),detail:detail[key],duration:elapsed(command.totalMs),facts,refusal:command.transaction==='rolled-back'};
    });
    const data=phaseList.filter(key=>phaseMap[key]).map(key=>[key,phaseMap[key]]);
    const latencyRows=data.map(([phase,s])=>[named(phase),number(s.completedResponses),
      number(s.latencyMs?.p50),number(s.latencyMs?.p95),number(s.latencyMs?.p99),number(s.latencyMs?.max),number(s.maxResponseGapMs)]);
    const auditRows=Object.entries(checks).filter(([,c])=>c&&c.erpHistory&&c.activeHistory).map(([key,c])=>{
      const diffs=Object.values(c.projectionDifferences||{});
      const same=c.erpHistory.sha256===history.sha256&&c.activeHistory.sha256===history.sha256&&c.erpHistory.rows===history.rows&&c.activeHistory.rows===history.rows;
      const mode={legacy:w('旧形式','Legacy'),dual:w('新旧併存','Dual'),normalized:w('新版','Normalized')}[c.mode]||text(c.mode);
      return [named(key),mode,number(c.erpRows),yesNo(c.widePhysicalTable),same?w('一致','Match'):w('不一致','Mismatch'),diffs.length?number(sum(diffs)):'—',number(c.unbalancedRequestPairs)];
    });
    const metrics=[
      {title:w('切替の経過時間','Cutover elapsed'),value:elapsed(migration.cutover.totalMs),note:w('切替処理の開始から確定まで','Switch request to transaction commit')},
      {title:w('切り戻しの経過時間','Rollback elapsed'),value:elapsed(migration.rollback?.totalMs),note:w('旧表の再構築と読取先の復帰','Rebuild old table and restore reads')},
      {title:w('同時に動かした書き手','Concurrent writers'),value:number(workload.writers),note:w('収録した負荷試験','Measured client workload')},
      {title:w('開始時の履歴','Opening history'),value:number(history.rows),note:w('照合に使用した分析明細','Historical analytic lines reconciled')},
      {title:w('完了した振替','Acknowledged transfers'),value:number(workload.successfulRequests),note:w('1件につき分析明細2行','Two analytic lines per transfer')}
    ];
    const audit=[{columns:[w('確認時点','Checkpoint'),w('読取形式','Read mode'),w('ERP行数','ERP rows'),w('旧表が存在','Old table present'),w('開始時履歴','Opening history'),w('差分件数合計','Projection differences'),w('振替ペアの不一致','Unbalanced pairs')],rows:auditRows},
      {title:w('台帳で使う列のSHA-256','SHA-256 of the projected business fields'),facts:[hashFact(w('開始時の履歴','Opening history SHA-256'),history),hashFact(w('終了時にERPで読み返した履歴','Final ERP historical digest'),checks.final.erpHistory),hashFact(w('終了時にKnotで読み返した履歴','Final Knot historical digest'),checks.final.activeHistory)]}];
    if(r.fullNativeHistory?.before && r.fullNativeHistory?.after) audit.push({title:w('Odoo全列と新規書き込みの照合','Full native rows and new writes'),facts:[
      hashFact(w('開始時のOdoo原本全列','Opening full native row digest'),r.fullNativeHistory.before),hashFact(w('終了時のOdoo原本全列','Final full native row digest'),r.fullNativeHistory.after),
      [w('Odooで実在を確認した書き込みID','Acknowledged Odoo line IDs reconciled'),text(workload.acknowledgedNativeLineIdsMatched)],
      [w('予算・工数の符号と値、作成者を照合した行','Rows matched on signed amounts, hours and creator'),text(workload.nativeSignedLegsAndCreatorsMatched)]]});
    const all=workload.overall||{};
    const load=[{facts:[
      [w('計測時間','Run elapsed'),ms(all.durationMs)],[w('平均書き込み応答 / 秒','Mean write responses / s'),text(all.requestsPerSecond)],
      [w('同時に応答を待ったERP要求の最大数','Peak overlapping ERP requests'),text(all.peakInFlightErpRequests)],
      [w('クライアントエラー','Client errors'),text(workload.failedRequests)],[w('書き込み応答 p95','Write response p95'),ms(all.latencyMs?.p95)],
      [w('最大応答間隔（全体）','Longest response gap overall'),ms(all.maxResponseGapMs)],
      [w('台帳読み取り p95','Projection read p95'),ms(workload.projectionReadLatencyMs?.p95)]]},
      {title:w('定常書き込みの応答時間 p95','Steady-write latency · p95'),chart:['legacy','dual','normalized','restored'].filter(key=>typeof phaseMap[key]?.latencyMs?.p95==='number').map(key=>({label:named(key),value:phaseMap[key].latencyMs.p95}))},
      {disclosure:w('全工程の応答時間と最大間隔','All phase latencies and response gaps'),columns:[w('工程','Phase'),w('応答件数','Responses'),'p50','p95','p99',w('最大','Max'),w('最大間隔','Max gap')],rows:latencyRows,
      note:w('単位はミリ秒。応答件数はその工程で完了した書き込みです。最大間隔は、工程の開始・終了を含めて成功応答が途切れた最長時間です。','Times are in milliseconds. Responses are assigned to the phase in which they completed. Max gap is the longest interval without a successful response, including the phase boundaries.')}];
    const rt=r.runtime||{}, param=r.parameters||{}, generator=rt.loadGenerator||{}, host=rt.images||{};
    const setup={facts:[
      [w('計測開始 UTC','Started (UTC)'),text(r.startedUtc)],['Odoo Community',text(rt.odoo)],['PostgreSQL',text(rt.postgresql)],['Python',text(rt.python)],['psycopg2',text(rt.driver)],
      [w('ERPの実行環境','ERP runtime'),text(host.guest||host.mode)],[w('ERPゲストのvCPU','ERP guest vCPUs'),text(host.guestVcpus)],
      [w('ERPゲストのメモリ','ERP guest RAM'),typeof host.guestMemoryMiB==='number'?number(host.guestMemoryMiB)+' MiB':null],
      [w('Dockerホストのアーキテクチャ','Docker host architecture'),text(host.dockerHost?.architecture)],
      [w('DockerホストのCPU','Docker host CPUs'),text(host.dockerHost?.cpus)],
      [w('Dockerホストのメモリ','Docker host RAM'),typeof host.dockerHost?.memoryBytes==='number'?number(host.dockerHost.memoryBytes/(1024**3))+' GiB':null],
      [w('Odoo HTTPモード','Odoo HTTP mode'),text(host.httpMode)],[w('Odooワーカープロセス','Odoo worker processes'),text(host.odooWorkers)],
      [w('Odoo定期処理スレッド','Odoo cron threads'),text(host.odooCronThreads)],
      [w('履歴データの投入','Seed elapsed'),ms(r.seed?.elapsedMs)],[w('転記1回の最大行数','Backfill chunk size'),text(param.chunk)],
      [w('定常負荷工程の最短時間','Minimum sustained phase'),seconds(param.minimumSteadyPhaseSeconds)],
      [w('負荷生成機のOS・アーキテクチャ','Load generator OS and architecture'),[generator.os,generator.architecture].filter(Boolean).join(' · ')||null],
      [w('負荷生成機から見える論理CPU','Logical CPUs visible to load generator'),text(generator.logicalCpuCountVisible)],
      [w('負荷生成機から見える物理メモリ','Physical RAM visible to load generator'),typeof generator.physicalMemoryBytesVisible==='number'?number(generator.physicalMemoryBytesVisible/(1024**3))+' GiB':null],
      [w('入力と出力','Input and read model'),w('Odooの分析明細 → Knotの予算・工数台帳','Odoo analytic lines → Knot budget and hours ledger')]],
      note:w('OdooとPostgreSQLを各1台とし、書き手ごとに別の分析勘定ペアへ生成データを投入しました。移行対象はKnotの読取用テーブルです。Odoo本体の更新や同じ勘定への集中負荷は別途測定が必要です。','One Odoo instance and one PostgreSQL instance served generated transfers on a separate pair of analytic accounts per writer. The migration changed Knot’s read model. An Odoo core upgrade or a workload concentrated on the same accounts requires a separate measurement.')};
    const profile=r.profile==='100k-plus'?w('本計測','Full workload'):r.profile==='smoke'?w('動作確認','Smoke run'):(typeof r.profile==='string'?r.profile:w('実測 ','Run ')+number(index+1));
    const environment=r.provenance?.runUrl?'GitHub Actions':host.mode==='native-packages'?w('ローカル','Local'):host.mode==='official-docker'?'Docker':'';
    const platform=/Ubuntu/.test(host.guest||'')?'Ubuntu':generator.os;
    const name=[profile,environment,[platform,generator.architecture].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const summary=migration.failedCutover?.newDifferences===1&&r.status==='PASS'?
      w('予算の1単位のずれを検出して切替を拒否しました。照合後の切替と、その後に追加された分析明細を含む切り戻しが完了しています。','A one-unit discrepancy blocked the switch. Reconciliation then allowed cutover, followed by rollback with the later writes intact.'):null;
    return {name,product:['Odoo Community',text(rt.odoo)].filter(Boolean).join(' · '),runUrl:r.provenance?.runUrl,note:w('ブラウザーでは保存した結果を再生します。再現手順で実験を実行できます。','This browser replays the saved results. Use the reproduction guide to run the experiment.'),summary,metrics,events,load,audit,setup};
  }
  const runs=reports.map(forRun);
  return {runs};
}
