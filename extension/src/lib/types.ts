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

// Newline-delimited events streamed from /api/research.
export type ResearchEvent =
  | { type: 'start'; lenses: { key: string; label: string }[] }
  | { type: 'agent_start'; key: string; label: string }
  | { type: 'agent_done'; key: string; label: string; finding: LensFinding }
  | { type: 'agent_error'; key: string; label: string; message: string }
  | { type: 'keywords'; alias: string; seeds: string[]; terms: string[] }
  | { type: 'synthesis'; plan: ListingPlan }
  | { type: 'verdict'; verdict: Verdict }
  | { type: 'done'; fleet?: FleetSummary }
  | { type: 'fatal'; message: string; fleet?: FleetSummary }
  // ---- Jev-orchestrated fleet (backend FLEET_MODE=shadow|live); safe to ignore ----
  | { type: 'agent_skipped'; key: string; label: string; reason: string }
  | { type: 'decision'; run: string; node: string; answers: Record<string, unknown>; latency_ms: number; model: string; shadow: boolean }
  | { type: 'edge'; run: string; from: string; label: string; to: string }

export interface FleetSummary {
  run_id: string
  mode: 'shadow' | 'live'
  status?: 'complete' | 'incomplete' | 'no_plan'
  // Staged-change guard. The real approval is the button in this panel, never the model.
  approval?: 'allow' | 'confirm' | 'human_review' | null
  lens_bundle?: string
  rubric?: { pass: boolean; rounds: number; failing: string[] } | null
  jev_calls: number
  agent_calls: number
  wall_ms: number
}
