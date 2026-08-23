import https from 'node:https'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { app } from 'electron'
import { createLogger } from '../lib/logger'
import {
  getConfiguredPinnedCertificateHashes,
  getPinnedCertificateHashesForHostname,
  hasPlaceholderHashes
} from '@memry/sync-client/certificate-pins'

export { getPinnedCertificateHashesForHostname, hasPlaceholderHashes } from '@memry/sync-client/certificate-pins'

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

/**
 * A host with no entry in the pin table and a host whose entry is still
 * placeholders are the same state — pinning was never activated for it — and
 * get the same outcome: standard TLS. `rejectUnauthorized: true` still enforces
 * the full CA chain and `tls.checkServerIdentity` still enforces the hostname,
 * so nothing is skipped; only the extra SPKI pin is absent.
 *
 * The two used to differ, because `hasPlaceholderHashes([])` is false: a host
 * with no entry built a pinning agent whose pin list could only ever be empty,
 * so it rejected *every* certificate for that host, the legitimate one
 * included. With no reference hash there is nothing to compare against, so that
 * branch could not tell an attacker's certificate from the real server's — it
 * was an unconditional outage, not a pin check. The session-level verify proc
 * (`configureCertificatePinning`, src/main/index.ts) has always passed unpinned
 * hosts straight through to Chromium's own verification; this matches it.
 *
 * Unlike placeholders — the deliberate shipping state, logged once at debug per
 * #846 — a host with no entry at all is a configuration mistake, so it logs at
 * warn. One slot rather than a set: this agent dials the single configured sync
 * host, so the target hostname changing is itself worth a line.
 */
let warnedUnpinnedHostname: string | null = null

function warnHostnameUnpinnedOnce(hostname: string): void {
  if (warnedUnpinnedHostname === hostname) return
  warnedUnpinnedHostname = hostname
  log.warn('No certificate pins configured for host — using standard TLS', { hostname })
}

/**
 * Pins are resolved once, at handshake time, for the hostname TLS is actually
 * dialing.
 *
 * The decision used to be split across two independent lookups: whether to pin
 * at all came from the *configured* host (`SYNC_SERVER_URL`, falling back to
 * `sync.memrynote.com`), while `checkServerIdentity` verified against the
 * *connecting* hostname's pins. Nothing enforced that those were the same host
 * — the WebSocket manager's `serverUrl` is an injected dep, not a call into
 * this module — and the two fallbacks already disagreed (`resolveSyncServerUrl`
 * falls back to localhost or throws). Any divergence failed silently in one
 * direction: the branch sees a placeholder-pinned host, hands back a plain TLS
 * agent, and pinning is skipped for a host that has real pins. One lookup, one
 * hostname, nothing left to diverge.
 */
export function createPinnedAgent(pins?: string[]): https.Agent {
  if (isPinningDisabled()) {
    log.debug('Certificate pinning disabled (dev/test mode)')
    return new https.Agent({ rejectUnauthorized: true })
  }

  return new https.Agent({
    rejectUnauthorized: true,
    checkServerIdentity: (hostname: string, cert: tls.PeerCertificate) => {
      const tlsCheckResult = tls.checkServerIdentity(hostname, cert)
      if (tlsCheckResult) return tlsCheckResult

      const effectivePins = pins ? [...pins] : [...getPinnedCertificateHashesForHostname(hostname)]

      if (hasPlaceholderHashes(effectivePins)) {
        warnPinningUnconfiguredOnce()
        return undefined
      }

      if (effectivePins.length === 0) {
        warnHostnameUnpinnedOnce(hostname)
        return undefined
      }

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
 * restart, no cache flush. `isPinningDisabled()` is now the only decision
 * `createPinnedAgent` freezes into the instance, so it is the whole cache key:
 * if it flips, the cached agent is destroyed and rebuilt rather than silently
 * reused under the old decision. The configured host's pins used to be part of
 * this key because they gated a construction-time branch; that branch moved
 * into `checkServerIdentity` (see above), so keying on them would now only
 * rebuild an agent that already reads the live table.
 */
let sharedPinnedAgent: { key: string; agent: https.Agent } | null = null

function pinnedAgentCacheKey(): string {
  return isPinningDisabled() ? 'disabled' : 'enabled'
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
