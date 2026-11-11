// Labeled inputs for the Jev-vs-baseline benchmark and the keyless demo.
//
//  SAMPLE_LISTINGS  — listings with the lens bundle a human would pick (+ quality/risk level).
//  GATE_CASES       — research findings labeled usable / not usable.
//  RUBRIC_CASES     — drafts labeled ready / not ready against their findings.
// Labels are one person's judgment; they measure agreement, not truth.
import type { ScrapedListing } from '../lib/shared.js'
import type { LensBundle } from '../lib/fleet/workflow.js'
import type { LensFinding, ListingPlan } from '../lib/fleet/lenses.js'

const base = (over: Partial<ScrapedListing>): ScrapedListing => ({
  asin: 'B000000000', title: '', brand: null, price: null, rating: null, reviewCount: null, bullets: [], reviews: [],
  mainImage: null, galleryImages: [], marketplace: 'amazon.com', url: 'https://www.amazon.com/dp/B000000000', ...over,
})

export interface ListingCase { id: string; listing: ScrapedListing; expected: { bundle: LensBundle; alt?: LensBundle[]; quality: [number, number]; risk: [number, number] } }

export const SAMPLE_LISTINGS: ListingCase[] = [
  { id: 'thin-supplement', listing: base({ asin: 'B0THIN0001', title: 'Ashwagandha Capsules', brand: 'Herbalux', price: '$18.99', rating: '4.3', reviewCount: '212', bullets: ['Herbal supplement', 'Made with care'], reviews: [{ title: 'ok', body: 'No idea how many to take per day.', rating: 3 }] }),
    expected: { bundle: 'thin_listing', quality: [0, 0], risk: [0, 1] } },
  { id: 'thin-cable', listing: base({ asin: 'B0THIN0002', title: 'USB C Cable', brand: null, price: '$9.99', bullets: [] }),
    expected: { bundle: 'thin_listing', quality: [0, 0], risk: [0, 0] } },
  { id: 'thin-sheets', listing: base({ asin: 'B0THIN0003', title: 'Bed Sheet Set Soft and Comfortable', brand: 'DreamNest', price: '$29.99', bullets: ['Very soft', 'Great for any bedroom'] }),
    expected: { bundle: 'thin_listing', quality: [0, 1], risk: [0, 1] } },
  { id: 'overlimit-supplement', listing: base({ asin: 'B0LONG0001', title: 'Organic Ashwagandha 1300mg Stress & Sleep Support Supplement, Third-Party Tested, Vegan, Non-GMO, 120 Veggie Capsules, 60 Day Supply', brand: 'Herbalux', price: '$21.99', rating: '4.6', reviewCount: '4,120', bullets: ['1300mg per serving (2 capsules)', 'Third-Party Tested for purity', 'Vegan, non-GMO capsules', 'Supports stress and sleep'] }),
    expected: { bundle: 'compliance_first', alt: ['full'], quality: [2, 3], risk: [1, 2] } },
  { id: 'flagged-claims', listing: base({ asin: 'B0FLAG0001', title: '#1 Best Zinc Lozenges - Cures Colds Fast, FDA Approved Immune Booster, 100 Count', brand: 'ZincMax', price: '$14.99', bullets: ['Clinically proven to cure colds in 24 hours', 'Doctor recommended #1 brand', '50mg zinc, 100 lozenges'] }),
    expected: { bundle: 'compliance_first', quality: [1, 2], risk: [3, 3] } },
  { id: 'flagged-cosmetic', listing: base({ asin: 'B0FLAG0002', title: 'Anti-Aging Vitamin C Serum Erases Wrinkles Permanently, Dermatologist Tested, 1 fl oz', brand: 'GlowLab', price: '$24.99', bullets: ['Removes wrinkles permanently', '20% vitamin C', 'Fragrance free'] }),
    expected: { bundle: 'compliance_first', quality: [1, 2], risk: [2, 3] } },
  { id: 'strong-knife', listing: base({ asin: 'B0STRG0001', title: 'Wusthof Classic 8-Inch Chef Knife, German High-Carbon Stainless Steel', brand: 'Wusthof', price: '$169.95', rating: '4.8', reviewCount: '9,800', bullets: ['8-inch forged blade, full tang', 'German high-carbon stainless steel', 'Precision Edge Technology (PEtec), 14° per side', 'Triple-riveted synthetic handle', 'Made in Solingen, Germany'], reviews: [{ title: 'Great', body: 'Holds an edge for months.', rating: 5 }] }),
    expected: { bundle: 'reposition', alt: ['full'], quality: [2, 3], risk: [0, 0] } },
  { id: 'strong-coffee', listing: base({ asin: 'B0STRG0002', title: 'Peak Roast Colombian Whole Bean Coffee, Medium Roast, 2 lb (32 oz) Bag', brand: 'Peak Roast', price: '$18.49', rating: '4.5', reviewCount: '3,210', bullets: ['100% Colombian Arabica, single origin', 'Medium roast, chocolate and caramel notes', '2 lb (32 oz) resealable bag', 'Roasted in small batches', 'Fair Trade Certified'] }),
    expected: { bundle: 'reposition', alt: ['full'], quality: [2, 3], risk: [0, 0] } },
  { id: 'average-bulb', listing: base({ asin: 'B0AVG00001', title: 'Philips LED Bulb 9W Soft White 4-Pack', brand: 'Philips', price: '$12.97', rating: '4.6', reviewCount: '18,200', bullets: ['9W LED (60W equivalent)', '2700K soft white', 'E26 base', 'Energy efficient'] }),
    expected: { bundle: 'full', alt: ['thin_listing'], quality: [1, 2], risk: [0, 0] } },
  { id: 'average-protein', listing: base({ asin: 'B0AVG00002', title: 'Optimum Whey Protein Powder Chocolate 5 lb', brand: 'Optimum', price: '$64.99', rating: '4.7', reviewCount: '120,000', bullets: ['24g protein per serving', 'Chocolate flavor', '5 lb tub'] }),
    expected: { bundle: 'full', alt: ['thin_listing'], quality: [1, 2], risk: [0, 1] } },
  { id: 'average-sheets', listing: base({ asin: 'B0AVG00003', title: 'Mellanni 500 Thread Count Cotton Sheet Set Queen 4 Piece Deep Pocket', brand: 'Mellanni', price: '$39.97', rating: '4.5', reviewCount: '300,000', bullets: ['500 thread count cotton', 'Queen, 4 piece', 'Deep pocket fits 16" mattress', 'Machine washable'] }),
    expected: { bundle: 'full', alt: ['reposition'], quality: [2, 2], risk: [0, 0] } },
  { id: 'overlimit-cable', listing: base({ asin: 'B0LONG0002', title: 'Anker USB-C to USB-C Cable 6ft Nylon Braided 100W Fast Charging Cable Compatible with MacBook Pro iPad Pro Galaxy S24 Pixel 8 and More, 2-Pack, Black', brand: 'Anker', price: '$15.99', rating: '4.7', reviewCount: '45,000', bullets: ['100W fast charging', '6ft nylon braided', '2-pack'] }),
    expected: { bundle: 'compliance_first', alt: ['full'], quality: [2, 2], risk: [1, 1] } },
]

