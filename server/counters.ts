import { getDb } from './db.js';
import type { FastifyInstance } from 'fastify';
import type { CallMetrics } from '../shared/types.js';

export function recordCall(metrics: CallMetrics, sessionHash?: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO counters (session_hash, tokens_in, tokens_out, tools_exposed, catalog_size, round_trips, latency_ms, execution_location, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionHash || null,
    metrics.tokensIn,
    metrics.tokensOut,
    metrics.toolsExposed,
    metrics.catalogSize,
    metrics.roundTrips,
    metrics.latencyMs,
    metrics.executionLocation,
    metrics.timestamp,
  );
}

export function registerCounterRoutes(app: FastifyInstance) {
  app.post('/api/counters/record', async (request, reply) => {
    const { metrics, sessionHash } = request.body as {
      metrics: CallMetrics;
      sessionHash?: string;
    };
    recordCall(metrics, sessionHash);
    return reply.send({ ok: true });
  });

  app.get('/api/counters/aggregate', async (_request, reply) => {
    const db = getDb();
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(tokens_in + tokens_out), 0) as total_tokens,
        COUNT(*) as total_calls,
        COALESCE(SUM(round_trips), 0) as total_round_trips,
        COALESCE(SUM(latency_ms), 0) as total_latency,
        COALESCE(SUM(CASE WHEN execution_location = 'browser' THEN 1 ELSE 0 END), 0) as local_calls
      FROM counters
    `).get() as {
      total_tokens: number;
      total_calls: number;
      total_round_trips: number;
      total_latency: number;
      local_calls: number;
    };

    return reply.send(row);
  });

  app.get('/api/counters/live', async (request, reply) => {
    const { sessionHash } = request.query as { sessionHash?: string };
    const db = getDb();

    const since = Date.now() - 3600_000; // last hour
    const rows = db.prepare(`
      SELECT tokens_in, tokens_out, tools_exposed, catalog_size, round_trips, latency_ms, execution_location, created_at
      FROM counters
      WHERE created_at > ? ${sessionHash ? 'AND session_hash = ?' : ''}
      ORDER BY created_at DESC
      LIMIT 100
    `).all(...(sessionHash ? [since, sessionHash] : [since])) as CallMetrics[];

    return reply.send(rows);
  });
}
