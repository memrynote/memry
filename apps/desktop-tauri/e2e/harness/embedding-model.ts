import { constants, cpSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { binaryPath } from './app-process'
import type { TauriApp } from './tauri-lifecycle'

/** `memry_ml::MODEL_REPO` under the transformers.js cache root (`embedding/worker.rs`). */
const MODEL_SUBDIR = join('models', 'transformers', 'onnx-community', 'embeddinggemma-2-ONNX')

const modelDir = (): string | undefined => process.env.MEMRY_E2E_MODEL_DIR

function semanticReady(): boolean {
  const worker = join(
    dirname(binaryPath()),
    process.platform === 'win32' ? 'memry-ml-worker.exe' : 'memry-ml-worker'
  )
  const dir = modelDir()
  return existsSync(worker) && !!dir && existsSync(dir) && readdirSync(dir).length > 0
}

/**
 * The model host is fixed to huggingface.co (`HUB_HOST`, `embedding/worker.rs`), so an e2e run
 * cannot serve the ~207 MB model from a local stub and does not download it either. A run that
 * has the model sets `MEMRY_E2E_MODEL_DIR` to a populated `embeddinggemma-2-ONNX` directory (the
 * transformers.js cache layout, as Electron and the Tauri app leave it) and builds the
 * `memry-ml-worker` sidecar with its `embed` feature next to the binary. With
 * `MEMRY_E2E_SEMANTIC=1` a missing worker or model fails the spec; any other run skips it.
 * Returns the skip reason, or null when the spec runs.
 */
export function semanticSkipReason(): string | null {
  if (semanticReady()) return null
  if (process.env.MEMRY_E2E_SEMANTIC === '1') {
    throw new Error(
      'MEMRY_E2E_SEMANTIC=1 but memry-ml-worker or MEMRY_E2E_MODEL_DIR is missing: the run did not provide them'
    )
  }
  return 'no memry-ml-worker with `embed` next to the binary, or MEMRY_E2E_MODEL_DIR is unset'
}

/** Clones the model into the app's cache, so the load verifies it and downloads nothing. */
export function seedModel(app: TauriApp): void {
  const source = modelDir()
  if (!source) throw new Error('MEMRY_E2E_MODEL_DIR is unset')
  cpSync(source, join(app.dirs.appDataDir, MODEL_SUBDIR), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE
  })
}
