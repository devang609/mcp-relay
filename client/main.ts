import './style.css';
import { detectWebGPU, checkBrowserCompat, lookupHFModel, type GPUCapabilities, type ModelTier } from './model/webgpu-detect.js';
import { loadModel, unloadModel, isModelLoaded, getCurrentModelId, type ModelLoadProgress } from './model/webllm-engine.js';
import { CLOUD_PROVIDERS } from './model/cloud-provider.js';
import { runAgent, type AgentResponse } from './agent/loop.js';
import { getConfig, setConfig, getServers, saveServer, removeServer, exportConfig, importConfig } from './store/index.js';
import type { ServerConfig } from '../shared/types.js';

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  latencyMs: number;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCallRecord[];
  tokensIn?: number;
  tokensOut?: number;
  rounds?: number;
  latencyMs?: number;
  model?: string;
}

interface AppState {
  view: 'chat' | 'servers' | 'dashboard';
  gpuCaps: GPUCapabilities | null;
  modelStatus: 'idle' | 'loading' | 'ready' | 'error';
  modelProgress: ModelLoadProgress | null;
  selectedModel: string;
  servers: ServerConfig[];
  messages: ChatMessage[];
  isProcessing: boolean;
  cloudMode: boolean;
  cloudProvider: string;
  totalQueries: number;
  totalToolCalls: number;
  totalTokens: number;
  abortController: AbortController | null;
  relayToolCalls: number;
}

const state: AppState = {
  view: 'chat',
  gpuCaps: null,
  modelStatus: 'idle',
  modelProgress: null,
  selectedModel: '',
  servers: [],
  messages: [],
  isProcessing: false,
  cloudMode: false,
  cloudProvider: 'groq',
  totalQueries: 0,
  totalToolCalls: 0,
  totalTokens: 0,
  abortController: null,
  relayToolCalls: 0,
};

const DEFAULT_SERVERS: ServerConfig[] = [
  { url: 'https://mcp.deepwiki.com/mcp', name: 'DeepWiki', enabled: true },
  { url: 'https://mcp.context7.com/mcp', name: 'Context7', enabled: true },
  { url: 'https://mcp.firecrawl.dev/mcp', name: 'Firecrawl', enabled: true },
];

// ---- Rendering ----

function render() {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    ${renderCompat()}
    ${renderHeader()}
    <div class="main-layout">
      <div class="chat-panel">
        ${state.view === 'chat' ? renderChat() : ''}
        ${state.view === 'servers' ? renderServers() : ''}
        ${state.view === 'dashboard' ? renderDashboard() : ''}
      </div>
      <div class="side-panel">
        ${renderModelCard()}
        ${renderStatsCard()}
        ${renderServersCard()}
        ${renderRelayCard()}
      </div>
    </div>
  `;
  attachEvents();
}

function renderCompat(): string {
  const compat = checkBrowserCompat();
  if (compat.privateMode) {
    return '<div class="compat-warning">Private browsing detected. MCPRelay needs IndexedDB to store your settings and model weights. Please use a regular browser window.</div>';
  }
  if (!compat.webgpu && !state.cloudMode) {
    return '<div class="banner warning">⚠ WebGPU not available. You can still use MCPRelay with a cloud API key (Groq, OpenAI, or OpenRouter).</div>';
  }
  return '';
}

function renderHeader(): string {
  return `
    <header class="header">
      <div class="header-brand">
        <span class="logo">⚡</span>
        <h1>MCPRelay</h1>
        <span class="header-badge">Agent Mode</span>
      </div>
      <nav class="header-nav">
        <button class="nav-tab ${state.view === 'chat' ? 'active' : ''}" data-view="chat">Chat</button>
        <button class="nav-tab ${state.view === 'servers' ? 'active' : ''}" data-view="servers">Servers</button>
        <button class="nav-tab ${state.view === 'dashboard' ? 'active' : ''}" data-view="dashboard">Dashboard</button>
      </nav>
    </header>
  `;
}

function renderChat(): string {
  if (state.messages.length === 0 && !state.isProcessing) {
    return `
      <div class="welcome">
        <h2>Agentic tool calling in your browser</h2>
        <p>Connect MCP tools, ask a question, and watch the LLM call tools and reason over results — all running locally via WebGPU.</p>
        <div class="welcome-actions">
          ${!isModelLoaded() && !state.cloudMode
            ? `<button class="btn btn-primary" id="btn-setup">Get Started</button>`
            : `<button class="btn btn-primary" id="btn-focus-input">Ask a question</button>`
          }
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;">
          <button class="btn btn-sm example-query" data-query="What is the architecture of the facebook/react repo?">🏗 Repo structure</button>
          <button class="btn btn-sm example-query" data-query="Find the React library and get docs about hooks">📚 Library docs</button>
          <button class="btn btn-sm example-query" data-query="Explain the main concepts of the vercel/next.js repository">🔍 Deep wiki</button>
        </div>
      </div>
      ${renderInputArea()}
    `;
  }

  const messagesHtml = state.messages.map(renderMessage).join('');
  return `
    <div class="chat-messages" id="chat-messages">
      ${messagesHtml}
      ${state.isProcessing ? `
        <div id="streaming-msg" class="message assistant" style="display:none;">
          <div class="message-bubble" id="streaming-content"></div>
        </div>
        <div class="execution-status running" id="processing-status"><div class="spinner"></div><span id="status-text">Thinking...</span></div>
      ` : ''}
    </div>
    ${renderInputArea()}
  `;
}

function renderMessage(msg: ChatMessage): string {
  const isUser = msg.role === 'user';
  let content = escapeHtml(msg.content);

  content = content.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="message-code"><code>$2</code></pre>');
  content = content.replace(/`([^`]+)`/g, '<code style="background:var(--bg-tertiary);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>');
  content = content.replace(/\n/g, '<br>');

  let metaHtml = '';
  if (msg.latencyMs !== undefined) {
    const tokens = (msg.tokensIn || 0) + (msg.tokensOut || 0);
    metaHtml = `
      <div class="message-meta">
        ${msg.model ? `<span style="color:var(--accent);">${escapeHtml(msg.model)}</span>` : ''}
        ${tokens ? `<span>${tokens} tokens</span>` : ''}
        ${msg.rounds ? `<span>${msg.rounds} LLM rounds</span>` : ''}
        <span>${msg.latencyMs}ms</span>
        ${msg.toolCalls ? `<span>${msg.toolCalls.length} tool calls</span>` : ''}
      </div>
    `;
  }

  let toolsHtml = '';
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    toolsHtml = `
      <div class="timeline">
        ${msg.toolCalls.map(tc => `
          <div class="timeline-item">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="tool-name">${escapeHtml(tc.name)}</span>
              <span class="latency">${tc.latencyMs}ms</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;font-family:'JetBrains Mono',monospace;">
              ${escapeHtml(JSON.stringify(tc.args)).slice(0, 120)}
            </div>
            <details style="margin-top:4px;">
              <summary style="font-size:11px;color:var(--accent);cursor:pointer;">Show result</summary>
              <pre style="font-size:11px;max-height:200px;overflow:auto;margin-top:4px;padding:8px;background:var(--code-bg);border-radius:var(--radius);white-space:pre-wrap;word-break:break-word;">${escapeHtml(tc.result).slice(0, 2000)}</pre>
            </details>
          </div>
        `).join('')}
      </div>
    `;
  }

  return `
    <div class="message ${isUser ? 'user' : 'assistant'}">
      <div class="message-bubble">${content}</div>
      ${toolsHtml}
      ${metaHtml}
    </div>
  `;
}

