import { API_BASE } from './config'
import type {
  ScrapedListing,
  ResearchEvent,
  RuntimeMessage,
  Draft,
  Verdict,
  DriftReport,
  BaselineRecord,
} from './types'

// Ask the content script in the active Amazon tab to scrape the listing.
export async function scrapeActiveTab(): Promise<ScrapedListing | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return null
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, {
      type: 'SCRAPE_LISTING',
    } as RuntimeMessage)) as RuntimeMessage
    if (res?.type === 'LISTING_RESULT') return res.payload
    return null
  } catch {
    // Content script not present (not an Amazon PDP, or needs reload).
    return null
  }
}

// Launch the agent fleet and yield each NDJSON event as it streams back.
export async function* streamResearch(
  listing: ScrapedListing
): AsyncGenerator<ResearchEvent> {
  const res = await fetch(`${API_BASE}/api/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ listing }),
  })
  if (!res.ok || !res.body) {
    throw new Error(`research failed: ${res.status} ${await res.text()}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) yield JSON.parse(line) as ResearchEvent
    }
  }
  const tail = buffer.trim()
  if (tail) yield JSON.parse(tail) as ResearchEvent
}

// Re-verify a draft the user edited by hand.
export async function reVerify(listing: ScrapedListing, draft: Draft): Promise<Verdict> {
  const res = await fetch(`${API_BASE}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ listing, draft }),
  })
  if (!res.ok) throw new Error(`verify failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Verdict
}

// Compare an approved baseline vs the current live listing.
export async function checkDrift(
  baseline: ScrapedListing,
  current: ScrapedListing
): Promise<DriftReport> {
  const res = await fetch(`${API_BASE}/api/drift`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseline, current }),
  })
  if (!res.ok) throw new Error(`drift failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as DriftReport
}

// DEMO: fabricate an Amazon-style rewrite of the baseline and run the real drift agent on it.
export async function simulateRewrite(
  baseline: ScrapedListing
): Promise<{ simulatedTitle: string; report: DriftReport }> {
  const res = await fetch(`${API_BASE}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseline }),
  })
  if (!res.ok) throw new Error(`simulate failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as { simulatedTitle: string; report: DriftReport }
}

// ---- Baseline persistence (chrome.storage.local, keyed by ASIN) ----
const baselineKey = (asin: string) => `baseline:${asin}`

export async function getBaseline(asin: string): Promise<BaselineRecord | null> {
  const key = baselineKey(asin)
  const store = await chrome.storage.local.get(key)
  return (store[key] as BaselineRecord | undefined) ?? null
}

export async function saveBaseline(listing: ScrapedListing): Promise<BaselineRecord> {
  const record: BaselineRecord = { listing, savedAt: new Date().toISOString() }
  await chrome.storage.local.set({ [baselineKey(listing.asin)]: record })
  return record
}
