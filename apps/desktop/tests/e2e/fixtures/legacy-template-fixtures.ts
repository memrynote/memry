import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { test as base } from './sync-auth-fixtures'

export const LEGACY_TEMPLATE_ID = 'legacy-tpl-1'
export const LEGACY_TEMPLATE_NAME = 'Legacy Standup'
export const LEGACY_TEMPLATE_BODY = '## Legacy Blockers'

/**
 * Writes a pre-sync template file into device A's vault BEFORE the app launches.
 *
 * vaultPathA is overridden rather than written from the test body because
 * electronAppA depends on vaultPathA, so Playwright resolves this fixture first.
 * Every other e2e seeds after launch and reindexes; the migration only runs on
 * vault open, so it must be on disk beforehand.
 */
export const test = base.extend({
  vaultPathA: async ({ vaultPathA }, use) => {
    const dir = path.join(vaultPathA, '.memry', 'templates')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${LEGACY_TEMPLATE_ID}.md`),
      matter.stringify(LEGACY_TEMPLATE_BODY, {
        id: LEGACY_TEMPLATE_ID,
        name: LEGACY_TEMPLATE_NAME,
        isBuiltIn: false,
        tags: ['daily'],
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
    )
    await use(vaultPathA)
  }
})

export { expect } from './sync-auth-fixtures'
