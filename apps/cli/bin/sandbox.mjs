#!/usr/bin/env node

// Runs the sandbox vault generator under Electron's Node. The workspace's
// better-sqlite3 binary is built for Electron (apps/desktop/scripts/ensure-native.sh),
// and flipping it to plain Node would break every other `pnpm dev` session.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.resolve(here, '../src/sandbox/index.ts')
const electron = createRequire(path.resolve(here, '../../desktop/package.json'))('electron')

const result = spawnSync(
  electron,
  [
    '--no-warnings',
    '--experimental-strip-types',
    '--experimental-transform-types',
    entry,
    ...process.argv.slice(2)
  ],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
)

process.exitCode = result.status ?? 1
