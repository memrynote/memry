// A relation property's chips in the running app (#3530 13q-2b): the note's file names its
// targets as `memry://note/<id>` values, `properties_resolve_refs` resolves them, and the panel
// shows the live target by its title and a missing one as deleted. The values are written to
// disk, as a sync or another app leaves them.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { openNoteByHandle } from '../../harness/note-sync-helpers'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

interface CreatedNote {
  id: string
  title: string
  path: string
  frontmatter: Record<string, unknown>
}

test('a relation shows its live target by title and a missing one as deleted', async ({
  page,
  testVaultPath
}) => {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
  const stamp = Date.now()
  const target = await invoke<CreatedNote>(page, 'notes_create', {
    input: { title: `Relation target ${stamp}` }
  })
  const source = await invoke<CreatedNote>(page, 'notes_create', {
    input: { title: `Relation source ${stamp}`, content: 'Links out.' }
  })
  const file = join(testVaultPath, source.path)
  const related = `related:\n  - memry://note/${target.id}\n  - memry://note/n-gone\n`
  const text = readFileSync(file, 'utf8')
  writeFileSync(
    file,
    text.startsWith('---\n') ? `---\n${related}${text.slice(4)}` : `---\n${related}---\n${text}`
  )
  await expect
    .poll(
      async () =>
        (await invoke<CreatedNote>(page, 'notes_get', { id: source.id })).frontmatter.related
    )
    .toEqual([`memry://note/${target.id}`, 'memry://note/n-gone'])

  await openNoteByHandle(page, { id: source.id, title: source.title })
  await expect(page.getByTestId('relation-chip')).toContainText(target.title)
  await expect(page.getByTestId('relation-chip-deleted')).toBeVisible()
})
