import Anthropic from '@anthropic-ai/sdk'

// ANTHROPIC_API_KEY only. An organization-level key (not scoped to a workspace) also needs
// ANTHROPIC_WORKSPACE_ID, sent on every request as the anthropic-workspace-id header.
const workspace = process.env.ANTHROPIC_WORKSPACE_ID
export const client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {})

// Mixed fleet: fast/cheap for the research lenses, top model for the money output.
export const MODELS = {
  fast: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-8',
} as const

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Token usage of one model call, reported to callers that meter spend (the fleet engine).
export interface CallUsage {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
}
export type OnUsage = (u: CallUsage) => void
function report(onUsage: OnUsage | undefined, resp: Anthropic.Message) {
  onUsage?.({
    model: resp.model,
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
    cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
  })
}

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

// Parse the model's text as JSON with clear, actionable errors. Structured
// output constrains the grammar only WHILE tokens are produced — a refusal
// (empty content) or a max_tokens truncation still yields unparseable text, so
// we surface stop_reason instead of throwing a raw "Unexpected end of JSON".
function parseModelJson<T>(resp: Anthropic.Message): T {
  if (resp.stop_reason === 'refusal') {
    throw new Error('model declined the request (stop_reason=refusal)')
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  if (!text.trim()) {
    throw new Error(`model returned no text to parse (stop_reason=${resp.stop_reason})`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    const hint = resp.stop_reason === 'max_tokens' ? ' — likely truncated (stop_reason=max_tokens)' : ''
    throw new Error(`model output was not valid JSON${hint}`)
  }
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

// A search agent with schema-constrained JSON: web_search tool + structured
// output, with a guarded parse (refusal/truncation surface a clear error, not a
// raw SyntaxError). Fixes the "(no structured output)" failure where search-heavy
// agents returned prose the parser couldn't read.
export async function runSearchStructured<T>(opts: {
  role: string
  prompt: string
  schema: Record<string, unknown>
  model?: string
  effort?: Effort
  maxTokens?: number
  onUsage?: OnUsage
}): Promise<T> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.prompt }]
  let containerId: string | undefined
  for (let i = 0; i < 6; i++) {
    // web_search_20260209 runs code-execution under the hood; on multi-turn
    // (pause_turn) continuations the container id must be passed back.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      model: opts.model ?? MODELS.fast,
      max_tokens: opts.maxTokens ?? 2200,
      system: systemBlocks(opts.role),
      output_config: {
        format: { type: 'json_schema', schema: opts.schema },
        ...(opts.effort ? { effort: opts.effort } : {}),
      },
      messages,
      // Basic web search (no code-execution container / dynamic-filtering) —
      // faster and avoids the pause_turn container-reuse complexity.
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    }
    if (containerId) body.container = containerId
    const resp = await client.messages.create(body)
    report(opts.onUsage, resp as Anthropic.Message)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containerId = (resp as any).container?.id ?? containerId
    if (resp.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: resp.content })
      continue
    }
    return parseModelJson<T>(resp as Anthropic.Message)
  }
  throw new Error('search agent did not finish (too many tool iterations)')
}

// A structured agent: schema-constrained JSON via output_config.format, with a
// guarded parse (refusal/truncation surface a clear error, not a raw SyntaxError).
export async function runStructured<T>(opts: {
  role: string
  prompt: string
  schema: Record<string, unknown>
  model?: string
  effort?: Effort
  maxTokens?: number
  onUsage?: OnUsage
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
  report(opts.onUsage, msg)
  return parseModelJson<T>(msg)
}
