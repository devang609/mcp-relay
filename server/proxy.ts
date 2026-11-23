import type { FastifyInstance } from 'fastify';

const MAX_INFLIGHT = 20;
let inflight = 0;
const queue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    queue.push(() => {
      inflight++;
      resolve();
    });
  });
}

function releaseSemaphore() {
  inflight--;
  const next = queue.shift();
  if (next) next();
}

const BLOCKED_PATTERNS = [
  /^(10\.\d+\.\d+\.\d+)/,
  /^(172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/,
  /^(192\.168\.\d+\.\d+)/,
  /^(127\.\d+\.\d+\.\d+)/,
  /^(0\.0\.0\.0)/,
  /^localhost/i,
  /^\[::1\]/,
];

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return BLOCKED_PATTERNS.some(p => p.test(parsed.hostname));
  } catch {
    return true;
  }
}

export function registerProxyRoutes(app: FastifyInstance) {
  app.post('/api/proxy/tool-call', async (request, reply) => {
    const { serverUrl, apiKey, toolName, args } = request.body as {
      serverUrl: string;
      apiKey?: string;
      toolName: string;
      args: Record<string, unknown>;
    };

    if (isBlockedUrl(serverUrl)) {
      return reply.status(400).send({ error: 'Blocked URL: private address ranges not allowed' });
    }

    await acquireSemaphore();
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      let response: Response;
      try {
        response = await fetch(serverUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: args,
            },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          return reply.status(504).send({ error: { message: `MCP server timed out after 30s` } });
        }
        throw err;
      }
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        return reply.status(502).send({
          error: { message: `Upstream returned ${response.status}: ${text.slice(0, 300)}` },
        });
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) {
          return reply.send({
            result: { content: [{ type: 'text', text: '(Response truncated — exceeded 2MB)' }] },
          });
        }
        const events = text.split('\n\n').filter(Boolean);
        for (const evt of events) {
          const dataLine = evt.split('\n').find((l: string) => l.startsWith('data: '));
          if (dataLine) {
            try {
              const data = JSON.parse(dataLine.slice(6));
              if (data.result || data.error) {
                return reply.send(data);
              }
            } catch {
              // skip malformed
            }
          }
        }
        return reply.status(502).send({ error: 'No valid JSON-RPC in SSE stream' });
      }

      const data = await response.json();
      return reply.send(data);
    } finally {
      releaseSemaphore();
    }
  });

  app.get('/api/proxy/stats', async (_request, reply) => {
    return reply.send({ inflight, queued: queue.length, maxInflight: MAX_INFLIGHT });
  });
}
