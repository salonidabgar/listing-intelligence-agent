// Phase-5 benchmark: the decision layer swapped, everything else identical.
//
//   npm run fleet:bench                                   # routers: jev (or heuristic if no key), claude-opus-5-5
//   npm run fleet:bench -- --routers jev,claude-sonnet-5-5,claude-opus-5-5
//   npm run fleet:bench -- --full --cases 3               # ALSO run the whole pipeline (legacy vs fleet) on N
//                                                         # listings with real Claude lenses: wall time + $ per run
//
// Decision accuracy is scored against the hand labels in eval/fleet-cases.ts (lens bundle,
// quality/risk level ranges, research gate usable/not, rubric ready/not). Writes
// eval/fleet-bench.json and eval/FLEET-BENCH.md.
import { readFileSync, writeFileSync } from 'node:fs'
try {
  const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2]
  }
} catch {
  /* ambient env */
}

const { makeJev } = await import('../lib/fleet/shadow.js')
const { ClaudeRouter } = await import('../lib/jev/jev/claude-router.js')
const { client: anthropic } = await import('../lib/claude.js') // shared client: carries ANTHROPIC_WORKSPACE_ID
const { WORKFLOWS, THRESHOLDS } = await import('../lib/fleet/workflow.js')
const { buildView } = await import('../lib/jev/jev/view.js')
const { createState } = await import('../lib/jev/spec/state.js')
const { SAMPLE_LISTINGS, GATE_CASES, RUBRIC_CASES } = await import('../eval/fleet-cases.js')
const { listingText, findingText, planText } = await import('../lib/fleet/lenses.js')
type Jev = import('../lib/jev/jev/types.js').Jev
type Question = import('../lib/jev/jev/types.js').Question