function renderInputArea(): string {
  const placeholder = isModelLoaded() || state.cloudMode
    ? 'Ask a question... (the LLM will call tools and reason over results)'
    : 'Set up a model or API key first...';
  const disabled = state.isProcessing || (!isModelLoaded() && !state.cloudMode);

  return `
    <div class="chat-input-area">
      <div class="chat-input-wrapper">
        <textarea class="chat-input" id="chat-input" placeholder="${placeholder}" ${disabled ? 'disabled' : ''} rows="1"></textarea>
        ${state.isProcessing
          ? '<button class="send-btn stop-btn" id="stop-btn">Stop</button>'
          : `<button class="send-btn" id="send-btn" ${disabled ? 'disabled' : ''}>Send</button>`}
      </div>
    </div>
  `;
}

function renderGPUInfo(): string {
  const caps = state.gpuCaps;
  if (!caps?.supported || !caps.adapterInfo) return '';

  const info = caps.adapterInfo;
  // Build a readable GPU name from whatever fields the browser gave us
  const gpuName = [info.device, info.description, info.architecture]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Unknown GPU';
  const vendor = info.vendor || '';

  return `
    <div style="padding:8px 10px; background:var(--bg-tertiary); border-radius:var(--radius); font-size:12px; margin-bottom:8px; border-left:3px solid var(--success);">
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
        <span style="color:var(--success); font-weight:600;">GPU Detected</span>
      </div>
      <div style="color:var(--text-primary); font-weight:500;">${escapeHtml(gpuName)}</div>
      ${vendor ? `<div style="color:var(--text-muted);">${escapeHtml(vendor)}</div>` : ''}
      <div style="color:var(--text-secondary); margin-top:4px;">
        ~${formatVRAM(caps.estimatedVRAM)} VRAM available
        · Buffer limit ${formatVRAM(Math.round((caps.limits?.maxBufferSize || 0) / (1024*1024)))}
      </div>
    </div>
  `;
}

