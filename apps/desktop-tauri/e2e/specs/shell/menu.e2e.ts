// The native application menu is built from the shared command table (inv09 #8).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { appReady } from '../../harness/app-ready'
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
  const chosen = await invoke<string | null>(page, 'shell_show_context_menu', {
    items: [{ id: 'rename', label: 'Rename' }]
  })
  expect(chosen).toBe('rename')
})

// On Linux `e2e_clipboard_write` leaves the app's GTK main loop owning the clipboard, as a copy in
// the page does, so a read on the main thread (where menu items run) would wait on itself.
test('the clipboard text reads back, and Paste and Match Style inserts it as plain text', async ({
  app,
  page
}) => {
  await appReady(page)
  const text = 'Plain <b>pasted</b> text'
  await invokeTest(app, 'e2e_clipboard_write', { text })
  expect(await invoke<string>(page, 'shell_clipboard_read_text')).toBe(text)

  await page.evaluate(() => {
    const field = document.createElement('textarea')
    field.id = 'paste-target'
    document.body.append(field)
    field.focus()
  })
  await invokeTest(app, 'e2e_menu_activate', { id: 'edit.pasteAndMatchStyle' })
  await expect(page.locator('#paste-target')).toHaveValue(text)
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

// A bare Alt reaches the frameless window as `WM_SYSCOMMAND` `SC_KEYMENU`. Left to
// `DefWindowProc`, it starts the keyboard mode of the hidden system menu, which shows nothing
// and holds the main thread, so the app's menu that the same Alt asks for waited for another key.
test('Windows: the SC_KEYMENU of a bare Alt leaves the main thread out of menu mode', async ({
  app,
  page
}) => {
  test.skip(process.platform !== 'win32', 'only Windows has the system menu keyboard mode')
  await appReady(page)
  expect(await invokeTest<boolean>(app, 'e2e_bare_alt_menu_mode')).toBe(false)
})
