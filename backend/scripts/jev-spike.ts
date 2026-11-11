// Phase-1 spike: hit the real Jev endpoint with the fleet's own Choice, Noul and Score
// questions and report latency / tokens / cost per decision.
//
//   npm run fleet:spike                 # needs JEV_API_KEY in .env.local (free key: https://jev-agent.com/api/auth)
//   npm run fleet:spike -- --n 10       # more rounds for p50/p95
//   npm run fleet:spike -- --jev claude # same questions through the Claude-as-router baseline
import { readFileSync } from 'node:fs'
try {
  const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2]
  }
} catch {
  /* ambient env */
}

const { makeJev, jevKind } = await import('../lib/fleet/shadow.js')
const { WORKFLOWS } = await import('../lib/fleet/workflow.js')
const { buildView } = await import('../lib/jev/jev/view.js')
const { createState } = await import('../lib/jev/spec/state.js')
const { SAMPLE_LISTINGS, GATE_CASES } = await import('../eval/fleet-cases.js')
const { listingText, findingText } = await import('../lib/fleet/lenses.js')

const argv = process.argv.slice(2)
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`)
  return i === -1 ? undefined : argv[i + 1]
}
const kind = (flag('jev') as 'http' | 'heuristic' | 'claude' | undefined) ?? jevKind()
const n = Number(flag('n') ?? 3)
if (kind === 'heuristic') {
  console.log(
    '⚠ JEV_API_KEY not set — running the lexical stand-in. Latency/cost below are NOT Jev numbers.\n' +
      '  Free key: https://jev-agent.com/api/auth (then JEV_BASE_URL=https://jev-agent.com/api/v1/systemone).\n' +
      '  TypeSafe key: https://console.typesafe.ai (default base URL https://api.typesafe.ai/v1/systemone).\n',
  )
}
const jev = makeJev(kind)

const main = WORKFLOWS.main
const lensRun = WORKFLOWS.lensRun
const assess = main.nodes.find((x) => x.id === 'assess')
const pick = main.nodes.find((x) => x.id === 'pick_lenses')
const gate = lensRun.nodes.find((x) => x.id === 'gate')
if (assess?.kind !== 'assess' || pick?.kind !== 'decide' || gate?.kind !== 'check') throw new Error('workflow nodes changed')

const JEV_USD_PER_MTOK = 0.042 // docs.typesafe.ai/models — input only, output free
// jev-agent.com free host: 1 credit = ceil(input_tokens/1000) per request, $9.99 / 50,000 credits (jev-agent.com/docs#credits)
const JAGENT_USD_PER_CREDIT = 9.99 / 50_000
const onJagent = /jev-agent\.com/.test(process.env.JEV_BASE_URL ?? '')
const lat: number[] = []
let tokens = 0
let credits = 0
let stopped: string | null = null
let calls = 0
let model = '?'

type Questions = Parameters<typeof jev.ask>[1]

async function ask(label: string, view: unknown, questions: Questions) {
  if (stopped) return
  const t = Date.now()
  let res: Awaited<ReturnType<typeof jev.ask>>
  try {
    res = await jev.ask(view, questions)
  } catch (err) {
    stopped = err instanceof Error ? err.message : String(err)
    console.log(`  ${label.padEnd(36)} ✖ ${stopped.slice(0, 160)}`)
    return
  }
  const ms = Date.now() - t
  lat.push(ms)
  calls++
  tokens += res.usage?.input_tokens ?? 0
  credits += Math.max(1, Math.ceil((res.usage?.input_tokens ?? 0) / 1000))
  model = res.model
  const a = Object.entries(res.answers)
    .map(([id, x]) => {
      if (x.type === 'choice') return `${id}=${x.choice}@${x.confidence}`
      if (x.type === 'noul') return `${id}=${x.noul}`
      const best = Object.entries(x.probabilities).sort((p, q) => q[1] - p[1])[0][0]
      return `${id}=L${best}(${x.score})`
    })
    .join(' ')
  console.log(`  ${label.padEnd(36)} ${String(ms).padStart(5)}ms ${String(res.usage?.input_tokens ?? '?').padStart(6)} tok  ${a}`)
}

const riskExtra = assess.extra?.risk
if (!riskExtra || riskExtra.type !== 'score') throw new Error('assess.extra.risk changed')

for (let i = 0; i < n; i++) {
  const c = SAMPLE_LISTINGS[i % SAMPLE_LISTINGS.length]
  const st = createState({
    id: 'spike',
    workflow: main.name,
    workflow_version: '1',
    start: main.start,
    goal: main.goal,
    input: { listing_text: listingText(c.listing), title_len: c.listing.title.length },
  })
  await ask(`assess+risk ${c.id}`, buildView(st, { reads: assess.reads }), {
    assess: { type: 'score', instructions: assess.instructions, criteria: assess.levels },
    'x:risk': { type: 'score', instructions: riskExtra.instructions, criteria: riskExtra.levels },
  })
  await ask(`pick_lenses ${c.id}`, buildView(st, { reads: pick.reads }), {
    route: {
      type: 'choice',
      instructions: pick.instructions,
      criteria: Object.fromEntries(Object.entries(pick.options).map(([k, o]) => [k, o.description])),
    },
  })

  const g = GATE_CASES[i % GATE_CASES.length]
  const gs = createState({
    id: 'spike',
    workflow: lensRun.name,
    workflow_version: '1',
    start: lensRun.start,
    goal: lensRun.goal,
    input: { lens: g.lens, listing_text: g.listing_text },
  })
  gs.facts.finding_text = { value: findingText(g.finding), source: 'code', step: 0, at: '' }
  const extras: Questions = {}
  for (const [id, q] of Object.entries(gate.extra ?? {})) {
    extras[`x:${id}`] =
      q.type === 'noul'
        ? { type: 'noul', instructions: q.instructions, criteria: q.criteria }
        : { type: 'score', instructions: q.instructions, criteria: q.levels }
  }
  await ask(`gate+3 extras ${g.id}`, buildView(gs, { reads: gate.reads }), {
    check: { type: 'noul', instructions: gate.instructions, criteria: gate.criteria },
    ...extras,
  })
}

if (!lat.length) {
  console.log(`\nno completed calls: ${stopped ?? 'unknown error'}`)
  process.exit(1)
}
if (stopped) console.log(`\n⚠ stopped early: ${String(stopped).slice(0, 200)}`)
lat.sort((a, b) => a - b)
const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]
const usd = kind !== 'http' ? NaN : onJagent ? credits * JAGENT_USD_PER_CREDIT : (tokens * JEV_USD_PER_MTOK) / 1e6
console.log(
  `\nmodel=${model} · ${calls} calls · p50 ${p(0.5)}ms · p95 ${p(0.95)}ms · ${tokens} input tokens` +
    (Number.isFinite(usd) ? ` · ${onJagent ? `${credits} credits · ` : ''}$${usd.toFixed(6)} total · $${(usd / calls).toFixed(6)} per decision` : ''),
)
console.log('plan claim to check: ~135ms and ~$0.00002 per decision (jev-1.13.0, Sep 2026 bench in the repo README)')