function renderModelCard(): string {
  const statusClass = state.modelStatus === 'ready' ? 'ready' : state.modelStatus === 'loading' ? 'loading' : state.modelStatus === 'error' ? 'error' : 'idle';
  const cloudProvider = CLOUD_PROVIDERS.find(p => p.id === state.cloudProvider);
  const statusText = state.cloudMode
    ? `☁ ${cloudProvider?.name || 'Cloud'} · ${cloudProvider?.defaultModel || 'unknown model'}`
    : state.modelStatus === 'ready'
    ? `${getCurrentModelId()?.split('-').slice(0, 3).join(' ') || 'Model'} loaded`
    : state.modelStatus === 'loading'
    ? state.modelProgress?.text || 'Loading...'
    : 'No model loaded';

  const models = state.gpuCaps?.allModels || [];

  let progressHtml = '';
  if (state.modelStatus === 'loading' && state.modelProgress) {
    const modelLabel = models.find(m => m.id === state.selectedModel)?.label || state.selectedModel;
    progressHtml = `
      <div style="margin-top:8px;">
        ${renderGPUInfo()}
        <div style="font-size:12px; color:var(--text-muted); margin:6px 0 4px;">
          Auto-loading <strong style="color:var(--text);">${modelLabel}</strong> (~${models.find(m => m.id === state.selectedModel)?.downloadMB || '?'}MB) from HuggingFace...
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${state.modelProgress.progress}%"></div>
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
          ${state.modelProgress.text}
        </div>
      </div>
    `;
  }
  const fittingModels = models.filter(m => m.fits);
  const modelOptions = fittingModels.map(m =>
    `<option value="${m.id}" ${m.id === state.selectedModel ? 'selected' : ''}>${m.label} — ${m.downloadMB}MB download${!m.codeCapable ? ' ⚠' : ''}</option>`
  ).join('');

  const noGPU = !state.gpuCaps?.supported;
  const gpuButNoFit = state.gpuCaps?.supported && fittingModels.length === 0;

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Model</span>
        <div class="status-dot ${statusClass}"></div>
      </div>
      <div class="model-status">
        <div class="status-dot ${statusClass}"></div>
        <span>${statusText}</span>
      </div>
      ${progressHtml}

      ${state.cloudMode ? `
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:12px; color:var(--text-muted);">Provider</div>
          <select class="input-field" id="cloud-provider-select" style="font-size:12px;">
            ${CLOUD_PROVIDERS.map(p => `<option value="${p.id}" ${p.id === state.cloudProvider ? 'selected' : ''}>${p.name} (${p.defaultModel})</option>`).join('')}
          </select>
          <div style="font-size:12px; color:var(--text-muted);">API Key</div>
          <input class="input-field" type="password" id="cloud-key-input" placeholder="sk-... or gsk_..." style="font-size:12px;" />
          <button class="btn" id="btn-use-cloud" style="font-size:12px;">Update Cloud Key</button>
          ${state.gpuCaps?.supported ? `
            <div style="border-top:1px solid var(--border); padding-top:8px; margin-top:4px;">
              <button class="btn" id="btn-switch-local" style="font-size:12px;">Switch to Local Model (WebGPU)</button>
            </div>
          ` : ''}
        </div>
      ` : ''}

      ${state.modelStatus === 'ready' && !state.cloudMode && state.gpuCaps?.supported ? `
        <div style="margin-top:8px;">
          ${renderGPUInfo()}
          <details style="margin-top:8px;">
            <summary style="font-size:12px; color:var(--accent); cursor:pointer;">Change model</summary>
            <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
              ${fittingModels.length > 0 ? `
                <select class="input-field" id="model-select" style="font-size:12px;">
                  ${modelOptions}
                </select>
                <button class="btn" id="btn-load-model" style="font-size:12px;">Load Different Model</button>
              ` : ''}
              <input class="input-field" id="hf-model-input" placeholder="Paste HF model ID..." style="font-size:12px;" />
              <button class="btn" id="btn-load-hf-model" style="font-size:12px;">Load from HuggingFace</button>
              <div class="hf-status" style="font-size:11px; color:var(--text-muted);"></div>
              <div style="border-top:1px solid var(--border); padding-top:8px; margin-top:8px;">
                <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">or switch to a cloud API</div>
                <select class="input-field" id="cloud-provider-select" style="margin-bottom:4px; font-size:12px;">
                  ${CLOUD_PROVIDERS.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
                </select>
                <input class="input-field" type="password" id="cloud-key-input" placeholder="sk-... or gsk_..." style="font-size:12px;" />
                <button class="btn" id="btn-use-cloud" style="font-size:12px; margin-top:4px;">Use Cloud Key</button>
              </div>
            </div>
          </details>
        </div>
      ` : ''}

      ${state.modelStatus === 'error' && state.gpuCaps?.supported ? `
        <div style="margin-top:8px;">
          ${renderGPUInfo()}
          <div style="font-size:12px; color:var(--error); margin:6px 0;">
            Model failed to load. Try a smaller model or use a cloud key.
          </div>
          ${fittingModels.length > 0 ? `
            <select class="input-field" id="model-select" style="font-size:12px;">
              ${modelOptions}
            </select>
            <button class="btn" id="btn-load-model" style="margin-top:4px;">Try Again</button>
          ` : ''}
        </div>
      ` : ''}

      ${state.modelStatus === 'idle' && !state.cloudMode ? `
        <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">

          ${renderGPUInfo()}

          ${noGPU ? `
            <div style="font-size:12px; color:var(--warning); padding:8px 10px; background:rgba(234,179,8,0.06); border-radius:var(--radius); line-height:1.5;">
              <strong>No WebGPU detected.</strong> To run models locally:<br/>
              1. Use <strong>Chrome 113+</strong> or <strong>Edge 113+</strong><br/>
              2. Enable hardware acceleration in Settings &gt; System<br/>
              3. Go to <code style="background:rgba(255,255,255,0.08); padding:1px 4px; border-radius:3px;">chrome://flags/#enable-unsafe-webgpu</code> &rarr; Enabled &rarr; restart<br/>
              ${state.gpuCaps?.reason ? `<details style="margin-top:4px;"><summary style="cursor:pointer; color:var(--text-muted);">Details</summary><div style="margin-top:4px; font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--text-muted); word-break:break-all;">${state.gpuCaps.reason}</div></details>` : ''}
            </div>
            <div style="font-size:12px; color:var(--text-secondary); text-align:center; margin:4px 0;">Or use a cloud API key below</div>
          ` : ''}

          ${gpuButNoFit ? `
            <div style="font-size:12px; color:var(--warning); padding:8px 10px; background:rgba(234,179,8,0.06); border-radius:var(--radius); line-height:1.5;">
              GPU detected (~${state.gpuCaps?.estimatedVRAM}MB VRAM) — below the minimum ${models[0]?.vramMB || 945}MB needed for local models. Add an API key below to use a cloud model instead.
            </div>
          ` : ''}

          ${state.gpuCaps?.supported && fittingModels.length > 0 ? `
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">Qwen 2.5 Coder</div>
            <div style="display:flex; flex-direction:column; gap:4px;">
              ${models.map(m => `
                <div class="model-catalog-item" style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-radius:var(--radius); background:var(--bg-tertiary); border:1px solid var(--border); font-size:12px; opacity:${m.fits ? '1' : '0.35'};">
                  <div style="flex:1; min-width:0;">
                    <div style="font-weight:500; color:${m.fits ? 'var(--text-primary)' : 'var(--text-muted)'};">${m.label}</div>
                    <div style="color:var(--text-muted); font-size:11px;">${m.downloadMB}MB · needs ${(m.vramMB / 1024).toFixed(1)}GB VRAM${!m.fits ? ' · exceeds GPU' : ''}</div>
                  </div>
                  ${m.fits ? `<button class="btn btn-sm catalog-load-btn" data-model-id="${m.id}" style="flex-shrink:0; margin-left:8px;">Load</button>` : ''}
                </div>
              `).join('')}
            </div>
            <input type="hidden" id="model-select" value="${state.selectedModel}" />
          ` : ''}

          <div style="text-align:center; color:var(--text-muted); font-size:12px; margin-top:4px;">or use a cloud key</div>

          <div class="input-group">
            <label class="input-label">Cloud API Key</label>
            <select class="input-field" id="cloud-provider-select" style="margin-bottom:4px;">
              ${CLOUD_PROVIDERS.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
            </select>
            <input class="input-field" type="password" id="cloud-key-input" placeholder="sk-... or gsk_..." />
          </div>
          <button class="btn" id="btn-use-cloud">Use Cloud Key</button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderStatsCard(): string {

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Session Stats</span>
      </div>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value accent">${formatNumber(state.totalTokens)}</div>
          <div class="stat-label">Tokens Used</div>
        </div>
        <div class="stat">
          <div class="stat-value">${state.totalQueries}</div>
          <div class="stat-label">Queries</div>
        </div>
        <div class="stat">
          <div class="stat-value success">${state.totalToolCalls}</div>
          <div class="stat-label">Tool Calls</div>
        </div>
      </div>
    </div>
  `;
}

function renderServersCard(): string {
  const serverList = state.servers.filter(s => s.enabled).map(s => `
    <div class="server-item">
      <div class="server-info">
        <div class="status-dot ready"></div>
        <span class="server-name">${escapeHtml(s.name)}</span>
      </div>
      <span class="server-tools">${escapeHtml(s.url.replace(/^https?:\/\//, '').split('/')[0])}</span>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Connected Servers</span>
        <button class="btn btn-sm" id="btn-add-server">+ Add</button>
      </div>
      <div class="server-list">
        ${serverList || '<div style="font-size:12px;color:var(--text-muted);">No servers connected. Add an MCP server to get started.</div>'}
      </div>
    </div>
  `;
}

function getRelayBaseUrl(): string {
  const loc = window.location;
  if (loc.port === '5173') return `${loc.protocol}//${loc.hostname}:3000`;
  return loc.origin;
}

function renderRelayCard(): string {
  const base = getRelayBaseUrl();
  const relayUrl = `${base}/relay/mcp`;
  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Relay (Stage 2)</span>
      </div>
      <div style="font-size:12px; color:var(--text-secondary);">
        Share this URL with Claude Desktop, Cursor, or Codex:
      </div>
      <div id="relay-url" style="margin-top:8px; padding:8px; background:var(--code-bg); border-radius:var(--radius); font-family:'JetBrains Mono',monospace; font-size:11px; word-break:break-all; color:var(--accent-blue); cursor:pointer;" title="Click to copy">
        ${escapeHtml(relayUrl)}
      </div>
      <div id="relay-copy-status" style="margin-top:4px; font-size:11px; color:var(--success); display:none;"></div>
      <div style="margin-top:6px; font-size:11px; color:var(--text-muted);">
        ⚠ This tab must stay open. Tool calls execute here.
      </div>
    </div>
  `;
}

function renderServers(): string {
  return `
    <div style="padding:24px; overflow-y:auto; flex:1;">
      <h2 style="font-size:20px; margin-bottom:16px;">MCP Servers</h2>
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div class="card">
          <div class="card-header"><span class="card-title">Add Server</span></div>
          <div class="input-group" style="margin-bottom:8px;">
            <label class="input-label">Server URL</label>
            <input class="input-field" id="server-url-input" placeholder="https://mcp.example.com/mcp" />
          </div>
          <div class="input-group" style="margin-bottom:8px;">
            <label class="input-label">API Key (optional)</label>
            <input class="input-field" type="password" id="server-key-input" placeholder="Bearer token..." />
          </div>
          <div class="input-group" style="margin-bottom:12px;">
            <label class="input-label">Display Name</label>
            <input class="input-field" id="server-name-input" placeholder="My Server" />
          </div>
          <button class="btn btn-primary" id="btn-connect-server">Connect</button>
          <div id="connect-status" style="margin-top:8px; font-size:13px; display:none;"></div>
        </div>

        ${state.servers.map(s => `
          <div class="card">
            <div style="display:flex; align-items:center; justify-content:space-between;">
              <div>
                <div style="font-weight:600;">${escapeHtml(s.name)}</div>
                <div style="font-size:12px; color:var(--text-muted);">${escapeHtml(s.url)}</div>
              </div>
              <div style="display:flex; gap:8px; align-items:center;">
                <div class="toggle ${s.enabled ? 'active' : ''}" data-toggle-server="${s.url}"></div>
                <button class="btn btn-sm" data-remove-server="${s.url}" style="color:var(--error);">Remove</button>
              </div>
            </div>
          </div>
        `).join('')}

        <div style="display:flex; gap:8px; margin-top:12px;">
          <button class="btn" id="btn-export-config">Export Config</button>
          <button class="btn" id="btn-import-config">Import Config</button>
        </div>
      </div>
    </div>
    ${renderInputArea()}
  `;
}

function renderDashboard(): string {
  return `
    <div style="padding:24px; overflow-y:auto; flex:1;">
      <h2 style="font-size:20px; margin-bottom:16px;">Dashboard</h2>
      <div class="card">
        <div class="card-header"><span class="card-title">Session Summary</span></div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-value accent">${formatNumber(state.totalTokens)}</div>
            <div class="stat-label">Total Tokens</div>
          </div>
          <div class="stat">
            <div class="stat-value">${state.totalQueries}</div>
            <div class="stat-label">Queries</div>
          </div>
          <div class="stat">
            <div class="stat-value success">${state.totalToolCalls}</div>
            <div class="stat-label">Browser Tool Calls</div>
          </div>
          <div class="stat">
            <div class="stat-value relay">${state.relayToolCalls}</div>
            <div class="stat-label">Relay Tool Calls</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px;">
        <div class="card-header"><span class="card-title">How it works</span></div>
        <div style="font-size:13px; color:var(--text-secondary); line-height:1.6;">
          <p>The LLM runs locally in your browser via WebGPU (or cloud API). MCP tool schemas are handed directly to the model as OpenAI-format function definitions.</p>
          <p style="margin-top:8px;">When the model decides to call a tool, the call is proxied through the backend to the MCP server. Results come back and the model reasons over them to produce a final answer.</p>
          <p style="margin-top:8px;">No code generation, no sandbox — just native tool calling.</p>
        </div>
      </div>
    </div>
    ${renderInputArea()}
  `;
}

// ---- Events ----

function attachEvents() {
  // Navigation
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.view = (tab as HTMLElement).dataset.view as AppState['view'];
      render();
    });
  });

  // Setup button
  document.getElementById('btn-setup')?.addEventListener('click', () => {
    // Just scroll to the model card in the side panel
    document.querySelector('.side-panel')?.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Load model
  document.getElementById('btn-load-model')?.addEventListener('click', async () => {
    const select = document.getElementById('model-select') as HTMLSelectElement;
    if (!select) return;
    state.selectedModel = select.value;
    state.modelStatus = 'loading';
    render();

    try {
      await loadModel(state.selectedModel, (progress) => {
        state.modelProgress = progress;
        const statusEl = document.querySelector('.model-status span');
        if (statusEl) statusEl.textContent = progress.text;
        const fill = document.querySelector('.progress-fill') as HTMLElement;
        if (fill) fill.style.width = `${progress.progress}%`;
      });
      state.modelStatus = 'ready';
      await setConfig('selectedModel', state.selectedModel);
    } catch (err) {
      state.modelStatus = 'error';
      console.error('Model load failed:', err);
    }
    render();
  });

  // Load custom HuggingFace model
  document.getElementById('btn-load-hf-model')?.addEventListener('click', async () => {
    const input = document.getElementById('hf-model-input') as HTMLInputElement;
    if (!input?.value.trim()) return;

    const statusEl = document.querySelector('.hf-status') as HTMLElement;
    if (statusEl) statusEl.textContent = 'Looking up model...';

    const info = await lookupHFModel(input.value.trim());
    if (!info) {
      if (statusEl) statusEl.textContent = 'Model not found in WebLLM catalog.';
      return;
    }

    if (!info.isPrebuilt) {
      if (statusEl) statusEl.textContent = `"${info.modelId}" not in prebuilt catalog — needs MLC-compiled weights.`;
      return;
    }

    if (info.vramMB && state.gpuCaps?.estimatedVRAM && info.vramMB > state.gpuCaps.estimatedVRAM) {
      if (statusEl) statusEl.textContent = `Warning: needs ~${info.vramMB}MB VRAM, you have ~${state.gpuCaps.estimatedVRAM}MB. Loading anyway...`;
    } else if (info.vramMB) {
      if (statusEl) statusEl.textContent = `Found: ${info.modelId} (~${info.vramMB}MB VRAM). Loading...`;
    }

    state.selectedModel = info.modelId;
    state.modelStatus = 'loading';
    render();

    try {
      await loadModel(info.modelId, (progress) => {
        state.modelProgress = progress;
        const span = document.querySelector('.model-status span');
        if (span) span.textContent = progress.text;
        const fill = document.querySelector('.progress-fill') as HTMLElement;
        if (fill) fill.style.width = `${progress.progress}%`;
      });
      state.modelStatus = 'ready';
    } catch (err) {
      state.modelStatus = 'error';
      console.error('HF model load failed:', err);
    }
    render();
  });

  // Cloud key
  document.getElementById('btn-use-cloud')?.addEventListener('click', async () => {
    const keyInput = document.getElementById('cloud-key-input') as HTMLInputElement;
    const providerSelect = document.getElementById('cloud-provider-select') as HTMLSelectElement;

    // Update provider even if key field is empty (keep existing key)
    if (providerSelect) {
      await setConfig('cloudProvider', providerSelect.value);
      state.cloudProvider = providerSelect.value;
    }

    if (keyInput?.value) {
      await setConfig('cloudApiKey', keyInput.value);
    }

    // Need at least a saved key
    const hasKey = keyInput?.value || await getConfig('cloudApiKey');
    if (!hasKey) return;

    if (isModelLoaded()) {
      await unloadModel();
    }

    state.cloudMode = true;
    state.modelStatus = 'ready';
    render();
  });

  // Live-update provider when dropdown changes in cloud mode
  if (state.cloudMode) {
    document.getElementById('cloud-provider-select')?.addEventListener('change', async (e) => {
      const val = (e.target as HTMLSelectElement).value;
      await setConfig('cloudProvider', val);
      state.cloudProvider = val;
      render();
    });
  }

  // Switch back to local model
  document.getElementById('btn-switch-local')?.addEventListener('click', async () => {
    await setConfig('cloudApiKey', '');
    state.cloudMode = false;
    state.modelStatus = 'idle';
    render();

    // Auto-load the best-fitting local model
    if (state.gpuCaps?.recommendedModel) {
      autoLoadModel(state.gpuCaps.recommendedModel);
    }
  });

  // Chat input
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  sendBtn?.addEventListener('click', handleSend);

  document.getElementById('stop-btn')?.addEventListener('click', () => {
    state.abortController?.abort();
  });

  document.getElementById('btn-focus-input')?.addEventListener('click', () => {
    input?.focus();
  });

  // Example queries
  document.querySelectorAll('.example-query').forEach(btn => {
    btn.addEventListener('click', () => {
      const query = (btn as HTMLElement).dataset.query!;
      if (input) {
        input.value = query;
        handleSend();
      }
    });
  });

  // Add server button
  document.getElementById('btn-add-server')?.addEventListener('click', () => {
    state.view = 'servers';
    render();
  });

  // Connect server
  document.getElementById('btn-connect-server')?.addEventListener('click', handleConnectServer);

  // Toggle server
  document.querySelectorAll('[data-toggle-server]').forEach(el => {
    el.addEventListener('click', async () => {
      const url = (el as HTMLElement).dataset.toggleServer!;
      const server = state.servers.find(s => s.url === url);
      if (server) {
        server.enabled = !server.enabled;
        await saveServer(server);
        registerRelayServers();
        render();
      }
    });
  });

  // Remove server
  document.querySelectorAll('[data-remove-server]').forEach(el => {
    el.addEventListener('click', async () => {
      const url = (el as HTMLElement).dataset.removeServer!;
      state.servers = state.servers.filter(s => s.url !== url);
      await removeServer(url);
      registerRelayServers();
      render();
    });
  });

  // Export/import config
  document.getElementById('btn-export-config')?.addEventListener('click', async () => {
    const json = await exportConfig();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mcprelay-config.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btn-import-config')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      await importConfig(text);
      state.servers = await getServers();
      render();
    };
    input.click();
  });

  // Copy relay URL
  document.getElementById('relay-url')?.addEventListener('click', async () => {
    const text = document.getElementById('relay-url')?.textContent?.trim();
    if (text) {
      await navigator.clipboard.writeText(text);
      const status = document.getElementById('relay-copy-status');
      if (status) { status.style.display = 'block'; status.textContent = 'Copied!'; }
      setTimeout(() => { if (status) status.style.display = 'none'; }, 2000);
    }
  });

  // Model select (hidden input fallback)
  document.getElementById('model-select')?.addEventListener('change', (e) => {
    state.selectedModel = (e.target as HTMLSelectElement).value;
  });

  // Model catalog load buttons
  document.querySelectorAll('.catalog-load-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const modelId = (btn as HTMLElement).dataset.modelId;
      if (!modelId) return;
      state.selectedModel = modelId;
      state.modelStatus = 'loading';
      render();
      try {
        await loadModel(modelId, (progress) => {
          state.modelProgress = progress;
          const statusEl = document.querySelector('.model-status span');
          if (statusEl) statusEl.textContent = progress.text;
          const fill = document.querySelector('.progress-fill') as HTMLElement;
          if (fill) fill.style.width = `${progress.progress}%`;
        });
        state.modelStatus = 'ready';
        await setConfig('selectedModel', modelId);
      } catch (err) {
        state.modelStatus = 'error';
        console.error('Model load failed:', err);
      }
      render();
    });
  });

  // Scroll chat to bottom
  const messagesEl = document.getElementById('chat-messages');
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

async function handleSend() {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  if (!input?.value.trim() || state.isProcessing) return;

  const query = input.value.trim();
  input.value = '';
  input.style.height = 'auto';

  state.messages.push({ role: 'user', content: query });
  state.isProcessing = true;
  state.abortController = new AbortController();
  render();

  try {
    let streamingStarted = false;
    const result = await runAgent({
      query,
      servers: state.servers.filter(s => s.enabled),
      signal: state.abortController.signal,
      onStatus: (status) => {
        const el = document.getElementById('status-text');
        if (el) el.textContent = status;
      },
      onToolCall: (name, _args, phase) => {
        const el = document.getElementById('status-text');
        if (el) el.textContent = phase === 'start' ? `Calling ${name}...` : `${name} done`;
      },
      onToken: (token) => {
        const streamEl = document.getElementById('streaming-msg');
        const contentEl = document.getElementById('streaming-content');
        const statusEl = document.getElementById('processing-status');
        if (!contentEl) return;
        if (!streamingStarted) {
          streamingStarted = true;
          if (streamEl) streamEl.style.display = '';
          if (statusEl) statusEl.style.display = 'none';
        }
        contentEl.textContent = (contentEl.textContent || '') + token;
        const messagesEl = document.getElementById('chat-messages');
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      },
    });

    const activeModel = state.cloudMode
      ? (CLOUD_PROVIDERS.find(p => p.id === state.cloudProvider)?.defaultModel || 'cloud')
      : (getCurrentModelId()?.split('-').slice(0, 4).join('-') || 'local');

    state.messages.push({
      role: 'assistant',
      content: result.answer,
      toolCalls: result.toolCalls,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      rounds: result.rounds,
      latencyMs: result.latencyMs,
      model: activeModel,
    });

    state.totalQueries++;
    state.totalToolCalls += result.toolCalls.length;
    state.totalTokens += result.tokensIn + result.tokensOut;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      state.messages.push({ role: 'assistant', content: 'Query cancelled.' });
    } else {
      state.messages.push({
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  state.isProcessing = false;
  state.abortController = null;
  render();
}

function showConnectStatus(msg: string, isError = false) {
  const el = document.getElementById('connect-status');
  if (!el) return;
  el.style.display = 'block';
  el.style.color = isError ? 'var(--error)' : 'var(--success)';
  el.textContent = msg;
}

async function handleConnectServer() {
  const urlInput = document.getElementById('server-url-input') as HTMLInputElement;
  const keyInput = document.getElementById('server-key-input') as HTMLInputElement;
  const nameInput = document.getElementById('server-name-input') as HTMLInputElement;

  if (!urlInput?.value) return;

  const url = urlInput.value.trim();
  const apiKey = keyInput?.value?.trim() || undefined;
  const name = nameInput?.value?.trim() || new URL(url).hostname;

  const btn = document.getElementById('btn-connect-server') as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }
  showConnectStatus('Connecting to server...', false);

  try {
    const response = await fetch('/api/catalog/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: url, apiKey }),
    });

    const data = await response.json() as { toolCount: number; schemaTokenWeight: number; error?: string };

    if (data.error) {
      showConnectStatus(`Connection failed: ${data.error}`, true);
      return;
    }

    const server: ServerConfig = { url, apiKey, name, enabled: true };
    state.servers.push(server);
    await saveServer(server);

    urlInput.value = '';
    if (keyInput) keyInput.value = '';
    if (nameInput) nameInput.value = '';

    await refreshToolServerCache();
    registerRelayServers();
    showConnectStatus(`Connected! Found ${data.toolCount} tools (${data.schemaTokenWeight} schema tokens)`);
    setTimeout(() => render(), 1500);
  } catch (err) {
    showConnectStatus(`Connection failed: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  }
}

// ---- Relay polling (Stage 2) ----

let relaySessionId: string | null = null;
let relayInterval: ReturnType<typeof setInterval> | null = null;
const toolServerCache = new Map<string, Set<string>>();

async function refreshToolServerCache() {
  try {
    const res = await fetch('/api/catalog/all-schemas');
    if (!res.ok) return;
    const tools = await res.json() as Array<{ name: string; serverUrl: string }>;
    toolServerCache.clear();
    for (const t of tools) {
      let set = toolServerCache.get(t.serverUrl);
      if (!set) { set = new Set(); toolServerCache.set(t.serverUrl, set); }
      set.add(t.name);
    }
  } catch {}
}

async function registerRelayServers() {
  if (!relaySessionId) return;
  const serverUrls = state.servers.filter(s => s.enabled).map(s => s.url);
  try {
    await fetch(`/relay/register/${relaySessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrls }),
    });
  } catch {}
}

function startRelayPolling() {
  relaySessionId = 'mcprelay';
  registerRelayServers();
  relayInterval = setInterval(async () => {
    if (!relaySessionId) return;

    try {
      const response = await fetch(`/relay/poll/${relaySessionId}`);
      const data = await response.json() as { job: { id: string; method: string; params: { name: string; arguments?: Record<string, unknown> } } | null };

      if (data.job) {
        const { name: toolName, arguments: args } = data.job.params;
        try {
          const proxyRes = await fetch('/api/proxy/tool-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              serverUrl: findServerForTool(toolName),
              apiKey: findApiKeyForTool(toolName),
              toolName,
              args: args || {},
            }),
          });
          const proxyData = await proxyRes.json() as { result?: unknown; error?: { message: string } };

          if (proxyData.error) {
            await fetch(`/relay/result/${data.job.id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: proxyData.error.message }),
            });
          } else {
            await fetch(`/relay/result/${data.job.id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ result: proxyData.result }),
            });
          }
          state.totalToolCalls++;
          updateRelayStats();
        } catch (err) {
          await fetch(`/relay/result/${data.job.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          });
        }
      }
    } catch {
      // Poll failure is non-fatal
    }
  }, 800);
}

