/**
 * Text files attached to an Agent Chat prompt travel inside the user message
 * text, so they sync with the message and need no attachment kind:
 *
 *   ```memry-file name="app.log" bytes=2048
 *   <file text>
 *   ```
 *
 * Shipped format: older and newer builds share these messages. `name` is a JSON
 * string, `bytes` is the UTF-8 size of the file, the fence is longer than any
 * backtick run in the file, and one newline separates the text from the closing
 * fence. Builds without this parser show the plain fenced block.
 */

import { createLogger } from '@/lib/logger'

const log = createLogger('AgentChatFiles')

export interface PromptFile {
  name: string
  bytes: number
  text: string
}

export type UserTextSegment =
  { kind: 'text'; text: string } | { kind: 'file'; name: string; bytes: number; content: string }

export type PromptFileRefusal = 'unsupported_type' | 'not_text' | 'too_large' | 'read_failed'

export const PROMPT_FILES_MAX_BYTES = 100 * 1024
export const PROMPT_FILE_EXTENSIONS = [
  '.txt',
  '.md',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml'
] as const

const BLOCK_PATTERN =
  /^(`{3,})memry-file name=("(?:[^"\\\n]|\\.)*") bytes=(\d+)\n([\s\S]*?)\n\1(?!`)[ \t]*$/gm

function formatMemryFileBlock(file: PromptFile): string {
  const longestRun = Math.max(0, ...(file.text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}memry-file name=${JSON.stringify(file.name)} bytes=${file.bytes}\n${file.text}\n${fence}`
}

export function appendMemryFileBlocks(text: string, files: PromptFile[]): string {
  return [text, ...files.map(formatMemryFileBlock)].join('\n\n')
}

export function splitMemryFileBlocks(text: string): UserTextSegment[] {
  const segments: UserTextSegment[] = []
  const pushText = (slice: string): void => {
    const trimmed = slice.replace(/^\n+|\n+$/g, '')
    if (trimmed) segments.push({ kind: 'text', text: trimmed })
  }
  let cursor = 0
  for (const match of text.matchAll(BLOCK_PATTERN)) {
    let name: unknown
    try {
      name = JSON.parse(match[2])
    } catch {
      continue
    }
    if (typeof name !== 'string') continue
    pushText(text.slice(cursor, match.index))
    segments.push({ kind: 'file', name, bytes: Number(match[3]), content: match[4] })
    cursor = match.index + match[0].length
  }
  pushText(text.slice(cursor))
  return segments
}

// FileReader rather than `file.arrayBuffer()`: jsdom's File has no arrayBuffer.
function readBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error('FileReader failed', { cause: reader.error }))
    reader.readAsArrayBuffer(file)
  })
}

export async function readPromptFile(
  file: File,
  usedBytes: number
): Promise<{ ok: true; file: PromptFile } | { ok: false; reason: PromptFileRefusal }> {
  const name = file.name.toLowerCase()
  if (!PROMPT_FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return { ok: false, reason: 'unsupported_type' }
  }
  if (usedBytes + file.size > PROMPT_FILES_MAX_BYTES) return { ok: false, reason: 'too_large' }
  let bytes: ArrayBuffer
  try {
    bytes = await readBytes(file)
  } catch (error) {
    log.error('Failed to read attached file', { name: file.name, bytes: file.size }, error)
    return { ok: false, reason: 'read_failed' }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    return { ok: false, reason: 'not_text' }
  }
  if (text.includes('\u0000')) return { ok: false, reason: 'not_text' }
  return { ok: true, file: { name: file.name, bytes: file.size, text } }
}
