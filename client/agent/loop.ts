import { generateCompletion, generateCompletionStream, isModelLoaded, resetChat, type ToolDef, type ToolCall, type ChatMessage, type CompletionResult } from '../model/webllm-engine.js';
import { cloudCompletion, CLOUD_PROVIDERS, type CloudProvider } from '../model/cloud-provider.js';
import { getConfig } from '../store/index.js';
import type { ToolSchema } from '../../shared/types.js';

const MAX_TOOL_ROUNDS = 5;
const TOOL_CALL_TIMEOUT_MS = 30_000;
const LLM_CALL_TIMEOUT_MS = 120_000;

export interface AgentOptions {
  query: string;
  servers: Array<{ url: string; apiKey?: string; name: string }>;
  onStatus?: (status: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, phase: 'start' | 'end', result?: string) => void;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface AgentResponse {
  answer: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; latencyMs: number }>;
  tokensIn: number;
  tokensOut: number;
  rounds: number;
  latencyMs: number;
}

export async function runAgent(opts: AgentOptions): Promise<AgentResponse> {
  const { query, servers, onStatus, onToolCall, signal } = opts;
  const startTime = performance.now();

  signal?.throwIfAborted();

  if (isModelLoaded()) {
    await resetChat();
  }

  onStatus?.('Loading tool schemas...');

  const enabledUrls = new Set(servers.map(s => s.url));
  const allTools = (await fetchAllTools(signal)).filter(t => enabledUrls.has(t.serverUrl));
  if (allTools.length === 0) {
    return {
      answer: 'No tools available. Connect an MCP server first.',
      toolCalls: [], tokensIn: 0, tokensOut: 0, rounds: 0,
      latencyMs: Math.round(performance.now() - startTime),
    };
  }

  const toolLookup = new Map(allTools.map(t => [t.name, t]));
  const useNativeTools = await supportsNativeTools();

  onStatus?.(`${allTools.length} tools loaded. Thinking...`);

  if (useNativeTools) {
    return runNativeToolLoop(allTools, toolLookup, opts, startTime);
  }
  return runPromptToolLoop(allTools, toolLookup, opts, startTime);
}

// --- Native tool calling (cloud APIs that support OpenAI function calling) ---

async function runNativeToolLoop(
  allTools: ToolSchema[],
  toolLookup: Map<string, ToolSchema>,
  opts: AgentOptions,
  startTime: number,
): Promise<AgentResponse> {
  const { query, servers, onStatus, onToolCall, onToken, signal } = opts;
  let tokensIn = 0, tokensOut = 0, rounds = 0;
  const allToolCalls: AgentResponse['toolCalls'] = [];

  // Cap tools to limit prompt token usage on rate-limited APIs
  const limitedTools = allTools.slice(0, 12);
  const toolDefs = mcpToOpenAITools(limitedTools);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildNativeSystemPrompt(limitedTools) },
    { role: 'user', content: query },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    signal?.throwIfAborted();
    rounds++;

    const completion = await callLLMWithTimeout(messages, toolDefs, signal);
    tokensIn += completion.usage.prompt_tokens;
    tokensOut += completion.usage.completion_tokens;

    if (completion.toolCalls.length === 0) {
      if (onToken && completion.content) {
        onToken(completion.content);
      }
      return {
        answer: completion.content || 'No response from model.',
        toolCalls: allToolCalls, tokensIn, tokensOut, rounds,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    messages.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls });

    for (const tc of completion.toolCalls) {
      signal?.throwIfAborted();
      const fnName = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}

      const schema = toolLookup.get(fnName);
      if (!schema) {
        messages.push({ role: 'tool', content: `Error: unknown tool "${fnName}". Available tools: ${limitedTools.map(t => t.name).join(', ')}`, tool_call_id: tc.id });
        continue;
      }

      onToolCall?.(fnName, args, 'start');
      onStatus?.(`Calling ${fnName}...`);

      const callStart = performance.now();
      let resultStr: string;
      try {
        const server = servers.find(s => s.url === schema.serverUrl);
        resultStr = await executeToolCallWithTimeout(schema.serverUrl, server?.apiKey, fnName, args, signal);
      } catch (err) {
        resultStr = `Error calling ${fnName}: ${err instanceof Error ? err.message : String(err)}`;
      }
      const latencyMs = Math.round(performance.now() - callStart);

      allToolCalls.push({ name: fnName, args, result: resultStr, latencyMs });
      onToolCall?.(fnName, args, 'end', resultStr);
      messages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id });
    }

    onStatus?.('Thinking...');
  }

  // Final round: no tools so the model must synthesize an answer — stream it
  signal?.throwIfAborted();
  rounds++;
  const finalCompletion = await callLLMWithTimeout(messages, undefined, signal, onToken);
  tokensIn += finalCompletion.usage.prompt_tokens;
  tokensOut += finalCompletion.usage.completion_tokens;

  return {
    answer: finalCompletion.content || 'Reached maximum tool call rounds.',
    toolCalls: allToolCalls, tokensIn, tokensOut, rounds,
    latencyMs: Math.round(performance.now() - startTime),
  };
}

