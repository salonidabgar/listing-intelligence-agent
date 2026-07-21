import Anthropic from '@anthropic-ai/sdk'

export const client = new Anthropic() // ANTHROPIC_API_KEY only

// Mixed fleet: fast/cheap for the research lenses, top model for the money output.
export const MODELS = {
  fast: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-8',
} as const

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Verified ground truth (confirmed against Amazon Seller Central + industry sources).
// Shared, stable prefix → marked cacheable so repeated agent calls reuse it cheaply.
export const POLICY_CONTEXT = `AMAZON LISTING POLICY — VERIFIED GROUND TRUTH (mid-2026):
- July 27, 2026: product titles in every category except media must be <=75 characters INCLUDING spaces.
- A new "Item Highlights" field (<=125 characters, searchable and indexed by A9/A10) launches at the same time for details that no longer fit in the title. Format: short comma-separated phrases (e.g. "Stainless steel, Double insulated, Dishwasher safe"), not prose.
- Titles over 75 chars are AUTOMATICALLY REWRITTEN by Amazon's AI — not a truncation, but a new title generated from Amazon's relevance model + backend search terms + bullet points. This frequently DROPS selling specifics (dose, count, material, certifications like "Third-Party Tested", variant).
- Brand Registry sellers get a 14-day window in "Review Listing Changes" to approve/modify; INACTION COUNTS AS APPROVAL. Non-Brand-Registry sellers get changes applied silently, with no notification.
- The seller is responsible for whatever text ends up live, including compliance risk in regulated categories (supplements, cosmetics, health).
- Discovery stack: A9/A10 ranking, with Rufus (gen-AI shopping assistant) on top and COSMO (commonsense knowledge graph) underneath. Optimize for machine-legibility: front-loaded specifics, structured attributes, use-case language.
Treat the above as authoritative. Use web_search only to confirm current details or find product/keyword/competitor specifics.`

function systemBlocks(role: string) {
  return [
    { type: 'text' as const, text: POLICY_CONTEXT, cache_control: { type: 'ephemeral' as const } },
    { type: 'text' as const, text: role },
  ]
}

// Extract the first JSON object from free text (used for search agents where we
// keep prompt-driven JSON rather than strict structured output).
export function extractJson<T>(text: string, fallback: T): T {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s === -1 || e === -1) return fallback
  try {
    return JSON.parse(text.slice(s, e + 1)) as T
  } catch {
    return fallback
  }
}

// A research agent that can use the web_search server tool. Returns raw text.
export async function runAgentText(opts: {
  role: string
  prompt: string
  search?: boolean
  model?: string
  effort?: Effort
  maxTokens?: number
}): Promise<string> {
  const tools = opts.search
    ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }]
    : undefined
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.prompt }]

  for (let i = 0; i < 6; i++) {
    const resp = await client.messages.create({
      model: opts.model ?? MODELS.fast,
      max_tokens: opts.maxTokens ?? 1800,
      system: systemBlocks(opts.role),
      ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(tools ? { tools: tools as any } : {}),
    })
    if (resp.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: resp.content })
      continue
    }
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

// A structured agent: guaranteed schema-valid JSON via output_config.format.
export async function runStructured<T>(opts: {
  role: string
  prompt: string
  schema: Record<string, unknown>
  model?: string
  effort?: Effort
  maxTokens?: number
}): Promise<T> {
  const msg = await client.messages.create({
    model: opts.model ?? MODELS.fast,
    max_tokens: opts.maxTokens ?? 2000,
    system: systemBlocks(opts.role),
    output_config: {
      format: { type: 'json_schema', schema: opts.schema },
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
    messages: [{ role: 'user', content: opts.prompt }],
  })
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return JSON.parse(text) as T
}
