import https from 'node:https'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { app } from 'electron'
import { createLogger } from '../lib/logger'
import {
  getConfiguredPinnedCertificateHashes,
  getPinnedCertificateHashesForHostname,
  hasPlaceholderHashes
} from './certificate-pins'

export { getPinnedCertificateHashesForHostname, hasPlaceholderHashes } from './certificate-pins'

const log = createLogger('CertPin')

export class CertificatePinningError extends Error {
  constructor(
    message: string,
    public readonly actualHash: string,
    public readonly expectedHashes: string[]
  ) {
    super(message)
    this.name = 'CertificatePinningError'
  }
}

// Placeholder pins mean pinning was never activated for this host; TLS-only
// is the deliberate fallback, not a runtime failure. Log once per process at
// debug: at warn this fired on every startup and was the single largest group
// in the production log stream (#846), with nothing actionable for the user.
let warnedPinningUnconfigured = false

export function warnPinningUnconfiguredOnce(): void {
  if (warnedPinningUnconfigured) return
  warnedPinningUnconfigured = true
  log.debug(
    'Certificate pinning not configured — using standard TLS. Run `pnpm cert:extract -- <hostname>` and update certificate-pins.ts to enable pinning.'
  )
}

export function isPinningDisabled(): boolean {
  try {
    if (app.isPackaged) return false
    return true
  } catch {
    return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
  }
}

export function computeSpkiHash(cert: tls.PeerCertificate): string {
  if (!cert.raw || cert.raw.length === 0) {
    throw new CertificatePinningError('Certificate missing raw DER data', '', [
      ...getConfiguredPinnedCertificateHashes()
    ])
  }
  const x509 = new crypto.X509Certificate(cert.raw)
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
  const hash = crypto.createHash('sha256').update(spkiDer).digest('base64')
  return `sha256/${hash}`
}

export function computeSpkiHashFromPem(pemData: string): string {
  const x509 = new crypto.X509Certificate(pemData)
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
  const hash = crypto.createHash('sha256').update(spkiDer).digest('base64')
  return `sha256/${hash}`
}

export function verifyCertificatePin(
  cert: tls.PeerCertificate,
  pins: string[] = [...getConfiguredPinnedCertificateHashes()]
): boolean {
  const spkiHash = computeSpkiHash(cert)
  return pins.some((pin) => pin === spkiHash)
}

export function createPinnedAgent(pins?: string[]): https.Agent {
  if (isPinningDisabled()) {
    log.debug('Certificate pinning disabled (dev/test mode)')
    return new https.Agent({ rejectUnauthorized: true })
  }

  const configuredPins = pins ? [...pins] : [...getConfiguredPinnedCertificateHashes()]

  if (hasPlaceholderHashes(configuredPins)) {
    warnPinningUnconfiguredOnce()
    return new https.Agent({ rejectUnauthorized: true })
  }

  return new https.Agent({
    rejectUnauthorized: true,
    checkServerIdentity: (hostname: string, cert: tls.PeerCertificate) => {
      const tlsCheckResult = tls.checkServerIdentity(hostname, cert)
      if (tlsCheckResult) return tlsCheckResult

      const effectivePins = pins ? [...pins] : [...getPinnedCertificateHashesForHostname(hostname)]
      const spkiHash = computeSpkiHash(cert)
      if (!effectivePins.some((pin) => pin === spkiHash)) {
        const err = new CertificatePinningError(
          `Certificate pin mismatch for ${hostname}`,
          spkiHash,
          effectivePins
        )
        log.error('Certificate pin verification failed', {
          hostname,
          actualHash: spkiHash,
          pinnedCount: effectivePins.length
        })
        return err
      }

      log.debug('Certificate pin verified', { hostname })
      return undefined
    }
  })
}

/**
 * The WebSocket manager built a fresh agent on every reconnect. An https.Agent
 * created here has `keepAlive` off and the `ws` upgrade detaches its socket
 * (`agentRemove`), so the agent owns nothing between connects — the object was
 * the only thing being reallocated.
 *
 * Reuse does NOT weaken the pin. The check lives in `checkServerIdentity`,
 * which resolves the connecting hostname's pins from `certificate-pins.ts` on
 * every TLS handshake, so a reused agent verifies exactly what a fresh one
 * would and an updated pin table takes effect on the very next handshake — no
 * restart, no cache flush. Only the two branches `createPinnedAgent` decides at
 * construction time are frozen into the instance: whether pinning is disabled
 * (dev/test) and whether the configured host still carries placeholder pins.
 * Those two form the cache key below, so if either flips, the cached agent is
 * destroyed and rebuilt rather than silently reused under the old decision.
 */
let sharedPinnedAgent: { key: string; agent: https.Agent } | null = null

function pinnedAgentCacheKey(): string {
  const disabled = isPinningDisabled() ? 'disabled' : 'enabled'
  return `${disabled}|${getConfiguredPinnedCertificateHashes().join(',')}`
}

export function getSharedPinnedAgent(): https.Agent {
  const key = pinnedAgentCacheKey()
  if (sharedPinnedAgent && sharedPinnedAgent.key === key) return sharedPinnedAgent.agent
  sharedPinnedAgent?.agent.destroy()
  sharedPinnedAgent = { key, agent: createPinnedAgent() }
  return sharedPinnedAgent.agent
}

/** Drop the shared agent (tests; and any future explicit pin reload). */
export function resetSharedPinnedAgent(): void {
  sharedPinnedAgent?.agent.destroy()
  sharedPinnedAgent = null
}

export function getPinnedCertificateHashes(): readonly string[] {
  const pins = [...getConfiguredPinnedCertificateHashes()]
  if (!isPinningDisabled() && hasPlaceholderHashes(pins)) {
    warnPinningUnconfiguredOnce()
    return []
  }
  return pins
}
