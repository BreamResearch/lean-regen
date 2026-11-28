const copy = {
  ja: {
    title:'Odoo連携台帳の切替実測', back:'← 台帳の運用検証', intro:'Odooで分析明細を作成しながら、Knotが参照する台帳を新しい保存形式に切り替えました。移行時の応答時間と、切り戻し後の履歴を実測記録で確認できます。',
    ciRun:'公開CIの実行記録 ↗', suspension:'移行の3方式を比較 ↗', nativePolicy:'振替判定の機械語版 ↗', guide:'再現手順 ↗', raw:'実測値のJSON ↗', scenario:'実行を選ぶ', summary:'測定結果', trace:'切替の記録', selectStep:'記録を選ぶ',
    previous:'前の記録', next:'次の記録', load:'負荷と応答', audit:'切替後の照合', setup:'測定条件', loading:'実測記録を読み込んでいます。', unavailable:'実測記録を読み込めませんでした。実測値のJSONを直接開けます。',
    pass:'合格', fail:'不一致', blocked:'拒否', rollback:'切り戻し', completed:'完了', stage:'工程', measure:'測定値', at:'経過時間', writers:'書き手', records:'業務レコード',
    count:'件数', seconds:'秒', writes:'書き込み', requests:'リクエスト', samples:'標本数', latency:'応答時間', rate:'処理率', elapsed:'経過時間', errors:'失敗', max:'最大', total:'合計',
    workload:'負荷試験', history:'履歴照合', result:'結果', checks:'照合項目', before:'移行前', after:'移行後', baseline:'基準', version:'バージョン',
    unavailableMetric:'未計測', replayOnly:'この画面は保存した実測記録を再生します。', rawFields:'実測記録の項目を見る'
  },
  en: {
    title:'An Odoo ledger cutover under load', back:'← Ledger operations', intro:'Odoo kept receiving analytic lines while the ledger read by Knot switched storage layouts. Replay the measurements and inspect the history restored after rollback.',
    ciRun:'Public CI run ↗', suspension:'Compare migration strategies ↗', nativePolicy:'Native transfer guard ↗', guide:'Reproduce the run ↗', raw:'Evidence JSON ↗', scenario:'Recorded run', summary:'Measured results', trace:'Cutover trace', selectStep:'Select a checkpoint',
    previous:'Previous checkpoint', next:'Next checkpoint', load:'Load and response', audit:'Post-cutover reconciliation', setup:'Test conditions', loading:'Loading the recorded run…', unavailable:'The run record could not be loaded. You can open the evidence JSON directly.',
    pass:'Passed', fail:'Mismatch', blocked:'Refused', rollback:'Rolled back', completed:'Completed', stage:'Phase', measure:'Value', at:'Elapsed', writers:'Writers', records:'Business records',
    count:'Count', seconds:'seconds', writes:'Writes', requests:'Requests', samples:'Samples', latency:'Latency', rate:'Throughput', elapsed:'Elapsed', errors:'Failed', max:'Max', total:'Total',
    workload:'Load test', history:'History check', result:'Outcome', checks:'Reconciliation checks', before:'Before', after:'After', baseline:'Baseline', version:'Version',
    unavailableMetric:'Not measured', replayOnly:'This page replays the saved measurements.', rawFields:'Inspect the recorded fields'
  }
};
export const label=(lang,key)=>copy[lang]?.[key]??key;
