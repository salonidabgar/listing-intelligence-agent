import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Listing Intelligence Agent',
  version: '0.1.0',
  description:
    'On-page AI agents that research and rewrite your Amazon listing into a July-27-compliant title + Item Highlights, verified before you publish.',
  icons: {
    '16': 'icons/icon16.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
  action: {
    default_title: 'Open Listing Creative AI',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  permissions: ['sidePanel', 'storage'],
  host_permissions: [
    'https://*.amazon.com/*',
    'https://*.amazon.co.uk/*',
    'https://*.amazon.in/*',
    'https://*.amazon.de/*',
    'https://*.amazon.ca/*',
  ],
  content_scripts: [
    {
      matches: [
        'https://*.amazon.com/*',
        'https://*.amazon.co.uk/*',
        'https://*.amazon.in/*',
        'https://*.amazon.de/*',
        'https://*.amazon.ca/*',
      ],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
})
