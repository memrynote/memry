/** An MCP image content part: base64 bytes and their MIME type. */
export interface ToolImage {
  data: string
  mimeType: string
}

/**
 * What a tool handler returns to send an image the model can look at. The
 * server sends `reply` as the usual JSON text part, then the image part.
 */
export class ImageToolResult {
  constructor(
    readonly reply: Record<string, unknown>,
    readonly image: ToolImage
  ) {}
}

function isImagePart(value: Record<string, unknown>): boolean {
  return value.type === 'image' && typeof value.data === 'string'
}

/**
 * The result with the base64 of every `{ type: 'image', data }` part dropped.
 * Tool results go to the renderer, which shows the call and has no use for
 * megabytes of image bytes. Returns `value` itself when it holds no image.
 */
export function withoutImageBytes(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(withoutImageBytes)
    return items.every((item, index) => item === value[index]) ? value : items
  }
  if (typeof value !== 'object' || value === null) return value

  const record = value as Record<string, unknown>
  if (isImagePart(record)) {
    return { type: 'image', mimeType: record.mimeType, dataOmitted: true }
  }
  let changed = false
  const entries = Object.entries(record).map(([key, entry]) => {
    const next = withoutImageBytes(entry)
    if (next !== entry) changed = true
    return [key, next] as const
  })
  return changed ? Object.fromEntries(entries) : value
}
