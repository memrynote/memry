#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts')
const result = spawnSync(
  process.execPath,
  [
    '--no-warnings',
    '--experimental-strip-types',
    '--experimental-transform-types',
    entry,
    ...process.argv.slice(2)
  ],
  { stdio: 'inherit' }
)

process.exitCode = result.status ?? 1
