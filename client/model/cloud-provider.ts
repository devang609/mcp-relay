export interface CloudProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  browserOriginAllowed: boolean;
}

export const CLOUD_PROVIDERS: CloudProvider[] = [
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-20b',
    browserOriginAllowed: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    browserOriginAllowed: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'qwen/qwen3.7-plus',
    browserOriginAllowed: true,
  },
];

import type { ToolDef, ToolCall, CompletionResult, ChatMessage } from './webllm-engine.js';

export async function cloudCompletion(
  apiKey: string,
  provider: CloudProvider,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; tools?: ToolDef[]; signal?: AbortSignal; onToken?: (token: string) => void },
): Promise<CompletionResult> {
  const useStream = !options?.tools?.length && !!options?.onToken;

  const body: Record<string, unknown> = {
    model: provider.defaultModel,
    messages,
    max_tokens: options?.maxTokens || 2048,
    temperature: options?.temperature ?? 0.2,
    stream: useStream,
  };

  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  if (useStream) {
    body.stream_options = { include_usage: true };
  }

  const RETRYABLE = new Set([429, 500, 502, 503]);
  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 4000);
      await new Promise(r => setTimeout(r, delay));
    }

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(`${provider.name} API error ${response.status}: ${text.slice(0, 200)}`);
      if (RETRYABLE.has(response.status) && attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    if (useStream) {
      return parseSSEStream(response, options!.onToken!);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const msg = data.choices[0]?.message;
    return {
      content: msg?.content || null,
      toolCalls: msg?.tool_calls || [],
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  throw lastError || new Error(`${provider.name} API failed after ${MAX_RETRIES + 1} attempts`);
}

async function parseSSEStream(
  response: Response,
  onToken: (token: string) => void,
): Promise<CompletionResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      if (payload === '[DONE]') continue;

      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onToken(delta.content);
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
      } catch {}
    }
  }

  return { content: content || null, toolCalls: [], usage };
}
