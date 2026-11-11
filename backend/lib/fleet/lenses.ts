// The research lenses as engine tools. Claude does the research and writing here;
// Jev (in workflow.ts) decides which lenses run and whether their output is usable.
//
// Deviation from the plan's "agentTool(ClaudeAgent)": the lenses wrap the project's
// existing structured helpers instead of the vendored plain-text ClaudeAgent, because
// those give schema-constrained JSON, the web_search server tool, and the cached
// July-27 policy context. Usage is still metered into the run via ctx.meter.
import type { Tool } from '../jev/runtime/engine.js'
import { runSearchStructured, runStructured, MODELS, type CallUsage } from '../claude.js'
import { PLAN_SCHEMA, type ScrapedListing, type Draft, type Verdict } from '../shared.js'
import { getRealKeywords, type RealKeywords } from '../keywords.js'
import { runVerify } from '../agents.js'

export interface LensFinding {
  title: string
  summary: string
  points: string[]
  sources: string[]
}

export type LensKey = 'market' | 'keywords' | 'voice' | 'compliance' | 'aco'
export const LENS_KEYS: LensKey[] = ['market', 'keywords', 'voice', 'compliance', 'aco']

export const LENS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'points', 'sources'],
} as const

const bullets = (l: ScrapedListing) => l.bullets.map((b) => '- ' + b).join('\n') || '(none)'

export const LENSES: Record<LensKey, { label: string; role: string; ask: (l: ScrapedListing) => string }> = {
  market: {
    label: 'Market & Competitor agent',
    role: 'You are an Amazon competitive-intelligence analyst. Use web search to study competing products in this category, their positioning, price bands, and what makes the top listings win.',
    ask: (l) =>
      `Research the competitive landscape for this Amazon product and how it can stand out.\nPRODUCT: ${l.title}\nBRAND: ${l.brand ?? '?'} · PRICE: ${l.price ?? '?'} · ${l.rating ?? ''} (${l.reviewCount ?? ''})`,
  },
  keywords: {
    label: 'Keyword / SEO agent',
    role: "You are an Amazon SEO strategist. Use web search to find high-intent keywords buyers use, then optimize so the listing reads clearly for Amazon's AI discovery layer (A9/A10 ranking, and gen-AI surfaces like Rufus/COSMO) — front-loaded specifics, structured attributes, use-case language. Identify keyword gaps in the current title and bullets.",
    ask: (l) =>
      `Find keyword and discoverability gaps for this listing (front-loaded specifics, structured attributes, use-case language).\nTITLE: ${l.title}\nBULLETS:\n${bullets(l)}`,
  },
  voice: {
    label: 'Voice-of-customer agent',
    role: 'You are a customer-insight researcher. Mine the provided reviews AND search the web for common complaints/desires about products like this. Surface the exact pains and desires buyers express.',
    ask: (l) =>
      `Extract the dominant customer pains and desires for this product.\nPRODUCT: ${l.title}\nREVIEWS:\n${l.reviews.map((r) => `- (${r.rating ?? '?'}★) ${r.title ? r.title + ': ' : ''}${r.body}`).join('\n') || '(none scraped — rely on web search for the category)'}`,
  },
  compliance: {
    label: 'Compliance / July-27 agent',
    role: "You are an Amazon listing-compliance specialist. Using the July-27 2026 policy in your system context (confirm via web search if useful), audit THIS listing's title for length and rewrite risk, flag selling specifics an AI rewrite could strip, and flag regulated or unsubstantiated claims.",
    ask: (l) =>
      `Audit this listing for Amazon compliance and July-27 2026 rewrite risk.\nTITLE (${l.title.length} chars): ${l.title}\nBULLETS:\n${bullets(l)}`,
  },
  // New lens: can an AI shopping assistant (Rufus, COSMO, and off-Amazon assistants)
  // answer the questions shoppers ask about this product FROM the listing text alone?
  aco: {
    label: 'AI-answerability (ACO) agent',
    role: "You are an answer-engine optimization (ACO) analyst for Amazon. Shoppers increasingly ask AI assistants (Amazon Rufus, and general assistants) questions like 'is this dishwasher safe?', 'does it fit a queen bed?', 'how long does the battery last?'. Use web search to find the questions buyers ask about this product category, then check whether THIS listing's title and bullets state the answer explicitly. Report the unanswered questions and the exact attribute/value the listing should state for each, as structured facts an assistant can quote.",
    ask: (l) =>
      `Answerability audit: which common shopper questions can an AI assistant NOT answer from this listing text?\nPRODUCT: ${l.title}\nBULLETS:\n${bullets(l)}\nReturn: title, a summary of the answerability gap, points (one per unanswered question: the question → the attribute/value to add and where: title, Item Highlights, or bullets), and sources.`,
  },
}

