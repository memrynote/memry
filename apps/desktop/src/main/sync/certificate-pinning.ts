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

export { hasPlaceholderHashes } from './certificate-pins'

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
    throw new CertificatePinningError(
      'Certificate missing raw DER data',
      '',
      [...getConfiguredPinnedCertificateHashes()]
    )
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
    log.error(
      'CRITICAL: Certificate pinning active but hashes are placeholders — using TLS-only agent'
    )
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

export function getPinnedCertificateHashes(): readonly string[] {
  const pins = [...getConfiguredPinnedCertificateHashes()]
  if (!isPinningDisabled() && hasPlaceholderHashes(pins)) {
    log.error(
      'CRITICAL: Certificate pinning active but hashes are placeholders — falling back to TLS-only'
    )
    return []
  }
  return pins
}
