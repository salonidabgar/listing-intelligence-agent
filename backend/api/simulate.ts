import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors, badRequest, type ScrapedListing } from '../lib/shared.js'
import { runStructured, MODELS } from '../lib/claude.js'
import { runDrift } from '../lib/agents.js'

// DEMO control. Role-plays Amazon's July-27 rewrite on the saved baseline, then
// runs the REAL drift agent on the result — so the alert is genuine detection,
// only the "after" is fabricated. Lets the drift feature be demoed on demand.
const REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'bullets'],
} as const

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return badRequest(res, 'POST only')

  const baseline = (req.body?.baseline ?? null) as ScrapedListing | null
  if (!baseline?.title) return badRequest(res, 'Missing baseline listing')

  try {
    const rewrite = await runStructured<{ title: string; bullets: string[] }>({
      model: MODELS.fast,
      effort: 'low',
      schema: REWRITE_SCHEMA,
      role: "You are role-playing Amazon's July-27 automated title-rewrite engine for a demo. Rewrite the given title to 75 characters or fewer: make it clean, generic and grammatical, and DROP selling specifics (dose, count, material, certifications, variant). Also strip the bullets down to one or two generic phrases. Return only the rewritten title and bullets — this is the kind of title Amazon's AI would silently publish.",
      prompt: `ORIGINAL TITLE: ${baseline.title}\nORIGINAL BULLETS:\n${baseline.bullets.map((b) => '- ' + b).join('\n')}`,
    })

    const current = { ...baseline, title: rewrite.title, bullets: rewrite.bullets }
    const report = await runDrift(baseline, current)
    res.status(200).json({ simulatedTitle: rewrite.title, report })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'simulate failed' })
  }
}
