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
// The FORGED_* certificates are CA certificates that carry the real intermediate's public key but
// are signed by an unrelated key, and omit key identifiers, so Node's name-only issuer match
// (`checkIssued`) accepts them and only the signature check can reject them. FORGED_LEAF names
// FORGED_INTERMEDIATE as its issuer; FORGED_INTERMEDIATE_UNDER_ROOT names ROOT as its issuer.
// DV_CERT is what a public CA issues to any applicant: basicConstraints CA:FALSE, no keyUsage,
// signed by the real intermediate. The applicant holds its key, so DV_LEAF is signed with it, and
// ROGUE_ROOT is a self-signed CA with that same name and key. None of these may act as an issuer.
const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBfTCCASSgAwIBAgIUIhEMJMCdOWupFAes5EIl0VOASncwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRVGVzdCBJbnRlcm1lZGlhdGUwIBcNMjYxMDI4MDkzNzU3WhgP
MjEyNjEwMDQwOTM3NTdaMBwxGjAYBgNVBAMMEXN5bmMtc3RhZ2luZy50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDm0T2N0VU9BsyDEsogiB2ppHyXFo9OUj
vos2jiB4adzrUxQZu465cJFt2z1Z9V4XzEoB3Eu5UmjVL79I8+afzKNCMEAwHQYD
VR0OBBYEFIzuxS+hXERSIDVhB+4kMdedK3G2MB8GA1UdIwQYMBaAFI95Vx7EyOQ8
x5sUb3hukhARPJZvMAoGCCqGSM49BAMCA0cAMEQCIAeeQBaa1+/WHRizEo40hSd1
UbVta86rxzeIh7NvUPNLAiB81fceFVw1vpxjebyfU+4HmcUwHR9Qv2hg2QZPlTTL
wQ==
-----END CERTIFICATE-----`

const INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBZTCCAQygAwIBAgIURmNjPCVHqy1gNr6A/wb/KXgi6FcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJVGVzdCBSb290MCAXDTI2MTAyODA5Mzc1N1oYDzIxMjYxMDA0
MDkzNzU3WjAcMRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0ZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABMJHFZbvj89AEmowLoiCJAoGpczL1nq7okFGQQ1RNPtq
OOzN2lt0LERxg04sGDuTL5xa0VmNtXn8zpP4o1LHCWKjMjAwMA8GA1UdEwEB/wQF
MAMBAf8wHQYDVR0OBBYEFI95Vx7EyOQ8x5sUb3hukhARPJZvMAoGCCqGSM49BAMC
A0cAMEQCIC3fmfldfYLXdvboyTSl05SuYT05YUq+VlqKfceoXrO1AiBcrY6nuJFY
Mr1nsehl6SHpnMse/xhvxd2wNBVM3soEQQ==
-----END CERTIFICATE-----`

const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBXjCCAQSgAwIBAgIUSzCmLTch6v2g3OlTFdx6NnK4tAkwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJVGVzdCBSb290MCAXDTI2MTAyODA5Mzc1N1oYDzIxMjYxMDA0
MDkzNzU3WjAUMRIwEAYDVQQDDAlUZXN0IFJvb3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASJ8gncOxn1fgcrqHCYhMY4AH4A85CADtMbhYqjBh62xa3KjykAhDff
sMlywCbtw0TVJzLb9fXfKjlt5/56qrFZozIwMDAdBgNVHQ4EFgQUy93zxd7o9r9h
yUXDikVb6MmzTbgwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA
w2K/oHu9SfbPSSfRrNNFqQDlD2AJ1/5UYKGr/VKk288CIESIHOm5k0JeVOjuf7HK
xwH+6dASgaJRtUNoFLeo25hk
-----END CERTIFICATE-----`

const FORGED_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBOTCB4KADAgECAhQz5HSuDKJBsNR9VjS4VY/dxZdVDDAKBggqhkjOPQQDAjAc
MRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0ZTAgFw0yNjEwMjgwOTM3NTdaGA8y
MTI2MTAwNDA5Mzc1N1owHDEaMBgGA1UEAwwRc3luYy1zdGFnaW5nLnRlc3QwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAASzl2fFY62+a/pFpWdSweKnrZnwkhVK9/Rc
BZ0WIO285DZd75q9fIA9CaddFIbaJ+N/iOkoJkfCNJHaBK942g2CMAoGCCqGSM49
BAMCA0gAMEUCIQD8vmHwuFE8pWFlXp1uXznttkhlYMdzmI6stVGaaXJ7eQIgVh1g
69GQUbDIlxB0JeNyGdBLl1kl0VeSABx3qQhQ+Cs=
-----END CERTIFICATE-----`

