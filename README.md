# Lean Regen

合意した業務仕様を残し、実装は差し替えられるようにする。その設計を、手元で書き換えて確かめられる参照実装です。同じ契約の下で動作の等しい変更を通し、意味を変えてしまう変更を検出するところまで試せます。最初の題材は在庫の予約と解放です。

Lean Regen is a runnable reference design for keeping an agreed business contract across implementation changes. Try a rewrite that preserves the contract, then one that breaks it, and see exactly where the proof fails. The worked example uses inventory reservations and releases. Both the design example and its companion trace checker run locally, free, without an account.

[設計と手順（日本語）](https://breamresearch.github.io/lean-regen/#design) · [Design and usage (English)](https://breamresearch.github.io/lean-regen/#design-en) · [照合ツール / Trace checker][checker-release] · [Lean ソース / Lean source alpha][alpha-release]

## 同じ契約に3つの実装をかける · Compare three implementations

[設計例の ZIP / Download the reference design][reference-zip] · [リリース / Release][reference-release]

Python 3.11 以上、公式 Lean/Lake 4.19.0 とネイティブリンカーを用意し、`lean-regen-reference.zip` を展開します。`--tool-bin` には実際の `bin` ディレクトリ、`--out` には新しい出力先を指定します。

Extract `lean-regen-reference.zip`. Use Python 3.11+, official Lean/Lake 4.19.0 for your platform and a working native linker. Set `--tool-bin` to your toolchain’s `bin` directory and use a fresh output directory. [Lean 4.19.0][lean]

Apple Silicon の macOS 27 では次の環境変数で Xcode のリンカーを選択します。On Apple Silicon with macOS 27, first select Xcode’s linker using these settings. Linux users can start at the next block.

```sh
export CCC_OVERRIDE_OPTIONS='+--ld-path=/usr/bin/ld'
export MACOSX_DEPLOYMENT_TARGET=27.0
```

```sh
cd lean-regen-reference
python3 compare.py --tool-bin /absolute/path/to/lean-4.19.0/bin --out ../comparison
```

| 実装 / Implementation | 同じ検査基準での結果 / Result against the same contract |
| --- | --- |
| 元の予約処理 / Original | 14定理を検査 / 14 theorems checked |
| 加算の順序を変え、交換則で証明 / Reordered addition with a proof of commutativity | 14定理を検査 / 14 theorems checked |
| 空き枠と同数の予約を拒否 / Rejects requests for exactly the available quantity | 正当な予約の成功を証明できず拒否 / Blocked by the original proof obligations |


## 記録から最初の反例を見つける · Find the first mismatch

`lean-regen-check.pyz` と `wrong.jsonl` を同じフォルダーに保存し、Python 3.9 以上で実行します。Download both files, then run the following in their directory. The bundled examples run offline with Python 3.9+. [チェッカー / Checker][pyz] · [誤実装の記録 / Faulty trace][wrong] · [チェックサム / Checksums][kit-sums]

```sh
python3 lean-regen-check.pyz
python3 lean-regen-check.pyz wrong.jsonl
```

| 入力 / Input | 結果 / Result |
| --- | --- |
| SQLite の16操作 / 16 SQLite transactions | `TRACE_MATCH` · 16/16 一致 / all matched |
| 全数予約を誤って拒否する版 / Implementation rejects the last available units | `COUNTEREXAMPLE` · 5行目、4操作目で停止 / line 5, operation 4, exit code 1 |

反例は空き8・予約済み2からの8枠予約です。期待値は**成功、空き0・予約済み10**。実測値は**拒否、空き8・予約済み2**。どちらも合計は10なので、数量保存のテストだけではこの違いを捉えられません。

The failing transaction tried to reserve 8 from a state with 8 available and 2 reserved. The contract requires **accepted, 0 available, 10 reserved**. The database application reported **rejected, 8 available, 2 reserved**. A test that only checks whether the quantities add up to 10 passes in both cases.

## 仕様から実装をたどる · Follow one rule through the code

参照設計のZIPを展開し、`project/` を開くと、次のファイルを読めます。In the reference design ZIP, the files below are under `project/`.

| ファイル / File | 何を読むか / What to read |
| --- | --- |
| `VerifiedInventory/Specification.lean` | `ReserveAllowed s q` は `0 < q ∧ q ≤ s.available`。`ReserveSpec` は成功時の正確な増減と、拒否時の元の状態を定義。 / The predicate permits reserving the last unit. The specification defines the exact accepted balances and the unchanged rejected state. |
| `VerifiedInventory/Implementation.lean` | `reserve` と `release` が実装。`step` は1操作、`run` は有限の操作列を実行。 / `step` dispatches a command to `reserve` or `release`. `run` applies a finite list of commands. |
| `VerifiedInventory/Proofs.lean` | `reserve_succeeds` は正当な予約の成功、`reserve_rejects_unchanged` は拒否時の状態保存、`run_preserves` は正当な初期状態からの総量保存。 / These prove required success, unchanged state on rejection, and capacity conservation from any well-formed state. |
| `Contract.lean` · `Audit.lean` · `assurance.json` | 6要件に対応する14定理を所定の型で検査し、使用した公理を照合。 / The challenge checks the expected theorem types. The manifest maps 14 theorems to six requirements. The verifier checks the audit output against the allowed axioms. |

自分の候補を試すには、同梱の `project/` をコピーして実装と証明を編集し、ZIP の README の「自分の実装を試す」に従って元の契約で再検査します。To check your own candidate, copy `project/`, edit the implementation and proofs, then follow “Check your own variant” in the archive README to run against the same lock.

## 自分のアプリへ移す · Adapt the example

**例として部屋の予約枠を扱う場合。** 同じ種類の空き枠を `available`、確保済みの枠を `reserved` に対応させます。1資源について、応答とコミット後の残高をコミット順に1回ずつ書き出します。例えば残り8枠をすべて予約する最短記録は次の3行です。`my-trace.jsonl` として保存してください。

**For a pool of interchangeable room slots,** map available and held slots to `available` and `reserved`. Export each committed operation for one pool in commit order, alongside the application decision and persisted balances. Save this complete, one-operation journal as `my-trace.jsonl`.

```jsonl
{"type":"start","format":"lean-regen-inventory-trace-v1","capacity":10,"available":8,"reserved":2}
{"type":"step","seq":1,"operation":"reserve","quantity":8,"outcome":"accepted","available":0,"reserved":10}
{"type":"end","count":1}
```

```sh
python3 lean-regen-check.pyz my-trace.jsonl
```

`TRACE_MATCH` は渡した操作列の一致を示します。固定した1,153件は容量0〜10の全ての正当な状態・両操作・数量0〜容量＋1と、64ビット上限で選んだ9件を含みます。範囲外は `OUTSIDE_COVERAGE`。大きな容量には `--tool-bin "$TOOL_BIN"` を追加して同梱の Lean 参照実装を実行できます。

A matching trace covers the supplied observations. The 1,153 reference cases include every valid state at capacities 0–10, both operations and quantities 0 through capacity + 1, plus nine cases at maximum signed 64-bit capacity. Outside this set, rerun with `--tool-bin "$TOOL_BIN"` to use the compiled Lean reference. [チェッカーのソースと JSONL 形式 / Checker source and journal format][kit-source]

所有者別の取消しや有効期限が必要なら、まず別バージョンの仕様に識別子・時刻・成功条件を追加し、状態、定理、検査課題を決めてから実装します。この14定理は単一資源の逐次数量モデルを扱います。並行実行、永続化、コンパイラ、OS の動作にはそれぞれ別の根拠が必要です。

For owner-specific cancellation or expiry, start a new contract version. Define identity, time, permitted transitions and rejection behavior before implementing them. The 14 theorems cover the sequential quantity model for one resource. Concurrency, storage, compiler and OS behavior require separate evidence.

**再利用 / Reuse.** プロジェクトのソース・仕様・証明は Apache-2.0 の条件で改変・商用利用・再配布できます。The source, specifications and proofs may be modified and redistributed under Apache-2.0, including for commercial use. Keep the applicable notices and identify changes when redistributing. [License][license] · [Third-party notices][notices]

[checker-release]: https://github.com/BreamResearch/lean-regen/releases/tag/inventory-check-v0.1.0-alpha.1
[pyz]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.1/lean-regen-check.pyz
[wrong]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.1/wrong.jsonl
[kit-sums]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.1/CONFORMANCE-SHA256SUMS
[kit-source]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.1/lean-regen-conformance-source.zip
[alpha-release]: https://github.com/BreamResearch/lean-regen/releases/tag/v0.2.0-alpha.2-dist.1
[lean]: https://github.com/leanprover/lean4/releases/tag/v4.19.0
[license]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/LICENSE
[notices]: https://github.com/BreamResearch/lean-regen/blob/main/THIRD_PARTY_NOTICES.md

[reference-zip]: https://github.com/BreamResearch/lean-regen/releases/download/reference-design-v0.1.0-alpha.1/lean-regen-reference.zip
[reference-release]: https://github.com/BreamResearch/lean-regen/releases/tag/reference-design-v0.1.0-alpha.1
