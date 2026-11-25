# Odoo Community 18 · 案件別の振替 / Project reallocations

この接続例は、専用の Odoo Community に会社、案件、案件ごとの分析勘定、書き手ごとのユーザーを作成します。1件の配分変更で二つの標準分析明細を同じ ORM リクエストに渡します。移転元は金額・時間とも負、移転先は正。金額の通貨は会社の設定、数量の単位は Odoo の「時間」です。これはプロジェクトの管理会計用の振替です。[Odoo の分析会計](https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/analytic_accounting.html)

The adapter creates standard Odoo projects linked to analytic accounts, then submits a debit and an equal credit in one authenticated XML-RPC `account.analytic.line.create` call. An acknowledgement supplies both native database IDs. Each writer has its own internal analytic user and pair of accounts. The benchmark reconciles actual committed rows in PostgreSQL. The records measure a change in project management accounting. [Odoo model API](https://www.odoo.com/documentation/18.0/developer/reference/external_api.html)

合成の期首残高は各勘定の金額・時間それぞれ100万です。書き手は Odoo に保存済みの明細を勘定別に合計し、期首残高に加えて開始します。各提案は元と先の両方で Knot の数量規則を通します。確定応答が届いてから次の残高を使います。担当勘定は書き手ごとに分かれ、移行する参照表は全員で共有します。

Each account starts with a synthetic opening of 1,000,000 monetary units and 1,000,000 hours, plus the signed amounts already stored in Odoo. Each writer alternates directions within its exclusive pair of accounts and checks both sides against the [fixed Knot guards](../../formal/policy.json). Before the load begins, an excessive proposal exercises the same submission path. A separate ORM read checks that the rejected proposal left the native line count unchanged. Workload timings therefore cover concurrent access to shared tables by writers with disjoint project accounts.

[再現コマンド / Run the benchmark](../README.md) · [固定イメージ / Image digests](images.json) · [公式 Odoo イメージのビルド定義 / Upstream Dockerfile](https://github.com/odoo/docker/blob/0ea197eb3852ca500e38fd72074b314833ee7dc8/18.0/Dockerfile)

The launcher pulls both images by immutable digest. Each invocation initializes the Project module without demo data, changes the generated database's administrative credential before starting the HTTP listener, and publishes Odoo and PostgreSQL on random IPv4 loopback ports. The benchmark operator can install PostgreSQL triggers in this disposable database. Odoo uses a separate database login. XML-RPC writes use individual Odoo identities. The launcher removes its containers, database volumes and network at the end. Pulled images remain in Docker's local cache.
