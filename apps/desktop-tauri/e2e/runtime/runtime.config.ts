import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const runtimeDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(runtimeDir, '../..')

export const runtimeConfig = {
  packageRoot,
  srcTauriRoot: resolve(packageRoot, 'src-tauri'),
  tmpRootPrefix: resolve(tmpdir(), 'memry-e2e-'),
  driverHost: '127.0.0.1',
  driverPort: 4444,
  tauriDriverVersion: '2.0.5'
} as const
