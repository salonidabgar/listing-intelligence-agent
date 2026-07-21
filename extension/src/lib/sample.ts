import type { ScrapedListing } from './types'

// Bundled sample so the panel renders on any page (and offline) during dev/demo.
export const SAMPLE_LISTING: ScrapedListing = {
  asin: 'B07SAMPLE0',
  title:
    'Organic Ashwagandha 1300mg - Stress & Mood Support, Sleep Aid, 120 Veggie Capsules',
  brand: 'NutraPeak',
  price: '$21.95',
  rating: '4.4 out of 5 stars',
  reviewCount: '12,847 ratings',
  bullets: [
    'HIGH POTENCY 1300MG per serving with organic black pepper for absorption',
    'CALM & FOCUS - supports a healthy stress response and balanced mood',
    'RESTFUL SLEEP - helps you wind down without next-day grogginess',
    '120 VEGGIE CAPSULES - 60-day supply, non-GMO, third-party tested',
  ],
  reviews: [
    { title: 'Actually helps my anxiety', body: 'Noticed calmer evenings within a week. I was skeptical but the stress relief is real for me.', rating: 5 },
    { title: 'Sleep improved', body: 'Falling asleep faster and waking up less. No grogginess in the morning which I love.', rating: 5 },
    { title: 'Capsules are easy to swallow', body: 'No aftertaste, smaller than other brands I tried. Good value for 120 count.', rating: 4 },
    { title: 'Works but takes time', body: 'Took about 2 weeks to feel the mood benefits. Consistency matters.', rating: 4 },
  ],
  mainImage:
    'https://m.media-amazon.com/images/I/71sample-placeholder._AC_SL1500_.jpg',
  galleryImages: [],
  marketplace: 'amazon.com',
  url: 'https://www.amazon.com/dp/B07SAMPLE0',
}
