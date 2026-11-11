# Listing Intelligence Agent — Chrome Extension

A **fleet of AI agents** that research and rewrite any Amazon listing, **right on the product page**.
Open a product → the side panel grabs the ASIN/title/reviews → click **Run AI research** and
four agents fan out in parallel (the keyword agent grounded in real Amazon autocomplete; the other
three do live web search), a synthesizer drafts an optimized, July-27-compliant listing, and a
verifier red-teams it — all streamed live into the panel.

```
On any Amazon PDP → "Run AI research":
  ├ Market / Competitor agent   ┐
  ├ Keyword / SEO agent         ├─ keyword lens grounded in Amazon autocomplete; others use web search
  ├ Voice-of-customer agent     │
  └ Compliance / July-27 agent  ┘
        ↓ all findings
  Synthesizer agent → optimized title (≤75) + Item Highlights (≤125) + bullets + keywords + actions
        ↓
  Verifier (red-team) agent → risks, compliance check, confidence
```

> A companion to [listingoptimization.ai](https://listingoptimization.ai/) — built for the
> on-page seller workflow. **Runs entirely on the Anthropic API key** (web search is a Claude
> server tool — no other provider or billing needed).

## Architecture

```
extension/  Chrome MV3 side panel (React + TS + Tailwind) + Amazon content-script scraper
backend/    Vercel serverless:
              /api/research  streaming multi-agent + web search → synthesizer → verifier
              /api/verify    re-verify a hand-edited draft (structured output)
              /api/drift     compare approved baseline vs live listing (Listing Sentinel)
            lib/claude.ts    shared helpers: mixed models (Sonnet lenses + Opus synth),
                             structured outputs, effort tuning, cached July-27 policy grounding
            (/api/analyze + /api/generate from the earlier image-gen prototype remain but are unused)
```

### Features
- **Deep research** — 4 parallel agents (market, keyword/SEO, voice, compliance). The keyword agent is grounded in real Amazon autocomplete queries (marketplace-correct); the other three use live web search.
- **Actionable output** — edit the drafted title / Item Highlights inline (live char-limit checks), copy any field, re-verify your edits.
- **Drift detection (backend + eval only)** — a `runDrift` agent + `/api/drift` endpoint detect when Amazon's July-27 AI rewrite silently drops selling specifics (per-change severity + fix recommendation). Exercised by the eval harness below; **not wired into the shipped side-panel UI.**
- **Latest Claude** — structured outputs (schema-constrained JSON, guarded parse), `claude-opus-4-8` for synthesis, effort tuning, prompt-cached policy context.

### Jev-orchestrated fleet (`backend/lib/fleet`, opt-in)
The same lenses as an explicit decision tree walked by **Jev** (a decision-only model: Choice / Score /
Noul answers, no reasoning tokens) via the vendored [prove-ai/jev-orchestration](https://github.com/prove-ai/jev-orchestration)
engine (`backend/lib/jev`). Claude still does every piece of research and writing; Jev only decides
*between* steps; every threshold is a number in `lib/fleet/workflow.ts`.

```
assess (Score: quality + risk) → decide (Choice: which lens bundle this ASIN needs)
  → parallel lens-run ×5 (market · keywords · VOC · compliance · AI-answerability [new])
      each: Claude lens → Jev research gate → accept | one retry with a code-named gap | reject
  → draft-loop: Opus draft → char limits (code) + Jev 5-part rubric → rewrite naming the failing checks (≤2 rounds)
  → verifier (red-team) → Jev completion gate (complete | one redraft | incomplete)
  → Jev staged-change guard → approval = allow | confirm | human_review   (the real approval is the panel button)
```

`FLEET_MODE=off` (default) keeps the fixed fan-out. `shadow` runs the tree, asks Jev every question and
**logs** the answers but follows the legacy path (all lenses, gates open) — zero behavior change, and the
log is what calibrates the thresholds. `live` lets Jev route. Same NDJSON event stream, plus
`decision` / `edge` / `agent_skipped` events the panel can ignore.

```bash
npm test                      # 12 routing tests on a scripted Jev (no network)
npm run fleet:demo            # whole tree on mock agents + the keyless Jev stand-in (prints every edge/decision)
npm run fleet:spike           # Phase-1 spike: latency / tokens / $ per decision on the real Jev (needs JEV_API_KEY)
npm run fleet:bench           # decision layer swapped: Jev vs Claude-as-router vs labels → eval/FLEET-BENCH.md
npm run fleet:calibrate       # per-node answer bands vs run outcomes from .jev/runs/*.jsonl
```
Env: `JEV_API_KEY` (free key: https://jev-agent.com/api/auth → `JEV_BASE_URL=https://jev-agent.com/api/v1/systemone`),
`JEV_MODEL=jev-1.13.0` (pinned; aliases move), `FLEET_MODE`, `FLEET_JEV`, `FLEET_AGENTS` — see `backend/.env.example`.

**Measured (2026-11-11, jev-1.13.0 via jev-agent.com, 36 decisions per router, `eval/FLEET-BENCH.md`):** Jev and
Claude Opus 5.5-as-router tie on every accuracy column (lens bundle 75% acceptable, research gate 88%, rubric 75%);
Jev answers in 409 ms p50 / 662 ms p95 at $0.0002 per decision vs 2.2 s / 3.4 s at $0.0069 for Opus. The 135 ms
figure in Jev's own bench did not reproduce from here (~450 ms). First shadow run on real Claude: all 5 lenses
passed their gate (0.69–0.90); the rubric failed 3 rounds because the draft kept a disease-claim word the verifier
also flagged, so completion/approval scored 0.03 → live mode would return `incomplete` + `human_review`, which is right.
Two `FLEET_MODE=live` runs: a thin cable listing routed `thin_listing` @1.00 (market + compliance skipped) and a
claims-heavy lozenge routed `compliance_first` @1.00 (market + voice skipped); 9 Jev calls and 8 Claude calls each,
~105 s, all gates 0.75–0.92. In all three real runs the rubric's `grounded` Noul never exceeded 0.36 across 9 drafts, so
every run ended `human_review` — the first threshold/prompt to calibrate.

### Eval harness
`npm run eval` (add `-- --fast` for Sonnet) runs 31 labeled examples through the **real** `runDrift` agent and scores drift-detection precision/recall/F1, dropped-specific recall, and false-positive rate → writes `eval/SCORECARD.md`. The set includes adversarial boundary cases (spec relocated title↔bullets, value changes, added claims, unit equivalence, dedup) that a naive keyword-diff fails. A first run surfaced an 18% false-positive rate from spec-relocation over-flagging; a targeted prompt fix (judge net effect across title+bullets) took it to **100% accuracy / 0% false positives** — the eval→fix→re-eval loop, and the fix improved production too. The eval tests the same code path the live endpoint runs.

The API key lives only in the backend — never in the extension.

## Run it

### 1. Backend (local, no login)
```bash
cd backend
npm install
cp .env.example .env.local      # add ANTHROPIC_API_KEY (GEMINI_API_KEY optional, only for the old image route)
npm run dev                     # local Node server → http://localhost:3000
```
`npm run dev` runs a tiny Node server (`dev-server.ts`) that loads `.env.local` and
serves the two handlers — no Vercel login needed. For production, `npm run deploy`
(`vercel deploy --prod`) and set the two env vars in the Vercel dashboard.

### 2. Extension
```bash
cd extension
npm install
# point the panel at your backend (default http://localhost:3000):
echo 'VITE_API_BASE=http://localhost:3000' > .env.local
npm run build
```
Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select
`extension/dist`. Open any Amazon product page and click the extension icon.

### Demo without keys
Build with `VITE_DEMO_MODE=true` to run the panel on bundled sample data + a canned brief
(image generation still needs the backend).

## Status
- [x] MV3 extension + Amazon scraper + side panel UI
- [x] `/api/research` — streaming multi-agent pipeline (4 research lenses + web search → synthesizer → verifier)
- [x] live agent cards, optimized-listing card (with char-limit checks), red-team verdict
- [x] verified end-to-end on the Anthropic key (~70–90s full run)
- [x] Jev-orchestrated fleet behind `FLEET_MODE` (shadow/live), ACO lens, research/rubric/completion/staging gates, bench + calibration scripts
- [x] `fleet:spike` + `fleet:bench --routers jev,claude-opus-5-5` on the real Jev; first shadow + live runs on real Claude (numbers above)
- [ ] rewrite feedback should carry Jev's specific rubric complaint (like the lens gap), not just the failing check names
- [ ] calibrate `THRESHOLDS` from shadow logs (`fleet:calibrate`) across many ASINs, then default `FLEET_MODE=live`
- [ ] side panel: render `agent_skipped` / `decision` events and the `approval` label on the apply button
- [ ] hero ASIN cache + demo Loom
