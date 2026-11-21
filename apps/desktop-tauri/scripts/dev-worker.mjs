#!/usr/bin/env node
// Builds the `memry-ml-worker` sidecar for `tauri dev`, after fetching the Tesseract sources it
// links, and fetches the pdfium it binds. The worker links ONNX Runtime statically, which needs
// `ORT_LIB_LOCATION` on every target but macOS arm64 (crates/AGENTS.md, ONNX Runtime). Without it,
// the dev build leaves out the `embed` feature: PDFs and OCR work, and every embedding op fails
// with the reason, so the app shows the model as failed. Tesseract is built with cmake; without
// cmake on PATH the dev build leaves out the `ocr` feature the same way, and images and scanned
// pages fail with the reason. whisper.cpp (`transcribe`, in `native`) lives in memry-ml, builds
// with cmake and generates its bindings with bindgen, which loads libclang, so it needs all three;
// without one, every local transcription fails with the reason. Cargo runs from `crates/`, so
// `crates/.cargo/config.toml` (whisper.cpp's `[env]`) applies.
//
//   node scripts/dev-worker.mjs
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/** The cargo feature arguments: the whole worker (transcription included) when ONNX Runtime can link, cmake runs and bindgen finds libclang, else PDFs plus what can build. */
export function workerFeatures(
  /** @type {{ platform: string, arch: string, env: Record<string, string | undefined>, cmake: boolean, libclang: boolean }} */ host
) {
  const ort =
    Boolean(host.env.ORT_LIB_LOCATION) || (host.platform === 'darwin' && host.arch === 'arm64')
  if (ort && host.cmake && host.libclang) return ['--features', 'native']
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

/** The libclang files clang-sys loads (its `build/dynamic.rs`). */
const LIBCLANG_FILE = {
  darwin: /^libclang\.dylib$/,
  linux: /^libclang(-[^/]*)?\.so(\..*)?$/,
  win32: /^libclang\.dll$/
}

/** A subset of the dirs clang-sys searches when `LIBCLANG_PATH` is unset (its `build/common.rs`), so a hit here is one for bindgen too. `*` matches within one path segment. */
const LIBCLANG_DIRS = {
  darwin: [
    '/Library/Developer/CommandLineTools/usr/lib',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib',
    '/usr/local/opt/llvm*/lib'
  ],
  linux: ['/usr/local/llvm*/lib*', '/usr/local/lib*', '/usr/lib*/*/*', '/usr/lib*/*', '/usr/lib*'],
  // clang-sys looks for libclang.dll in the `bin` beside each LLVM `lib`.
  win32: ['C:\\Program Files*\\LLVM\\bin', 'C:\\LLVM\\bin']
}

/** The regex for one segment of a `LIBCLANG_DIRS` pattern: `*` matches within the segment and every other character matches itself. */
export function segmentPattern(/** @type {string} */ segment) {
  const literal = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')
  return new RegExp(`^${literal}$`, 'i')
}

/** The dirs `pattern` names, each `*` matched against the entries of its parent. */
function expand(/** @type {string} */ pattern) {
  const [root, ...segments] = pattern.split(/[\\/]/)
  let dirs = [root === '' ? '/' : `${root}\\`]
  for (const segment of segments) {
    const name = segmentPattern(segment)
    dirs = dirs.flatMap((dir) =>
      segment.includes('*')
        ? entries(dir)
            .filter((e) => name.test(e))
            .map((e) => join(dir, e))
        : [join(dir, segment)]
    )
  }
  return dirs
}

function entries(/** @type {string} */ dir) {
  try {
    return readdirSync(dir)
  } catch {
    // A dir that is not there or not readable holds no libclang.
    return []
  }
}

/** Whether whisper-rs-sys's bindgen finds libclang, as clang-sys searches: only `LIBCLANG_PATH` (a dir or the file) when it is set, else `llvm-config --prefix`, then the usual install dirs. */
export function hasLibclang(
  /** @type {{ platform: string, env: Record<string, string | undefined>, llvmPrefix: () => string | undefined }} */ host
) {
  const { platform } = host
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return false
  const file = LIBCLANG_FILE[platform]
  const holds = (/** @type {string} */ dir) => entries(dir).some((entry) => file.test(entry))
  const pinned = host.env.LIBCLANG_PATH
  if (pinned) {
    const name = basename(pinned)
    return holds(pinned) || (file.test(name) && entries(dirname(pinned)).includes(name))
  }
  const prefix = host.llvmPrefix()
  const dirs = prefix ? ['bin', 'lib', 'lib64'].map((dir) => join(prefix, dir)) : []
  return [...dirs, ...LIBCLANG_DIRS[platform].flatMap(expand)].some(holds)
}

function llvmPrefix() {
  const result = spawnSync('llvm-config', ['--prefix'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.split('\n')[0].trim() || undefined : undefined
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
  const libclang = hasLibclang({ platform: process.platform, env: process.env, llvmPrefix })
  const features = workerFeatures({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    cmake,
    libclang
  })
  const built = features.at(-1) ?? ''
  if (!built.includes('embed') && built !== 'native') {
    console.warn(
      'ORT_LIB_LOCATION is not set: building memry-ml-worker without the embedding model and ' +
        'local transcription. Set it as crates/.cargo/config.toml describes to run them in dev.'
    )
  }
  if (!libclang) {
    console.warn(
      'libclang is not found: building memry-ml-worker without local transcription, since ' +
        "whisper.cpp's bindings are generated with it. Install LLVM (apps/desktop-tauri/AGENTS.md) " +
        'or set LIBCLANG_PATH to the dir that holds it to transcribe voice memos in dev.'
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
