// Amazon autocomplete client — real shopper queries, no key, no auth.
// Prefix-based: it completes what you type, so relevance comes from the SEED
// phrase; the `alias` scopes it to a department (removes cross-category noise).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

// Per-marketplace completion host + marketplace id. Queries must hit the RIGHT
// marketplace or a UK/DE/CA/IN listing gets US shopper queries. Keyed by the
// hostname suffix the scraper reports (location.hostname, e.g. "amazon.co.uk").
interface Marketplace {
  host: string
  mid: string
}
const MARKETPLACES: { suffix: string; mp: Marketplace }[] = [
  { suffix: 'amazon.co.uk', mp: { host: 'completion.amazon.co.uk', mid: 'A1F83G8C2ARO7P' } },
  { suffix: 'amazon.de', mp: { host: 'completion.amazon.de', mid: 'A1PA6795UKMFR9' } },
  { suffix: 'amazon.ca', mp: { host: 'completion.amazon.ca', mid: 'A2EUQ1WTGCTBG2' } },
  { suffix: 'amazon.in', mp: { host: 'completion.amazon.in', mid: 'A21TJRUUN4KGV' } },
]
const US: Marketplace = { host: 'completion.amazon.com', mid: 'ATVPDKIKX0DER' }

// Resolve a scraped marketplace string (hostname) to its completion endpoint.
// Unknown / undefined marketplaces fall back to the US endpoint.
export function resolveMarketplace(marketplace?: string): Marketplace {
  const m = (marketplace ?? '').toLowerCase()
  // Anchored suffix match so a look-alike host ("notamazon.co.uk") can't resolve
  // to a real marketplace: require an exact match or a dot-delimited subdomain.
  return MARKETPLACES.find((x) => m === x.suffix || m.endsWith('.' + x.suffix))?.mp ?? US
}

// True when the resolved endpoint is not the US one (used to decide the US-endpoint
// last-resort fallback when a non-US completion host is unreachable, e.g. IN).
export function isNonUsMarketplace(marketplace?: string): boolean {
  return resolveMarketplace(marketplace).host !== US.host
}

interface Suggestion {
  value?: string
}
interface AutocompleteResponse {
  suggestions?: Suggestion[]
}

// Fetch the raw suggestion list for one prefix, in Amazon's popularity order.
export async function fetchAutocomplete(
  prefix: string,
  alias = 'aps',
  marketplace?: string,
): Promise<string[]> {
  const { host, mid } = resolveMarketplace(marketplace)
  const url =
    `https://${host}/api/2017/suggestions` +
    `?mid=${mid}&alias=${encodeURIComponent(alias)}&prefix=${encodeURIComponent(prefix)}`
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return []
    const data = (await r.json()) as AutocompleteResponse
    return (data.suggestions ?? [])
      .map((s) => (s.value ?? '').trim())
      .filter((v) => v.length > 0)
  } catch {
    return []
  }
}

// Gather de-duplicated suggestions across several seeds, preserving first-seen
// (≈ popularity) order. `expand` also queries "<seed> a" … "<seed> z" to harvest
// the long tail. Requests run in small parallel batches to keep latency down.
export async function gatherTerms(
  seeds: string[],
  alias: string,
  opts?: { expand?: boolean; cap?: number; marketplace?: string },
): Promise<string[]> {
  const prefixes: string[] = []
  for (const seed of seeds) {
    prefixes.push(seed)
    if (opts?.expand) {
      for (const c of 'abcdefghijklmnopqrstuvwxyz') prefixes.push(`${seed} ${c}`)
    }
  }

  // Seeds themselves are not "gap" terms — Amazon echoes the prefix back, so a
  // suggestion equal to a seed carries no new signal. Exclude them from output.
  const seedSet = new Set(seeds.map((s) => s.toLowerCase()))
  const seen = new Set<string>()
  const ordered: string[] = []
  const batchSize = 8
  for (let i = 0; i < prefixes.length; i += batchSize) {
    const batch = prefixes.slice(i, i + batchSize)
    const results = await Promise.all(batch.map((p) => fetchAutocomplete(p, alias, opts?.marketplace)))
    for (const list of results) {
      for (const term of list) {
        const key = term.toLowerCase()
        if (!seen.has(key) && !seedSet.has(key)) {
          seen.add(key)
          ordered.push(term)
        }
      }
    }
    if (opts?.cap && ordered.length >= opts.cap) break
  }
  return opts?.cap ? ordered.slice(0, opts.cap) : ordered
}