// --- Prompt-based tool calling (for local models without native function calling) ---

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n', max);
  if (cut > max * 0.6) return s.slice(0, cut) + '\n... (truncated)';
  return s.slice(0, max) + '\n... (truncated)';
}

function buildNativeSystemPrompt(tools: ToolSchema[]): string {
  const serverNames = [...new Set(tools.map(t => {
    try { return new URL(t.serverUrl).hostname; } catch { return t.serverUrl; }
  }))];
  return `You are a helpful assistant with access to ${tools.length} tools from these MCP servers: ${serverNames.join(', ')}. Use the provided tools to answer the user's question. Call tools when needed, then give a clear, detailed answer based on the results. If a tool returns an error, try an alternative tool or explain what happened.`;
}

function buildToolSystemPrompt(tools: ToolSchema[]): string {
  const toolDescs = tools.map(t => {
    const params = t.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
    const props = params?.properties || {};
    const required = params?.required || [];
    const paramList = required
      .map(k => `${k}: ${props[k]?.type || 'string'}`)
      .join(', ');
    const desc = truncate(t.description || t.name, 120);
    return `- ${t.name}(${paramList}): ${desc}`;
  }).join('\n');

  return `You have tools. To use one, reply with ONLY this JSON:
{"tool":"NAME","args":{"key":"value"}}

Tools:
${toolDescs}

If you don't need a tool, answer directly.`;
}

function parseToolCallFromText(text: string, validTools: Set<string>): { tool: string; args: Record<string, unknown> } | null {
  const trimmed = text.trim();

  try {
    const obj = JSON.parse(trimmed);
    if (obj.tool && validTools.has(obj.tool)) return obj;
  } catch {}

  const jsonMatch = trimmed.match(/\{[\s\S]*"tool"\s*:\s*"[^"]+?"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.tool && validTools.has(obj.tool)) return obj;
    } catch {}
  }

  return null;
}

async function runPromptToolLoop(
  allTools: ToolSchema[],
  toolLookup: Map<string, ToolSchema>,
  opts: AgentOptions,
  startTime: number,
): Promise<AgentResponse> {
  const { query, servers, onStatus, onToolCall, onToken, signal } = opts;
  let tokensIn = 0, tokensOut = 0, rounds = 0;
  const allToolCalls: AgentResponse['toolCalls'] = [];

  const limitedTools = allTools.slice(0, 8);
  const validToolNames = new Set(limitedTools.map(t => t.name));
  const systemPrompt = buildToolSystemPrompt(limitedTools);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: query },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    signal?.throwIfAborted();
    rounds++;
    onStatus?.(round === 0 ? 'Thinking...' : 'Reasoning over results...');

    const completion = await callLLMWithTimeout(messages, undefined, signal);
    tokensIn += completion.usage.prompt_tokens;
    tokensOut += completion.usage.completion_tokens;

    const responseText = completion.content || '';
    const toolCall = parseToolCallFromText(responseText, validToolNames);

    if (!toolCall) {
      if (onToken && responseText) {
        onToken(responseText);
      }
      return {
        answer: responseText || 'No response from model.',
        toolCalls: allToolCalls, tokensIn, tokensOut, rounds,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    messages.push({ role: 'assistant', content: responseText });

    const schema = toolLookup.get(toolCall.tool);
    if (!schema) {
      messages.push({ role: 'user', content: `Error: unknown tool "${toolCall.tool}". Use one of the available tools.` });
      continue;
    }

    const args = toolCall.args || {};
    onToolCall?.(toolCall.tool, args, 'start');
    onStatus?.(`Calling ${toolCall.tool}...`);

    const callStart = performance.now();
    let resultStr: string;
    try {
      const server = servers.find(s => s.url === schema.serverUrl);
      resultStr = await executeToolCallWithTimeout(schema.serverUrl, server?.apiKey, toolCall.tool, args, signal);
    } catch (err) {
      resultStr = `Error calling ${toolCall.tool}: ${err instanceof Error ? err.message : String(err)}`;
    }
    const latencyMs = Math.round(performance.now() - callStart);

    allToolCalls.push({ name: toolCall.tool, args, result: resultStr, latencyMs });
    onToolCall?.(toolCall.tool, args, 'end', resultStr);
    onStatus?.(`${toolCall.tool} returned (${latencyMs}ms). Reasoning...`);

    const maxResultLen = isModelLoaded() ? 1500 : 4000;
    const truncatedResult = resultStr.length > maxResultLen ? truncate(resultStr, maxResultLen) : resultStr;
    messages.push({ role: 'user', content: `Tool result for ${toolCall.tool}:\n${truncatedResult}\n\nNow answer the original question based on this result.` });
  }

  return {
    answer: 'Reached maximum tool call rounds without a final answer.',
    toolCalls: allToolCalls, tokensIn, tokensOut, rounds,
    latencyMs: Math.round(performance.now() - startTime),
  };
}

