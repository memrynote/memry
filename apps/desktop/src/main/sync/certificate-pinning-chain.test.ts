import crypto from 'node:crypto'
import type tls from 'node:tls'
import type { Certificate } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  CertificatePinningError,
  computeSpkiHashFromPem,
  createPinnedAgent,
  verifyCertificatePin,
  verifySessionCertificatePin
} from './certificate-pinning'
import {
  FORGED_INTERMEDIATE_PEM,
  FORGED_LEAF_PEM,
  INTERMEDIATE_PEM,
  LEAF_PEM,
  ROOT_PEM
} from './certificate-chain-fixtures'

const HOST = 'sync-staging.test'
const LEAF_PIN = computeSpkiHashFromPem(LEAF_PEM)
const INTERMEDIATE_PIN = computeSpkiHashFromPem(INTERMEDIATE_PEM)
const ROOT_PIN = computeSpkiHashFromPem(ROOT_PEM)
const UNRELATED_PIN = computeSpkiHashFromPem(FORGED_LEAF_PEM)

function der(pem: string): Buffer {
  return new crypto.X509Certificate(pem).raw
}

/** What Node hands `checkServerIdentity`: the leaf with `issuerCertificate` links up the chain. */
function peerChain(...pems: string[]): tls.DetailedPeerCertificate {
  const certs = pems.map(
    (pem) =>
      ({
        raw: der(pem),
        subjectaltname: `DNS:${HOST}`
      }) as tls.DetailedPeerCertificate
  )
  certs.forEach((cert, i) => {
    cert.issuerCertificate = certs[i + 1] ?? cert
  })
  return certs[0]
}

/** What Chromium hands `setCertificateVerifyProc`: PEM `data` with `issuerCert` links. */
function sessionChain(...pems: string[]): Certificate {
  const certs = pems.map((data) => ({ data }) as Certificate)
  certs.forEach((cert, i) => {
    cert.issuerCert = certs[i + 1]
  })
  return certs[0]
}

describe('chain-aware certificate pinning', () => {
  describe.each([
    ['node TLS peer certificate', peerChain, verifyCertificatePin],
    ['Electron session certificate', sessionChain, verifySessionCertificatePin]
  ] as const)('%s', (_label, chainOf, verify) => {
    const matches = (pems: string[], pins: string[]) =>
      (verify as (cert: never, pins: string[]) => boolean)(chainOf(...pems) as never, pins)

    it('accepts a pin on the leaf', () => {
      expect(matches([LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM], [LEAF_PIN])).toBe(true)
    })

    it('accepts a pin on the intermediate, so a renewed leaf still matches', () => {
      expect(matches([LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM], [INTERMEDIATE_PIN])).toBe(true)
    })

    it('accepts a pin on the root key above the intermediate', () => {
      expect(matches([LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM], [UNRELATED_PIN, ROOT_PIN])).toBe(true)
    })

    it('rejects a chain none of whose certificates are pinned', () => {
      expect(matches([LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM], [UNRELATED_PIN])).toBe(false)
    })

    it('rejects an empty pin set', () => {
      expect(matches([LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM], [])).toBe(false)
    })

    it('rejects a forged parent that carries the pinned key but did not sign the leaf', () => {
      // Name-only issuer matching accepts this pair, so only the signature check stops it.
      const leaf = new crypto.X509Certificate(FORGED_LEAF_PEM)
      const forged = new crypto.X509Certificate(FORGED_INTERMEDIATE_PEM)
      expect(leaf.checkIssued(forged)).toBe(true)
      expect(computeSpkiHashFromPem(FORGED_INTERMEDIATE_PEM)).toBe(INTERMEDIATE_PIN)

      expect(matches([FORGED_LEAF_PEM, FORGED_INTERMEDIATE_PEM], [INTERMEDIATE_PIN])).toBe(false)
    })

    it('rejects a pin above a link that is not signed by the next certificate up', () => {
      // The real root is pinned, but the forged intermediate between it and the leaf breaks the walk.
      expect(matches([FORGED_LEAF_PEM, FORGED_INTERMEDIATE_PEM, ROOT_PEM], [ROOT_PIN])).toBe(false)
    })
  })

  it('stops at a self-referencing root and at a cyclic chain', () => {
    const leaf = peerChain(LEAF_PEM)
    expect(verifyCertificatePin(leaf, [UNRELATED_PIN])).toBe(false)

    const a = { raw: der(LEAF_PEM) } as tls.DetailedPeerCertificate
    const b = { raw: der(INTERMEDIATE_PEM) } as tls.DetailedPeerCertificate
    a.issuerCertificate = b
    b.issuerCertificate = a
    expect(verifyCertificatePin(a, [UNRELATED_PIN])).toBe(false)
  })

  describe('createPinnedAgent', () => {
    const check = (pins: string[], chain: tls.DetailedPeerCertificate) =>
      createPinnedAgent(pins).options.checkServerIdentity!(HOST, chain)

    it('accepts a renewed leaf under an intermediate pin', () => {
      expect(check([INTERMEDIATE_PIN, ROOT_PIN], peerChain(LEAF_PEM, INTERMEDIATE_PEM))).toBe(
        undefined
      )
    })

    it('refuses a chain that matches no pin and reports the leaf hash', () => {
      const result = check([UNRELATED_PIN], peerChain(LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM))

      expect(result).toBeInstanceOf(CertificatePinningError)
      expect((result as CertificatePinningError).actualHash).toBe(LEAF_PIN)
    })

    it('still rejects a certificate whose SAN does not cover the host', () => {
      const chain = peerChain(LEAF_PEM, INTERMEDIATE_PEM)
      chain.subjectaltname = 'DNS:other.test'

      const result = check([INTERMEDIATE_PIN], chain)

      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(CertificatePinningError)
    })
  })
})
