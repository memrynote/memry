#!/usr/bin/env node
// Builds native/eventkit/bin/memry-eventkit, the macOS Calendar bridge (#1405).
//
// macOS only. On Windows and Linux this exits 0 without touching anything, so
// no install, dev or packaging step there can fail because of it. The binary is
// universal (arm64 + x86_64) and only rebuilt when the Swift source is newer.
//
//   node scripts/build-eventkit-helper.mjs            build if stale
//   node scripts/build-eventkit-helper.mjs --force    always rebuild
//   node scripts/build-eventkit-helper.mjs --optional never fail (dev convenience)

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(appRoot, 'native', 'eventkit', 'main.swift')
const outputPath = join(appRoot, 'native', 'eventkit', 'bin', 'memry-eventkit')
// Keep in step with the oldest macOS the bundled Electron supports.
const deploymentTarget = '12.0'
const archs = ['arm64', 'x86_64']

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const optional = args.has('--optional')

function log(message) {
  console.log(`[eventkit-helper] ${message}`)
}

function isStale() {
  if (!existsSync(outputPath)) return true
  return statSync(sourcePath).mtimeMs > statSync(outputPath).mtimeMs
}

function build() {
  const workDir = mkdtempSync(join(tmpdir(), 'memry-eventkit-'))
  try {
    const slices = archs.map((arch) => {
      const slicePath = join(workDir, `memry-eventkit-${arch}`)
      execFileSync(
        'xcrun',
        [
          'swiftc',
          '-O',
          // Swift 6 strict concurrency buys nothing in a single-queue helper.
          '-swift-version',
          '5',
          '-target',
          `${arch}-apple-macos${deploymentTarget}`,
          '-framework',
          'EventKit',
          sourcePath,
          '-o',
          slicePath
        ],
        { stdio: 'inherit' }
      )
      return slicePath
    })
    mkdirSync(dirname(outputPath), { recursive: true })
    execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', outputPath], {
      stdio: 'inherit'
    })
    // Ad-hoc signature for dev runs. Packaging re-signs it with the app's
    // Developer ID identity and entitlements.
    execFileSync('codesign', ['--force', '--sign', '-', outputPath], { stdio: 'inherit' })
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.platform !== 'darwin') {
  log(`skipped on ${process.platform}: the macOS Calendar bridge is macOS only`)
  process.exit(0)
}

if (!force && !isStale()) {
  log('up to date')
  process.exit(0)
}

try {
  build()
  log(`built ${outputPath}`)
} catch (error) {
  if (!optional) throw error
  log(
    `build failed; macOS Calendar will report "unavailable" until it builds (${error instanceof Error ? error.message : String(error)})`
  )
}
