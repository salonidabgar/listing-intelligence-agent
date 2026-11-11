// Entry point: run the Jev-orchestrated fleet for one listing and stream the same
// NDJSON events the side panel already understands (plus `decision` / `edge` /
// `agent_skipped` / `fleet` events it can ignore until the UI learns them).
import { run } from '../jev/runtime/engine.js'
import type { RunEvent } from '../jev/runtime/events.js'
import { jsonlSink } from '../jev/runtime/log.js'
import type { RunState } from '../jev/spec/state.js'
import type { Jev } from '../jev/jev/types.js'
import type { Tool } from '../jev/runtime/engine.js'
import type { ScrapedListing } from '../shared.js'
import { WORKFLOWS, REGISTRY, CODE, type FleetResult } from './workflow.js'
import { lensTool, synthesizerTool, verifierTool, realKeywordsTool, startRealKeywords, listingText, LENSES, type LensToolDeps, type LensKey } from './lenses.js'
import { ShadowJev, fleetMode, makeJev, jevKind, type FleetMode, type ShadowRecord } from './shadow.js'
import { mockTools } from './mock.js'

export type Emit = (e: Record<string, unknown>) => void

export interface RunFleetOptions {
  mode?: FleetMode                 // shadow | live (off is handled by the caller)
  jev?: Jev                        // override (bench, tests); default from env
  agents?: 'claude' | 'mock'       // mock = no Claude calls
  logDir?: string | null           // JSONL event log dir; null disables. Default .jev/runs
  runId?: string
}

export interface FleetRun { state: RunState; result: FleetResult | null; shadow: ShadowRecord[] }

export async function runFleet(listing: ScrapedListing, emit: Emit, opts: RunFleetOptions = {}): Promise<FleetRun> {
  const mode = opts.mode ?? (fleetMode() === 'off' ? 'shadow' : fleetMode())
  const agents = opts.agents ?? (process.env.FLEET_AGENTS === 'mock' ? 'mock' : 'claude')
  const shadow: ShadowRecord[] = []
  const inner = opts.jev ?? makeJev()
  const jev: Jev = mode === 'shadow' ? new ShadowJev(inner, (r) => shadow.push(r)) : inner

  const deps: LensToolDeps = {
    listing,
    realKeywords: agents === 'mock' ? Promise.resolve(null) : startRealKeywords(listing),
    emit,
  }
  const tools: Record<string, Tool> = agents === 'mock'
    ? mockTools(deps)
    : { lens: lensTool(deps), synthesizer: synthesizerTool(deps), verifier: verifierTool(deps), real_keywords: realKeywordsTool(deps) }

  const log = opts.logDir === null ? null : jsonlSink(opts.logDir ?? process.env.FLEET_LOG_DIR ?? '.jev/runs')
  const lensList = Object.entries(LENSES).map(([key, l]) => ({ key, label: l.label }))
  emit({ type: 'start', lenses: lensList, fleet: { mode, jev: opts.jev ? 'custom' : jevKind(), agents } })

  const onEvent = (e: RunEvent) => {
    log?.(e)
    forward(e, emit, mode)
  }

  const state = await run(
    { listing, listing_text: listingText(listing), title_len: listing.title.length, asin: listing.asin },
    { workflow: WORKFLOWS.main, workflows: REGISTRY, jev, tools, code: CODE, onEvent, runId: opts.runId },
  )

  const result = (state.output ?? null) as FleetResult | null
  if (shadow.length) {
    // Shadow decisions ride in the run log too, so calibration has them next to the outcome.
    log?.({ type: 'shadow', run_id: state.run.id, at: new Date().toISOString(), records: shadow } as unknown as RunEvent)
  }
  if (state.run.status !== 'succeeded') {
    emit({ type: 'fatal', message: `fleet ${state.run.status}: ${state.run.halt_reason ?? 'unknown'}`, fleet: summary(state, mode) })
  } else {
    emit({ type: 'done', fleet: { ...summary(state, mode), status: result?.status, approval: result?.approval, lens_bundle: result?.lens_bundle, rubric: result?.rubric } })
  }
  return { state, result, shadow }
}

function summary(state: RunState, mode: FleetMode) {
  const s = state.run.spent
  return { run_id: state.run.id, mode, steps: s.steps, jev_calls: s.jev_calls, jev_input_tokens: s.jev_input_tokens, agent_calls: s.agent_calls, agent_input_tokens: s.agent_input_tokens, agent_output_tokens: s.agent_output_tokens, wall_ms: s.wall_ms, decisions: state.decisions.map((d) => ({ node: d.node, mode: d.mode, edge: d.edge, confidence: d.confidence, latency_ms: d.latency_ms })) }
}

/** Engine events → panel events. Tools emit their own agent_* events; this adds the routing layer. */
function forward(e: RunEvent, emit: Emit, mode: FleetMode) {
  switch (e.type) {
    case 'jev.answer':
      emit({ type: 'decision', run: e.run_id, node: e.node, answers: e.answers, latency_ms: e.latency_ms, model: e.model, shadow: mode === 'shadow' })
      break
    case 'edge':
      emit({ type: 'edge', run: e.run_id, from: e.from, label: e.label, to: e.to })
      break
    case 'tool.call': {
      const args = e.args as { selected?: unknown; lens?: string } | undefined
      if (e.tool === 'workflow:lens-run' && args && args.selected !== true && args.lens) {
        const key = args.lens as LensKey
        emit({ type: 'agent_skipped', key, label: LENSES[key]?.label ?? key, reason: 'not selected by the router' })
      }
      break
    }
    default:
      break
  }
}
