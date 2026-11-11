// The Listing Optimizer as an explicit decision tree. Jev answers typed questions
// (Choice / Noul / Score) between the steps; Claude tools do the research and writing;
// every threshold ("bar") lives in THRESHOLDS below — in code, never in a prompt.
//
//  assess quality+risk → decide lens bundle → parallel lens-run ×5 (each: run → Noul gate
//  → accept | one bounded retry with a named gap | reject) → draft-loop (Opus draft →
//  code char limits + Jev 5-part rubric → rewrite with failing checks named, max 2 rounds)
//  → verifier → Noul completion gate → Noul staged-change guard (allow/confirm/human_review)
//  → output. Real approval stays in the host UI; this run only labels the change.
import { loadWorkflow, type WorkflowInput } from '../jev/spec/workflow.js'
import type { CodeFn } from '../jev/runtime/engine.js'
import type { RunState } from '../jev/spec/state.js'
import { LENS_KEYS, LENSES, type LensKey, type LensFinding, type ListingPlan, TITLE_LIMIT, HIGHLIGHTS_LIMIT, findingText, planText, verdictText } from './lenses.js'
import type { Verdict } from '../shared.js'
import type { RealKeywords } from '../keywords.js'

// ---- every bar in one place (calibrate these from .jev/runs logs, see scripts/jev-calibrate.ts) ----
export const THRESHOLDS = {
  lens_pick_min_confidence: 0.5,   // decide: below this → safe default (all lenses)
  gate_threshold: 0.55,            // research gate: P(usable) at/above → accept
  gate_unsure_band: 0.1,           // |p-0.5| < band → verify_more (one bounded retry)
  gate_extra_bar: 0.5,             // ride-along Nouls below this name the gap for the retry
  rubric: { grounded: 0.6, keyword_coverage: 0.5, compliance: 0.6, specificity: 0.5, overall: 0.5 },
  rubric_max_rounds: 3,            // 1 draft + 2 rewrites
  completion_threshold: 0.6,
  completion_unsure_band: 0.1,
  approval_threshold: 0.7,
  approval_unsure_band: 0.15,
} as const

export type LensBundle = 'full' | 'thin_listing' | 'compliance_first' | 'reposition'
export const LENS_BUNDLES: Record<LensBundle, LensKey[]> = {
  full: ['market', 'keywords', 'voice', 'compliance', 'aco'],
  thin_listing: ['keywords', 'voice', 'aco'],
  compliance_first: ['compliance', 'keywords', 'aco'],
  reposition: ['market', 'voice', 'aco'],
}

export const QUALITY_LEVELS = [
  'Thin: short generic title, few or no bullets, no selling specifics (size, count, material, certification)',
  'Partial: some specifics present but key attributes, use-cases or shopper keywords are missing',
  'Solid: specific title and bullets, minor gaps in keywords or structure',
  'Strong: front-loaded specifics, structured attributes, use-case language, within the 75-char title limit',
]
export const RISK_LEVELS = [
  'No risk: no regulated or unsubstantiated claims, title within 75 characters',
  'Low: title over 75 characters OR mild marketing superlatives, no regulated claims',
  'Elevated: regulated category (supplement, cosmetic, health, baby) with unqualified benefit claims',
  'Flagged: medical/cure/FDA-approved claims, "#1"/"best" superlatives, or prohibited terms',
]

