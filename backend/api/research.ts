import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors, PLAN_SCHEMA, type ScrapedListing } from '../lib/shared.js'
import { runSearchStructured, runStructured, MODELS } from '../lib/claude.js'
import { runVerify } from '../lib/agents.js'
import { getRealKeywords, type RealKeywords } from '../lib/keywords.js'
import { fleetMode } from '../lib/fleet/shadow.js'
import { runFleet } from '../lib/fleet/run.js'

interface LensFinding {
  title: string
  summary: string
  points: string[]
  sources: string[]
}

const LENS_SCHEMA = {
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

const LENSES = [
  {
    key: 'market',
    label: 'Market & Competitor agent',
    role: 'You are an Amazon competitive-intelligence analyst. Use web search to study competing products in this category, their positioning, price bands, and what makes the top listings win.',
    ask: (l: ScrapedListing) =>
      `Research the competitive landscape for this Amazon product and how it can stand out.\nPRODUCT: ${l.title}\nBRAND: ${l.brand ?? '?'} · PRICE: ${l.price ?? '?'} · ${l.rating ?? ''} (${l.reviewCount ?? ''})`,
  },
  {
    key: 'keywords',
    label: 'Keyword / SEO agent',
    role: "You are an Amazon SEO strategist. Use web search to find high-intent keywords buyers use, then optimize so the listing reads clearly for Amazon's AI discovery layer (A9/A10 ranking, and gen-AI surfaces like Rufus/COSMO) — front-loaded specifics, structured attributes, use-case language. This does NOT call any Rufus API; it only makes the copy machine-legible. Identify keyword gaps in the current title and bullets.",
    ask: (l: ScrapedListing) =>
      `Find keyword and discoverability gaps for this listing (front-loaded specifics, structured attributes, use-case language).\nTITLE: ${l.title}\nBULLETS:\n${l.bullets.map((b) => '- ' + b).join('\n') || '(none)'}`,
  },
  {
    key: 'voice',
    label: 'Voice-of-customer agent',
    role: 'You are a customer-insight researcher. Mine the provided reviews AND search the web for common complaints/desires about products like this. Surface the exact pains and desires buyers express.',
    ask: (l: ScrapedListing) =>
      `Extract the dominant customer pains and desires for this product.\nPRODUCT: ${l.title}\nREVIEWS:\n${l.reviews.map((r) => `- (${r.rating ?? '?'}★) ${r.title ? r.title + ': ' : ''}${r.body}`).join('\n') || '(none scraped — rely on web search for the category)'}`,
  },
  {
    key: 'compliance',
    label: 'Compliance / July-27 agent',
    role: "You are an Amazon listing-compliance specialist. Using the July-27 2026 policy in your system context (confirm via web search if useful), audit THIS listing's title for length and rewrite risk, and flag selling specifics an AI rewrite could strip.",
    ask: (l: ScrapedListing) =>
      `Audit this title for Amazon compliance and July-27 2026 rewrite risk.\nTITLE (${l.title.length} chars): ${l.title}`,
  },
] as const

const FIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { optimizedTitle: { type: 'string' }, itemHighlights: { type: 'string' } },
  required: ['optimizedTitle', 'itemHighlights'],
} as const

function hardTrim(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut
  return base.replace(/[\s,\-|&]+$/, '').trim()
}

