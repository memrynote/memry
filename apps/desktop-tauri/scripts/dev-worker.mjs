#!/usr/bin/env node
// Builds the `memry-ml-worker` sidecar for `tauri dev`, after fetching the Tesseract sources it
// links, and fetches the pdfium it binds. The worker links ONNX Runtime statically, which needs
// `ORT_LIB_LOCATION` on every target but macOS arm64 (crates/AGENTS.md, ONNX Runtime). Without it,
// the dev build leaves out the `embed` feature: PDFs and OCR work, and every embedding op fails
// with the reason, so the app shows the model as failed. Tesseract is built with cmake; without
// cmake on PATH the dev build leaves out the `ocr` feature the same way, and images and scanned
// pages fail with the reason. whisper.cpp (`transcribe`, in `native`) lives in memry-ml and builds
// with cmake, so it needs both; without either, every local transcription fails with the reason.
// Cargo runs from `crates/`, so `crates/.cargo/config.toml` (whisper.cpp's `[env]`) applies.
//
//   node scripts/dev-worker.mjs
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/** The cargo feature arguments: the whole worker (transcription included) when ONNX Runtime can link and cmake runs, else PDFs plus what can build. */
export function workerFeatures(
  /** @type {{ platform: string, arch: string, env: Record<string, string | undefined>, cmake: boolean }} */ host
) {
  const ort =
    Boolean(host.env.ORT_LIB_LOCATION) || (host.platform === 'darwin' && host.arch === 'arm64')
  if (ort && host.cmake) return ['--features', 'native']
  const features = ['pdf', host.cmake && 'ocr', ort && 'embed'].filter(Boolean)
  return ['--no-default-features', '--features', features.join(',')]
}

/** The worker's cargo build, run from `crates/` so its `.cargo/config.toml` applies. */
export function workerBuild(/** @type {string[]} */ features) {
  return {
    cwd: join(ROOT, 'crates'),
    args: ['build', '-p', 'memry-ml-worker', '--bin', 'memry-ml-worker', ...features]
  }
}

function hasCmake() {
  return spawnSync('cmake', ['--version'], { stdio: 'ignore' }).status === 0
}

function run(/** @type {string} */ command, /** @type {string[]} */ args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmake = hasCmake()
  const features = workerFeatures({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    cmake
  })
  const built = features.at(-1) ?? ''
  if (!built.includes('embed') && built !== 'native') {
    console.warn(
      'ORT_LIB_LOCATION is not set: building memry-ml-worker without the embedding model and ' +
        'local transcription. Set it as crates/.cargo/config.toml describes to run them in dev.'
    )
  }
  if (cmake) {
    run(process.execPath, ['scripts/fetch-tesseract-sources.mjs'])
  } else {
    console.warn(
      'cmake is not on PATH: building memry-ml-worker without OCR (Tesseract) and local ' +
        'transcription (whisper.cpp), so images, scanned pages and voice memos are not read in ' +
        'dev. Install cmake and a C++ compiler (apps/desktop-tauri/AGENTS.md) to read them.'
    )
  }
  const build = workerBuild(features)
  run('cargo', build.args, build.cwd)
  run(process.execPath, ['scripts/fetch-pdfium.mjs'])
}
