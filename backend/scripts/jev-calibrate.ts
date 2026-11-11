// Phase-6 calibration helper: read .jev/runs/*.jsonl and show, per decision node, what
// Jev answered (shadow or live) next to how the run ended, so each THRESHOLD in
// lib/fleet/workflow.ts can be set from logged data instead of guessed.
//
//   npm run fleet:calibrate                # all runs in .jev/runs
//   npm run fleet:calibrate -- --dir path  # another log dir
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`)
  return i === -1 ? undefined : argv[i + 1]
}
const dir = flag('dir') ?? '.jev/runs'

type Ans = { type: 'choice'; choice: string; confidence: number } | { type: 'noul'; noul: number } | { type: 'score'; score: number }
interface JevAnswerEvent { type: 'jev.answer'; run_id: string; node: string; answers: Record<string, Ans>; latency_ms: number; model: string }
interface ShadowEvent { type: 'shadow'; records: Array<{ questions: Record<string, unknown>; real: Record<string, Ans> | null; latency_ms: number }> }
interface EndEvent { type: 'run.end'; run_id: string; status: string }
interface StateEvent { type: 'state'; run_id: string; state: { output?: { approval?: string | null; status?: string; rubric?: { pass: boolean } | null } } }
type Ev = JevAnswerEvent | ShadowEvent | EndEvent | StateEvent | { type: string; run_id?: string }

interface Row { run: string; node: string; mode: Ans['type']; bucket: string; p: number | null; shadow: boolean; outcome: string; fleetStatus: string; approval: string; rubricPass: boolean | null; latency_ms: number }

const rows: Row[] = []
let files = 0
let dirEntries: string[] = []
try {
  dirEntries = readdirSync(dir)
} catch {
  console.log(`no log dir ${dir}. Run the fleet first (npm run fleet:demo, or FLEET_MODE=shadow on /api/research).`)
  process.exit(0)
}

for (const f of dirEntries.filter((x) => x.endsWith('.jsonl'))) {
  files++
  const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev)
  const isRoot = (e: { run_id?: string }) => !!e.run_id && !e.run_id.includes('.')
  const end = lines.find((e): e is EndEvent => e.type === 'run.end' && isRoot(e))
  const finalState = [...lines].reverse().find((e): e is StateEvent => e.type === 'state' && isRoot(e))
  const out = finalState?.state.output
  const shadowRecs = lines.find((e): e is ShadowEvent => e.type === 'shadow')?.records ?? []
  // Shadow records are appended in ask() order; jev.answer events with a shadow(...) model
  // appear in the same order, so pair them by index.
  let shadowIdx = 0
  for (const e of lines.filter((e): e is JevAnswerEvent => e.type === 'jev.answer')) {
    const shadow = String(e.model).startsWith('shadow(')
    const real = shadow ? shadowRecs[shadowIdx++]?.real ?? null : null
    for (const [id, forced] of Object.entries(e.answers)) {
      if (id.startsWith('x:')) continue
      const a = (shadow ? real?.[id] : forced) ?? null
      if (!a) continue
      const p = a.type === 'choice' ? a.confidence : a.type === 'noul' ? a.noul : a.score
      const bucket = a.type === 'choice' ? a.choice : a.type === 'noul' ? `p ${(Math.floor(a.noul * 10) / 10).toFixed(1)}–${(Math.floor(a.noul * 10) / 10 + 0.1).toFixed(1)}` : `level≈${Math.round(a.score)}`
      rows.push({ run: e.run_id, node: e.node, mode: a.type, bucket, p, shadow, outcome: end?.status ?? '?', fleetStatus: out?.status ?? '?', approval: out?.approval ?? '-', rubricPass: out?.rubric?.pass ?? null, latency_ms: shadow ? shadowRecs[shadowIdx - 1]?.latency_ms ?? e.latency_ms : e.latency_ms })
    }
  }
}

if (!rows.length) {
  console.log(`no decisions found in ${dir} (${files} files). Run the fleet first.`)
  process.exit(0)
}

const byNode = new Map<string, Row[]>()
for (const r of rows) byNode.set(r.node, [...(byNode.get(r.node) ?? []), r])
console.log(`${files} runs · ${rows.length} decisions · ${rows.filter((r) => r.shadow).length} recorded in shadow\n`)
for (const [node, rs] of byNode) {
  const ps = rs.map((r) => r.p).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
  const q = (f: number) => (ps.length ? ps[Math.min(ps.length - 1, Math.floor(f * ps.length))].toFixed(2) : '-')
  const lat = rs.map((r) => r.latency_ms).sort((a, b) => a - b)
  console.log(`▸ ${node} (${rs[0].mode}) · n=${rs.length} · p10/p50/p90 = ${q(0.1)}/${q(0.5)}/${q(0.9)} · latency p50 ${lat[Math.floor(lat.length / 2)]}ms`)
  const buckets = new Map<string, Row[]>()
  for (const r of rs) buckets.set(r.bucket, [...(buckets.get(r.bucket) ?? []), r])
  for (const [k, sub] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const clean = sub.filter((r) => r.outcome === 'succeeded' && r.fleetStatus === 'complete' && r.rubricPass !== false).length
    console.log(`    ${k.padEnd(20)} n=${String(sub.length).padStart(3)}   clean runs ${clean}/${sub.length}   approval: ${[...new Set(sub.map((r) => r.approval))].join(',')}`)
  }
}
console.log('\nRead: for each Noul gate, the probability band where "clean runs" flips is where its threshold belongs.\nEdit THRESHOLDS in lib/fleet/workflow.ts, re-run, compare. Pin JEV_MODEL when you do — levels shift between Jev versions.')
