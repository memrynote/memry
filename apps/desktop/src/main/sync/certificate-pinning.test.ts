import { describe, it, expect, vi, beforeEach } from 'vitest'
import type tls from 'node:tls'
import { DEFAULT_SYNC_CERT_HOSTNAME, PINNED_CERTIFICATE_HASHES_BY_HOST } from './certificate-pins'

const mockApp = vi.hoisted(() => ({ isPackaged: false }))

vi.mock('electron', () => ({
  app: mockApp
}))

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mockLog
}))

import {
  computeSpkiHash,
  computeSpkiHashFromPem,
  verifyCertificatePin,
  createPinnedAgent,
  getSharedPinnedAgent,
  resetSharedPinnedAgent,
  CertificatePinningError,
  getPinnedCertificateHashes,
  isPinningDisabled,
  hasPlaceholderHashes
} from './certificate-pinning'

function makeMockCertWithRaw(raw: Buffer): tls.PeerCertificate {
  return {
    raw,
    subject: {} as tls.Certificate,
    issuer: {} as tls.Certificate,
    subjectaltname: '',
    infoAccess: {},
    modulus: '',
    exponent: '',
    valid_from: '',
    valid_to: '',
    fingerprint: '',
    fingerprint256: '',
    fingerprint512: '',
    ext_key_usage: [],
    serialNumber: '',
    pubkey: Buffer.alloc(0)
  } as tls.PeerCertificate
}

