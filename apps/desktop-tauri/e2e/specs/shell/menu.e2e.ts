// The native application menu is built from the shared command table (inv09 #8).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'

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
