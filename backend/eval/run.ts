// Eval harness for drift detection. Runs every labeled example through the REAL
// production agent (lib/agents.runDrift) and scores it. Writes a markdown scorecard.
//
//   npm run eval            # full set, production model (Opus)
//   npm run eval -- --fast  # cheaper/faster iteration (Sonnet)
//   npm run eval -- --limit 6
import { readFileSync, writeFileSync } from 'node:fs'
import { DATASET, type EvalExample } from './dataset.js'
import type { DriftReport } from '../lib/shared.js'

// Load .env.local before importing the agent (it constructs the client at load).
try {
  const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) process.env[m[1]] ??= m[2]
  }
} catch {
  /* rely on ambient env */
}

const { runDrift } = await import('../lib/agents.js')

const argv = process.argv.slice(2)
const FAST = argv.includes('--fast')
const limitArg = argv.indexOf('--limit')
const LIMIT = limitArg !== -1 ? Number(argv[limitArg + 1]) : Infinity
const opts = FAST ? { model: 'claude-sonnet-4-6', effort: 'medium' as const } : {}
const examples = DATASET.slice(0, LIMIT)

// A dropped specific is "detected" if all its word tokens appear anywhere in the
// report (droppedSpecifics + change fields + summary). Lenient on phrasing, strict
// on presence.
function specificDetected(spec: string, report: DriftReport): boolean {
  const blob = [
    report.summary,
    report.droppedSpecifics.join(' '),
    report.changes.map((c) => `${c.field} ${c.before} ${c.after} ${c.impact}`).join(' '),
  ]
    .join(' ')
    .toLowerCase()
  const tokens = spec.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return tokens.length > 0 && tokens.every((t) => blob.includes(t))
}

interface Row {
  ex: EvalExample
  got: boolean | null
  correct: boolean
  specMatched: number
  specTotal: number
  error?: string
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

const started = Date.now()
console.log(`\nRunning drift eval — ${examples.length} examples · model=${FAST ? 'claude-sonnet-4-6' : 'claude-opus-4-8'}\n`)

const rows = await pool<EvalExample, Row>(examples, 5, async (ex) => {
  try {
    const report = await runDrift(ex.baseline, ex.current, opts)
    const got = report.changed
    const correct = got === ex.expected.changed
    const specTotal = ex.expected.droppedSpecifics.length
    const specMatched = ex.expected.droppedSpecifics.filter((s) => specificDetected(s, report)).length
    const mark = correct ? '✓' : '✗'
    const spec = specTotal ? ` · specifics ${specMatched}/${specTotal}` : ''
    console.log(`  ${mark} ${ex.id} [${ex.category}] expected=${ex.expected.changed} got=${got}${spec}`)
    return { ex, got, correct, specMatched, specTotal }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.log(`  ⚠ ${ex.id} ERROR: ${error}`)
    return { ex, got: null, correct: false, specMatched: 0, specTotal: ex.expected.droppedSpecifics.length, error }
  }
})

// ---- aggregate metrics ----
let TP = 0, FP = 0, TN = 0, FN = 0, specMatched = 0, specTotal = 0, errors = 0
for (const r of rows) {
  if (r.error) errors++
  if (r.got === null) continue
  const exp = r.ex.expected.changed
  if (exp && r.got) TP++
  else if (!exp && r.got) FP++
  else if (!exp && !r.got) TN++
  else FN++
  if (exp) {
    specMatched += r.specMatched
    specTotal += r.specTotal
  }
}
const pct = (n: number, d: number) => (d ? (100 * n) / d : 0)
const precision = pct(TP, TP + FP)
const recall = pct(TP, TP + FN)
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
const accuracy = pct(TP + TN, TP + TN + FP + FN)
const fpRate = pct(FP, FP + TN)
const specRecall = pct(specMatched, specTotal)
const elapsed = ((Date.now() - started) / 1000).toFixed(0)

const fmt = (n: number) => n.toFixed(1)
console.log(`
── Drift-detection scorecard ─────────────────────────
  Accuracy            ${fmt(accuracy)}%   (${TP + TN}/${TP + TN + FP + FN})
  Precision           ${fmt(precision)}%
  Recall              ${fmt(recall)}%
  F1                  ${fmt(f1)}
  False-positive rate ${fmt(fpRate)}%   (cosmetic changes wrongly flagged)
  Dropped-spec recall ${fmt(specRecall)}%   (${specMatched}/${specTotal})
  Confusion           TP=${TP} FP=${FP} TN=${TN} FN=${FN}${errors ? `  errors=${errors}` : ''}
  Wall time           ${elapsed}s
──────────────────────────────────────────────────────
`)

// ---- write artifacts ----
const scorecard = `# Drift-detection eval scorecard

Model: \`${FAST ? 'claude-sonnet-4-6' : 'claude-opus-4-8'}\` · ${examples.length} labeled examples · ${elapsed}s

| Metric | Value |
|---|---|
| Accuracy | ${fmt(accuracy)}% (${TP + TN}/${TP + TN + FP + FN}) |
| Precision | ${fmt(precision)}% |
| Recall | ${fmt(recall)}% |
| F1 | ${fmt(f1)} |
| False-positive rate | ${fmt(fpRate)}% |
| Dropped-spec recall | ${fmt(specRecall)}% (${specMatched}/${specTotal}) |
| Confusion | TP=${TP} FP=${FP} TN=${TN} FN=${FN} |

## Per-example

| id | category | expected | got | pass | specifics |
|---|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| ${r.ex.id} | ${r.ex.category} | ${r.ex.expected.changed} | ${r.error ? 'ERROR' : r.got} | ${
        r.correct ? '✓' : '✗'
      } | ${r.specTotal ? `${r.specMatched}/${r.specTotal}` : '—'} |`
  )
  .join('\n')}

_The hard cases are the \`cosmetic-nochange\` / \`identical\` rows: the false-positive rate measures whether the agent correctly stays silent when word order or punctuation changes but every selling specific is intact._
`
writeFileSync(new URL('./SCORECARD.md', import.meta.url), scorecard)
writeFileSync(
  new URL('./results.json', import.meta.url),
  JSON.stringify(
    { model: FAST ? 'claude-sonnet-4-6' : 'claude-opus-4-8', accuracy, precision, recall, f1, fpRate, specRecall, TP, FP, TN, FN, rows: rows.map((r) => ({ id: r.ex.id, expected: r.ex.expected.changed, got: r.got, correct: r.correct, specMatched: r.specMatched, specTotal: r.specTotal, error: r.error })) },
    null,
    2
  )
)
console.log('Wrote eval/SCORECARD.md and eval/results.json\n')
