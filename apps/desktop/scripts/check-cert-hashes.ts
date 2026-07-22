import {
  checkCertificatePinConfig,
  getConfiguredPinnedCertificateHashes,
  getConfiguredSyncCertHostname
} from '../src/main/sync/certificate-pins.ts'

const hostname = getConfiguredSyncCertHostname(process.env.SYNC_SERVER_URL)
const pins = getConfiguredPinnedCertificateHashes(process.env.SYNC_SERVER_URL)
const strict = process.env.MEMRY_CERT_PINS_STRICT === '1'

const result = checkCertificatePinConfig({ hostname, pins, strict })

if (result.level === 'error') {
  console.error(`ERROR: ${result.message}`)
  process.exit(1)
}

if (result.level === 'warn') {
  console.warn(`WARNING: ${result.message}`)
} else {
  console.log(result.message)
}
