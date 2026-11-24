# 配布物を選ぶ · Choose a download

## 同じ仕様で実装を比べる · Compare implementations under one contract

加算の順序を変えた予約処理と、残り枠の全数予約を拒否する予約処理は、同じ業務仕様を満たすでしょうか。設計例は、元の実装と2つの変更例を同じ14の証明条件で比較する手順を示します。

The reference design compares the original implementation, a rewrite that reverses the order of addition, and a change that rejects exact-fill reservations. You can reuse the pattern to compare implementations of your own contract. The guide includes the download and build instructions. [設計例 / Reference design release](https://github.com/BreamResearch/lean-regen/releases/tag/reference-design-v0.1.0-alpha.1)

## 予約アプリの記録を検査する · Check a booking log

自分のアプリの予約・解放履歴を、期待される応答と照合できます。Python 3.9以上で `lean-regen-check.pyz` を実行すると、同梱された正常例の16操作がすべて一致します。サンプルの `wrong.jsonl` を渡すと、残り8枠の全数予約を誤って拒否した4操作目が見つかります。

Use the checker to compare an application's decisions and committed inventory balances with a fixed reference. Download the checker and sample to the same directory, then run them with Python 3.9 or later. Both examples run offline without registration. [照合器とサンプル / Checker and sample, v0.1.0-alpha.1](https://github.com/BreamResearch/lean-regen/releases/tag/inventory-check-v0.1.0-alpha.1)

```sh
python3 lean-regen-check.pyz
python3 lean-regen-check.pyz wrong.jsonl
```

## 在庫モデルの証明を再現する · Reproduce the inventory proofs

ソースZIPには、逐次的な在庫予約・解放の仕様、実装、証明が入っています。Python 3.11以上とLean/Lake 4.19.0で14の定理を検査でき、拒否された3種類の変更も確認できます。公開時のファイル一式を照合するには、同じリリースの5ファイルすべてを同じディレクトリに保存します。

The source alpha includes the inventory model, its proofs, the recorded Lean kernel report and a per-file manifest. To reproduce the release's original checksums, download all five attached assets from this versioned release into one directory. Its `SHA256SUMS` covers the four accompanying files, including its original release notes. [ソースと公開時の照合値 / Source and original checksums, v0.2.0-alpha.2](https://github.com/BreamResearch/lean-regen/releases/tag/v0.2.0-alpha.2-dist.1)

このリポジトリのルートにある `SHA256SUMS` は、この案内と隣接する3ファイルを照合します。The repository's root checksum list covers this guide and the adjacent source ZIP, manifest and kernel report.
