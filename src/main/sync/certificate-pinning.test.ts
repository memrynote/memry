import { describe, it, expect, vi, beforeEach } from 'vitest'
import type tls from 'node:tls'

const mockApp = vi.hoisted(() => ({ isPackaged: false }))

vi.mock('electron', () => ({
  app: mockApp
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import {
  computeSpkiHash,
  computeSpkiHashFromPem,
  verifyCertificatePin,
  createPinnedAgent,
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
    it('#given dev mode (app.isPackaged=false) #then returns agent without pin checking', () => {
      // #when
      const agent = createPinnedAgent()

      // #then
      expect(agent).toBeDefined()
      expect(agent.options.rejectUnauthorized).not.toBe(false)
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

    it('#given packaged mode with placeholder hashes #then returns standard TLS agent', () => {
      // #given
      mockApp.isPackaged = true

      // #when
      const agent = createPinnedAgent(['sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64'])

      // #then
      expect(agent).toBeDefined()
      expect(agent.options.checkServerIdentity).toBeUndefined()
      expect(agent.options.rejectUnauthorized).not.toBe(false)
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
})