// Pre-generated self-signed RSA certificate for testing
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIC/zCCAeegAwIBAgIUc5LW+ctIeXFvGviuyhHmP5SPVvswDQYJKoZIhvcNAQEL
BQAwDzENMAsGA1UEAwwEdGVzdDAeFw0yNjAyMjgwMzA5MDlaFw0zNjAyMjYwMzA5
MDlaMA8xDTALBgNVBAMMBHRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQCb/QQgRLt8FpkwAbgBE5TX9bkgnQk91HTZ+KWf29EpzGN7/97gulLtNtpP
LxAC1K/l1dhDP9u98B11Px7/iGOC2ENQxlcgebb5rIWdxJRovUW6DyM2X7RVzqpg
7XKOItEJZ4K23/AjO60FyGfBiUAxi5e2x9hGMStUKLJPILhC5McL/JL5R8i6wAa6
3uwv2VRBFwDS2nOv5gglV8pWtzJDdUhubHpD4gP4Qgi4SZ/ijO32YltL56whrT8r
+WPN090pPEdzecRDOuVH2Dd/dnDWEE6cbJQTVBNWlpnQvJlvQtQpt0El8QmRatpm
3m9G1/VodQLuWxa/Z/8kUSiVTH3DAgMBAAGjUzBRMB0GA1UdDgQWBBTrudwN5su3
CGjlHMD1PxoRrbQAAjAfBgNVHSMEGDAWgBTrudwN5su3CGjlHMD1PxoRrbQAAjAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAcSNtFdUJwbvDfZpFk
K+T2mi0K7OmMR8Ci5SXUKqv39wa+7ooXjGtclfKfqTfCyF7Df9GzV4jVRjKOAJSu
L7G3upijp94rfazBoLY/V8CN8ZUiJgHSjipso6e1rE77C7MQ2x9XMMNLYif5qLLJ
OocT79NTjzf6Qh5kFjuwWN5Zqj98LQnQQo6LCbMHCpjQick11Z0Dq7a74EmPpyGC
Ddc0e6Mi6xgPQLOc3NbC1jPTxvzkE3u74Ie6mbZ8oygkZyvKfN86y7rESif5ULaH
FC8ikmdtt3CeDG6B7t0cgutqr+1y1wQgVA/JXBf/anQ8n9W6pAGvfnIM4xybcmfg
E03i
-----END CERTIFICATE-----`

function getTestCertDer(): Buffer {
  const base64 = TEST_CERT_PEM.replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '')
  return Buffer.from(base64, 'base64')
}

describe('certificate-pinning', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    mockApp.isPackaged = false
  })

  describe('computeSpkiHash', () => {
    it('#given valid cert with raw DER #then returns sha256 hash', () => {
      // #given
      const cert = makeMockCertWithRaw(getTestCertDer())

      // #when
      const hash = computeSpkiHash(cert)

      // #then
      expect(hash).toMatch(/^sha256\/[A-Za-z0-9+/]+=*$/)
    })

    it('#given cert with empty raw #then throws CertificatePinningError', () => {
      // #given
      const cert = makeMockCertWithRaw(Buffer.alloc(0))

      // #when / #then
      expect(() => computeSpkiHash(cert)).toThrow(CertificatePinningError)
    })

    it('#given cert with no raw field #then throws CertificatePinningError', () => {
      // #given
      const cert = { subject: {} } as tls.PeerCertificate

      // #when / #then
      expect(() => computeSpkiHash(cert)).toThrow('Certificate missing raw DER data')
    })

    it('#given same cert twice #then produces identical hashes', () => {
      // #given
      const raw = getTestCertDer()
      const cert1 = makeMockCertWithRaw(raw)
      const cert2 = makeMockCertWithRaw(Buffer.from(raw))

      // #when
      const hash1 = computeSpkiHash(cert1)
      const hash2 = computeSpkiHash(cert2)

      // #then
      expect(hash1).toBe(hash2)
    })
  })

  describe('computeSpkiHashFromPem', () => {
    it('#given valid PEM cert #then returns sha256 hash', () => {
      // #when
      const hash = computeSpkiHashFromPem(TEST_CERT_PEM)

      // #then
      expect(hash).toMatch(/^sha256\/[A-Za-z0-9+/]+=*$/)
    })

    it('#given same cert as DER and PEM #then produces identical hashes', () => {
      // #when
      const pemHash = computeSpkiHashFromPem(TEST_CERT_PEM)
      const derHash = computeSpkiHash(makeMockCertWithRaw(getTestCertDer()))

      // #then
      expect(pemHash).toBe(derHash)
    })
  })

  describe('isPinningDisabled', () => {
    it('#given packaged app #then returns false', () => {
      // #given
      mockApp.isPackaged = true

      // #then
      expect(isPinningDisabled()).toBe(false)
    })

    it('#given unpackaged app #then returns true', () => {
      // #given
      mockApp.isPackaged = false

      // #then
      expect(isPinningDisabled()).toBe(true)
    })

    it('#given packaged app with env var set #then still returns false', () => {
      // #given
      mockApp.isPackaged = true
      vi.stubEnv('MEMRY_DISABLE_CERT_PIN', '1')

      // #then
      expect(isPinningDisabled()).toBe(false)
    })
  })

  describe('verifyCertificatePin', () => {
    it('#given cert matching one of the pins #then returns true', () => {
      // #given
      const cert = makeMockCertWithRaw(getTestCertDer())
      const hash = computeSpkiHash(cert)

      // #when
      const result = verifyCertificatePin(cert, [hash, 'sha256/otherpin'])

      // #then
      expect(result).toBe(true)
    })

    it('#given cert not matching any pin #then returns false', () => {
      // #given
      const cert = makeMockCertWithRaw(getTestCertDer())

      // #when
      const result = verifyCertificatePin(cert, ['sha256/wrongpin1', 'sha256/wrongpin2'])

      // #then
      expect(result).toBe(false)
    })

    it('#given empty pins array #then returns false', () => {
      // #given
      const cert = makeMockCertWithRaw(getTestCertDer())

      // #when
      const result = verifyCertificatePin(cert, [])

      // #then
      expect(result).toBe(false)
    })
  })

  describe('hasPlaceholderHashes', () => {
    it('#given default placeholder hashes #then returns true', () => {
      expect(hasPlaceholderHashes()).toBe(true)
    })

    it('#given real hashes #then returns false', () => {
      const pins = ['sha256/abc123def456=', 'sha256/xyz789ghi012=']
      expect(hasPlaceholderHashes(pins)).toBe(false)
    })

    it('#given mixed real and placeholder #then returns true', () => {
      const pins = ['sha256/abc123def456=', 'sha256/PLACEHOLDER_BACKUP']
      expect(hasPlaceholderHashes(pins)).toBe(true)
    })

    it('#given empty array #then returns false', () => {
      expect(hasPlaceholderHashes([])).toBe(false)
    })
  })

  describe('createPinnedAgent', () => {
    const STAGING_HOST = 'sync-staging.memrynote.com'

    /** A cert whose SAN covers `hostname`, so the stock TLS identity check
     *  passes and the pin check is what decides the outcome. */
    function certFor(hostname: string): tls.PeerCertificate {
      return {
        ...makeMockCertWithRaw(getTestCertDer()),
        subjectaltname: `DNS:${hostname}`
      } as tls.PeerCertificate
    }

    function checkOf(agent: ReturnType<typeof createPinnedAgent>) {
      const check = agent.options.checkServerIdentity
      expect(check).toBeDefined()
      return check!
    }

    it('#given dev mode (app.isPackaged=false) #then returns agent without pin checking', () => {
      // #when
      const agent = createPinnedAgent()

      // #then
      expect(agent).toBeDefined()
      expect(agent.options.rejectUnauthorized).not.toBe(false)
      expect(agent.options.checkServerIdentity).toBeUndefined()
    })

    it('#given packaged mode #then returns agent with checkServerIdentity', () => {
      // #given
      mockApp.isPackaged = true

      // #when
      const agent = createPinnedAgent(['sha256/testpin'])

      // #then
      expect(agent).toBeDefined()
      expect(agent.options.checkServerIdentity).toBeDefined()
    })

    it('#given the connecting host has real pins and the cert does not match #then rejects', () => {
      // #given a packaged build dialing a host with real (non-placeholder) pins
      vi.stubEnv('SYNC_SERVER_URL', `https://${STAGING_HOST}`)
      mockApp.isPackaged = true

      // #when a certificate arrives whose SPKI hash is not in the table
      const result = checkOf(createPinnedAgent())(STAGING_HOST, certFor(STAGING_HOST))

      // #then it is rejected — pinning still enforces
      expect(result).toBeInstanceOf(CertificatePinningError)
    })

    it('#given the connecting host has real pins and the cert matches #then accepts', () => {
      // #given
      vi.stubEnv('SYNC_SERVER_URL', `https://${STAGING_HOST}`)
      mockApp.isPackaged = true
      const originalPins = PINNED_CERTIFICATE_HASHES_BY_HOST[STAGING_HOST]

      try {
        PINNED_CERTIFICATE_HASHES_BY_HOST[STAGING_HOST] = [computeSpkiHashFromPem(TEST_CERT_PEM)]

        // #when / #then
        expect(checkOf(createPinnedAgent())(STAGING_HOST, certFor(STAGING_HOST))).toBeUndefined()
      } finally {
        PINNED_CERTIFICATE_HASHES_BY_HOST[STAGING_HOST] = originalPins
      }
    })

    it('#given the configured host is placeholder-pinned but the connecting host has real pins #then the connecting host still enforces', () => {
      // #given SYNC_SERVER_URL naming the shipping host, whose entry is still
      // placeholders — the branch that used to decide "do not pin at all"
      vi.stubEnv('SYNC_SERVER_URL', `https://${DEFAULT_SYNC_CERT_HOSTNAME}`)
      mockApp.isPackaged = true

      // #when the handshake is against a *different* host that does have pins
      const result = checkOf(createPinnedAgent())(STAGING_HOST, certFor(STAGING_HOST))

      // #then the connecting host's pins decide, so a non-matching cert is
      // rejected instead of silently accepted under the configured host's
      // placeholder verdict
      expect(result).toBeInstanceOf(CertificatePinningError)
    })

    it('#given the connecting host still has placeholder pins #then standard TLS applies', () => {
      // #given the shipping configuration: pinning never activated for this host
      vi.stubEnv('SYNC_SERVER_URL', `https://${DEFAULT_SYNC_CERT_HOSTNAME}`)
      mockApp.isPackaged = true

      // #when / #then — unchanged behaviour for the host we actually ship
      expect(
        checkOf(createPinnedAgent())(
          DEFAULT_SYNC_CERT_HOSTNAME,
          certFor(DEFAULT_SYNC_CERT_HOSTNAME)
        )
      ).toBeUndefined()
    })

    it('#given explicit placeholder pins #then standard TLS applies', () => {
      // #given
      mockApp.isPackaged = true

      // #when / #then
      expect(
        checkOf(createPinnedAgent(['sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64']))(
          STAGING_HOST,
          certFor(STAGING_HOST)
        )
      ).toBeUndefined()
    })

    it('#given the connecting host has no pin entry #then falls back to standard TLS and warns once', () => {
      // #given a pinning agent built for a host that does have pins...
      vi.stubEnv('SYNC_SERVER_URL', `https://${STAGING_HOST}`)
      mockApp.isPackaged = true
      const unpinnedHost = 'sync-unlisted.memrynote.test'
      mockLog.warn.mockClear()

      // #when the handshake is against a host with no entry at all
      const check = checkOf(createPinnedAgent())
      const first = check(unpinnedHost, certFor(unpinnedHost))
      const second = check(unpinnedHost, certFor(unpinnedHost))

      // #then it is not rejected — an empty pin list has no reference hash to
      // compare against, so rejecting would kill the legitimate cert too
      expect(first).toBeUndefined()
      expect(second).toBeUndefined()
      expect(mockLog.warn).toHaveBeenCalledTimes(1)
      expect(mockLog.warn).toHaveBeenCalledWith(expect.any(String), { hostname: unpinnedHost })
    })

    it('#given a cert whose SAN does not cover the connecting host #then the stock TLS identity check still rejects', () => {
      // #given
      vi.stubEnv('SYNC_SERVER_URL', `https://${STAGING_HOST}`)
      mockApp.isPackaged = true

      // #when the cert is for a different host entirely
      const result = checkOf(createPinnedAgent())(STAGING_HOST, certFor('evil.example.com'))

      // #then hostname verification rejects before the pin check is reached
      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(CertificatePinningError)
    })
  })

  describe('getSharedPinnedAgent', () => {
    const STAGING_HOST = 'sync-staging.memrynote.com'

    beforeEach(() => {
      resetSharedPinnedAgent()
    })

    it('#given repeated connects #then hands back the same agent instance', () => {
      // #when — what a WebSocket reconnect loop does
      const first = getSharedPinnedAgent()
      const second = getSharedPinnedAgent()
      const third = getSharedPinnedAgent()

      // #then
      expect(second).toBe(first)
      expect(third).toBe(first)
    })

    it('#given the pinning decision flips #then rebuilds and destroys the stale agent', () => {
      // #given a dev-mode (pinning disabled) agent
      const devAgent = getSharedPinnedAgent()
      const destroySpy = vi.spyOn(devAgent, 'destroy')

      // #when the construction-time decision changes
      mockApp.isPackaged = true
      const packagedAgent = getSharedPinnedAgent()

      // #then the cached instance is not reused under the new decision
      expect(packagedAgent).not.toBe(devAgent)
      expect(destroySpy).toHaveBeenCalled()
    })

    it('#given a pinned host #then an updated pin table applies to the already-shared agent', () => {
      // #given a packaged build pinned to a host with real (non-placeholder) pins
      vi.stubEnv('SYNC_SERVER_URL', `https://${STAGING_HOST}`)
      mockApp.isPackaged = true
      const originalPins = PINNED_CERTIFICATE_HASHES_BY_HOST[STAGING_HOST]

      try {
        const agent = getSharedPinnedAgent()
        const checkServerIdentity = agent.options.checkServerIdentity
        expect(checkServerIdentity).toBeDefined()

        // A cert whose SPKI hash is not in the table. subjectaltname makes the
        // stock TLS hostname check pass so the pin check is what decides.
        const cert = {
          ...makeMockCertWithRaw(getTestCertDer()),
          subjectaltname: `DNS:${STAGING_HOST}`
        } as tls.PeerCertificate

        // #then it is rejected
        expect(checkServerIdentity!(STAGING_HOST, cert)).toBeInstanceOf(CertificatePinningError)

        // #when the pin table is updated to trust it — no restart, no cache flush
        PINNED_CERTIFICATE_HASHES_BY_HOST[STAGING_HOST] = [computeSpkiHashFromPem(TEST_CERT_PEM)]

        // #then the SAME already-shared agent honours the new pins: the check
        // resolves them per handshake, so reuse never freezes a pin decision
        expect(checkServerIdentity!(STAGING_HOST, cert)).toBeUndefined()
      } finally {
        PINNED_CERTIFICATE_HASHES_BY_HOST[STAGING_HOST] = originalPins
      }
    })
  })

  describe('getPinnedCertificateHashes', () => {
    it('#given dev mode #then returns placeholder hashes as-is', () => {
      // #when
      const hashes = getPinnedCertificateHashes()

      // #then
      expect(hashes).toHaveLength(2)
      expect(hashes[0]).toMatch(/^sha256\//)
      expect(hashes[1]).toMatch(/^sha256\//)
    })

    it('#given packaged mode with placeholders #then returns empty array', () => {
      // #given
      mockApp.isPackaged = true

      // #when
      const hashes = getPinnedCertificateHashes()

      // #then
      expect(hashes).toHaveLength(0)
    })
  })

  describe('placeholder pins fallback logging', () => {
    it('#given packaged mode with placeholders #then logs debug once and never warns or errors', async () => {
      // #given — fresh module so the once-guard starts clean
      vi.resetModules()
      mockApp.isPackaged = true
      mockLog.debug.mockClear()
      mockLog.warn.mockClear()
      mockLog.error.mockClear()
      const fresh = await import('./certificate-pinning')

      // #when — every placeholder-detecting path fires
      fresh.getPinnedCertificateHashes()
      fresh.createPinnedAgent()
      fresh.warnPinningUnconfiguredOnce()

      // #then — TLS-only fallback is deliberate: one debug line, nothing in the
      // remote warn/error stream (which is floored at warn) — see #846
      expect(mockLog.debug).toHaveBeenCalledTimes(1)
      expect(mockLog.warn).not.toHaveBeenCalled()
      expect(mockLog.error).not.toHaveBeenCalled()
    })
  })
})
