# PostgreSQL 16 · 競合、権限、移行 / Writes, access and migration

二つの部門に、それぞれ配分枠 A と B があります。各振替は A の予算と工数を B に移し、部門の版と取引履歴を一緒に更新します。検査のたびに新しい PostgreSQL クラスタ、専用の Unix ソケット、一時パスワードを作成します。外部のデータベースやアカウントは不要です。

Each of two tenants has accounts A and B. A transfer moves budget and hours from A to B, records the transaction and advances that tenant’s revision. The exercise runs PostgreSQL 16 in a disposable local cluster. It connects through a private Unix socket using fresh SCRAM passwords, with TCP listening disabled.

## 実行 / Run

このディレクトリで、PostgreSQL 16 のコマンド一式と Python 3.9 以上を使います。PostgreSQL が一時クラスタを作れる一般ユーザーで実行してください。指定する JSON は新規ファイルです。

Use an ordinary local OS account, Python 3.9+ and the PostgreSQL 16 server and client programs. With that version’s `pg_config` on your path, run the following command. On Ubuntu 24.04 with PostgreSQL 16 installed, you can pass `--pg-bin /usr/lib/postgresql/16/bin` directly.

```sh
python3 verify.py --pg-bin "$(pg_config --bindir)" --out new-postgres.json
```

## 結果の読み方 / Read the evidence

- **競合 / Race.** 二人が同じ部門の版1で振替を確定しようとします。先に行ロックを得た接続が取引を開いたまま、もう一人が待つことを `pg_blocking_pids` で観測します。解放後、後の接続には `stale` が返り、版2の取引が1件残ります。The report records both server process IDs and PostgreSQL’s observed blocking relationship. Replaying the winner’s request produces one journal entry in total.
- **権限 / Access.** アプリ用 DB ロールはテーブルを所有せず、指定した関数だけを呼べます。関数は接続時の `session_user` で部門を判定します。読取ロールの確定、他部門の閲覧・確定、業務ロールによるテーブルへの直接アクセスは権限エラーになります。A wrong password fails login. A correctly authenticated login can still be denied by its role or tenant scope. The fresh balance and journal snapshots verify that the denied requests left the data unchanged.
- **移行 / Migration.** 旧表の予算・工数2列を、単位ごとに1行ずつ持つ新表へ段階的に移します。旧接続が取引を開いたまま、別部門の新クライアントが実際に確定します。未転記または不一致があれば旧表を残します。The verifier observes the backfill waiting on an old writer and the final cutover waiting for another outstanding writer. It checks the copied values against both the old table and the opening balances plus committed history. After cutover, the old table is removed, the old client returns `writer-retired`, and the new client posts to the new table.

この試験は単一 PostgreSQL インスタンス・2部門の合成データで実行します。The scope is one PostgreSQL instance, two synthetic tenants and a transfer between two pools per tenant. The cutover briefly serializes writers. [実行記録 / Recorded run](evidence.json) · [ロールと取引 / Roles and posting](ledger.sql) · [移行と照合 / Migration and reconciliation](expand.sql)
