// Parse a base64 data URL ("data:<mime>;base64,<payload>") into its MIME type
// and decoded bytes. Returns null for anything that is not a non-empty base64
// data URL (callers fall through to leaving the capture image-less).
export function parseDataUrl(input: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(input.trim())
  if (!match) return null
  const mime = match[1].toLowerCase()
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0) return null
  return { mime, buffer }
}
