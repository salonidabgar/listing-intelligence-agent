import { runStructured, MODELS } from './claude.js'
import { gatherTerms, isNonUsMarketplace } from './autocomplete.js'
import type { ScrapedListing } from './shared.js'

// Division of labor that keeps the SEO claim honest:
//  - Claude does EXTRACTION (what it's good at): read the listing -> propose
//    generic product-type SEED phrases + the best department alias.
//  - Amazon autocomplete supplies the DEMAND DATA (what the model can't honestly
//    know): the real, popularity-ranked queries shoppers type for those seeds.
// The model never invents keywords; it only decides what to look up.

// Known-good Amazon department search-aliases. `aps` = all departments (fallback).
const ALIASES = [
  'aps',
  'beauty',
  'hpc',
  'grocery',
  'electronics',
  'toys',
  'pets',
  'sporting',
  'office-products',
  'automotive',
  'baby-products',
  'fashion',
  'lawngarden',
  'tools',
  'videogames',
  'books',
  'kitchen',
] as const

const SEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    alias: { type: 'string', enum: ALIASES },
    seeds: { type: 'array', items: { type: 'string' } },
  },
  required: ['alias', 'seeds'],
} as const

export interface RealKeywords {
  alias: string
  seeds: string[]
  terms: string[]
}

// Extract seeds + department from the listing, then pull real autocomplete terms.
export async function getRealKeywords(
  listing: ScrapedListing,
  opts?: { expand?: boolean; cap?: number },
): Promise<RealKeywords> {
  const { alias: rawAlias, seeds } = await runStructured<{ alias: string; seeds: string[] }>({
    model: MODELS.fast,
    effort: 'low',
    maxTokens: 400,
    schema: SEED_SCHEMA,
    role:
      'You extract Amazon autocomplete SEED phrases from a product listing. A seed is the GENERIC product type in shopper language — never the brand, never marketing adjectives (premium, salon-quality, luxury). You also pick the single best department alias for the product.',
    prompt:
      `From this listing, output 3–5 autocomplete seed phrases and the department alias.\n` +
      `Rules: lowercase; no brand names; no marketing words; use the words a shopper would type. ` +
      `Include (a) the bare category term, (b) one "<category> for" connector, (c) 1–2 "<attribute> <category>" seeds from real product attributes.\n\n` +
      `TITLE: ${listing.title}\n` +
      `BRAND: ${listing.brand ?? '?'}\n` +
      `BULLETS:\n${listing.bullets.map((b) => '- ' + b).join('\n') || '(none)'}`,
  })

  const cleanSeeds = Array.from(
    new Set(seeds.map((s) => s.trim().toLowerCase()).filter(Boolean)),
  ).slice(0, 5)

  const cap = opts?.cap ?? 60
  const marketplace = listing.marketplace
  const dedupeCap = (lists: string[][]): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of lists.flat()) {
      const k = t.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        out.push(t)
      }
    }
    return out.slice(0, cap)
  }

  let alias = rawAlias
  let terms = await gatherTerms(cleanSeeds, alias, { expand: opts?.expand, cap, marketplace })
  // If a narrow department returned almost nothing, widen to all departments and
  // MERGE (narrow terms first — they're the more relevant ones), rather than
  // discarding what we already have and re-fetching from scratch.
  if (terms.length < 5 && alias !== 'aps') {
    const wide = await gatherTerms(cleanSeeds, 'aps', { expand: opts?.expand, cap, marketplace })
    terms = dedupeCap([terms, wide])
    alias = 'aps'
  }
  // Last resort: a non-US completion host can be unreachable (e.g. IN's
  // completion.amazon.in 502s), which would silently yield zero grounded terms
  // and let the lens fall back to web-search guessing. Before that, retry the
  // seeds against the US endpoint so we still return REAL Amazon queries.
  if (terms.length === 0 && isNonUsMarketplace(marketplace)) {
    terms = await gatherTerms(cleanSeeds, 'aps', { expand: opts?.expand, cap, marketplace: 'amazon.com' })
    alias = 'aps'
  }
  return { alias, seeds: cleanSeeds, terms }
}
