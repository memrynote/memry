import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const prePush = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8')

describe('pre-push hook policy', () => {
  it('keeps heavy checks behind explicit strict mode', () => {
    assert.match(prePush, /MEMRY_HOOK_STRICT/)

    const strictModeStart = prePush.indexOf('MEMRY_HOOK_STRICT')
    assert.notEqual(strictModeStart, -1)

    const strictModeSection = prePush.slice(strictModeStart)
    for (const command of [
      'pnpm repair:links',
      'pnpm check:contracts',
      'pnpm check:architecture',
      'pnpm typecheck:packages',
      'pnpm lint:desktop',
      'pnpm ipc:check',
      'pnpm typecheck:desktop',
      'pnpm test:desktop',
      'pnpm typecheck:sync-server',
      'pnpm test:sync-server'
    ]) {
      assert.match(strictModeSection, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })

  it('keeps docs AI updates opt-in instead of running them on every push', () => {
    assert.match(prePush, /MEMRY_DOCS_AI_AUTO:-0/)

    const docsAutoStart = prePush.indexOf('MEMRY_DOCS_AI_AUTO:-0')
    const docsUpdaterCommand = prePush.indexOf('pnpm docs:ai-update --base "$base_commit"')
    assert.notEqual(docsAutoStart, -1)
    assert.notEqual(docsUpdaterCommand, -1)
    assert.ok(docsUpdaterCommand > docsAutoStart)
  })

  it('does not build docs unless strict mode is requested', () => {
    const strictModeStart = prePush.indexOf('MEMRY_HOOK_STRICT')
    assert.notEqual(strictModeStart, -1)

    const quickModeSection = prePush.slice(0, strictModeStart)
    assert.doesNotMatch(quickModeSection, /pnpm docs:build/)
  })
})
