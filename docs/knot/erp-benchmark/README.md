# Knot × Odoo Community · 書き込み中の台帳移行 / Ledger migration under live ERP writes

Odoo Community 18 の分析会計に、Knot が予算・工数の振替を送ります。複数のクライアントが Odoo の API を使って書き込んでいる間に、Knot が参照する台帳の形式を切り替えます。照合に失敗した切替と、切替後の書き込みを残したまま旧形式へ戻る手順も対象です。

Knot sends paired budget and effort reallocations to Odoo Community 18 analytic accounting. While separate clients keep posting through the ERP API, the exercise switches the ledger representation used by Knot. It tests a rejected cutover and a return to the former representation after new writes have committed.

[実測デモ](https://breamresearch.github.io/lean-regen/knot/erp-benchmark/) · [English demo](https://breamresearch.github.io/lean-regen/knot/erp-benchmark/?lang=en) · [実測データ / Recorded measurements](evidence.json)

## 実測結果 / Measured results

両環境で Odoo Community 18.0-20261112 を起動しました。Odoo の ORM で分析明細を10万行作成し、8人の試験ユーザーが API で予算・工数の振替を送信しました。各振替は分析明細2行を同じ Odoo トランザクションで確定します。Both runs seeded 100,000 Odoo analytic lines and reached eight overlapping authenticated API requests. Each transfer commits two native analytic lines in one Odoo transaction. [GitHub Actions run](https://github.com/BreamResearch/lean-regen/actions/runs/45523419930)

| 測定項目 / Metric | GitHub Actions x86‑64 · PostgreSQL 16.16 | Ubuntu ARM64 · PostgreSQL 16.15 |
| --- | ---: | ---: |
| 旧形式で確定した明細の転記 / Backfill while writes continued | 100,768行 · 3.487 s | 100,362行 · 3.549 s |
| 照合失敗からトランザクション取消まで / Rejected cutover | 0.261 s | 0.396 s |
| 本切替の所要時間 / Successful cutover | **0.509 s** | **0.733 s** |
| 本切替のうち排他ゲートの取得待ち / Cutover wait for the exclusive gate | 0.660 ms | 21.731 ms |
| 旧形式の再構築と切り戻し / Rebuild and restore the old layout | **0.845 s** | **0.887 s** |
| 負荷中の振替成功 / 失敗 · Successful / failed workload transfers | 2,690 / 0 | 1,456 / 0 |
| Odoo 書き込み応答の p95 / Odoo write response p95 | 0.107 s | 0.273 s |
| 成功応答の最大間隔 / Longest gap between successful responses | 1.789 s | 1.226 s |
| 最終明細の差分 / Final reconciliation differences | 0 · 105,380行を照合 | 0 · 102,912行を照合 |

両方の実行で、金額を1単位ずらした切替を拒否し、旧形式から読み続けました。その後、正常に切り替えて旧表を削除しました。新形式の定常負荷区間だけでも584件と289件の振替が確定しました。切り戻しで旧表を作り直した後、Odoo 原本と読み取り結果に差分がないこと、元の10万行の全列ハッシュが変わらないこと、追加した明細の金額・工数・勘定・作成者が送信内容と一致することを確認しました。

Both runs rejected a one-unit discrepancy and kept serving the former layout. A subsequent successful cutover removed the old table. The two steady windows on the new layout accepted another 584 and 289 transfers respectively. After rebuilding the former table, both runs compared every test row with Odoo, checked the full-row digest of the 100,000 original lines and matched the new entries to the amounts, hours, accounts and users that submitted them. [Measurement source and digests](evidence.json)

## 測るもの / What is measured

- **切替 / Cutover.** 排他ゲートを取りに行ってから処理が終わるまでと、ゲート取得後の処理を分けて計測します。過去データの事前転記は別に計測します。The switch time includes lock acquisition and the transition transaction. Copying historical rows runs separately.
- **運用中の書き込み / Writes under load.** Odoo API の実際の要求について、成功数・失敗数、応答時間と確定応答の間隔を測ります。The client timings measure the API request path on the test machine. Completion gaps describe this set of callers.
- **失敗と復帰 / Failure and recovery.** 転記前の切替に加え、新形式の金額を試験的に1単位ずらした切替を拒否します。照合に合格した切替では旧表を削除し、旧形式へ戻すときに新表から再構築して、その間に確定した取引まで Odoo の原本と比較します。The gate blocks an early switch and a switch with a one-unit discrepancy. A successful cutover removes the old table. Rollback rebuilds it from the new representation and reconciles it with Odoo, including later writes.

この実験で測るのは、Knot が使う台帳の形式変更です。Odoo の標準明細は正本として残り、Odoo 自体のバージョンアップや標準スキーマの移行は別の作業です。負荷は同一環境の架空データによるもので、件数や応答時間は利用するコンピューターと処理内容に依存します。

The migration changes Knot's ledger representation. Standard Odoo entries remain the source of truth. An Odoo upgrade, production workload traces, remote-network latency and the organisation's cutover target require separate measurement.

書き手ごとに担当する勘定の組は異なり、同じ Odoo テーブルと切替ゲートを共有します。この実験で使う固定の [Knot 業務規則](../formal/policy.json) は、Odoo API を呼ぶ前に振替の両側に適用します。移行時は PostgreSQL 上で明細の差分を検査します。

Writers use disjoint pairs of accounts while sharing Odoo's tables and the switch gate. The adapter applies the [fixed Knot account rules](../formal/policy.json) before calling Odoo. PostgreSQL checks the migrated records at cutover and rollback. [Odoo adapter and fixture](erp/README.md)

二重書き込みを有効にする時点で、旧形式だけに確定した最終明細までを転記対象として記録します。負荷開始時の100,000行は、別の境界で元の履歴として照合します。The expansion gate records the last ERP line committed under the old-only route. Backfill uses that boundary. The 100,000 original rows have a separate boundary for historical integrity checks.

## 再現する / Reproduce the run

公開リポジトリを取得し、Docker デーモンと Python 3.12 が利用できる環境で、次のコマンドを実行します。イメージを取得する通信が必要です。起動スクリプトは試験専用の Odoo、データベース、ネットワークを作り、一時認証情報を子プロセスに渡します。ループバックで実験コードから接続し、終了時に試験用の環境を片付けます。

Clone the public repository. With a running Docker daemon, Python 3.12 and network access to fetch the pinned images and driver, run the commands below. The launcher provisions a disposable ERP and database, supplies per-run credentials to the child process, and cleans them up afterward. Choose an unused path for the report.

```sh
git clone https://github.com/BreamResearch/lean-regen.git
cd lean-regen/docs/knot/erp-benchmark
python3.12 -m venv .venv
.venv/bin/python -m pip install --only-binary=:all: --require-hashes -r requirements.txt
.venv/bin/python erp/run.py -- .venv/bin/python benchmark.py \
  --out new-evidence.json --rows 100000 --writers 8 --phase-seconds 6 --chunk 4000
```

この手順で毎回の環境作成、同じ負荷の投入、切替、失敗の注入、復帰、照合を繰り返せます。既存 ERP を接続する際には、会社・配分枠と勘定の対応、接続権限、業務上の単位、再送時の扱い、実データで許容できる待ち時間を現場で決めます。

The repeatable part is provisioning the fixture, applying the same workload, exercising the failure, restoring the former route and retaining the measurements. Connecting an existing ERP still requires company and account mapping, access and write permissions, units, retry semantics and a cutover budget based on real traffic.

## ライセンス / Licenses

Knot の実験コードはプロジェクトの Apache-2.0 で公開します。実行時に公式の Odoo Community、PostgreSQL のイメージと試験用の psycopg2 ドライバーを取得します。これらのバイナリやイメージはこのリポジトリに同梱していません。Knot’s benchmark code uses the project’s Apache-2.0 license. The launcher fetches the upstream images and PostgreSQL driver to run the experiment. [Lean Regen license](../../../LICENSE) · [Odoo Community license](https://github.com/odoo/odoo/blob/18.0/LICENSE) · [PostgreSQL license](https://www.postgresql.org/about/licence/) · [Psycopg distribution](https://pypi.org/project/psycopg2-binary/2.9.13/)

[Odoo Community source](https://github.com/odoo/odoo/tree/18.0) · [Official image](https://hub.docker.com/_/odoo) · [Knot の業務仕様 / Knot specification](../formal/README.md)
