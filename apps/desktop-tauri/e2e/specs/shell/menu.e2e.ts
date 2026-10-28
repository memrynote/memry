// The native application menu is built from the shared command table (inv09 #8).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { invoke } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

interface MenuNode {
  kind: string
  id: string | null
  label: string
  accelerator: string | null
  children: MenuNode[]
}

function flatten(nodes: MenuNode[]): MenuNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

test('the menu lists File, Edit and Help with the command items', async ({ app }) => {
  const tree = await invokeTest<MenuNode[]>(app, 'e2e_menu_tree')
  const labels = new Set(tree.map((node) => node.label))
  for (const label of ['File', 'Edit', 'Insert', 'Format', 'View', 'Help']) {
    expect(labels.has(label)).toBe(true)
  }
  const ids = new Set(flatten(tree).map((node) => node.id))
  for (const id of ['nav.newNote', 'tabs.closeTab', 'help.documentation']) {
    expect(ids.has(id)).toBe(true)
  }
})

test('a context menu answers with the queued selection', async ({ app, page }) => {
  await invokeTest(app, 'e2e_set_next_context_menu_selection', { selection: 'rename' })
  const chosen = await page.evaluate(async () => {
    const api = (
      window as unknown as { api: { showContextMenu: (i: unknown[]) => Promise<string | null> } }
    ).api
    return api.showContextMenu([{ id: 'rename', label: 'Rename' }])
  })
  expect(chosen).toBe('rename')
})

test('Linux: the menu bar is hidden after the window shows, and the first bare Alt shows it', async ({
  app,
  page
}) => {
  test.skip(process.platform !== 'linux', 'only Linux attaches the menu bar to the window')
  const shown = await pollUntil(async () => {
    const windows = await invokeTest<{ label: string; visible: boolean }[]>(app, 'e2e_windows')
    return windows.some((w) => w.label === 'main' && w.visible)
  })
  expect(shown).toBe(true)
  expect(await invokeTest<boolean | null>(app, 'e2e_menu_bar_visible')).toBe(false)
  expect(await invoke<boolean>(page, 'menu_toggle_alt')).toBe(true)
  expect(await invokeTest<boolean | null>(app, 'e2e_menu_bar_visible')).toBe(true)
  expect(await invoke<boolean>(page, 'menu_toggle_alt')).toBe(false)
  expect(await invokeTest<boolean | null>(app, 'e2e_menu_bar_visible')).toBe(false)
})
