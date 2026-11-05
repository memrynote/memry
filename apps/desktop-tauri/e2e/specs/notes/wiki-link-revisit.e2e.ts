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

import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const NOTE_TITLE = 'textarea[aria-label="Note title"]'
const NOTE_EDITOR = '[aria-label="Rich text editor"] [contenteditable="true"]'

interface NoteView {
  id: string
  path: string
  title: string
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

async function createNotes(
  page: Page,
  notes: Array<{ title: string; content: string }>
): Promise<NoteView[]> {
  const created: NoteView[] = []
  for (const input of notes) created.push(await invoke<NoteView>(page, 'notes_create', { input }))
  return created
}

/** Opens a vault-root note from the Collections tree, as a user does. */
async function open(page: Page, note: NoteView): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  // The section opens through a 100 ms transition inside an overflow-hidden box. The driver
  // scrolls a row it clicks into view, which scrolls that box mid-transition; the box springs
  // back when the transition ends and the click lands on the row above.
  await expect
    .poll(() =>
      page
        .locator('#section-content-collections > div')
        .evaluate(
          (box: HTMLElement) => box.clientHeight > 0 && box.scrollHeight <= box.clientHeight
        )
    )
    .toBe(true)
  await page.locator(`[data-tree-node-id="${note.id}"]`).click()
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(note.title)
  await expect(page.locator(NOTE_EDITOR).first()).toBeVisible()
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
  await ready(page)
  const [a, b, other] = ['Alpha', 'Beta', 'Elsewhere'].map((name) => `${name} ${stamp()}`)
  const [, , elsewhere, src] = await createNotes(page, [
    { title: a, content: 'A.\n' },
    { title: b, content: 'B.\n' },
    { title: other, content: 'Somewhere else.\n' },
    { title: `Revisit ${stamp()}`, content: `[[${a}]] [[${b}]]\n\nMore text [[${a}]] here.\n` }
  ])

  for (let round = 0; round < 4; round++) {
    await open(page, src)
    await expect.poll(() => editorState(page)).toEqual({ chips: 3, rawBrackets: false })
    // Stay long enough for a write-back and any follow-up update to land; the chips stay.
    await page.waitForTimeout(1500)
    expect(await editorState(page)).toEqual({ chips: 3, rawBrackets: false })
    await open(page, elsewhere)
  }
})

// The reported note's shape: a code block used as a heading, with a list indented under it.
// Open-time promotion skipped a code block's children.
test('links in a list nested under a code block are chips on every visit', async ({ page }) => {
  await ready(page)
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
    await open(page, src)
    await expect.poll(() => editorState(page)).toEqual({ chips: 2, rawBrackets: false })
    await open(page, elsewhere)
  }
})

test('links written into the file while the note is open become chips and stay chips', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const target = `Target ${stamp()}`
  const [, src] = await createNotes(page, [
    { title: target, content: 'A target.\n' },
    { title: `Open Edit ${stamp()}`, content: 'Nothing linked yet.\n' }
  ])
  await open(page, src)
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
