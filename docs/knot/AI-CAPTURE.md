# 収録提案の出所 / Proposal provenance

「顧客移行の期限前倒し」では、Codex に必要な予算・工数と二つの受入枠を渡しました。候補は DATA と RISK の開発・QA枠です。各枠の残高・確約・振替経路・確保状態を渡し、可能なら同じ部門から調達する条件で振替元を選ばせました。応答は DATA の開発・QA枠を選びました。[収録応答](recorded-plans.json)

For *Customer migration moves up*, Codex received required amounts and destination accounts, plus four source pools in two cost centres. It received each source's balances, commitments, route eligibility and protected status. It chose both DATA pools under a preference for coordinating within one centre. A separate check reads the current database before any posting. [Recorded responses](recorded-plans.json)

共通枠の過剰引当、古い版、途中障害、締め済み期間、依存先未完了の例は、検査で境界を観察できるように振替明細を指定し、その候補について Codex の日英の説明を収録しました。8案件の一括振替は、同じ負荷を繰り返せるよう固定した試験データです。

The boundary scenarios supply specific lines for Codex to explain in both languages. The eight-project wave is a deterministic load fixture. The public web app replays these inputs and runs the policy and SQLite operations in the current tab. No inference credentials or business data are bundled.
