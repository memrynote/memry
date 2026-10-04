import { randomUUID } from 'node:crypto'
import type { LanguageModelMiddleware } from 'ai'

/**
 * How one provider configuration (preset, base URL, model) speaks tools. The capability
 * probe learns it and every chat turn replays it, so the chat sends the request shape
 * the probe proved works instead of asking the user to adapt the provider.
 */
export interface ToolCallProfile {
  /** `omit` when the provider rejected a named tool_choice and only worked without one. */
  toolChoice: 'auto' | 'omit'
  /** `text` when the model writes its call into the reply as `<tool_call>{...}</tool_call>`. */
  toolCalls: 'native' | 'text'
}

export interface TextToolCall {
  toolName: string
  /** The arguments as a JSON string, the shape the AI SDK expects on a tool-call part. */
  input: string
}

export type TextToolCallSegment =
  { kind: 'text'; text: string } | { kind: 'call'; call: TextToolCall }

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapStream']>>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

// Hermes and Qwen chat templates write tool calls this way. A server that cannot parse
// the template returns them as plain reply text instead of `tool_calls`.
const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

/**
 * Splits streamed reply text into plain text and tool calls. Text that could be the start
 * of an open tag is held back until the next delta decides it. Only names in `toolNames`
 * become calls, so a model that quotes the syntax for some other name stays text.
 */
export class TextToolCallSplitter {
  private pending = ''
  private insideCall = false

  constructor(private readonly toolNames: ReadonlySet<string>) {}

  push(delta: string): TextToolCallSegment[] {
    this.pending += delta
    const segments: TextToolCallSegment[] = []
    for (;;) {
      if (this.insideCall) {
        const end = this.pending.indexOf(CLOSE_TAG)
        if (end < 0) return segments
        segments.push(this.closeCall(this.pending.slice(0, end)))
        this.pending = this.pending.slice(end + CLOSE_TAG.length)
        continue
      }
      const start = this.pending.indexOf(OPEN_TAG)
      if (start < 0) {
        const text = this.pending.slice(0, this.pending.length - partialOpenTagLength(this.pending))
        this.pending = this.pending.slice(text.length)
        if (text) segments.push({ kind: 'text', text })
        return segments
      }
      if (start > 0) segments.push({ kind: 'text', text: this.pending.slice(0, start) })
      this.pending = this.pending.slice(start + OPEN_TAG.length)
      this.insideCall = true
    }
  }

  /** Ends the text. A call missing only its closing tag still counts. */
  flush(): TextToolCallSegment[] {
    const rest = this.pending
    this.pending = ''
    if (this.insideCall) return [this.closeCall(rest)]
    return rest ? [{ kind: 'text', text: rest }] : []
  }

  private closeCall(body: string): TextToolCallSegment {
    this.insideCall = false
    const call = parseTextToolCall(body, this.toolNames)
    return call ? { kind: 'call', call } : { kind: 'text', text: OPEN_TAG + body + CLOSE_TAG }
  }
}

function partialOpenTagLength(text: string): number {
  for (let length = Math.min(OPEN_TAG.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(OPEN_TAG.slice(0, length))) return length
  }
  return 0
}

function parseTextToolCall(body: string, toolNames: ReadonlySet<string>): TextToolCall | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { name, arguments: args, parameters } = parsed as Record<string, unknown>
  if (typeof name !== 'string' || !toolNames.has(name)) return null
  const input = args ?? parameters ?? {}
  return { toolName: name, input: typeof input === 'string' ? input : JSON.stringify(input) }
}

/** Replays a probed profile on the chat model. A native, auto profile changes nothing. */
export function toolCallProfileMiddleware(profile: ToolCallProfile): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) =>
      profile.toolChoice === 'omit' ? { ...params, toolChoice: undefined } : params,
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream()
      if (profile.toolCalls === 'native') return result
      const toolNames = new Set((params.tools ?? []).map((tool) => tool.name))
      return { ...result, stream: result.stream.pipeThrough(textToolCallTransform(toolNames)) }
    }
  }
}

function textToolCallTransform(
  toolNames: ReadonlySet<string>
): TransformStream<StreamPart, StreamPart> {
  const splitters = new Map<string, TextToolCallSplitter>()
  const calls: StreamPart[] = []
  let sawCall = false

  const emit = (
    controller: TransformStreamDefaultController<StreamPart>,
    id: string,
    segments: TextToolCallSegment[]
  ): void => {
    for (const segment of segments) {
      if (segment.kind === 'text') {
        controller.enqueue({ type: 'text-delta', id, delta: segment.text })
        continue
      }
      sawCall = true
      calls.push({ type: 'tool-call', toolCallId: randomUUID(), ...segment.call })
    }
  }

  return new TransformStream({
    transform(part, controller) {
      if (part.type === 'text-delta') {
        let splitter = splitters.get(part.id)
        if (!splitter) {
          splitter = new TextToolCallSplitter(toolNames)
          splitters.set(part.id, splitter)
        }
        emit(controller, part.id, splitter.push(part.delta))
        return
      }
      if (part.type === 'text-end') {
        emit(controller, part.id, splitters.get(part.id)?.flush() ?? [])
        splitters.delete(part.id)
        controller.enqueue(part)
        for (const call of calls.splice(0)) controller.enqueue(call)
        return
      }
      if (part.type === 'finish' && sawCall) {
        controller.enqueue({
          ...part,
          finishReason: { ...part.finishReason, unified: 'tool-calls' }
        })
        return
      }
      controller.enqueue(part)
    }
  })
}
