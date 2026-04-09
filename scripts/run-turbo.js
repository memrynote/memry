#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')

const repoRoot = path.resolve(__dirname, '..')
const workspaceRequire = createRequire(path.join(repoRoot, 'package.json'))

function resolveTurboBin() {
  try {
    return workspaceRequire.resolve('turbo/bin/turbo')
  } catch (error) {
    const pnpmStoreDir = path.join(repoRoot, 'node_modules/.pnpm')
    const packageDir = fs
      .readdirSync(pnpmStoreDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('turbo@'))

    if (!packageDir) {
      throw error
    }

    return path.join(pnpmStoreDir, packageDir.name, 'node_modules/turbo/bin/turbo')
  }
}

const result = spawnSync(process.execPath, [resolveTurboBin(), ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit'
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