function updateRelayStats() {
  const statsEl = document.querySelector('.relay-call-count');
  if (statsEl) statsEl.textContent = String(state.relayToolCalls);
  const sideEl = document.querySelector('.stat-value.relay');
  if (sideEl) sideEl.textContent = String(state.relayToolCalls);
}

function findServerForTool(toolName: string): string {
  for (const s of state.servers) {
    if (!s.enabled) continue;
    // Check cached catalog for this server
    const cached = toolServerCache.get(s.url);
    if (cached?.has(toolName)) return s.url;
  }
  // Fallback: return first enabled server
  return state.servers.find(s => s.enabled)?.url || '';
}

function findApiKeyForTool(toolName: string): string | undefined {
  for (const s of state.servers) {
    if (!s.enabled) continue;
    const cached = toolServerCache.get(s.url);
    if (cached?.has(toolName)) return s.apiKey;
  }
  return undefined;
}

// ---- Utilities ----

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatVRAM(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + 'GB';
  return mb + 'MB';
}

// ---- Auto-load best model ----

async function autoLoadModel(modelId: string) {
  state.modelStatus = 'loading';
  state.selectedModel = modelId;
  render();

  try {
    await loadModel(modelId, (progress) => {
      state.modelProgress = progress;
      const statusEl = document.querySelector('.model-status span');
      if (statusEl) statusEl.textContent = progress.text;
      const fill = document.querySelector('.progress-fill') as HTMLElement;
      if (fill) fill.style.width = `${progress.progress}%`;
    });
    state.modelStatus = 'ready';
    await setConfig('selectedModel', modelId);
  } catch (err) {
    state.modelStatus = 'error';
    console.error('Auto-load model failed:', err);
  }
  render();
}

