import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors, badRequest, type ScrapedListing, type Draft } from '../lib/shared.js'
import { runVerify } from '../lib/agents.js'

// Re-verify a draft the user edited by hand → fresh red-team verdict.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return badRequest(res, 'POST only')

  const listing = (req.body?.listing ?? null) as ScrapedListing | null
  const draft = (req.body?.draft ?? null) as Draft | null
  if (!listing || !draft?.optimizedTitle) return badRequest(res, 'Missing listing or draft')

  try {
    res.status(200).json(await runVerify(listing, draft))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'verify failed' })
  }
}