export interface LensToolDeps {
  listing: ScrapedListing
  /** Real Amazon autocomplete terms; started once per run, only the keyword lens waits on it. */
  realKeywords: Promise<RealKeywords | null>
  emit: (e: Record<string, unknown>) => void
}

function meterInto(ctx: { meter: (m: { agent: string; model?: string; usage?: { input_tokens: number; output_tokens: number } }) => void }, agent: string) {
  return (u: CallUsage) => ctx.meter({ agent, model: u.model, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens } })
}

/** Starts the autocomplete pull. Shared by the keyword lens and the synthesizer. */
export function startRealKeywords(listing: ScrapedListing): Promise<RealKeywords | null> {
  return getRealKeywords(listing, { expand: false, cap: 60 }).catch(() => null)
}

/** tool "real_keywords": awaits the shared autocomplete pull so its result lands in state. */
export function realKeywordsTool(deps: LensToolDeps): Tool {
  return async (_args, ctx) => {
    const rk = await deps.realKeywords
    if (rk && rk.terms.length) {
      ctx.meter({ agent: 'keyword-seeds', model: MODELS.fast })
      deps.emit({ type: 'keywords', alias: rk.alias, seeds: rk.seeds, terms: rk.terms })
    }
    return rk
  }
}

/**
 * tool "lens": args { lens, gap? }. One Claude call (web search + structured output).
 * `gap` is set on the bounded retry after a Jev `verify_more` gate: it names what the
 * first pass lacked, derived in code from the gate's ride-along questions.
 */
export function lensTool(deps: LensToolDeps): Tool {
  return async (args, ctx) => {
    const key = String(args.lens) as LensKey
    const lens = LENSES[key]
    if (!lens) throw new Error(`unknown lens "${key}"`)
    const gap = typeof args.gap === 'string' && args.gap ? args.gap : null
    const onUsage = meterInto(ctx, `lens:${key}`)
    deps.emit({ type: 'agent_start', key, label: lens.label, retry: !!gap })
    const gapNote = gap ? `\n\nA reviewer rejected the first pass. Fix exactly this: ${gap}` : ''
    try {
      let f: LensFinding
      if (key === 'keywords') {
        const rk = await deps.realKeywords
        if (rk && rk.terms.length) {
          f = await runStructured<LensFinding>({
            model: MODELS.fast,
            effort: 'low',
            schema: LENS_SCHEMA,
            onUsage,
            role:
              "You are an Amazon SEO strategist. You are given REAL Amazon autocomplete queries — what shoppers actually type for this product's category, in popularity order (top = most searched). Do a coverage-gap analysis: which high-popularity terms/modifiers are MISSING from the current title and bullets, which are phrased differently than shoppers search, and which should be front-loaded. Do NOT invent keywords outside the provided list.",
            prompt:
              `Coverage-gap analysis for this listing against real shopper queries.\n` +
              `Return: title, a summary of the biggest gaps, points (each a specific missing/mis-phrased term to add and where — title vs Item Highlights), and sources.\n\n` +
              `CURRENT TITLE: ${deps.listing.title}\nCURRENT BULLETS:\n${bullets(deps.listing)}\n\n` +
              `REAL AMAZON AUTOCOMPLETE (department "${rk.alias}", seeds: ${rk.seeds.join(', ')}), popularity order:\n${rk.terms.map((t, i) => `${i + 1}. ${t}`).join('\n')}` +
              gapNote,
          })
          f.sources = [`Amazon autocomplete · department "${rk.alias}" · ${rk.terms.length} real queries`]
          deps.emit({ type: 'agent_done', key, label: lens.label, finding: f })
          return f
        }
      }
      f = await runSearchStructured<LensFinding>({
        role: lens.role,
        prompt: lens.ask(deps.listing) + gapNote,
        schema: LENS_SCHEMA,
        effort: 'low',
        onUsage,
      })
      deps.emit({ type: 'agent_done', key, label: lens.label, finding: f })
      return f
    } catch (err) {
      const message = err instanceof Error ? err.message : 'agent failed'
      deps.emit({ type: 'agent_error', key, label: lens.label, message })
      throw err
    }
  }
}