// ================= sub-workflow: one lens with its research gate =================
const lensRun: WorkflowInput = {
  name: 'lens-run',
  goal: { text: 'Produce one usable research finding for this lens, or say clearly why not.', success_criteria: ['grounded in this product', 'specific actionable points', 'sources named'] },
  start: 'selected',
  budget: { max_visits_per_node: 3, max_jev_calls: 4 },
  nodes: [
    { kind: 'switch', id: 'selected', title: 'Lens selected by the router?', on: 'input.selected', cases: { true: 'run' }, default: 'skip' },
    { kind: 'code', id: 'skip', title: 'Skipped by router', fn: 'lens_skip', next: 'done' },
    {
      kind: 'act', id: 'run', title: 'Run lens', tool: 'lens',
      args: { lens: '$input.lens', gap: '$facts.gap' },
      store_as: 'finding', summary: '${input.lens} finding ready', next: 'render', on_error: 'failed',
    },
    { kind: 'code', id: 'render', title: 'Render for Jev (code)', fn: 'lens_render', next: 'gate' },
    {
      kind: 'check', id: 'gate', title: 'Research gate',
      instructions: 'Is this research finding usable as input for rewriting the Amazon listing? Judge it against the listing it is about.',
      reads: ['input.lens', 'input.listing_text', 'facts.finding_text'],
      criteria: {
        true: 'Usable: the points are about this specific product and category, concrete enough to act on (named terms, numbers, phrases, competitors or questions), and sources are named',
        false: 'Not usable: generic advice that would fit any product, speculative or off-product, empty, or an error message',
      },
      threshold: THRESHOLDS.gate_threshold, unsure_band: THRESHOLDS.gate_unsure_band,
      extra: {
        grounded: { type: 'noul', instructions: 'Do the points refer to THIS product and its category rather than generic listing advice?', criteria: { true: 'Points name this product type, its attributes, its category or its competitors', false: 'Points are generic and would apply to any Amazon listing' } },
        specific: { type: 'noul', instructions: 'Are the points concrete enough to act on?', criteria: { true: 'Points name exact terms, numbers, phrases, questions or competitors to use', false: 'Points are vague directions without concrete content' } },
        sourced: { type: 'noul', instructions: 'Does the finding name where its facts came from?', criteria: { true: 'Sources list names real sites, data sets or the scraped reviews', false: 'Sources list is empty or placeholder' } },
      },
      on_true: 'accept', on_false: 'reject', on_unsure: 'retry_switch',
    },
    { kind: 'switch', id: 'retry_switch', title: 'Already retried?', on: 'facts.retried', cases: { true: 'reject' }, default: 'name_gap' },
    { kind: 'code', id: 'name_gap', title: 'Name the gap (code)', fn: 'lens_name_gap', next: 'run' },
    { kind: 'code', id: 'accept', title: 'Accept', fn: 'lens_accept', next: 'done' },
    { kind: 'code', id: 'reject', title: 'Reject', fn: 'lens_reject', next: 'done' },
    { kind: 'code', id: 'failed', title: 'Lens errored', fn: 'lens_failed', next: 'done' },
    { kind: 'end', id: 'done', outcome: 'succeeded', output: 'facts.result' },
  ],
}

// ================= sub-workflow: draft → rubric → bounded rewrite =================
const draftLoop: WorkflowInput = {
  name: 'draft-loop',
  goal: { text: 'Draft a July-27-compliant optimized listing that passes every rubric check.', success_criteria: ['title <=75 and highlights <=125 (code)', 'claims grounded in findings', 'shopper keywords covered', 'no compliance risk', 'specific copy'] },
  start: 'init',
  budget: { max_visits_per_node: THRESHOLDS.rubric_max_rounds + 1, max_jev_calls: 6 },
  nodes: [
    { kind: 'code', id: 'init', title: 'Seed feedback from parent (code)', fn: 'draft_init', next: 'write' },
    {
      kind: 'act', id: 'write', title: 'Synthesizer drafts (Opus)', tool: 'synthesizer',
      args: { findings_text: '$input.findings_text', keywords_text: '$input.keywords_text', feedback: '$facts.feedback' },
      store_as: 'draft', summary: 'draft ready', next: 'fit',
    },
    { kind: 'code', id: 'fit', title: 'Char limits (code)', fn: 'draft_fit', next: 'rubric' },
    {
      kind: 'check', id: 'rubric', title: '5-part rubric',
      instructions: 'Is this optimized Amazon listing draft ready to show the seller? Compare it to the original listing, the research findings and the real shopper queries.',
      reads: ['input.listing_text', 'input.findings_text', 'input.keywords_text', 'facts.draft_text'],
      criteria: {
        true: 'Ready: every claim traces to the original listing or a finding, the top shopper queries appear, nothing risks a policy violation, and the copy states specifics',
        false: 'Not ready: invented or unsupported claims, missing high-popularity terms, a compliance risk, or vague copy',
      },
      threshold: THRESHOLDS.rubric.overall,
      extra: {
        grounded: { type: 'noul', instructions: 'Is every claim in the draft supported by the original listing or a research finding?', criteria: { true: 'No invented specs, certifications, numbers or benefits', false: 'The draft states something not present in the listing or findings' } },
        keyword_coverage: { type: 'noul', instructions: 'Does the draft use the high-popularity shopper queries (title first, overflow in Item Highlights)?', criteria: { true: 'The top queries appear, front-loaded, in shopper phrasing', false: 'Top queries are missing or buried' } },
        compliance: { type: 'noul', instructions: 'Is the draft free of compliance risk under Amazon policy?', criteria: { true: 'No medical/cure claims, no superlatives like #1/best, no prohibited terms', false: 'Contains a regulated, unsubstantiated or prohibited claim' } },
        specificity: { type: 'noul', instructions: 'Is the copy specific rather than generic marketing?', criteria: { true: 'States counts, sizes, materials, certifications, use cases', false: 'Mostly adjectives and generic benefit language' } },
      },
      on_true: 'score', on_false: 'score',   // the decision is made in code from all five answers + the char limits
    },
    { kind: 'code', id: 'score', title: 'Done? (code: every check past its bar)', fn: 'draft_score', next: 'pass_switch' },
    { kind: 'switch', id: 'pass_switch', title: 'Passed?', on: 'facts.rubric_pass', cases: { true: 'done' }, default: 'rounds_switch' },
    { kind: 'switch', id: 'rounds_switch', title: 'Rounds left?', on: 'facts.rounds', cases: { [String(THRESHOLDS.rubric_max_rounds)]: 'best_effort' }, default: 'rewrite' },
    { kind: 'code', id: 'rewrite', title: 'Name failing checks (code)', fn: 'draft_rewrite', next: 'write' },
    { kind: 'code', id: 'best_effort', title: 'Out of rounds: ship best effort, flagged', fn: 'draft_best_effort', next: 'done' },
    { kind: 'end', id: 'done', outcome: 'succeeded', output: 'facts.result' },
  ],
}