// --- Shared utilities ---

function mcpToOpenAITools(tools: ToolSchema[]): ToolDef[] {
  return tools.map(t => {
    const schema = t.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined;
    const minSchema: Record<string, unknown> = { type: 'object' };
    if (schema?.properties) {
      // Only include required params to cut token usage
      const required = schema.required || [];
      if (required.length > 0) {
        const props: Record<string, unknown> = {};
        for (const key of required) {
          if (schema.properties[key]) props[key] = schema.properties[key];
        }
        minSchema.properties = props;
        minSchema.required = required;
      } else {
        minSchema.properties = schema.properties;
      }
    } else {
      minSchema.properties = {};
    }
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: truncate(t.description || t.name, 200),
        parameters: minSchema,
      },
    };
  });
}

async function fetchAllTools(signal?: AbortSignal): Promise<ToolSchema[]> {
  try {
    const res = await fetch('/api/catalog/all-schemas', { signal });
    if (!res.ok) return [];
    return await res.json() as ToolSchema[];
  } catch {
    return [];
  }
}

async function executeToolCallWithTimeout(
  serverUrl: string,
  apiKey: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_CALL_TIMEOUT_MS);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await executeToolCall(serverUrl, apiKey, toolName, args, controller.signal);
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      return `Error: ${toolName} timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s`;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function executeToolCall(
  serverUrl: string,
  apiKey: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/proxy/tool-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverUrl, apiKey, toolName, args }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tool call failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await response.json() as {
    result?: { content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> };
    error?: { message: string; code?: number };
  };

  if (data.error) {
    throw new Error(data.error.message);
  }

  const content = data.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return JSON.stringify(data.result).slice(0, 4000);
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push('[image content omitted]');
    } else if (block.type === 'resource' && block.text) {
      parts.push(block.text);
    } else if (block.text) {
      parts.push(block.text);
    }
  }

  const text = parts.join('\n');
  if (!text) return JSON.stringify(data.result).slice(0, 4000);

  const maxLen = isModelLoaded() ? 1500 : 8000;
  return text.length > maxLen ? truncate(text, maxLen) : text;
}

async function supportsNativeTools(): Promise<boolean> {
  if (isModelLoaded()) return false;
  const cloudKey = await getConfig('cloudApiKey') as string | undefined;
  return !!cloudKey;
}

async function callLLMWithTimeout(
  messages: ChatMessage[],
  tools?: ToolDef[],
  signal?: AbortSignal,
  onToken?: (token: string) => void,
): Promise<CompletionResult> {
  if (isModelLoaded()) {
    if (onToken && !tools) {
      return generateCompletionStream(messages, onToken, { temperature: 0.1, maxTokens: 512 });
    }
    return generateCompletion(messages, { temperature: 0.1, maxTokens: 512 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await callLLM(messages, tools, controller.signal, onToken);
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`LLM call timed out after ${LLM_CALL_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLLM(messages: ChatMessage[], tools?: ToolDef[], signal?: AbortSignal, onToken?: (token: string) => void): Promise<CompletionResult> {
  if (isModelLoaded()) {
    if (onToken && !tools) {
      return generateCompletionStream(messages, onToken, { temperature: 0.1, maxTokens: 512 });
    }
    return generateCompletion(messages, { temperature: 0.1, maxTokens: 512 });
  }

  const cloudKey = await getConfig('cloudApiKey') as string | undefined;
  const providerId = await getConfig('cloudProvider') as string | undefined;

  if (!cloudKey) {
    throw new Error('No model loaded and no cloud API key configured');
  }

  const provider = CLOUD_PROVIDERS.find(p => p.id === providerId) || CLOUD_PROVIDERS[0];
  return cloudCompletion(cloudKey, provider, messages, { temperature: 0.1, maxTokens: 2048, tools, signal, onToken });
}