// ---- synthesizer + fit-to-limits (ported from api/research.ts) ----

const FIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { optimizedTitle: { type: 'string' }, itemHighlights: { type: 'string' } },
  required: ['optimizedTitle', 'itemHighlights'],
} as const

export const TITLE_LIMIT = 75
export const HIGHLIGHTS_LIMIT = 125

export function hardTrim(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut
  return base.replace(/[\s,\-|&]+$/, '').trim()
}

export async function fitToLimits(plan: { optimizedTitle?: string; itemHighlights?: string }, onUsage?: (u: CallUsage) => void): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const tLen = (plan.optimizedTitle ?? '').length
    const hLen = (plan.itemHighlights ?? '').length
    if (tLen <= TITLE_LIMIT && hLen <= HIGHLIGHTS_LIMIT) return
    try {
      const fix = await runStructured<{ optimizedTitle: string; itemHighlights: string }>({
        model: MODELS.fast,
        effort: 'low',
        schema: FIT_SCHEMA,
        onUsage,
        role: 'You shorten Amazon listing fields to fit HARD character limits while keeping the most important selling specifics and keywords, front-loaded. Never exceed the limits; drop the least important words first.',
        prompt: `Rewrite to fit exactly:\n- title: at most ${TITLE_LIMIT} characters (it is currently ${tLen})\n- itemHighlights: at most ${HIGHLIGHTS_LIMIT} characters (it is currently ${hLen})\ntitle: ${plan.optimizedTitle}\nitemHighlights: ${plan.itemHighlights}`,
      })
      plan.optimizedTitle = fix.optimizedTitle
      plan.itemHighlights = fix.itemHighlights
    } catch {
      break
    }
  }
  if ((plan.optimizedTitle ?? '').length > TITLE_LIMIT) plan.optimizedTitle = hardTrim(plan.optimizedTitle!, TITLE_LIMIT)
  if ((plan.itemHighlights ?? '').length > HIGHLIGHTS_LIMIT) plan.itemHighlights = hardTrim(plan.itemHighlights!, HIGHLIGHTS_LIMIT)
}

export interface ListingPlan {
  optimizedTitle: string
  itemHighlights: string
  bullets: string[]
  aPlusAngle: string
  keywordsToAdd: string[]
  actions: { priority: 'high' | 'medium' | 'low'; action: string }[]
}

/**
 * tool "synthesizer": args { findings_text, keywords_text, feedback? }. Opus drafts the
 * listing; char limits are then enforced in code (never trusted to the model).
 * `feedback` names the rubric checks the previous draft failed (set by the draft loop).
 */
