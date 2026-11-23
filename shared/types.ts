export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverUrl: string;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  serverUrl: string;
}

export interface ServerConfig {
  url: string;
  apiKey?: string;
  name: string;
  enabled: boolean;
}

export interface CallMetrics {
  tokensIn: number;
  tokensOut: number;
  toolsExposed: number;
  catalogSize: number;
  roundTrips: number;
  latencyMs: number;
  executionLocation: 'browser' | 'server';
  timestamp: number;
}

export interface CumulativeMetrics {
  tokensAvoided: number;
  roundTripsEliminated: number;
  timeSavedMs: number;
  callsLocal: number;
  callsTotal: number;
}

export interface RelayJob {
  id: string;
  method: string;
  params: unknown;
  createdAt: number;
  result?: unknown;
  error?: string;
  status: 'pending' | 'claimed' | 'done' | 'error';
}

export interface SandboxResult {
  success: boolean;
  value?: unknown;
  error?: string;
  metrics: {
    executionMs: number;
    toolCalls: number;
    toolCallDetails: Array<{
      name: string;
      server: string;
      latencyMs: number;
      responseBytes: number;
    }>;
  };
}

export interface FacadeDefinition {
  typescript: string;
  toolNames: string[];
  serverUrls: string[];
}

export interface CodeModeRequest {
  query: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface CodeModeResponse {
  answer: string;
  program?: string;
  sandboxResult?: SandboxResult;
  metrics: CallMetrics;
}
