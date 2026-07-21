// Backend base URL. Override at build time with VITE_API_BASE.
// Defaults to the deployed Vercel backend; falls back to localhost in dev.
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  'http://localhost:3000'

// When true, the panel uses bundled sample data + a canned creative instead of
// hitting the backend. Lets the extension be demoed before keys are wired.
export const DEMO_MODE =
  (import.meta.env.VITE_DEMO_MODE as string | undefined) === 'true'
