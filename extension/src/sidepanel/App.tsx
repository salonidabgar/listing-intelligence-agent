import { useEffect, useState } from 'react'
import type { ScrapedListing, LensFinding, ListingPlan, Verdict, Draft } from '../lib/types'
import { scrapeActiveTab, streamResearch, reVerify } from '../lib/api'
import { DEMO_MODE } from '../lib/config'
import { SAMPLE_LISTING } from '../lib/sample'

type Stage = 'idle' | 'scraping' | 'no-listing' | 'ready' | 'researching' | 'done' | 'error'
type AgentStatus = 'running' | 'done' | 'error'
interface AgentState {
  label: string
  status: AgentStatus
  finding?: LensFinding
  message?: string
}

export default function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [listing, setListing] = useState<ScrapedListing | null>(null)
  const [agents, setAgents] = useState<Record<string, AgentState>>({})
  const [order, setOrder] = useState<string[]>([])
  const [keywords, setKeywords] = useState<{ alias: string; seeds: string[]; terms: string[] } | null>(null)
  const [plan, setPlan] = useState<ListingPlan | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [reVerifying, setReVerifying] = useState(false)
  const [reVerifyError, setReVerifyError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function detect() {
    setStage('scraping')
    setError(null)
    const result = DEMO_MODE ? SAMPLE_LISTING : await scrapeActiveTab()
    setListing(result)
    setStage(result ? 'ready' : 'no-listing')
  }

  function upsert(key: string, patch: Partial<AgentState>, label?: string) {
    setAgents((prev) => {
      const existing: AgentState = prev[key] ?? { label: label ?? key, status: 'running' }
      return { ...prev, [key]: { ...existing, ...(label ? { label } : {}), ...patch } }
    })
    setOrder((prev) => (prev.includes(key) ? prev : [...prev, key]))
  }

  function resolveRunning(status: AgentStatus) {
    setAgents((prev) => {
      const next: Record<string, AgentState> = {}
      for (const [k, v] of Object.entries(prev)) next[k] = v.status === 'running' ? { ...v, status } : v
      return next
    })
  }

  async function run() {
    if (!listing) return
    setStage('researching')
    setError(null)
    setAgents({})
    setOrder([])
    setKeywords(null)
    setPlan(null)
    setDraft(null)
    setVerdict(null)
    let fatal = false
    try {
      for await (const ev of streamResearch(listing)) {
        switch (ev.type) {
          case 'agent_start':
            upsert(ev.key, { status: 'running' }, ev.label)
            break
          case 'agent_done':
            upsert(ev.key, { status: 'done', finding: ev.finding }, ev.label)
            break
          case 'agent_error':
            upsert(ev.key, { status: 'error', message: ev.message }, ev.label)
            break
          case 'keywords':
            setKeywords({ alias: ev.alias, seeds: ev.seeds, terms: ev.terms })
            break
          case 'synthesis':
            setPlan(ev.plan)
            setDraft({
              optimizedTitle: ev.plan.optimizedTitle ?? '',
              itemHighlights: ev.plan.itemHighlights ?? '',
              bullets: ev.plan.bullets ?? [],
            })
            upsert('synthesis', { status: 'done' })
            break
          case 'verdict':
            setVerdict(ev.verdict)
            upsert('verify', { status: 'done' })
            break
          case 'done':
            resolveRunning('done')
            break
          case 'fatal':
            fatal = true
            setError(ev.message)
            resolveRunning('error')
            break
        }
      }
      if (fatal) {
        setStage('error')
      } else {
        resolveRunning('done')
        setStage('done')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage('error')
    }
  }

  async function onReVerify() {
    if (!listing || !draft) return
    setReVerifying(true)
    setReVerifyError(null)
    try {
      setVerdict(await reVerify(listing, draft))
    } catch (e) {
      setReVerifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setReVerifying(false)
    }
  }

  const busy = stage === 'researching'
  const researchDone = order.filter((k) => agents[k]?.status === 'done').length

  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <main className="flex-1 px-4 py-4 space-y-4">
        {stage === 'scraping' && <Loading label="Detecting product…" />}
        {stage === 'no-listing' && <NoListing onRetry={detect} />}
        {listing && stage !== 'no-listing' && <ListingCard listing={listing} />}

        {/* ── Optimize flow ── */}
        {(stage === 'ready' || stage === 'done' || stage === 'error') && listing && (
          <PrimaryButton onClick={run}>
            {stage === 'ready' ? 'Run AI research' : 'Re-run research'}
          </PrimaryButton>
        )}

        {order.length > 0 && (
          <FleetCard order={order} agents={agents} busy={busy} done={researchDone} />
        )}

        {keywords && keywords.terms.length > 0 && <KeywordsCard data={keywords} />}

        {draft && plan && (
          <PlanCard
            plan={plan}
            draft={draft}
            setDraft={setDraft}
            onReVerify={onReVerify}
            reVerifying={reVerifying}
            reVerifyError={reVerifyError}
          />
        )}
        {verdict && <VerdictCard verdict={verdict} />}
        {error && <ErrorNote>{error}</ErrorNote>}
      </main>
    </div>
  )
}

