/** How big a tool's reply may get, and what a cut reply tells the agent to call instead. */
export interface ReplyCap {
  maxBytes: number
  advice: (input: unknown) => string
}

interface TruncatedReply {
  truncated: true
  totalBytes: number
  message: string
  partial: string
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncatedReply(
  text: string,
  totalBytes: number,
  end: number,
  advice: string
): TruncatedReply {
  const partial = text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? end - 1 : end)
  return {
    truncated: true,
    totalBytes,
    message:
      `Reply cut at ${utf8Bytes(partial)} of ${totalBytes} bytes. ` +
      'partial holds the start of the JSON reply and is not valid JSON on its own. ' +
      `The rest is not returned. ${advice}`,
    partial
  }
}

export function capReply(value: unknown, cap: ReplyCap, input: unknown): unknown {
  const { maxBytes } = cap
  const text = JSON.stringify(value) ?? ''
  const totalBytes = utf8Bytes(text)
  if (totalBytes <= maxBytes) return value

  const advice = cap.advice(input)

  // `partial` is escaped again when the reply is serialized, so the cut point
  // shrinks until the whole serialized reply fits.
  let end = Math.min(text.length, maxBytes)
  let reply = truncatedReply(text, totalBytes, end, advice)
  let replyBytes = utf8Bytes(JSON.stringify(reply))
  while (replyBytes > maxBytes) {
    end = Math.min(end - 1, Math.floor((end * maxBytes) / replyBytes))
    reply = truncatedReply(text, totalBytes, end, advice)
    replyBytes = utf8Bytes(JSON.stringify(reply))
  }
  return reply
}
