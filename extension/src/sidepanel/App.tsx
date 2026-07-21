import { useEffect, useState } from 'react'
import type {
  ScrapedListing,
  LensFinding,
  ListingPlan,
  Verdict,
  Draft,
  DriftReport,
  DriftCause,
  BaselineRecord,
} from '../lib/types'
import {
  scrapeActiveTab,
  streamResearch,
  reVerify,
  checkDrift,
  simulateRewrite,
  getBaseline,
  saveBaseline,
} from '../lib/api'
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
  const [plan, setPlan] = useState<ListingPlan | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [reVerifying, setReVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // monitoring
  const [baseline, setBaselineState] = useState<BaselineRecord | null>(null)
  const [drift, setDrift] = useState<DriftReport | null>(null)
  const [driftStage, setDriftStage] = useState<'idle' | 'checking' | 'error'>('idle')
  const [driftError, setDriftError] = useState<string | null>(null)
  const [simulating, setSimulating] = useState(false)
  const [simulatedTitle, setSimulatedTitle] = useState<string | null>(null)

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
    setBaselineState(result ? await getBaseline(result.asin) : null)
    setDrift(null)
    setDriftStage('idle')
  }

  function upsert(key: string, patch: Partial<AgentState>, label?: string) {
    setAgents((prev) => {
      const existing: AgentState = prev[key] ?? { label: label ?? key, status: 'running' }
      return { ...prev, [key]: { ...existing, ...(label ? { label } : {}), ...patch } }
    })
    setOrder((prev) => (prev.includes(key) ? prev : [...prev, key]))
  }

  // Flip any agents still shown as spinning to a terminal state (done/error).
  function resolveRunning(status: AgentStatus) {
    setAgents((prev) => {
      const next: Record<string, AgentState> = {}
      for (const [k, v] of Object.entries(prev)) {
        next[k] = v.status === 'running' ? { ...v, status } : v
      }
      return next
    })
  }

  async function run() {
    if (!listing) return
    setStage('researching')
    setError(null)
    setAgents({})
    setOrder([])
    setPlan(null)
    setDraft(null)
    setVerdict(null)
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
            setError(ev.message)
            resolveRunning('error')
            break
        }
      }
      resolveRunning('done')
      setStage('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage('error')
    }
  }

  async function onReVerify() {
    if (!listing || !draft) return
    setReVerifying(true)
    try {
      setVerdict(await reVerify(listing, draft))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReVerifying(false)
    }
  }

  async function onSaveBaseline() {
    if (!listing) return
    setBaselineState(await saveBaseline(listing))
    setDrift(null)
    setSimulatedTitle(null)
  }

  async function onCheckDrift() {
    if (!baseline) return
    setDriftStage('checking')
    setDriftError(null)
    setDrift(null)
    setSimulatedTitle(null)
    try {
      const current = DEMO_MODE ? SAMPLE_LISTING : await scrapeActiveTab()
      if (!current) throw new Error('Could not read the current page — open the product page.')
      setDrift(await checkDrift(baseline.listing, current))
      setDriftStage('idle')
    } catch (e) {
      setDriftError(e instanceof Error ? e.message : String(e))
      setDriftStage('error')
    }
  }

  async function onSimulate() {
    if (!baseline) return
    setSimulating(true)
    setDriftError(null)
    setDrift(null)
    setSimulatedTitle(null)
    try {
      const { simulatedTitle: t, report } = await simulateRewrite(baseline.listing)
      setSimulatedTitle(t)
      setDrift(report)
    } catch (e) {
      setDriftError(e instanceof Error ? e.message : String(e))
    } finally {
      setSimulating(false)
    }
  }

  const busy = stage === 'researching'

  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <main className="flex-1 px-4 py-3 space-y-4">
        {stage === 'scraping' && <Spinner label="Detecting product…" />}
        {stage === 'no-listing' && <NoListing onRetry={detect} />}
        {listing && stage !== 'no-listing' && <ListingCard listing={listing} />}

        {listing && stage !== 'no-listing' && (
          <MonitorSection
            baseline={baseline}
            onSave={onSaveBaseline}
            onCheck={onCheckDrift}
            onSimulate={onSimulate}
            checking={driftStage === 'checking'}
            simulating={simulating}
          />
        )}
        {driftError && <p className="text-xs text-red-400 bg-red-500/10 rounded-lg p-3">{driftError}</p>}
        {simulatedTitle && (
          <p className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
            ⚡ Demo — simulated Amazon rewrite: “{simulatedTitle}”
          </p>
        )}
        {drift && <DriftCard report={drift} />}

        {(stage === 'ready' || stage === 'done' || stage === 'error') && listing && (
          <button
            onClick={run}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-semibold text-sm hover:opacity-90 transition shadow-lg shadow-accent/20"
          >
            {stage === 'ready' ? '🤖 Run AI deep-research' : '↻ Re-run research'}
          </button>
        )}

        {order.length > 0 && (
          <section className="space-y-2">
            <SectionLabel>Agent fleet {busy && '· working…'}</SectionLabel>
            {order.map((k) => (
              <AgentCard key={k} state={agents[k]} />
            ))}
          </section>
        )}

        {draft && plan && (
          <EditablePlan
            plan={plan}
            draft={draft}
            setDraft={setDraft}
            onReVerify={onReVerify}
            reVerifying={reVerifying}
          />
        )}
        {verdict && <VerdictCard verdict={verdict} />}

        {error && <p className="text-xs text-red-400 bg-red-500/10 rounded-lg p-3">{error}</p>}
      </main>
      <Footer />
    </div>
  )
}

