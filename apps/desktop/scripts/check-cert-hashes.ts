import {
  getConfiguredPinnedCertificateHashes,
  getConfiguredSyncCertHostname,
  hasPlaceholderHashes
} from '../src/main/sync/certificate-pins.ts'

const hostname = getConfiguredSyncCertHostname(process.env.SYNC_SERVER_URL)
const pins = getConfiguredPinnedCertificateHashes(process.env.SYNC_SERVER_URL)

if (pins.length === 0) {
  console.error(`ERROR: No certificate pins configured for sync host ${hostname}`)
  process.exit(1)
}

if (hasPlaceholderHashes(pins)) {
  console.error(`ERROR: Placeholder certificate hashes found for sync host ${hostname}`)
  console.error("Run 'pnpm cert:extract -- <hostname>' and update the matching host entry.")
  process.exit(1)
}

console.log(`Certificate hashes OK for ${hostname} — no placeholders found`)
