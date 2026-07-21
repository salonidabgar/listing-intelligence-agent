import type { ScrapedListing, ReviewSnippet } from '../lib/types'

// Defensive scraping: Amazon's DOM varies by category/marketplace, so every
// field has multiple selector fallbacks. Returns null if this isn't a PDP.

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function firstText(selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    const t = text(el)
    if (t) return t
  }
  return null
}

function getAsin(): string | null {
  // 1) URL pattern /dp/ASIN or /gp/product/ASIN
  const m = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)
  if (m) return m[1].toUpperCase()
  // 2) Hidden input / data attribute
  const input = document.querySelector<HTMLInputElement>('input#ASIN, input[name="ASIN"]')
  if (input?.value && /^[A-Z0-9]{10}$/i.test(input.value)) return input.value.toUpperCase()
  const dataAsin = document
    .querySelector('[data-asin]')
    ?.getAttribute('data-asin')
  if (dataAsin && /^[A-Z0-9]{10}$/i.test(dataAsin)) return dataAsin.toUpperCase()
  return null
}

function getBullets(): string[] {
  const nodes = document.querySelectorAll(
    '#feature-bullets li span.a-list-item, #feature-bullets ul li, #productFactsDesktopExpander li'
  )
  const out: string[] = []
  nodes.forEach((n) => {
    const t = text(n)
    if (t && !/see more product details/i.test(t)) out.push(t)
  })
  return out.slice(0, 8)
}

function getMainImage(): string | null {
  const img = document.querySelector<HTMLImageElement>(
    '#landingImage, #imgBlkFront, #main-image, #ivLargeImage img'
  )
  if (img) {
    // hi-res variant often hidden in data-old-hires / data-a-dynamic-image
    const hires = img.getAttribute('data-old-hires')
    if (hires) return hires
    const dyn = img.getAttribute('data-a-dynamic-image')
    if (dyn) {
      try {
        const map = JSON.parse(dyn) as Record<string, [number, number]>
        const best = Object.keys(map).sort(
          (a, b) => (map[b][0] || 0) - (map[a][0] || 0)
        )[0]
        if (best) return best
      } catch {
        /* ignore */
      }
    }
    if (img.src) return img.src
  }
  return null
}

function getGallery(): string[] {
  const thumbs = document.querySelectorAll<HTMLImageElement>(
    '#altImages img, li.imageThumbnail img'
  )
  const urls = new Set<string>()
  thumbs.forEach((t) => {
    // thumbnails encode size as ._AC_US40_. — strip to get larger
    const src = t.src?.replace(/\._[^.]+_\./, '.')
    if (src && !/sprite|play-button|360_icon/i.test(src)) urls.add(src)
  })
  return Array.from(urls).slice(0, 8)
}

function getReviews(): ReviewSnippet[] {
  const blocks = document.querySelectorAll('[data-hook="review"], .review')
  const out: ReviewSnippet[] = []
  blocks.forEach((b) => {
    const body = text(b.querySelector('[data-hook="review-body"], .review-text-content'))
    if (!body) return
    const title = firstTextIn(b, ['[data-hook="review-title"]', '.review-title'])
    const ratingText = firstTextIn(b, [
      '[data-hook="review-star-rating"] .a-icon-alt',
      '.review-rating .a-icon-alt',
    ])
    const rating = ratingText ? parseFloat(ratingText) : null
    out.push({ title, body: body.slice(0, 600), rating: Number.isFinite(rating) ? rating : null })
  })
  return out.slice(0, 12)
}

function firstTextIn(root: Element, selectors: string[]): string | null {
  for (const sel of selectors) {
    const t = text(root.querySelector(sel))
    if (t) return t
  }
  return null
}

export function scrapeListing(): ScrapedListing | null {
  const asin = getAsin()
  const title = firstText(['#productTitle', '#title', 'h1#title span'])
  if (!asin || !title) return null

  return {
    asin,
    title,
    brand: firstText(['#bylineInfo', 'a#bylineInfo', '#brand']),
    price: firstText([
      'span.a-price span.a-offscreen',
      '#corePrice_feature_div .a-offscreen',
      '#price_inside_buybox',
    ]),
    rating: firstText([
      '#acrPopover .a-icon-alt',
      'span[data-hook="rating-out-of-text"]',
    ]),
    reviewCount: firstText(['#acrCustomerReviewText', '[data-hook="total-review-count"]']),
    bullets: getBullets(),
    reviews: getReviews(),
    mainImage: getMainImage(),
    galleryImages: getGallery(),
    marketplace: location.hostname.replace('www.', ''),
    url: location.href,
  }
}
