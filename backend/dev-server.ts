// Local, login-free dev server. Loads .env.local and serves the Vercel
// handlers over plain Node http. Run: npm run dev  (stop any `vercel dev` first)
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

// 1) Load .env.local BEFORE importing handlers (they read env at module load).
try {
  const raw = readFileSync(new URL('./.env.local', import.meta.url), 'utf8')
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) process.env[m[1]] ??= m[2]
  }
} catch {
  console.warn('No .env.local found — set ANTHROPIC_API_KEY / GEMINI_API_KEY')
}

// 2) Dynamic import so the env above is in place first.
const { default: research } = await import('./api/research.ts')
const { default: verify } = await import('./api/verify.ts')
const { default: drift } = await import('./api/drift.ts')
const { default: simulate } = await import('./api/simulate.ts')

type Handler = (req: any, res: any) => unknown

// Adapt a Vercel handler (req.body, res.status().json()) to raw Node http.
function adapt(handler: Handler) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    ;(req as any).body = body ? JSON.parse(body) : {}
    ;(res as any).status = (code: number) => {
      res.statusCode = code
      return res
    }
    ;(res as any).json = (obj: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(obj))
    }
    try {
      await handler(req, res)
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'handler error' }))
    }
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/api/research')) return adapt(research)(req, res)
  if (url.startsWith('/api/verify')) return adapt(verify)(req, res)
  if (url.startsWith('/api/drift')) return adapt(drift)(req, res)
  if (url.startsWith('/api/simulate')) return adapt(simulate)(req, res)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, endpoints: ['/api/research', '/api/verify', '/api/drift', '/api/simulate'] }))
})

const PORT = Number(process.env.PORT ?? 3000)
server.listen(PORT, () => console.log(`Local API → http://localhost:${PORT}`))