export function synthesizerTool(deps: LensToolDeps): Tool {
  return async (args, ctx) => {
    const feedback = typeof args.feedback === 'string' && args.feedback ? args.feedback : null
    const onUsage = meterInto(ctx, 'synthesizer')
    deps.emit({ type: 'agent_start', key: 'synthesis', label: 'Synthesizer agent (Opus)', retry: !!feedback })
    try {
      const plan = await runStructured<ListingPlan>({
        model: MODELS.deep,
        effort: 'medium',
        maxTokens: 2200,
        schema: PLAN_SCHEMA,
        onUsage,
        role: 'You are a senior Amazon listing strategist. Using the research findings, produce an optimized, July-27-compliant listing: optimizedTitle (<=75 chars, front-loaded specifics), itemHighlights (<=125 chars, comma-separated phrases), 5 bullets, aPlusAngle, keywordsToAdd (5-8), and prioritized actions. Prefer the exact phrasing from the real shopper queries where relevant; front-load the highest-popularity terms in the title and put overflow terms in itemHighlights. Every claim must trace to the original listing or a research finding — never invent specs.',
        prompt:
          `CURRENT LISTING:\nTITLE: ${deps.listing.title}\nBULLETS:\n${bullets(deps.listing)}\n` +
          (args.keywords_text ? `\nREAL AMAZON SHOPPER QUERIES (autocomplete, popularity order — use this exact phrasing):\n${args.keywords_text}\n` : '') +
          `\nRESEARCH FINDINGS:\n${args.findings_text ?? '(none)'}` +
          (feedback ? `\n\nTHE PREVIOUS DRAFT FAILED THESE CHECKS — fix them without regressing the others:\n${feedback}` : ''),
      })
      await fitToLimits(plan, onUsage)
      deps.emit({ type: 'synthesis', plan })
      return plan
    } catch (err) {
      deps.emit({ type: 'agent_error', key: 'synthesis', label: 'Synthesizer agent (Opus)', message: err instanceof Error ? err.message : 'synthesis failed' })
      throw err
    }
  }
}

/** tool "verifier": args { plan }. The existing red-team agent (exact char counts computed in code). */
export function verifierTool(deps: LensToolDeps): Tool {
  return async (args, ctx) => {
    const p = (args.plan ?? {}) as Partial<Draft>
    deps.emit({ type: 'agent_start', key: 'verify', label: 'Verifier (red-team) agent' })
    try {
      const verdict: Verdict = await runVerify(deps.listing, {
        optimizedTitle: p.optimizedTitle ?? '',
        itemHighlights: p.itemHighlights ?? '',
        bullets: p.bullets ?? [],
      })
      ctx.meter({ agent: 'verifier', model: MODELS.fast })
      deps.emit({ type: 'verdict', verdict })
      return verdict
    } catch (err) {
      deps.emit({ type: 'agent_error', key: 'verify', label: 'Verifier (red-team) agent', message: err instanceof Error ? err.message : 'verify failed' })
      throw err
    }
  }
}

// ---- text renderings Jev reads (small, declared slices of state) ----

export function listingText(l: ScrapedListing): string {
  return `TITLE (${l.title.length} chars): ${l.title}\nBRAND: ${l.brand ?? '?'} · PRICE: ${l.price ?? '?'} · RATING: ${l.rating ?? '?'} (${l.reviewCount ?? '?'} reviews)\nBULLETS:\n${bullets(l)}\nREVIEWS SCRAPED: ${l.reviews.length}`
}

export function findingText(f: LensFinding | null | undefined): string {
  if (!f) return '(no finding)'
  return `## ${f.title}\n${f.summary}\n${f.points.map((p) => '- ' + p).join('\n')}\nSOURCES: ${f.sources.join('; ') || '(none)'}`
}

export function planText(p: Partial<ListingPlan> | null | undefined): string {
  if (!p) return '(no draft)'
  return `TITLE (${(p.optimizedTitle ?? '').length}/${TITLE_LIMIT}): ${p.optimizedTitle ?? ''}\nITEM HIGHLIGHTS (${(p.itemHighlights ?? '').length}/${HIGHLIGHTS_LIMIT}): ${p.itemHighlights ?? ''}\nBULLETS:\n${(p.bullets ?? []).map((b) => '- ' + b).join('\n')}\nKEYWORDS TO ADD: ${(p.keywordsToAdd ?? []).join(', ')}`
}

export function verdictText(v: Partial<Verdict> | null | undefined): string {
  if (!v) return '(verifier did not run)'
  return `VERDICT: ${v.verdict ?? ''} (confidence ${v.confidence ?? '?'})\nRISKS: ${v.risks?.length ? v.risks.join('; ') : 'none'}\nCOMPLIANCE NOTES: ${v.complianceNotes?.length ? v.complianceNotes.join('; ') : 'none'}\nTITLE ${v.titleCharCount ?? '?'}/${TITLE_LIMIT} · HIGHLIGHTS ${v.highlightsCharCount ?? '?'}/${HIGHLIGHTS_LIMIT}`
}
