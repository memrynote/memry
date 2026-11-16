import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { binaryPath } from './app-process'

const PDFIUM_DIR = fileURLToPath(new URL('../../src-tauri/resources/pdfium', import.meta.url))

function fileTextReady(): boolean {
  const worker = join(
    dirname(binaryPath()),
    process.platform === 'win32' ? 'memry-ml-worker.exe' : 'memry-ml-worker'
  )
  return (
    existsSync(worker) &&
    existsSync(PDFIUM_DIR) &&
    readdirSync(PDFIUM_DIR).some((name) => /pdfium/i.test(name) && !name.endsWith('.md'))
  )
}

/**
 * Throws unless the app under test can read a PDF or an image: the `memry-ml-worker` sidecar sits
 * next to the binary (`WorkerPaths::new`) and pdfium is in the checkout's resources, where a debug
 * build looks. `pnpm build:e2e` builds neither. A CI leg that builds both (the arm64 legs of
 * `desktop-tauri-ci.yml`) sets `MEMRY_E2E_FILE_TEXT=1`, and a missing worker or pdfium fails the
 * spec there. Any other run (a leg that does not build them, a local `pnpm test:e2e`) skips it.
 * Returns the skip reason, or null when the spec runs.
 */
export function fileTextSkipReason(): string | null {
  if (fileTextReady()) return null
  if (process.env.MEMRY_E2E_FILE_TEXT === '1') {
    throw new Error(
      'MEMRY_E2E_FILE_TEXT=1 but memry-ml-worker or pdfium is missing: the CI leg did not build them'
    )
  }
  return 'the e2e build has no memry-ml-worker sidecar or pdfium (only the arm64 CI legs build them)'
}
