import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Listing Creative AI',
  version: '0.1.0',
  description:
    'Generate high-converting Amazon main images & infographics right on the product page.',
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
  permissions: ['sidePanel', 'activeTab', 'scripting', 'storage'],
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
