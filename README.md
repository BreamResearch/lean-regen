# Lean Regen

**残り8枠をすべて予約できるはずなのに、サンプルアプリが拒否した。** 合計だけ見ると、空き8＋予約済み2のままでも在庫10は保たれます。Lean Regen は、予約・解放の応答と保存後の残高を、固定した Lean 仕様の結果と1操作ずつ照合します。最初に食い違った状態と操作を、手元のテストに取り込めます。

**The sample booking app rejected a reservation for its last 8 available units.** Its totals still balanced. Lean Regen compares each recorded decision and committed balance with a fixed Lean inventory contract. It reports the first input where they differ, so you can turn the failure into a regression test for your implementation.

[日英ガイド / Project guide](https://breamresearch.github.io/lean-regen/) · [改変不能のアルファ版 / Immutable source alpha](https://github.com/BreamResearch/lean-regen/releases/tag/v0.2.0-alpha.2-dist.1) · [GitHub CI](https://github.com/BreamResearch/lean-regen/actions/runs/45375656292)

## 登録なしで試す · Try the trace checker

Python 3.9 以上だけで、チェッカーと反例サンプルを同じディレクトリに保存し、オフラインで実行できます。ローカル利用は無料です。Download the checker and the sample counterexample to the same directory, then run them offline with Python 3.9+. No account, payment or Lean installation is needed for the bundled examples. [チェッカー / Download the checker](./lean-regen-check.pyz?raw=1) · [誤実装の記録 / Sample counterexample](./wrong.jsonl?raw=1) · [ソース / Checker source ZIP](./lean-regen-conformance-source.zip?raw=1)

```sh
python3 lean-regen-check.pyz
python3 lean-regen-check.pyz wrong.jsonl
```

ソースZIPは開発コミット `cacfa10286e3a06bbab49d38e396f0c9978505db` を収録しています。To rebuild the checker from that source, run `python3 packages/conformance/build_zipapp.py --out ../reproduced.pyz` in the extracted directory. [照合値 / SHA-256 checksums](./CONFORMANCE-SHA256SUMS)

| 入力 / Input | 実行結果 / Observed result |
| --- | --- |
| 独立した SQLite アプリの記録 / Trace from the SQLite example app | `TRACE_MATCH` · 16件すべて一致 / 16 of 16 operations matched |
| 境界で誤る実装の記録 / Trace from the faulty implementation | `COUNTEREXAMPLE` · 5行目、4操作目で終了コード1 / Exit 1 at line 5, operation 4 |

反例の直前は空き8・予約済み2。8を予約したときの期待値は**成功、空き0・予約済み10**。実測値は**拒否、空き8・予約済み2**です。

Before operation 4, there were 8 available and 2 reserved. Reserving 8 should be **accepted, with 0 available and 10 reserved**. The application **rejected it, leaving 8 available and 2 reserved**.

自分の実装では、1資源の操作をコミット順に JSONL へ書き出し、応答と保存後の残高を渡します。形式は `wrong.jsonl` と同じで、開始状態・連番付きの各操作・件数を示す終了行を含みます。既存テストが合計しか確認していないときや、古い実装と書き換え後の実装に同じ基準を当てたいときに使えます。

For your own application, export one resource’s operations in commit order, including its decisions and persisted balances. Use the same JSONL record format as `wrong.jsonl`, with a start state, numbered operations and a final count. This check is useful when existing tests only assert a total, or when you want to compare a rewrite and its predecessor against the same expected behavior.

```sh
python3 lean-regen-check.pyz my-trace.jsonl
```

同梱の1,153件は、容量0〜10の全ての正当な状態・両操作・数量0〜容量＋1と、64ビット上限で選んだ9件を含みます。対象外の入力は `OUTSIDE_COVERAGE` です。より大きな数量は同梱の Lean 参照実装をビルドするネイティブモードで扱えます（Python 3.11 以上、Lean/Lake 4.19.0）。macOS 27 の Apple Silicon では下の手順にあるリンカー設定を先に適用してください。

The 1,153 bundled reference transitions cover all valid states for capacities 0–10, both operations and request sizes from 0 through capacity + 1, plus nine selected cases at maximum signed 64-bit capacity. Other inputs return `OUTSIDE_COVERAGE`. For larger quantities, native mode builds the bundled reference with Python 3.11+ and Lean/Lake 4.19.0. On Apple Silicon with macOS 27, use the linker settings under the source alpha instructions below.

```sh
python3 lean-regen-check.pyz my-trace.jsonl --tool-bin /absolute/path/to/lean-4.19.0/bin
```

照合できるのは記録した逐次操作です。予約者ごとの権限や並行処理の順序が主な課題なら、別の仕様が必要です。ここでの数値は同梱サンプルの検査結果で、顧客環境での効果や工数削減は未測定です。

A match covers the recorded sequential operations. If your main risk is ownership or concurrency, that needs its own specification. These results come from the supplied examples. Customer outcomes and engineering time saved have yet to be measured.

## Lean の14定理を再検査する · Rebuild the source alpha


1. ソース ZIP を保存します。Download the source ZIP. [v0.2.0-alpha.2 ZIP][zip] · [SHA256SUMS][sums]
2. Python 3.11 以上と、OS に合った公式 Lean/Lake 4.19.0 を用意します。Install Python 3.11+ and the official Lean/Lake 4.19.0 distribution for your platform. [Lean 4.19.0][lean]
3. 次のコマンドで ZIP を照合して展開します。Verify and extract the ZIP in your downloads directory.

```sh
python3 -c "from pathlib import Path; from hashlib import sha256; p=Path('lean-regen-v0.2.0-alpha.2-source.zip'); actual=sha256(p.read_bytes()).hexdigest(); print(actual); raise SystemExit(actual != '3894eac56d6392930e20ec4321a1daf96dfa7c66a690923a75b014758292b6dc')" && unzip lean-regen-v0.2.0-alpha.2-source.zip
cd lean-regen-v0.2.0-alpha.2
```

Apple Silicon の macOS 27 では、Xcode のリンカーを次の設定で使用します。On Apple Silicon running macOS 27, run these exports first. We tested them on macOS 27.0.1 with Xcode 27.2. Linux users can continue to the demo.

```sh
export CCC_OVERRIDE_OPTIONS='+--ld-path=/usr/bin/ld'
export MACOSX_DEPLOYMENT_TARGET=27.0
```

`TOOL_BIN` を実際の `bin` の場所に置き換えて実行してください。Set `TOOL_BIN` to your extracted toolchain’s `bin` directory. The demo writes its results to a fresh directory.

```sh
TOOL_BIN=/absolute/path/to/lean-4.19.0/bin
run_dir=$(mktemp -d)
python3 scripts/leanregen.py check-upstream
python3 scripts/leanregen.py demo --tool-bin "$TOOL_BIN" --workdir "$run_dir/demo"
cat "$run_dir/demo/project/evidence/core-check.json"
```

## 在庫数で見る結果 · Read the result

| 操作 / Operation | 結果 / Result | 利用可能 / Available | 予約済み / Reserved |
| --- | --- | ---: | ---: |
| 初期状態 / Start | 容量 / Capacity 10 | 10 | 0 |
| 3 を予約 / Reserve 3 | 成功 / Accepted | 7 | 3 |
| 2 を解放 / Release 2 | 成功 / Accepted | 9 | 1 |
| 20 を予約 / Reserve 20 | 拒否 / Rejected | 9 | 1 |

固定した単一資源モデルの14定理を検査しました。正当な操作の成功と正確な数量変化、拒否時の状態保存、任意の有限操作列での総量保存が対象です。予約済み数量を1多く記録する変更、すべての予約を拒否する変更、予約の事前条件を外す変更の3件は、元の証明で拒否されました。

The 14 checked theorems cover one sequential resource. They require valid operations to succeed with exact quantities, rejected operations to preserve state, and capacity to hold over every finite sequence. The mutation suite tried recording one extra unit as reserved, rejecting every reservation and removing the reservation guard. The original proofs rejected all three. The model covers aggregate quantities. Ownership, concurrent requests and storage need additional specifications and tests. [検査記録 / Kernel report][report] · [収録ファイル / Manifest][manifest] · [リリースノート / Release notes][notes]

## 履歴と開発版 · Inspect the Git history

ZIP はタグのソース、Git バンドルはその履歴と `codex/post-alpha` 開発ブランチを収録しています。The bundle includes the tagged source and the development branch. Download it to the current directory and clone offline. [Git bundle][bundle]

```sh
git clone -b main ./lean-regen.git.bundle lean-regen-src
git -C lean-regen-src rev-parse 'v0.2.0-alpha.2^{commit}'
git -C lean-regen-src switch codex/post-alpha
```

| 識別子 / Identifier | 値 / Value |
| --- | --- |
| ソースタグのコミット / Tagged source commit | `80a86efab6e6d678d7ae839811a2fb95352ddbbd` |
| Git バンドル / Bundle SHA-256 | `bef15192a35c80de150fa56f8b65d86a08e0f3341263b8a117cf3aec5fe1c1d3` |

開発版では、固定した証明の6カーネル検査、依存更新候補の作成、開発用署名、SQLite 台帳をローカルで実行済みです。公開登録、課金、本番への自動配布は今後の作業です。

The development branch includes local runs of six proof kernels, dependency update preparation, a development signature and a SQLite inventory ledger. Public signup, billing and automatic production delivery remain pending. BreamResearch distributes the project source under Apache-2.0. [ライセンス / License][license] · [第三者の表記 / Third-party notices][notices]

[zip]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/lean-regen-v0.2.0-alpha.2-source.zip
[sums]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/SHA256SUMS
[lean]: https://github.com/leanprover/lean4/releases/tag/v4.19.0
[report]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/core-check.json
[manifest]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/manifest.json
[notes]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/RELEASE-NOTES.md
[bundle]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/lean-regen.git.bundle
[license]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/LICENSE
[notices]: https://raw.githubusercontent.com/BreamResearch/lean-regen/454e9b5581785e82107db88f064b6e65b643f43c/THIRD_PARTY_NOTICES.md
