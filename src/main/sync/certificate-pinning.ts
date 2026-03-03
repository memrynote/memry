import https from 'node:https'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { app } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('CertPin')

const PINNED_CERTIFICATE_HASHES: string[] = [
  'sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64',
  'sha256/PLACEHOLDER_BACKUP_CERT_HASH_BASE64'
]

export function hasPlaceholderHashes(pins: readonly string[] = PINNED_CERTIFICATE_HASHES): boolean {
  return pins.some((pin) => /PLACEHOLDER/i.test(pin))
}

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
      PINNED_CERTIFICATE_HASHES
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
  pins: string[] = PINNED_CERTIFICATE_HASHES
): boolean {
  const spkiHash = computeSpkiHash(cert)
  return pins.some((pin) => pin === spkiHash)
}

export function createPinnedAgent(pins: string[] = [...PINNED_CERTIFICATE_HASHES]): https.Agent {
  if (isPinningDisabled()) {
    log.debug('Certificate pinning disabled (dev/test mode)')
    return new https.Agent({ rejectUnauthorized: true })
  }

  if (hasPlaceholderHashes(pins)) {
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

      const spkiHash = computeSpkiHash(cert)
      if (!pins.some((pin) => pin === spkiHash)) {
        const err = new CertificatePinningError(
          `Certificate pin mismatch for ${hostname}`,
          spkiHash,
          pins
        )
        log.error('Certificate pin verification failed', {
          hostname,
          actualHash: spkiHash,
          pinnedCount: pins.length
        })
        return err
      }

      log.debug('Certificate pin verified', { hostname })
      return undefined
    }
  })
}

export function getPinnedCertificateHashes(): readonly string[] {
  if (!isPinningDisabled() && hasPlaceholderHashes()) {
    log.error(
      'CRITICAL: Certificate pinning active but hashes are placeholders — falling back to TLS-only'
    )
    return []
  }
  return PINNED_CERTIFICATE_HASHES
}
