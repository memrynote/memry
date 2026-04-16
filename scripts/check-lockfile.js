#!/usr/bin/env node

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml')
const snapshotPath = path.join(os.tmpdir(), `memry-lockfile-${process.pid}.yaml`)

function cleanup() {
  if (fs.existsSync(snapshotPath)) {
    fs.unlinkSync(snapshotPath)
  }
}

function finish(code, message) {
  cleanup()
  if (message) {
    const stream = code === 0 ? process.stdout : process.stderr
    stream.write(`${message}\n`)
  }
  process.exit(code)
}

function run(command) {
  execSync(command, { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] })
}

process.on('SIGINT', () => finish(130))
process.on('SIGTERM', () => finish(143))

if (!fs.existsSync(lockfilePath)) {
  finish(1, '\n  pnpm-lock.yaml not found. Are you at the repo root?\n')
}

console.log('Snapshotting current lockfile...')
fs.copyFileSync(lockfilePath, snapshotPath)

console.log('Regenerating lockfile (pnpm install --lockfile-only --ignore-scripts)...')
run('pnpm install --lockfile-only --ignore-scripts')

const before = fs.readFileSync(snapshotPath)
const after = fs.readFileSync(lockfilePath)

if (before.equals(after)) {
  finish(0, '\nLockfile is clean.')
}

fs.copyFileSync(snapshotPath, lockfilePath)
finish(
  1,
  '\n  pnpm-lock.yaml would change after "pnpm install". Lockfile is drifted.\n' +
    '  Fix: run "pnpm install" and commit the regenerated pnpm-lock.yaml.\n',
)
