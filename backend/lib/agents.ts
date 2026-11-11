// The actual production agents, so the live endpoints AND the eval harness
// exercise the exact same prompt / model / schema — the eval tests real code.
import {
  DRIFT_SCHEMA,
  VERDICT_SCHEMA,
  type ScrapedListing,
  type Draft,
  type Verdict,
  type DriftReport,
} from './shared.js'
import { runStructured, MODELS, type Effort } from './claude.js'

const DRIFT_ROLE =
  "You are a listing-integrity monitor. Compare an approved BASELINE listing to the CURRENT live listing. Detect meaningful changes — especially Amazon's July-27 AI rewrite silently dropping selling specifics (dose, count, material, certifications like 'Third-Party Tested', variant) or introducing compliance risk. For each change, judge severity by lost search keywords, lost trust/conversion signals, and compliance exposure.\n\nCRITICAL — judge NET effect across the whole listing, not the title alone:\n- Treat the title and bullets together as ONE set of selling specifics. A specific that merely MOVED from the title into the bullets (or vice versa) is NOT dropped. Only count a specific as dropped if it is absent from BOTH the current title AND the current bullets.\n- A changed VALUE (e.g. 1300mg → 1000mg) IS drift. A newly added claim — especially an unsubstantiated health/efficacy claim — IS drift (compliance risk).\n- These are NOT drift (set changed=false): word order, punctuation, capitalization, spacing; removal of duplicate/redundant repeated keywords when every unique specific is retained; unit-equivalent restatements (e.g. '1 lb' = '16 oz', '6ft' = '6 foot').\n\nIf nothing material changed, set changed=false.\n\nAlso classify the LIKELY CAUSE with a confidence and one-sentence reasoning:\n- amazon_ai_rewrite: the title was shortened to about 75 characters or fewer, reads grammar-clean and generic, and selling specifics were dropped with no typos — the signature of Amazon's July-27 automated title rewrite.\n- manual_edit: partial/scattered edits, typos, or newly added marketing/promo language — a human editing.\n- catalog_or_shared_asin: a whole content block was swapped or brand/style differs markedly — an Amazon catalog change or another seller editing a shared ASIN.\n- no_material_change: use this whenever changed=false.\n- unknown: signals are genuinely ambiguous."

export function runDrift(
  baseline: Pick<ScrapedListing, 'title' | 'bullets'>,
  current: Pick<ScrapedListing, 'title' | 'bullets'>,
  opts: { model?: string; effort?: Effort } = {}
): Promise<DriftReport> {
  return runStructured<DriftReport>({
    model: opts.model ?? MODELS.deep,
    effort: opts.effort ?? 'high',
    schema: DRIFT_SCHEMA,
    role: DRIFT_ROLE,
    prompt: `BASELINE (approved):\nTITLE: ${baseline.title}\nBULLETS:\n${baseline.bullets.map((b) => '- ' + b).join('\n')}\n\nCURRENT (live):\nTITLE: ${current.title}\nBULLETS:\n${current.bullets.map((b) => '- ' + b).join('\n')}`,
  })
}

const VERIFY_ROLE =
  'You are an adversarial reviewer red-teaming a listing draft. The exact character counts are given to you — do NOT recount them. Report ONLY genuinely blocking or high-severity problems: policy violations, over-limit fields, unsubstantiated or regulated claims, or a selling specific lost vs the original. Be terse — at most 3 risks and at most 2 compliance notes, each a short actionable clause under ~14 words. If the draft is clean, return empty arrays. The verdict field is ONE short sentence. When you mention a character count, use only the exact numbers provided.'

export async function runVerify(
  listing: Pick<ScrapedListing, 'title'>,
  draft: Draft
): Promise<Verdict> {
  // Character counts are deterministic — compute them in code, never trust the
  // model to count (LLMs miscount characters).
  const titleCharCount = draft.optimizedTitle.length
  const highlightsCharCount = draft.itemHighlights.length

  const verdict = await runStructured<Verdict>({
    effort: 'medium',
    schema: VERDICT_SCHEMA,
    role: VERIFY_ROLE,
    prompt: `Character counts (exact, authoritative): Title = ${titleCharCount} chars (limit 75), Item Highlights = ${highlightsCharCount} chars (limit 125).\n\nORIGINAL TITLE: ${listing.title}\n\nDRAFT:\nTitle: ${draft.optimizedTitle}\nItem Highlights: ${draft.itemHighlights}\nBullets:\n${draft.bullets.map((b) => '- ' + b).join('\n')}`,
  })

  // Override whatever the model reported with the true counts.
  return { ...verdict, titleCharCount, highlightsCharCount }
}
