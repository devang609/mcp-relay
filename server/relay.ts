import type { FastifyInstance } from 'fastify';
import { getDb } from './db.js';
import { randomUUID } from 'crypto';

const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 800;
const JOB_EXPIRY_MS = 60_000;

// Tracks which server URLs are enabled per relay session (set by the browser)
const sessionServers = new Map<string, string[]>();

const DEFAULT_SESSION = 'mcprelay';

export function registerRelayRoutes(app: FastifyInstance) {
  // Browser registers its enabled servers for a relay session
  app.post('/relay/register/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { serverUrls } = request.body as { serverUrls: string[] };
    sessionServers.set(sessionId, serverUrls);
    return reply.send({ ok: true });
  });

  // MCP endpoint — agent sends tool calls here
  // Accepts /relay/mcp (defaults to 'mcprelay') or /relay/mcp/:sessionId
  const mcpHandler = async (request: any, reply: any) => {
    const sessionId = (request.params as any).sessionId || DEFAULT_SESSION;
    const body = request.body as {
      jsonrpc: string;
      id: number | string;
      method: string;
      params?: unknown;
    };

    if (body.method === 'initialize') {
      return reply.send({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcprelay', version: '0.1.0' },
        },
      });
    }

    if (body.method === 'tools/list') {
      const db = getDb();
      const enabledUrls = sessionServers.get(sessionId);
      const query = enabledUrls && enabledUrls.length > 0
        ? `SELECT tools_json FROM catalogs WHERE server_url IN (${enabledUrls.map(() => '?').join(',')})`
        : 'SELECT tools_json FROM catalogs';
      const rows = (enabledUrls && enabledUrls.length > 0
        ? db.prepare(query).all(...enabledUrls)
        : db.prepare(query).all()) as Array<{ tools_json: string }>;
      const allTools = rows.flatMap(r => {
        const tools = JSON.parse(r.tools_json) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
        return tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      });
      return reply.send({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: allTools },
      });
    }

    if (body.method === 'tools/call') {
      const db = getDb();
      const jobId = randomUUID();
      const now = Date.now();

      db.prepare(
        `INSERT INTO relay_jobs (id, session_id, method, params_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      ).run(jobId, sessionId, body.method, JSON.stringify(body.params), now, now);

      const deadline = now + TIMEOUT_MS;
      while (Date.now() < deadline) {
        const job = db.prepare(
          'SELECT status, result_json, error FROM relay_jobs WHERE id = ?'
        ).get(jobId) as { status: string; result_json: string | null; error: string | null } | undefined;

        if (job?.status === 'done') {
          return reply.send({
            jsonrpc: '2.0',
            id: body.id,
            result: JSON.parse(job.result_json!),
          });
        }

        if (job?.status === 'error') {
          return reply.send({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32000, message: job.error || 'Execution failed' },
          });
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      db.prepare('DELETE FROM relay_jobs WHERE id = ?').run(jobId);
      return reply.send({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32000,
          message: 'Session gone — the browser tab may be closed. Open the MCPRelay tab to resume.',
        },
      });
    }

    // Notifications (no id) are fire-and-forget — accept silently
    if (body.method.startsWith('notifications/') || body.id === undefined) {
      return reply.status(204).send();
    }

    return reply.status(400).send({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: `Unknown method: ${body.method}` },
    });
  };
  app.post('/relay/mcp', mcpHandler);
  app.post('/relay/mcp/:sessionId', mcpHandler);

  // Browser tab polls for pending jobs
  app.get('/relay/poll/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const db = getDb();

    const job = db.prepare(
      `SELECT id, method, params_json FROM relay_jobs
       WHERE session_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT 1`
    ).get(sessionId) as { id: string; method: string; params_json: string } | undefined;

    if (!job) {
      return reply.send({ job: null });
    }

    db.prepare(
      "UPDATE relay_jobs SET status = 'claimed', updated_at = ? WHERE id = ?"
    ).run(Date.now(), job.id);

    return reply.send({
      job: {
        id: job.id,
        method: job.method,
        params: JSON.parse(job.params_json),
      },
    });
  });

  // Browser tab posts results
  app.post('/relay/result/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { result, error } = request.body as { result?: unknown; error?: string };
    const db = getDb();

    if (error) {
      db.prepare(
        "UPDATE relay_jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ?"
      ).run(error, Date.now(), jobId);
    } else {
      db.prepare(
        "UPDATE relay_jobs SET status = 'done', result_json = ?, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(result), Date.now(), jobId);
    }

    return reply.send({ ok: true });
  });

  // Cleanup expired jobs periodically
  setInterval(() => {
    try {
      const db = getDb();
      db.prepare(
        'DELETE FROM relay_jobs WHERE created_at < ?'
      ).run(Date.now() - JOB_EXPIRY_MS);
    } catch {
      // db may not be ready yet
    }
  }, JOB_EXPIRY_MS);
}