const FORGED_INTERMEDIATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBTjCB9aADAgECAhQz5HSuDKJBsNR9VjS4VY/dxZdVDTAKBggqhkjOPQQDAjAc
MRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0ZTAgFw0yNjEwMjgwOTM3NTdaGA8y
MTI2MTAwNDA5Mzc1N1owHDEaMBgGA1UEAwwRVGVzdCBJbnRlcm1lZGlhdGUwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAATCRxWW74/PQBJqMC6IgiQKBqXMy9Z6u6JB
RkENUTT7ajjszdpbdCxEcYNOLBg7ky+cWtFZjbV5/M6T+KNSxwlioxMwETAPBgNV
HRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIG80wysyi5T18t/7pPgeNB1P
/5RvEUe1TN0LQLPCOEImAiEAxyNtNidO/E34m11lh6vvz0Z09IJjCsd7uJ9CWihR
lIs=
-----END CERTIFICATE-----`

const FORGED_INTERMEDIATE_UNDER_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBRjCB7aADAgECAhRKZa1hEpBBwKt/fkE60zgYHYk4ADAKBggqhkjOPQQDAjAU
MRIwEAYDVQQDDAlUZXN0IFJvb3QwIBcNMjYxMDI4MDkzNzU3WhgPMjEyNjEwMDQw
OTM3NTdaMBwxGjAYBgNVBAMMEVRlc3QgSW50ZXJtZWRpYXRlMFkwEwYHKoZIzj0C
AQYIKoZIzj0DAQcDQgAEwkcVlu+Pz0ASajAuiIIkCgalzMvWeruiQUZBDVE0+2o4
7M3aW3QsRHGDTiwYO5MvnFrRWY21efzOk/ijUscJYqMTMBEwDwYDVR0TAQH/BAUw
AwEB/zAKBggqhkjOPQQDAgNIADBFAiBiMfYYEEQJPKuEU8lNNDHdGQQc0ByRx/B+
Ip1S8Vm5/wIhAK7gX6W/ZrCmN6gTK+KmoGEDZtAYFLsK21CVzVGRxTjc
-----END CERTIFICATE-----`

const DV_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBQjCB6KADAgECAhQiEQwkwJ05a6kUB6zkQiXRU4BKeDAKBggqhkjOPQQDAjAc
MRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0ZTAgFw0yNjEwMjgwOTM3NTdaGA8y
MTI2MTAwNDA5Mzc1N1owEjEQMA4GA1UEAwwHVGVzdCBEVjBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABMmMmZuVs7n+Y/j5yhUbvh+AjPHlP4oPLWGEezt40JDRJA80
6Qm/ArDlSPBmBztmuJ0fOU+8m94k6hWdUmuZebKjEDAOMAwGA1UdEwEB/wQCMAAw
CgYIKoZIzj0EAwIDSQAwRgIhAJMpR3xuDfT9W9KzjhO2gL4S33Do9hB7C1dw8dem
orh7AiEAi/Y+YACbX9vkQPPfnlGNNnyPPTNTBm7RilGGkbo5zlU=
-----END CERTIFICATE-----`

const DV_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBLjCB1qADAgECAhRB7dpnUp2iQbklBJ/CRoAhkjB1lzAKBggqhkjOPQQDAjAS
MRAwDgYDVQQDDAdUZXN0IERWMCAXDTI2MTAyODA5Mzc1N1oYDzIxMjYxMDA0MDkz
NzU3WjAcMRowGAYDVQQDDBFzeW5jLXN0YWdpbmcudGVzdDBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABJkYjJ24BT84tK6/vqc+JjB9ocSfToib8j//2cSMqM6cJ/b5
ar5OBUo0FADVdZx8FW5PA1IyoOkt+BU854r4EJUwCgYIKoZIzj0EAwIDRwAwRAIg
ZcN7UlLPm6OiqG8y5VhByQCNlzkW9q88oQgK0nQAy5MCIFXH2s+R4yXOc2d8kg2t
2h0LFStpCvWEUL++NEgxm9hh
-----END CERTIFICATE-----`

