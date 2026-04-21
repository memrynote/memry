import tls from 'node:tls'
import crypto from 'node:crypto'
import { parseExtractCertHashArgs } from '../src/main/sync/cert-hash-cli'

const { hostname, port } = parseExtractCertHashArgs(process.argv.slice(2))

function computeSpkiHash(cert: tls.PeerCertificate): string {
  const x509 = new crypto.X509Certificate(cert.raw)
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
  const hash = crypto.createHash('sha256').update(spkiDer).digest('base64')
  return `sha256/${hash}`
}

console.log(`Connecting to ${hostname}:${port}...\n`)

const socket = tls.connect({ host: hostname, port, servername: hostname }, () => {
  const cert = socket.getPeerCertificate(true)
  if (!cert || !cert.raw) {
    console.error('Failed to get peer certificate')
    process.exit(1)
  }

  let current: tls.DetailedPeerCertificate | undefined = cert as tls.DetailedPeerCertificate
  let depth = 0

  while (current && current.raw) {
    const hash = computeSpkiHash(current)
    const label =
      depth === 0 ? 'LEAF' : current.issuer?.CN === current.subject?.CN ? 'ROOT' : 'INTERMEDIATE'

    console.log(`[${depth}] ${label}`)
    console.log(`  Subject:  ${current.subject?.CN || 'N/A'}`)
    console.log(`  Issuer:   ${current.issuer?.CN || 'N/A'}`)
    console.log(`  Valid:    ${current.valid_from} — ${current.valid_to}`)
    console.log(`  SPKI:     ${hash}`)
    console.log()

    const next = (current as tls.DetailedPeerCertificate).issuerCertificate
    if (!next || next === current || next.raw?.equals(current.raw)) break
    current = next
    depth++
  }

  socket.destroy()
})

socket.on('error', (err) => {
  console.error(`TLS connection failed: ${err.message}`)
  process.exit(1)
})
