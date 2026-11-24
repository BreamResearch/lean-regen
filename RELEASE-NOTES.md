# ダウンロード / Downloads

## 参照設計 / Reference design

業務上の約束を Lean で記述し、元の実装と書き換え後の実装を同じ条件で検査できます。`lean-regen-reference.zip` を展開して README の手順を実行してください。題材は1種類の在庫の予約と解放です。

Use `lean-regen-reference.zip` to run three implementations against the same inventory contract. The archive contains the specification, implementations, proofs, verifier and instructions for trying your own change. [設計例と照合値 / Reference design and checksum](https://github.com/BreamResearch/lean-regen/releases/tag/reference-design-v0.1.0-alpha.2)

## 操作ログの照合器 / Trace checker

アプリの応答と、永続化後の在庫数を1取引ずつ参照値と照合します。`lean-regen-check.pyz` と `wrong.jsonl` を同じフォルダーに保存し、Python 3.9 以上で次を実行します。

Compare the application's decisions and committed balances with the inventory reference. Save the checker and sample journal in one directory. The first command checks 16 matching operations. The second stops at a valid reservation the sample application rejected. [照合器・ソース・チェックサム / Checker, source and checksums](https://github.com/BreamResearch/lean-regen/releases/tag/inventory-check-v0.1.0-alpha.2)

```sh
python3 lean-regen-check.pyz
python3 lean-regen-check.pyz wrong.jsonl
```

リポジトリから取得した4個の配布ファイルは、同じフォルダーで `shasum -a 256 -c SHA256SUMS`（macOS）または `sha256sum -c SHA256SUMS`（Linux）を実行すると照合できます。

The repository's `SHA256SUMS` covers the two ZIP files, the checker and the sample journal. Individual release pages provide checksums for their own downloads. [日本語ガイド](https://breamresearch.github.io/lean-regen/#ja) · [English guide](https://breamresearch.github.io/lean-regen/#en)