function Header() {
  return (
    <header className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent2 flex items-center justify-center text-white font-bold text-sm">
        L
      </div>
      <div>
        <h1 className="text-sm font-bold leading-tight">Listing Intelligence Agent</h1>
        <p className="text-[10px] text-muted leading-tight">Research · rewrite · monitor — a fleet of AI agents</p>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="px-4 py-2 border-t border-white/10 text-[10px] text-muted text-center">
      Multi-agent · live web research · powered by Claude
    </footer>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] uppercase tracking-wide text-muted">{children}</p>
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <div className="w-7 h-7 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      <p className="text-xs text-muted text-center max-w-[220px]">{label}</p>
    </div>
  )
}

function NoListing({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="text-center py-10 space-y-3">
      <p className="text-sm font-medium">No Amazon product detected</p>
      <p className="text-xs text-muted max-w-[240px] mx-auto">
        Open a product page (its URL has <span className="font-mono">/dp/</span>), then reopen this panel.
      </p>
      <button onClick={onRetry} className="text-xs px-3 py-1.5 rounded-lg border border-white/15 hover:bg-white/5">
        ↻ Retry detection
      </button>
    </div>
  )
}

function ListingCard({ listing }: { listing: ScrapedListing }) {
  return (
    <div className="rounded-xl bg-panel border border-white/10 p-3 flex gap-3">
      {listing.mainImage && (
        <img src={listing.mainImage} alt="" className="w-14 h-14 rounded-lg object-contain bg-white shrink-0" />
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium line-clamp-3 leading-snug">{listing.title}</p>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted">
          <span className="font-mono">{listing.asin}</span>
          {listing.rating && <span>· {listing.rating.split(' ')[0]}★</span>}
          {listing.price && <span>· {listing.price}</span>}
        </div>
      </div>
    </div>
  )
}

function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {
          /* ignore */
        }
      }}
      className="text-[10px] px-2 py-0.5 rounded-md border border-white/15 hover:bg-white/5 text-muted shrink-0"
    >
      {done ? '✓ Copied' : label}
    </button>
  )
}

