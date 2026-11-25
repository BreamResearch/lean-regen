# Knot · 負荷に応じた台帳移行 / Adapting a ledger migration to load

Odoo Community に振替を書き込みながら、Knot が読む台帳を切り替えます。同じ負荷で、転記を固定4,000行で行う方式、書き込みの負荷に応じて転記を調整する方式、その自動調整にローカルLLMの切替助言を加える方式を比較しました。

Knot switches the ledger it reads while Odoo Community receives transfers. The experiment compares fixed 4,000-row backfill batches, feedback-controlled backfill, and the same feedback controller with an offline model advising on cutover timing.

[日本語デモ](https://breamresearch.github.io/lean-regen/knot/erp-benchmark/suspension/) · [English demo](https://breamresearch.github.io/lean-regen/knot/erp-benchmark/suspension/?lang=en) · [全実行の測定データ / Raw measurements](evidence.json)

## 実測結果 / Measured results

Odoo Community 18.0-20261112 を使った9試行の結果です。各欄は3回の中央値です。The table shows the median of three trials for each strategy on the same runner. [GitHub Actions run](https://github.com/BreamResearch/lean-regen/actions/runs/45531754049)

| 測定項目 / Metric | 固定4,000行 / Fixed | 自動調整 / Adaptive | 自動調整＋LLM / Adaptive + LLM |
| --- | ---: | ---: | ---: |
| 転記時間 / Backfill elapsed | 2.022 s | 2.029 s | 2.014 s |
| 到着予定からOdoo応答まで p95 / Scheduled arrival to acknowledgement p95 | 140.9 ms | 122.7 ms | 152.7 ms |
| 到着予定からOdoo応答まで p99 / Scheduled arrival to acknowledgement p99 | 1,483.3 ms | 1,284.9 ms | 1,395.5 ms |
| 切替トランザクション / Cutover transaction | 0.501 s | 0.501 s | 0.495 s |
| 切替判断でモデルを待った時間 / Wait for model advice | 0.000 s | 0.000 s | 1.816 s |
| 移行開始から切り戻し後の照合まで / Migration through rollback audit | 18.208 s | 18.149 s | 19.738 s |

このランナーでは自動調整も全試行で4,000行を維持しました。この表の書き込み応答の差には試行間のばらつきが含まれます。LLM は負荷中の3回すべてで規則と同じ「切替を試す」を返し、推論待ちは中央値1.816秒でした。

The adaptive controller stayed at 4,000 rows in all trials on this runner. The latency differences in the table include trial-to-trial variation. All three live model calls recommended the same action as the structured rule and added a median 1.816 seconds of model wait.

### 転記サイズが変わった実行 / Run that changed the batch size

別の標準ランナーでも同じ到着時刻表を使いました。自動調整の両方式は、全試行で2,000行に下げて4,000行に戻す調整を行いました。以下は各方式3回の中央値です。先行実行から最終版へのソース変更は、切替を見送った場合の報告項目だけです。両実行で全試行が切替を完了したため、この変更は計測した制御に影響していません。A second standard runner received the same scheduled arrivals. Both adaptive arms used batches of 2,000 and 4,000 rows in each trial. The source change between runs only affects how the report describes a cutover that was deferred outright. Every trial in both runs cut over under load. [Second GitHub Actions run](https://github.com/BreamResearch/lean-regen/actions/runs/45531274367)

| 測定項目 / Metric | 固定4,000行 / Fixed | 自動調整 / Adaptive | 自動調整＋LLM / Adaptive + LLM |
| --- | ---: | ---: | ---: |
| 転記時間 / Backfill elapsed | 3.647 s | 3.625 s | 3.694 s |
| 到着予定からOdoo応答まで p95 / Scheduled arrival to acknowledgement p95 | 263.4 ms | 284.3 ms | 478.0 ms |
| 到着予定からOdoo応答まで p99 / Scheduled arrival to acknowledgement p99 | 1,845.1 ms | 1,810.9 ms | 1,757.1 ms |
| 切替判断でモデルを待った時間 / Wait for model advice | 0.000 s | 0.000 s | 3.240 s |

刻みの変更は機能しました。利用者の待ち時間は指標と試行によって優劣が変わりました。二つの実行を通じ、LLM の助言は6回すべて共通規則と一致しました。自動調整だけの場合と同じ反復で比べると、LLM を加えた場合は、切り戻しと事後照合までの時間が6回すべて長くなりました。

The controller adjusted its batch size as designed. User latency varied by percentile and repeat. Across both runs, all six live model replies agreed with the shared rule. In every matched repeat, adding model advice took longer to reach the end of the rollback audit.

運用メモの試験は期待判断を先に確定した10件で、うち1件は共通の必須検査で拒否しました。残る9件は実際に推論し、一致はLLM 3/9、構造化規則 6/9、キーワードを加えた規則 7/9 でした。モデルは延期すべき6件でも進行を提案しました。**このモデルと条件では、切替判断にLLMを加える実用上の利点は確認できませんでした。**

One of the ten labelled situations was blocked by the shared mandatory check. On the nine cases where the model actually ran, its advice matched the expected action on 3/9 cases, compared with 6/9 for the structured rule and 7/9 for the rule plus keywords. Six model answers advised proceeding when the fixture expected a deferral. **This experiment found no practical advantage from adding this model to the cutover decision.**

18試行すべてで負荷中の切替と後続の書き込みを確認し、切り戻し後に元の10万行の全列と、各試行で追加した1,968行の金額・工数・勘定・作成者まで照合しました。各試行で意図的な1単位の不一致は切替を拒否しました。All 18 trials exercised cutover and later writes under offered load. Rollback retained the complete opening history and all 1,968 new native lines per trial. Every injected one-unit discrepancy blocked cutover. [Raw reports](evidence.json)

## 実験方法 / Experiment design

- **同じ開始状態 / Same starting state.** Odoo の ORM が作成した10万行を含むデータベースを複製し、同じ履歴、同じ分析勘定、同じ権限で各方式を始めます。Each trial starts with a fresh clone of the same Odoo database, including its 100,000 native analytic lines, accounts and users.
- **同じ投入負荷 / Same offered load.** 8人分の要求を先に時刻付きで作り、各方式に同じ並びで投入します。44秒間に984件を、毎秒16 → 32 → 8 → 32 → 16件の順で投入します。応答待ちで遅れた要求も計測に含めます。同じ環境で各方式を3回、順番を入れ替えて実行します。All trials receive the same 984 scheduled requests from eight clients across 44 seconds. The offered rate moves through 16, 32, 8, 32 and 16 requests per second. End-to-end latency starts at the scheduled arrival, including any queue time. Each strategy runs three times in rotating order on the same host.
- **同じ切替条件 / Same cutover checks.** 3方式で、欠落や差分があると切替を拒否し、書き込まれた明細を Odoo の原本と照合します。LLM の出力は切替を試す時刻の助言に使い、切替は既存の検査を通過したときに実行します。All three strategies use the same Odoo-to-Knot reconciliation and the same transaction gate. The model can advise on timing within those conditions.
- **実運用に関する判断 / Operational decisions.** 切替時刻を選ぶ能力は、実際の Odoo 負荷中の判断と、答えを事前に定めた運用メモの問題で確認します。We evaluate advice during live Odoo writes and separately score operational notes with predeclared expected answers.

固定方式と自動調整方式は、同じ決定ルールで切替を試みます。自動調整では、転記1回の時間、書き込みの待ち行列、直近の応答時間に応じ、500〜4,000行の間で刻みを変えます。LLM 方式も同じ自動調整を使います。共通ルールが許可してからモデルを呼び、推論後の負荷を再確認します。LLM は追加の延期を提案できます。切替可能な時間が過ぎれば、旧台帳を読み続けます。

Fixed and adaptive batching share the same cutover rule. The feedback controller adjusts between 500 and 4,000 rows per batch using copy duration, queue depth and recent write latency. The model-assisted strategy uses that same controller. It consults the model only when the shared rule permits an attempt and rechecks load after inference. The model can recommend an additional deferral. If the attempt window expires, the legacy read path stays active.

切替対象は Knot の参照台帳です。試験は、別々の分析勘定ペアに書き込む利用者を使います。結果は、測定した合成データ、実行環境、運用メモ、モデルの組み合わせに対するものです。The migration changes Knot's ledger representation. Each trial writer uses a distinct pair of analytic accounts. The results apply to the measured synthetic traffic, hardware, operational notes and model. [共通の業務規則 / Frozen Knot policy](../../formal/policy.json) · [既存の切替・切り戻し / Original cutover and recovery](../README.md)

## 再現する / Reproduce the comparison

Linux x86-64 で、Docker デーモンと Python 3.12、および初回ダウンロード用のネット接続を用意します。スクリプトが専用の Odoo と PostgreSQL を作成し、完了時に試験環境を片付けます。モデルと実行ファイルを取得してハッシュを照合した後、推論はローカルCPUで実行します。外部推論 API や登録は不要です。

Start with a Docker daemon, Python 3.12 and network access on Linux x86-64. The launcher creates and removes a disposable Odoo/PostgreSQL environment. The bootstrap checks the pinned downloads. Inference then runs on the local CPU without a hosted model API or account.

```sh
git clone https://github.com/BreamResearch/lean-regen.git
cd lean-regen/docs/knot/erp-benchmark
python3.12 -m venv .venv
.venv/bin/python -m pip install --only-binary=:all: --require-hashes -r requirements.txt
export KNOT_MODEL_CACHE="$PWD/.model-cache"
.venv/bin/python suspension_model.py --prepare --cache "$KNOT_MODEL_CACHE"
.venv/bin/python suspension_launcher.py -- .venv/bin/python suspension.py \
  --out comparison.json --rows 100000 --writers 8 --repeats 3
.venv/bin/python suspension_model.py --evaluate --out decision-cases.json
```

上書きしないよう、新しい結果ファイル名を指定してください。GitHub 上では公開リポジトリの標準ランナーで再現できます。Choose fresh paths for the two reports. The workflow uses a standard public GitHub runner. [Benchmark source](../suspension.py) · [Pinned model and CPU runtime](../suspension_model_lock.json) · [Frozen decision cases](../suspension_model_cases.json) · [Workflow](../../../../.github/workflows/knot-suspension.yml)

モデルは公式の Qwen2.5-0.5B-Instruct Q4_K_M、推論は llama.cpp のCPU版です。公開リポジトリにはソース、依存先のハッシュと測定結果を含みます。The experiment uses the official Qwen2.5-0.5B-Instruct Q4_K_M weights and a pinned CPU build of llama.cpp. Both are fetched from their publishers. [Qwen license](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/9217f5db79a29953eb74d5343926648285ec7e67/LICENSE) · [llama.cpp license](https://github.com/ggml-org/llama.cpp/blob/82dd9704742e8514088914b61d61fbcd35d599ee/LICENSE)
