import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors, badRequest, type ScrapedListing } from '../lib/shared.js'
import { runDrift } from '../lib/agents.js'

// Compare an approved baseline listing vs the current live listing — the
// Listing Sentinel loop (catches silent July-27 AI rewrites).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return badRequest(res, 'POST only')

  const baseline = (req.body?.baseline ?? null) as ScrapedListing | null
  const current = (req.body?.current ?? null) as ScrapedListing | null
  if (!baseline?.title || !current?.title) return badRequest(res, 'Missing baseline or current listing')

  try {
    res.status(200).json(await runDrift(baseline, current))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'drift failed' })
  }
}
