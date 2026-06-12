function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad
  return atob(base64)
}

export function extractJti(jwt: string): string {
  const parts = jwt.split('.')
  if (parts.length < 2) throw new Error('Malformed token')
  const payload = JSON.parse(base64UrlDecode(parts[1])) as { jti?: string }
  if (!payload.jti) throw new Error('Token missing jti claim')
  return payload.jti
}
