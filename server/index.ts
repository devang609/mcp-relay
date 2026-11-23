import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDb, closeDb } from './db.js';
import { registerProxyRoutes } from './proxy.js';
import { registerRelayRoutes } from './relay.js';
import { registerCounterRoutes } from './counters.js';
import { fetchToolCatalog, searchCatalog, getFullSchema, getAllTools, getAllSchemas } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await ensureDb();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(rateLimit, {
  max: 1000,
  timeWindow: '1 minute',
});

// API routes
registerProxyRoutes(app);
registerRelayRoutes(app);
registerCounterRoutes(app);

// Catalog routes
app.post('/api/catalog/connect', async (request, reply) => {
  const { serverUrl, apiKey } = request.body as { serverUrl: string; apiKey?: string };

  try {
    const tools = await fetchToolCatalog(serverUrl, apiKey);
    const tokenWeight = JSON.stringify(tools.map(t => t.inputSchema)).length;

    return reply.send({
      toolCount: tools.length,
      schemaTokenWeight: Math.ceil(tokenWeight / 4),
      tools: tools.map(t => ({ name: t.name, description: t.description })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return reply.status(502).send({ error: message });
  }
});

app.get('/api/catalog/search', async (request, reply) => {
  const { q } = request.query as { q: string };
  const results = searchCatalog(q);
  return reply.send(results);
});

app.get('/api/catalog/all', async (_request, reply) => {
  const results = getAllTools();
  return reply.send(results);
});

app.get('/api/catalog/all-schemas', async (_request, reply) => {
  const schemas = getAllSchemas();
  return reply.send(schemas);
});

// Health check
app.get('/api/health', async () => {
  return { status: 'ok', timestamp: Date.now() };
});

// Serve static files in production
const clientPath = path.join(__dirname, '..', 'client');
try {
  await app.register(fastifyStatic, {
    root: clientPath,
    prefix: '/',
    wildcard: false,
  });
  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile('index.html');
  });
} catch {
  // Client build may not exist yet during development
}

const DEFAULT_SERVERS = [
  'https://mcp.context7.com/mcp',
  'https://mcp.deepwiki.com/mcp',
];

const existing = getAllSchemas();
if (existing.length === 0) {
  console.log('No tools cached — connecting default MCP servers...');
  for (const url of DEFAULT_SERVERS) {
    fetchToolCatalog(url).then(tools => {
      console.log(`  ${url}: ${tools.length} tools`);
    }).catch(err => {
      console.log(`  ${url}: failed (${err instanceof Error ? err.message : err})`);
    });
  }
}

const port = parseInt(process.env.PORT || '3000');
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`MCPRelay server running on ${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});
