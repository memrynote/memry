import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { analyzeDocsImpact, buildDocsUpdatePrompt } from './docs-impact.mjs'

describe('docs impact automation', () => {
  it('requires docs when desktop code changes without docs changes', () => {
    const result = analyzeDocsImpact([
      'apps/desktop/src/main/ipc/settings-handlers.ts',
      'packages/contracts/src/settings.ts'
    ])

    assert.deepEqual(result, {
      docsChanged: false,
      docsRelevantChanged: true,
      relevantFiles: [
        'apps/desktop/src/main/ipc/settings-handlers.ts',
        'packages/contracts/src/settings.ts'
      ],
      status: 'missing-docs'
    })
  })

  it('treats sync-server changes as covered when docs change too', () => {
    const result = analyzeDocsImpact([
      'apps/sync-server/src/routes/sync.ts',
      'apps/docs/src/architecture/sync-protocol.md'
    ])

    assert.equal(result.status, 'covered')
    assert.equal(result.docsChanged, true)
    assert.equal(result.docsRelevantChanged, true)
    assert.deepEqual(result.relevantFiles, ['apps/sync-server/src/routes/sync.ts'])
  })

  it('does not require docs for docs-only changes', () => {
    const result = analyzeDocsImpact(['apps/docs/src/contribute/workflow.md'])

    assert.equal(result.status, 'not-needed')
    assert.equal(result.docsChanged, true)
    assert.equal(result.docsRelevantChanged, false)
  })

  it('builds a scoped AI prompt for docs updates', () => {
    const prompt = buildDocsUpdatePrompt({
      baseRef: 'origin/main',
      relevantFiles: ['apps/desktop/src/main/updater.ts', 'apps/sync-server/src/routes/auth.ts']
    })

    assert.match(prompt, /Update Memry docs for the current branch diff against origin\/main/)
    assert.match(prompt, /apps\/docs\/src\/\*\*/)
    assert.match(prompt, /Do not edit application code/)
    assert.match(prompt, /pnpm docs:build/)
    assert.match(prompt, /apps\/desktop\/src\/main\/updater\.ts/)
    assert.match(prompt, /apps\/sync-server\/src\/routes\/auth\.ts/)
  })
})
