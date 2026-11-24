# Lean Regen

予約機能を作り直したとき、正しい予約まで拒否する実装を見抜けますか。Lean Regen は、予約が成功する条件、数量の変化、拒否時の状態を先に決め、実装を変えるたびに同じ仕様を Lean で検査できる OSS です。ローカル利用は無料で、登録は不要です。

Would your tests catch a rewrite that rejects every valid reservation? Lean Regen gives developers a fixed contract for when a reservation must succeed, how quantities change and what a rejection preserves. Run the same Lean checks against each implementation and inspect the proof and build logs yourself. Local use is free and requires no account.

## アルファ版を試す · Try the source alpha

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