const ROGUE_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBWzCCAQCgAwIBAgIURDzO0SNq1dS01lgXBqGSTqEAI3UwCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHVGVzdCBEVjAgFw0yNjEwMjgwOTM3NTdaGA8yMTI2MTAwNDA5
Mzc1N1owEjEQMA4GA1UEAwwHVGVzdCBEVjBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABMmMmZuVs7n+Y/j5yhUbvh+AjPHlP4oPLWGEezt40JDRJA806Qm/ArDlSPBm
BztmuJ0fOU+8m94k6hWdUmuZebKjMjAwMB0GA1UdDgQWBBQieVmQjEv8XBSnxK+s
AnPPXqiIQjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCDaiWG
xZCXbIICWsYgRj7INGamxPb1hU488Z6Z18/6rQIhAMKAXey6OhPkE4whS7UZyKSe
u6kt7dwt7cORhtanPV4J
-----END CERTIFICATE-----`

// The same CA name and key twice, as with self-signed R4 and its cross-certificate. ANCHOR_COPY_A
// is signed by a key nobody in the chain holds, so it is a dead end. ANCHOR_COPY_B is signed by
// TOP, so the pin on TOP is reachable only through it.
const ANCHOR_COPY_A_PEM = `-----BEGIN CERTIFICATE-----
MIIBRTCB7aADAgECAhQOF2v5mUARG5UwnHd/TRmdUdwUBTAKBggqhkjOPQQDAjAc
MRowGAYDVQQDDBFUZXN0IE90aGVyIEFuY2hvcjAgFw0yNjEwMjgwOTQxNTlaGA8y
MTI2MTAwNDA5NDE1OVowFDESMBAGA1UEAwwJVGVzdCBSb290MFkwEwYHKoZIzj0C
AQYIKoZIzj0DAQcDQgAEifIJ3DsZ9X4HK6hwmITGOAB+APOQgA7TG4WKowYetsWt
yo8pAIQ337DJcsAm7cNE1Scy2/X13yo5bef+eqqxWaMTMBEwDwYDVR0TAQH/BAUw
AwEB/zAKBggqhkjOPQQDAgNHADBEAiBihSfEkwGKcHe807udnEQuyDpkoJlMrSG6
s6LzRIIgfQIgJ6DFU6zASgE/5UDjzdUq6AL8s3ML743GA97Jqff0Vdk=
-----END CERTIFICATE-----`

const ANCHOR_COPY_B_PEM = `-----BEGIN CERTIFICATE-----
MIIBPTCB5KADAgECAhRwOOj+atbGrgor9pvmSzTIwcw7NzAKBggqhkjOPQQDAjAT
MREwDwYDVQQDDAhUZXN0IFRvcDAgFw0yNjEwMjgwOTQxNTlaGA8yMTI2MTAwNDA5
NDE1OVowFDESMBAGA1UEAwwJVGVzdCBSb290MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEifIJ3DsZ9X4HK6hwmITGOAB+APOQgA7TG4WKowYetsWtyo8pAIQ337DJ
csAm7cNE1Scy2/X13yo5bef+eqqxWaMTMBEwDwYDVR0TAQH/BAUwAwEB/zAKBggq
hkjOPQQDAgNIADBFAiBoxiPlmTwaxTe8cp3uV50aXOFsx0Yc9+8pH4eSLyOYTQIh
ALGDT6vkUTZF4mT6so69DYBDZbs/mr7kaJ7/VtLvmEdO
-----END CERTIFICATE-----`

const TOP_PEM = `-----BEGIN CERTIFICATE-----
MIIBWzCCAQKgAwIBAgIUVHypY8vmUDJTSFYpwxqPRq5bONUwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIVGVzdCBUb3AwIBcNMjYxMDI4MDk0MTU5WhgPMjEyNjEwMDQw
OTQxNTlaMBMxETAPBgNVBAMMCFRlc3QgVG9wMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE+t4JbuIz7bjgh5v4d1C/oegifexdN4gaqptq5COx6xI+PsWuB9U/4r8t
S29l6bgJtPVxST7kKiXAtcL7XW24NKMyMDAwHQYDVR0OBBYEFN0B0UnaJ52ilIV6
wxxIMSxi9wIfMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgBwoP
oGr68nw1c+8U+g8IosrpW1Zi8KpFPUModlh7/UcCICkX/Yry25Zx1//6hxZzzt9y
lW1CzFnCsYZ2TRHF5uYV
-----END CERTIFICATE-----`

const HOST = 'sync-staging.test'
const LEAF_PIN = computeSpkiHashFromPem(LEAF_PEM)
const INTERMEDIATE_PIN = computeSpkiHashFromPem(INTERMEDIATE_PEM)
const ROOT_PIN = computeSpkiHashFromPem(ROOT_PEM)
const TOP_PIN = computeSpkiHashFromPem(TOP_PEM)
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

    it('reaches a pin through the second of two CA copies when the first leads nowhere', () => {
      const chain = [LEAF_PEM, INTERMEDIATE_PEM, ANCHOR_COPY_A_PEM, ANCHOR_COPY_B_PEM, TOP_PEM]

      expect(matches(chain, [TOP_PIN])).toBe(true)
      expect(matches([LEAF_PEM, INTERMEDIATE_PEM, ANCHOR_COPY_A_PEM], [TOP_PIN])).toBe(false)
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

  describe('a certificate that is not a CA', () => {
    // An attacker holding any DV certificate under the pinned intermediate holds a key that
    // signs leaves `checkIssued` and `verify` both accept, so only `ca` rejects the link.
    const dvCert = () => new crypto.X509Certificate(DV_CERT_PEM)

    it('has the shape that passes the signature and name checks but is not a CA', () => {
      const leaf = new crypto.X509Certificate(DV_LEAF_PEM)
      expect(dvCert().ca).toBe(false)
      expect(dvCert().keyUsage).toBeUndefined()
      expect(leaf.checkIssued(dvCert())).toBe(true)
      expect(leaf.verify(dvCert().publicKey)).toBe(true)
    })

    it('does not link a leaf to the pinned intermediate through a CA:FALSE certificate', () => {
      expect(
        verifyCertificatePin(peerChain(DV_LEAF_PEM, DV_CERT_PEM, INTERMEDIATE_PEM), [
          INTERMEDIATE_PIN
        ])
      ).toBe(false)
    })

    it.each([
      ['leaf only', () => electronChain(DV_LEAF_PEM)],
      [
        'leaf and a self-signed root with the DV key',
        () => electronChain(DV_LEAF_PEM, ROGUE_ROOT_PEM)
      ]
    ])('does not match through the session chains when validated is %s', (_label, validated) => {
      expect(
        verifySessionCertificatePin(
          {
            certificate: electronChain(DV_LEAF_PEM, DV_CERT_PEM, INTERMEDIATE_PEM),
            validatedCertificate: validated()
          },
          [INTERMEDIATE_PIN]
        )
      ).toBe(false)
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
