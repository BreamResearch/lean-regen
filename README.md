# Lean Regen

予約枠の仕様を固定し、実装を変えても「いつ予約が成功するか」「拒否したときに状態が変わらないか」「数量が保存されるか」をLeanで再検査するOSSです。登録・支払いは不要です。BreamResearchによる独立したプロジェクトです。

## アルファ版を試す

[v0.2.0-alpha.2 ソースZIP](./lean-regen-v0.2.0-alpha.2-source.zip?raw=1) を展開し、ソースのルートディレクトリで実行してください。Python 3.11以上と、公式のLean/Lake 4.19.0を使用します。

```sh
python3 scripts/leanregen.py check-upstream
python3 scripts/leanregen.py demo --tool-bin /absolute/path/to/lean-4.19.0/bin --workdir ../lean-regen-demo-001
```

ZIPのSHA-256は `3894eac56d6392930e20ec4321a1daf96dfa7c66a690923a75b014758292b6dc` です。固定した在庫モデルの14定理を再検査し、3種類の誤った変更が拒否されることを確認しました。[検査記録](./core-check.json) · [ファイル一覧](./manifest.json) · [リリースノート](./RELEASE-NOTES.md)

## Git履歴と開発版

[Gitバンドル](./lean-regen.git.bundle?raw=1) にはアルファ版のソースと注釈付きタグ、開発ブランチ `codex/post-alpha` の完全な履歴があります。手元で次のように開けます。

```sh
git clone -b main ./lean-regen.git.bundle lean-regen-src
git -C lean-regen-src rev-parse 'v0.2.0-alpha.2^{commit}'
git -C lean-regen-src switch codex/post-alpha
```

タグのコミットは `80a86efab6e6d678d7ae839811a2fb95352ddbbd` です。開発版にはLean 4.36.0での6カーネル検査、更新候補の生成と開発用署名、SQLite接続の実装と実行記録があります。自動での本番配布、一般向け登録、有料サービスは稼働していません。

本プロジェクトはApache-2.0です。Lean本体やコンパイル済み実行ファイルはソースZIPに同梱していません。[ライセンス](./LICENSE) · [第三者の権利表記](./THIRD_PARTY_NOTICES.md)
