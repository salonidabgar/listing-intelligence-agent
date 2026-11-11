# Vendored: prove-ai/jev-orchestration (src/, minus the live SSE viewer)

Source: https://github.com/prove-ai/jev-orchestration — vendored 2026-11-11 (repo is not published to npm).
Kept verbatim except for this README. Modules:

- `spec/`      workflow + RunState zod schemas, path resolution
- `jev/`       wire types, HTTP client (TypeSafe / jev-agent.com), Heuristic/Scripted stand-ins, state view builder, ClaudeRouter baseline
- `runtime/`   the engine (guards, Jev calls, tools, events), event types, JSONL sink
- `agents/`    Agent interface, agentTool adapter, ClaudeAgent

Our own code lives in `lib/fleet/` and only imports from here.
