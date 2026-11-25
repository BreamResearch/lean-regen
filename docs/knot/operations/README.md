# Knot · 台帳の運用を試す / Operating the Knot ledger

同じ残高を見た二人が同時に振替を確定したら、仕訳は何件残るでしょうか。配分の計算に加えて、誰がどの取引を確定できるか、別の書き手が先に確定したとき次の書き手に何を返すか、移行の前後でどの履歴を引き継ぐかを調べる演習です。

Two operators see the same balance and try to commit a transfer. How many entries should the ledger retain? This exercise shows who may commit a transaction, what a second writer sees after the first commits, and which entries survive a migration.

[日本語で開く](https://breamresearch.github.io/lean-regen/knot/operations/) · [Open in English](https://breamresearch.github.io/lean-regen/knot/operations/?lang=en)

| タブ / Scenario | 確かめること / What to inspect |
| --- | --- |
| **同時更新 / Concurrent writes** | A・Bに同じ版を読ませ、先に確定する人を選びます。1件が確定し、もう1件は古い版で止まります。再計算すると、空き予算と工数も足りません。Choose A or B to go first. One transfer posts two ledger entries. The other request is stale and, after recalculation, exceeds the remaining budget and hours. |
| **操作権限 / Authorization** | 同じ取引でも、担当者の役割と許可された配分枠で結果が変わります。拒否された後の残高と台帳も確認します。Try the same request under different roles and scopes. Check whether a refused request left a posting or changed either balance. |
| **オンライン移行 / Online migration** | ブラウザーでは仕訳の予算を万円単位から円単位へ移します。移行中に旧版と新版で書き込み、過去の行を転記する前後で読み取りを切り替えてください。The browser changes signed journal amounts from units of ¥10,000 to yen. Try switching readers before and after copying the historical rows, with new postings made during the transition. |

公開デモは一つのタブ内の SQLite で動き、操作の順序と架空の担当者を選んで結果を再現できます。登録は不要です。実サーバー上の競合・認可・移行は、次の2通りで手元から検査できます。

The free browser lab runs SQLite in one tab. You choose the submission order and the fictional actor. The two local exercises below make actual requests from separate clients, and retain a report of what the server observed.

## 実サーバーで確かめる / Check the actual servers

**SQLite と HTTP。** ループバック限定の HTTP サービスが利用者ごとの一時トークンを受け取り、許可された部門と操作をサーバー側で判定します。異なる接続が同じ版を更新しようとすると、片方が確定し、片方は古い版として停止します。移行では予算・工数の2列を単位別の行へ変換し、旧版・新版からの書き込み中に読み取り先を切り替え、元の構造への切り戻し後も残高を仕訳から再計算します。[手順](server/README.md) · [SQLite実行記録](server/evidence.json)

**SQLite over HTTP.** A loopback service checks each request’s per-run test credential, role and scope. Two concurrent requests compete for the same balance on separate SQLite connections. One commits and one returns a stale-revision response. This exercise migrates two balance columns to separate budget and hours rows under live writes. After cutover and rollback it reconciles opening balances with the signed ledger. The number of transfers completed during migration depends on scheduling.

**PostgreSQL 16。** 業務ごとの DB ログインを使います。実測では、同じ部門に書く2つのバックエンドの待機関係を PostgreSQL 自身で観測しました。別部門の新版クライアントは旧版の取引が開いたまま確定でき、転記と最終切替は対象の書き手を待ちました。値に1単位のずれがあると旧表を保持します。照合後に旧表を削除し、新版の書き込みを確認します。[手順](postgres/README.md) · [PostgreSQL実行記録](postgres/evidence.json)

**PostgreSQL 16.** Separate database logins use SCRAM authentication. PostgreSQL reports which backend blocks a competing writer. A new writer in a different tenant commits while the legacy transaction remains open. Backfill and final cutover wait where they overlap with outstanding writes. The cutover refuses an incomplete copy or a one-unit mismatch, then retires the old table only after reconciliation. The local record covers one database instance, two tenants and five committed transfers.

公開リポジトリの `docs/knot/operations` から実行します。最初のコマンドは Python 3.9 以上とそのSQLiteモジュール、2つ目は PostgreSQL 16 のサーバー・クライアントコマンド一式を使います。Node.js 24 があれば `node check.mjs` でブラウザー用処理も再検査できます。Run from `docs/knot/operations` using new report filenames. The PostgreSQL command expects that version’s `pg_config` on your path.

```sh
python3 -B server/exercise.py --out new-sqlite.json
python3 -B postgres/verify.py --pg-bin "$(pg_config --bindir)" --out new-postgres.json
```

運用試験が扱うのは単一ホスト上の合成取引です。Lean の数量規則の証明は、資源配分モデルのガイドから再検査できます。These local experiments measure transaction behaviour on a single host. The separate allocation model and its Lean proofs are documented in the main guide. [資源配分モデル / Allocation model](../README.md)
