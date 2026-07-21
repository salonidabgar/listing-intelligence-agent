# Drift-detection eval scorecard

Model: `claude-sonnet-4-6` · 31 labeled examples · 72s

| Metric | Value |
|---|---|
| Accuracy | 96.8% (30/31) |
| Precision | 95.2% |
| Recall | 100.0% |
| F1 | 97.6 |
| False-positive rate | 9.1% |
| Dropped-spec recall | 100.0% (49/49) |
| Confusion | TP=20 FP=1 TN=10 FN=0 |

## Per-example

| id | category | expected | got | pass | specifics |
|---|---|---|---|---|---|
| A1 | dropped-spec | true | true | ✓ | 4/4 |
| A2 | dropped-spec | true | true | ✓ | 2/2 |
| A3 | dropped-spec | true | true | ✓ | 3/3 |
| A4 | dropped-spec | true | true | ✓ | 3/3 |
| A5 | dropped-spec | true | true | ✓ | 4/4 |
| A6 | dropped-spec | true | true | ✓ | 3/3 |
| A7 | dropped-spec | true | true | ✓ | 4/4 |
| A8 | dropped-spec | true | true | ✓ | 2/2 |
| B1 | compliance | true | true | ✓ | 3/3 |
| B2 | compliance | true | true | ✓ | 4/4 |
| B3 | compliance | true | true | ✓ | 2/2 |
| B4 | compliance | true | true | ✓ | 5/5 |
| C1 | cosmetic-nochange | false | false | ✓ | — |
| C2 | cosmetic-nochange | false | false | ✓ | — |
| C3 | cosmetic-nochange | false | false | ✓ | — |
| C4 | cosmetic-nochange | false | false | ✓ | — |
| C5 | cosmetic-nochange | false | false | ✓ | — |
| D1 | identical | false | false | ✓ | — |
| D2 | identical | false | false | ✓ | — |
| E1 | partial-drop | true | true | ✓ | 1/1 |
| E2 | partial-drop | true | true | ✓ | 1/1 |
| E3 | partial-drop | true | true | ✓ | 1/1 |
| F1 | truncation | true | true | ✓ | 3/3 |
| F2 | truncation | true | true | ✓ | 2/2 |
| G1 | adversarial | false | true | ✗ | — |
| G2 | adversarial | false | false | ✓ | — |
| G3 | adversarial | true | true | ✓ | 1/1 |
| G4 | adversarial | true | true | ✓ | — |
| G5 | adversarial | false | false | ✓ | — |
| G6 | adversarial | false | false | ✓ | — |
| G7 | adversarial | true | true | ✓ | 1/1 |

_The hard cases are the `cosmetic-nochange` / `identical` rows: the false-positive rate measures whether the agent correctly stays silent when word order or punctuation changes but every selling specific is intact._
