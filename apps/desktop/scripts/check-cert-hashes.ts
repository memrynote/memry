import {
  checkCertificatePinConfig,
  getConfiguredPinnedCertificateHashes,
  getConfiguredSyncCertHostname
} from '@memry/sync-client/certificate-pins'
import { describeCertCheckHost, resolveCertCheckConfig } from './check-cert-hashes-config.ts'

// App root comes from the shell wrapper; cwd is the fallback for `pnpm cert:check`
// style invocations from apps/desktop.
const appRoot = process.argv[2] ?? process.cwd()
const config = resolveCertCheckConfig(appRoot)

const hostname = getConfiguredSyncCertHostname(config.syncServerUrl)
const pins = getConfiguredPinnedCertificateHashes(config.syncServerUrl)

console.log(describeCertCheckHost(config, hostname))

const result = checkCertificatePinConfig({ hostname, pins, strict: config.strict })

if (result.level === 'error') {
  console.error(`ERROR: ${result.message}`)
  process.exit(1)
}

if (result.level === 'warn') {
  console.warn(`WARNING: ${result.message}`)
} else {
  console.log(result.message)
}
