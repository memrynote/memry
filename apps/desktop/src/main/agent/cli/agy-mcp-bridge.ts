/**
 * stdio <-> HTTP bridge between Antigravity CLI and Memry's Vault MCP server.
 *
 * Why this process exists: `agy` reads MCP servers from a *static* user-level
 * `mcp_config.json`, and header values in that file are not environment-
 * expanded — a `${VAR}` header reaches the server verbatim. Claude's
 * `--mcp-config` and Codex's `-c mcp_servers...` overrides have no counterpart
 * here, so there is no way to hand `agy` a per-turn bearer token or write grant
 * through the config file.
 *
 * What is per-run, though, is the environment: an stdio MCP child inherits the
 * environment of the `agy` process, which Memry spawns. So the config entry
 * stays constant and points at this script, and the turn's secrets arrive in
 * `process.env`. Nothing sensitive is ever written to the user's disk.
 *
 * Runs under Electron with ELECTRON_RUN_AS_NODE=1, so it must stick to node
 * built-ins: importing `electron` here would fail.
 */
import { createInterface } from 'node:readline'

type JsonRpcId = string | number | null | undefined

export interface BridgeTarget {
  url: string | undefined
  token: string | undefined
  writeGrant?: string | undefined
  windowId?: string | undefined
}

export interface Bridge {
  /** Forward one JSON-RPC message; resolves once its reply has been written. */
  handle(line: string): Promise<void>
}

export function createBridge(target: BridgeTarget, write: (message: unknown) => void): Bridge {
  const respondError = (id: JsonRpcId, code: number, message: string): void => {
    // A notification (no id) expects no reply at all.
    if (id === undefined || id === null) return
    write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  const forward = async (payload: unknown, id: JsonRpcId): Promise<void> => {
    if (!target.url || !target.token) {
      respondError(
        id,
        -32000,
        'Memry is not running an agent turn, so its vault tools are unavailable in this session.'
      )
      return
    }

    let response: Response
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${target.token}`,
          ...(target.writeGrant ? { 'x-memry-turn': target.writeGrant } : {}),
          ...(target.windowId ? { 'x-memry-window': target.windowId } : {})
        },
        body: JSON.stringify(payload)
      })
    } catch (error) {
      respondError(id, -32000, `Could not reach Memry: ${describe(error)}`)
      return
    }

    if (!response.ok) {
      respondError(id, -32000, `Memry responded ${response.status}`)
      return
    }

    // The server uses the stateless Streamable HTTP transport, so each message
    // is its own POST and the reply is either a JSON body or an SSE stream
    // carrying one or more `data:` frames.
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await relaySse(response, write)
      return
    }

    const text = (await response.text()).trim()
    if (!text) return
    try {
      write(JSON.parse(text))
    } catch {
      respondError(id, -32000, 'Memry returned a malformed MCP response')
    }
  }

  return {
    async handle(line) {
      const trimmed = line.trim()
      if (!trimmed) return
      let payload: unknown
      try {
        payload = JSON.parse(trimmed)
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      await forward(payload, (payload as { id?: JsonRpcId } | null)?.id)
    }
  }
}

async function relaySse(response: Response, write: (message: unknown) => void): Promise<void> {
  const body = response.body
  if (!body) return
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trimEnd()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trim()
      if (!data) continue
      try {
        write(JSON.parse(data))
      } catch {
        // A frame we cannot parse is not worth killing the session over.
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function main(): void {
  const bridge = createBridge(
    {
      url: process.env.MEMRY_MCP_URL,
      token: process.env.MEMRY_AGENT_TOKEN,
      writeGrant: process.env.MEMRY_AGENT_TURN,
      windowId: process.env.MEMRY_AGENT_WINDOW
    },
    (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  )

  // Messages are forwarded strictly in order: the MCP client pipelines
  // requests, and an out-of-order `initialize` reply makes it abort the
  // handshake.
  let queue: Promise<void> = Promise.resolve()
  createInterface({ input: process.stdin }).on('line', (line) => {
    queue = queue.then(() => bridge.handle(line)).catch(() => undefined)
  })
}

// Only when agy launched this file as a process. Importing it (tests) must not
// start reading stdin.
if (require.main === module) {
  main()
}