function AgentCard({ state }: { state: AgentState }) {
  const icon =
    state.status === 'running' ? (
      <span className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin shrink-0" />
    ) : state.status === 'done' ? (
      <span className="text-accent2 text-sm shrink-0">✓</span>
    ) : (
      <span className="text-red-400 text-sm shrink-0">!</span>
    )
  return (
    <div className="rounded-xl bg-panel border border-white/10 p-3">
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-xs font-semibold">{state.label}</p>
      </div>
      {state.finding && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-muted leading-relaxed">{state.finding.summary}</p>
          <ul className="space-y-1">
            {state.finding.points.map((p, i) => (
              <li key={i} className="text-[11px] leading-snug flex gap-1.5">
                <span className="text-accent2">›</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
          {state.finding.sources?.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {state.finding.sources.slice(0, 3).map((s, i) => (
                <a key={i} href={s} target="_blank" rel="noreferrer" className="text-[9px] text-muted hover:text-accent2 underline truncate max-w-[140px]">
                  {hostOf(s)}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
      {state.message && <p className="mt-1 text-[10px] text-red-400">{state.message}</p>}
    </div>
  )
}

function EditablePlan({
  plan,
  draft,
  setDraft,
  onReVerify,
  reVerifying,
}: {
  plan: ListingPlan
  draft: Draft
  setDraft: (d: Draft) => void
  onReVerify: () => void
  reVerifying: boolean
}) {
  const tLen = draft.optimizedTitle.length
  const hLen = draft.itemHighlights.length
  const fullText = [
    `Title (${tLen}/75): ${draft.optimizedTitle}`,
    `Item Highlights (${hLen}/125): ${draft.itemHighlights}`,
    '',
    'Bullets:',
    ...draft.bullets.map((b) => `• ${b}`),
    '',
    plan.keywordsToAdd?.length ? `Keywords: ${plan.keywordsToAdd.join(', ')}` : '',
  ].join('\n')

  return (
    <div className="rounded-xl bg-gradient-to-br from-accent/10 to-accent2/5 border border-accent/25 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <SectionLabel>✨ Optimized listing · editable</SectionLabel>
        <CopyBtn text={fullText} label="Copy all" />
      </div>

      <EditField
        label="Title"
        value={draft.optimizedTitle}
        max={75}
        onChange={(v) => setDraft({ ...draft, optimizedTitle: v })}
      />
      <EditField
        label="Item Highlights"
        value={draft.itemHighlights}
        max={125}
        onChange={(v) => setDraft({ ...draft, itemHighlights: v })}
      />

      {draft.bullets.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] text-muted">Bullets</p>
            <CopyBtn text={draft.bullets.map((b) => `• ${b}`).join('\n')} />
          </div>
          <ul className="space-y-1">
            {draft.bullets.map((b, i) => (
              <li key={i} className="text-[11px] leading-snug flex gap-1.5">
                <span className="text-accent2">•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.keywordsToAdd?.length ? (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] text-muted">Keywords to add</p>
            <CopyBtn text={plan.keywordsToAdd.join(', ')} />
          </div>
          <div className="flex flex-wrap gap-1">
            {plan.keywordsToAdd.map((k) => (
              <span key={k} className="text-[10px] px-2 py-0.5 rounded-md bg-accent/15 text-accent2 border border-accent/20">
                {k}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {plan.actions?.length ? (
        <div>
          <p className="text-[10px] text-muted mb-1">Prioritized actions</p>
          <ul className="space-y-1">
            {plan.actions.map((a, i) => (
              <li key={i} className="text-[11px] leading-snug flex gap-1.5">
                <PriorityDot p={a.priority} />
                <span>{a.action}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <button
        onClick={onReVerify}
        disabled={reVerifying}
        className="w-full py-2 rounded-lg border border-accent/40 text-accent2 text-xs font-semibold hover:bg-accent/10 disabled:opacity-50"
      >
        {reVerifying ? 'Re-verifying edited draft…' : '🛡 Re-verify my edits'}
      </button>
    </div>
  )
}

function EditField({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: string
  max: number
  onChange: (v: string) => void
}) {
  const over = value.length > max
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <p className={`text-[10px] ${over ? 'text-red-400' : 'text-muted'}`}>
          {label} · {value.length}/{max}
          {over && ' — over limit!'}
        </p>
        <CopyBtn text={value} />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className={`w-full text-[11px] leading-snug rounded-lg bg-ink/60 border p-2 resize-none focus:outline-none focus:ring-1 ${
          over ? 'border-red-500/50 focus:ring-red-500/40' : 'border-white/15 focus:ring-accent/40'
        }`}
      />
    </div>
  )
}

function VerdictCard({ verdict }: { verdict: Verdict }) {
  const color =
    verdict.confidence === 'high' ? 'text-emerald-400' : verdict.confidence === 'low' ? 'text-red-400' : 'text-amber-400'
  return (
    <div className="rounded-xl bg-panel border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <SectionLabel>🛡 Verifier (red-team)</SectionLabel>
        {verdict.confidence && <span className={`text-[10px] font-semibold ${color}`}>{verdict.confidence} confidence</span>}
      </div>
      {verdict.verdict && <p className="text-[11px] leading-relaxed">{verdict.verdict}</p>}
      {verdict.risks?.length ? <List label="Risks" items={verdict.risks} mark="⚠" markClass="text-amber-400" /> : null}
      {verdict.complianceNotes?.length ? (
        <List label="Compliance" items={verdict.complianceNotes} mark="§" markClass="text-muted" />
      ) : null}
    </div>
  )
}

function MonitorSection({
  baseline,
  onSave,
  onCheck,
  onSimulate,
  checking,
  simulating,
}: {
  baseline: BaselineRecord | null
  onSave: () => void
  onCheck: () => void
  onSimulate: () => void
  checking: boolean
  simulating: boolean
}) {
  return (
    <div className="rounded-xl bg-panel border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <SectionLabel>📡 Listing monitor</SectionLabel>
        {baseline ? (
          <span className="text-[10px] text-emerald-400">baseline saved {timeAgo(baseline.savedAt)}</span>
        ) : (
          <span className="text-[10px] text-muted">no baseline yet</span>
        )}
      </div>
      <p className="text-[10px] text-muted leading-relaxed">
        Save an approved snapshot, then check anytime for Amazon's July-27 AI rewrite silently changing your listing.
      </p>
      <div className="flex gap-2">
        <button onClick={onSave} className="flex-1 py-1.5 rounded-lg border border-white/15 text-[11px] font-medium hover:bg-white/5">
          {baseline ? '↻ Update baseline' : '＋ Save as baseline'}
        </button>
        <button
          onClick={onCheck}
          disabled={!baseline || checking || simulating}
          className="flex-1 py-1.5 rounded-lg bg-accent/20 border border-accent/30 text-accent2 text-[11px] font-medium hover:bg-accent/30 disabled:opacity-40"
        >
          {checking ? 'Checking…' : '🔍 Check for drift'}
        </button>
      </div>
      <button
        onClick={onSimulate}
        disabled={!baseline || simulating || checking}
        className="w-full py-1.5 rounded-lg border border-dashed border-amber-500/40 text-amber-300 text-[10px] font-medium hover:bg-amber-500/10 disabled:opacity-40"
      >
        {simulating ? 'Simulating an Amazon rewrite…' : '⚡ Simulate Amazon rewrite (demo)'}
      </button>
    </div>
  )
}

const CAUSE_META: Record<
  DriftCause['type'],
  { icon: string; label: string; cls: string }
> = {
  amazon_ai_rewrite: { icon: '🤖', label: 'Likely Amazon July-27 AI rewrite', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  manual_edit: { icon: '✏️', label: 'Likely manual edit', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  catalog_or_shared_asin: { icon: '🗂', label: 'Likely Amazon catalog / shared-ASIN change', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  no_material_change: { icon: '—', label: 'No material change', cls: 'bg-white/5 text-muted border-white/10' },
  unknown: { icon: '❓', label: 'Cause unclear', cls: 'bg-white/5 text-muted border-white/15' },
}

function CauseBanner({ cause }: { cause: DriftCause }) {
  const m = CAUSE_META[cause.type] ?? CAUSE_META.unknown
  return (
    <div className={`rounded-lg border p-2 ${m.cls}`}>
      <div className="flex items-center gap-1.5">
        <span>{m.icon}</span>
        <span className="text-[11px] font-semibold">{m.label}</span>
        <span className="text-[9px] opacity-70 ml-auto uppercase">{cause.confidence} conf.</span>
      </div>
      {cause.reasoning && <p className="text-[10px] mt-1 opacity-90 leading-snug">{cause.reasoning}</p>}
    </div>
  )
}

function DriftCard({ report }: { report: DriftReport }) {
  if (!report.changed) {
    return (
      <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 space-y-2">
        <p className="text-xs font-semibold text-emerald-400">✓ No drift detected</p>
        {report.likelyCause && <CauseBanner cause={report.likelyCause} />}
        <p className="text-[11px] text-muted leading-relaxed">{report.summary}</p>
      </div>
    )
  }
  return (
    <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 space-y-2">
      <p className="text-xs font-semibold text-red-400">⚠ Drift detected — your listing changed</p>
      {report.likelyCause && <CauseBanner cause={report.likelyCause} />}
      <p className="text-[11px] leading-relaxed">{report.summary}</p>
      {report.droppedSpecifics?.length > 0 && (
        <div>
          <p className="text-[10px] text-muted mb-1">Dropped specifics</p>
          <div className="flex flex-wrap gap-1">
            {report.droppedSpecifics.map((d) => (
              <span key={d} className="text-[10px] px-2 py-0.5 rounded-md bg-red-500/20 text-red-300 border border-red-500/30">
                {d}
              </span>
            ))}
          </div>
        </div>
      )}
      {report.changes?.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-muted">Changes</p>
          {report.changes.map((c, i) => (
            <div key={i} className="rounded-lg bg-black/20 p-2">
              <div className="flex items-center gap-2 mb-0.5">
                <SeverityBadge s={c.severity} />
                <span className="text-[11px] font-medium">{c.field}</span>
              </div>
              <p className="text-[10px] text-muted">
                <span className="line-through">{c.before}</span> → {c.after}
              </p>
              <p className="text-[10px] mt-0.5 leading-snug">{c.impact}</p>
            </div>
          ))}
        </div>
      )}
      {report.recommendation && (
        <div>
          <p className="text-[10px] text-muted mb-0.5">Recommendation</p>
          <p className="text-[11px] leading-relaxed">{report.recommendation}</p>
        </div>
      )}
    </div>
  )
}

function SeverityBadge({ s }: { s: DriftReport['changes'][number]['severity'] }) {
  const c =
    s === 'critical'
      ? 'bg-red-500/25 text-red-300'
      : s === 'high'
      ? 'bg-orange-500/25 text-orange-300'
      : s === 'medium'
      ? 'bg-amber-500/25 text-amber-300'
      : 'bg-white/10 text-muted'
  return <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase ${c}`}>{s}</span>
}

function List({ label, items, mark, markClass }: { label: string; items: string[]; mark: string; markClass: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted mb-1">{label}</p>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-[11px] leading-snug flex gap-1.5">
            <span className={markClass}>{mark}</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
