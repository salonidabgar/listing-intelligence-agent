// Keyless stand-ins for the Claude tools: exercise the tree, guards, gates and the
// event stream without spending anything. Deterministic; the compliance lens returns
// a deliberately generic finding so the research gate has something to reject.
import type { Tool } from '../jev/runtime/engine.js'
import { LENSES, type LensKey, type LensToolDeps, type ListingPlan, type LensFinding, hardTrim, TITLE_LIMIT, HIGHLIGHTS_LIMIT } from './lenses.js'
import type { Verdict } from '../shared.js'

export function mockTools(deps: LensToolDeps): Record<string, Tool> {
  const l = deps.listing
  const findings: Record<LensKey, (gap: string | null) => LensFinding> = {
    market: () => ({ title: 'Competitive landscape', summary: `${l.brand ?? 'This brand'} competes in a crowded ${l.title.split(' ').slice(0, 3).join(' ')} segment at ${l.price ?? '$20-40'}.`, points: ['Top 3 listings lead with count + material in the first 40 chars', 'Price band $19-$34; this listing sits mid-band', 'Competitors call out "third-party tested" in Item Highlights'], sources: ['amazon.com best sellers', 'junglescout.com category report'] }),
    keywords: () => ({ title: 'Keyword coverage gaps', summary: 'Shoppers search by use-case terms the title does not use.', points: ['Add "for sleep" (top-3 query) to the title', 'Move "120 capsules" before the brand name', 'Item Highlights: "vegan, non-GMO, gluten free"'], sources: ['Amazon autocomplete · 42 real queries'] }),
    voice: () => ({ title: 'Customer pains and desires', summary: 'Buyers want dose clarity and a smell-free capsule.', points: ['Pain: "no idea how many per day" (12 reviews)', 'Desire: "doesn\'t smell like hay" mentioned 8 times', 'Trust: certificate of analysis requested in Q&A'], sources: ['scraped reviews', 'reddit.com/r/supplements'] }),
    // first pass generic → gate should want more; the retry with a named gap is specific
    compliance: (gap) => gap
      ? ({ title: 'Compliance audit', summary: `Title is ${l.title.length} chars; ${l.title.length > TITLE_LIMIT ? 'over' : 'within'} the 75-char limit.`, points: [`Title ${l.title.length}/75 — ${l.title.length > TITLE_LIMIT ? 'will be AI-rewritten; dose and count at risk' : 'safe from the AI rewrite'}`, 'No medical claims found in bullets', '"Third-Party Tested" must be retained verbatim'], sources: ['sellercentral.amazon.com policy page'] })
      : ({ title: 'Compliance', summary: 'Make sure the listing follows Amazon policy.', points: ['Follow the rules', 'Avoid problems'], sources: [] }),
    aco: () => ({ title: 'AI-answerability gaps', summary: 'Rufus cannot answer 3 of the 5 most common questions from this text.', points: ['"How many per serving?" → state "2 capsules per serving" in bullets', '"Is it vegan?" → add "vegan capsules" to Item Highlights', '"How long does a bottle last?" → "60-day supply" in title or highlights'], sources: ['amazon.com customer questions', 'rufus prompts sample'] }),
  }
  return {
    real_keywords: async () => { deps.emit({ type: 'keywords', alias: 'hpc', seeds: ['ashwagandha'], terms: ['ashwagandha for sleep', 'ashwagandha capsules', 'ashwagandha 1300mg'] }); return { alias: 'hpc', seeds: ['ashwagandha'], terms: ['ashwagandha for sleep', 'ashwagandha capsules', 'ashwagandha 1300mg'] } },
    lens: async (args, ctx) => {
      const key = String(args.lens) as LensKey
      const gap = typeof args.gap === 'string' && args.gap ? args.gap : null
      deps.emit({ type: 'agent_start', key, label: LENSES[key].label, retry: !!gap })
      ctx.meter({ agent: `lens:${key}`, model: 'mock', usage: { input_tokens: 900, output_tokens: 250 } })
      const f = findings[key](gap)
      deps.emit({ type: 'agent_done', key, label: LENSES[key].label, finding: f })
      return f
    },
    synthesizer: async (args, ctx) => {
      deps.emit({ type: 'agent_start', key: 'synthesis', label: 'Synthesizer agent (mock)', retry: !!args.feedback })
      ctx.meter({ agent: 'synthesizer', model: 'mock', usage: { input_tokens: 3000, output_tokens: 600 } })
      const plan: ListingPlan = {
        optimizedTitle: hardTrim(`${l.brand ?? ''} ${l.title} for Sleep, 120 Capsules`.trim(), TITLE_LIMIT),
        itemHighlights: hardTrim('Vegan, Non-GMO, Third-Party Tested, 2 capsules per serving, 60-day supply', HIGHLIGHTS_LIMIT),
        bullets: ['2 capsules per serving — 60-day supply', 'Third-Party Tested for purity', 'Vegan, non-GMO capsules', 'Odor-free formula', 'Certificate of analysis on request'],
        aPlusAngle: 'Dose clarity + trust signals',
        keywordsToAdd: ['ashwagandha for sleep', 'vegan', 'third-party tested'],
        actions: [{ priority: 'high', action: 'Shorten title to 75 chars before July 27' }],
      }
      deps.emit({ type: 'synthesis', plan })
      return plan
    },
    verifier: async (args, ctx) => {
      deps.emit({ type: 'agent_start', key: 'verify', label: 'Verifier (mock)' })
      ctx.meter({ agent: 'verifier', model: 'mock', usage: { input_tokens: 800, output_tokens: 120 } })
      const p = args.plan as ListingPlan
      const verdict: Verdict = { titleCharCount: p.optimizedTitle.length, highlightsCharCount: p.itemHighlights.length, risks: [], complianceNotes: [], confidence: 'high', verdict: 'Clean draft within limits.' }
      deps.emit({ type: 'verdict', verdict })
      return verdict
    },
  }
}