// ================= main workflow =================
const listingFleet: WorkflowInput = {
  name: 'listing-fleet',
  goal: { text: 'Research this Amazon listing and produce a verified, July-27-compliant optimized listing the seller can stage.', success_criteria: ['only the lenses this ASIN needs', 'every finding gated', 'draft passed the rubric', 'verifier cleared it', 'staging risk labeled'] },
  start: 'assess',
  budget: { max_steps: 60, max_jev_calls: 40, max_wall_ms: 10 * 60_000, max_visits_per_node: 3, max_depth: 3 },
  nodes: [
    {
      kind: 'assess', id: 'assess', title: 'Listing quality (Score)',
      instructions: 'Rate the overall quality of this Amazon listing as it stands.',
      reads: ['input.listing_text', 'input.title_len'],
      levels: QUALITY_LEVELS, store_as: 'quality',
      extra: { risk: { type: 'score', instructions: 'Rate the compliance risk of this listing text.', levels: RISK_LEVELS } },
      next: 'pick_lenses',
    },
    {
      kind: 'decide', id: 'pick_lenses', title: 'Which lenses does this ASIN need? (Choice)',
      instructions: 'Choose the research plan for this listing given its quality and risk assessment. Every plan includes the AI-answerability lens.',
      reads: ['input.listing_text', 'input.title_len', 'assessments.quality', 'assessments.risk'],
      options: {
        full: { description: 'Average listing with no single dominant problem: run every lens (market, keywords, voice of customer, compliance, AI answerability)', next: 'expand' },
        thin_listing: { description: 'Sparse or generic listing lacking specifics and keywords: keywords, voice of customer and AI answerability find the missing substance; market and compliance add little', next: 'expand' },
        compliance_first: { description: 'Title over 75 characters or regulated/risky claims present: compliance first, with keywords and AI answerability; skip market and voice', next: 'expand' },
        reposition: { description: 'Specific, compliant listing that is losing on positioning: market and voice of customer with AI answerability; skip keywords and compliance', next: 'expand' },
      },
      min_confidence: THRESHOLDS.lens_pick_min_confidence,
      on_unsure: 'expand',   // safe default in code: unsure → all lenses (see fleet_expand)
    },
    { kind: 'code', id: 'expand', title: 'Bundle → lens set (code)', fn: 'fleet_expand', next: 'research' },
    {
      kind: 'parallel', id: 'research', title: 'Lens agents (parallel, each gated)',
      branches: [
        // Real Amazon autocomplete pull runs alongside the lenses (the keyword lens waits on it inside its tool).
        { id: 'real_keywords', kind: 'act' as const, tool: 'real_keywords', args: {} },
        ...LENS_KEYS.map((lens) => ({
          id: lens, kind: 'sub' as const, workflow: 'lens-run',
          input: { lens, selected: `$facts.lens_plan.${lens}`, listing_text: '$input.listing_text' },
        })),
      ],
      store_as: 'lens_results', next: 'collect', on_error: 'collect',
    },
    { kind: 'code', id: 'collect', title: 'Collect accepted findings (code)', fn: 'fleet_collect', next: 'draft' },
    {
      kind: 'sub', id: 'draft', title: 'Draft loop', workflow: 'draft-loop',
      input: { listing_text: '$input.listing_text', findings_text: '$facts.findings_text', keywords_text: '$facts.keywords_text', feedback: '$facts.verifier_feedback' },
      store_as: 'draft', summary: 'draft ready', next: 'verify', on_error: 'no_plan',
    },
    { kind: 'act', id: 'verify', title: 'Verifier (red-team)', tool: 'verifier', args: { plan: '$facts.draft.plan' }, store_as: 'verdict', summary: 'verdict ready', next: 'render', on_error: 'incomplete' },
    { kind: 'code', id: 'render', title: 'Render draft + verdict for Jev (code)', fn: 'fleet_render', next: 'completion' },
    {
      kind: 'check', id: 'completion', title: 'Completion gate',
      instructions: 'Is this optimized listing complete and safe to show the seller? Consider the draft, the verifier verdict and the original listing.',
      reads: ['input.listing_text', 'facts.draft_text', 'facts.verdict_text', 'facts.draft.rubric_pass'],
      criteria: {
        true: 'Complete: within limits, keeps every selling specific of the original, no blocking risks from the verifier, reflects the research',
        false: 'Incomplete: the verifier reports blocking risks or policy violations, specifics were lost, or the draft ignores the findings',
      },
      threshold: THRESHOLDS.completion_threshold, unsure_band: THRESHOLDS.completion_unsure_band,
      on_true: 'approval', on_false: 'incomplete', on_unsure: 'redraft_switch',
    },
    { kind: 'switch', id: 'redraft_switch', title: 'Already redrafted?', on: 'facts.redrafted', cases: { true: 'incomplete' }, default: 'redraft' },
    { kind: 'code', id: 'redraft', title: 'Redraft once with verifier feedback (code)', fn: 'fleet_redraft', next: 'draft' },
    {
      kind: 'check', id: 'approval', title: 'Staged-change guard',
      instructions: 'Can this change be staged for one-click apply by the seller without a human review step?',
      reads: ['input.listing_text', 'facts.draft_text', 'facts.verdict_text', 'assessments.risk'],
      criteria: {
        true: 'Low risk: unregulated category, no new or changed claims, every specific retained, verifier found nothing',
        false: 'Needs review: regulated category, new or changed claims, or verifier risks that a person must weigh',
      },
      threshold: THRESHOLDS.approval_threshold, unsure_band: THRESHOLDS.approval_unsure_band,
      on_true: 'allow', on_false: 'human_review', on_unsure: 'confirm',
    },
    { kind: 'code', id: 'allow', title: 'approval=allow', fn: 'fleet_allow', next: 'output' },
    { kind: 'code', id: 'confirm', title: 'approval=confirm', fn: 'fleet_confirm', next: 'output' },
    { kind: 'code', id: 'human_review', title: 'approval=human_review', fn: 'fleet_human_review', next: 'output' },
    { kind: 'code', id: 'incomplete', title: 'status=incomplete', fn: 'fleet_incomplete', next: 'output' },
    { kind: 'code', id: 'no_plan', title: 'status=no_plan', fn: 'fleet_no_plan', next: 'output' },
    { kind: 'code', id: 'output', title: 'Shape output (code)', fn: 'fleet_output', next: 'end' },
    { kind: 'end', id: 'end', outcome: 'succeeded', output: 'facts.result' },
  ],
}

