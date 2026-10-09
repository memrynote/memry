import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEEPSEEK_REASONING = 'The user wants tags, so call vault_get_tags.'
export const DEEPSEEK_REPLY = 'You have no tags.'

export interface ChatMessage {
  role: string
  content?: unknown
  reasoning_content?: string
  tool_calls?: unknown[]
}

export interface ChatRequest {
  model?: string
  stream?: boolean
  tools?: Array<{ function?: { name?: string } }>
  tool_choice?: unknown
  reasoning_effort?: unknown
  thinking?: { type?: string }
  messages: ChatMessage[]
}

export interface FakeDeepSeekOptions {
  /** Bearer token the server requires; null accepts any request. */
  apiKey?: string | null
  /** `once`: one tool call, then text. `always`: a tool call whenever tools are offered. `reject`: tools are an error, as with a model without function calling. */
  tools?: 'once' | 'always' | 'reject'
  /** reasoning_effort values the API accepts. */
  efforts?: readonly string[]
  /** Text of a final answer. */
  reply?: string
}

export interface FakeDeepSeek {
  baseUrl: string
  /** Every chat request with the status it got, in arrival order. */
  requests: Array<{ body: ChatRequest; status: number }>
  close: () => Promise<void>
}

// The DeepSeek API rules the app broke on (FB-006, #2609) plus the request fields it adds
// (#2708). Thinking is on unless the request disables it.
function rejectReason(body: ChatRequest, options: Required<FakeDeepSeekOptions>): string | null {
  const thinking = body.thinking?.type !== 'disabled'
  if (
    body.reasoning_effort !== undefined &&
    !options.efforts.includes(String(body.reasoning_effort))
  ) {
    return `reasoning_effort ${String(body.reasoning_effort)} is not supported`
  }
  if (body.tools && options.tools === 'reject')
    return 'this model does not support function calling'
  if (thinking && body.tools && typeof body.tool_choice === 'object' && body.tool_choice !== null) {
    return 'tool_choice is not supported in thinking mode'
  }
  const stripped = body.messages.some(
    (message) => message.role === 'assistant' && message.tool_calls && !message.reasoning_content
  )
  return thinking && stripped ? 'reasoning_content must be passed back in thinking mode' : null
}

function toolCall(body: ChatRequest): {
  id: string
  type: string
  function: { name: string; arguments: string }
} {
  const names = (body.tools ?? []).map((tool) => tool.function?.name ?? '')
  const name = names.includes('vault_get_tags') ? 'vault_get_tags' : (names[0] ?? '')
  const toolResults = body.messages.filter((message) => message.role === 'tool').length
  return {
    id: `call_${toolResults + 1}`,
    type: 'function',
    function: { name, arguments: name === 'memry_probe_echo' ? '{"text":"ok"}' : '{}' }
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const value = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: DEEPSEEK_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
  return `data: ${JSON.stringify(value)}\n\n`
}

async function readBody(req: IncomingMessage): Promise<string> {
  let text = ''
  for await (const piece of req) text += String(piece)
  return text
}

export async function startFakeDeepSeek(input: FakeDeepSeekOptions = {}): Promise<FakeDeepSeek> {
  const options: Required<FakeDeepSeekOptions> = {
    apiKey: input.apiKey ?? null,
    tools: input.tools ?? 'once',
    efforts: input.efforts ?? ['high', 'max'],
    reply: input.reply ?? DEEPSEEK_REPLY
  }
  const requests: FakeDeepSeek['requests'] = []

  const server = createServer((req, res) => {
    void (async () => {
      if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
        send(res, 401, { error: { message: 'Authentication Fails', type: 'authentication_error' } })
        return
      }
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        send(res, 200, { object: 'list', data: [{ id: DEEPSEEK_MODEL, object: 'model' }] })
        return
      }
      const body = JSON.parse(await readBody(req)) as ChatRequest
      const rejected = rejectReason(body, options)
      requests.push({ body, status: rejected ? 400 : 200 })
      if (rejected) {
        send(res, 400, { error: { message: rejected, type: 'invalid_request_error' } })
        return
      }

      const thinking = body.thinking?.type !== 'disabled'
      const reasoning = thinking ? { reasoning_content: DEEPSEEK_REASONING } : {}
      const toolRounds = body.messages.filter((message) => message.role === 'tool').length
      const call =
        body.tools && (options.tools === 'always' || toolRounds === 0) ? toolCall(body) : null

      if (!body.stream) {
        const message = call
          ? { role: 'assistant', content: null, ...reasoning, tool_calls: [call] }
          : { role: 'assistant', content: options.reply, ...reasoning }
        send(res, 200, {
          choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }]
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ role: 'assistant', content: '', ...reasoning }))
      if (call) {
        res.write(chunk({ tool_calls: [{ index: 0, ...call }] }))
        res.write(chunk({}, 'tool_calls'))
      } else {
        res.write(chunk({ content: options.reply }))
        res.write(chunk({}, 'stop'))
      }
      res.end('data: [DONE]\n\n')
    })().catch((error: unknown) => send(res, 500, { error: { message: String(error) } }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
