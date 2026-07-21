import type { VercelRequest, VercelResponse } from '@vercel/node'
import { GoogleGenAI } from '@google/genai'
import { applyCors, badRequest, type ScrapedListing, type CreativeBrief } from '../lib/shared.js'

// Gemini 2.5 Flash Image ("nano banana") — edits/re-renders using the real
// product photo as a reference, which is exactly what an Amazon main image needs.
const MODEL = 'gemini-2.5-flash-image'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// Fetch the product image and return base64 + mime, or null if unavailable.
async function fetchImage(url: string | null): Promise<{ data: string; mimeType: string } | null> {
  if (!url) return null
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const mimeType = resp.headers.get('content-type') ?? 'image/jpeg'
    const buf = Buffer.from(await resp.arrayBuffer())
    return { data: buf.toString('base64'), mimeType }
  } catch {
    return null
  }
}

function buildPrompt(listing: ScrapedListing, brief: CreativeBrief): string {
  return [
    brief.imagePrompt,
    '',
    `Headline to feature: "${brief.heroMessage}".`,
    `Benefit callouts to render as clean badges: ${brief.callouts.join(' · ')}.`,
    'Output a square (1:1) Amazon-compliant main image: the real product as the hero on a pure white background,',
    'studio lighting, sharp focus, professional e-commerce quality. Keep any callout text short and legible.',
    'Do not distort the product or invent a different product.',
  ].join('\n')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return badRequest(res, 'POST only')

  const listing = (req.body?.listing ?? null) as ScrapedListing | null
  const brief = (req.body?.brief ?? null) as CreativeBrief | null
  if (!listing || !brief?.imagePrompt) return badRequest(res, 'Missing listing or brief.imagePrompt')

  try {
    const product = await fetchImage(listing.mainImage)
    const parts: Array<Record<string, unknown>> = [{ text: buildPrompt(listing, brief) }]
    if (product) {
      parts.push({ inlineData: { mimeType: product.mimeType, data: product.data } })
    }

    const result = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
    })

    const out = result.candidates?.[0]?.content?.parts?.find(
      (p): p is { inlineData: { data: string; mimeType?: string } } =>
        !!(p as { inlineData?: unknown }).inlineData
    )
    if (!out?.inlineData?.data) {
      return res.status(502).json({ error: 'Image model returned no image' })
    }

    res.status(200).json({
      imageBase64: out.inlineData.data,
      mimeType: out.inlineData.mimeType ?? 'image/png',
    })
  } catch (err) {
    console.error('[generate] error', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'generate failed' })
  }
}
