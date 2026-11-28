# Knot · 振替判定を機械語まで落とす / From transfer rules to machine code

Knot が Odoo に振替を書き込む直前の6つの判定を、固定幅の整数演算に落としました。従来はキャッシュ済みの JSON 規則を使い、呼び出しごとに式の木をたどって拒否理由を求めていました。C 版は6つの結果を6ビットで返します。Python 側は同じ API、理由の順序、残高を維持し、32ビットを超える振替金額・工数は従来の任意精度の経路で扱います。

Knot's Odoo adapter normally interprets a JSON rule tree for each source and destination account. The fixed-word C implementation uses six bits for the same six rule outcomes. The Python boundary preserves validation, ordered rejection reasons and returned balances. Transfers outside the word representation retain the original arbitrary-precision path.

[日本語の測定ページ](https://breamresearch.github.io/lean-regen/knot/erp-benchmark/native/) · [English measurements](https://breamresearch.github.io/lean-regen/knot/erp-benchmark/native/?lang=en) · [実測値・検証記録 / Evidence](evidence.json)

## 実測結果 / Measurements

同じ Apple ARM64 上で、振替4,096件と単口座16,384行をそれぞれ同じ入力で比較しました。以下はウォームアップ後の7反復の中央値です。On the same ARM64 host each implementation received the same fixed inputs. Values are medians across 7 warmed rounds.

| 比較対象 / Work | 実装 / Implementation | 時間 / Time |
| --- | --- | ---: |
| 完全な振替応答 / Full transfer response | Python | 9.50 µs/件 |
| 完全な振替応答 / Full transfer response | C via Python | 2.34 µs/件 |
| 判定ビットの一括計算 / Batch account masks | C | 1.91 ns/口座 |
| 判定ビットの一括計算 / Batch account masks | NumPy 2.3.5, interleaved | 15.95 ns/口座 |
| 判定ビットの一括計算 / Batch account masks | NumPy 2.3.5, contiguous columns | 8.13 ns/口座 |

振替判定の速度比は同じ反復内の中央値で 4.04 倍でした。プロセス最大RSSの中央値は Python 版 26.17 MiB、C を呼ぶ版 26.30 MiB でした。一括処理では列を連続配置した NumPy と比べて 4.27 倍です。NumPy は288 KiBの作業配列を再利用し、列配置への変換で別途896 KiBを使いました。C の一括処理は入力と出力を呼び出し側から受け取り、作業配列を確保しません。

The median of paired speed ratios was 4.04× for the complete transfer response. Median process peak RSS was 26.17 MiB with Python and 26.30 MiB with the C bridge. C batch throughput was 4.27× the NumPy kernel with prearranged columns. NumPy reused 288 KiB of scratch and its one-time column conversion used another 896 KiB. Both measurements reused their input and output buffers. The reported batch time excludes the one-time conversion.

別の共有ライブラリとしてビルドした Lean 生成単口座版は、ARM64 の命令部分が 216 バイト、共有ライブラリ全体が 16,800 バイトで、未解決シンボルは0個です。The Lean-generated ARM64 scalar contains 216 bytes of executable instructions inside a 16,800-byte shared library and has no undefined symbols.

### 実際の Odoo / Live Odoo

Odoo Community 18.0-20261112 で、10万行の同じ開始履歴を各試行に複製し、8人が44秒間に984件を同じ時刻表で要求しました。振替直前の判定処理は各方式の2試行で、p50の中央値が 24.092 → 15.798 µs でした。要求の到着予定から応答までの p95 は、対応する試行ごとに 262.03 → 371.56 ms、289.91 → 292.23 ms でした。RPC、データベース処理、切替中の待ちを含む数値です。 [実測ログ](https://github.com/BreamResearch/lean-regen/actions/runs/46153624406)

In each live trial, eight writers offered 984 transfers over 44 seconds on a clone of the same 100,000-line Odoo history. The median of per-trial guard p50 was 24.092 → 15.798 µs. Paired end-to-end p95 from planned arrival to acknowledgement was 262.03 → 371.56 ms and 289.91 → 292.23 ms. The larger measurement includes RPC, the database, and migration-related waits.

別のランナーで同じバイナリと同じ時刻表を使った実行も確認しました。判定 p50 は 38.287 → 22.708 µs、応答 p95 は 222.32 → 200.61 ms でした。2環境とも判定 p50 は短くなり、判定の経過時間を全呼び出しで足した値は増えました。この合計には並行実行中の待ちも入り、CPU時間とは別の指標です。応答 p95 は実行によって方向が異なり、Odoo 全体での一貫した高速化は確認できませんでした。 [別ランナーの実測ログ](https://github.com/BreamResearch/lean-regen/actions/runs/46153479942)

The repeat used the same binary and arrival schedule. Median guard p50 was 38.287 → 22.708 µs, and end-to-end p95 was 222.32 → 200.61 ms. On both runners the native guard had lower p50 and higher summed per-call elapsed time. That sum includes time spent waiting during concurrent execution. End-to-end p95 moved in different directions across the two measurements.

計8試行で書き込みは全件成功しました。意図的に入れた1単位の不一致は毎回切替を止め、切り戻し後の履歴と追加明細をすべて照合しました。独立した判定試験では8,271行と全64通りの拒否ビット、2口座をまとめる8,192組、完全なアダプター呼び出し1,032件を照合しました。Every offered write across the eight trials was acknowledged. All one-unit discrepancies blocked cutover, and all native and projected histories reconciled after rollback. The separate conformance check covered 8,271 rows, all 64 masks, 8,192 fused pairs and 1,032 full adapter cases. [実測値 / Raw evidence](evidence.json)

## 何を証明したか / What the proof covers

32ビットに入る全ての入力について、固定幅モデルの6ビットを復号すると元の Lean の規則と同じ順序の拒否理由を得ることを証明しました。加算前に64ビットへ拡張し、最大値同士の和でも桁あふれを起こさないことを証明に含めています。歴史的な仕様、公理、検査条件はそのままです。`lake` で別の Lean 実行ファイルを生成し、既存の規則と手書き C の境界を差分検査します。

For all representable input words and Boolean flags, the Lean word model decodes to the original ordered list of violations. The proof widens operands before addition and establishes the exact sum. The original specification and its proof checks are retained. A separately compiled Lean program checks the handwritten C implementation against the rule semantics on the recorded corpus. [Lean proof](../../formal/Knot/Machine.lean) · [C](guard.c) · [C/Python boundary](bridge.py) · [Differential checks](check.py)

Lean が出力した C を加工せずコンパイルし、リンカで対象関数だけ残すと、実際に `knot_word_mask` が残ります。次は ARM64 のその関数から抜粋した実行命令です。`uxtw` は32ビット値をゼロ拡張し、`cmp` と `csel` は比較結果に応じてビットを選びます。The Lean compiler emitted the C function and the system compiler produced these ARM64 instructions after the linker retained that one exported symbol.

```asm
8b20414a  add  x10, x10, w0, uxtw
eb0d015f  cmp  x10, x13
1a8b31eb  csel w11, w15, w11, lo
```

Odoo の測定で使ったのは、送金元と送金先を1回の呼び出しで処理する C 版です。Lean が生成した単口座の共有ライブラリも別にロードして比較しました。The live Odoo exercise uses the fused handwritten C guard. The separately linked Lean-generated scalar was also loaded and checked. [Build the emitted scalar](build_scalar.sh)

## 再現する / Reproduce the measurements

公開リポジトリを取得し、`docs/knot/erp-benchmark` から実行します。Python 3.12、C コンパイラ、Lean 4.19.0 の `bin` ディレクトリを用意します。Odoo の実行には既存の Docker ランチャーと PostgreSQL ドライバーを使います。The host provides Python 3.12, a C compiler and the `bin` directory for Lean 4.19.0. The ERP run uses the existing Docker launcher and PostgreSQL driver. Choose fresh output paths.

```sh
git clone https://github.com/BreamResearch/lean-regen.git
cd lean-regen/docs/knot/erp-benchmark
OUT=$(mktemp -d)
clang -std=c17 -O3 -fPIC -shared -Wall -Wextra -Werror native/guard.c -o "$OUT/guard.so"
sh native/build_oracle.sh /path/to/lean-4.19.0/bin "$OUT/oracle"
sh native/build_scalar.sh /path/to/lean-4.19.0/bin "$OUT/oracle" "$OUT/lean-word.so"
python3.12 -m native.check --library "$OUT/guard.so" \
  --oracle "$OUT/oracle/.lake/build/bin/wordOracle" --lean-scalar "$OUT/lean-word.so" \
  --out "$OUT/checked.json"
python3.12 native/measure.py --library "$OUT/guard.so" --out "$OUT/measured.json" --numpy auto
python3.12 -m venv "$OUT/venv"
"$OUT/venv/bin/python" -m pip install --only-binary=:all: --require-hashes -r requirements.txt
"$OUT/venv/bin/python" suspension_launcher.py -- "$OUT/venv/bin/python" -m native.odoo_benchmark \
  --library "$OUT/guard.so" --out "$OUT/odoo.json" --repeats 2
```

ARM64 macOS 27 のローカル計測では、Lean 4.19.0 の実行ファイルを作る際に Apple のリンカを指定しました。必要な場合は `CCC_OVERRIDE_OPTIONS='+--ld-path=/usr/bin/ld' MACOSX_DEPLOYMENT_TARGET=27.0 sh native/build_oracle.sh …` を使います。NumPy も比較する場合は、計測用の Python 環境に `numpy==2.3.5` を入れ、`--numpy required` を指定します。The macOS ARM64 measurement used Apple’s linker for the Lean 4.19.0 executable. For the NumPy comparison, install `numpy==2.3.5` in the measurement environment and use `--numpy required`. [CPU measurement source](measure.py) · [Live Odoo replay](odoo_benchmark.py) · [Workflow](../../../../.github/workflows/knot-native-policy.yml)
