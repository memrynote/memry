// TEMPORARY FLAKE-7D probe: does another X11 client taking the PRIMARY selection clear the app's
// DOM selection? Linux only.
import { spawn } from 'node:child_process'
import { openNewNote, setBlocks } from '../../harness/editor'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import { tableBlock } from '../../harness/table'
import { test, expect } from '../../harness/test'

const STEAL = `
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, GLib
cb = Gtk.Clipboard.get(Gdk.SELECTION_PRIMARY)
cb.set_text('stolen', -1)
print('owned', flush=True)
GLib.timeout_add(4000, Gtk.main_quit)
Gtk.main()
`

const selection = (): string => window.getSelection()?.toString() ?? ''

if (process.platform === 'linux') {
  for (let rep = 0; rep < 3; rep++) {
    test(`PROBE steal ${rep} another client taking PRIMARY clears the page selection`, async ({
      page
    }) => {
      await vaultOpen(page)
      await openNewNote(page, `Steal ${Date.now()}`, 'seed')
      await setBlocks(page, [
        tableBlock([
          ['Task', 'State'],
          ['Shipping', 'Open']
        ])
      ])
      const cell = page.locator(`${NOTE_EDITOR} td`).first()
      await cell.click({ position: { x: 20, y: 20 } })
      await cell.evaluate((element: HTMLElement) => {
        const text = element.querySelector('p')?.firstChild
        if (text) window.getSelection()?.setBaseAndExtent(text, 0, text, 8)
      })
      await expect.poll(() => page.evaluate(selection)).toBe('Shipping')
      await page.waitForTimeout(1500)
      const control = await page.evaluate(selection)

      const child = spawn('python3', ['-c', STEAL], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve())
        child.once('exit', (code) => reject(new Error(`steal client exited ${code}: ${stderr}`)))
      })
      const at = Date.now()
      let after = await page.evaluate(selection)
      while (after !== '' && Date.now() - at < 3000) {
        await page.waitForTimeout(50)
        after = await page.evaluate(selection)
      }
      child.kill()
      throw new Error(
        `STEAL RESULT control=${JSON.stringify(control)} after=${JSON.stringify(after)} clearedAfterMs=${Date.now() - at}`
      )
    })
  }
}
