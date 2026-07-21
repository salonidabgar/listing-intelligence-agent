import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { applyCors, badRequest, type ScrapedListing, type CreativeBrief } from '../lib/shared.js'

// Fast + cheap for a live demo. Swap to "claude-opus-4-8" for max quality.
const MODEL = 'claude-sonnet-4-6'

const SHAPE = `{
  "customerPains": string[],      // 3-4
  "customerDesires": string[],    // 3-4
  "heroMessage": string,          // <=6 words
  "callouts": string[],           // 3-4, each <=5 words
  "imagePrompt": string,
  "rationale": string             // 1-2 sentences
}`

const client = new Anthropic() // reads ANTHROPIC_API_KEY

// Extract the first JSON object from the model's text (tolerates stray prose/fences).
function parseBrief(text: string): CreativeBrief {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object in model output')
  return JSON.parse(text.slice(start, end + 1)) as CreativeBrief
}

function buildPrompt(l: ScrapedListing): string {
  const reviews = l.reviews
    .map((r) => `- (${r.rating ?? '?'}★) ${r.title ? r.title + ': ' : ''}${r.body}`)
    .join('\n')
  return [
    'You are an expert Amazon listing strategist trained on thousands of high-converting listings.',
    'Analyze this product and its reviews, then produce a creative brief for a NEW high-converting main image / infographic.',
    '',
    `TITLE: ${l.title}`,
    l.brand ? `BRAND: ${l.brand}` : '',
    l.price ? `PRICE: ${l.price}` : '',
    l.rating ? `RATING: ${l.rating} (${l.reviewCount ?? ''})` : '',
    '',
    'BULLETS:',
    l.bullets.map((b) => `- ${b}`).join('\n') || '(none scraped)',
    '',
    'TOP REVIEWS:',
    reviews || '(none scraped)',
    '',
    'Rules:',
    '- customerPains / customerDesires: 3-4 each, mined from the actual reviews and bullets.',
    '- heroMessage: a punchy <=6-word headline for the image.',
    '- callouts: 3-4 short badge texts (specs/benefits buyers care about), each <=5 words.',
    '- imagePrompt: a vivid prompt to regenerate the main product image on a clean white background with the callouts arranged in a clear visual hierarchy. Keep the real product recognizable.',
    '- rationale: 1-2 sentences on why these choices lift CTR/CVR, citing review themes.',
    '',
    'Respond with ONLY a valid JSON object (no markdown fences, no prose) matching this shape:',
    SHAPE,
  ]
    .filter(Boolean)
    .join('\n')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return badRequest(res, 'POST only')

  const listing = (req.body?.listing ?? null) as ScrapedListing | null
  if (!listing?.title) return badRequest(res, 'Missing listing.title')

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: buildPrompt(listing) }],
    })
    const text = msg.content.find((b) => b.type === 'text')?.text ?? '{}'
    res.status(200).json(parseBrief(text))
  } catch (err) {
    console.error('[analyze] error', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'analyze failed' })
  }
}
