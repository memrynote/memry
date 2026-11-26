// Drives the Rust vault MCP server the way an external client does, with the official
// TypeScript SDK, and prints what it saw as one JSON object. The Rust test
// `agent_mcp_client` (crates/memry-desktop/tests/agent_mcp_client.rs) starts the server and
// asserts on the output.
// Usage: node mcp-client.mjs <base url> <bearer> <rotated-out bearer> <turn capability>
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [url, token, oldToken, turn] = process.argv.slice(2)

async function connect(bearer, headers = {}) {
  const client = new Client({ name: 'memry-agent-mcp-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}`, ...headers } }
  })
  await client.connect(transport)
  return client
}

async function refusal(bearer) {
  try {
    const client = await connect(bearer)
    await client.close()
    return 'connected'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const external = await connect(token)
const agent = await connect(token, { 'X-Memry-Turn': turn, 'X-Memry-Window': 'main' })
const out = {
  serverInfo: external.getServerVersion(),
  tools: (await external.listTools()).tools,
  read: await external.callTool({ name: 'vault_read_note', arguments: { id: 'note-1' } }),
  noArguments: await external.callTool({ name: 'vault_get_tags' }),
  invalid: await external.callTool({
    name: 'vault_search_notes',
    arguments: { query: 'relaunch', memry_unknown_key: true }
  }),
  writeWithoutTurn: await external.callTool({
    name: 'vault_delete_note',
    arguments: { id: 'note-1' }
  }),
  writeInTurn: await agent.callTool({ name: 'vault_delete_note', arguments: { id: 'note-1' } }),
  badBearer: await refusal('0'.repeat(64)),
  rotatedOut: await refusal(oldToken)
}
await external.close()
await agent.close()
process.stdout.write(JSON.stringify(out))