/* ───────────────────────── shared primitives ───────────────────────── */

function Header() {
  return (
    <header className="px-4 py-3 border-b border-white/10 flex items-center gap-2.5">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent2 flex items-center justify-center text-white font-bold text-sm">
        L
      </div>
      <h1 className="text-sm font-semibold">Listing Intelligence</h1>
    </header>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl bg-panel border border-white/10 ${className}`}>{children}</div>
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] uppercase tracking-wider text-muted">{children}</p>
}

function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full py-2.5 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-semibold text-sm hover:opacity-90 transition"
    >
      {children}
    </button>
  )
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-red-400 bg-red-500/10 rounded-lg p-2.5">{children}</p>
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10">
      <Spinner />
      <p className="text-xs text-muted">{label}</p>
    </div>
  )
}

function Spinner({ size = 'w-6 h-6' }: { size?: string }) {
  return <div className={`${size} border-2 border-accent/25 border-t-accent rounded-full animate-spin`} />
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className={`text-muted text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
  )
}

function StatusDot({ status }: { status: AgentStatus }) {
  if (status === 'running') return <Spinner size="w-3.5 h-3.5" />
  if (status === 'error') return <span className="text-red-400 text-xs w-3.5 text-center">!</span>
  return <span className="text-accent2 text-xs w-3.5 text-center">✓</span>
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1000)
        } catch {
          /* ignore */
        }
      }}
      className="text-[10px] text-muted hover:text-white shrink-0"
    >
      {done ? 'copied' : 'copy'}
    </button>
  )
}

/* ───────────────────────── empty / product ───────────────────────── */

function NoListing({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="text-center py-12 space-y-3">
      <p className="text-sm font-medium">No Amazon product detected</p>
      <p className="text-xs text-muted max-w-[230px] mx-auto">
        Open a product page (URL has <span className="font-mono">/dp/</span>), then reopen this panel.
      </p>
      <button onClick={onRetry} className="text-xs px-3 py-1.5 rounded-lg border border-white/15 hover:bg-white/5">
        Retry
      </button>
    </div>
  )
}

