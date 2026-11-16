import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { binaryPath } from './app-process'

const PDFIUM_DIR = fileURLToPath(new URL('../../src-tauri/resources/pdfium', import.meta.url))

/**
 * Whether the app under test can read a PDF or an image: the `memry-ml-worker` sidecar sits next
 * to the binary (`WorkerPaths::new`) and pdfium is in the checkout's resources, where a debug
 * build looks. `pnpm build:e2e` builds neither; the e2e CI legs build and fetch neither yet, so a
 * spec that needs the text of a file skips there with that reason.
 */
export function fileTextAvailable(): boolean {
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

export const FILE_TEXT_UNAVAILABLE =
  'the e2e build has no memry-ml-worker sidecar or pdfium (CI builds neither for e2e yet)'
