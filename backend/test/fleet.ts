// Routing tests for the fleet tree. ScriptedJev answers every question from a script, so
// these prove the edges, guards and code-side bars without any network.
//   npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptedJev } from '../lib/jev/jev/mock.js'
import type { Answer, Question } from '../lib/jev/jev/types.js'
import { runFleet } from '../lib/fleet/run.js'
import { legacyAnswer } from '../lib/fleet/shadow.js'
import { SAMPLE_LISTINGS } from '../eval/fleet-cases.js'
import { THRESHOLDS } from '../lib/fleet/workflow.js'

const listing = SAMPLE_LISTINGS[0].listing
const noul = (p: number): Answer => ({ type: 'noul', noul: p })
const choice = (c: string, conf: number, keys: string[]): Answer => ({ type: 'choice', choice: c, confidence: conf, probabilities: Object.fromEntries(keys.map((k) => [k, k === c ? conf : (1 - conf) / (keys.length - 1)])) })
const score = (level: number, n: number): Answer => ({ type: 'score', score: level, confidence: 0.9, legend: {}, probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === level ? 0.9 : 0.1 / (n - 1)])) })

type Script = (view: { context: Record<string, unknown> }, q: Question, id: string) => Answer
const run = (script: Script) => runFleet(listing, () => {}, { mode: 'live', agents: 'mock', jev: new ScriptedJev((s, q, id) => script(s as { context: Record<string, unknown> }, q, id)), logDir: null })

// A confident, everything-passes router that runs every lens.
const happy: Script = (_s, q, id) => {
  if (q.type === 'choice') return choice('full', 0.9, Object.keys(q.criteria))
  if (q.type === 'score') return score(id === 'x:risk' ? 0 : 1, q.criteria.length)
  return noul(0.95)
}

test('live: router picks a bundle, unselected lenses are skipped, gates pass, approval=allow', async () => {
  const { state, result } = await run((s, q, id) => (q.type === 'choice' ? choice('compliance_first', 0.9, Object.keys(q.criteria)) : happy(s, q, id)))
  assert.equal(state.run.status, 'succeeded')
  assert.ok(result)
  assert.equal(result.lens_bundle, 'compliance_first')
  assert.deepEqual(result.lenses.map((l) => `${l.lens}=${l.status}`), ['market=skipped', 'keywords=accepted', 'voice=skipped', 'compliance=accepted', 'aco=accepted'])
  assert.equal(result.status, 'complete')
  assert.equal(result.approval, 'allow')
  assert.equal(result.rubric?.pass, true)
  assert.equal(result.rubric?.rounds, 1)
  assert.ok(result.plan && result.plan.optimizedTitle.length <= 75)
})

test('live: low-confidence lens pick falls back to all lenses in code (no human stop)', async () => {
  const { result } = await run((s, q, id) => (q.type === 'choice' ? choice('reposition', THRESHOLDS.lens_pick_min_confidence - 0.1, Object.keys(q.criteria)) : happy(s, q, id)))
  assert.ok(result)
  assert.equal(result.lens_bundle, 'full (router unsure)')
  assert.ok(result.lenses.every((l) => l.status !== 'skipped'))
})

test('live: research gate — unsure triggers ONE retry with a code-named gap, then accepts as "verified"', async () => {
  let complianceGateCalls = 0
  const { result } = await run((s, q, id) => {
    if (q.type === 'noul' && id === 'check' && s.context['input.lens'] === 'compliance') {
      complianceGateCalls++
      return noul(complianceGateCalls === 1 ? 0.5 : 0.9) // first pass: dead center → verify_more
    }
    if (q.type === 'noul' && id === 'x:grounded' && s.context['input.lens'] === 'compliance') return noul(0.1)
    return happy(s, q, id)
  })
  assert.ok(result)
  const c = result.lenses.find((l) => l.lens === 'compliance')!
  assert.equal(complianceGateCalls, 2)
  assert.equal(c.status, 'verified')
  assert.match(c.gap ?? '', /THIS product/)
  // the mock compliance lens returns the specific finding only when it receives a gap
  assert.match(c.finding?.summary ?? '', /75-char limit/)
})

test('live: research gate — unsure twice → rejected and excluded from the synthesizer input', async () => {
  const { result } = await run((s, q, id) => (q.type === 'noul' && id === 'check' && s.context['input.lens'] === 'voice' ? noul(0.5) : happy(s, q, id)))
  assert.ok(result)
  assert.equal(result.lenses.find((l) => l.lens === 'voice')!.status, 'rejected')
  assert.equal(result.lenses.filter((l) => l.status === 'accepted').length, 4)
})

