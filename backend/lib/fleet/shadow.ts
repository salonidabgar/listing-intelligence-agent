// Jev selection + shadow mode.
//
//  FLEET_MODE  off    → legacy fixed fan-out in api/research.ts (default)
//              shadow → the tree runs, Jev is asked every question and its answers are
//                       LOGGED, but the run follows the legacy path (all lenses, every
//                       gate passes, approval=confirm). Zero behavior change; the log is
//                       what calibrates the thresholds.
//              live   → Jev's answers route the run.
//  FLEET_JEV   http | heuristic | claude   (default: http if JEV_API_KEY is set, else heuristic)
//  FLEET_AGENTS claude | mock              (mock = no Claude spend, for demos/tests)
import type { Answer, Jev, JevResponse, Question } from '../jev/jev/types.js'
import { HttpJev } from '../jev/jev/client.js'
import { HeuristicJev } from '../jev/jev/mock.js'
import { ClaudeRouter } from '../jev/jev/claude-router.js'
import { client } from '../claude.js'

export type FleetMode = 'off' | 'shadow' | 'live'
export type JevKind = 'http' | 'heuristic' | 'claude'

export function fleetMode(env = process.env): FleetMode {
  const m = env.FLEET_MODE
  return m === 'shadow' || m === 'live' ? m : 'off'
}

export function jevKind(env = process.env): JevKind {
  const k = env.FLEET_JEV
  if (k === 'http' || k === 'heuristic' || k === 'claude') return k
  return env.JEV_API_KEY ? 'http' : 'heuristic'
}

export function makeJev(kind = jevKind(), env = process.env): Jev {
  if (kind === 'http') {
    if (!env.JEV_API_KEY) throw new Error('FLEET_JEV=http but JEV_API_KEY is not set')
    // Pin the model: aliases move (jev-latest → 1.14 since Oct 2026); thresholds are tuned per version.
    return new HttpJev({ apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL || undefined, model: env.JEV_MODEL || 'jev-1.13.0' })
  }
  if (kind === 'claude') return new ClaudeRouter({ client, model: env.FLEET_ROUTER_MODEL || 'claude-opus-5-5', effort: 'low' })
  return new HeuristicJev()
}

export interface ShadowRecord {
  at: string
  questions: Record<string, Question>
  real: Record<string, Answer> | null
  forced: Record<string, Answer>
  error: string | null
  latency_ms: number
  model: string | null
}

/**
 * Asks the inner Jev, records what it said, returns the legacy answer instead.
 * Routing questions (`route`, `check`) are forced; assessments and ride-along
 * extras (`assess`, `x:*`) pass through — they never route anything by themselves.
 */
export class ShadowJev implements Jev {
  constructor(private readonly inner: Jev, private readonly onRecord: (r: ShadowRecord) => void) {}

  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
    const t0 = Date.now()
    let real: JevResponse | null = null
    let error: string | null = null
    try {
      real = await this.inner.ask(state, questions)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const forced: Record<string, Answer> = {}
    for (const [id, q] of Object.entries(questions)) {
      const r = real?.answers[id]
      forced[id] = id === 'route' || id === 'check' ? legacyAnswer(q) : r ?? legacyAnswer(q)
    }
    this.onRecord({ at: new Date().toISOString(), questions, real: real?.answers ?? null, forced, error, latency_ms: Date.now() - t0, model: real?.model ?? null })
    return { model: `shadow(${real?.model ?? 'error'})`, answers: forced, usage: real?.usage ?? { input_tokens: 0, output_tokens: 0 } }
  }
}

/** The answer the pre-Jev pipeline implicitly gave: run everything, pass every gate. */
export function legacyAnswer(q: Question): Answer {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria)
    const pick = keys.includes('full') ? 'full' : keys[0]
    return { type: 'choice', choice: pick, confidence: 1, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 1 : 0])) }
  }
  if (q.type === 'noul') {
    // The staged-change guard is the one gate legacy never had; land in its unsure band → "confirm".
    const isApproval = /without a human review/i.test(q.instructions)
    return { type: 'noul', noul: isApproval ? 0.5 : 1 }
  }
  const n = q.criteria.length
  return { type: 'score', score: n - 1, confidence: 1, legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), l])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === n - 1 ? 1 : 0])) }
}
