import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  bundledPackSha256,
  OCR_DATA,
  pdfiumTarget,
  sidecarBuild,
  sidecarFile,
  SIDECARS
} from './build-sidecars.mjs'

const RELEASE_CONFIG = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.release.conf.json', import.meta.url), 'utf8')
)

describe('build-sidecars', () => {
  it('names each sidecar as externalBin expects it per target', () => {
    assert.equal(
      sidecarFile('memry-ml-worker', 'aarch64-pc-windows-msvc'),
      'memry-ml-worker-aarch64-pc-windows-msvc.exe'
    )
    assert.equal(
      sidecarFile('memry-ml-worker', 'x86_64-apple-darwin'),
      'memry-ml-worker-x86_64-apple-darwin'
    )
  })

  it('builds every Rust sidecar the release config bundles', () => {
    assert.deepEqual(
      SIDECARS.map(({ bin }) => `binaries/${bin}`),
      RELEASE_CONFIG.bundle.externalBin
    )
  })

  it('builds a sidecar from crates/ so its .cargo/config.toml applies', () => {
    const { cwd, args } = sidecarBuild(
      'memry-ml-worker',
      'memry-ml-worker',
      'x86_64-pc-windows-msvc'
    )
    assert.equal(cwd, fileURLToPath(new URL('../../../crates', import.meta.url)))
    assert.ok(!args.includes('--manifest-path'))
    assert.ok(existsSync(join(cwd, '.cargo/config.toml')))
    assert.match(
      readFileSync(join(cwd, '.cargo/config.toml'), 'utf8'),
      /CMAKE_MSVC_RUNTIME_LIBRARY = "MultiThreaded"/
    )
  })

  it('maps the five release targets to their pdfium builds and refuses others', () => {
    assert.equal(pdfiumTarget('x86_64-apple-darwin'), 'darwin-x64')
    assert.equal(pdfiumTarget('aarch64-pc-windows-msvc'), 'win32-arm64')
    assert.equal(pdfiumTarget('x86_64-unknown-linux-gnu'), 'linux-x64')
    assert.throws(() => pdfiumTarget('i686-pc-windows-msvc'), /no release target/)
  })

  it('reads the English data pin from ocr.rs, which the committed data matches', () => {
    const ocr = readFileSync(
      new URL('../../../crates/memry-desktop/src/services/file_text/ocr.rs', import.meta.url),
      'utf8'
    )
    const pin = bundledPackSha256(ocr)
    assert.equal(pin, '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91')
    assert.equal(createHash('sha256').update(readFileSync(OCR_DATA)).digest('hex'), pin)
    assert.throws(() => bundledPackSha256('const X: &str = "";'), /no BUNDLED_PACK_SHA256/)
  })
})
