export const projects = [
  ['atlas','顧客移行基盤','Customer migration',1,'active'],
  ['orbit','社内分析基盤','Internal analytics',0,'planned'],
  ['shield','規制対応','Regulatory readiness',1,'ready'],
  ['pulse','契約更新基盤','Contract renewals',0,'active'],
];

export const events = [
  {id:'deadline',action:'normal',title:{ja:'顧客移行の期限前倒し',en:'Customer migration moves up'},
   detail:{ja:'移行が3週間前倒し。開発と品質保証の配分枠を別々に調達し、案件を最優先にする。',en:'The migration moved up three weeks. Find engineering and QA capacity and promote the project.'}},
  {id:'shared-pool',action:'normal',title:{ja:'2案件が同じ枠を要求',en:'Two projects request the same pool'},
   detail:{ja:'各明細だけを見ると移せる。同じ振替元の確約済み予算と工数を考慮して、バッチ全体を検査する。',en:'Each line looks affordable alone. Check both against commitments in their shared source pool.'}},
  {id:'stale',action:'drift',title:{ja:'生成後に新しい発注が到着',en:'A new commitment arrives after planning'},
   detail:{ja:'提案を受け取った後、別の担当が発注を確定。新しい台帳に古い配分案を確定できるか試す。',en:'Another operator books a purchase after the plan is prepared. Try applying the plan to the newer ledger.'}},
  {id:'rollback',action:'fault',title:{ja:'仕訳の途中で停止',en:'Failure midway through posting'},
   detail:{ja:'最初の仕訳と残高更新の直後に障害を発生させ、巻き戻し・再試行・重複防止を確認する。',en:'Inject a failure after the first posting and balance update. Inspect rollback, retry, and duplicate protection.'}},
  {id:'closed-period',action:'normal',title:{ja:'締め済みの会計期間',en:'A closed fiscal period'},
   detail:{ja:'残枠がある過去月からの振替を試す。金額と工数が足りても、締め済み期間は変更できない。',en:'Try moving an available balance in a closed month. A closed period cannot be adjusted even when capacity remains.'}},
  {id:'dependency',action:'normal',title:{ja:'依存ゲートの未完了',en:'Unmet delivery dependency'},
   detail:{ja:'資源は足りているが、切替前の契約案件が出荷条件を満たしていない。依存テーブルを照合する。',en:'The balance is sufficient, but a prerequisite project has not reached its release gate.'}},
  {id:'portfolio-wave',action:'normal',scaled:true,title:{ja:'8案件の一括振替',en:'Post a wave across eight projects'},
   detail:{ja:'追加データの8案件に、開発・品質保証の計16明細をまとめて割り当てる。依存関係と確約枠を照合し、32行の仕訳を確定する。',en:'Allocate engineering and QA across eight projects in one 16-line batch. Check dependencies and commitments, then post 32 ledger rows.'}},
];

export const backgroundId = number => 'work-' + String(number).padStart(5,'0');

export function wavePlan() {
  const lines = [];
  for (let target = 2; target <= 16; target += 2) {
    for (const skill of ['ENG','QA']) {
      lines.push({from:backgroundId(target-1)+'-01-'+skill,to:backgroundId(target)+'-01-'+skill,budget:35,hours:15});
    }
  }
  return {project:backgroundId(2),priority:2,mode:'scripted',lines,reason:{
    ja:'8案件の開発・品質保証を同じ会計期間にそろえる固定の負荷試験。各受入案件に依存先があり、各供出枠には既存の確約がある。',
    en:'This scripted load exercise aligns engineering and QA across eight projects. Each recipient has a prerequisite, and every source pool has existing commitments.',
  }};
}

export const basePools = [
  // ID, project, period, center, skill, budget, hours, minimums, ceilings, locked
  ['01-DATA-ENG','orbit','01','DATA','ENG',1000,420,360,100,1500,600,0],
  ['01-DATA-QA','orbit','01','DATA','QA',600,220,200,70,900,400,0],
  ['01-PLAT-ENG','atlas','01','PLAT','ENG',440,180,80,40,850,400,0],
  ['01-PLAT-QA','atlas','01','PLAT','QA',260,110,80,20,650,300,0],
  ['01-OPS-ENG','pulse','01','OPS','ENG',350,130,120,50,850,400,0],
  ['01-OPS-QA','pulse','01','OPS','QA',160,75,30,10,550,300,0],
  ['01-RISK-ENG','shield','01','RISK','ENG',700,230,250,90,1050,450,1],
  ['01-RISK-QA','shield','01','RISK','QA',320,110,160,60,550,260,0],
  ['02-DATA-ENG','orbit','02','DATA','ENG',950,410,210,80,1600,600,0],
  ['02-PLAT-ENG','atlas','02','PLAT','ENG',480,190,110,60,900,400,0],
  ['00-DATA-ENG','orbit','00','DATA','ENG',900,380,200,80,1500,600,0],
  ['00-PLAT-ENG','atlas','00','PLAT','ENG',400,150,90,40,850,400,0],
];

export const baselineCommitments = [
  ['purchase-45','01-DATA-ENG',400,170,'approved'],
  ['allocation-19','01-DATA-ENG',230,90,'approved'],
  ['canceled-01','01-DATA-ENG',200,80,'canceled'],
  ['purchase-46','01-DATA-QA',410,110,'approved'],
  ['atlas-contract','01-PLAT-ENG',210,90,'approved'],
  ['pulse-contract','01-OPS-ENG',155,60,'approved'],
  ['audit-contract','01-RISK-ENG',410,150,'approved'],
  ['past-contract','00-DATA-ENG',350,120,'approved'],
];

export const dependencies = [['atlas','shield','01'],['pulse','shield','01'],['shield','pulse','01']];
