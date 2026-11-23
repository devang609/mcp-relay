/**
 * Baseline measurement: compare token usage between classic tool use
 * and Code Mode for the same MCP server.
 *
 * Usage: npx tsx scripts/eval-tokens.ts <server-url> [api-key]
 */

const serverUrl = process.argv[2];
const apiKey = process.argv[3];

if (!serverUrl) {
  console.error('Usage: npx tsx scripts/eval-tokens.ts <server-url> [api-key]');
  process.exit(1);
}

async function fetchTools(url: string, key?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  const data = await res.json() as { result?: { tools?: any[] } };
  return data.result?.tools || [];
}

async function main() {
  console.log(`Fetching tools from ${serverUrl}...`);
  const tools = await fetchTools(serverUrl, apiKey);
  console.log(`Found ${tools.length} tools\n`);

  // Classic approach: all schemas as tool definitions
  const classicPayload = JSON.stringify(tools.map((t: any) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  })));

  // Code Mode approach: three tools + facade
  const facadeLines = tools.map((t: any) => `  ${t.name}(args: any): Promise<any>;`);
  const facade = `declare const server: {\n${facadeLines.join('\n')}\n};`;

  const codeModePayload = JSON.stringify([
    { type: 'function', function: { name: 'search_tools', description: 'Search available tools', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'describe_tools', description: 'Get schemas for specific tools', parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] } } },
    { type: 'function', function: { name: 'execute', description: 'Run a JavaScript program', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  ]);

  const classicTokens = Math.ceil(classicPayload.length / 4);
  const codeModeTokens = Math.ceil(codeModePayload.length / 4);
  const facadeTokens = Math.ceil(facade.length / 4);

  console.log('=== Token Comparison ===');
  console.log(`Classic (all ${tools.length} schemas):  ~${classicTokens} tokens`);
  console.log(`Code Mode (3 tools):            ~${codeModeTokens} tokens`);
  console.log(`Facade (TypeScript):             ~${facadeTokens} tokens`);
  console.log(`Code Mode total (tools+facade):  ~${codeModeTokens + facadeTokens} tokens`);
  console.log(`\nReduction: ${Math.round((1 - (codeModeTokens + facadeTokens) / classicTokens) * 100)}%`);
  console.log(`Tokens avoided per call: ~${classicTokens - codeModeTokens - facadeTokens}`);
}

main().catch(console.error);
