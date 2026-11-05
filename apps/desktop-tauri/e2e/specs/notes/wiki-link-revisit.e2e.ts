// Wiki links on a note that is revisited, or changed from outside while open, ported from
// Electron's `wiki-link-revisit.e2e.ts` (Step 13q-5, #3530).
//
// A note's markdown holds `[[X]]` as plain text; only the renderer turns it into a chip. That
// text reaches the editor on open, and as an update to an editor that is already open (an
// outside file edit, a sync pull). In Electron a promotion written during the update's render
// reached ProseMirror but not the document, and the next change re-rendered `[[a]] [[b]]` as
// text until the user clicked into it.
//
// Electron runs each case twice, with the CRDT store and with its preflight forced to fail
// (`MEMRY_TEST_CRDT_PREFLIGHT_CRASH`). The Tauri app has no preflight child and the switch is
// retired (e2e/HOOKS.md), so each case runs once.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { NOTE_EDITOR, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

interface NoteView {
  id: string
  path: string
  title: string
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function createNotes(
  page: Page,
  notes: Array<{ title: string; content: string }>
): Promise<NoteView[]> {
  const created: NoteView[] = []
  for (const input of notes) created.push(await invoke<NoteView>(page, 'notes_create', { input }))
  return created
}

/** What the reader sees: the chips rendered, and whether any `[[` is left as text. */
function editorState(page: Page): Promise<{ chips: number; rawBrackets: boolean }> {
  return page
    .locator(NOTE_EDITOR)
    .first()
    .evaluate((editor: HTMLElement) => ({
      chips: editor.querySelectorAll('[data-wiki-link]').length,
      rawBrackets: editor.innerText.includes('[[')
    }))
}

test('a note left and reopened still shows its links as chips', async ({ page }) => {
  await vaultOpen(page)
  const [a, b, other] = ['Alpha', 'Beta', 'Elsewhere'].map((name) => `${name} ${stamp()}`)
  const [, , elsewhere, src] = await createNotes(page, [
    { title: a, content: 'A.\n' },
    { title: b, content: 'B.\n' },
    { title: other, content: 'Somewhere else.\n' },
    { title: `Revisit ${stamp()}`, content: `[[${a}]] [[${b}]]\n\nMore text [[${a}]] here.\n` }
  ])

  for (let round = 0; round < 4; round++) {
    await openFromSidebar(page, src)
    await expect.poll(() => editorState(page)).toEqual({ chips: 3, rawBrackets: false })
    // Stay long enough for a write-back and any follow-up update to land; the chips stay.
    await page.waitForTimeout(1500)
    expect(await editorState(page)).toEqual({ chips: 3, rawBrackets: false })
    await openFromSidebar(page, elsewhere)
  }
})

// The reported note's shape: a code block used as a heading, with a list indented under it.
// Open-time promotion skipped a code block's children.
test('links in a list nested under a code block are chips on every visit', async ({ page }) => {
  await vaultOpen(page)
  const [a, b, other] = ['Module A', 'Module B', 'Elsewhere'].map((name) => `${name} ${stamp()}`)
  const dash =
    '<span style="color:rgb(255, 255, 255);background-color:rgb(26, 26, 26)">\u2014\u2014\u2014 </span>'
  const [, , elsewhere, src] = await createNotes(page, [
    { title: a, content: 'A.\n' },
    { title: b, content: 'B.\n' },
    { title: other, content: 'Somewhere else.\n' },
    {
      title: `Grades ${stamp()}`,
      content: [
        '```text',
        ' modules & gpa:',
        '```',
        '',
        '<!-- memry:block-nesting-level=1 -->',
        '',
        `- *[[${a}]]* ${dash}`,
        '',
        `- *[[${b}]]* ${dash}`,
        '',
        '##### `gpa:`',
        '',
        '<!-- memry:block-nesting-level=0 -->',
        ''
      ].join('\n')
    }
  ])

  for (let round = 0; round < 3; round++) {
    await openFromSidebar(page, src)
    await expect.poll(() => editorState(page)).toEqual({ chips: 2, rawBrackets: false })
    await openFromSidebar(page, elsewhere)
  }
})

test('links written into the file while the note is open become chips and stay chips', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  const target = `Target ${stamp()}`
  const [, src] = await createNotes(page, [
    { title: target, content: 'A target.\n' },
    { title: `Open Edit ${stamp()}`, content: 'Nothing linked yet.\n' }
  ])
  await openFromSidebar(page, src)
  // An editor that has not loaded yet also has no chips, and a write racing that load would never
  // reach an already-open editor, which is the path this case exists for.
  await expect
    .poll(() => page.locator(NOTE_EDITOR).first().innerText())
    .toContain('Nothing linked yet.')
  await expect.poll(() => editorState(page)).toEqual({ chips: 0, rawBrackets: false })

  // When another app adds links to the file while it is open here,
  const file = join(testVaultPath, src.path)
  writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\n[[${target}]] [[${target}]]\n`)
  await expect
    .poll(() => editorState(page), { timeout: 30_000 })
    .toEqual({ chips: 2, rawBrackets: false })

  // and a later, unrelated change arrives the same way,
  writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\nAn unrelated line.\n`)
  await expect
    .poll(() => page.locator(NOTE_EDITOR).first().innerText())
    .toContain('An unrelated line.')

  // then the links are still chips.
  await page.waitForTimeout(1000)
  expect(await editorState(page)).toEqual({ chips: 2, rawBrackets: false })
})
