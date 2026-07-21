# Listing Intelligence Agent — Chrome Extension

A **fleet of AI agents** that research and rewrite any Amazon listing, **right on the product page**.
Open a product → the side panel grabs the ASIN/title/reviews → click **Run AI deep-research** and
four agents fan out in parallel (each doing live web search), a synthesizer drafts an optimized,
July-27-compliant listing, and a verifier red-teams it — all streamed live into the panel.

```
On any Amazon PDP → "Run AI deep-research":
  ├ Market / Competitor agent   ┐
  ├ Keyword / SEO + Rufus agent ├─ each runs Claude's web_search server tool
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
- **Deep research** — 4 parallel agents (market, keyword/Rufus, voice, compliance) with live web search.
- **Actionable output** — edit the drafted title / Item Highlights inline (live char-limit checks), copy any field, re-verify your edits.
- **Listing monitor (drift)** — save an approved baseline per ASIN (chrome.storage), then detect when Amazon's July-27 AI rewrite silently drops selling specifics, with per-change severity + a fix recommendation.
- **Latest Claude** — structured outputs (guaranteed-valid JSON), `claude-opus-4-8` for synthesis + drift, effort tuning, prompt-cached policy context.

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
- [x] verified end-to-end on the Anthropic key (~2.5 min full run)
- [ ] hero ASIN cache + demo Loom
