import { scrapeListing } from './scraper'
import type { RuntimeMessage } from '../lib/types'

// Respond to scrape requests from the side panel.
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'SCRAPE_LISTING') {
    try {
      const listing = scrapeListing()
      sendResponse({ type: 'LISTING_RESULT', payload: listing })
    } catch (err) {
      console.error('[Listing Creative AI] scrape failed', err)
      sendResponse({ type: 'LISTING_RESULT', payload: null })
    }
  }
  return true // keep the message channel open for async sendResponse
})
