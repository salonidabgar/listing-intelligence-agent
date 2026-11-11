// Run the fleet tree on a sample listing without any API key (heuristic Jev + mock
// agents) or with whatever keys .env.local provides. Prints every edge and decision.
//
//   npm run fleet:demo                       # mock agents, heuristic Jev, live routing
//   npm run fleet:demo -- --mode shadow      # shadow routing (legacy path, Jev logged)
//   npm run fleet:demo -- --agents claude    # real Claude lenses (spends tokens)
//   npm run fleet:demo -- --jev http         # real Jev (needs JEV_API_KEY)
import { readFileSync } from 'node:fs'
try {
  const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  for (const line of raw.split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2] }
} catch { /* ambient env */ }

const { runFleet } = await import('../lib/fleet/run.js')
const { makeJev } = await import('../lib/fleet/shadow.js')
const { SAMPLE_LISTINGS } = await import('../eval/fleet-cases.js')

const argv = process.argv.slice(2)
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i === -1 ? undefined : argv[i + 1] }
const mode = (flag('mode') ?? 'live') as 'shadow' | 'live'
const agents = (flag('agents') ?? 'mock') as 'claude' | 'mock'
const jevArg = flag('jev') as 'http' | 'heuristic' | 'claude' | undefined
const caseId = flag('case') ?? 'thin-supplement'
const c = SAMPLE_LISTINGS.find((x) => x.id === caseId) ?? SAMPLE_LISTINGS[0]

console.log(`fleet demo · case=${c.id} · mode=${mode} · agents=${agents} · jev=${jevArg ?? (process.env.JEV_API_KEY ? 'http' : 'heuristic')}\n`)
const t0 = Date.now()
const { state, result, shadow } = await runFleet(c.listing, (e) => {
  if (e.type === 'edge') console.log(`  ${String(e.run).padEnd(34)} ${e.from} --${e.label}--> ${e.to}`)
  else if (e.type === 'decision') console.log(`  ${String(e.run).padEnd(34)} ◆ ${e.node}: ${JSON.stringify(e.answers)}${e.shadow ? '  [shadow]' : ''}`)
  else if (e.type === 'agent_start' || e.type === 'agent_done' || e.type === 'agent_error' || e.type === 'agent_skipped') console.log(`  ${''.padEnd(34)} ▸ ${e.type} ${e.key}${e.message ? ': ' + e.message : ''}${e.reason ? ': ' + e.reason : ''}`)
  else if (e.type === 'done' || e.type === 'fatal') console.log(`\n${e.type}: ${JSON.stringify(e.fleet ?? e.message, null, 1)}`)
}, { mode, agents, jev: jevArg ? makeJev(jevArg) : undefined, logDir: '.jev/runs' })

console.log(`\nstatus=${state.run.status}${state.run.halt_reason ? ` (${state.run.halt_reason})` : ''} · ${Date.now() - t0}ms · jev calls ${state.run.spent.jev_calls} · agent calls ${state.run.spent.agent_calls}`)
if (result) {
  console.log(`result: status=${result.status} approval=${result.approval} bundle=${result.lens_bundle} rubric=${JSON.stringify(result.rubric)}`)
  console.log(`lenses: ${result.lenses.map((l) => `${l.lens}=${l.status}`).join(' ')}`)
  if (result.plan) console.log(`title (${result.plan.optimizedTitle.length}): ${result.plan.optimizedTitle}\nhighlights (${result.plan.itemHighlights.length}): ${result.plan.itemHighlights}`)
}
if (shadow.length) console.log(`shadow records: ${shadow.length} (real answers logged to .jev/runs/<run>.jsonl)`)
