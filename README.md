# MCPRelay — Code Mode Agent Harness

**Your agent writes programs instead of making tool calls.**

MCPRelay cuts LLM tool-calling cost by giving the model three tools instead of fifty: `search_tools`, `describe_tools`, and `execute`. The model searches for what it needs, pulls a few schemas, writes a short JavaScript program against a typed facade, and that program runs in a QuickJS-WASM sandbox in your browser tab.

Only the program's return value re-enters the model's context, so large intermediate tool results never cost tokens.

## How it works

1. **Search** — the model queries the tool catalog by keyword
2. **Describe** — it pulls TypeScript signatures for just the tools it needs
3. **Execute** — it writes a JavaScript program that calls those tools, and the sandbox runs it

Instead of sending 50 tool schemas (thousands of tokens) every turn, the model sees 3 tools and a compact facade. The sandbox runs in your browser — nothing executes on the server.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. Either:
- **Load a local model** (requires WebGPU / Chromium) — downloads ~400MB–1GB to your browser
- **Paste a cloud API key** (Groq, OpenAI, or OpenRouter) — works immediately

The free tool pack (DeepWiki, Context7) is pre-wired. Add your own MCP servers on the Servers tab.

## Architecture

```
Browser                          Server (Node/Fastify)
┌──────────────────────┐         ┌───────────────────┐
│ WebLLM / Cloud API   │         │ SQLite catalog     │
│ ↓                    │         │ MCP proxy          │
│ Code Mode loop       │  HTTP   │ Relay endpoint     │
│ ↓                    │◄───────►│ Counter aggregation│
│ QuickJS sandbox      │         └───────────────────┘
│ (WASM, 64MB cap)     │
│ ↓                    │
│ Dashboard / Counters │
└──────────────────────┘
```

**Server** — Fastify + SQLite. Caches tool catalogs, proxies tool calls (streaming, with semaphore), serves the relay for Stage 2. Never stores prompts, tokens, arguments, or results.

**Browser** — QuickJS-WASM sandbox with injected host functions. Fresh context per execution. Memory-capped at 64MB with interrupt handler for runaway loops. Tool credentials live in host function closures — generated code can never read a token.

## Stages

| Stage | What it does | Trust level |
|-------|-------------|-------------|
| 0 | Load a model, use free tools, see counters | No account, no key needed |
| 1 | Connect your own MCP servers | Paste a URL and optional API key |
| 2 | Relay endpoint for desktop agents | Tab stays open, agent calls through |

## Stack

- **Server**: Node 20, Fastify, SQLite (better-sqlite3)
- **Sandbox**: quickjs-emscripten (async variant)
- **Local inference**: WebLLM (@mlc-ai/web-llm), Qwen2.5-Coder models
- **Client state**: IndexedDB + Cache Storage
- **Build**: Vite, TypeScript

## Privacy

- Keys stored in IndexedDB on your device, never sent to our server
- MCP tokens transit the proxy (forwarded, never stored, never logged)
- No accounts, no server-side user data
- Dashboard numbers are aggregate and anonymous

## License

MIT


```shell
$env:PATH = "C:\node-v24.21.0-win-x64;$env:PATH"; cd D:\embarko; npm run dev
```