// ---- Init ----

async function init() {
  // Check storage persistence
  if (navigator.storage?.persist) {
    await navigator.storage.persist();
  }

  // Detect GPU
  state.gpuCaps = await detectWebGPU();
  if (state.gpuCaps.recommendedModel) {
    state.selectedModel = state.gpuCaps.recommendedModel;
  }

  // Load saved servers
  state.servers = await getServers();
  if (state.servers.length === 0) {
    // Pre-load free tool pack
    for (const s of DEFAULT_SERVERS) {
      state.servers.push(s);
      await saveServer(s);
    }
    // Connect default servers silently
    for (const s of DEFAULT_SERVERS) {
      fetch('/api/catalog/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: s.url }),
      }).catch(() => {});
    }
  }

  // Check if cloud key already saved
  const savedCloudKey = await getConfig('cloudApiKey');
  if (savedCloudKey) {
    state.cloudMode = true;
    state.cloudProvider = (await getConfig('cloudProvider') as string) || 'groq';
    state.modelStatus = 'ready';
  }

  // Start relay polling
  await refreshToolServerCache();
  startRelayPolling();

  render();

  // Only auto-load if user previously loaded a model (persisted choice)
  const savedModelId = await getConfig('selectedModel') as string | null;
  if (savedModelId && state.gpuCaps.supported && !savedCloudKey) {
    autoLoadModel(savedModelId);
  }
}

init();
