import type { VercelRequest, VercelResponse } from '@vercel/node'

// Shared types (kept in sync with the extension's src/lib/types.ts).
export interface ReviewSnippet {
  title: string | null
  body: string
  rating: number | null
}

export interface ScrapedListing {
  asin: string
  title: string
  brand: string | null
  price: string | null
  rating: string | null
  reviewCount: string | null
  bullets: string[]
  reviews: ReviewSnippet[]
  mainImage: string | null
  galleryImages: string[]
  marketplace: string
  url: string
}

export interface CreativeBrief {
  customerPains: string[]
  customerDesires: string[]
  heroMessage: string
  callouts: string[]
  imagePrompt: string
  rationale: string
}

// Permissive CORS for the demo — the extension calls from a chrome-extension:// origin.
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}

export function badRequest(res: VercelResponse, message: string) {
  res.status(400).json({ error: message })
}

// ---- Structured-output JSON schemas (output_config.format) ----

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    optimizedTitle: { type: 'string' },
    itemHighlights: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' } },
    aPlusAngle: { type: 'string' },
    keywordsToAdd: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          action: { type: 'string' },
        },
        required: ['priority', 'action'],
      },
    },
  },
  required: ['optimizedTitle', 'itemHighlights', 'bullets', 'aPlusAngle', 'keywordsToAdd', 'actions'],
} as const

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    titleCharCount: { type: 'integer' },
    highlightsCharCount: { type: 'integer' },
    risks: { type: 'array', items: { type: 'string' } },
    complianceNotes: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    verdict: { type: 'string' },
  },
  required: ['titleCharCount', 'highlightsCharCount', 'risks', 'complianceNotes', 'confidence', 'verdict'],
} as const

export const DRIFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changed: { type: 'boolean' },
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          before: { type: 'string' },
          after: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          impact: { type: 'string' },
        },
        required: ['field', 'before', 'after', 'severity', 'impact'],
      },
    },
    droppedSpecifics: { type: 'array', items: { type: 'string' } },
    likelyCause: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          enum: ['amazon_ai_rewrite', 'manual_edit', 'catalog_or_shared_asin', 'no_material_change', 'unknown'],
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        reasoning: { type: 'string' },
      },
      required: ['type', 'confidence', 'reasoning'],
    },
    recommendation: { type: 'string' },
  },
  required: ['changed', 'summary', 'changes', 'droppedSpecifics', 'likelyCause', 'recommendation'],
} as const

// An edited draft the user re-verifies.
export interface Draft {
  optimizedTitle: string
  itemHighlights: string
  bullets: string[]
}

export interface Verdict {
  titleCharCount: number
  highlightsCharCount: number
  risks: string[]
  complianceNotes: string[]
  confidence: 'high' | 'medium' | 'low'
  verdict: string
}

export interface DriftChange {
  field: string
  before: string
  after: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  impact: string
}

export interface DriftCause {
  type: 'amazon_ai_rewrite' | 'manual_edit' | 'catalog_or_shared_asin' | 'no_material_change' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
}

export interface DriftReport {
  changed: boolean
  summary: string
  changes: DriftChange[]
  droppedSpecifics: string[]
  likelyCause: DriftCause
  recommendation: string
}
