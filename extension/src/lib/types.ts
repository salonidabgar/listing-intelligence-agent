// Shared types between content script, side panel, and backend.

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

export interface ReviewSnippet {
  title: string | null
  body: string
  rating: number | null
}

// Message protocol: side panel <-> content script
export type RuntimeMessage =
  | { type: 'SCRAPE_LISTING' }
  | { type: 'LISTING_RESULT'; payload: ScrapedListing | null }

// ---- Deep-research agent contracts ----

export interface LensFinding {
  title: string
  summary: string
  points: string[]
  sources: string[]
}

export interface ListingPlan {
  optimizedTitle?: string
  itemHighlights?: string
  bullets?: string[]
  aPlusAngle?: string
  keywordsToAdd?: string[]
  actions?: { priority: 'high' | 'medium' | 'low'; action: string }[]
}

export interface Verdict {
  titleCharCount?: number
  highlightsCharCount?: number
  risks?: string[]
  complianceNotes?: string[]
  confidence?: 'high' | 'medium' | 'low'
  verdict?: string
}

// A draft the user edits and re-verifies.
export interface Draft {
  optimizedTitle: string
  itemHighlights: string
  bullets: string[]
}

// ---- Drift monitoring ----
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

export interface BaselineRecord {
  listing: ScrapedListing
  savedAt: string // ISO
}

// Newline-delimited events streamed from /api/research.
export type ResearchEvent =
  | { type: 'start'; lenses: { key: string; label: string }[] }
  | { type: 'agent_start'; key: string; label: string }
  | { type: 'agent_done'; key: string; label: string; finding: LensFinding }
  | { type: 'agent_error'; key: string; label: string; message: string }
  | { type: 'synthesis'; plan: ListingPlan }
  | { type: 'verdict'; verdict: Verdict }
  | { type: 'done' }
  | { type: 'fatal'; message: string }
