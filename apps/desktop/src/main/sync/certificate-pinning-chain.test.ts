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
  peerChainHashes,
  sessionChainHashes,
  verifyCertificatePin,
  verifySessionCertificatePin
} from './certificate-pinning'

// Throwaway P-256 chain, test-only. leaf <- intermediate <- root is signed correctly.
// The FORGED_* certificates carry the real intermediate's public key but are signed by an
// unrelated key, and omit key identifiers, so Node's name-only issuer match (`checkIssued`)
// accepts them and only the signature check can reject them. FORGED_LEAF names
// FORGED_INTERMEDIATE as its issuer; FORGED_INTERMEDIATE_UNDER_ROOT names ROOT as its issuer.
const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBfjCCASSgAwIBAgIUIYWQWkG/TWRWNMDasILdhiIMyV0wCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRVGVzdCBJbnRlcm1lZGlhdGUwIBcNMjYxMDI4MDkxMjQ4WhgP
MjEyNjEwMDQwOTEyNDhaMBwxGjAYBgNVBAMMEXN5bmMtc3RhZ2luZy50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+87k5rpbT3kBjaqUux2w7BlyCDENwyKB
1O4l7K1D3cHW8z5OcqW2sh51dOK+CiRMwvEeNetv1UDjdqtVUw8bo6NCMEAwHQYD
VR0OBBYEFJ97h3yV7QjiJ5g+Q5Te8eMqRRC7MB8GA1UdIwQYMBaAFJ30NnPDaEZ9
Hg5Pc2gFsp1KaXcoMAoGCCqGSM49BAMCA0gAMEUCIGqLuEJhau6Zr/pIFll5OG1O
YW1mn0sehdyqd+XrTjQNAiEA7De38q8RJnPuPw/3WG4aywBnYYcKQZ8lUwtoWlSX
J3A=
-----END CERTIFICATE-----`

const INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBZTCCAQygAwIBAgIUTjAgosF8bpxImXVH6Tts2MQ5n2IwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJVGVzdCBSb290MCAXDTI2MTAyODA5MTI0OFoYDzIxMjYxMDA0
MDkxMjQ4WjAcMRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0ZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABONSrnqOz5BD1zdTBavOI/+1O2gvzpIIIKi8yr4tqdUU
QABFESk/yd026fpR1CZZskHOojiFdXJwGnVuFuYeLoCjMjAwMA8GA1UdEwEB/wQF
MAMBAf8wHQYDVR0OBBYEFJ30NnPDaEZ9Hg5Pc2gFsp1KaXcoMAoGCCqGSM49BAMC
A0cAMEQCIHQlrJioLN4zf/pYMVgJu3dvt/qxeQZbY4kc7MUd/9RjAiBeUcbZ/l44
5fthnm88ZBZHUjkZt9glUn7MAzRbkAIAJQ==
-----END CERTIFICATE-----`

const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBXzCCAQSgAwIBAgIUTWBumuGavdHnhP1zX7Uo+2K2gXIwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJVGVzdCBSb290MCAXDTI2MTAyODA5MTI0OFoYDzIxMjYxMDA0
MDkxMjQ4WjAUMRIwEAYDVQQDDAlUZXN0IFJvb3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT/RfEpldjce3dDemnkN5RQstKjJm6RaxjPCZq/doa9VFM6wB2vPURF
WLqWdAZfUji2LY7KCV169UKciKoq57ycozIwMDAdBgNVHQ4EFgQUm+YGkjjtuNRp
pELqDaC+smWeTgQwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA
hrRprXmIX6MclEXjyLva2OzZnUBSw3tJqtCycoh74KECIQDUPfhoHgcexKlLa5Gh
aO4fQrYq4JhsDuO1GkKl1XlGvg==
-----END CERTIFICATE-----`

const FORGED_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBOTCB4KADAgECAhQRXZ/GyWA4EhczVURwddbQf7IdRjAKBggqhkjOPQQDAjAc
MRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0ZTAgFw0yNjEwMjgwOTEyNThaGA8y
MTI2MTAwNDA5MTI1OFowHDEaMBgGA1UEAwwRc3luYy1zdGFnaW5nLnRlc3QwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAASr/j5z8Qfwnqu5z4xDdMUaRh0kao1vQvyS
u74NLEoqWHdRwSXF0Hkd5hgWnxD6BqqTfh0foSRM5Rkd+xVrcKUXMAoGCCqGSM49
BAMCA0gAMEUCIQCOJRxuiTDeQ0V4Icp6RePEFcuqG+IOY25hqL0sBCjiwgIgRoNC
QCHy6SwBZ8ZUeIn5Er+5EJzq0NoqXzUYmswITGw=
-----END CERTIFICATE-----`