function ListingCard({ listing }: { listing: ScrapedListing }) {
  return (
    <Card className="p-3 flex gap-3">
      {listing.mainImage && (
        <img src={listing.mainImage} alt="" className="w-12 h-12 rounded-lg object-contain bg-white shrink-0" />
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium line-clamp-2 leading-snug">{listing.title}</p>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted">
          <span className="font-mono">{listing.asin}</span>
          {listing.rating && <span>· {listing.rating.split(' ')[0]}★</span>}
          {listing.price && <span>· {listing.price}</span>}
        </div>
      </div>
    </Card>
  )
}

/* ───────────────────────── research fleet ───────────────────────── */

function FleetCard({
  order,
  agents,
  busy,
  done,
}: {
  order: string[]
  agents: Record<string, AgentState>
  busy: boolean
  done: number
}) {
  return (
    <Card>
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <Label>Agents</Label>
        <span className="text-[10px] text-muted">{busy ? `${done}/${order.length} done` : `${order.length} agents`}</span>
      </div>
      <div className="divide-y divide-white/5">
        {order.map((k) => (
          <AgentRow key={k} state={agents[k]} />
        ))}
      </div>
    </Card>
  )
}

function KeywordsCard({ data }: { data: { alias: string; seeds: string[]; terms: string[] } }) {
  const top = data.terms.slice(0, 12)
  const rest = data.terms.slice(12)
  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Label>Real Amazon searches</Label>
        <span className="text-[10px] text-muted font-mono">{data.alias} · {data.terms.length}</span>
      </div>
      <p className="text-[10px] text-muted leading-snug">
        Live autocomplete queries, in popularity order — grounds the keyword agent instead of guessing.
      </p>
      <div className="flex flex-wrap gap-1">
        {top.map((t) => (
          <span key={t} className="text-[10px] px-2 py-0.5 rounded-md bg-white/[0.04] text-white/80 border border-white/10">
            {t}
          </span>
        ))}
      </div>
      {rest.length > 0 && (
        <Expander label={`+${rest.length} more`}>
          <div className="flex flex-wrap gap-1 pt-1.5">
            {rest.map((t) => (
              <span key={t} className="text-[10px] px-2 py-0.5 rounded-md bg-white/[0.04] text-white/60 border border-white/10">
                {t}
              </span>
            ))}
          </div>
        </Expander>
      )}
    </Card>
  )
}

function AgentRow({ state }: { state: AgentState }) {
  const [open, setOpen] = useState(false)
  const hasDetail = !!state.finding
  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left ${hasDetail ? 'hover:bg-white/[0.03]' : ''}`}
      >
        <StatusDot status={state.status} />
        <span className="text-xs font-medium flex-1 truncate">{state.label}</span>
        {hasDetail && <Chevron open={open} />}
      </button>
      {open && state.finding && (
        <div className="px-3 pb-3 pl-8 space-y-1.5">
          <p className="text-[11px] text-muted leading-relaxed">{state.finding.summary}</p>
          <ul className="space-y-1">
            {(state.finding.points ?? []).map((p, i) => (
              <li key={i} className="text-[11px] leading-snug flex gap-1.5">
                <span className="text-accent2">·</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
          {state.finding.sources?.length > 0 && (
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 pt-0.5">
              {state.finding.sources.slice(0, 3).map((s, i) => (
                <a key={i} href={s} target="_blank" rel="noreferrer" className="text-[9px] text-muted hover:text-accent2 underline truncate max-w-[130px]">
                  {hostOf(s)}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
      {state.message && <p className="px-3 pb-2 pl-8 text-[10px] text-red-400">{state.message}</p>}
    </div>
  )
}

/* ───────────────────────── optimized listing ───────────────────────── */

function PlanCard({
  plan,
  draft,
  setDraft,
  onReVerify,
  reVerifying,
  reVerifyError,
}: {
  plan: ListingPlan
  draft: Draft
  setDraft: (d: Draft) => void
  onReVerify: () => void
  reVerifying: boolean
  reVerifyError: string | null
}) {
  const fullText = [
    `Title: ${draft.optimizedTitle}`,
    `Item Highlights: ${draft.itemHighlights}`,
    '',
    ...draft.bullets.map((b) => `• ${b}`),
    plan.keywordsToAdd?.length ? `\nKeywords: ${plan.keywordsToAdd.join(', ')}` : '',
  ].join('\n')

  return (
    <Card className="p-3 space-y-3 border-accent/25 bg-gradient-to-br from-accent/[0.07] to-transparent">
      <div className="flex items-center justify-between">
        <Label>Optimized listing</Label>
        <CopyBtn text={fullText} />
      </div>

      <EditField label="Title" value={draft.optimizedTitle} max={75} onChange={(v) => setDraft({ ...draft, optimizedTitle: v })} />
      <EditField label="Item Highlights" value={draft.itemHighlights} max={125} onChange={(v) => setDraft({ ...draft, itemHighlights: v })} />

      {draft.bullets.length > 0 && (
        <ul className="space-y-1">
          {draft.bullets.map((b, i) => (
            <li key={i} className="text-[11px] leading-snug flex gap-1.5">
              <span className="text-accent2">•</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}

      {plan.keywordsToAdd?.length ? (
        <div className="flex flex-wrap gap-1">
          {plan.keywordsToAdd.map((k) => (
            <span key={k} className="text-[10px] px-2 py-0.5 rounded-md bg-accent/12 text-accent2 border border-accent/20">
              {k}
            </span>
          ))}
        </div>
      ) : null}

      {plan.actions?.length ? (
        <Expander label={`Actions (${plan.actions.length})`}>
          <ul className="space-y-1 pt-1">
            {plan.actions.map((a, i) => (
              <li key={i} className="text-[11px] leading-snug flex gap-1.5">
                <PriorityDot p={a.priority} />
                <span>{a.action}</span>
              </li>
            ))}
          </ul>
        </Expander>
      ) : null}

      <button
        onClick={onReVerify}
        disabled={reVerifying}
        className="w-full py-2 rounded-lg border border-accent/40 text-accent2 text-xs font-medium hover:bg-accent/10 disabled:opacity-50"
      >
        {reVerifying ? 'Re-verifying…' : 'Re-verify edits'}
      </button>
      {reVerifyError && <p className="text-[10px] text-red-400 leading-snug">{reVerifyError}</p>}
    </Card>
  )
}

function EditField({ label, value, max, onChange }: { label: string; value: string; max: number; onChange: (v: string) => void }) {
  const over = value.length > max
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-muted">{label}</span>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono ${over ? 'text-red-400' : 'text-muted'}`}>
            {value.length}/{max}
          </span>
          <CopyBtn text={value} />
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className={`w-full text-[11px] leading-snug rounded-lg bg-ink/60 border p-2 resize-none focus:outline-none focus:ring-1 ${
          over ? 'border-red-500/50 focus:ring-red-500/40' : 'border-white/12 focus:ring-accent/40'
        }`}
      />
    </div>
  )
}

