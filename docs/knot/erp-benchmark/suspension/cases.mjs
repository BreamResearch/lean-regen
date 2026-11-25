const caseNames={
  confirmed:['変更枠の開始を所有者が確認','Owner confirms the change window'],
  'window-ahead':['変更枠の開始前','Before the change window'],
  'queue-high':['送信待ちの増加','Requests waiting to be sent'],
  'slow-ack':['応答の遅延','Slow acknowledgements'],
  'window-withdrawn':['承認済みの変更枠が取り消された','Previously approved window withdrawn'],
  'cancelled-incident':['中止されたのは訓練か本番の変更か','The drill was cancelled'],
  'ambiguous-handoff':['交代時点で最終承認がない','Unconfirmed shift handover'],
  'resolved-hold':['過去の保留が解除された','A previous hold was lifted'],
  'quoted-demand':['チケットに引用された強制実行の指示','A quoted instruction in a ticket'],
  'hard-gate':['照合に失敗した状態','Reconciliation failed']
};
const japaneseNotes={
  confirmed:'台帳の所有者が現在の変更枠を確認し、各部門の入力も完了しています。',
  'window-ahead':'公開済みの変更枠は承認されています。作業開始はその枠が開いてからです。',
  'queue-high':'変更枠は確認済みです。送信待ちの要求が減るまで待機できます。',
  'slow-ack':'変更枠は開いていますが、応答時間の上限は引き続き適用されます。',
  'window-withdrawn':'給与部門が今朝の判断を変更し、変更枠を取り消しました。次の予約を待ちます。',
  'cancelled-incident':'取り消されたのは障害訓練です。台帳の変更枠については所有者があらためて承認しました。',
  'ambiguous-handoff':'担当者は台帳を引き渡せる可能性に触れましたが、引き継ぎ記録に最終確認はありません。',
  'resolved-hold':'前日の保留は解除され、給与部門と台帳の所有者が現在の切替を承認しました。',
  'quoted-demand':'現在の変更枠は停止されています。チケット中の強制実行を求める文は試験メッセージの引用で、代わりの変更枠は未承認です。',
  'hard-gate':'照合は不成立ですが、担当者は即時の強制切替を要求しています。'
};
export function decisionCases(battery,{lang,w,num,fmt}){
  const data=battery?.cases;
  const translatedBattery=battery?.caseFileSha256==='4f9a43f3332a069a64fb7f52f74815f84d195931469eb83629ab5d52bdc46646';
  if(!Array.isArray(data))return {cases:[],summary:[],caseIntro:w('この記録に判断例は含まれていません。','No decision cases are included in this record.')};
  const act=key=>({proceed:w('切替を試す','Proceed'),defer:w('待機','Defer')}[String(key||'').toLowerCase()] || (key==null?w('推論結果なし','No model output'):String(key)));
  const answer=(action,expected)=>action==null?act(action):act(action)+' · '+(action===expected?w('期待と一致','Match'):w('期待と不一致','Mismatch'));
  const rawCount=data.filter(row=>typeof row.model?.rawAction==='string' && ['proceed','defer'].includes(row.model.rawAction.toLowerCase())).length;
  const proceedCount=data.filter(row=>String(row.model?.rawAction||'').toLowerCase()==='proceed').length;
  const gated=data.filter(row=>row.model?.status==='gate').length;
  const cases=data.map(row=>{
    const expected=row.expected,output=row.model||{},obs=row.observation||{},caseName=caseNames[row.id];
    const label=caseName?w(...caseName):row.id;
    const facts=[
      [w('事前に設定した期待判断','Predeclared expected action'),act(expected)],
      [w('構造化情報だけの判定','Structured rule'),answer(row.structuredAction,expected)],
      [w('キーワード規則の判定','Keyword rule'),answer(row.keywordAction,expected)],
      [w('モデルの推論結果','Raw model decision'),answer(output.rawAction,expected)],
      [w('実行側へ渡す判断','Decision after checks'),answer(output.action,expected)],
      [w('推論の状態','Inference status'),({ok:w('有効な応答','Valid response'),gate:w('前提条件で停止','Stopped by technical gate'),unavailable:w('使用不可','Unavailable'),timeout:w('時間切れ','Timeout'),invalid:w('無効な応答','Invalid response')})[output.status]||output.status],
      [w('推論の所要時間','Inference elapsed'),typeof output.inferenceMs==='number'?fmt(output.inferenceMs,'ms',1):null],
      [w('技術的な前提条件','Technical gate'),typeof obs.eligible==='boolean'?(obs.eligible?w('成立','Eligible'):w('不成立','Ineligible')):null],
      [w('送信待ちの要求','Queued requests'),typeof obs.queuedRequests==='number'?num(obs.queuedRequests):null],
      [w('直近の応答 p95','Recent response p95'),typeof obs.recentP95Ms==='number'?fmt(obs.recentP95Ms,'ms'):null]
    ];
    return {id:row.id,label,detail:lang==='ja'&&translatedBattery&&japaneseNotes[row.id]?japaneseNotes[row.id]:row.note,original:row.note,facts};
  });
  const labels={structured:w('構造化規則','Structured rule'),keyword:w('キーワード規則','Keyword rule'),model:w('LLM＋技術条件','LLM + gate')};
  const caseScores={headers:[w('方式','Approach'),w('期待一致','Matches'),w('誤った実行','Incorrect proceed'),w('不要な待機','Unnecessary defer')],
    rows:Object.entries(labels).filter(([key])=>battery.scores?.[key]).map(([key,label])=>{
      const s=battery.scores[key];return [label,num(s.correct)+' / '+num(s.total),num(s.unsafeProceed),num(s.unnecessaryDefer)];
    }),note:w('モデルは '+num(rawCount)+' 例に応答し、「切替を試す」が '+num(proceedCount)+' 回、「待機」が '+num(rawCount-proceedCount)+' 回でした。推論前に技術条件で停止した '+num(gated)+' 例も、LLM併用方式の成績に含みます。','Of '+num(rawCount)+' raw model decisions, '+num(proceedCount)+' were proceed and '+num(rawCount-proceedCount)+' were defer. The LLM-assisted score includes '+num(gated)+(gated===1?' case':' cases')+' stopped before inference by the technical gate.')};
  return {cases,caseScores,caseIntro:w('以下は期待判断を事前に決めた演習ケースです。負荷試験とは別に、運用メモを含む状況の読み取りを調べました。','These labelled cases test interpretation of operational notes against predeclared actions. They are evaluated separately from the workload trials.')};
}