test('live: research gate — clear "not usable" rejects without a retry', async () => {
  let gateCalls = 0
  const { result } = await run((s, q, id) => {
    if (q.type === 'noul' && id === 'check' && s.context['input.lens'] === 'aco') { gateCalls++; return noul(0.1) }
    return happy(s, q, id)
  })
  assert.equal(gateCalls, 1)
  assert.equal(result!.lenses.find((l) => l.lens === 'aco')!.status, 'rejected')
})

test('live: draft rubric — a failing part names itself in the rewrite feedback; loop is bounded at 3 rounds', async () => {
  let rubricCalls = 0
  const { state, result } = await run((s, q, id) => {
    if (q.type === 'noul' && id === 'x:keyword_coverage') { rubricCalls++; return noul(0.2) } // always fails
    return happy(s, q, id)
  })
  assert.equal(state.run.status, 'succeeded')
  assert.equal(rubricCalls, THRESHOLDS.rubric_max_rounds)
  assert.equal(result!.rubric?.pass, false)
  assert.equal(result!.rubric?.rounds, THRESHOLDS.rubric_max_rounds)
  assert.deepEqual(result!.rubric?.failing, ['keyword coverage'])
  assert.ok(result!.plan, 'best-effort draft is still delivered, flagged')
})

test('live: completion gate unsure → one redraft with verifier feedback, then incomplete → approval=human_review', async () => {
  let completion = 0
  const { result } = await run((s, q, id) => {
    if (q.type === 'noul' && id === 'check' && /complete and safe/i.test(q.instructions)) { completion++; return noul(0.55) }
    return happy(s, q, id)
  })
  assert.equal(completion, 2)
  assert.equal(result!.status, 'incomplete')
  assert.equal(result!.approval, 'human_review')
})

test('live: staged-change guard maps p → allow / confirm / human_review', async () => {
  const guard = async (p: number) => (await run((s, q, id) => (q.type === 'noul' && id === 'check' && /without a human review/i.test(q.instructions) ? noul(p) : happy(s, q, id)))).result!.approval
  assert.equal(await guard(0.9), 'allow')
  assert.equal(await guard(0.6), 'confirm')
  assert.equal(await guard(0.2), 'human_review')
})

test('shadow: Jev is asked, answers are recorded, but the legacy path is followed', async () => {
  const asked: string[] = []
  const inner = new ScriptedJev((s, q, id) => { asked.push(id); return happy(s as { context: Record<string, unknown> }, q, id) })
  const { result, shadow } = await runFleet(listing, () => {}, { mode: 'shadow', agents: 'mock', jev: inner, logDir: null })
  assert.ok(asked.includes('route') && asked.includes('check') && asked.includes('assess'))
  assert.ok(shadow.length >= 10)
  assert.ok(shadow.every((r) => r.real && !r.error))
  assert.equal(result!.lens_bundle, 'full')                  // forced, although the router said thin_listing
  assert.ok(result!.lenses.every((l) => l.status === 'accepted'))
  assert.equal(result!.approval, 'confirm')                   // the one gate legacy never had lands on "confirm"
  assert.equal(result!.status, 'complete')
})

test('shadow: a Jev outage does not break the run', async () => {
  const broken = { ask: async () => { throw new Error('jev http 503') } }
  const { state, result, shadow } = await runFleet(listing, () => {}, { mode: 'shadow', agents: 'mock', jev: broken, logDir: null })
  assert.equal(state.run.status, 'succeeded')
  assert.equal(result!.status, 'complete')
  assert.ok(shadow.every((r) => r.error === 'jev http 503' && r.real === null))
})

test('legacyAnswer: full bundle, gates open, approval guard in the unsure band', () => {
  const c = legacyAnswer({ type: 'choice', instructions: '', criteria: { full: '', thin_listing: '' } })
  assert.equal(c.type === 'choice' && c.choice, 'full')
  assert.equal((legacyAnswer({ type: 'noul', instructions: 'Is this finding usable?', criteria: { true: '', false: '' } }) as { noul: number }).noul, 1)
  assert.equal((legacyAnswer({ type: 'noul', instructions: 'Can this change be staged without a human review step?', criteria: { true: '', false: '' } }) as { noul: number }).noul, 0.5)
})

test('event stream keeps the legacy contract and adds routing events', async () => {
  const types: string[] = []
  await runFleet(listing, (e) => types.push(String(e.type)), { mode: 'live', agents: 'mock', jev: new ScriptedJev((s, q, id) => (q.type === 'choice' ? choice('thin_listing', 0.9, Object.keys(q.criteria)) : happy(s as { context: Record<string, unknown> }, q, id))), logDir: null })
  for (const t of ['start', 'agent_start', 'agent_done', 'keywords', 'synthesis', 'verdict', 'done', 'decision', 'edge', 'agent_skipped']) assert.ok(types.includes(t), `missing ${t}`)
  assert.equal(types[0], 'start')
  assert.equal(types.at(-1), 'done')
})
