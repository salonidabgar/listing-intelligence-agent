import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors, PLAN_SCHEMA, VERDICT_SCHEMA, type ScrapedListing } from '../lib/shared.js'
import { runAgentText, runStructured, extractJson, MODELS } from '../lib/claude.js'

interface LensFinding {
  title: string
  summary: string
  points: string[]
  sources: string[]
}

const LENS_SHAPE = `{ "title": string, "summary": string (1-2 sentences), "points": string[] (3-5 concrete findings), "sources": string[] (URLs you actually used, may be empty) }`

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
    label: 'Keyword / SEO + Rufus agent',
    role: "You are an Amazon SEO strategist. Use web search to find high-intent keywords buyers use, and assess machine-legibility for Amazon's AI discovery layer (Rufus / COSMO). Identify keyword gaps in the current title and bullets.",
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

  try {
    emit({ type: 'start', lenses: LENSES.map((l) => ({ key: l.key, label: l.label })) })

    // Fan out the research lenses in parallel (Sonnet, low effort, web search).
    const findings = await Promise.all(
      LENSES.map(async (lens) => {
        emit({ type: 'agent_start', key: lens.key, label: lens.label })
        try {
          const text = await runAgentText({
            role: `${lens.role}\nRespond with ONLY a JSON object: ${LENS_SHAPE}`,
            prompt: lens.ask(listing),
            search: true,
            effort: 'low',
          })
          const f = extractJson<LensFinding>(text, {
            title: lens.label,
            summary: '(no structured output)',
            points: [],
            sources: [],
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

    // Synthesize with the top model + high effort + guaranteed-valid JSON.
    emit({ type: 'agent_start', key: 'synthesis', label: 'Synthesizer agent (Opus)' })
    const plan = await runStructured({
      model: MODELS.deep,
      effort: 'high',
      maxTokens: 2200,
      schema: PLAN_SCHEMA,
      role: 'You are a senior Amazon listing strategist. Using the research findings, produce an optimized, July-27-compliant listing: optimizedTitle (<=75 chars, front-loaded specifics), itemHighlights (<=125 chars, comma-separated phrases), 5 bullets, aPlusAngle, keywordsToAdd (5-8), and prioritized actions.',
      prompt: `CURRENT LISTING:\nTITLE: ${listing.title}\nBULLETS:\n${listing.bullets.map((b) => '- ' + b).join('\n')}\n\nRESEARCH FINDINGS:\n${findings
        .map((f) => `## ${f.title}\n${f.summary}\n${f.points.map((p) => '- ' + p).join('\n')}`)
        .join('\n\n')}`,
    })
    emit({ type: 'synthesis', plan })

    // Verify / red-team (Sonnet, medium effort, structured verdict).
    emit({ type: 'agent_start', key: 'verify', label: 'Verifier (red-team) agent' })
    const verdict = await runStructured({
      effort: 'medium',
      schema: VERDICT_SCHEMA,
      role: 'You are an adversarial reviewer. Red-team the proposed listing for factual overreach, Amazon policy violations, title (<=75) and Item-Highlights (<=125) length limits, and any lost selling specifics vs the original. Count characters exactly.',
      prompt: `ORIGINAL TITLE: ${listing.title}\n\nPROPOSED:\n${JSON.stringify(plan, null, 2)}`,
    })
    emit({ type: 'verdict', verdict })

    emit({ type: 'done' })
    res.end()
  } catch (err) {
    emit({ type: 'fatal', message: err instanceof Error ? err.message : 'research failed' })
    res.end()
  }
}