// Guarantee the shipped title <=75 and Item Highlights <=125 chars. The model
// occasionally overshoots the limit, so retry it (cheaply) to shorten while
// preserving the key specifics, then hard-trim to a word boundary as a last resort.
async function fitToLimits(plan: { optimizedTitle?: string; itemHighlights?: string }): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const tLen = (plan.optimizedTitle ?? '').length
    const hLen = (plan.itemHighlights ?? '').length
    if (tLen <= 75 && hLen <= 125) return
    try {
      const fix = await runStructured<{ optimizedTitle: string; itemHighlights: string }>({
        model: MODELS.fast,
        effort: 'low',
        schema: FIT_SCHEMA,
        role: 'You shorten Amazon listing fields to fit HARD character limits while keeping the most important selling specifics and keywords, front-loaded. Never exceed the limits; drop the least important words first.',
        prompt: `Rewrite to fit exactly:\n- title: at most 75 characters (it is currently ${tLen})\n- itemHighlights: at most 125 characters (it is currently ${hLen})\ntitle: ${plan.optimizedTitle}\nitemHighlights: ${plan.itemHighlights}`,
      })
      plan.optimizedTitle = fix.optimizedTitle
      plan.itemHighlights = fix.itemHighlights
    } catch {
      break
    }
  }
  if ((plan.optimizedTitle ?? '').length > 75) plan.optimizedTitle = hardTrim(plan.optimizedTitle!, 75)
  if ((plan.itemHighlights ?? '').length > 125) plan.itemHighlights = hardTrim(plan.itemHighlights!, 125)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const listing = (req.body?.listing ?? null) as ScrapedListing | null
  if (!listing?.title) {
    res.status(400).json({ error: 'Missing listing.title' })
    return
  }

  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  const emit = (event: Record<string, unknown>) => res.write(JSON.stringify(event) + '\n')

  // FLEET_MODE=shadow|live → the Jev-orchestrated tree (lib/fleet). Same event stream;
  // `off` (default) keeps the fixed fan-out below.
  const mode = fleetMode()
  if (mode !== 'off') {
    try {
      await runFleet(listing, emit, { mode })
    } catch (err) {
      emit({ type: 'fatal', message: err instanceof Error ? err.message : 'fleet failed' })
    }
    res.end()
    return
  }

  try {
    emit({ type: 'start', lenses: LENSES.map((l) => ({ key: l.key, label: l.label })) })

    // Kick off the real-keyword pull (Claude extracts seeds -> Amazon autocomplete
    // supplies the actual popularity-ranked queries). Runs alongside the lenses;
    // only the keyword lens waits on it.
    const realKeywordsPromise: Promise<RealKeywords | null> = getRealKeywords(listing, {
      expand: false,
      cap: 60,
    }).catch(() => null)

    // Fan out the research lenses in parallel (Sonnet, low effort).
    const findings = await Promise.all(
      LENSES.map(async (lens) => {
        emit({ type: 'agent_start', key: lens.key, label: lens.label })
        try {
          // Keyword lens is GROUNDED in real Amazon autocomplete instead of guessing
          // from web pages. Falls back to web search if the pull failed.
          if (lens.key === 'keywords') {
            const rk = await realKeywordsPromise
            if (rk && rk.terms.length) {
              emit({ type: 'keywords', alias: rk.alias, seeds: rk.seeds, terms: rk.terms })
              const f = await runStructured<LensFinding>({
                model: MODELS.fast,
                effort: 'low',
                schema: LENS_SCHEMA,
                role:
                  "You are an Amazon SEO strategist. You are given REAL Amazon autocomplete queries — what shoppers actually type for this product's category, in popularity order (top = most searched). Do a coverage-gap analysis: which high-popularity terms/modifiers are MISSING from the current title and bullets, which are phrased differently than shoppers search, and which should be front-loaded. Do NOT invent keywords outside the provided list.",
                prompt:
                  `Coverage-gap analysis for this listing against real shopper queries.\n` +
                  `Return: title, a summary of the biggest gaps, points (each a specific missing/mis-phrased term to add and where — title vs Item Highlights), and sources.\n\n` +
                  `CURRENT TITLE: ${listing.title}\n` +
                  `CURRENT BULLETS:\n${listing.bullets.map((b) => '- ' + b).join('\n') || '(none)'}\n\n` +
                  `REAL AMAZON AUTOCOMPLETE (department "${rk.alias}", seeds: ${rk.seeds.join(', ')}), popularity order:\n${rk.terms.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
              })
              // Attribute the real provenance.
              f.sources = [`Amazon autocomplete · department "${rk.alias}" · ${rk.terms.length} real queries`]
              emit({ type: 'agent_done', key: lens.key, label: lens.label, finding: f })
              return { key: lens.key, ...f }
            }
          }
          const f = await runSearchStructured<LensFinding>({
            role: lens.role,
            prompt: lens.ask(listing),
            schema: LENS_SCHEMA,
            effort: 'low',
          })
          emit({ type: 'agent_done', key: lens.key, label: lens.label, finding: f })
          return { key: lens.key, ...f }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'agent failed'
          emit({ type: 'agent_error', key: lens.key, label: lens.label, message })
          return { key: lens.key, title: lens.label, summary: message, points: [], sources: [] }
        }
      })
    )

    const realKeywords = await realKeywordsPromise

    // Synthesize with the top model (Opus). One retry; a persistent failure
    // degrades gracefully — the streamed research findings stay on screen, we
    // just skip the plan + verdict instead of aborting the whole run.
    emit({ type: 'agent_start', key: 'synthesis', label: 'Synthesizer agent (Opus)' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let plan: any = null
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      try {
        plan = await runStructured({
          model: MODELS.deep,
          effort: 'medium',
          maxTokens: 2200,
          schema: PLAN_SCHEMA,
          role: 'You are a senior Amazon listing strategist. Using the research findings, produce an optimized, July-27-compliant listing: optimizedTitle (<=75 chars, front-loaded specifics), itemHighlights (<=125 chars, comma-separated phrases), 5 bullets, aPlusAngle, keywordsToAdd (5-8), and prioritized actions. Prefer the exact phrasing from the real shopper queries where relevant; front-load the highest-popularity terms in the title and put overflow terms in itemHighlights.',
          prompt: `CURRENT LISTING:\nTITLE: ${listing.title}\nBULLETS:\n${listing.bullets.map((b) => '- ' + b).join('\n')}\n${
            realKeywords && realKeywords.terms.length
              ? `\nREAL AMAZON SHOPPER QUERIES (autocomplete, popularity order — use this exact phrasing):\n${realKeywords.terms
                  .slice(0, 30)
                  .map((t) => '- ' + t)
                  .join('\n')}\n`
              : ''
          }\nRESEARCH FINDINGS:\n${findings
            .map((f) => `## ${f.title}\n${f.summary}\n${f.points.map((p) => '- ' + p).join('\n')}`)
            .join('\n\n')}`,
        })
      } catch (err) {
        if (attempt === 1) {
          emit({ type: 'agent_error', key: 'synthesis', label: 'Synthesizer agent (Opus)', message: err instanceof Error ? err.message : 'synthesis failed' })
        }
      }
    }

    if (plan) {
      await fitToLimits(plan as { optimizedTitle?: string; itemHighlights?: string })
      emit({ type: 'synthesis', plan })

      // Verify / red-team (Sonnet). Non-fatal: a verifier failure still leaves
      // the optimized listing on screen rather than discarding the whole run.
      emit({ type: 'agent_start', key: 'verify', label: 'Verifier (red-team) agent' })
      const p = plan as { optimizedTitle?: string; itemHighlights?: string; bullets?: string[] }
      try {
        const verdict = await runVerify(listing, {
          optimizedTitle: p.optimizedTitle ?? '',
          itemHighlights: p.itemHighlights ?? '',
          bullets: p.bullets ?? [],
        })
        emit({ type: 'verdict', verdict })
      } catch (err) {
        emit({ type: 'agent_error', key: 'verify', label: 'Verifier (red-team) agent', message: err instanceof Error ? err.message : 'verify failed' })
      }
    }

    emit({ type: 'done' })
    res.end()
  } catch (err) {
    emit({ type: 'fatal', message: err instanceof Error ? err.message : 'research failed' })
    res.end()
  }
}
