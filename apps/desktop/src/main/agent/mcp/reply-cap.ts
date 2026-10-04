interface TruncatedReply {
  truncated: true
  totalBytes: number
  message: string
  partial: string
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncatedReply(text: string, totalBytes: number, end: number): TruncatedReply {
  const partial = text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? end - 1 : end)
  return {
    truncated: true,
    totalBytes,
    message:
      `Reply cut at ${utf8Bytes(partial)} of ${totalBytes} bytes. ` +
      'partial holds the start of the JSON reply and is not valid JSON on its own. ' +
      'The rest is not returned. Call an operation that returns less, such as a list with a ' +
      'smaller limit, or vault_read_note for a note body.',
    partial
  }
}

export function capReply(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value) ?? ''
  const totalBytes = utf8Bytes(text)
  if (totalBytes <= maxBytes) return value

  // `partial` is escaped again when the reply is serialized, so the cut point
  // shrinks until the whole serialized reply fits.
  let end = Math.min(text.length, maxBytes)
  let reply = truncatedReply(text, totalBytes, end)
  let replyBytes = utf8Bytes(JSON.stringify(reply))
  while (replyBytes > maxBytes) {
    end = Math.min(end - 1, Math.floor((end * maxBytes) / replyBytes))
    reply = truncatedReply(text, totalBytes, end)
    replyBytes = utf8Bytes(JSON.stringify(reply))
  }
  return reply
}
