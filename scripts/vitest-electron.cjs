#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')

const electron = require('electron')
const vitestEntry = require.resolve('vitest/vitest.mjs')

const result = spawnSync(electron, [vitestEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

if (result.error) {
  process.stderr.write(`${String(result.error)}\n`)
  process.exit(1)
}

process.exit(result.status ?? 1)
