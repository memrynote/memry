import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const prePush = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8')

describe('pre-push hook policy', () => {
  it('leaves lint, typecheck, and test suites to GitHub Actions', () => {
    assert.doesNotMatch(prePush, /MEMRY_HOOK_STRICT/)

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
      assert.doesNotMatch(prePush, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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

  it('keeps the docs impact gate in the pre-push hook', () => {
    assert.match(prePush, /pnpm docs:impact --base "\$base_commit" --strict/)
    assert.doesNotMatch(prePush, /pnpm docs:build/)
  })
})
