#!/usr/bin/env node
/**
 * Lint gate for the whole repo: oxlint (type-aware) plus a ratchet.
 *
 * A rule with no violations is configured as an error. A rule that still has a
 * backlog is a warning, and this script holds it at the per-file counts in
 * scripts/lint-baseline.json: a count may fall but never rise. oxlint.config.mts
 * reads the same baseline, so a rule whose last violation is fixed becomes an
 * error as soon as `--update` drops it from the baseline.
 *
 *   node scripts/lint-ratchet.mjs                       check (CI, `pnpm lint`)
 *   node scripts/lint-ratchet.mjs --update              lock in lower counts
 *   node scripts/lint-ratchet.mjs --update --allow-increase   accept new debt
 *   node scripts/lint-ratchet.mjs --github              force workflow annotations
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = resolve(repoRoot, 'scripts/lint-baseline.json')

// oxlint labels a diagnostic `plugin(rule)`. The config spells core rules bare and
// every other rule `plugin/rule`; the React Compiler rules report as `react-hooks`.
const PLUGIN_ALIASES = { eslint: '', 'react-hooks': 'react' }

export function ruleName(code) {
  const match = /^(.+?)\((.+)\)$/.exec(code ?? '')
  if (!match) return null
  const plugin = PLUGIN_ALIASES[match[1]] ?? match[1]
  return plugin ? `${plugin}/${match[2]}` : match[2]
}

/** Splits oxlint's JSON diagnostics into hard errors and warnings grouped by file and rule. */
export function classify(diagnostics) {
  const errors = []
  const warnings = new Map()
  for (const diagnostic of diagnostics) {
    const rule = ruleName(diagnostic.code)
    if (diagnostic.severity === 'error' || !rule) {
      errors.push(diagnostic)
      continue
    }
    const key = `${diagnostic.filename}\0${rule}`
    const group = warnings.get(key) ?? { file: diagnostic.filename, rule, diagnostics: [] }
    group.diagnostics.push(diagnostic)
    warnings.set(key, group)
  }
  return { errors, warnings: [...warnings.values()] }
}

/** Compares warning groups with the baseline: what rose, and how much fell. */
export function compare(warnings, baselineFiles) {
  const increased = []
  let fixed = 0
  const seen = new Set()
  for (const group of warnings) {
    const allowed = baselineFiles[group.file]?.[group.rule] ?? 0
    seen.add(`${group.file}\0${group.rule}`)
    const count = group.diagnostics.length
    if (count > allowed) increased.push({ ...group, allowed })
    else fixed += allowed - count
  }
  for (const [file, rules] of Object.entries(baselineFiles)) {
    for (const [rule, allowed] of Object.entries(rules)) {
      if (!seen.has(`${file}\0${rule}`)) fixed += allowed
    }
  }
  return { increased, fixed }
}

export function toBaselineFiles(warnings) {
  const files = {}
  for (const { file, rule, diagnostics } of warnings) {
    files[file] ??= {}
    files[file][rule] = diagnostics.length
  }
  return files
}

/** One file per line keeps baseline diffs reviewable. */
export function serializeBaseline(files) {
  const sorted = Object.keys(files).sort()
  const lines = sorted.map((file) => {
    const rules = Object.fromEntries(
      Object.entries(files[file]).sort(([a], [b]) => (a < b ? -1 : 1))
    )
    return `    ${JSON.stringify(file)}: ${JSON.stringify(rules)}`
  })
  return `{\n  "version": 1,\n  "files": {\n${lines.join(',\n')}\n  }\n}\n`
}

function location(diagnostic) {
  const span = diagnostic.labels?.[0]?.span
  return { line: span?.line ?? 1, column: span?.column ?? 1 }
}

function format(diagnostic, rule, annotate) {
  const { line, column } = location(diagnostic)
  const name = rule ?? diagnostic.code ?? 'parse-error'
  if (annotate) {
    const message = diagnostic.message.replace(/\r?\n/g, ' ')
    return `::error file=${diagnostic.filename},line=${line},col=${column},title=${name}::${message}`
  }
  return `  ${diagnostic.filename}:${line}:${column}  ${name}  ${diagnostic.message}`
}

function runOxlint({ everythingWarns }) {
  const result = spawnSync(
    resolve(repoRoot, 'node_modules/.bin/oxlint'),
    ['--format', 'json', '.'],
    {
      cwd: repoRoot,
      env: { ...process.env, LINT_RATCHET_ALL_WARN: everythingWarns ? '1' : '0' },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024
    }
  )
  try {
    return JSON.parse(result.stdout).diagnostics
  } catch {
    process.stderr.write(`${result.stdout}${result.stderr}`)
    throw new Error('oxlint did not produce JSON output (config or tsgolint failure above)')
  }
}

/** Decides the outcome of one run; `main` only does the I/O around it. */
export function evaluate({ diagnostics, baselineFiles, update, allowIncrease, annotate }) {
  const { errors, warnings } = classify(diagnostics)
  const out = { exitCode: 0, stdout: [], stderr: [], baselineFiles: null }

  if (errors.length > 0) {
    out.exitCode = 1
    out.stderr.push(`${errors.length} lint error(s):`)
    for (const diagnostic of errors) {
      out.stderr.push(format(diagnostic, ruleName(diagnostic.code), annotate))
    }
    return out
  }

  const { increased, fixed } = compare(warnings, baselineFiles)

  if (increased.length > 0 && !(update && allowIncrease)) {
    out.exitCode = 1
    out.stderr.push(
      'Lint violations above the baseline (every occurrence in each affected file is listed):'
    )
    for (const group of increased) {
      out.stderr.push(
        `${group.file}  ${group.rule}: ${group.diagnostics.length} (baseline ${group.allowed})`
      )
      for (const diagnostic of group.diagnostics) {
        out.stderr.push(format(diagnostic, group.rule, annotate))
      }
    }
    out.stderr.push('\nFix them, or run `pnpm lint --update --allow-increase` to accept the debt.')
    return out
  }

  if (update) {
    out.baselineFiles = toBaselineFiles(warnings)
    out.stdout.push(
      `Baseline updated: ${fixed} fewer violation(s), ${increased.length} group(s) raised.`
    )
    return out
  }

  if (fixed > 0) {
    out.stdout.push(
      `${fixed} baselined violation(s) are gone. Run \`pnpm lint --update\` to lock that in.`
    )
  }
  const total = warnings.reduce((sum, group) => sum + group.diagnostics.length, 0)
  out.stdout.push(`Lint passed: no errors, ${total} baselined warning(s) held.`)
  return out
}

function main(argv) {
  const update = argv.includes('--update')
  const allowIncrease = argv.includes('--allow-increase')
  const annotate = argv.includes('--github') || process.env.GITHUB_ACTIONS === 'true'

  let baselineFiles = {}
  try {
    baselineFiles = JSON.parse(readFileSync(baselinePath, 'utf8')).files
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const result = evaluate({
    diagnostics: runOxlint({ everythingWarns: update && allowIncrease }),
    baselineFiles,
    update,
    allowIncrease,
    annotate
  })
  for (const line of result.stdout) console.log(line)
  for (const line of result.stderr) console.error(line)
  if (result.baselineFiles) writeFileSync(baselinePath, serializeBaseline(result.baselineFiles))
  return result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