export const WORKFLOWS = {
  main: loadWorkflow(listingFleet),
  lensRun: loadWorkflow(lensRun),
  draftLoop: loadWorkflow(draftLoop),
}
export const REGISTRY = { [WORKFLOWS.main.name]: WORKFLOWS.main, [WORKFLOWS.lensRun.name]: WORKFLOWS.lensRun, [WORKFLOWS.draftLoop.name]: WORKFLOWS.draftLoop }

// ================= code nodes (pure functions over state) =================
export interface LensResult { lens: LensKey; label: string; status: 'accepted' | 'verified' | 'rejected' | 'skipped' | 'error'; finding: LensFinding | null; gap?: string; error?: string }
export type Approval = 'allow' | 'confirm' | 'human_review'
export interface FleetResult {
  status: 'complete' | 'incomplete' | 'no_plan'
  approval: Approval | null
  lens_bundle: string
  lenses: LensResult[]
  plan: ListingPlan | null
  rubric: { pass: boolean; rounds: number; failing: string[] } | null
  verdict: Verdict | null
  quality: { level: number; label: string; score: number } | null
  risk: { level: number; label: string; score: number } | null
}

const fact = <T>(s: RunState, k: string): T | undefined => s.facts[k]?.value as T | undefined
const input = <T>(s: RunState, k: string): T | undefined => s.input[k] as T | undefined
const noul = (s: RunState, k: string): number => { const v = fact<unknown>(s, k); return typeof v === 'number' ? v : NaN }
const lensOf = (s: RunState): { lens: LensKey; label: string } => { const lens = input<LensKey>(s, 'lens') ?? 'market'; return { lens, label: LENSES[lens].label } }

