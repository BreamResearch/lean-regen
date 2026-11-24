# Knot の勘定・取引モデル / Account and posting model

1つの予算・工数プールに、同じ取引で複数の明細が届く場合を扱います。たとえば100万円のプールで40万円を別の発注に確約していると、40万円の支出は1件なら通ります。40万円を2件合算すると残高は20万円となり、取引全体を拒否します。受領側にも仕訳は立ちません。

Knot checks the aggregate movement against each participating account. From a budget of 100 with 40 committed, either outgoing request for 40 fits on its own. Combining the two would leave 20, so the entire posting retains its previous balances. This case appears in `cases.json`.

## 入出力 / Interface

`knotCheck row` takes 14 nonnegative decimal integers in this order. `closed` and `locked` accept 0 or 1. An account with any outgoing budget or time needs to be unlocked. A locked account can receive funds or time. Every participating account must have an open period.

```
budget hours budgetIn hoursIn budgetOut hoursOut minBudget minHours maxBudget maxHours committedBudget committedHours closed locked
```

予算・時間はそれぞれ独立の整数単位で計算します。入出金・工数を差し引いた残高の下限は「最低確保量」と「確約済み量」の大きい方です。受理には両方の残高が各上限以内であることも必要です。

The row command returns `accepted`, the failed rule codes in order, and the resulting `budget` and `hours`. `knotCheck batch CURRENT EXPECTED` followed by one or more 14-field rows also checks the expected revision and whether total inflows equal total outflows for each resource. A successful batch increments the revision once. A rejection preserves every row and its revision. The native CLI requires at least one participating row.

## 再検査 / Reproduce

Use Python 3.9+ and official Lean/Lake 4.19.0. Run from this directory. On Apple Silicon macOS 27, use Xcode's native linker by first setting `export CCC_OVERRIDE_OPTIONS='+--ld-path=/usr/bin/ld'` and `export MACOSX_DEPLOYMENT_TARGET=27.0`.

```sh
python3 verify.py --tool-bin /absolute/path/to/lean-4.19.0/bin --out ../new-knot-evidence.json
```

ネイティブCLIを手元で使うには、同じツールチェーンの `lake build` をこのディレクトリで実行します。The trusted toolchain’s `lake build` produces `.lake/build/bin/knotCheck`. These examples print the rule program and the rejected donor account above.

```sh
.lake/build/bin/knotCheck policy
.lake/build/bin/knotCheck row 100 80 0 0 80 40 10 10 110 90 40 15 0 0
```

`Knot/Specification.lean` defines the six obligations independently of the executable rule expressions in `Knot/Policy.lean`. `Knot/Batch.lean` defines revision checking, resource balance and the atomic abstract posting. `Contract.lean` fixes 13 exact theorem statements. `verify.py` uses a fresh build, checks the statements and axiom lists, compares the native policy export with `policy.json` byte for byte, exercises the examples, and checks that altered candidates fail the unchanged proofs. `evidence.json` records the results and hashes. The exported expressions use exact natural-number arithmetic, including intermediate sums.

## 証明の対象 / Claim boundary

形式モデルは、取引の全明細が現在の予算プール・会計期間などのキーで正しく集計され、対象勘定が重複なく1行ずつ渡されたところから始まります。予算／工数が個別に釣り合う全行を同時に更新し、受理済みの旧版番号で再度計上する要求を拒否することを示しています。最新のDB残高、集計、識別子、SQLiteの排他制御、承認者、ERP接続、通貨換算、プールごとのスキル互換性は別に検査する事項です。

The composition proof assumes one correctly joined, current row per participating account and a single applicable revision. Conservation applies separately to the budget and hours across those rows. Real account-key matching, complete line capture, concurrent database transactions and ERP integration need their own checks. The browser interprets the exported rule program. The proof recorded here was checked by native Lean; parity of another interpreter is tested separately.