export interface GateCase { id: string; lens: string; listing_text: string; finding: LensFinding; expected: boolean }
const ashwa = 'TITLE (20 chars): Ashwagandha Capsules\nBRAND: Herbalux · PRICE: $18.99 · RATING: 4.3 (212 reviews)\nBULLETS:\n- Herbal supplement\n- Made with care\nREVIEWS SCRAPED: 1'
export const GATE_CASES: GateCase[] = [
  { id: 'g-good-aco', lens: 'aco', listing_text: ashwa, expected: true, finding: { title: 'AI-answerability gaps', summary: 'Rufus cannot answer 3 of the 5 most common ashwagandha questions from this text.', points: ['"How many mg per serving?" → state "1300mg per 2-capsule serving" in the title', '"Is it vegan?" → add "vegan capsules" to Item Highlights', '"How many days does it last?" → "60-day supply" in highlights'], sources: ['amazon.com customer questions for ashwagandha', 'scraped reviews'] } },
  { id: 'g-good-market', lens: 'market', listing_text: ashwa, expected: true, finding: { title: 'Competitive landscape', summary: 'Ashwagandha capsules cluster at $15-$25; top sellers lead with dose and testing.', points: ['NutriRise and Physician\'s Choice lead with "1300mg" and "Third-Party Tested" in the first 40 chars', 'KSM-66 extract is a differentiator named by 4 of the top 10', 'Top listings put "for stress and sleep" use-case language in the title'], sources: ['amazon.com best sellers in ashwagandha', 'junglescout.com'] } },
  { id: 'g-generic', lens: 'compliance', listing_text: ashwa, expected: false, finding: { title: 'Compliance', summary: 'Make sure the listing follows Amazon policy.', points: ['Follow the rules', 'Avoid problems', 'Keep the title short'], sources: [] } },
  { id: 'g-empty', lens: 'voice', listing_text: ashwa, expected: false, finding: { title: 'Voice of customer', summary: 'model returned no text to parse (stop_reason=max_tokens)', points: [], sources: [] } },
  { id: 'g-offproduct', lens: 'keywords', listing_text: ashwa, expected: false, finding: { title: 'Keyword gaps', summary: 'Shoppers search for wireless earbuds with noise cancelling.', points: ['Add "noise cancelling" to the title', 'Add "bluetooth 5.3" to highlights'], sources: ['Amazon autocomplete'] } },
  { id: 'g-good-voice', lens: 'voice', listing_text: ashwa, expected: true, finding: { title: 'Customer pains and desires', summary: 'Buyers want dose clarity and an odor-free capsule.', points: ['Pain: "no idea how many to take per day" (scraped review, echoed in 12 category reviews)', 'Desire: capsules that "don\'t smell like hay"', 'Trust: shoppers ask for a certificate of analysis'], sources: ['scraped reviews', 'reddit.com/r/supplements'] } },
  { id: 'g-vague-market', lens: 'market', listing_text: ashwa, expected: false, finding: { title: 'Market', summary: 'The market is competitive and growing.', points: ['Many competitors exist', 'Differentiate the product', 'Pricing matters'], sources: ['general knowledge'] } },
  { id: 'g-good-compliance', lens: 'compliance', listing_text: ashwa, expected: true, finding: { title: 'Compliance audit', summary: 'Title is 20 chars, safe from the July-27 rewrite; bullets make no claims but also carry no retained specifics.', points: ['Title 20/75 — no AI rewrite risk', 'No dose stated anywhere: if added, keep it identical in title and bullets so a rewrite cannot drop it', 'Avoid "stress relief" phrasing without "supports" qualifier (supplement claim rules)'], sources: ['sellercentral.amazon.com dietary supplement policy'] } },
]