export const CODE: Record<string, CodeFn> = {
  // -- main --
  fleet_expand: (s) => {
    const pick = fact<string>(s, 'pick_lenses')
    const bundle: LensBundle = pick && pick in LENS_BUNDLES ? (pick as LensBundle) : 'full'
    const set = new Set(LENS_BUNDLES[bundle])
    return { facts: { lens_bundle: pick === 'unsure' ? 'full (router unsure)' : bundle, lens_plan: Object.fromEntries(LENS_KEYS.map((k) => [k, set.has(k)])) } }
  },
  fleet_collect: (s) => {
    const results = (fact<Record<string, unknown>>(s, 'lens_results') ?? {}) as Record<string, LensResult> & { real_keywords?: RealKeywords | null }
    const rk = results.real_keywords ?? null
    const keywords_text = rk && rk.terms.length ? rk.terms.slice(0, 30).map((t) => '- ' + t).join('\n') : ''
    const ordered = LENS_KEYS.map((k) => results[k] ?? { lens: k, label: LENSES[k].label, status: 'error' as const, finding: null, error: 'branch failed' })
    const usable = ordered.filter((r) => (r.status === 'accepted' || r.status === 'verified') && r.finding)
    const findings_text = usable.map((r) => findingText(r.finding)).join('\n\n') || '(no usable findings)'
    return { facts: { lenses: ordered, findings_text, keywords_text, usable_count: usable.length } }
  },
  fleet_render: (s) => {
    const draft = fact<{ plan: ListingPlan }>(s, 'draft')
    return { facts: { draft_text: planText(draft?.plan), verdict_text: verdictText(fact<Verdict>(s, 'verdict')) } }
  },
  fleet_redraft: (s) => {
    const v = fact<Verdict>(s, 'verdict')
    const fb = `The verifier flagged: ${[...(v?.risks ?? []), ...(v?.complianceNotes ?? [])].join('; ') || v?.verdict || 'unspecified concerns'}`
    return { facts: { redrafted: true, verifier_feedback: fb } }
  },
  fleet_allow: () => ({ facts: { approval: 'allow', status: 'complete' } }),
  fleet_confirm: () => ({ facts: { approval: 'confirm', status: 'complete' } }),
  fleet_human_review: () => ({ facts: { approval: 'human_review', status: 'complete' } }),
  fleet_incomplete: () => ({ facts: { approval: 'human_review', status: 'incomplete' } }),
  fleet_no_plan: () => ({ facts: { approval: null, status: 'no_plan' } }),
  fleet_output: (s) => {
    const draft = fact<{ plan: ListingPlan; rubric_pass: boolean; rounds: number; failing: string[] }>(s, 'draft')
    const q = s.assessments.quality, r = s.assessments.risk
    const result: FleetResult = {
      status: fact<FleetResult['status']>(s, 'status') ?? 'no_plan',
      approval: fact<Approval | null>(s, 'approval') ?? null,
      lens_bundle: fact<string>(s, 'lens_bundle') ?? 'full',
      lenses: fact<LensResult[]>(s, 'lenses') ?? [],
      plan: draft?.plan ?? null,
      rubric: draft ? { pass: draft.rubric_pass, rounds: draft.rounds, failing: draft.failing } : null,
      verdict: fact<Verdict>(s, 'verdict') ?? null,
      quality: q ? { level: q.level, label: q.label, score: q.score } : null,
      risk: r ? { level: r.level, label: r.label, score: r.score } : null,
    }
    return { facts: { result } }
  },

  // -- lens-run --
  lens_skip: (s) => ({ facts: { result: { ...lensOf(s), status: 'skipped', finding: null } satisfies LensResult } }),
  lens_render: (s) => ({ facts: { finding_text: findingText(fact<LensFinding>(s, 'finding')) } }),
  lens_name_gap: (s) => {
    const gaps: string[] = []
    if (noul(s, 'grounded') < THRESHOLDS.gate_extra_bar) gaps.push('make every point about THIS product and category, not generic listing advice')
    if (noul(s, 'specific') < THRESHOLDS.gate_extra_bar) gaps.push('give concrete content per point: exact terms, numbers, phrases, questions or competitor names')
    if (noul(s, 'sourced') < THRESHOLDS.gate_extra_bar) gaps.push('name the sources (sites, data, or the scraped reviews) for each fact')
    return { facts: { retried: true, gap: gaps.join('; ') || 'be more specific and grounded in this exact product' } }
  },
  lens_accept: (s) => ({ facts: { result: { ...lensOf(s), status: fact(s, 'retried') ? 'verified' : 'accepted', finding: fact<LensFinding>(s, 'finding') ?? null, gap: fact<string>(s, 'gap') } satisfies LensResult } }),
  lens_reject: (s) => ({ facts: { result: { ...lensOf(s), status: 'rejected', finding: fact<LensFinding>(s, 'finding') ?? null, gap: fact<string>(s, 'gap') } satisfies LensResult } }),
  lens_failed: (s) => ({ facts: { result: { ...lensOf(s), status: 'error', finding: null, error: s.last.error ?? 'lens failed' } satisfies LensResult } }),

  // -- draft-loop --
  draft_init: (s) => ({ facts: { feedback: input<string>(s, 'feedback') ?? '' } }),
  draft_fit: (s) => {
    const p = fact<ListingPlan>(s, 'draft')
    const limits_ok = !!p && p.optimizedTitle.length <= TITLE_LIMIT && p.itemHighlights.length <= HIGHLIGHTS_LIMIT
    return { facts: { limits_ok, draft_text: planText(p) } }
  },
  draft_score: (s) => {
    const failing: string[] = []
    if (!fact<boolean>(s, 'limits_ok')) failing.push(`char limits (title <=${TITLE_LIMIT}, Item Highlights <=${HIGHLIGHTS_LIMIT})`)
    for (const [k, bar] of Object.entries(THRESHOLDS.rubric)) {
      if (k === 'overall') continue
      if (!(noul(s, k) >= bar)) failing.push(k.replace('_', ' '))
    }
    const overall = fact<boolean | 'unsure'>(s, 'rubric')
    if (overall !== true) failing.push('overall readiness')
    const rounds = (fact<number>(s, 'rounds') ?? 0) + 1
    return { facts: { rubric_pass: failing.length === 0, failing, rounds, result: { plan: fact<ListingPlan>(s, 'draft'), rubric_pass: failing.length === 0, rounds, failing } } }
  },
  draft_rewrite: (s) => ({ facts: { feedback: (fact<string[]>(s, 'failing') ?? []).map((f) => '- ' + f).join('\n') } }),
  draft_best_effort: (s) => ({ facts: { result: { plan: fact<ListingPlan>(s, 'draft'), rubric_pass: false, rounds: fact<number>(s, 'rounds') ?? 0, failing: fact<string[]>(s, 'failing') ?? [] } } }),
}

