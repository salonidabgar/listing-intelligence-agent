# Fleet benchmark — decision layer swapped, everything else identical

2026-11-11T16:59:52.237Z · labels: eval/fleet-cases.ts (12 listings, 8 gate cases, 4 rubric cases) · thresholds: lib/fleet/workflow.ts

| router | model | lens bundle exact | acceptable | unsure | quality in range | risk in range | research gate | draft rubric | p50 / p95 | USD per decision |
|---|---|---|---|---|---|---|---|---|---|---|
| jev | jev-1.13.0 | 50% | 75% | 1 | 75% | 92% | 88% | 75% | 409 / 662 ms | $0.000222 |
| claude-opus-5-5 | claude-opus-5-5 | 58% | 75% | 2 | 75% | 92% | 88% | 75% | 2210 / 3448 ms | $0.006934 |

"acceptable" counts the labeler's alternative bundle as correct. "heuristic" is the keyless lexical stand-in — a floor, not a router.


Caveats: one pass, small n, labels by one person. Trust the order-of-magnitude latency/cost gaps; treat accuracy parity as suggestive.
