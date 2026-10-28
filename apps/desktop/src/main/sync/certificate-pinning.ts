import https from 'node:https'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { app, type Certificate } from 'electron'
import { createLogger } from '../lib/logger'
import {
  getConfiguredPinnedCertificateHashes,
  getPinnedCertificateHashesForHostname,
  hasPlaceholderHashes
} from '@memry/sync-client/certificate-pins'

export {
  getPinnedCertificateHashesForHostname,
  hasPlaceholderHashes
} from '@memry/sync-client/certificate-pins'

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

function spkiHashOf(x509: crypto.X509Certificate): string {
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
  return `sha256/${crypto.createHash('sha256').update(spkiDer).digest('base64')}`
}

export function computeSpkiHash(cert: tls.PeerCertificate): string {
  if (!cert.raw || cert.raw.length === 0) {
    throw new CertificatePinningError('Certificate missing raw DER data', '', [
      ...getConfiguredPinnedCertificateHashes()
    ])
  }
  return spkiHashOf(new crypto.X509Certificate(cert.raw))
}

export function computeSpkiHashFromPem(pemData: string): string {
  return spkiHashOf(new crypto.X509Certificate(pemData))
}

// Real sync chains hold three certificates. A longer one is malformed or hostile.
const MAX_CHAIN_DEPTH = 8

/**
 * A pin matches the SPKI of any certificate on the path from the leaf up, so a
 * pin on the issuing intermediate or root survives leaf renewals (a leaf pin
 * broke at every renewal: the staging leaf renewed on 2026-10-13 and every
 * packaged build pointed at staging refused it).
 *
 * `pool` holds the certificates the peer or Chromium handed over, leaf first.
 * Their links and order are not trusted: a peer holding any publicly trusted
 * certificate for the host could append a fake parent that carries a pinned
 * SPKI. So the path is built from the leaf upward, and a certificate counts only
 * when the one below it passes `checkIssued` and is signed by its key.
 */
function isChainPinned(pool: readonly crypto.X509Certificate[], pins: readonly string[]): boolean {
  let current: crypto.X509Certificate | undefined = pool[0]
  for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth++) {
    if (pins.includes(spkiHashOf(current))) return true
    const child: crypto.X509Certificate = current
    current = pool.find(
      (parent) =>
        !parent.raw.equals(child.raw) && child.checkIssued(parent) && child.verify(parent.publicKey)
    )
  }
  return false
}

function nodePeerChain(
  leaf: tls.PeerCertificate | tls.DetailedPeerCertificate
): crypto.X509Certificate[] {
  const chain: crypto.X509Certificate[] = []
  let current: tls.PeerCertificate | tls.DetailedPeerCertificate | undefined = leaf
  while (current?.raw?.length && chain.length < MAX_CHAIN_DEPTH) {
    chain.push(new crypto.X509Certificate(current.raw))
    const next: tls.DetailedPeerCertificate | undefined =
      'issuerCertificate' in current ? current.issuerCertificate : undefined
    if (!next || next === current || next.raw?.equals(current.raw)) break
    current = next
  }
  return chain
}

function electronChain(leaf: Certificate | undefined): crypto.X509Certificate[] {
  const chain: crypto.X509Certificate[] = []
  let current: Certificate | undefined = leaf
  while (current?.data && chain.length < MAX_CHAIN_DEPTH) {
    chain.push(new crypto.X509Certificate(current.data))
    const next: Certificate | undefined = current.issuerCert
    if (!next || next === current) break
    current = next
  }
  return chain
}

/** The two chains Chromium reports for one connection to the session verifier. */
export interface SessionCertificates {
  /** The chain as the server sent it. */
  certificate: Certificate
  /** The chain Chromium verified. The platform verifier may leave the trust anchor out. */
  validatedCertificate?: Certificate
}

/**
 * Both chains feed one pool. `validatedCertificate` is the chain Chromium built
 * to a trusted root, so the issuing intermediate is there whatever order or
 * extras the server sends. It does not always carry the root: on macOS it holds
 * the leaf and WE1 only, so a pin on GTS Root R4 matches only while the server
 * still sends the R4 cross-certificate (valid to 2028-01-28). The WE1 pin does not
 * depend on that.
 */
function sessionPool({ certificate, validatedCertificate }: SessionCertificates) {
  const byRaw = new Map<string, crypto.X509Certificate>()
  for (const cert of [...electronChain(validatedCertificate), ...electronChain(certificate)]) {
    byRaw.set(cert.raw.toString('base64'), cert)
  }
  return [...byRaw.values()]
}

export function verifyCertificatePin(
  cert: tls.PeerCertificate,
  pins: string[] = [...getConfiguredPinnedCertificateHashes()]
): boolean {
  return isChainPinned(nodePeerChain(cert), pins)
}

/** The session verifier's counterpart to `verifyCertificatePin`. */
export function verifySessionCertificatePin(
  certs: SessionCertificates,
  pins: readonly string[]
): boolean {
  return isChainPinned(sessionPool(certs), pins)
}

/** SPKI hash of every certificate the peer or Chromium reported, for mismatch logs. */
export function peerChainHashes(cert: tls.PeerCertificate): string[] {
  return nodePeerChain(cert).map(spkiHashOf)
}

export function sessionChainHashes(certs: SessionCertificates): string[] {
  return sessionPool(certs).map(spkiHashOf)
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
      if (!verifyCertificatePin(cert, effectivePins)) {
        const err = new CertificatePinningError(
          `Certificate pin mismatch for ${hostname}`,
          spkiHash,
          effectivePins
        )
        log.error('Certificate pin verification failed', {
          hostname,
          actualHash: spkiHash,
          chainHashes: peerChainHashes(cert),
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
  if (sharedPinnedAgent?.key === key) return sharedPinnedAgent.agent
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
