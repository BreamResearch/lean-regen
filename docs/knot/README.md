# Knot · 複数案件の予算と工数を振り替える / Reallocating a project portfolio

予算と工数の総計が合っていても、監査用の予算を使ったり、別の期間の残高を減らしたりすれば、取引は誤りです。Knot は架空の配分依頼を使い、どの配分案を選んだか、業務仕様がどの条件で受け入れるか、データベースに何が残るかを一件ずつ調べる Lean Regen の例です。

A transfer can balance perfectly while spending a protected allocation or debiting the wrong period. Knot follows a fictional portfolio request from a proposed allocation through its business rules to the entries recorded in the database. Inspecting the source, destination and ledger together makes those errors visible.

[デモを開く / Open the demo](https://breamresearch.github.io/lean-regen/knot/)

**最初の1件。** 「顧客移行の期限前倒し」を選び、「案を読み込み、検査する」を押します。「配分枠の検査結果を見る」で振替元と先を調べ、「配分を確定」で取引履歴の件数と仕訳を確認します。金額の単位は万円、工数の単位は時間です。

**First transaction.** Choose *Customer migration moves up*, load its proposal, inspect the affected pools and commit the allocation. Open the ledger to see the postings. Budget figures are in units of ¥10,000 and effort is in hours.

## 手元で確かめる / What to try

各ケースの数値は「デモをリセット」→「初期状態に戻す」で標準データに戻したときの値です。ケースを続けて操作すると、前の取引で変わった残高や優先度を引き継ぎます。Reset the standard dataset before each case to reproduce these figures. Within a case, keep the ledger open through the retry.

| 操作 / Scenario | どこを見るか / What to inspect |
| --- | --- |
| 複数の振替をまとめて確定する / Commit a batch of transfers | 振替元・先の予算と工数、台帳明細、全体の合計を見比べます。開発とQAを合わせて320万円・120時間、仕訳は4行です。Engineering and QA transfer 320 budget units and 120 h in total. Check both sides of the four signed ledger entries. |
| 共通する振替元を使い過ぎる / Overcommit a shared source | 空き370万円・160時間に対し、220万円・90時間を2件要求すると70万円・20時間足りません。2件目を140万円・60時間に直して再検査できます。Two requests for 220 and 90 h exceed the shared 370 and 160 h. Edit the second to 140 and 60 h to make the batch eligible. |
| 提案後に前提を変える / Change the state after preview | プレビュー時の版と現在の版、確定の可否、その後の残高を確認します。Compare the revision captured by the proposal with the current revision and inspect the balances after the attempt. |
| 書き込み途中で失敗させて再送する / Interrupt a write and retry | 失敗後に残った台帳件数と残高を記録し、同じ要求を再送してもう一度見ます。Inspect the ledger and balances after the interruption, after the retry and after repeating the successful request. |
| 締め済み期間に振り替える / Try a closed period | 数量に余裕がある場合にも、会計期間の状態が取引を左右します。Check the period and the outcome even when the accounts have enough to cover the transfer. |
| 依存先の準備完了を待つ / Unmet delivery dependency | 数量条件を満たしても、前提案件が準備中なら取引は拒否されます。The numerical checks pass here. Checking the prerequisite project blocks the transfer. |

## 何が動いているか / What runs where

- **提案 / Proposal.** 「収録したCodex提案」は架空の業務イベントに対する実際の応答です。「2案件が同じ枠を要求」では金額・工数を調整して再検査できます。A proposal marked *Recorded Codex proposal* replays a model response to a fictional event. In the shared-pool case, you can edit the amounts and recheck the batch. The public demo is free to use without an account or live model call.
- **業務仕様 / Contract.** Lean 4.19.0 で、会計期間・振替ロック・上下限を含む配分枠の条件と、一括振替前後の予算・工数の保存を検査します。ブラウザーでは Lean が出力した方針を JavaScript が評価します。Lean checks the per-account numerical rules and the batch conservation properties at build time. The browser interprets the exported policy for the request at hand.
- **取引 / Transaction.** ブラウザー内の SQLite が会計期間、原価センター、開発・QAの職能、配分枠、確約済みの予算・工数、依存関係、台帳を扱います。複数行の読み取り、集約、更新、ロールバックは統合テストで確かめます。「台帳を開き直す」はその場で SQLite の内容を書き出して読み直します。ページを再読み込みすると初期状態に戻ります。SQLite runs in the browser through sql.js. Integration tests exercise the joins, grouping, writes and rollback. Reopening the ledger serializes and reopens the database inside the tab. Reloading the page starts a fresh database.

## 規模を変えて試す / Try the larger ledger

「大規模」を選ぶと、2,004案件、3会計期間、4原価センター、12,012配分枠、24,008確約明細、6,000件の依存関係を使えます。「8案件の一括振替」は、8つの振替先に開発とQAの予算・工数を同時配分する規模検査用の固定案です。16明細を確定すると計560万円・240時間の移動が32行の仕訳になり、他の配分枠は元のままです。

The large dataset has 2,004 projects, three fiscal periods, four cost centres, 12,012 allocation pools, 24,008 commitments and 6,000 dependency records. Its scripted eight-recipient batch posts 16 transfers, totalling ¥5.6 million and 240 hours, as 32 signed ledger entries. The integration check reads every pool back, including the untouched ones. The demo uses one tab with one transaction writer.

## 検査を再実行する / Reproduce the checks

公開リポジトリの `docs/knot` ディレクトリで実行します。Node.js 24は検査用のネイティブSQLiteを内蔵しています。アプリには同梱のsql.jsを使い、書き出したデータベースを別のSQLiteで開いて12表の内容を照合します。

Run these commands from `docs/knot` in a checkout of the public repository. Node.js 24 includes an independent SQLite reader. The check drives the app’s sql.js build, opens the exported database with native SQLite, and compares signed postings, balances, revisions and all twelve tables across failures and retries.

```sh
node check.mjs
```

公式の Lean/Lake 4.19.0 と Python 3.9以上を用意すると、証明を再検査し、実際のSQL行から組み立てた入力をネイティブのLean実行ファイルにも渡せます。`new-proof.json` と `new-integration.json` には新しいファイル名を使います。Apple SiliconのmacOS 27用リンカー設定は検査手順にあります。[検査手順 / Native build instructions](formal/README.md)

With the official Lean/Lake 4.19.0 toolchain on your path and Python 3.9+, recheck the fixed proof obligations and compile the native decision function. The last command independently reconstructs the model inputs from the exported database and compares the native outcomes with the app’s decisions and actual committed balances.

```sh
python3 formal/verify.py --tool-bin "$(lean --print-prefix)/bin" --out new-proof.json
(cd formal && lake build knotCheck)
node check.mjs --native formal/.lake/build/bin/knotCheck --out new-integration.json
```

実測では8ケース・延べ52配分枠をネイティブLeanと照合しました。「依存ゲートの未完了」では数量モデルが受理し、アプリが依存テーブルの追加条件で拒否します。The recorded native comparison covers eight batches and 52 participating pool rows. In the unmet-dependency case, the numerical model accepts and the application rejects on its separate relational rule. [証明・固定条件 / Proof record](formal/evidence.json) · [SQLite・Lean照合結果 / Integration results](integration.json)

自分の業務に当てはめるなら、一つの期間・部門から始め、代表的な取引について、元の行、判断、その後の行、台帳明細を突き合わせてください。特に、受理されるべき取引を含めると、合計値が保たれていても正当な依頼が取りこぼされる不具合を見つけられます。

For an existing system, start with one fiscal period and one cost centre. Compare its before-state, decision, committed rows and journal for a representative request. Include one request that **must succeed**. A database that declines every transfer can still preserve its totals.