export interface RubricCase { id: string; listing_text: string; findings_text: string; keywords_text: string; draft: ListingPlan; expected: boolean }
const findingsTxt = '## AI-answerability gaps\n- "How many mg per serving?" → 1300mg per 2-capsule serving\n- "Is it vegan?" → vegan capsules\n## Compliance audit\n- No dose stated; keep dose identical in title and bullets\n- Avoid unqualified stress claims'
const kw = '- ashwagandha for sleep\n- ashwagandha capsules\n- ashwagandha 1300mg\n- organic ashwagandha'
export const RUBRIC_CASES: RubricCase[] = [
  { id: 'r-ready', listing_text: ashwa, findings_text: findingsTxt, keywords_text: kw, expected: true, draft: { optimizedTitle: 'Herbalux Ashwagandha Capsules for Sleep, Vegan, 120 Count', itemHighlights: 'Vegan capsules, 2 per serving, 60-day supply, Non-GMO', bullets: ['2 vegan capsules per serving', '120 capsules — 60-day supply', 'Supports a calm, restful night', 'Non-GMO, gluten free', 'Made in a GMP facility'], aPlusAngle: 'Dose clarity', keywordsToAdd: ['ashwagandha for sleep'], actions: [] } },
  { id: 'r-invented', listing_text: ashwa, findings_text: findingsTxt, keywords_text: kw, expected: false, draft: { optimizedTitle: 'Herbalux Ashwagandha 1300mg KSM-66, Third-Party Tested, Clinically Proven', itemHighlights: 'KSM-66 extract, Third-Party Tested, Clinically proven', bullets: ['Clinically proven to reduce cortisol 30%', 'KSM-66 root extract', 'Third-Party Tested'], aPlusAngle: '', keywordsToAdd: [], actions: [] } },
  { id: 'r-vague', listing_text: ashwa, findings_text: findingsTxt, keywords_text: kw, expected: false, draft: { optimizedTitle: 'Premium Ashwagandha Supplement for Wellness', itemHighlights: 'High quality, Natural, Effective', bullets: ['Premium quality', 'Feel your best', 'Natural wellness support', 'Great value', 'Trusted brand'], aPlusAngle: '', keywordsToAdd: [], actions: [] } },
  { id: 'r-claims', listing_text: ashwa, findings_text: findingsTxt, keywords_text: kw, expected: false, draft: { optimizedTitle: '#1 Best Ashwagandha Capsules — Cures Anxiety and Insomnia Fast', itemHighlights: 'Cures anxiety, FDA approved, Doctor recommended', bullets: ['Cures insomnia in 3 days', 'FDA approved formula'], aPlusAngle: '', keywordsToAdd: [], actions: [] } },
]
