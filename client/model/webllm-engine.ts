export interface ModelLoadProgress {
  stage: 'checking-storage' | 'downloading' | 'compiling' | 'warming-up' | 'ready' | 'error';
  progress: number; // 0-100
  text: string;
  bytesLoaded?: number;
  bytesTotal?: number;
}

export type ProgressCallback = (progress: ModelLoadProgress) => void;

let engine: any = null;
let currentModelId: string | null = null;

export async function loadModel(modelId: string, onProgress: ProgressCallback): Promise<void> {
  if (engine && currentModelId === modelId) {
    onProgress({ stage: 'ready', progress: 100, text: 'Model already loaded' });
    return;
  }

  // Request persistent storage before a potentially large download
  onProgress({ stage: 'checking-storage', progress: 0, text: 'Checking storage...' });
  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persist();
      if (!persisted) {
        console.warn('Storage persistence not granted — weights may be evicted');
      }
    }
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const freeMB = Math.round(((est.quota || 0) - (est.usage || 0)) / (1024 * 1024));
      onProgress({
        stage: 'checking-storage',
        progress: 2,
        text: `${freeMB}MB storage available`,
      });
    }
  } catch {
    // Storage API unavailable
  }

  onProgress({ stage: 'downloading', progress: 3, text: 'Loading WebLLM runtime...' });

  // Dynamic import to keep initial bundle small.
  // WebLLM downloads model shards from HuggingFace into Cache Storage.
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm');

  onProgress({ stage: 'downloading', progress: 5, text: 'Fetching model from HuggingFace...' });

  engine = await CreateMLCEngine(modelId, {
    initProgressCallback: (report: { progress: number; text: string; timeElapsed?: number }) => {
      const pct = Math.round(report.progress * 100);

      let stage: ModelLoadProgress['stage'] = 'downloading';
      if (report.text.includes('Loading GPU shader')) {
        stage = 'compiling';
      } else if (pct >= 100) {
        stage = 'compiling';
      }

      onProgress({
        stage,
        progress: Math.min(pct, 99),
        text: report.text,
      });
    },
  });

  currentModelId = modelId;

  // Warm-up: first inference includes shader compilation and looks like a hang
  onProgress({ stage: 'warming-up', progress: 99, text: 'Warm-up inference (compiling shaders)...' });
  try {
    await engine.chat.completions.create({
      messages: [{ role: 'user', content: 'return 1+1' }],
      max_tokens: 10,
      temperature: 0.0,
    });
  } catch {
    // Warm-up failure is non-fatal
  }

  onProgress({ stage: 'ready', progress: 100, text: 'Model ready' });
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function generateCompletion(
  messages: ChatMessage[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    tools?: ToolDef[];
  },
): Promise<CompletionResult> {
  if (!engine) {
    throw new Error('Model not loaded');
  }

  const params: Record<string, unknown> = {
    messages,
    max_tokens: options?.maxTokens || 1024,
    temperature: options?.temperature ?? 0.2,
    stream: false,
  };

  if (options?.tools && options.tools.length > 0) {
    params.tools = options.tools;
    params.tool_choice = 'auto';
  }

  const response = await engine.chat.completions.create(params);

  const msg = response.choices?.[0]?.message;
  const content = msg?.content || null;
  const toolCalls: ToolCall[] = msg?.tool_calls || [];
  const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return { content, toolCalls, usage };
}

export async function generateCompletionStream(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  options?: {
    maxTokens?: number;
    temperature?: number;
  },
): Promise<CompletionResult> {
  if (!engine) {
    throw new Error('Model not loaded');
  }

  const chunks = await engine.chat.completions.create({
    messages,
    max_tokens: options?.maxTokens || 1024,
    temperature: options?.temperature ?? 0.2,
    stream: true,
  });

  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onToken(delta.content);
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }

  return { content: content || null, toolCalls: [], usage };
}

export async function resetChat(): Promise<void> {
  if (engine) {
    await engine.resetChat();
  }
}

export function isModelLoaded(): boolean {
  return engine !== null;
}

export function getCurrentModelId(): string | null {
  return currentModelId;
}

export async function unloadModel(): Promise<void> {
  if (engine) {
    engine = null;
    currentModelId = null;
  }
}