/* ───────────────────────── verifier (compact) ───────────────────────── */

function VerdictCard({ verdict }: { verdict: Verdict }) {
  const tLen = verdict.titleCharCount ?? 0
  const hLen = verdict.highlightsCharCount ?? 0
  const risks = verdict.risks ?? []
  const notes = verdict.complianceNotes ?? []
  const detailCount = risks.length + notes.length

  const clean = tLen <= 75 && hLen <= 125 && verdict.confidence !== 'low' && risks.length === 0
  const chipCls = clean ? 'text-emerald-400' : verdict.confidence === 'low' ? 'text-red-400' : 'text-amber-400'
  const chipText = clean ? 'looks clean' : `${verdict.confidence ?? 'medium'} confidence`

  return (
    <Card className="p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <Label>Verified</Label>
        <span className={`text-[10px] font-medium ${chipCls}`}>{chipText}</span>
      </div>
      <div className="flex gap-2">
        <CharBadge label="Title" n={tLen} max={75} />
        <CharBadge label="Highlights" n={hLen} max={125} />
      </div>
      {verdict.verdict && <p className="text-[11px] text-muted leading-relaxed line-clamp-3">{verdict.verdict}</p>}
      {detailCount > 0 && (
        <Expander label={`Details (${detailCount})`}>
          <div className="space-y-2 pt-1">
            {risks.length > 0 && <MiniList label="Risks" items={risks} tone="text-amber-400" />}
            {notes.length > 0 && <MiniList label="Compliance" items={notes} tone="text-muted" />}
          </div>
        </Expander>
      )}
    </Card>
  )
}

function CharBadge({ label, n, max }: { label: string; n: number; max: number }) {
  const ok = n <= max
  return (
    <span
      className={`text-[10px] px-2 py-1 rounded-md border font-mono ${
        ok ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'
      }`}
    >
      {label} {n}/{max}
    </span>
  )
}

function MiniList({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted mb-1">{label}</p>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-[11px] leading-snug flex gap-1.5">
            <span className={tone}>·</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ───────────────────────── misc ───────────────────────── */

function Expander({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[10px] text-muted hover:text-white">
        <Chevron open={open} />
        {label}
      </button>
      {open && children}
    </div>
  )
}

function PriorityDot({ p }: { p: 'high' | 'medium' | 'low' }) {
  const c = p === 'high' ? 'bg-red-400' : p === 'medium' ? 'bg-amber-400' : 'bg-muted'
  return <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${c}`} />
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    return url
  }
}

