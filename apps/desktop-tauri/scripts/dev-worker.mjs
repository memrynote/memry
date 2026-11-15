#!/usr/bin/env node
// Builds the `memry-ml-worker` sidecar for `tauri dev` and fetches the pdfium it binds. The worker
// links ONNX Runtime statically, which needs `ORT_LIB_LOCATION` on every target but macOS arm64
// (crates/AGENTS.md, ONNX Runtime). Without it, the dev build leaves out the `embed` feature: PDFs
// work, and every embedding op fails with the reason, so the app shows the model as failed.
//
//   node scripts/dev-worker.mjs
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/** The cargo feature arguments: the whole worker when ONNX Runtime can link, else PDFs only. */
export function workerFeatures(
  /** @type {{ platform: string, arch: string, env: Record<string, string | undefined> }} */ host
) {
  const ort =
    Boolean(host.env.ORT_LIB_LOCATION) || (host.platform === 'darwin' && host.arch === 'arm64')
  return ort ? ['--features', 'native'] : ['--no-default-features', '--features', 'pdf']
}

function run(/** @type {string} */ command, /** @type {string[]} */ args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const features = workerFeatures({
    platform: process.platform,
    arch: process.arch,
    env: process.env
  })
  if (features.includes('--no-default-features')) {
    console.warn(
      'ORT_LIB_LOCATION is not set: building memry-ml-worker without the embedding model. ' +
        'Set it as crates/.cargo/config.toml describes to run embeddings in dev.'
    )
  }
  run('cargo', [
    'build',
    '--manifest-path',
    'crates/Cargo.toml',
    '-p',
    'memry-ml-worker',
    '--bin',
    'memry-ml-worker',
    ...features
  ])
  run(process.execPath, ['scripts/fetch-pdfium.mjs'])
}
