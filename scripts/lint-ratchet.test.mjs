import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluate, ruleName, serializeBaseline } from './lint-ratchet.mjs'

const diag = (rule, filename, line = 1, severity = 'warning') => ({
  code: rule,
  severity,
  filename,
  message: `${rule} message`,
  labels: [{ span: { line, column: 3 } }]
})

const anyDiag = (line) => diag('typescript(no-explicit-any)', 'a.ts', line)

const run = (diagnostics, baselineFiles, options = {}) =>
  evaluate({
    diagnostics,
    baselineFiles,
    update: false,
    allowIncrease: false,
    annotate: false,
    ...options
  })

await test('ruleName', async (t) => {
  await t.test('spells core rules bare and the others plugin/rule', () => {
    assert.equal(ruleName('eslint(no-var)'), 'no-var')
    assert.equal(ruleName('typescript(no-explicit-any)'), 'typescript/no-explicit-any')
    assert.equal(ruleName('react-hooks(rules-of-hooks)'), 'react/rules-of-hooks')
    assert.equal(ruleName(undefined), null)
  })
})

await test('lint ratchet', async (t) => {
  const baseline = { 'a.ts': { 'typescript/no-explicit-any': 2 } }
  await t.test('passes when counts match the baseline', () => {
    assert.equal(run([anyDiag(1), anyDiag(2)], baseline).exitCode, 0)
  })

  await t.test('fails on a count above the baseline and lists that file and rule', () => {
    const result = run([anyDiag(1), anyDiag(2), anyDiag(9)], baseline)
    assert.equal(result.exitCode, 1)
    const text = result.stderr.join('\n')
    assert.match(text, /a\.ts {2}typescript\/no-explicit-any: 3 \(baseline 2\)/)
    assert.match(text, /a\.ts:9:3/)
  })

  await t.test('fails on a violation in a file or rule the baseline does not have', () => {
    assert.equal(run([diag('eslint(no-shadow)', 'b.ts')], baseline).exitCode, 1)
  })

  await t.test('fails on any error-level diagnostic, even a baselined rule', () => {
    const result = run([diag('typescript(no-explicit-any)', 'a.ts', 4, 'error')], baseline)
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr.join('\n'), /a\.ts:4:3/)
  })

  await t.test('fails on a diagnostic with no rule, such as a parse error', () => {
    const parseError = { severity: 'warning', filename: 'a.ts', message: 'bad', labels: [] }
    assert.equal(run([parseError], baseline).exitCode, 1)
  })

  await t.test('reports fixed violations without failing and points at --update', () => {
    const result = run([anyDiag(1)], baseline)
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.join('\n'), /1 baselined violation\(s\) are gone/)
  })

  await t.test('emits workflow annotations when asked', () => {
    const result = run([anyDiag(1), anyDiag(2), anyDiag(7)], baseline, { annotate: true })
    assert.match(
      result.stderr.join('\n'),
      /::error file=a\.ts,line=7,col=3,title=typescript\/no-explicit-any::/
    )
  })

  await t.test('--update lowers counts and drops rules that reached zero', () => {
    const result = run([anyDiag(1)], { ...baseline, 'b.ts': { 'no-shadow': 1 } }, { update: true })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.baselineFiles, { 'a.ts': { 'typescript/no-explicit-any': 1 } })
  })

  await t.test('--update refuses to raise a count without --allow-increase', () => {
    const result = run([anyDiag(1), anyDiag(2), anyDiag(3)], baseline, { update: true })
    assert.equal(result.exitCode, 1)
    assert.equal(result.baselineFiles, null)
  })

  await t.test('--update --allow-increase accepts new debt', () => {
    const result = run([anyDiag(1), anyDiag(2), anyDiag(3)], baseline, {
      update: true,
      allowIncrease: true
    })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.baselineFiles, { 'a.ts': { 'typescript/no-explicit-any': 3 } })
  })
})

await test('serializeBaseline', async (t) => {
  await t.test('writes one sorted file per line', () => {
    const text = serializeBaseline({ 'b.ts': { z: 1, a: 2 }, 'a.ts': { x: 1 } })
    assert.deepEqual(JSON.parse(text), {
      version: 1,
      files: { 'a.ts': { x: 1 }, 'b.ts': { a: 2, z: 1 } }
    })
    assert.ok(text.indexOf('"a.ts"') < text.indexOf('"b.ts"'))
    assert.ok(text.includes('{"a":2,"z":1}'))
  })
})
