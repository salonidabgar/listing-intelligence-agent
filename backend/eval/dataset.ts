// Labeled eval set for drift detection. Each example is an (approved baseline →
// live current) pair with ground-truth labels. The hard cases are the cosmetic
// "no-change" traps (C/D) — anyone can flag an obvious diff; the business skill
// is NOT crying wolf when word order changes but every selling spec is intact.

export interface EvalExample {
  id: string
  name: string
  category: 'dropped-spec' | 'compliance' | 'cosmetic-nochange' | 'identical' | 'partial-drop' | 'truncation' | 'adversarial'
  baseline: { title: string; bullets: string[] }
  current: { title: string; bullets: string[] }
  expected: { changed: boolean; droppedSpecifics: string[] }
}

export const DATASET: EvalExample[] = [
  // ---- A. True drift: AI rewrite dropped selling specifics (changed=true) ----
  {
    id: 'A1', name: 'supplement drops dose + cert', category: 'dropped-spec',
    baseline: { title: 'Organic Ashwagandha 1300mg Stress & Sleep Support, Third-Party Tested, 120 Veggie Capsules', bullets: ['1300mg per serving', 'Third-Party Tested'] },
    current: { title: 'Ashwagandha Capsules for Stress and Sleep', bullets: ['Herbal supplement'] },
    expected: { changed: true, droppedSpecifics: ['1300mg', 'Third-Party Tested', '120 count', 'Organic'] },
  },
  {
    id: 'A2', name: 'coffee drops weight + count', category: 'dropped-spec',
    baseline: { title: 'Peak Roast Colombian Whole Bean Coffee, Medium Roast, 2 lb (32 oz) Bag', bullets: ['32 oz', 'Whole bean'] },
    current: { title: 'Colombian Whole Bean Coffee Medium Roast', bullets: ['Whole bean'] },
    expected: { changed: true, droppedSpecifics: ['2 lb', '32 oz'] },
  },
  {
    id: 'A3', name: 'cable drops length + material', category: 'dropped-spec',
    baseline: { title: 'Anker USB-C to USB-C Cable 6ft, Nylon Braided, 100W Fast Charging', bullets: ['6ft length', '100W'] },
    current: { title: 'Anker USB-C to USB-C Charging Cable', bullets: ['Fast charging'] },
    expected: { changed: true, droppedSpecifics: ['6ft', 'Nylon Braided', '100W'] },
  },
  {
    id: 'A4', name: 'vitamin drops IU + count', category: 'dropped-spec',
    baseline: { title: 'Vitamin D3 5000 IU Softgels, 360 Count, Non-GMO', bullets: ['5000 IU', '360 count'] },
    current: { title: 'Vitamin D3 Softgels Supplement', bullets: ['Supports immune health'] },
    expected: { changed: true, droppedSpecifics: ['5000 IU', '360 count', 'Non-GMO'] },
  },
  {
    id: 'A5', name: 'bedsheet drops thread count + size', category: 'dropped-spec',
    baseline: { title: 'Mellanni 500 Thread Count Cotton Sheet Set, Queen, 4 Piece, Deep Pocket', bullets: ['500 thread count', 'Queen size'] },
    current: { title: 'Mellanni Cotton Bed Sheet Set', bullets: ['Soft cotton'] },
    expected: { changed: true, droppedSpecifics: ['500 thread count', 'Queen', '4 Piece', 'Deep Pocket'] },
  },
  {
    id: 'A6', name: 'protein drops grams + flavor', category: 'dropped-spec',
    baseline: { title: 'Optimum Whey Protein Powder, Chocolate, 24g Protein, 5 lb', bullets: ['24g protein', 'Chocolate'] },
    current: { title: 'Optimum Whey Protein Powder', bullets: ['Great taste'] },
    expected: { changed: true, droppedSpecifics: ['24g protein', 'Chocolate', '5 lb'] },
  },
  {
    id: 'A7', name: 'LED bulb drops wattage + kelvin + count', category: 'dropped-spec',
    baseline: { title: 'Philips LED Bulb 9W (60W Equivalent), 2700K Soft White, 4-Pack, E26', bullets: ['9W', '2700K'] },
    current: { title: 'Philips LED Light Bulb Soft White', bullets: ['Energy efficient'] },
    expected: { changed: true, droppedSpecifics: ['9W', '2700K', '4-Pack', '60W Equivalent'] },
  },
  {
    id: 'A8', name: 'knife drops steel + size', category: 'dropped-spec',
    baseline: { title: 'Wusthof Classic 8-Inch Chef Knife, German High-Carbon Stainless Steel', bullets: ['8 inch', 'High-carbon steel'] },
    current: { title: 'Wusthof Classic Chef Knife', bullets: ['Precision forged'] },
    expected: { changed: true, droppedSpecifics: ['8-Inch', 'High-Carbon Stainless Steel'] },
  },

  // ---- B. Compliance-relevant drift (changed=true) ----
  {
    id: 'B1', name: 'AI adds banned promo + drops cert', category: 'compliance',
    baseline: { title: 'Zinc 50mg Immune Support Lozenges, 100 Count, Third-Party Tested', bullets: ['50mg zinc', 'Third-Party Tested'] },
    current: { title: 'Best #1 Zinc Immune Support Lozenges - Top Rated', bullets: ['Immune support'] },
    expected: { changed: true, droppedSpecifics: ['50mg', '100 Count', 'Third-Party Tested'] },
  },
  {
    id: 'B2', name: 'cosmetic serum drops dermatologist-tested', category: 'compliance',
    baseline: { title: 'Vitamin C Serum 20% for Face, Dermatologist Tested, Fragrance Free, 1 fl oz', bullets: ['20% vitamin C', 'Dermatologist Tested'] },
    current: { title: 'Vitamin C Face Serum for Glowing Skin', bullets: ['Brightening serum'] },
    expected: { changed: true, droppedSpecifics: ['20%', 'Dermatologist Tested', 'Fragrance Free', '1 fl oz'] },
  },
  {
    id: 'B3', name: 'sunscreen drops regulated SPF', category: 'compliance',
    baseline: { title: 'La Roche-Posay Anthelios Sunscreen SPF 50, Oil Free, 1.7 fl oz', bullets: ['SPF 50', 'Oil free'] },
    current: { title: 'La Roche-Posay Anthelios Face Sunscreen', bullets: ['Daily protection'] },
    expected: { changed: true, droppedSpecifics: ['SPF 50', '1.7 fl oz'] },
  },
  {
    id: 'B4', name: 'supplement drops Non-GMO + tested', category: 'compliance',
    baseline: { title: 'Turmeric Curcumin 1500mg with BioPerine, Non-GMO, Third-Party Tested, 90 Caps', bullets: ['1500mg', 'BioPerine'] },
    current: { title: 'Turmeric Curcumin Supplement Capsules', bullets: ['Joint support'] },
    expected: { changed: true, droppedSpecifics: ['1500mg', 'BioPerine', 'Non-GMO', 'Third-Party Tested', '90'] },
  },

  // ---- C. Cosmetic no-change: FALSE-POSITIVE TRAPS (changed=false) ----
  {
    id: 'C1', name: 'word reorder, all specs intact', category: 'cosmetic-nochange',
    baseline: { title: 'Organic Ashwagandha 1300mg, 120 Veggie Capsules, Stress & Sleep Support', bullets: ['1300mg', '120 capsules'] },
    current: { title: 'Ashwagandha 1300mg for Stress & Sleep Support, Organic, 120 Veggie Capsules', bullets: ['1300mg', '120 capsules'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'C2', name: 'punctuation/hyphen only', category: 'cosmetic-nochange',
    baseline: { title: 'Anker USB-C to USB-C Cable 6ft - Nylon Braided - 100W Fast Charging', bullets: ['6ft', '100W'] },
    current: { title: 'Anker USB-C to USB-C Cable 6ft, Nylon Braided, 100W Fast Charging', bullets: ['6ft', '100W'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'C3', name: 'capitalization only', category: 'cosmetic-nochange',
    baseline: { title: 'Vitamin D3 5000 IU Softgels, 360 Count, Non-GMO', bullets: ['5000 IU'] },
    current: { title: 'VITAMIN D3 5000 IU SOFTGELS, 360 COUNT, NON-GMO', bullets: ['5000 IU'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'C4', name: 'unit synonym & ampersand, specs preserved', category: 'cosmetic-nochange',
    baseline: { title: 'Peak Roast Colombian Whole Bean Coffee, Medium Roast, 32 oz & Fresh', bullets: ['32 oz'] },
    current: { title: 'Peak Roast Colombian Whole Bean Coffee, Medium Roast, 32 ounce and Fresh', bullets: ['32 ounce'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'C5', name: 'whitespace/comma tidy', category: 'cosmetic-nochange',
    baseline: { title: 'Mellanni 500 Thread Count  Cotton Sheet Set , Queen , 4 Piece', bullets: ['500 TC', 'Queen'] },
    current: { title: 'Mellanni 500 Thread Count Cotton Sheet Set, Queen, 4 Piece', bullets: ['500 TC', 'Queen'] },
    expected: { changed: false, droppedSpecifics: [] },
  },

  // ---- D. Identical (changed=false) ----
  {
    id: 'D1', name: 'exactly identical', category: 'identical',
    baseline: { title: 'Wusthof Classic 8-Inch Chef Knife, German High-Carbon Stainless Steel', bullets: ['8 inch', 'High-carbon steel'] },
    current: { title: 'Wusthof Classic 8-Inch Chef Knife, German High-Carbon Stainless Steel', bullets: ['8 inch', 'High-carbon steel'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'D2', name: 'identical (electronics)', category: 'identical',
    baseline: { title: 'Philips LED Bulb 9W (60W Equivalent), 2700K Soft White, 4-Pack, E26', bullets: ['9W', '2700K'] },
    current: { title: 'Philips LED Bulb 9W (60W Equivalent), 2700K Soft White, 4-Pack, E26', bullets: ['9W', '2700K'] },
    expected: { changed: false, droppedSpecifics: [] },
  },

  // ---- E. Partial drop (changed=true) ----
  {
    id: 'E1', name: 'keeps dose, drops count', category: 'partial-drop',
    baseline: { title: 'Magnesium Glycinate 400mg, 180 Capsules, High Absorption', bullets: ['400mg', '180 count'] },
    current: { title: 'Magnesium Glycinate 400mg High Absorption Capsules', bullets: ['400mg'] },
    expected: { changed: true, droppedSpecifics: ['180 Capsules'] },
  },
  {
    id: 'E2', name: 'keeps cert, drops material', category: 'partial-drop',
    baseline: { title: 'Stainless Steel Water Bottle 32oz, BPA-Free, Double Wall Insulated', bullets: ['32oz', 'Stainless steel'] },
    current: { title: '32oz Water Bottle, BPA-Free, Double Wall Insulated', bullets: ['32oz'] },
    expected: { changed: true, droppedSpecifics: ['Stainless Steel'] },
  },
  {
    id: 'E3', name: 'keeps size, drops color/variant', category: 'partial-drop',
    baseline: { title: 'Nike Dri-FIT Running Socks, Large, Black, 3-Pair Pack', bullets: ['Large', 'Black'] },
    current: { title: 'Nike Dri-FIT Running Socks, Large, 3-Pair Pack', bullets: ['Large'] },
    expected: { changed: true, droppedSpecifics: ['Black'] },
  },

  // ---- F. Truncation / shortening that loses a spec (changed=true) ----
  {
    id: 'F1', name: 'truncated to 75, trailing specs lost', category: 'truncation',
    baseline: { title: 'Hydro Flask Water Bottle 40oz Wide Mouth, Flex Cap, Stainless Steel, Insulated', bullets: ['40oz', 'Insulated'] },
    current: { title: 'Hydro Flask Water Bottle 40oz Wide Mouth', bullets: ['40oz'] },
    expected: { changed: true, droppedSpecifics: ['Flex Cap', 'Stainless Steel', 'Insulated'] },
  },
  {
    id: 'F2', name: 'shortened, drops 2-Pack', category: 'truncation',
    baseline: { title: 'Ring Video Doorbell, 1080p HD, 2-Pack, Battery Powered, Night Vision', bullets: ['1080p', '2-pack'] },
    current: { title: 'Ring Video Doorbell 1080p HD Battery Powered', bullets: ['1080p'] },
    expected: { changed: true, droppedSpecifics: ['2-Pack', 'Night Vision'] },
  },

  // ---- G. Adversarial boundary cases. A naive title-only keyword diff gets these
  //         WRONG; a business-aware agent must reason about net effect. ----
  {
    id: 'G1', name: 'spec relocated title→bullets (no net loss)', category: 'adversarial',
    baseline: { title: 'Ashwagandha 1300mg Organic, 120 Veggie Capsules', bullets: ['Stress support'] },
    current: { title: 'Organic Ashwagandha for Stress & Sleep', bullets: ['1300mg per serving', '120 veggie capsules'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'G2', name: 'count moved to bullets (no net loss)', category: 'adversarial',
    baseline: { title: 'Vitamin D3 5000 IU Softgels 360 Count Non-GMO', bullets: ['Immune support'] },
    current: { title: 'Vitamin D3 5000 IU Softgels, Non-GMO', bullets: ['360 count per bottle', 'Immune support'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'G3', name: 'dose VALUE quietly changed (1300→1000)', category: 'adversarial',
    baseline: { title: 'Ashwagandha 1300mg Organic, 120 Veggie Capsules, Third-Party Tested', bullets: ['1300mg'] },
    current: { title: 'Ashwagandha 1000mg Organic, 120 Veggie Capsules, Third-Party Tested', bullets: ['1000mg'] },
    expected: { changed: true, droppedSpecifics: ['1300mg'] },
  },
  {
    id: 'G4', name: 'AI added unsubstantiated health claim', category: 'adversarial',
    baseline: { title: 'Magnesium Glycinate 400mg, 180 Capsules, High Absorption', bullets: ['400mg', '180 count'] },
    current: { title: 'Magnesium Glycinate 400mg Cures Anxiety & Insomnia, 180 Capsules', bullets: ['400mg', '180 count'] },
    expected: { changed: true, droppedSpecifics: [] },
  },
  {
    id: 'G5', name: 'removed only duplicate keyword stuffing (specs intact)', category: 'adversarial',
    baseline: { title: 'Coffee Whole Bean Coffee Colombian Coffee Medium Roast 32 oz Coffee', bullets: ['32 oz', 'Whole bean'] },
    current: { title: 'Colombian Whole Bean Coffee, Medium Roast, 32 oz', bullets: ['32 oz', 'Whole bean'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'G6', name: 'unit equivalence 1 lb ↔ 16 oz (same quantity)', category: 'adversarial',
    baseline: { title: 'Peak Roast Colombian Whole Bean Coffee, Medium Roast, 1 lb', bullets: ['1 lb'] },
    current: { title: 'Peak Roast Colombian Whole Bean Coffee, Medium Roast, 16 oz', bullets: ['16 oz'] },
    expected: { changed: false, droppedSpecifics: [] },
  },
  {
    id: 'G7', name: 'cosmetic noise hides one real drop (BPA-Free)', category: 'adversarial',
    baseline: { title: 'Stainless Steel Water Bottle 32oz - BPA-Free - Double Wall Insulated', bullets: ['32oz', 'BPA-Free'] },
    current: { title: '32oz Stainless Steel Water Bottle, Double Wall Insulated', bullets: ['32oz'] },
    expected: { changed: true, droppedSpecifics: ['BPA-Free'] },
  },
]
