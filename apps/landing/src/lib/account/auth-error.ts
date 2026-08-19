import { trackLandingException } from '../analytics'

// Signing in needs a device keypair, and libsodium compiles a WebAssembly
// module to make one. When the browser refuses to compile it, emscripten throws
// its raw abort text — "Aborted(CompileError: …). Build with -sASSERTIONS for
// more info." — which is no answer for someone waiting to sign in.
const CRYPTO_UNAVAILABLE =
  'Secure sign-in could not start in this browser. Reload the page, or try a different browser.'

function isCryptoInitFailure(message: string): boolean {
  return message.includes('Aborted(') || message.includes('WebAssembly')
}

export function authErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (!message) return fallback
  if (!isCryptoInitFailure(message)) return message

  trackLandingException(error, 'auth:crypto-init')
  return CRYPTO_UNAVAILABLE
}