const argv = process.argv.slice(2)
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`)
  return i === -1 ? undefined : argv[i + 1]
}
const FULL = argv.includes('--full')
const N_FULL = Number(flag('cases') ?? 2)
const routerNames = (flag('routers') ?? `${process.env.JEV_API_KEY ? 'jev' : 'heuristic'},claude-opus-5-5`).split(',').map((s) => s.trim()).filter(Boolean)

// USD per 1M tokens (input, output). Jev: input only.
const PRICES: Array<[string, number, number]> = [
  ['jev', 0.042, 0],
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
]
// jev-agent.com bills whole credits per request (ceil(input/1000), min 1) at $9.99 / 50,000; TypeSafe and OpenRouter bill per token.
const onJagent = /jev-agent\.com/.test(process.env.JEV_BASE_URL ?? '')
const cost = (model: string, inTok: number, outTok: number) => {
  if (model.startsWith('jev') && onJagent) return Math.max(1, Math.ceil(inTok / 1000)) * (9.99 / 50_000)
  const p = PRICES.find(([pre]) => model.startsWith(pre))
  return p ? (inTok * p[1] + outTok * p[2]) / 1e6 : NaN
}

class Metered implements Jev {
  calls: Array<{ model: string; latency_ms: number; input_tokens: number; output_tokens: number }> = []
  constructor(private inner: Jev) {}
  async ask(state: unknown, questions: Record<string, Question>) {
    const t = Date.now()
    const res = await this.inner.ask(state, questions)
    this.calls.push({ model: res.model, latency_ms: Date.now() - t, input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 })
    return res
  }
}

function makeRouter(name: string): Jev {
  if (name === 'jev') return makeJev('http')
  if (name === 'heuristic') return makeJev('heuristic')
  if (name.startsWith('claude-')) return new ClaudeRouter({ client: anthropic, model: name, effort: 'low' })
  throw new Error(`unknown router "${name}" (jev | heuristic | claude-<model>)`)
}

// ---- the four decisions, asked exactly as the engine asks them ----
type Node = import('../lib/jev/spec/workflow.js').Node
function node<K extends Node['kind']>(wf: { nodes: Node[] }, id: string, kind: K): Extract<Node, { kind: K }> {
  const n = wf.nodes.find((x) => x.id === id)
  if (!n || n.kind !== kind) throw new Error(`workflow node "${id}" (${kind}) changed`)
  return n as Extract<Node, { kind: K }>
}
const main = WORKFLOWS.main
const assess = node(main, 'assess', 'assess')
const pick = node(main, 'pick_lenses', 'decide')
const gate = node(WORKFLOWS.lensRun, 'gate', 'check')
const rubric = node(WORKFLOWS.draftLoop, 'rubric', 'check')
const riskExtraRaw = assess.extra?.risk
if (riskExtraRaw?.type !== 'score') throw new Error('assess.extra.risk changed')
const riskExtra: { instructions: string; levels: string[] } = riskExtraRaw

const extrasOf = (node: { extra?: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } } | { type: 'score'; instructions: string; levels: string[] }> }): Record<string, Question> =>
  Object.fromEntries(Object.entries(node.extra ?? {}).map(([id, q]) => [`x:${id}`, q.type === 'noul' ? { type: 'noul', instructions: q.instructions, criteria: q.criteria } : { type: 'score', instructions: q.instructions, criteria: q.levels }]))

interface RouterReport {
  model: string
  bundle: { correct: number; acceptable: number; unsure: number; n: number }
  quality: { inRange: number; n: number }
  risk: { inRange: number; n: number }
  gate: { correct: number; n: number }
  rubric: { correct: number; n: number }
  p50_ms: number
  p95_ms: number
  usd_per_decision: number
  calls: number
  errors: string[]
  preds: Record<string, unknown>[]
}

async function benchRouter(name: string): Promise<RouterReport> {
  const m = new Metered(makeRouter(name))
  const r: RouterReport = { model: '?', bundle: { correct: 0, acceptable: 0, unsure: 0, n: 0 }, quality: { inRange: 0, n: 0 }, risk: { inRange: 0, n: 0 }, gate: { correct: 0, n: 0 }, rubric: { correct: 0, n: 0 }, p50_ms: 0, p95_ms: 0, usd_per_decision: 0, calls: 0, errors: [], preds: [] }
  const argmax = (p: Record<string, number>) => Number(Object.entries(p).sort((a, b) => b[1] - a[1])[0][0])

  for (const c of SAMPLE_LISTINGS) {
    try {
      const st = createState({ id: c.id, workflow: main.name, workflow_version: '1', start: main.start, goal: main.goal, input: { listing_text: listingText(c.listing), title_len: c.listing.title.length } })
      const a = await m.ask(buildView(st, { reads: assess.reads }), { assess: { type: 'score', instructions: assess.instructions, criteria: assess.levels }, 'x:risk': { type: 'score', instructions: riskExtra.instructions, criteria: riskExtra.levels } })
      const qa = a.answers.assess, ra = a.answers['x:risk']
      let qLevel: number | null = null, rLevel: number | null = null
      if (qa.type === 'score') { qLevel = argmax(qa.probabilities); r.quality.n++; if (qLevel >= c.expected.quality[0] && qLevel <= c.expected.quality[1]) r.quality.inRange++ }
      if (ra.type === 'score') { rLevel = argmax(ra.probabilities); r.risk.n++; if (rLevel >= c.expected.risk[0] && rLevel <= c.expected.risk[1]) r.risk.inRange++ }
      // the decide node reads the assessments the engine would have stored
      if (qa.type === 'score' && qLevel !== null) st.assessments.quality = { level: qLevel, label: assess.levels[qLevel], score: qa.score, confidence: qa.confidence, probabilities: qa.probabilities, step: 0 }
      if (ra.type === 'score' && rLevel !== null) st.assessments.risk = { level: rLevel, label: riskExtra.levels[rLevel], score: ra.score, confidence: ra.confidence, probabilities: ra.probabilities, step: 0 }
      const d = await m.ask(buildView(st, { reads: pick.reads }), { route: { type: 'choice', instructions: pick.instructions, criteria: Object.fromEntries(Object.entries(pick.options).map(([k, o]) => [k, o.description])) } })
      const da = d.answers.route
      r.bundle.n++
      let chosen = '?'
      if (da.type === 'choice') {
        chosen = da.confidence < THRESHOLDS.lens_pick_min_confidence ? `unsure(${da.choice})` : da.choice
        if (da.confidence < THRESHOLDS.lens_pick_min_confidence) r.bundle.unsure++
        else if (da.choice === c.expected.bundle) { r.bundle.correct++; r.bundle.acceptable++ }
        else if (c.expected.alt?.includes(da.choice as never)) r.bundle.acceptable++
      }
      r.preds.push({ case: c.id, quality: qLevel, risk: rLevel, bundle: chosen, expected: c.expected })
    } catch (e) {
      r.errors.push(`${c.id}: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  for (const g of GATE_CASES) {
    try {
      const st = createState({ id: g.id, workflow: 'lens-run', workflow_version: '1', start: 'selected', goal: WORKFLOWS.lensRun.goal, input: { lens: g.lens, listing_text: g.listing_text } })
      st.facts.finding_text = { value: findingText(g.finding), source: 'code', step: 0, at: '' }
      const res = await m.ask(buildView(st, { reads: gate.reads }), { check: { type: 'noul', instructions: gate.instructions, criteria: gate.criteria }, ...extrasOf(gate) })
      const a = res.answers.check
      if (a.type === 'noul') {
        const got = a.noul >= THRESHOLDS.gate_threshold
        r.gate.n++
        if (got === g.expected) r.gate.correct++
        r.preds.push({ case: g.id, p_usable: a.noul, expected: g.expected })
      }
    } catch (e) {
      r.errors.push(`${g.id}: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  for (const c of RUBRIC_CASES) {
    try {
      const st = createState({ id: c.id, workflow: 'draft-loop', workflow_version: '1', start: 'init', goal: WORKFLOWS.draftLoop.goal, input: { listing_text: c.listing_text, findings_text: c.findings_text, keywords_text: c.keywords_text } })
      st.facts.draft_text = { value: planText(c.draft), source: 'code', step: 0, at: '' }
      const res = await m.ask(buildView(st, { reads: rubric.reads }), { check: { type: 'noul', instructions: rubric.instructions, criteria: rubric.criteria }, ...extrasOf(rubric) })
      // same rule as the draft_score code node: every part past its bar
      const bars = THRESHOLDS.rubric
      const n = (id: string) => { const a = res.answers[`x:${id}`]; return a?.type === 'noul' ? a.noul : NaN }
      const overall = res.answers.check
      const pass = overall.type === 'noul' && overall.noul >= bars.overall && n('grounded') >= bars.grounded && n('keyword_coverage') >= bars.keyword_coverage && n('compliance') >= bars.compliance && n('specificity') >= bars.specificity
      r.rubric.n++
      if (pass === c.expected) r.rubric.correct++
      r.preds.push({ case: c.id, pass, expected: c.expected, parts: { overall: overall.type === 'noul' ? overall.noul : null, grounded: n('grounded'), keyword_coverage: n('keyword_coverage'), compliance: n('compliance'), specificity: n('specificity') } })
    } catch (e) {
      r.errors.push(`${c.id}: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  const lat = m.calls.map((c) => c.latency_ms).sort((a, b) => a - b)
  const q = (f: number) => lat[Math.min(lat.length - 1, Math.floor(f * lat.length))] ?? 0
  r.model = m.calls[0]?.model ?? name
  r.calls = m.calls.length
  r.p50_ms = q(0.5)
  r.p95_ms = q(0.95)
  const usd = m.calls.reduce((s, c) => s + cost(c.model, c.input_tokens, c.output_tokens), 0)
  r.usd_per_decision = m.calls.length ? usd / m.calls.length : 0
  return r
}

// ---- optional: whole pipeline, legacy vs fleet(live), real Claude ----
interface FullRow { arch: string; case: string; status: string; wall_ms: number; agent_calls: number; usd: number; approval?: string | null; bundle?: string; rubric_pass?: boolean | null }
async function benchFull(): Promise<FullRow[]> {
  const { runFleet } = await import('../lib/fleet/run.js')
  const { MODELS } = await import('../lib/claude.js')
  const out: FullRow[] = []
  const usdOf = (s: { agent_input_tokens: number; agent_output_tokens: number }) =>
    // lenses+verify on MODELS.fast, synthesis on MODELS.deep: approximate with the blend the run reports per agent is not available here, so price everything at the fast rate plus the synth share at deep.
    cost(MODELS.fast, s.agent_input_tokens * 0.6, s.agent_output_tokens * 0.6) + cost(MODELS.deep, s.agent_input_tokens * 0.4, s.agent_output_tokens * 0.4)
  for (const c of SAMPLE_LISTINGS.slice(0, N_FULL)) {
    // legacy = the same tree in shadow mode (all lenses, every gate forced open) — identical Claude work to api/research.ts
    for (const mode of ['shadow', 'live'] as const) {
      const t = Date.now()
      const { state, result } = await runFleet(c.listing, () => {}, { mode, agents: 'claude', logDir: '.jev/bench-runs' })
      out.push({ arch: mode === 'shadow' ? 'fixed fan-out (shadow)' : 'jev-routed (live)', case: c.id, status: `${state.run.status}/${result?.status ?? '-'}`, wall_ms: Date.now() - t, agent_calls: state.run.spent.agent_calls, usd: usdOf(state.run.spent), approval: result?.approval, bundle: result?.lens_bundle, rubric_pass: result?.rubric?.pass ?? null })
      console.log(`  ${out.at(-1)!.arch.padEnd(24)} ${c.id.padEnd(22)} ${out.at(-1)!.status.padEnd(20)} ${String(out.at(-1)!.wall_ms).padStart(7)}ms  ${out.at(-1)!.agent_calls} agent calls  $${out.at(-1)!.usd.toFixed(3)}`)
    }
  }
  return out
}

// ---- run ----
console.log(`fleet bench · routers: ${routerNames.join(', ')} · ${SAMPLE_LISTINGS.length} listings · ${GATE_CASES.length} gate cases · ${RUBRIC_CASES.length} rubric cases${FULL ? ` · FULL pipeline on ${N_FULL} listings` : ''}\n`)
const reports: Record<string, RouterReport> = {}
for (const name of routerNames) {
  process.stdout.write(`== ${name} ... `)
  try {
    reports[name] = await benchRouter(name)
    const r = reports[name]
    console.log(`${r.calls} calls · bundle ${r.bundle.correct}/${r.bundle.n} exact, ${r.bundle.acceptable}/${r.bundle.n} acceptable, ${r.bundle.unsure} unsure · quality ${r.quality.inRange}/${r.quality.n} · risk ${r.risk.inRange}/${r.risk.n} · gate ${r.gate.correct}/${r.gate.n} · rubric ${r.rubric.correct}/${r.rubric.n} · p50 ${r.p50_ms}ms p95 ${r.p95_ms}ms · $${r.usd_per_decision.toFixed(6)}/decision${r.errors.length ? ` · ${r.errors.length} errors` : ''}`)
    for (const e of r.errors.slice(0, 3)) console.log(`     ! ${e}`)
  } catch (e) {
    console.log(`skipped: ${(e as Error).message}`)
  }
}
const full = FULL ? await benchFull() : []

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-')
const md = `# Fleet benchmark — decision layer swapped, everything else identical

${new Date().toISOString()} · labels: eval/fleet-cases.ts (${SAMPLE_LISTINGS.length} listings, ${GATE_CASES.length} gate cases, ${RUBRIC_CASES.length} rubric cases) · thresholds: lib/fleet/workflow.ts

| router | model | lens bundle exact | acceptable | unsure | quality in range | risk in range | research gate | draft rubric | p50 / p95 | USD per decision |
|---|---|---|---|---|---|---|---|---|---|---|
${Object.entries(reports).map(([n, r]) => `| ${n} | ${r.model} | ${pct(r.bundle.correct, r.bundle.n)} | ${pct(r.bundle.acceptable, r.bundle.n)} | ${r.bundle.unsure} | ${pct(r.quality.inRange, r.quality.n)} | ${pct(r.risk.inRange, r.risk.n)} | ${pct(r.gate.correct, r.gate.n)} | ${pct(r.rubric.correct, r.rubric.n)} | ${r.p50_ms} / ${r.p95_ms} ms | $${r.usd_per_decision.toFixed(6)} |`).join('\n')}

"acceptable" counts the labeler's alternative bundle as correct. "heuristic" is the keyless lexical stand-in — a floor, not a router.
${full.length ? `
## Whole pipeline (real Claude lenses)

| architecture | case | status | wall | agent calls | est. USD | bundle | rubric pass | approval |
|---|---|---|---|---|---|---|---|---|
${full.map((f) => `| ${f.arch} | ${f.case} | ${f.status} | ${(f.wall_ms / 1000).toFixed(0)}s | ${f.agent_calls} | $${f.usd.toFixed(3)} | ${f.bundle ?? '-'} | ${f.rubric_pass ?? '-'} | ${f.approval ?? '-'} |`).join('\n')}

Cost is estimated from token counts at list prices (60% fast / 40% deep blend); read it as relative.` : ''}

Caveats: one pass, small n, labels by one person. Trust the order-of-magnitude latency/cost gaps; treat accuracy parity as suggestive.
`
writeFileSync(new URL('./FLEET-BENCH.md', import.meta.url), md)
writeFileSync(new URL('./fleet-bench.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), reports, full }, null, 2))
console.log('\nWrote eval/FLEET-BENCH.md and eval/fleet-bench.json')
