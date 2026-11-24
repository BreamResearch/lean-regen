# Lean Regen

Lean Regen は、業務仕様を Lean で定義し、実装を書き換えても同じ条件を満たすか検査するための参照設計です。在庫の予約と解放を例に、元の実装と二つの書き換えを比較できます。無料で、登録せずに手元で実行できます。

Lean Regen shows how to specify business rules in Lean and check a replacement implementation against those same rules. The example compares three implementations of inventory reservations and releases. The tools run locally, free of charge, without an account.

[設計と手順（日本語）](https://breamresearch.github.io/lean-regen/#design) · [Design and usage (English)](https://breamresearch.github.io/lean-regen/#design-en) · [照合ツール / Trace checker][checker-release]

## 同じ契約で3つの実装を検査する · Compare three implementations

[設計例の ZIP / Download the reference design][reference-zip] · [リリース / Release][reference-release]

Python 3.11 以上、公式 Lean/Lake とネイティブリンカーを用意し、`lean --version` が 4.19.0 を示すことを確認します。ZIP を展開し、`lean-regen-reference` フォルダーの親ディレクトリで次を実行します。出力先の `comparison` には未使用のディレクトリ名を指定してください。

Use Python 3.11+, the official Lean/Lake toolchain and a native linker. Check that `lean --version` reports 4.19.0. Extract the ZIP and open a terminal in the directory containing `lean-regen-reference`. Choose a fresh output directory for each run. [Lean 4.19.0][lean]

Apple Silicon の macOS 27 では次の環境変数で Xcode のリンカーを選択します。

On Apple Silicon with macOS 27, first select Xcode’s linker using these settings. Linux users can skip the two export commands.

```sh
export CCC_OVERRIDE_OPTIONS='+--ld-path=/usr/bin/ld'
export MACOSX_DEPLOYMENT_TARGET=27.0
```

```sh
cd lean-regen-reference
python3 compare.py --tool-bin "$(lean --print-prefix)/bin" --out ../comparison
```

| 実装 / Implementation | 同じ検査基準での結果 / Result against the same contract |
| --- | --- |
| 元の予約処理 / Original | 14定理を検査 / 14 theorems checked |
| 加算の順序を変え、交換則で証明 / Reordered addition with a proof of commutativity | 14定理を検査 / 14 theorems checked |
| 空き枠と同数の予約を拒否 / Rejects requests for exactly the available quantity | 正当な予約の成功を証明できず `BLOCKED` / The required success cannot be proved |

3件目が想定どおり止まると比較全体は正常終了します。検査の詳細は `../comparison/boundary-error/result_logs/build.log` にあります。

The comparison exits successfully when it sees all three expected results. The failed proof and its source location appear in that build log.

## SQLite の記録から誤りを見つける · Find a mismatch in a SQLite journal

`lean-regen-check.pyz` と `wrong.jsonl` を同じフォルダーに保存し、Python 3.9 以上で実行します。

Download both files, then run the following in their directory. The bundled examples run offline with Python 3.9+. [チェッカー / Checker][pyz] · [誤実装の記録 / Faulty trace][wrong] · [チェックサム / Checksums][kit-sums]

```sh
python3 lean-regen-check.pyz
python3 lean-regen-check.pyz wrong.jsonl
```

| 入力 / Input | 結果 / Result |
| --- | --- |
| SQLite の16操作 / 16 SQLite transactions | `TRACE_MATCH` · 16/16 一致 / all matched |
| 全数予約を誤って拒否する版 / Implementation rejects the last available units | `COUNTEREXAMPLE` · 5行目、4操作目で停止 / line 5, operation 4, exit code 1 |

反例は空き8・予約済み2からの8枠予約です。契約では予約を受理し、空き0・予約済み10になります。SQLite の実測値は拒否、空き8・予約済み2でした。どちらも合計は10なので、数量保存のテストだけではこの違いを捉えられません。

The failing transaction tried to reserve 8 from a state with 8 available and 2 reserved. The contract requires **accepted, 0 available, 10 reserved**. The database application reported **rejected, 8 available, 2 reserved**. A test that only checks whether the quantities add up to 10 passes in both cases.

## 仕様から実装をたどる · Follow one rule through the code

参照設計 ZIP の `lean-regen-reference/project/` に次のファイルがあります。

In the reference design ZIP, the files below are under `project/`.

| ファイル / File | 何を読むか / What to read |
| --- | --- |
| `VerifiedInventory/Specification.lean` | `ReserveAllowed s q` は `0 < q ∧ q ≤ s.available`。`ReserveSpec` は成功時の正確な増減と、拒否時の元の状態を定義。 / The predicate permits reserving the last unit. The specification defines the exact accepted balances and the unchanged rejected state. |
| `VerifiedInventory/Implementation.lean` | `reserve` と `release` が実装。`step` は1操作、`run` は有限の操作列を実行。 / `step` dispatches a command to `reserve` or `release`. `run` applies a finite list of commands. |
| `VerifiedInventory/Proofs.lean` | `reserve_succeeds` は正当な予約の成功、`reserve_rejects_unchanged` は拒否時の状態保存、`run_preserves` は正当な初期状態からの総量保存。 / These prove required success, unchanged state on rejection, and capacity conservation from any well-formed state. |
| `Contract.lean` · `Audit.lean` · `assurance.json` | 6要件に対応する14定理を所定の型で検査し、使用した公理を照合。 / The challenge checks the expected theorem types. The manifest maps 14 theorems to six requirements. The verifier checks the audit output against the allowed axioms. |

自分の候補を試すには、同梱の `project/` をコピーして実装と証明を編集し、ZIP の README の「自分の実装を試す」に従って元の契約で再検査します。

To check your own candidate, copy `project/`, edit the implementation and proofs, then follow “Check your own variant” in the archive README to run against the same lock.

## 自分のアプリのログを照合する · Check your application’s journal

たとえば同じ種類の予約枠を数量で管理するアプリなら、空き枠数を `available`、予約済み枠数を `reserved` として記録します。1資源の初期状態から始め、アプリの応答とコミット後の残高を確定順に書き出します。次の3行を `my-trace.jsonl` として保存すると、残り8枠をすべて予約する例を試せます。

For a pool of interchangeable slots, map available and reserved quantities to `available` and `reserved`. Export each committed operation for one pool in commit order, alongside the application decision and persisted balances. Save this complete, one-operation journal as `my-trace.jsonl`.

```jsonl
{"type":"start","format":"lean-regen-inventory-trace-v1","capacity":10,"available":8,"reserved":2}
{"type":"step","seq":1,"operation":"reserve","quantity":8,"outcome":"accepted","available":0,"reserved":10}
{"type":"end","count":1}
```

```sh
python3 lean-regen-check.pyz my-trace.jsonl
```

`TRACE_MATCH` は渡した操作列の一致を示します。固定した1,153件は容量0〜10の全ての正当な状態・両操作・数量0〜容量＋1と、64ビット上限で選んだ9件を含みます。範囲外は `OUTSIDE_COVERAGE`。範囲外の入力も、Python 3.11 以上と上記の Lean/Lake 4.19.0 を使って照合できます。

A matching trace covers the supplied observations. The 1,153 reference cases include every valid state at capacities 0–10, both operations and quantities 0 through capacity + 1, plus nine cases at maximum signed 64-bit capacity. For an input outside this set, use Python 3.11+ and the Lean/Lake 4.19.0 environment from the comparison example to run the bundled Lean reference. [チェッカーのソースと JSONL 形式 / Checker source and journal format][kit-source]

```sh
python3 lean-regen-check.pyz my-trace.jsonl --tool-bin "$(lean --print-prefix)/bin"
```

誰が予約を取り消せるか、いつ期限が切れるかまで扱うには、予約者・時刻・取消条件を定めた仕様が必要です。この14定理は単一資源の逐次数量モデルを扱います。並行実行、永続化、コンパイラ、OS の動作にはそれぞれ別の根拠が必要です。

A system with per-user cancellation or expiry needs a contract that specifies identity, time and when a cancellation is allowed. The 14 theorems cover the sequential quantity model for one resource. Concurrency, storage, compiler and OS behavior require separate evidence.

**再利用 / Reuse.** この設計例のソース・仕様・証明には Apache-2.0 が適用されます。

The source, specifications and proofs in the reference design use Apache-2.0. [License][license] · [Third-party notices][notices]

[checker-release]: https://github.com/BreamResearch/lean-regen/releases/tag/inventory-check-v0.1.0-alpha.2
[pyz]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.2/lean-regen-check.pyz
[wrong]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.2/wrong.jsonl
[kit-sums]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.2/CONFORMANCE-SHA256SUMS
[kit-source]: https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.2/lean-regen-conformance-source.zip
[lean]: https://github.com/leanprover/lean4/releases/tag/v4.19.0
[license]: https://github.com/BreamResearch/lean-regen/blob/main/LICENSE
[notices]: https://github.com/BreamResearch/lean-regen/blob/main/THIRD_PARTY_NOTICES.md

[reference-zip]: https://github.com/BreamResearch/lean-regen/releases/download/reference-design-v0.1.0-alpha.2/lean-regen-reference.zip
[reference-release]: https://github.com/BreamResearch/lean-regen/releases/tag/reference-design-v0.1.0-alpha.2
