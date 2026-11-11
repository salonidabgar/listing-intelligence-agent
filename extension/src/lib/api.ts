import { API_BASE } from './config'
import type {
  ScrapedListing,
  ResearchEvent,
  RuntimeMessage,
  Draft,
  Verdict,
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

// POST JSON with a hard timeout, so a stalled or rate-limited request fails with
// a clear message instead of spinning forever.
async function postJson<T>(path: string, body: unknown, timeoutMs = 90000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s — the model may be rate-limited. Try again.`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// Re-verify a draft the user edited by hand.
export function reVerify(listing: ScrapedListing, draft: Draft): Promise<Verdict> {
  return postJson<Verdict>('/api/verify', { listing, draft })
}
