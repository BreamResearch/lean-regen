# Knot HTTP ledger · SQLite WAL

[日本語](#日本語) · [English](#english) · [実測結果 / Recorded run](evidence.json)

## 日本語

同じプールから同時に予算を移すと、どの申請が台帳に残るか。スキーマ移行中も旧版・新版クライアントは投稿を続けられるか。この例では、一時的なローカル HTTP サーバー、独立した SQLite 接続、架空の八つの資源プールで両方を試せます。

このディレクトリで実行してください。Python 3.9 以上と SQLite 3.37 以上を使います。Python 標準ライブラリ以外の依存パッケージはありません。

```sh
python3 -B exercise.py --out run.json
```

出力には新しいファイル名を指定してください。スクリプトはループバックの一時ポートを開き、台帳と今回専用の五つの認証情報を作成します。終了時にデータベースと認証情報を破棄します。金額は一万円単位、工数は整数時間です。プールの判定には [Lean から出力した規則](../../formal/policy.json) を使います。プログラムは起動時にその SHA-256 を検査します。

| 試せる操作 | 実行時に確認する事実 |
| --- | --- |
| 認証と権限 | 未発行のトークンは 401。閲覧者による投稿や権限外の拠点への移転は 403。認証情報の所持者、役割、拠点をサーバー側で照合します。 |
| 同時申請 | 異なる認証情報の二つの HTTP リクエストが同じ版・同じ移転元を使います。両方が実際に書き込みロックに遭遇したことを確認してから先に進め、一方が確定し、他方は 409 になります。成功した申請の同一再送は二重計上されません。 |
| 複数仕訳 | A から B に予算 2・工数 3、C に予算 4・工数 5 を同時移管します。A の減少は 6 と 8。四つの仕訳で予算と工数がそれぞれ釣り合います。二明細の合算で確約分を割る申請は全体を棄却します。 |
| オンライン移行 | 旧表の予算・工数の二列を、新表の単位別の行に展開します。バックフィル未完了、および検査用コピーでの台帳不一致は切替を停止します。切替後は旧版が更新可能ビューを使い、ロールバックで旧表を現時点の残高から復元します。両版の実投稿件数を移行段階別に記録します。 |

## English

Run `python3 -B exercise.py --out run.json` from this directory with a fresh output path. Use Python 3.9+ linked to SQLite 3.37+. The exercise starts a temporary HTTP server on loopback, creates eight synthetic resource pools and five fresh bearer credentials, then deletes the temporary database. The Python standard library and the [pinned Lean policy export](../../formal/policy.json) provide the runtime inputs.

Two independent HTTP handlers compete with the same revision and a shared donor. A third database connection holds a write reservation until each handler encounters SQLite lock contention. The revision check runs inside the eventual write transaction. One request commits. The other receives HTTP 409. An identical replay returns the original receipt. Each posting applies policy to aggregate deltas per pool, journals the signed debit and credit legs, updates priority and advances the revision atomically.

The server resolves identities, roles and cost-center grants from stored hashes of generated bearer tokens. Readers can inspect their own scope. Posters can move resources only between authorized pools. The operations role runs schema changes. The service uses a database-wide revision and SQLite serializes writers. This fixture runs on one host with synthetic accounts.

During expansion, v1 writers update legacy columns and v2 writers update normalized budget/hour rows. Triggers synchronize the representations in the writing transaction. Backfill proceeds a pool at a time while both client generations post. The cutover requires matching balances, a contiguous receipt history, balanced journal legs, foreign keys and agreement with opening balances plus journal movements. It replaces the old table with an updatable view. Rollback reconstructs the physical table from current normalized balances and reinstates dual writes. Both client generations continue to post after each transition. Amounts keep their units throughout. The [recorded run](evidence.json) includes post counts, checked data hashes around each transition and SQLite integrity-check results. The winner and counts vary with scheduling.

| HTTP endpoint | Required role |
| --- | --- |
| `GET /state` | Authenticated identity, restricted to its granted centers |
| `POST /v1/post`, `POST /v2/post` | Poster with grants for every touched pool |
| `GET /admin/reconcile` | Operator |
| `POST /admin/expand`, `backfill`, `contract`, `rollback` under `/admin/` | Operator |

The Lean export covers six per-pool guards. HTTP authorization, SQL projection, concurrency and migration behavior are exercised by the integration tests. The server here uses generated local credentials and loopback HTTP. Multi-host failover, external SSO and production credential management require separate integration.
