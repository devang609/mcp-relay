import { getDb } from './db.js';
import type { ToolSchema, ToolCatalogEntry } from '../shared/types.js';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function fetchToolCatalog(serverUrl: string, apiKey?: string): Promise<ToolSchema[]> {
  const db = getDb();
  const cached = db.prepare(
    'SELECT tools_json, fetched_at FROM catalogs WHERE server_url = ?'
  ).get(serverUrl) as { tools_json: string; fetched_at: number } | undefined;

  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return JSON.parse(cached.tools_json);
  }

  const tools = await fetchToolsFromServer(serverUrl, apiKey);

  db.prepare(
    'INSERT OR REPLACE INTO catalogs (server_url, tools_json, fetched_at) VALUES (?, ?, ?)'
  ).run(serverUrl, JSON.stringify(tools), Date.now());

  return tools;
}

async function fetchToolsFromServer(serverUrl: string, apiKey?: string): Promise<ToolSchema[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP server returned ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let data: {
    result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    error?: { message: string };
  };

  if (contentType.includes('text/event-stream')) {
    data = await parseSSEResponse(response);
  } else {
    data = await response.json() as typeof data;
  }

  if (data.error) {
    throw new Error(`MCP error: ${data.error.message}`);
  }

  const tools = data.result?.tools || [];
  return tools.map(t => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || {},
    serverUrl,
  }));
}

async function parseSSEResponse(response: Response): Promise<any> {
  const text = await response.text();
  const events = text.split('\n\n').filter(Boolean);
  for (const evt of events) {
    const dataLine = evt.split('\n').find(l => l.startsWith('data: '));
    if (dataLine) {
      try {
        const data = JSON.parse(dataLine.slice(6));
        if (data.result || data.error) {
          return data;
        }
      } catch {
        // skip malformed events
      }
    }
  }
  throw new Error('No valid JSON-RPC response found in SSE stream');
}

export function getCatalogEntries(serverUrl: string): ToolCatalogEntry[] {
  const db = getDb();
  const row = db.prepare(
    'SELECT tools_json FROM catalogs WHERE server_url = ?'
  ).get(serverUrl) as { tools_json: string } | undefined;

  if (!row) return [];

  const tools: ToolSchema[] = JSON.parse(row.tools_json);
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    serverUrl: t.serverUrl,
  }));
}

export function getFullSchema(serverUrl: string, toolName: string): ToolSchema | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT tools_json FROM catalogs WHERE server_url = ?'
  ).get(serverUrl) as { tools_json: string } | undefined;

  if (!row) return null;

  const tools: ToolSchema[] = JSON.parse(row.tools_json);
  return tools.find(t => t.name === toolName) || null;
}

export function getAllTools(): ToolCatalogEntry[] {
  const db = getDb();
  const rows = db.prepare('SELECT tools_json, server_url FROM catalogs').all() as Array<{
    tools_json: string;
    server_url: string;
  }>;

  const all: ToolCatalogEntry[] = [];
  for (const row of rows) {
    const tools: ToolSchema[] = JSON.parse(row.tools_json);
    for (const tool of tools) {
      all.push({ name: tool.name, description: tool.description, serverUrl: tool.serverUrl });
    }
  }
  return all;
}

export function getAllSchemas(): ToolSchema[] {
  const db = getDb();
  const rows = db.prepare('SELECT tools_json FROM catalogs').all() as Array<{ tools_json: string }>;

  const all: ToolSchema[] = [];
  for (const row of rows) {
    const tools: ToolSchema[] = JSON.parse(row.tools_json);
    all.push(...tools);
  }
  return all;
}

export function searchCatalog(query: string): ToolCatalogEntry[] {
  const db = getDb();
  const rows = db.prepare('SELECT tools_json, server_url FROM catalogs').all() as Array<{
    tools_json: string;
    server_url: string;
  }>;

  // Wildcard: return all tools from all connected servers
  if (query === '*') {
    const all: ToolCatalogEntry[] = [];
    for (const row of rows) {
      const tools: ToolSchema[] = JSON.parse(row.tools_json);
      for (const tool of tools) {
        all.push({ name: tool.name, description: tool.description, serverUrl: tool.serverUrl });
      }
    }
    return all.slice(0, 30);
  }

  const queryLower = query.toLowerCase();
  const results: Array<ToolCatalogEntry & { score: number }> = [];

  for (const row of rows) {
    const tools: ToolSchema[] = JSON.parse(row.tools_json);
    for (const tool of tools) {
      let score = 0;
      const nameLower = tool.name.toLowerCase();
      const descLower = tool.description.toLowerCase();

      if (nameLower === queryLower) score += 10;
      else if (nameLower.includes(queryLower)) score += 5;
      if (descLower.includes(queryLower)) score += 3;

      const queryWords = queryLower.split(/\s+/);
      for (const word of queryWords) {
        if (nameLower.includes(word)) score += 2;
        if (descLower.includes(word)) score += 1;
      }

      if (score > 0) {
        results.push({
          name: tool.name,
          description: tool.description,
          serverUrl: tool.serverUrl,
          score,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 20);
}
