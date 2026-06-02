import { test, expect } from './fixtures'
import { waitForAppReady } from './utils/electron-helpers'

type AgentStatus = {
  url: string | null
  ['token']: string | null
  toolCount: number
}

type JsonRpcEnvelope = {
  id?: number | string
  result?: unknown
  error?: unknown
}

const AGENT_MCP_STATUS_TIMEOUT_MS = process.env.CI ? 75_000 : 20_000

async function waitForAgentStatus(page: Parameters<typeof waitForAppReady>[0]): Promise<{
  url: string
  bearerValue: string
  toolCount: number
}> {
  await expect
    .poll(
      async () => {
        const status = await page.evaluate(() => window.api.agentMcp.getStatus())
        return Boolean(status.url && status.token && status.toolCount > 0)
      },
      { timeout: AGENT_MCP_STATUS_TIMEOUT_MS }
    )
    .toBe(true)

  const status = (await page.evaluate(() => window.api.agentMcp.getStatus())) as AgentStatus
  if (!status.url || !status.token) {
    throw new Error('Agent MCP status did not include URL and bearer value')
  }
  return { url: status.url, bearerValue: status.token, toolCount: status.toolCount }
}

async function postMcp(url: string, bearerValue: string, body: unknown): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerValue}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(body)
  })
}

function parseMcpEvents(text: string): JsonRpcEnvelope[] {
  const events = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as JsonRpcEnvelope)

  if (events.length > 0) return events
  return [JSON.parse(text) as JsonRpcEnvelope]
}

function findRpcEvent(events: JsonRpcEnvelope[], id: number): JsonRpcEnvelope | undefined {
  return events.find((event) => event.id === id)
}

test.describe('Agent MCP external client', () => {
  test('lists tools, calls a read tool, denies writes, and rejects a bad bearer', async ({
    page
  }) => {
    await waitForAppReady(page)
    const { url, bearerValue, toolCount } = await waitForAgentStatus(page)

    const listResponse = await postMcp(url, bearerValue, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    })
    expect(listResponse.status).toBe(200)
    const listText = await listResponse.text()
    expect(listText).toContain('vault_search_notes')
    expect(listText).toContain('vault_create_note')
    expect(listText).toContain('vault_snooze_inbox_item')
    const listEvent = findRpcEvent(parseMcpEvents(listText), 1)
    expect((listEvent?.result as { tools?: unknown[] } | undefined)?.tools).toHaveLength(toolCount)

    const readResponse = await postMcp(url, bearerValue, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'vault_get_tags',
        arguments: {}
      }
    })
    expect(readResponse.status).toBe(200)
    expect(await readResponse.text()).toContain('"content"')

    const writeResponse = await postMcp(url, bearerValue, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'vault_create_note',
        arguments: { title: 'Test', content_markdown: 'body' }
      }
    })
    expect(writeResponse.status).toBe(200)
    expect(await writeResponse.text()).toContain('PERMISSION_DENIED')

    const badBearer = await postMcp(url, 'wrong', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list'
    })
    expect(badBearer.status).toBe(401)
  })
})
