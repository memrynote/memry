function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad
  return atob(base64)
}

export function extractJti(jwt: string): string {
  const parts = jwt.split('.')
  if (parts.length < 2) throw new Error('Malformed token')
  const payload: unknown = JSON.parse(base64UrlDecode(parts[1]))
  const jti =
    typeof payload === 'object' && payload !== null && 'jti' in payload ? payload.jti : null
  if (typeof jti !== 'string' || !jti) throw new Error('Token missing jti claim')
  return jti
}
