# ライセンスと第三者の表記 · Licenses and third-party notices

## 配布物の再利用 · Reusing the downloads

このプロジェクトが作成したコード、仕様、証明、合成のテストデータ、文書はApache License 2.0で配布しています。照合器とソースZIPに `LICENSE`、`NOTICE`、第三者の表記を収録しています。商用利用と改変が可能です。再配布時にはライセンス本文を添え、該当する帰属表示を保持し、変更したファイルには変更の旨を明記してください。

Project-authored code, specifications, proofs, synthetic test fixtures and documentation are distributed under Apache License 2.0. The checker and source archives include the license and attribution notices. Commercial use and modification are permitted. When redistributing, include the license, retain applicable notices and identify modified files. The source archives include the original project's attribution for the preserved Lean Verified SDLC 1.0.0 examples. [Project license](https://github.com/BreamResearch/lean-regen/blob/454e9b5581785e82107db88f064b6e65b643f43c/LICENSE) · [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.html)

## 実行環境 · Runtime and build tools

`lean-regen-check.pyz` はソースと参照データを収めたPython用アーカイブです。通常の照合は手元のPythonで実行します。追加の入力をネイティブモードで照合する場合は、利用者が用意したLean/Lake 4.19.0で在庫モデルをビルドします。PythonやLeanの実行ファイルは、この照合器・ソースZIPには同梱していません。

The checker runs with the user's Python interpreter. Its optional native mode builds the supplied inventory model with Lean/Lake 4.19.0. The separate proof-comparison example in the checker source archive uses Lean 4.36.0. The Lean proof assistant is licensed under Apache-2.0. Its toolchain distributions include other components, among them LLVM under Apache-2.0 with the LLVM exceptions and GNU MP under LGPLv3. Redistribution of a toolchain, prebuilt executable or container must account for the actual components distributed and linked. [Lean 4.19.0 license](https://github.com/leanprover/lean4/blob/v4.19.0/LICENSE) · [4.19.0 component notices](https://github.com/leanprover/lean4/blob/v4.19.0/LICENSES) · [Lean 4.36.0 license](https://github.com/leanprover/lean4/blob/v4.36.0/LICENSE) · [4.36.0 component notices](https://github.com/leanprover/lean4/blob/v4.36.0/LICENSES)

SQLiteの例は、Pythonの `sqlite3` モジュールを通じて、利用者の環境にあるSQLiteを呼び出します。公開CIが使用するGitHubのcheckoutアクションにも独自のライセンスが適用されます。

The SQLite examples use the host's SQLite implementation through Python's `sqlite3` module. Hosted builds fetch GitHub's MIT-licensed checkout action separately. [Python license](https://docs.python.org/3/license.html) · [SQLite copyright](https://www.sqlite.org/copyright.html) · [Checkout action license](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/LICENSE)

## 名称 · Names

BreamResearchが提供する独立したプロジェクトです。リポジトリ名の「Lean」はLean証明支援系との互換性を示します。Leanの名称とロゴにはLean FROの商標方針が適用されます。

This independent project is distributed by BreamResearch. The repository name refers to compatibility with the Lean proof assistant. Lean FRO's trademark policy governs use of the Lean name and logos. [Lean trademark policy](https://lean-lang.org/trademark-policy/)