const FORGED_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBODCB4KADAgECAhQRXZ/GyWA4EhczVURwddbQf7IdRzAKBggqhkjOPQQDAjAc
MRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0ZTAgFw0yNjEwMjgwOTEyNThaGA8y
MTI2MTAwNDA5MTI1OFowHDEaMBgGA1UEAwwRVGVzdCBJbnRlcm1lZGlhdGUwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAATjUq56js+QQ9c3UwWrziP/tTtoL86SCCCo
vMq+LanVFEAARREpP8ndNun6UdQmWbJBzqI4hXVycBp1bhbmHi6AMAoGCCqGSM49
BAMCA0cAMEQCIDBtFpVrFSx50PpRI4BQfOHLZwAYUz/2irF/dl8coBgIAiAYx5Cq
uevB02SJN0XQQ/WCOSE7wHWhsIUk5qm8ztlnqg==
-----END CERTIFICATE-----`

const FORGED_INTERMEDIATE_UNDER_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBMjCB2KADAgECAhR3PAeFbSBJdH2ivnsCSjU8HPprUDAKBggqhkjOPQQDAjAU
MRIwEAYDVQQDDAlUZXN0IFJvb3QwIBcNMjYxMDI4MDkyNTE5WhgPMjEyNjEwMDQw
OTI1MTlaMBwxGjAYBgNVBAMMEVRlc3QgSW50ZXJtZWRpYXRlMFkwEwYHKoZIzj0C
AQYIKoZIzj0DAQcDQgAE41Kueo7PkEPXN1MFq84j/7U7aC/OkgggqLzKvi2p1RRA
AEURKT/J3Tbp+lHUJlmyQc6iOIV1cnAadW4W5h4ugDAKBggqhkjOPQQDAgNJADBG
AiEA/Rv9ds0wLuVp52pbcKWugNalKUgZqXDKCRqM5h5MbskCIQDqUUQchvI2NgDF
njRBNe9dgkzVYX0oOL421JO8t8PPww==
-----END CERTIFICATE-----`

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

/** Chromium's certificate: PEM `data` with `issuerCert` links. */
function electronChain(...pems: string[]): Certificate {
  const certs = pems.map((data) => ({ data }) as Certificate)
  certs.forEach((cert, i) => {
    cert.issuerCert = certs[i + 1]
  })
  return certs[0]
}

describe('chain-aware certificate pinning', () => {
  describe.each([
    [
      'node TLS peer certificate',
      (pems: string[], pins: string[]) => verifyCertificatePin(peerChain(...pems), pins)
    ],
    [
      'Electron session certificate',
      (pems: string[], pins: string[]) =>
        verifySessionCertificatePin({ certificate: electronChain(...pems) }, pins)
    ]
  ])('%s', (_label, matches) => {
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

    it('rejects a pin on a root whose link below it is not signed by that root', () => {
      // The leaf really is signed by this intermediate key, and the intermediate names ROOT as
      // its issuer, so `checkIssued` passes at both links. Only the intermediate's signature
      // (made by another key) separates it from ROOT.
      const intermediate = new crypto.X509Certificate(FORGED_INTERMEDIATE_UNDER_ROOT_PEM)
      expect(intermediate.checkIssued(new crypto.X509Certificate(ROOT_PEM))).toBe(true)

      expect(matches([LEAF_PEM, FORGED_INTERMEDIATE_UNDER_ROOT_PEM, ROOT_PEM], [ROOT_PIN])).toBe(
        false
      )
    })
  })

  it('stops at a cyclic chain', () => {
    const a = { raw: der(LEAF_PEM) } as tls.DetailedPeerCertificate
    const b = { raw: der(INTERMEDIATE_PEM) } as tls.DetailedPeerCertificate
    a.issuerCertificate = b
    b.issuerCertificate = a

    expect(verifyCertificatePin(a, [UNRELATED_PIN])).toBe(false)
  })

  describe('session verifier chains', () => {
    // On macOS Chromium's validated chain stops below the trust anchor, while the server
    // still sends the root cross-certificate. Pins may match through either.
    const validated = () => electronChain(LEAF_PEM, INTERMEDIATE_PEM)
    const sent = () => electronChain(LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM)

    it('matches an intermediate pin from the validated chain alone', () => {
      expect(
        verifySessionCertificatePin(
          { certificate: electronChain(LEAF_PEM), validatedCertificate: validated() },
          [INTERMEDIATE_PIN]
        )
      ).toBe(true)
    })

    it('matches a root pin through the server-sent chain when the validated chain omits it', () => {
      expect(
        verifySessionCertificatePin({ certificate: sent(), validatedCertificate: validated() }, [
          ROOT_PIN
        ])
      ).toBe(true)
    })

    it('cannot match a root pin once neither chain carries the root', () => {
      expect(
        verifySessionCertificatePin(
          {
            certificate: electronChain(LEAF_PEM, INTERMEDIATE_PEM),
            validatedCertificate: validated()
          },
          [ROOT_PIN]
        )
      ).toBe(false)
    })

    it('does not let the server-sent chain vouch for a forged parent', () => {
      expect(
        verifySessionCertificatePin(
          {
            certificate: electronChain(FORGED_LEAF_PEM, FORGED_INTERMEDIATE_PEM),
            validatedCertificate: electronChain(FORGED_LEAF_PEM)
          },
          [INTERMEDIATE_PIN]
        )
      ).toBe(false)
    })
  })

  it('lists the hash of every reported certificate for mismatch logs', () => {
    const expected = [LEAF_PIN, INTERMEDIATE_PIN, ROOT_PIN]

    expect(peerChainHashes(peerChain(LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM))).toEqual(expected)
    expect(
      sessionChainHashes({
        certificate: electronChain(LEAF_PEM, INTERMEDIATE_PEM, ROOT_PEM),
        validatedCertificate: electronChain(LEAF_PEM, INTERMEDIATE_PEM)
      })
    ).toEqual(expected)
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
