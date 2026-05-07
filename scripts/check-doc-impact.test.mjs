import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatDocImpactReport, resolveDocImpact } from './check-doc-impact.mjs'

describe('docs impact checker', () => {
  const config = {
    rules: [
      {
        sources: ['apps/desktop/src/main/ipc/**', 'packages/contracts/src/**'],
        docs: ['apps/docs/src/architecture/ipc.md']
      },
      {
        sources: ['apps/sync-server/**'],
        docs: [
          'apps/docs/src/architecture/sync-protocol.md',
          'apps/docs/src/user-guide/sync/how-sync-works.md'
        ]
      }
    ]
  }

  it('maps changed source files to impacted docs with source reasons', () => {
    const impact = resolveDocImpact(config, [
      'packages/contracts/src/ipc-auth.ts',
      'apps/sync-server/src/routes/sync.ts',
      'README.md'
    ])

    assert.deepEqual(impact.impactedDocs, [
      {
        docPath: 'apps/docs/src/architecture/ipc.md',
        isChanged: false,
        sourcePaths: ['packages/contracts/src/ipc-auth.ts']
      },
      {
        docPath: 'apps/docs/src/architecture/sync-protocol.md',
        isChanged: false,
        sourcePaths: ['apps/sync-server/src/routes/sync.ts']
      },
      {
        docPath: 'apps/docs/src/user-guide/sync/how-sync-works.md',
        isChanged: false,
        sourcePaths: ['apps/sync-server/src/routes/sync.ts']
      }
    ])
  })

  it('tracks whether suggested docs were changed', () => {
    const impact = resolveDocImpact(config, [
      'apps/sync-server/src/services/sync.ts',
      'apps/docs/src/architecture/sync-protocol.md'
    ])

    assert.equal(impact.impactedDocs[0].isChanged, true)
    assert.equal(impact.impactedDocs[1].isChanged, false)
    assert.equal(impact.hasChangedImpactedDocs, true)
    assert.equal(impact.hasUnchangedImpactedDocs, true)
  })

  it('formats a concise report for agents', () => {
    const impact = resolveDocImpact(config, ['apps/desktop/src/main/ipc/index.ts'])
    const report = formatDocImpactReport(impact)

    assert.match(report, /apps\/docs\/src\/architecture\/ipc\.md/)
    assert.match(report, /apps\/desktop\/src\/main\/ipc\/index\.ts/)
    assert.match(report, /Read each listed page/)
  })
})
