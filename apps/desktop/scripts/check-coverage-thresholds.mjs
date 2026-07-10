#!/usr/bin/env node
// Enforces the coverage ratchet floors against a coverage-summary.json produced
// by the test run. Split out of the test job so the CI "Coverage thresholds"
// check is distinct from "Unit & integration tests": a coverage regression
// shows up as its own red badge instead of masquerading as a failing test.
//
// Floors come from config/coverage-thresholds.json — the same file vitest.config.ts
// reads — so local `pnpm test` and this gate can never disagree.

import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const thresholdsPath = resolve(here, '../config/coverage-thresholds.json')
const summaryPath = resolve(here, '../coverage/coverage-summary.json')

const METRICS = ['statements', 'branches', 'functions', 'lines']

const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`Could not read ${label} at ${path}: ${err.message}`)
    process.exit(1)
  }
}

const thresholds = readJson(thresholdsPath, 'coverage thresholds')
const total = readJson(summaryPath, 'coverage summary').total

let failed = false
for (const metric of METRICS) {
  const pct = total?.[metric]?.pct
  const floor = thresholds[metric]
  if (typeof pct !== 'number') {
    console.error(`FAIL  ${metric.padEnd(11)} missing from coverage summary`)
    failed = true
    continue
  }
  const ok = pct >= floor
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(11)} ${pct.toFixed(2)}%  (floor ${floor}%)`)
}

if (failed) {
  console.error(
    '\nCoverage below the ratchet floor. Add tests to raise it, or — if this is' +
      '\nmeasured baseline drift, not a regression — update the floor in' +
      '\napps/desktop/config/coverage-thresholds.json.'
  )
  process.exit(1)
}

console.log('\nAll coverage thresholds met.')
